import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { loadVenues, canonVenues } from './venues'

type DB = SupabaseClient<Database>

export interface OutreachResult {
  synced: number
}

interface AirtableRecord {
  id: string
  fields: Record<string, unknown>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * Mirror the Airtable "Player Outreach" CRM into inbox_outreach so the browser
 * can use it as a batch recipient source (it can't read Airtable directly — the
 * key is server-side). Upserts on airtable_id, so it's safe to run repeatedly.
 */
export async function syncOutreach(
  db: DB,
  apiKey: string,
  baseId: string,
  table: string,
): Promise<OutreachResult> {
  // Alias folding comes from inbox_venues now, so the dashboard's venue
  // manager and this importer can never drift apart.
  const venues = await loadVenues(db)
  const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`
  let offset: string | undefined
  let synced = 0

  do {
    const url = new URL(base)
    url.searchParams.set('pageSize', '100')
    if (offset) url.searchParams.set('offset', offset)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Airtable ${res.status} ${res.statusText} ${body}`.trim())
    }
    const data = (await res.json()) as { records: AirtableRecord[]; offset?: string }

    const rows = data.records.map((r) => {
      const f = r.fields
      return {
        airtable_id: r.id,
        player_name: str(f['Player Name']),
        first_name: str(f['First Name']),
        last_name: str(f['Last Name']),
        phone: str(f['Phone']),
        email: str(f['Email']),
        beeper_chat_id: str(f['Beeper Chat ID']),
        beeper_contact_name: str(f['Beeper Contact Name']),
        region: str(f['Region']),
        stakes: arr(f['Stakes']),
        venues: canonVenues(arr(f['Venues']), venues),
        activity: str(f['Activity']),
        outreach_status: str(f['Outreach Status']),
        game_type: str(f['Game Type']),
        last_active: str(f['Last Active']),
        last_contacted: str(f['Last Contacted']),
        notes: str(f['Notes']),
        source: str(f['Source']),
        synced_at: new Date().toISOString(),
      }
    })

    if (rows.length) {
      // Skip records a merge retired (inbox_merge_tombstones): re-upserting them
      // resurrects the deleted duplicate — and the source-refresh upsert below
      // has no ignoreDuplicates, so it would re-insert a merged-away row as a
      // near-empty skeleton (just airtable_id + source). Tolerates the table
      // not existing yet (migration 0068 unapplied).
      const tombstoned = new Set<string>()
      const t = db as unknown as {
        from: (x: string) => {
          select: (c: string) => {
            in: (col: string, v: string[]) => Promise<{ data: { airtable_id: string }[] | null; error: unknown }>
          }
        }
      }
      const { data: ts, error: tErr } = await t
        .from('inbox_merge_tombstones')
        .select('airtable_id')
        .in('airtable_id', rows.map((r) => r.airtable_id))
      if (!tErr) for (const x of ts ?? []) tombstoned.add(x.airtable_id)
      const keep = rows.filter((r) => !tombstoned.has(r.airtable_id))

      // Insert new players only; never overwrite existing rows, so manual CRM
      // edits (region tidy-ups, tags, bans) persist across syncs.
      if (keep.length) {
        const { error } = await db
          .from('inbox_outreach')
          .upsert(keep, { onConflict: 'airtable_id', ignoreDuplicates: true })
        if (error) throw error
      }
      synced += keep.length

      // The "Source" (real origin: Facebook Messenger / Google Contacts / raffle
      // cards / reservation PDF …) IS allowed to refresh on existing rows — it's
      // not something Justin hand-edits, and the generic "airtable" label is
      // useless without it. Upsert just airtable_id + source (no ignoreDuplicates),
      // which updates source while leaving every other field — and his edits —
      // untouched.
      const srcRows = keep
        .filter((r) => r.source)
        .map((r) => ({ airtable_id: r.airtable_id, source: r.source }))
      if (srcRows.length) {
        const { error: se } = await db
          .from('inbox_outreach')
          .upsert(srcRows, { onConflict: 'airtable_id' })
        if (se) throw se
      }
    }
    offset = data.offset
  } while (offset)

  return { synced }
}
