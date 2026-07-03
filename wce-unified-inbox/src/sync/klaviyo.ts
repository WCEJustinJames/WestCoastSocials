import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>
type Push = Database['public']['Tables']['klaviyo_pushes']['Row']

export interface KlaviyoResult {
  prepared: number
  disabled?: boolean
}

const KLAVIYO = 'https://a.klaviyo.com/api'
const REVISION = '2026-04-15' // current stable per developers.klaviyo.com

let klaviyoDisabled = false

/** CRM emails for a blast segment: everyone | cash | tourney | venue:<Name>. */
async function segmentEmails(db: DB, segment: string): Promise<string[]> {
  let q = db
    .from('inbox_outreach')
    .select('email, cash, tournament, venues')
    .not('email', 'is', null)
    .eq('do_not_message', false)
    .eq('hidden', false)
    .eq('staff', false)
  const { data } = await q.limit(5000)
  const rows = (data ?? []) as { email: string | null; cash: boolean; tournament: boolean; venues: string[] | null }[]
  const venue = segment.startsWith('venue:') ? segment.slice(6).toLowerCase() : null
  return [
    ...new Set(
      rows
        .filter((r) =>
          segment === 'everyone' ? true
          : segment === 'cash' ? r.cash
          : segment === 'tourney' ? r.tournament
          : venue ? (r.venues ?? []).some((v) => v.toLowerCase().includes(venue))
          : true,
        )
        .map((r) => (r.email ?? '').trim().toLowerCase())
        .filter((e) => /.+@.+\..+/.test(e)),
    ),
  ]
}

async function kfetch(path: string, apiKey: string, body: unknown): Promise<Response> {
  return fetch(`${KLAVIYO}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      'content-type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json',
      revision: REVISION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
}

/**
 * Klaviyo blast bones: a queued push gathers the segment's CRM emails, creates a
 * Klaviyo LIST named after the push, and subscribes the profiles into it — then
 * marks the push 'ready'. Actually firing the campaign (template, send time) is
 * done in Klaviyo against that list, which keeps the send button (and unsubscribe
 * compliance) on Klaviyo's side. No key => pushes stay queued, logged once.
 */
export async function processKlaviyoPushes(db: DB, apiKey: string): Promise<KlaviyoResult> {
  const { data: queued } = await db.from('klaviyo_pushes').select('*').eq('status', 'queued').limit(3)
  const pushes = (queued as Push[]) ?? []
  if (pushes.length === 0) return { prepared: 0 }

  if (!apiKey) {
    if (!klaviyoDisabled) {
      klaviyoDisabled = true
      console.warn(`[klaviyo] ${pushes.length} push(es) queued but KLAVIYO_API_KEY is not set — they hold until Klaviyo is connected`)
    }
    return { prepared: 0, disabled: true }
  }
  klaviyoDisabled = false

  let prepared = 0
  for (const push of pushes) {
    try {
      const emails = await segmentEmails(db, push.segment)
      if (emails.length === 0) throw new Error('segment has no usable emails')

      const listRes = await kfetch('/lists/', apiKey, {
        data: { type: 'list', attributes: { name: `WCP push: ${push.name}` } },
      })
      if (!listRes.ok) throw new Error(`list create ${listRes.status}`)
      const listJson = (await listRes.json()) as { data?: { id?: string } }
      const listId = listJson.data?.id
      if (!listId) throw new Error('no list id returned')

      // Bulk-subscribe the segment into the list (batches of 100 per API limits).
      for (let i = 0; i < emails.length; i += 100) {
        const chunk = emails.slice(i, i + 100)
        const subRes = await kfetch('/profile-subscription-bulk-create-jobs/', apiKey, {
          data: {
            type: 'profile-subscription-bulk-create-job',
            attributes: {
              profiles: {
                data: chunk.map((email) => ({
                  type: 'profile',
                  attributes: { email, subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } },
                })),
              },
            },
            relationships: { list: { data: { type: 'list', id: listId } } },
          },
        })
        if (!subRes.ok) throw new Error(`subscribe job ${subRes.status}`)
      }

      await db
        .from('klaviyo_pushes')
        .update({
          status: 'ready',
          sent_at: new Date().toISOString(),
          stats: { emails: emails.length, list_id: listId },
          push_error: null,
        })
        .eq('id', push.id)
      console.log(`[klaviyo] push "${push.name}": ${emails.length} email(s) loaded into Klaviyo list ${listId} — fire the campaign from Klaviyo`)
      prepared++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db.from('klaviyo_pushes').update({ status: 'failed', push_error: msg }).eq('id', push.id)
      console.error(`[klaviyo] push "${push.name}" failed:`, msg)
    }
  }
  return { prepared }
}
