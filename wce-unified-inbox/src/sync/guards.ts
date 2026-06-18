import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

// Default minimum days between proactive outreach touches when a contact has no
// explicit contact_frequency_days. Conservative — better to under-message.
const DEFAULT_FREQ_DAYS = 4

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
}

/**
 * Send-time guard for a batch item, run right before the send (defense in depth —
 * the batch was built earlier, so flags / last_contacted may have changed since):
 *  - half-rendered or empty text  -> blocked for ALL sends
 *  - do_not_message / hidden      -> blocked for ALL sends
 *  - staff                        -> blocked for proactive outreach only
 *  - per-contact frequency cap    -> blocked for proactive outreach only
 * Returns a skip reason or ok. Reply/confirmation batches (isOutreach=false)
 * still honour bans but bypass the cooldown and staff checks.
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
    .select('do_not_message, hidden, staff, last_contacted, contact_frequency_days, beeper_chat_id')
    .eq('id', args.outreachId)
    .maybeSingle()
  if (!row) return { ok: true }

  if (row.do_not_message) return { ok: false, reason: 'do_not_message' }
  if (row.hidden) return { ok: false, reason: 'hidden' }
  if (args.isOutreach && row.staff) return { ok: false, reason: 'staff' }

  if (args.isOutreach && row.last_contacted) {
    const freq = row.contact_frequency_days ?? DEFAULT_FREQ_DAYS
    const lastMs = new Date(`${row.last_contacted}T00:00:00Z`).getTime()
    if (Number.isFinite(lastMs)) {
      const ageDays = (Date.now() - lastMs) / 86_400_000
      if (ageDays < freq) return { ok: false, reason: `cooldown_${freq}d` }
    }
  }

  // Non-replier guard: never send proactive outreach to someone who hasn't
  // replied to our last message (their thread's most recent message is ours).
  // Resolves the thread via the stored chat id — Messenger always, SMS once the
  // send-linkage has recorded it; unlinked SMS falls back to the cooldown above.
  if (args.isOutreach && row.beeper_chat_id) {
    const { data: conv } = await db
      .from('inbox_conversations')
      .select('id')
      .eq('external_chat_id', row.beeper_chat_id)
      .limit(1)
      .maybeSingle()
    if (conv?.id) {
      const { data: last } = await db
        .from('inbox_messages')
        .select('direction')
        .eq('conversation_id', conv.id)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (last && (last.direction as unknown as string) === 'outbound') {
        return { ok: false, reason: 'awaiting_reply' }
      }
    }
  }
  return { ok: true }
}
