import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { accessToken } from './contacts'

type DB = SupabaseClient<Database>

export interface EmailResult {
  scanned: number
  inserted: number
  /** True when the refresh token lacks the gmail.readonly scope (sync disabled). */
  disabled?: boolean
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

// A token minted before gmail.readonly was added to the scopes 403s every call.
// Detect it once, log the fix, and stay quiet for the rest of the process.
let scopeMissing = false

/** Pull "Name <email>" apart; either half may be absent. */
function parseFrom(raw: string | undefined): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null }
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || null, email: m[2].trim() || null }
  return { name: null, email: raw.trim() || null }
}

/**
 * Mirror unread inbox emails into inbox_emails for the Home action queue. Read-only
 * against Gmail (never marks read, never sends); "done" lives entirely on our side
 * (inbox_emails.resolved). Promotions/social are excluded so marketing doesn't
 * flood the queue; idempotent on gmail_id, so re-syncs only add what's new.
 */
export async function syncGmail(
  db: DB,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<EmailResult> {
  if (scopeMissing) return { scanned: 0, inserted: 0, disabled: true }
  const token = await accessToken(clientId, clientSecret, refreshToken)

  const listUrl = new URL(`${GMAIL}/messages`)
  listUrl.searchParams.set('q', 'in:inbox is:unread newer_than:14d -category:promotions -category:social')
  listUrl.searchParams.set('maxResults', '25')
  const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 403) {
    scopeMissing = true
    console.warn(
      '[email] Gmail scope missing — re-run scripts/get-google-refresh-token.mjs (it now includes gmail.readonly) and update GOOGLE_REFRESH_TOKEN in .env',
    )
    return { scanned: 0, inserted: 0, disabled: true }
  }
  if (!res.ok) throw new Error(`Gmail list ${res.status} ${await res.text().catch(() => '')}`.trim())
  const list = (await res.json()) as { messages?: { id: string; threadId: string }[] }
  const msgs = list.messages ?? []
  if (msgs.length === 0) return { scanned: 0, inserted: 0 }

  // Only fetch metadata for messages we haven't mirrored yet.
  const ids = msgs.map((m) => m.id)
  const { data: existing } = await db.from('inbox_emails').select('gmail_id').in('gmail_id', ids)
  const have = new Set((existing ?? []).map((e) => e.gmail_id))
  const fresh = msgs.filter((m) => !have.has(m.id))

  let inserted = 0
  for (const m of fresh) {
    const metaUrl = new URL(`${GMAIL}/messages/${m.id}`)
    metaUrl.searchParams.set('format', 'metadata')
    for (const h of ['From', 'Subject', 'Date']) metaUrl.searchParams.append('metadataHeaders', h)
    const mr = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } })
    if (!mr.ok) continue
    const detail = (await mr.json()) as {
      snippet?: string
      internalDate?: string
      payload?: { headers?: { name: string; value: string }[] }
    }
    const headers = new Map((detail.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
    const from = parseFrom(headers.get('from'))
    const { error } = await db.from('inbox_emails').upsert(
      {
        gmail_id: m.id,
        thread_id: m.threadId ?? null,
        from_name: from.name,
        from_email: from.email,
        subject: headers.get('subject') ?? null,
        snippet: detail.snippet ?? null,
        received_at: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : null,
      },
      { onConflict: 'gmail_id', ignoreDuplicates: true },
    )
    if (!error) inserted++
  }

  return { scanned: msgs.length, inserted }
}
