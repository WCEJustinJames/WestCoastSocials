import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { VOICE } from './voice'
import { classifyAiError, type AiOutcome } from './alert'

type DB = SupabaseClient<Database>
type Schedule = Database['public']['Tables']['inbox_schedules']['Row']

export interface SocialAutoResult {
  created: number
  ai?: AiOutcome
}

/**
 * Game-week social autopilot. Every active game schedule gets TWO promo posts
 * per occurrence in the next 7 days — a day-before hype post (17:30) and a
 * morning-of reminder (09:30) — AI-written in the house voice and saved as
 * DRAFTS on the Social calendar. Justin approves the week in one sitting
 * ("Schedule all drafts"); Postiz publishes to every connected channel.
 * Idempotent via source_key (schedule x game-date x slot), so edits/deletes to
 * one week's drafts are never resurrected or duplicated.
 */
const SYSTEM_PROMPT = `You write short social media posts for West Coast Poker (WCP), a Perth poker club. These are PUBLIC posts (Instagram/Facebook), not private texts, promoting a regular game.

${VOICE}

Adjust for social: speaking to the room, not one player (never {{first_name}}). A single tasteful emoji is fine. End with a short call to action like "DM us to lock a seat."
Rules:
- Under 350 characters each. No em-dashes. No hashtags spam (max 2, optional). Don't invent buy-ins, prices, or times not given.
- Return ONLY a JSON object: {"day_before": "...", "day_of": "..."} — the first hypes tomorrow's game, the second reminds that it's on TONIGHT.`

const SLOTS = [
  { key: 'daybefore', offsetDays: -1, time: '17:30' },
  { key: 'dayof', offsetDays: 0, time: '09:30' },
] as const

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function generateSocialPromos(db: DB, anthropic: Anthropic, model: string): Promise<SocialAutoResult> {
  const { data: scheds } = await db.from('inbox_schedules').select('*').eq('active', true)
  const schedules = (scheds as Schedule[]) ?? []
  if (!schedules.length) return { created: 0 }

  // Every schedule occurrence in the next 7 days, with the slots still ahead of us.
  const now = new Date()
  const wanted: { s: Schedule; gameDate: string; gameDay: Date; slot: (typeof SLOTS)[number]; at: Date; key: string }[] = []
  for (let off = 0; off <= 7; off++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off)
    for (const s of schedules) {
      if (s.day_of_week !== day.getDay()) continue
      const gameDate = localISO(day)
      for (const slot of SLOTS) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + slot.offsetDays)
        const [h, m] = slot.time.split(':').map(Number)
        at.setHours(h, m, 0, 0)
        if (at <= now) continue // that window already passed
        wanted.push({ s, gameDate, gameDay: day, slot, at, key: `promo:${s.id}:${gameDate}:${slot.key}` })
      }
    }
  }
  if (!wanted.length) return { created: 0 }

  // Which already exist (including ones Justin edited or deleted-and-rebuilt)?
  const { data: existing } = await db
    .from('social_posts')
    .select('source_key')
    .in('source_key', wanted.map((w) => w.key))
  const have = new Set((existing ?? []).map((x) => x.source_key))
  const missing = wanted.filter((w) => !have.has(w.key))
  if (!missing.length) return { created: 0 }

  // One AI call per schedule occurrence covers both slots.
  const byOccurrence = new Map<string, typeof missing>()
  for (const w of missing) {
    const k = `${w.s.id}:${w.gameDate}`
    byOccurrence.set(k, [...(byOccurrence.get(k) ?? []), w])
  }

  let created = 0
  let aiOutcome: AiOutcome | undefined
  for (const group of byOccurrence.values()) {
    const { s, gameDay } = group[0]
    const label = [s.venue, s.game_type, DOW[gameDay.getDay()], s.event_time].filter(Boolean).join(' ')
    let text = ''
    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content:
            `Game: ${s.name}. Venue: ${s.venue ?? 'TBC'}. Type: ${s.game_type ?? 'poker'} game. ` +
            `Day: ${DOW[gameDay.getDay()]} ${gameDay.getDate()}/${gameDay.getMonth() + 1}. ` +
            `Start time: ${s.event_time ?? 'evening'}. Reference wording from the invite: ${s.template_body}`,
        }],
      })
      text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      aiOutcome = { ok: true }
    } catch (e) {
      aiOutcome = { ok: false, ...classifyAiError(e) }
      console.error('[socialauto] AI error:', e instanceof Error ? e.message : e)
      break // a bad key fails every occurrence — stop hammering this pass
    }

    const copy = parsePromos(text)
    if (!copy) continue
    for (const w of group) {
      const body = w.slot.key === 'daybefore' ? copy.day_before : copy.day_of
      if (!body) continue
      const { error } = await db.from('social_posts').insert({
        title: `${label} (${w.slot.key === 'daybefore' ? 'day before' : 'game day'})`,
        body,
        platforms: [], // all connected channels
        scheduled_at: w.at.toISOString(),
        status: 'draft', // approval-gated: Justin schedules them from the Social tab
        source: 'autopilot',
        source_key: w.key,
      })
      if (!error) created++
    }
  }
  if (created) console.log(`[socialauto] drafted ${created} promo post(s) for the week — approve them in Social`)
  return { created, ai: aiOutcome }
}

/** Pull {"day_before","day_of"} out of the model's reply, tolerating stray prose. */
function parsePromos(raw: string): { day_before?: string; day_of?: string } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const clean = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.replace(/[—–]/g, ', ').trim().slice(0, 500) : undefined
    const day_before = clean(o.day_before)
    const day_of = clean(o.day_of)
    return day_before || day_of ? { day_before, day_of } : null
  } catch {
    return null
  }
}
