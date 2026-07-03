import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { VOICE } from './voice'
import { classifyAiError, type AiOutcome } from './alert'

type DB = SupabaseClient<Database>

export interface DraftingResult {
  generated: number
  skipped: number
  /** How the Anthropic draft calls went this pass (undefined = none made). */
  ai?: AiOutcome
}

/**
 * AI drafting (Roadmap item 1). For conversations whose most recent message is
 * inbound and that don't already have an open draft, ask Claude for a suggested
 * reply and insert it as `pending` / `generated_by='ai'`. Justin edits/approves
 * it in the UI — it goes nowhere until he hits Approve (same gate as Phase A).
 *
 * Bounded on purpose: scans the most recently active conversations and stops
 * after `maxPerPass` generations so a single sync pass never fans out into a
 * burst of API calls.
 */
const SYSTEM_PROMPT = `You draft suggested reply messages for the West Coast Poker (WCP) player-messaging inbox. Justin runs WCP and messages players 1:1 over SMS, Messenger, and WhatsApp.

Write the reply Justin would send next, given the conversation so far.

${VOICE}

TIME AWARENESS (critical — stale offers have burned us):
- You are given the CURRENT date/time and each message's timestamp. Reason about elapsed time: an invite that said "tomorrow" two days ago is about a game that has PASSED.
- You are given which WCP games are ON today and what's next this week. NEVER offer a seat, say "tonight", or confirm attendance for a game that is not actually on. If a game IS on today but it's already evening (past its start), treat it as underway/passed, not offerable.
- If the player is replying about a game that has passed, acknowledge naturally (no apology theatre) and, if a next game is listed, pivot to that. Otherwise leave it open ("I'll flick you the next one").

Rules:
- Do NOT invent specifics you can't see, no made-up event names, dates, times, venues, prices, or promises. If a detail is needed but unknown, keep it general or ask.
- This is only a suggestion a human will review and edit, so aim for a sensible default, not a hedge.
- Respond with ONLY the message text to send. No preamble, no quotes, no explanation, no notes about your reasoning.`

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Fri 3/7 6:47pm" — Perth-local, compact, unambiguous for the model. */
export function stamp(d: Date): string {
  const h = d.getHours() % 12 || 12
  const ap = d.getHours() < 12 ? 'am' : 'pm'
  return `${DOW[d.getDay()].slice(0, 3)} ${d.getDate()}/${d.getMonth() + 1} ${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`
}

/** Today's games + the next few this week, from the active schedules. Shared by
 * the inbox draft suggester and the auto-reply rail, so neither can offer a
 * seat at a game that isn't on. */
export async function gamesContext(db: DB, now: Date): Promise<string> {
  const { data } = await db
    .from('inbox_schedules')
    .select('name, venue, game_type, day_of_week, event_time')
    .eq('active', true)
  const scheds = data ?? []
  const line = (s: (typeof scheds)[number]) =>
    `${s.name} (${s.game_type ?? 'game'}${s.venue ? ` at ${s.venue}` : ''}${s.event_time ? `, ${s.event_time}` : ''})`
  const today = scheds.filter((s) => s.day_of_week === now.getDay())
  const upcoming: string[] = []
  for (let off = 1; off <= 6 && upcoming.length < 3; off++) {
    const dow = (now.getDay() + off) % 7
    for (const s of scheds.filter((x) => x.day_of_week === dow)) {
      upcoming.push(`${DOW[dow]}: ${line(s)}`)
    }
  }
  return (
    `CURRENT TIME: ${stamp(now)} (Perth).\n` +
    (today.length ? `Games ON today: ${today.map(line).join('; ')}.\n` : 'NO WCP game is on today.\n') +
    (upcoming.length ? `Next this week: ${upcoming.join(' · ')}.` : 'Nothing else scheduled this week.')
  )
}

export async function generateDrafts(
  db: DB,
  anthropic: Anthropic,
  model: string,
  maxPerPass: number,
): Promise<DraftingResult> {
  // A suggestion drafted hours ago describes a different world ("save you a seat
  // tonight" after the game). Retire stale pending AI drafts (status 'rejected' —
  // the enum has no 'expired'); if the thread still ends inbound it gets a fresh
  // draft below, grounded in the current time. Human-typed drafts are untouched.
  await db
    .from('inbox_drafts')
    .update({ status: 'rejected' })
    .eq('status', 'pending')
    .eq('generated_by', 'ai')
    .lt('created_at', new Date(Date.now() - 6 * 60 * 60_000).toISOString())

  // Most recently active conversations are the ones most likely to need a reply.
  const { data: convs, error } = await db
    .from('inbox_conversations')
    .select('id, title, external_chat_id')
    .order('last_activity', { ascending: false, nullsFirst: false })
    .limit(40)
  if (error) throw error
  if (!convs || convs.length === 0) return { generated: 0, skipped: 0 }

  const now = new Date()
  const games = await gamesContext(db, now)

  // Whale (priority) players get a warmer, higher-touch draft. Look up their linked
  // threads once so we can flag the relevant conversations below.
  const { data: whales } = await db
    .from('inbox_outreach')
    .select('beeper_chat_id')
    .eq('whale', true)
    .not('beeper_chat_id', 'is', null)
  const whaleChats = new Set((whales ?? []).map((w) => w.beeper_chat_id))

  let generated = 0
  let skipped = 0
  let aiOutcome: AiOutcome | undefined

  for (const conv of convs) {
    if (generated >= maxPerPass) break

    // Skip if an open draft already exists (don't double-suggest).
    const { data: existing } = await db
      .from('inbox_drafts')
      .select('id')
      .eq('conversation_id', conv.id)
      .in('status', ['pending', 'approved'])
      .limit(1)
    if (existing && existing.length > 0) {
      skipped++
      continue
    }

    // Only suggest when the player spoke last (an inbound message awaiting reply).
    const { data: recent } = await db
      .from('inbox_messages')
      .select('direction, sender_name, text, timestamp')
      .eq('conversation_id', conv.id)
      .order('timestamp', { ascending: false })
      .limit(12)
    if (!recent || recent.length === 0 || recent[0].direction !== 'inbound') {
      skipped++
      continue
    }

    const transcript = recent
      .slice()
      .reverse()
      .map((m) => {
        const who = m.direction === 'outbound' ? 'Us' : (m.sender_name ?? 'Them')
        const when = m.timestamp ? ` [${stamp(new Date(m.timestamp))}]` : ''
        return `${who}${when}: ${stripHtml(m.text)}`
      })
      .join('\n')

    let text = ''
    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${games}\n\nConversation${conv.title ? ` with ${conv.title}` : ''}:\n\n${transcript}\n\n${
              conv.external_chat_id && whaleChats.has(conv.external_chat_id)
                ? "This player is a valued regular (VIP). Be a touch warmer and more personal than usual, acknowledge them by name, still in Justin's voice with no hype.\n\n"
                : ''
            }Draft the reply to send next.`,
          },
        ],
      })
      text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      aiOutcome = { ok: true }
    } catch (e) {
      // A bad key/model fails the same way for every conversation — record it
      // for the health alerter and stop hammering the API this pass.
      aiOutcome = { ok: false, ...classifyAiError(e) }
      console.error(`[drafts] classify error for conversation ${conv.id}:`, e instanceof Error ? e.message : e)
      skipped++
      break
    }
    if (!text) {
      skipped++
      continue
    }
    try {
      const { error: insErr } = await db.from('inbox_drafts').insert({
        conversation_id: conv.id,
        content: text,
        status: 'pending',
        generated_by: 'ai',
      })
      if (insErr) throw insErr
      generated++
    } catch (e) {
      console.error(`[drafts] insert error for conversation ${conv.id}:`, e instanceof Error ? e.message : e)
      skipped++
    }
  }

  return { generated, skipped, ai: aiOutcome }
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
