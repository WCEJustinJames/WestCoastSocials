import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface IdentityKey {
  adapter: Database['public']['Enums']['inbox_adapter']
  network: string
  accountId: string | null
  externalId: string
  handle: string | null
  displayName: string | null
}

/**
 * Normalize a handle for cross-channel matching.
 * - emails/usernames: lowercased as-is
 * - phone numbers: last 9 digits (ignores country-code / formatting differences)
 */
export function normalizeHandle(h: string | null | undefined): string | null {
  if (!h) return null
  const trimmed = h.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.includes('@')) return trimmed
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length >= 6) return digits.slice(-9)
  return trimmed
}

/**
 * Resolve (or create) the unified person for a channel identity, and ensure the
 * identity row exists against them. Cross-channel identity is first-class: one
 * player = one inbox_people row, every channel handle hangs off it.
 *
 * Matching order (Step 1):
 *   1. exact identity (same adapter + external_id) -> its person
 *   2. fuzzy: same normalized handle on ANY channel -> that person
 *   3. otherwise -> create a new person
 */
export async function resolvePersonId(db: DB, key: IdentityKey): Promise<string> {
  // 1. exact identity match
  const { data: exact } = await db
    .from('inbox_identities')
    .select('person_id')
    .eq('adapter', key.adapter)
    .eq('external_id', key.externalId)
    .maybeSingle()
  if (exact?.person_id) {
    await upsertIdentity(db, key, exact.person_id)
    return exact.person_id
  }

  // 2. fuzzy handle match across channels
  let personId: string | null = null
  const norm = normalizeHandle(key.handle)
  if (norm) {
    const { data: rows } = await db
      .from('inbox_identities')
      .select('person_id, handle')
    const hit = (rows ?? []).find((r) => normalizeHandle(r.handle) === norm)
    if (hit) personId = hit.person_id
  }

  // 3. create a new person
  if (!personId) {
    const { data: person, error } = await db
      .from('inbox_people')
      .insert({ display_name: key.displayName })
      .select('id')
      .single()
    if (error) throw error
    personId = person.id
  }

  await upsertIdentity(db, key, personId)
  return personId
}

async function upsertIdentity(db: DB, key: IdentityKey, personId: string): Promise<void> {
  const { error } = await db.from('inbox_identities').upsert(
    {
      person_id: personId,
      adapter: key.adapter,
      network: key.network,
      account_id: key.accountId,
      external_id: key.externalId,
      handle: key.handle,
      match_confidence: 1.0,
    },
    { onConflict: 'adapter,account_id,external_id' },
  )
  if (error) throw error
}
