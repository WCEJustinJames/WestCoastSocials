import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'
import { VOICE } from './voice'
import { classifyAiError, type AiOutcome } from './alert'
import { flaggedConversationIds } from './roster'

type DB = SupabaseClient<Database>

export interface ReplyResult {
  replied: number
  confirmed: number
  escalated: number
  /** How the Anthropic classify call went this pass (undefined = none made). */
  ai?: AiOutcome
}

// Pace auto-replies like batch sends (Beeper suspends accounts that fire fast).
const SEND_DELAY_MS = 1500
// Must outlast the 12h quiet window (21:00-09:00): a reply landing just before
// 9pm is held overnight and still needs to be inside the lookback at 9am.
const LOOKBACK_MS = 16 * 60 * 60 * 1000

// The auto-reply rail answers replies to invitations we actually SENT — nothing
// else. A chat is "in an outreach cycle" only if it has a send-ledger entry
// within this window (comfortably longer than the reply lookback, so a next-
// morning reply to last night's invite still counts). Anything we never invited
// — business, admin, a chat about the Facebook page — is left for Justin.
const INVITE_LOOKBACK_MS = 30 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Beeper mirrors group/system events as inbound messages ("X joined the chat").
// They aren't real replies — never classify or reply to them.
const SYSTEM_NOISE =
  /\b(joined|left|added|removed|created|changed|renamed|set the|started|ended|missed|deleted)\b.*\b(chat|group|call|name|photo|message)\b|^\s*(👍|👎|❤️|reacted)/i

const SYSTEM_PROMPT = `You triage inbound SMS replies to a poker game invite. Justin runs West Coast Poker (WCP) and texted players game invites. Players are now replying. For each reply, decide how Justin should respond.

Each numbered line may quote, in [invited Nh ago: "..."], the EXACT invite that player is replying to and how long ago it was sent. That quote is the ground truth for WHICH game they mean (venue, stakes, day) — never assume a different game:
- An invite for "tonight" means the day it was sent.
- An invite for "tomorrow" sent yesterday means the game is TODAY; sent today it means TOMORROW — a yes to that is "Sweet, see you tomorrow night", never "see you tonight".
- Keep any venue/stakes wording consistent with the quoted invite; never substitute another venue.

Return intent:
- "yes"   = they're coming / confirming / keen. This INCLUDES a confirmation that also states a preference or condition — a table, stakes (e.g. $2/5 vs $2/5/10), a seat, or an arrival time. "I'll be there but prefer 2/5" is a YES, not a decline; put the preference in the note. A stated game/table/stakes preference is NEVER a "no".
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

Also extract "note": the single most useful detail the player stated, kept short.
- For "yes": any game/stake/seat/table preference (e.g. "$2/5 seat 7", "prefers $2/5 not $2/5/10", "second table", "save me a seat", "arriving ~6").
- For "no"/"maybe": WHY they can't make it and, crucially, WHEN they'll be back if they say — e.g. "away in Thailand for a month", "back first week of July", "in Sydney, back next week", "works night shifts", "Woodvale too far". Always capture a return date/timeframe when they give one; it tells Justin when to re-invite.
Keep it a short phrase; empty string if there's genuinely nothing.

Also set "back_on": for a "no"/"maybe" where they say WHEN they'll be back or free to play again, the resolved calendar date as YYYY-MM-DD — use the "Today is" date below to resolve relative phrases ("next week" ≈ +7 days, "first week of July", "back in a month", "mid next month"). Empty string for "yes", or when no return time is given.

Respond with ONLY a JSON array, one object per message, in the same order:
[{"i":0,"intent":"no","auto_ok":true,"reply":"...","note":"away with work","back_on":"2026-07-15"}]
No prose, no code fences.`

interface ConvJob {
  conversationId: string
  chatId: string
  name: string
  transcript: string
  messageIds: string[]
  /** The exact invite this thread is replying to, from the send ledger. */
  invite?: { text: string; sentAt: string }
}

// Pull the canonical venue out of an invite's wording, for the digest tag.
const VENUE_WORDS: [RegExp, string][] = [
  [/market city|\bmct\b/i, 'MCT'], [/woodvale/i, 'Woodvale'],
  [/leederville|leedy/i, 'Leederville'], [/kenwick/i, 'Kenwick'],
  [/kingsley/i, 'Kingsley'], [/bentley/i, 'Bentley'],
  [/stirling/i, 'Stirling'], [/planet royale/i, 'Planet Royale'],
]
function venueFromText(t: string): string | null {
  for (const [re, v] of VENUE_WORDS) if (re.test(t)) return v
  return null
}

interface Verdict {
  i: number
  intent: 'yes' | 'no' | 'maybe' | 'other'
  auto_ok: boolean
  reply: string
  note?: string
  back_on?: string
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
    // 'noise', NOT 'other': 'other' means "a real reply that needs Justin" and
    // feeds the Home action queue — system events must never land there.
    await db.from('inbox_messages').update({ auto_handled: true, reply_intent: 'noise' }).in('id', noiseIds)
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

  // Never auto-reply to staff / dealers / banned / hidden contacts — they're
  // coordinating the game, not confirming a seat (the "No worries Shane, catch
  // you at the next one" reply to the permit holder). Drop them before classify.
  const excludedConvs = await flaggedConversationIds(db, [...byConv.keys()])

  // Outreach-only gate: resolve each conversation's chat id, then find which of
  // those we actually invited recently (the ledger keys recipient = chat id).
  // The rail replies ONLY inside those threads — a chat we never invited (e.g.
  // the Facebook-page conversation with Desmond) is never auto-answered, so a
  // message like "No options" can't be misread as declining a game.
  const chatIdByConv = new Map<string, string>()
  for (const [cid, ms] of byConv) {
    const conv = ms[0].conversation as unknown as { external_chat_id?: string } | null
    if (conv?.external_chat_id) chatIdByConv.set(cid, conv.external_chat_id)
  }
  // The ledger also carries WHAT we sent each chat — the latest invite per thread
  // is quoted to the classifier as hard context (which game/venue/day the player
  // is replying about), instead of assuming "a game tonight".
  const invitedChats = new Set<string>()
  const inviteByChat = new Map<string, { text: string; sentAt: string }>()
  {
    const chatIds = [...new Set(chatIdByConv.values())]
    if (chatIds.length) {
      const ledger = db as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            in: (col: string, v: string[]) => {
              gt: (col: string, v: string) => {
                order: (col: string, o: { ascending: boolean }) => Promise<{
                  data: { recipient: string; rendered_text: string | null; sent_at: string }[] | null
                }>
              }
            }
          }
        }
      }
      const { data: sent } = await ledger
        .from('inbox_sent_log')
        .select('recipient, rendered_text, sent_at')
        .in('recipient', chatIds)
        .gt('sent_at', new Date(Date.now() - INVITE_LOOKBACK_MS).toISOString())
        .order('sent_at', { ascending: false })
      for (const s of sent ?? []) {
        invitedChats.add(s.recipient)
        if (!inviteByChat.has(s.recipient) && s.rendered_text) {
          inviteByChat.set(s.recipient, { text: s.rendered_text, sentAt: s.sent_at })
        }
      }
    }
  }

  const jobs: ConvJob[] = []
  const skipHandledIds: string[] = []
  for (const [conversationId, msgs] of byConv) {
    if (excludedConvs.has(conversationId)) {
      skipHandledIds.push(...msgs.map((m) => m.id))
      continue
    }
    // Outreach-only: skip any thread we didn't recently invite.
    if (!invitedChats.has(chatIdByConv.get(conversationId) ?? '')) {
      skipHandledIds.push(...msgs.map((m) => m.id))
      continue
    }
    // If Justin has already replied by hand since the player's latest text, the
    // thread is handled — never let the rail fire a second reply on top of him.
    // His manual reply is mirrored as a later outbound in the same conversation,
    // so a most-recent outbound newer than the latest inbound means "answered".
    const latestInbound = Math.max(...msgs.map((m) => new Date(m.timestamp).getTime()))
    const { data: lastOut } = await db
      .from('inbox_messages')
      .select('timestamp')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastOut?.timestamp && new Date(lastOut.timestamp).getTime() > latestInbound) {
      skipHandledIds.push(...msgs.map((m) => m.id))
      continue
    }
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
      invite: inviteByChat.get(conv.external_chat_id),
    })
    if (jobs.length >= maxPerPass) break
  }
  if (skipHandledIds.length) {
    await db.from('inbox_messages').update({ auto_handled: true }).in('id', skipHandledIds)
  }
  if (jobs.length === 0) return { replied: 0, confirmed: 0, escalated: 0 }

  // Whale (priority) players get a 🐋 in the digest so their replies stand out.
  const whaleChats = new Set<string>()
  {
    const { data: whaleRows } = await db
      .from('inbox_outreach')
      .select('beeper_chat_id')
      .eq('whale', true)
      .not('beeper_chat_id', 'is', null)
    for (const w of whaleRows ?? []) if (w.beeper_chat_id) whaleChats.add(w.beeper_chat_id)
  }

  // Classify + draft replies for the whole pass in one call.
  let verdicts: Verdict[]
  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: `${SYSTEM_PROMPT}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
      messages: [
        {
          role: 'user',
          content: jobs
            .map((j, i) => {
              const inv = j.invite
                ? ` [invited ${Math.max(1, Math.round((Date.now() - new Date(j.invite.sentAt).getTime()) / 3_600_000))}h ago: "${stripHtml(j.invite.text).slice(0, 160)}"]`
                : ''
              return `${i}. ${j.name}${inv}: ${j.transcript}`
            })
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
    // Don't mark handled — retry these next pass. Surface the failure so the
    // health alerter can text Justin if the AI key/model has gone bad.
    console.error('[reply] classify error:', e instanceof Error ? e.message : e)
    return { replied: 0, confirmed: 0, escalated: 0, ai: { ok: false, ...classifyAiError(e) } }
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
    // A resolved return date ("back first week of July" → 2026-07-01), stored so
    // the Home "Who's out" panel can flag them ready to re-invite once it passes.
    const backOnRaw = (v?.back_on ?? '').trim()
    const backOn = /^\d{4}-\d{2}-\d{2}$/.test(backOnRaw) ? backOnRaw : null

    // CLAIM BEFORE SEND — the cure for double auto-replies. Atomically flip this
    // thread's inbound rows unhandled -> handled, but ONLY the rows still
    // unhandled (.eq auto_handled,false). If a second sync pass or a duplicate
    // run-wce.bat window is racing us, it already flipped them, so this UPDATE
    // matches zero rows and we skip WITHOUT sending. Marking first (instead of
    // after the send, as before) closes the multi-second window where two passes
    // both classify the same text and fire two different acks. Postgres makes the
    // conditional UPDATE atomic, so exactly one racer can ever win the claim.
    const { data: claimed, error: claimErr } = await db
      .from('inbox_messages')
      .update({ auto_handled: true, reply_intent: intent, reply_note: note || null, reply_back_on: backOn })
      .in('id', job.messageIds)
      .eq('auto_handled', false)
      .select('id')
    if (claimErr || !claimed || claimed.length === 0) {
      console.log(`[reply] skip ${job.name}: thread already claimed by another pass/window`)
      continue
    }

    // Reserve confirmations get a generic lock emoji (no enthusiasm, per Justin);
    // declines / maybes use the model's short acknowledgement.
    const replyText = intent === 'yes' ? '🔒' : v && v.auto_ok && v.reply ? stripDashes(v.reply) : ''
    if (replyText && intent !== 'other' && adapter.sendMessage) {
      try {
        const r = await adapter.sendMessage(job.chatId, replyText)
        if (r.ok) replied++
      } catch (e) {
        console.error(`[reply] send error to ${job.name}:`, e instanceof Error ? e.message : e)
      }
      await sleep(SEND_DELAY_MS)
    }

    // Digest entries name the game the player was replying to (from the quoted
    // invite), so on a two-game day "yes @ Leederville" and "yes @ Kenwick" read apart.
    const inviteVenue = job.invite ? venueFromText(job.invite.text) : null
    const digestBase = whaleChats.has(job.chatId) ? `🐋 ${name}` : name
    const digestName = inviteVenue ? `${digestBase} @ ${inviteVenue}` : digestBase
    if (intent === 'yes') confirmedEntries.push(note ? `${digestName} (${note})` : digestName)
    else if (intent === 'no') declinedNames.push(digestName)
    else needYou.push(`${digestName} ("${job.transcript.slice(0, 60)}")`)
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

  // Reaching here means the classify call succeeded — the AI key/model are fine.
  return { replied, confirmed: confirmedEntries.length, escalated: needYou.length, ai: { ok: true } }
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

  // Drop anyone whose CRM row is staff / do_not_message / hidden before they hit
  // the public list (a dealer replying "yes" shouldn't appear).
  const excluded = await flaggedConversationIds(db, (yes ?? []).map((r) => r.conversation_id))
  // One entry per player (latest reply wins), preserving first-confirmed order.
  const seen = new Set<string>()
  const entries: string[] = []
  for (const r of (yes ?? []).slice().reverse()) {
    const key = r.conversation_id ?? r.sender_name ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    if (r.conversation_id && excluded.has(r.conversation_id)) continue
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
