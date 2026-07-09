import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface ContactsResult {
  scanned: number
  created: number
  autoHidden: number
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
export async function accessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
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
// contacts that CHANGED since last time. Stored in inbox_contacts_sync, one row
// per Google account slot (1 = personal, 2 = work) so two accounts can sync
// independently. Cast: the table post-dates the generated Database types.
async function loadSyncToken(db: DB, slot: number): Promise<string | null> {
  const q = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: number) => {
          maybeSingle: () => Promise<{ data: { sync_token: string | null } | null }>
        }
      }
    }
  }
  const { data } = await q.from('inbox_contacts_sync').select('sync_token').eq('id', slot).maybeSingle()
  return data?.sync_token ?? null
}
async function saveSyncToken(db: DB, slot: number, token: string | null): Promise<void> {
  const q = db as unknown as {
    from: (t: string) => { upsert: (v: unknown) => Promise<{ error: unknown }> }
  }
  await q.from('inbox_contacts_sync').upsert({ id: slot, sync_token: token, updated_at: new Date().toISOString() })
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

// Auto-hide obvious non-people on import (banks, telcos, govt, bowls clubs,
// businesses, phone-system codes) so only real new contacts surface for review.
// Mirrors the one-off cleanup filter. Anything with poker context is always kept.
const POKER_CTX =
  /\b(poker|holdem|tourney|tournament|cash|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|stirling|adriatic)\b/i
const NON_PERSON =
  /\b(directory|psych|banking|anz|nab|commbank|commonwealth|westpac|bankwest|printing|accounting|bookkeep|association|bowls|bowlo|turf|trailers|gaming|licensing|drgl|dlgsc|fairwork|centrelink|medicare|registration|voicemail|roaming|recharge|luxonpay|square|pty|ltd|telstra|optus|vodafone|synergy|bunnings|woolworths|reception|noreply|warranty|dealership|towing|services|clinic|council|pharmacy|chemist|dental|insurance|signs)\b/i
const NON_PERSON_LOOSE =
  /(on\/off|\/off|rate plan|missed call|call waiting|client id|kids help|city of|online banking|account (transfer|balance)|customer (care|service)| home$)/i

function looksLikeNonPerson(name: string): boolean {
  if (/\b(bowls|bowlo)\b/i.test(name)) return true // bowls clubs are never poker
  if (POKER_CTX.test(name)) return false // protect real poker contacts
  return NON_PERSON.test(name) || NON_PERSON_LOOSE.test(name)
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
  slot = 1,
): Promise<ContactsResult> {
  const token = await accessToken(clientId, clientSecret, refreshToken)
  let syncToken = await loadSyncToken(db, slot)
  let scanned = 0
  let created = 0
  let autoHidden = 0

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
      // An expired sync token: the People API returns it as 410, OR as a 400
      // with reason EXPIRED_SYNC_TOKEN — both mean "drop the token, full resync".
      if (res.status === 410 || res.status === 400) {
        const body = await res.text().catch(() => '')
        if (res.status === 410 || /EXPIRED_SYNC_TOKEN|Sync token is expired/i.test(body)) { expired = true; break }
        throw new Error(`People API 400 ${body}`.trim())
      }
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
    // Obvious non-people are imported but flagged hidden, so they stay out of
    // the batch builder / lists (one un-hide away if we got it wrong).
    const rows = people
      .filter((p) => !p.metadata?.deleted)
      .map((p) => {
        const player_name = p.names?.[0]?.displayName ?? null
        return {
          airtable_id: `gcontact:${p.resourceName}`,
          player_name,
          phone: pickPhone(p.phoneNumbers),
          email: pickEmail(p.emailAddresses),
          preferred_channel: 'sms',
          hidden: player_name ? looksLikeNonPerson(player_name) : false,
          synced_at: new Date().toISOString(),
        }
      })
      .filter((r) => r.player_name && r.phone)

    scanned = rows.length
    if (rows.length) {
      const ids = rows.map((r) => r.airtable_id)
      const { data: existing } = await db
        .from('inbox_outreach')
        .select('airtable_id')
        .in('airtable_id', ids)
      const have = new Set((existing ?? []).map((e) => e.airtable_id))
      const newRows = rows.filter((r) => !have.has(r.airtable_id))
      created = newRows.length
      autoHidden = newRows.filter((r) => r.hidden).length

      const { error } = await db
        .from('inbox_outreach')
        .upsert(rows, { onConflict: 'airtable_id', ignoreDuplicates: true })
      if (error) throw error
    }
    await saveSyncToken(db, slot, nextSyncToken)
    break
  }

  return { scanned, created, autoHidden }
}
