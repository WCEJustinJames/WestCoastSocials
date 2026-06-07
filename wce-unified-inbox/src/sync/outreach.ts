import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

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
        venues: arr(f['Venues']),
        activity: str(f['Activity']),
        outreach_status: str(f['Outreach Status']),
        game_type: str(f['Game Type']),
        last_active: str(f['Last Active']),
        last_contacted: str(f['Last Contacted']),
        notes: str(f['Notes']),
        synced_at: new Date().toISOString(),
      }
    })

    if (rows.length) {
      const { error } = await db.from('inbox_outreach').upsert(rows, { onConflict: 'airtable_id' })
      if (error) throw error
      synced += rows.length
    }
    offset = data.offset
  } while (offset)

  return { synced }
}
