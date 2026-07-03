import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>
type Post = Database['public']['Tables']['social_posts']['Row']

export interface SocialResult {
  published: number
  rolled: number
  disabled?: boolean
}

// A missing/rejected Postiz key is logged once per process, then quiet.
let postizDisabled = false

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
      // Postiz public API: create a post against every configured integration.
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/public/v1/posts`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'now',
          tags: [],
          shortLink: false,
          date: new Date().toISOString(),
          content: [p.title, p.body].filter(Boolean).join('\n\n'),
          platforms: p.platforms,
          image: p.asset_url || undefined,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`Postiz ${res.status} ${detail}`)
      }
      const j = (await res.json().catch(() => ({}))) as { id?: string }
      await db
        .from('social_posts')
        .update({ status: 'posted', posted_at: new Date().toISOString(), postiz_id: j.id ?? null, post_error: null })
        .eq('id', p.id)
      published++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db.from('social_posts').update({ status: 'failed', post_error: msg }).eq('id', p.id)
      console.error(`[social] publish failed for "${p.title}":`, msg)
      continue // a failed post still rolls below so the series isn't lost
    } finally {
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
