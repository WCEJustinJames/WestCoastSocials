import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

// Proactive invites are idempotent within this window: the identical message is
// never sent to the same recipient twice inside it. Sits just under the typical
// weekly cadence and above the 4-day cooldown, so legitimate weekly invites
// (which differ per game anyway) aren't affected.
const IDEMPOTENT_WINDOW_DAYS = 6

/** Stable short hash of a message body, whitespace/case-insensitive. */
export function textHash(text: string): string {
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ')
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)
}

// inbox_sent_log post-dates the generated Database types — cast, same pattern as
// the heartbeat / settings tables use elsewhere.
type LedgerFilter = {
  eq: (c: string, v: string) => LedgerFilter
  gt: (c: string, v: string) => LedgerFilter
  limit: (n: number) => Promise<{ data: { id: string }[] | null }>
}
type LedgerDb = {
  from: (t: string) => {
    select: (c: string) => LedgerFilter
    insert: (v: unknown) => Promise<{ error: { message?: string } | null }>
  }
}

/** Have we already sent this exact message to this recipient inside the window? */
export async function alreadySent(db: DB, recipient: string, hash: string): Promise<boolean> {
  const since = new Date(Date.now() - IDEMPOTENT_WINDOW_DAYS * 86_400_000).toISOString()
  try {
    const { data } = await (db as unknown as LedgerDb)
      .from('inbox_sent_log')
      .select('id')
      .eq('recipient', recipient)
      .eq('text_hash', hash)
      .gt('sent_at', since)
      .limit(1)
    return !!(data && data.length)
  } catch (e) {
    console.error('[ledger] idempotency check failed (allowing send):', e instanceof Error ? e.message : e)
    return false // fail OPEN — never block a send on a ledger hiccup
  }
}

/** Append a send to the audit ledger. Best-effort; never throws. */
export async function recordSent(
  db: DB,
  row: {
    outreachId?: string | null
    recipient: string
    hash: string
    batchItemId?: string | null
    text: string
  },
): Promise<void> {
  try {
    const { error } = await (db as unknown as LedgerDb).from('inbox_sent_log').insert({
      outreach_id: row.outreachId ?? null,
      recipient: row.recipient,
      text_hash: row.hash,
      batch_item_id: row.batchItemId ?? null,
      rendered_text: row.text,
    })
    if (error) console.error('[ledger] record failed:', error.message ?? error)
  } catch (e) {
    console.error('[ledger] record failed:', e instanceof Error ? e.message : e)
  }
}
