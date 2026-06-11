import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'
import { VOICE } from './voice'

type DB = SupabaseClient<Database>

export interface ReplyResult {
  replied: number
  confirmed: number
  escalated: number
}

// Pace auto-replies like batch sends (Beeper suspends accounts that fire fast).
const SEND_DELAY_MS = 1500
// Must outlast the 12h quiet window (21:00-09:00): a reply landing just before
// 9pm is held overnight and still needs to be inside the lookback at 9am.
const LOOKBACK_MS = 16 * 60 * 60 * 1000

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
${VOICE}
- For "no": understanding, brief, no guilt: "No worries [name], catch you at the next one" or just "All good mate, next time".
- For "yes": confirm it like he would: "Sweet, see you tonight", "Yes sir mate I wrote you down", "Catchya in a bit. Will save a seat".
- For "maybe": no pressure, short: "All g, lmk" or "No worries, hope to see you then".
- Use the player's first name only if it flows naturally; plenty of his texts skip the name.
- Do NOT state any specific time, place, or buy-in.
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
        const r = await adapter.sendMessage(job.chatId, stripDashes(v.reply))
        if (r.ok) replied++
      } catch (e) {
        console.error(`[reply] send error to ${job.name}:`, e instanceof Error ? e.message : e)
      }
      await sleep(SEND_DELAY_MS)
    }

    if (intent === 'yes') confirmedEntries.push(note ? `${name} (${note})` : name)
    else if (intent === 'no') declinedNames.push(name)
    else needYou.push(`${name} ("${job.transcript.slice(0, 60)}")`)

    await db
      .from('inbox_messages')
      .update({ auto_handled: true, reply_intent: intent, reply_note: note || null })
      .in('id', job.messageIds)
  }

  // Text Justin a digest — only when there's something he'd want to know (new
  // confirmations or a reply that needs him). Pure declines stay silent.
  if ((confirmedEntries.length || needYou.length) && adapter.startChatAndSend) {
    const parts: string[] = []
    if (confirmedEntries.length)
      parts.push(`Confirmed (${confirmedEntries.length}): ${confirmedEntries.join(', ')}`)
    if (declinedNames.length) parts.push(`Can't make it (${declinedNames.length})`)
    if (needYou.length) parts.push(`Needs you (${needYou.length}): ${needYou.join('; ')}`)
    try {
      await adapter.startChatAndSend(notifyAccount, notifyPhone, stripDashes(`WCP replies:\n${parts.join('\n')}`))
    } catch (e) {
      console.error('[reply] digest send error:', e instanceof Error ? e.message : e)
    }
  }

  // Keep ONE current seat-list message in the cash-games group: rebuild the full
  // roster from all of today's confirmations, and if it changed, delete the
  // previous post and put up the fresh one (so only the latest list is held).
  if (notifyGroupChatId && confirmedEntries.length) {
    await syncGroupRoster(db, adapter, notifyGroupChatId)
  }

  return { replied, confirmed: confirmedEntries.length, escalated: needYou.length }
}

/**
 * Rebuild the full confirmed roster from today's `yes` replies and, if it
 * changed since last time, delete the previous group message and post the new
 * one — so the group always holds a single, current seat list for reference.
 */
async function syncGroupRoster(db: DB, adapter: ChannelAdapter, groupChatId: string): Promise<void> {
  const since = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString()
  const { data: yes } = await db
    .from('inbox_messages')
    .select('conversation_id, sender_name, reply_note, timestamp')
    .eq('direction', 'inbound')
    .eq('reply_intent', 'yes')
    .gt('timestamp', since)
    .order('timestamp', { ascending: false })

  // One entry per player (latest reply wins), preserving first-confirmed order.
  const seen = new Set<string>()
  const entries: string[] = []
  for (const r of (yes ?? []).slice().reverse()) {
    const key = r.conversation_id ?? r.sender_name ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const nm = cleanName(r.sender_name ?? 'Player')
    const note = (r.reply_note ?? '').trim()
    entries.push(note ? `${nm} (${note})` : nm)
  }
  if (entries.length === 0) return

  const body = stripDashes(
    `CASH tonight, confirmed (${entries.length}):\n` +
      entries.map((e, i) => `${i + 1}. ${e}`).join('\n'),
  )
  const hash = String(entries.length) + ':' + entries.join('|')

  const { data: prevRows } = await db
    .from('inbox_group_post')
    .select('message_id, roster_hash')
    .eq('id', 1)
    .limit(1)
  const prev = (prevRows ?? [])[0] as { message_id?: string; roster_hash?: string } | undefined
  if (prev?.roster_hash === hash) return // nothing changed

  // Delete the previous roster message so only the latest remains.
  if (prev?.message_id && adapter.deleteMessage) {
    try {
      await adapter.deleteMessage(groupChatId, prev.message_id)
    } catch (e) {
      console.error('[reply] group delete error:', e instanceof Error ? e.message : e)
    }
  }

  if (!adapter.sendMessage) return
  const r = await adapter.sendMessage(groupChatId, body)
  await db
    .from('inbox_group_post')
    .update({ chat_id: groupChatId, message_id: r.pendingMessageId ?? null, roster_hash: hash, updated_at: new Date().toISOString() })
    .eq('id', 1)
}

/** West Coast Poker's no-em-dash rule: replace —/– with a comma (or strip). */
function stripDashes(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*-\s+/g, ', ') // a spaced hyphen used as a dash
    .replace(/,\s*,/g, ',')
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
