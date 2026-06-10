import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'

type DB = SupabaseClient<Database>

export interface ReplyResult {
  replied: number
  confirmed: number
  escalated: number
}

// Pace auto-replies like batch sends (Beeper suspends accounts that fire fast).
const SEND_DELAY_MS = 1500
const LOOKBACK_MS = 12 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Beeper mirrors group/system events as inbound messages ("X joined the chat").
// They aren't real replies — never classify or reply to them.
const SYSTEM_NOISE =
  /\b(joined|left|added|removed|created|changed|renamed|set the|started|ended|missed|deleted)\b.*\b(chat|group|call|name|photo|message)\b|^\s*(👍|👎|❤️|reacted)/i

const SYSTEM_PROMPT = `You triage inbound SMS replies to a poker game invite. Justin runs West Coast Poker (WCP) and texted players inviting them to a game TONIGHT. Players are now replying. For each reply, decide how Justin should respond.

Return intent:
- "yes"   = they're coming / confirming / keen.
- "no"    = they can't make it / declining.
- "maybe" = unsure, will try, asking a quick logistics thing you can't answer.
- "other" = anything that genuinely needs Justin himself: a real question (where/what time/buy-in/address), money or banking talk, a complaint, an angry message, or something off-topic/unclear.

Set "auto_ok" true ONLY for yes/no/maybe where a short, safe acknowledgement is clearly fine. Set it false for "other" — never invent details (times, venues, buy-ins, addresses, promises).

When auto_ok is true, write "reply": the exact text Justin would send back. Rules for the reply:
- Warm, casual, Australian English, like a real person texting. 1-2 short sentences.
- For "no": be understanding and thank them for letting you know (e.g. "No worries [name], thanks heaps for getting back to me — catch you at the next one!").
- For "yes": acknowledge warmly and that you'll see them tonight.
- For "maybe": friendly, no pressure, thank them for getting back.
- Use the player's first name if it's obvious from their name. No emojis unless their message uses them. Do NOT state any specific time, place, or buy-in.
When auto_ok is false, set "reply" to "".

Also extract "note": any game/stake/seat detail the player stated (e.g. "$2/5 seat 7", "2/5/10", "save me a seat"). Keep it short; empty string if none.

Respond with ONLY a JSON array, one object per message, in the same order:
[{"i":0,"intent":"yes","auto_ok":true,"reply":"...","note":"$2/5 seat 7"}]
No prose, no code fences.`

interface ConvJob {
  conversationId: string
  chatId: string
  name: string
  transcript: string
  messageIds: string[]
}

interface Verdict {
  i: number
  intent: 'yes' | 'no' | 'maybe' | 'other'
  auto_ok: boolean
  reply: string
  note?: string
}

/**
 * Auto-reply rail. Reads unhandled inbound replies, lets Claude classify each
 * and (for the simple confirm/decline/maybe cases) write a warm acknowledgement
 * that we send back automatically. Anything that needs Justin himself is left
 * unanswered and surfaced in the digest. After each pass, texts Justin a summary
 * of who confirmed (and who needs him) so he doesn't have to watch the inbox.
 *
 * One auto-reply per conversation, ever — once we've handled a thread we won't
 * keep replying to follow-ups. Everything we touch is marked `auto_handled` so
 * it's never reprocessed.
 */
export async function processReplies(
  db: DB,
  adapter: ChannelAdapter,
  anthropic: Anthropic,
  model: string,
  maxPerPass: number,
  notifyPhone: string,
  notifyGroupChatId: string | null = null,
  notifyAccount = 'gmessages',
): Promise<ReplyResult> {
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
  const { data: rows, error } = await db
    .from('inbox_messages')
    .select(
      'id, conversation_id, sender_name, text, timestamp, conversation:inbox_conversations!inner(external_chat_id, adapter, title)',
    )
    .eq('direction', 'inbound')
    .eq('auto_handled', false)
    .gt('timestamp', since)
    .order('timestamp', { ascending: true })
    .limit(100)
  if (error) throw error
  if (!rows || rows.length === 0) return { replied: 0, confirmed: 0, escalated: 0 }

  // Mark the system-noise rows handled straight away so they never come back.
  const noiseIds: string[] = []
  type Row = (typeof rows)[number]
  const real: Row[] = []
  for (const m of rows) {
    const conv = m.conversation as unknown as { adapter?: string } | null
    const txt = stripHtml(m.text)
    const isJustin = (m.sender_name ?? '').toLowerCase().includes('justin lewis')
    if (!txt || txt === '(no text)' || SYSTEM_NOISE.test(txt) || conv?.adapter !== adapter.id || isJustin) {
      noiseIds.push(m.id)
    } else {
      real.push(m)
    }
  }
  if (noiseIds.length) {
    await db.from('inbox_messages').update({ auto_handled: true, reply_intent: 'other' }).in('id', noiseIds)
  }
  if (real.length === 0) return { replied: 0, confirmed: 0, escalated: 0 }

  // One job per conversation (combine multiple texts from the same person).
  // Skip conversations we've already auto-replied to in a previous pass.
  const byConv = new Map<string, Row[]>()
  for (const m of real) {
    const arr = byConv.get(m.conversation_id) ?? []
    arr.push(m)
    byConv.set(m.conversation_id, arr)
  }

  const jobs: ConvJob[] = []
  const skipHandledIds: string[] = []
  for (const [conversationId, msgs] of byConv) {
    const { count } = await db
      .from('inbox_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('auto_handled', true)
      .not('reply_intent', 'is', null)
      .in('reply_intent', ['yes', 'no', 'maybe'])
    if ((count ?? 0) > 0) {
      // already auto-replied to this thread — just mark the new ones handled.
      skipHandledIds.push(...msgs.map((m) => m.id))
      continue
    }
    const conv = msgs[0].conversation as unknown as { external_chat_id: string; title: string | null }
    const name = (msgs[0].sender_name || conv.title || 'there').trim()
    const transcript = msgs.map((m) => stripHtml(m.text)).join(' / ')
    jobs.push({
      conversationId,
      chatId: conv.external_chat_id,
      name,
      transcript,
      messageIds: msgs.map((m) => m.id),
    })
    if (jobs.length >= maxPerPass) break
  }
  if (skipHandledIds.length) {
    await db.from('inbox_messages').update({ auto_handled: true }).in('id', skipHandledIds)
  }
  if (jobs.length === 0) return { replied: 0, confirmed: 0, escalated: 0 }

  // Classify + draft replies for the whole pass in one call.
  let verdicts: Verdict[]
  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: jobs
            .map((j, i) => `${i}. ${j.name}: ${j.transcript}`)
            .join('\n'),
        },
      ],
    })
    const out = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim()
    verdicts = JSON.parse(out)
  } catch (e) {
    // Don't mark handled — retry these next pass.
    console.error('[reply] classify error:', e instanceof Error ? e.message : e)
    return { replied: 0, confirmed: 0, escalated: 0 }
  }

  let replied = 0
  const confirmedEntries: string[] = [] // "Name — $2/5 seat 7"
  const declinedNames: string[] = []
  const needYou: string[] = []

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const v = verdicts.find((x) => x.i === i) ?? verdicts[i]
    const intent = v?.intent ?? 'other'
    const name = cleanName(job.name)
    const note = (v?.note ?? '').trim()

    if (v && v.auto_ok && v.reply && intent !== 'other' && adapter.sendMessage) {
      try {
        const r = await adapter.sendMessage(job.chatId, v.reply)
        if (r.ok) replied++
      } catch (e) {
        console.error(`[reply] send error to ${job.name}:`, e instanceof Error ? e.message : e)
      }
      await sleep(SEND_DELAY_MS)
    }

    if (intent === 'yes') confirmedEntries.push(note ? `${name} — ${note}` : name)
    else if (intent === 'no') declinedNames.push(name)
    else needYou.push(`${name} ("${job.transcript.slice(0, 60)}")`)

    await db
      .from('inbox_messages')
      .update({ auto_handled: true, reply_intent: intent })
      .in('id', job.messageIds)
  }

  // Text Justin a digest — only when there's something he'd want to know (new
  // confirmations or a reply that needs him). Pure declines stay silent.
  if ((confirmedEntries.length || needYou.length) && adapter.startChatAndSend) {
    const parts: string[] = []
    if (confirmedEntries.length)
      parts.push(`✅ Confirmed (${confirmedEntries.length}): ${confirmedEntries.join(', ')}`)
    if (declinedNames.length) parts.push(`🙅 Can't make it (${declinedNames.length})`)
    if (needYou.length) parts.push(`⚠️ Needs you (${needYou.length}): ${needYou.join('; ')}`)
    try {
      await adapter.startChatAndSend(notifyAccount, notifyPhone, `WCP replies:\n${parts.join('\n')}`)
    } catch (e) {
      console.error('[reply] digest send error:', e instanceof Error ? e.message : e)
    }
  }

  // Post fresh confirmations into the cash-games coordination group.
  if (confirmedEntries.length && notifyGroupChatId && adapter.sendMessage) {
    const msg = `🟢 Cash tonight — just confirmed:\n${confirmedEntries.map((e) => `• ${e}`).join('\n')}`
    try {
      await adapter.sendMessage(notifyGroupChatId, msg)
    } catch (e) {
      console.error('[reply] group post error:', e instanceof Error ? e.message : e)
    }
  }

  return { replied, confirmed: confirmedEntries.length, escalated: needYou.length }
}

/** Strip the venue/stake noise operators put in contact names, for display. */
function cleanName(raw: string): string {
  const c = raw
    .replace(/\$\s*\d[\d/]*/g, '')
    .replace(/\b(cash|poker|mct|mct's|tourney|tournament|game|games|and|vm|nlh|plo|woodvale|kenwick|southside|south|north|central)\b/gi, '')
    .replace(/[\/|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return c || raw.split(/\s+/)[0] || 'there'
}

/** Beeper stores text as rich-text (HTML); flatten it to readable plain text. */
function stripHtml(raw: string | null): string {
  if (!raw) return '(no text)'
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
}
