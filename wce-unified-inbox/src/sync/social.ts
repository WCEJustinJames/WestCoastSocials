import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { env } from '../lib/env'

type DB = SupabaseClient<Database>
type Post = Database['public']['Tables']['social_posts']['Row']

// Pseudo-channel: a post carrying this chip also pushes its artwork into
// LetsPoker as the live CLUB COVER (what players see in the app), via the
// letspoker-cover edge function (admin cookie + TOTP live server-side).
export const LP_BANNER = 'lp-banner'

export interface SocialResult {
  published: number
  rolled: number
  disabled?: boolean
}

// A missing/rejected Postiz key is logged once per process, then quiet.
let postizDisabled = false

interface Integration {
  id: string
  name?: string
  identifier?: string // platform slug: 'instagram', 'facebook', 'tiktok', ...
  disabled?: boolean
}

// Connected channels change rarely — cache the /integrations answer ~10 min.
let integrationsCache: { at: number; list: Integration[] } | null = null

async function pfetch<T>(base: string, path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base.replace(/\/$/, '')}/public/v1${path}`, {
    ...init,
    headers: { Authorization: apiKey, ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Postiz ${res.status} ${path}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  return (await res.json().catch(() => ({}))) as T
}

async function getIntegrations(base: string, apiKey: string): Promise<Integration[]> {
  if (integrationsCache && Date.now() - integrationsCache.at < 10 * 60_000) return integrationsCache.list
  const raw = await pfetch<Integration[] | { integrations?: Integration[] }>(base, '/integrations', apiKey)
  const list = (Array.isArray(raw) ? raw : raw.integrations ?? []).filter((i) => i?.id && !i.disabled)
  integrationsCache = { at: Date.now(), list }
  return list
}

/** Which connected channels a post targets ('instagram' matches by identifier/name). */
function matchIntegrations(all: Integration[], platforms: string[]): Integration[] {
  if (!platforms.length) return all
  return all.filter((i) => {
    const hay = `${i.identifier ?? ''} ${i.name ?? ''}`.toLowerCase()
    return platforms.some((p) => hay.includes(p.toLowerCase()))
  })
}

/**
 * Postiz requires images to be uploaded first; a Canva export link is fetched
 * and re-uploaded. Best-effort: a failure publishes text-only with the link
 * appended, rather than losing the post.
 */
async function uploadAsset(base: string, apiKey: string, url: string): Promise<Record<string, unknown> | null> {
  try {
    const src = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!src.ok) throw new Error(`asset fetch ${src.status}`)
    const blob = await src.blob()
    const name = (url.split('/').pop() ?? 'asset').split('?')[0] || 'asset.png'
    const form = new FormData()
    form.append('file', blob, name.includes('.') ? name : `${name}.png`)
    const res = await fetch(`${base.replace(/\/$/, '')}/public/v1/upload`, {
      method: 'POST',
      headers: { Authorization: apiKey },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  } catch (e) {
    console.warn('[social] asset upload failed (posting text-only):', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Push artwork into LetsPoker as the live club cover: fetch the direct image
 * link, re-encode as a data URL, and hand it to the letspoker-cover edge
 * function (which uploads to the club library and activates it — the same
 * two-step flow as the admin UI).
 */
async function pushLpBanner(assetUrl: string): Promise<void> {
  const src = await fetch(assetUrl, { signal: AbortSignal.timeout(30_000) })
  if (!src.ok) throw new Error(`artwork fetch ${src.status}`)
  const mime = (src.headers.get('content-type') ?? '').split(';')[0] || 'image/jpeg'
  if (!mime.startsWith('image/')) throw new Error(`artwork is ${mime} — needs a DIRECT image link (.png/.jpg)`)
  const buf = new Uint8Array(await src.arrayBuffer())
  if (buf.length > 8_000_000) throw new Error('artwork over 8MB — export a smaller banner')
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  const fileDataUrl = `data:${mime};base64,${btoa(bin)}`

  const res = await fetch(`${env.supabaseUrl}/functions/v1/letspoker-cover`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.supabaseServiceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'cover', fileDataUrl }),
    signal: AbortSignal.timeout(60_000),
  })
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; step?: string; body?: string }
  if (!res.ok || !j.ok) {
    throw new Error(`LP cover update failed (${j.error ?? j.step ?? res.status}) ${String(j.body ?? '').slice(0, 120)}`)
  }
}

/** The next occurrence for a repeat rule, or null when the rule ends. */
function nextOccurrence(post: Post): string | null {
  if (!post.scheduled_at || post.repeat_rule === 'none') return null
  const d = new Date(post.scheduled_at)
  switch (post.repeat_rule) {
    case 'daily': d.setDate(d.getDate() + 1); break
    case 'weekly': d.setDate(d.getDate() + 7); break
    case 'fortnightly': d.setDate(d.getDate() + 14); break
    case 'monthly': d.setMonth(d.getMonth() + 1); break
    default: return null
  }
  if (post.repeat_until && d.toISOString().slice(0, 10) > post.repeat_until) return null
  return d.toISOString()
}

/**
 * Publish due social posts through Postiz (which fans out to the connected
 * Instagram/Facebook/TikTok/... accounts) and roll repeating posts forward to
 * their next occurrence. No key => posts stay 'scheduled' untouched and a hint
 * is logged once, so nothing is lost before Postiz is connected.
 *
 * Postiz public API (docs.postiz.com/public-api): posts target INTEGRATION IDS
 * (the connected channels, listed via GET /integrations); our platform chips
 * ('instagram', 'facebook', …) are matched against each integration's
 * identifier/name at publish time, so connecting a new channel in Postiz needs
 * no change here.
 */
export async function publishSocialPosts(db: DB, apiUrl: string, apiKey: string): Promise<SocialResult> {
  const { data: due } = await db
    .from('social_posts')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .limit(10)
  const posts = (due as Post[]) ?? []
  if (posts.length === 0) return { published: 0, rolled: 0 }

  if (!apiKey) {
    if (!postizDisabled) {
      postizDisabled = true
      console.warn(`[social] ${posts.length} post(s) due but POSTIZ_API_KEY is not set — they hold until Postiz is connected`)
    }
    return { published: 0, rolled: 0, disabled: true }
  }
  postizDisabled = false

  let published = 0
  let rolled = 0
  for (const p of posts) {
    try {
      // Two legs: the LP club banner (when its chip is on) and the Postiz
      // social channels (any other chips; NO chips = all connected channels).
      // A leg that succeeds is never re-run — one failed leg marks the post
      // 'posted' with a warning rather than risking a double social post.
      const wantsLp = p.platforms.includes(LP_BANNER)
      const socialPlatforms = p.platforms.filter((x) => x !== LP_BANNER)
      const wantsSocial = socialPlatforms.length > 0 || p.platforms.length === 0
      const legs: string[] = []
      const errs: string[] = []
      let firstId = ''

      if (wantsLp) {
        try {
          if (!p.asset_url) throw new Error('LP banner needs an artwork link (direct image URL)')
          await pushLpBanner(p.asset_url)
          legs.push('LP banner')
        } catch (e) {
          errs.push(`LP banner: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (wantsSocial) {
        try {
          const all = await getIntegrations(apiUrl, apiKey)
          if (!all.length) throw new Error('no channels connected in Postiz yet — connect Instagram/Facebook/... there first')
          const targets = matchIntegrations(all, socialPlatforms)
          if (!targets.length) {
            throw new Error(`no connected channel matches [${socialPlatforms.join(', ')}] — connected: ${all.map((i) => i.identifier ?? i.name).join(', ')}`)
          }

          const media = p.asset_url ? await uploadAsset(apiUrl, apiKey, p.asset_url) : null
          // The caption is what gets posted; the title is just the calendar label
          // (and the fallback when no caption was written).
          let content = (p.body ?? '').trim() || p.title
          if (p.asset_url && !media) content += `\n\n${p.asset_url}`

          const body = {
            type: 'now',
            date: new Date().toISOString(),
            shortLink: false,
            tags: [],
            posts: targets.map((i) => ({
              integration: { id: i.id },
              value: [{ content, image: media ? [media] : [] }],
              settings: { __type: i.identifier ?? 'x' },
            })),
          }
          const j = await pfetch<unknown>(apiUrl, '/posts', apiKey, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          firstId = Array.isArray(j)
            ? String((j[0] as Record<string, unknown> | undefined)?.postId ?? (j[0] as Record<string, unknown> | undefined)?.id ?? '')
            : String((j as Record<string, unknown>)?.id ?? '')
          legs.push(`${targets.length} channel(s): ${targets.map((i) => i.identifier ?? i.name).join(', ')}`)
        } catch (e) {
          errs.push(e instanceof Error ? e.message : String(e))
        }
      }

      if (!legs.length) throw new Error(errs.join(' · ') || 'nothing to publish')
      await db
        .from('social_posts')
        .update({
          status: 'posted',
          posted_at: new Date().toISOString(),
          postiz_id: firstId || null,
          post_error: errs.length ? `partial: ${errs.join(' · ')}` : null,
        })
        .eq('id', p.id)
      console.log(`[social] "${p.title}" published — ${legs.join(' + ')}${errs.length ? ` (partial: ${errs.join(' · ')})` : ''}`)
      published++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db.from('social_posts').update({ status: 'failed', post_error: msg }).eq('id', p.id)
      console.error(`[social] publish failed for "${p.title}":`, msg)
    } finally {
      // A failed occurrence still rolls forward so the series isn't lost.
      const next = nextOccurrence(p)
      if (next) {
        await db.from('social_posts').insert({
          title: p.title,
          body: p.body,
          asset_url: p.asset_url,
          platforms: p.platforms,
          scheduled_at: next,
          repeat_rule: p.repeat_rule,
          repeat_until: p.repeat_until,
          status: 'scheduled',
        })
        rolled++
      }
    }
  }
  return { published, rolled }
}
