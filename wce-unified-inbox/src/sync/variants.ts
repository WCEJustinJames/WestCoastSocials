import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { VOICE } from './voice'
import { classifyAiError, type AiOutcome } from './alert'

type DB = SupabaseClient<Database>

export interface VariantsResult {
  generated: number
  venues: number
  /** How the Anthropic call went this pass (undefined = none made). */
  ai?: AiOutcome
}

/**
 * Outreach drafting (Roadmap #3). For each venue with an active schedule, pre-write
 * THREE invite variants (varied angle + length) in Justin's voice, so he can pick one
 * in the Batches composer instead of writing from scratch. Refreshed ~daily; replaces
 * a venue's variants atomically (deactivate old, insert three new). Bounded: one
 * Anthropic call per venue, and venues with fresh variants are skipped.
 */
const SYSTEM_PROMPT = `You write short invite messages for West Coast Poker (WCP). Justin texts players 1:1 to invite them to a game tonight.

${VOICE}

Write exactly THREE different invite messages for tonight's game at the given venue. Make them genuinely different in angle and length:
1) terse, game-first (lead with the stakes/venue, very short)
2) social proof (mention seats left / who's around, a touch longer)
3) a short, low-key nudge
Rules:
- Use {{first_name}} where the player's name goes.
- Keep each under 220 characters. No em-dashes. No hype, no exclamation marks. Don't invent specific buy-ins, times, or prices unless they're in the reference wording.
- Return ONLY a JSON array of exactly three strings, nothing else.`

export async function generateInviteVariants(
  db: DB,
  anthropic: Anthropic,
  model: string,
): Promise<VariantsResult> {
  const { data: scheds } = await db
    .from('inbox_schedules')
    .select('venue, template_body')
    .eq('active', true)
  const byVenue = new Map<string, string>()
  for (const s of scheds ?? []) {
    if (s.venue && !byVenue.has(s.venue)) byVenue.set(s.venue, s.template_body)
  }
  if (byVenue.size === 0) return { generated: 0, venues: 0 }

  let generated = 0
  let venues = 0
  let aiOutcome: AiOutcome | undefined
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString() // ~daily refresh

  for (const [venue, base] of byVenue) {
    const { data: existing } = await db
      .from('inbox_invite_variants')
      .select('id')
      .eq('venue', venue)
      .eq('active', true)
      .gte('created_at', since)
      .limit(1)
    if (existing && existing.length > 0) continue // already fresh

    let text = ''
    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Venue: ${venue}. Tonight's game. Base wording for reference: ${base}` }],
      })
      text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      aiOutcome = { ok: true }
    } catch (e) {
      aiOutcome = { ok: false, ...classifyAiError(e) }
      console.error('[variants] AI error:', e instanceof Error ? e.message : e)
      break // a bad key fails every venue — stop hammering this pass
    }

    const variants = parseVariants(text)
    if (variants.length === 0) continue

    await db.from('inbox_invite_variants').update({ active: false }).eq('venue', venue).eq('active', true)
    const { error } = await db
      .from('inbox_invite_variants')
      .insert(variants.map((body) => ({ venue, body })))
    if (!error) {
      generated += variants.length
      venues++
    }
  }

  return { generated, venues, ai: aiOutcome }
}

/** Pull the JSON array of strings out of the model's reply, tolerating stray prose. */
function parseVariants(raw: string): string[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.replace(/[—–]/g, ', ').trim()) // strip em/en dashes per house rule
      .filter((s) => s.length > 0)
      .slice(0, 3)
  } catch {
    return []
  }
}
