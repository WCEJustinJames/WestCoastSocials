import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface ContactsResult {
  scanned: number
  created: number
}

interface Person {
  resourceName: string
  names?: { displayName?: string }[]
  phoneNumbers?: { value?: string; canonicalForm?: string; metadata?: { primary?: boolean } }[]
  emailAddresses?: { value?: string; metadata?: { primary?: boolean } }[]
  metadata?: { deleted?: boolean }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me/connections'

/** Exchange the long-lived refresh token for a short-lived access token. */
async function accessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google token ${res.status} ${await res.text().catch(() => '')}`.trim())
  const j = (await res.json()) as { access_token?: string }
  if (!j.access_token) throw new Error('Google token: no access_token in response')
  return j.access_token
}

// The People API sync token is persisted across runs so each sync only fetches
// contacts that CHANGED since last time. Stored in inbox_contacts_sync(id=1).
// Cast: the table post-dates the generated Database types.
async function loadSyncToken(db: DB): Promise<string | null> {
  const q = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: number) => {
          maybeSingle: () => Promise<{ data: { sync_token: string | null } | null }>
        }
      }
    }
  }
  const { data } = await q.from('inbox_contacts_sync').select('sync_token').eq('id', 1).maybeSingle()
  return data?.sync_token ?? null
}
async function saveSyncToken(db: DB, token: string | null): Promise<void> {
  const q = db as unknown as {
    from: (t: string) => { upsert: (v: unknown) => Promise<{ error: unknown }> }
  }
  await q.from('inbox_contacts_sync').upsert({ id: 1, sync_token: token, updated_at: new Date().toISOString() })
}

const pickPhone = (p?: Person['phoneNumbers']): string | null => {
  if (!p?.length) return null
  const primary = p.find((x) => x.metadata?.primary) ?? p[0]
  return primary.canonicalForm ?? primary.value ?? null
}
const pickEmail = (e?: Person['emailAddresses']): string | null => {
  if (!e?.length) return null
  const primary = e.find((x) => x.metadata?.primary) ?? e[0]
  return primary.value ?? null
}

/**
 * Pull Google Contacts (People API) into inbox_outreach so contacts Justin adds
 * in person show up in the CRM automatically — even before he texts them. The
 * sync is incremental via a stored sync token (only changed contacts each run);
 * a 410 means the token expired, so we fall back to a full resync. Upserts on
 * airtable_id with ignoreDuplicates, so new contacts are inserted while existing
 * CRM rows and any manual edits are left untouched (same rule as the Airtable
 * mirror). Read-only — never writes back to Google.
 */
export async function syncGoogleContacts(
  db: DB,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<ContactsResult> {
  const token = await accessToken(clientId, clientSecret, refreshToken)
  let syncToken = await loadSyncToken(db)
  let scanned = 0
  let created = 0

  // One pass, retried once WITHOUT the sync token if Google reports it expired.
  for (let attempt = 0; attempt < 2; attempt++) {
    let pageToken: string | undefined
    let nextSyncToken: string | null = null
    let expired = false
    const people: Person[] = []

    do {
      const url = new URL(PEOPLE_URL)
      url.searchParams.set('personFields', 'names,phoneNumbers,emailAddresses')
      url.searchParams.set('pageSize', '1000')
      url.searchParams.set('requestSyncToken', 'true')
      if (syncToken) url.searchParams.set('syncToken', syncToken)
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 410) { expired = true; break } // sync token too old
      if (!res.ok) throw new Error(`People API ${res.status} ${await res.text().catch(() => '')}`.trim())
      const data = (await res.json()) as {
        connections?: Person[]
        nextPageToken?: string
        nextSyncToken?: string
      }
      if (data.connections) people.push(...data.connections)
      pageToken = data.nextPageToken
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken
    } while (pageToken)

    if (expired) { syncToken = null; continue } // restart loop for a full resync

    // Only contacts with a name AND a phone — a number is what makes them
    // reachable / worth inviting. Deleted contacts are skipped, never removed.
    const rows = people
      .filter((p) => !p.metadata?.deleted)
      .map((p) => ({
        airtable_id: `gcontact:${p.resourceName}`,
        player_name: p.names?.[0]?.displayName ?? null,
        phone: pickPhone(p.phoneNumbers),
        email: pickEmail(p.emailAddresses),
        preferred_channel: 'sms',
        synced_at: new Date().toISOString(),
      }))
      .filter((r) => r.player_name && r.phone)

    scanned = rows.length
    if (rows.length) {
      const ids = rows.map((r) => r.airtable_id)
      const { data: existing } = await db
        .from('inbox_outreach')
        .select('airtable_id')
        .in('airtable_id', ids)
      const have = new Set((existing ?? []).map((e) => e.airtable_id))
      created = rows.filter((r) => !have.has(r.airtable_id)).length

      const { error } = await db
        .from('inbox_outreach')
        .upsert(rows, { onConflict: 'airtable_id', ignoreDuplicates: true })
      if (error) throw error
    }
    await saveSyncToken(db, nextSyncToken)
    break
  }

  return { scanned, created }
}
