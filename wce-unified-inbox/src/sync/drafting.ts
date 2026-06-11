import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { VOICE } from './voice'

type DB = SupabaseClient<Database>

export interface DraftingResult {
  generated: number
  skipped: number
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

Rules:
- Do NOT invent specifics you can't see, no made-up event names, dates, times, venues, prices, or promises. If a detail is needed but unknown, keep it general or ask.
- This is only a suggestion a human will review and edit, so aim for a sensible default, not a hedge.
- Respond with ONLY the message text to send. No preamble, no quotes, no explanation, no notes about your reasoning.`

export async function generateDrafts(
  db: DB,
  anthropic: Anthropic,
  model: string,
  maxPerPass: number,
): Promise<DraftingResult> {
  // Most recently active conversations are the ones most likely to need a reply.
  const { data: convs, error } = await db
    .from('inbox_conversations')
    .select('id, title')
    .order('last_activity', { ascending: false, nullsFirst: false })
    .limit(40)
  if (error) throw error
  if (!convs || convs.length === 0) return { generated: 0, skipped: 0 }

  let generated = 0
  let skipped = 0

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
        return `${who}: ${stripHtml(m.text)}`
      })
      .join('\n')

    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Conversation${conv.title ? ` with ${conv.title}` : ''}:\n\n${transcript}\n\nDraft the reply to send next.`,
          },
        ],
      })
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      if (!text) {
        skipped++
        continue
      }
      const { error: insErr } = await db.from('inbox_drafts').insert({
        conversation_id: conv.id,
        content: text,
        status: 'pending',
        generated_by: 'ai',
      })
      if (insErr) throw insErr
      generated++
    } catch (e) {
      console.error(
        `[drafts] error drafting for conversation ${conv.id}:`,
        e instanceof Error ? e.message : e,
      )
      skipped++
    }
  }

  return { generated, skipped }
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
