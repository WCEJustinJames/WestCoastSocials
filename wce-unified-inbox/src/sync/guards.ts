import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { env } from '../lib/env'

type DB = SupabaseClient<Database>

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

// Skip proactive outreach once a contact has ignored this many invitations in a
// row (no reply since). First-time / low-count contacts are exempt.
const NO_REPLY_LIMIT = 4

// A message still carrying a template token (or an empty "." body) must never go
// out — that's the "Hi {{first}}," / spammy, not-his-voice failure mode.
const UNRENDERED =
  /\{\{\s*\w+\s*\}\}|\{\s*(first|firstname|name|opponent|date|venue|stake|time|day)\s*\}/i

/** Reject empty / junk / half-rendered message bodies. Applies to EVERY send. */
export function checkRendered(text: string | null | undefined): GuardVerdict {
  const t = (text ?? '').trim()
  if (t.length < 2) return { ok: false, reason: 'empty_or_too_short' }
  if (UNRENDERED.test(t)) return { ok: false, reason: 'unrendered_placeholder' }
  return { ok: true }
}

type OutreachGuardRow = {
  do_not_message: boolean | null
  hidden: boolean | null
  staff: boolean | null
  last_contacted: string | null
  contact_frequency_days: number | null
  beeper_chat_id: string | null
  snooze_until: string | null
}

/**
 * Send-time guard for a batch item, run right before the send (defense in depth —
 * the batch was built earlier, so flags / last_contacted may have changed since):
 *  - half-rendered or empty text  -> blocked for ALL sends
 *  - do_not_message / hidden      -> blocked for ALL sends
 *  - staff                        -> blocked for proactive outreach only
 *  - ignored last N invitations   -> blocked for proactive outreach only
 * Returns a skip reason or ok. Reply/confirmation batches (isOutreach=false)
 * still honour bans but bypass the no-reply and staff checks.
 */
export async function guardSend(
  db: DB,
  args: { renderedText: string | null | undefined; isOutreach: boolean; outreachId?: string | null },
): Promise<GuardVerdict> {
  const text = checkRendered(args.renderedText)
  if (!text.ok) return text

  if (!args.outreachId) return { ok: true } // no CRM row to check (ad-hoc send)

  // Cast: some flags (staff/weekly) post-date the generated Database types.
  const q = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => {
          maybeSingle: () => Promise<{ data: OutreachGuardRow | null; error: unknown }>
        }
      }
    }
  }
  const { data: row } = await q
    .from('inbox_outreach')
    .select('do_not_message, hidden, staff, last_contacted, contact_frequency_days, beeper_chat_id, snooze_until')
    .eq('id', args.outreachId)
    .maybeSingle()
  // The item names a CRM row that no longer exists (deleted by a merge after the
  // batch was approved). Sending blind would bypass EVERY per-player guard — the
  // ban/hidden/staff flags live on the row we can't find — so skip, never send.
  if (!row) return { ok: false, reason: 'crm_row_missing' }

  if (row.do_not_message) return { ok: false, reason: 'do_not_message' }
  if (row.hidden) return { ok: false, reason: 'hidden' }
  if (args.isOutreach && row.staff) return { ok: false, reason: 'staff' }

  // "On ice": parked from proactive outreach until their snooze date passes
  // (e.g. away with work, or you benched them). Replies are never gated by this.
  if (args.isOutreach && row.snooze_until && row.snooze_until > new Date().toISOString().slice(0, 10)) {
    return { ok: false, reason: 'on_ice' }
  }

  // Vet first-timers (opt-in, VET_FIRST_TIMERS=on): a contact we've never messaged
  // (no last_contacted) is held for one-tap review before their FIRST proactive
  // outreach, so a freshly imported phonebook number isn't cold-blasted unvetted.
  if (args.isOutreach && env.vetFirstTimers && !row.last_contacted) {
    return { ok: false, reason: 'first_time_review' }
  }

  // No-reply guard (per Justin): stop proactive outreach once a contact has
  // ignored our last N invitations — i.e. N+ invitations have been sent since
  // their most recent reply (or ever, if they've never replied). First-time and
  // low-count contacts are exempt, and time-since-last-contact no longer gates
  // anything — a regular can be invited every night until they go quiet.
  if (args.isOutreach) {
    // Their most recent reply, resolved via the linked thread (if any).
    let lastReply = '1970-01-01T00:00:00Z'
    if (row.beeper_chat_id) {
      const { data: conv } = await db
        .from('inbox_conversations')
        .select('id')
        .eq('external_chat_id', row.beeper_chat_id)
        .limit(1)
        .maybeSingle()
      if (conv?.id) {
        const { data: lastIn } = await db
          .from('inbox_messages')
          .select('timestamp')
          .eq('conversation_id', conv.id)
          .eq('direction', 'inbound')
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (lastIn?.timestamp) lastReply = lastIn.timestamp
      }
    }
    // Count invitations (the send ledger) to this player since that reply.
    const ledger = db as unknown as {
      from: (t: string) => {
        select: (c: string, o: { count: 'exact'; head: true }) => {
          eq: (col: string, v: string) => {
            gt: (col: string, v: string) => Promise<{ count: number | null }>
          }
        }
      }
    }
    const { count } = await ledger
      .from('inbox_sent_log')
      .select('id', { count: 'exact', head: true })
      .eq('outreach_id', args.outreachId)
      .gt('sent_at', lastReply)
    if ((count ?? 0) >= NO_REPLY_LIMIT) {
      return { ok: false, reason: `no_reply_${NO_REPLY_LIMIT}` }
    }
  }
  return { ok: true }
}
