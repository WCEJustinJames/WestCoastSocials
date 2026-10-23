import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { normalizeAuMobile } from './batches'

type DB = SupabaseClient<Database>

export interface ScheduledBatchResult {
  /** Draft batches created this pass. */
  created: number
  /** Schedules that were due and materialised this pass. */
  schedules: number
}

/**
 * Weekly auto-draft engine. Each active schedule says: on this weekday, this
 * many days ahead, build a DRAFT batch for this venue from this standing list
 * using this message. This turns those rules into real draft batches — the
 * piece the admin-hub Schedules screen promises but nothing was building.
 *
 * SAFETY. It only ever writes a batch as status 'draft' with items 'pending' —
 * exactly what the admin composer's "Save as draft" writes, and exactly what
 * the send rail (processBatches) NEVER touches. A human still opens the draft,
 * reviews it and hits Approve, which re-runs the full exclusion guard before a
 * single message goes out. Nothing here sends.
 *
 * IDEMPOTENT two ways: `inbox_schedules.last_materialised_for` records the last
 * game-date built, and the deterministic batch name ("<schedule> — <date>") is
 * checked for existence before inserting — so a crash between the insert and
 * the stamp can't produce a duplicate draft on the next pass.
 */

/** Perth-local YYYY-MM-DD. The sync box runs on Perth time, so `Date` is local. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole days from `from` to the next occurrence of weekday `dow` (0=Sun); 0 when today IS that day. */
export function daysUntilDow(dow: number, from: Date): number {
  return ((dow - from.getDay()) % 7 + 7) % 7
}

/** The date of the next occurrence of `dow`, at local midnight. */
export function nextOccurrence(dow: number, from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  d.setDate(d.getDate() + daysUntilDow(dow, from))
  return d
}

/** Fill the message template — same placeholders as the admin composer. */
export function fillTemplate(tpl: string, names: { name: string; first: string; nickname: string }): string {
  return tpl
    .replace(/\{name\}/gi, names.name)
    .replace(/\{first\}/gi, names.first)
    .replace(/\{nickname\}/gi, names.nickname)
}

type OutreachRow = {
  id: string
  player_name: string | null
  first_name: string | null
  nickname: string | null
  phone: string | null
  beeper_chat_id: string | null
  region: string | null
  preferred_channel: string | null
  do_not_message: boolean
  hidden: boolean
  staff: boolean
}

/* ---- permit gate -------------------------------------------------------
   Compliance: automated outreach for a game may only go out if that game's
   venue and month sit under an active DLGSC permit. WCE's protection is the
   evidence, so the bar here is an APPROVED (not rejected/withdrawn), PAID
   permit that covers the game type. No permit => no draft. Fail closed. */

type PermitRow = {
  venue_name: string | null
  games: string[] | null
  outcome: string | null
  paid_at: string | null
  permit_no: string | null
}

/** Normalise a venue to a comparable key: lowercase, letters+digits only. */
function venueKey(s: string | null): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** A schedule's short venue ("Woodvale") vs a permit's full name ("The Woodvale
 *  Tavern") — one contains the other once both are reduced to a key. */
function venueMatches(scheduleVenue: string | null, permitVenue: string | null): boolean {
  const a = venueKey(scheduleVenue)
  const b = venueKey(permitVenue)
  if (a.length < 3 || b.length < 3) return false
  return a.includes(b) || b.includes(a)
}

/** Map a schedule's free-text game type to the permit's game classes. */
function gameClass(gt: string | null): 'cash' | 'tournament' | null {
  const g = (gt ?? '').toLowerCase()
  if (/\bcash\b|\$|\d\s*\/\s*\d/.test(g)) return 'cash'
  if (/tourn|\bmtt\b|freeze\s*out|bounty|deep\s*stack/.test(g)) return 'tournament'
  return null
}

/**
 * Find an active, paid permit covering this venue + game date + game type.
 * Returns the permit (for the audit log) or null when the game isn't permitted.
 * wcp_permits isn't in the worker's generated types, so the query is cast.
 */
async function activePermitFor(
  db: DB, venue: string | null, gameDate: string, gameType: string | null,
): Promise<PermitRow | null> {
  const month = `${gameDate.slice(0, 7)}-01` // first of the game's month, YYYY-MM-01
  const q = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => Promise<{ data: PermitRow[] | null; error: unknown }>
      }
    }
  }
  const { data } = await q.from('wcp_permits').select('venue_name, games, outcome, paid_at, permit_no').eq('permit_month', month)
  const rows = data ?? []
  const cls = gameClass(gameType)
  return rows.find((r) =>
    r.outcome == null &&           // not rejected / withdrawn
    r.paid_at != null &&           // fully evidenced (application + receipt filed)
    venueMatches(venue, r.venue_name) &&
    (cls == null || (r.games ?? []).includes(cls)),
  ) ?? null
}

function displayNames(r: OutreachRow): { name: string; first: string; nickname: string } {
  const name = (r.player_name ?? '').trim() || (r.nickname ?? '').trim() || (r.first_name ?? '').trim() || 'there'
  const first = (r.first_name ?? '').trim() || (name.split(' ')[0] ?? name).trim()
  const nickname = (r.nickname ?? '').trim() || first
  return { name, first, nickname }
}

export async function generateScheduledBatches(db: DB, now: Date = new Date()): Promise<ScheduledBatchResult> {
  const { data: scheds, error } = await db
    .from('inbox_schedules')
    .select('id, name, venue, game_type, template_body, day_of_week, list_id, lead_days, last_materialised_for, active')
    .eq('active', true)
  if (error) throw error

  let created = 0
  let schedules = 0

  for (const s of scheds ?? []) {
    if (!s.list_id) continue // a schedule with no list has nobody to draft for
    const daysUntil = daysUntilDow(s.day_of_week, now)
    if (daysUntil > (s.lead_days ?? 0)) continue // not inside the lead window yet
    const gameDate = ymd(nextOccurrence(s.day_of_week, now))
    if (s.last_materialised_for === gameDate) continue // already built for this occurrence

    const batchName = `${s.name} — ${gameDate}`

    // Hard idempotency guard: never a second draft for the same occurrence, even
    // if last_materialised_for failed to stamp after a previous insert.
    const { data: dupe } = await db.from('inbox_batches').select('id').eq('name', batchName).limit(1)
    if (dupe && dupe.length > 0) {
      await db.from('inbox_schedules').update({ last_materialised_for: gameDate }).eq('id', s.id)
      continue
    }

    // COMPLIANCE GATE: no automated outreach for a game that isn't permitted.
    // Deliberately NOT stamped as materialised — if the permit is filed later,
    // the next pass picks it up and drafts, still inside the lead window.
    const permit = await activePermitFor(db, s.venue, gameDate, s.game_type)
    if (!permit) {
      console.log(`[schedules] no active paid permit for "${s.venue ?? '(no venue)'}" ${gameDate.slice(0, 7)} — not drafting "${s.name}"`)
      continue
    }

    // List members → outreach rows.
    const { data: members } = await db
      .from('inbox_list_members')
      .select('outreach_id')
      .eq('list_id', s.list_id)
    const ids = (members ?? []).map((m) => m.outreach_id)
    if (ids.length === 0) {
      await db.from('inbox_schedules').update({ last_materialised_for: gameDate }).eq('id', s.id)
      continue
    }

    const rows: OutreachRow[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const { data: chunk } = await db
        .from('inbox_outreach')
        .select('id, player_name, first_name, nickname, phone, beeper_chat_id, region, preferred_channel, do_not_message, hidden, staff')
        .in('id', ids.slice(i, i + 500))
      rows.push(...((chunk ?? []) as OutreachRow[]))
    }

    // Light filter mirrors the composer's send plan: drop banned/hidden/staff and
    // the unreachable, dedupe by mobile. The heavy exclusion reconciliation (LP /
    // platform block) and opt-out re-check run at Approve and at send time.
    const items: Database['public']['Tables']['inbox_batch_items']['Insert'][] = []
    const seenPhone = new Set<string>()
    for (const r of rows) {
      if (r.do_not_message || r.hidden || r.staff) continue
      const phone = r.phone ? normalizeAuMobile(r.phone) : null
      const hasThread = !!r.beeper_chat_id
      if (!phone && !hasThread) continue
      if (phone) {
        if (seenPhone.has(phone)) continue
        seenPhone.add(phone)
      }
      const channel: 'sms' | 'thread' = phone && r.preferred_channel !== 'thread' ? 'sms' : hasThread ? 'thread' : 'sms'
      const names = displayNames(r)
      items.push({
        batch_id: '', // set after the batch row exists
        rendered_text: fillTemplate(s.template_body, names),
        status: 'pending',
        guard_flag: false,
        data: {
          outreach_id: r.id,
          beeper_chat_id: r.beeper_chat_id,
          phone: r.phone,
          account_id: 'gmessages',
          channel,
          name: names.name,
          region: r.region,
        },
      })
    }

    if (items.length === 0) {
      await db.from('inbox_schedules').update({ last_materialised_for: gameDate }).eq('id', s.id)
      continue
    }

    const { data: batch, error: bErr } = await db
      .from('inbox_batches')
      .insert({
        name: batchName,
        template_body: s.template_body,
        status: 'draft',
        created_by: 'schedule',
        is_outreach: true,
        venue: s.venue,
      })
      .select('id')
      .single()
    if (bErr || !batch) {
      console.error(`[schedules] batch insert failed for "${s.name}":`, bErr?.message ?? 'unknown')
      continue
    }

    const withBatch = items.map((it) => ({ ...it, batch_id: batch.id }))
    const { error: iErr } = await db.from('inbox_batch_items').insert(withBatch)
    if (iErr) {
      // Roll back the empty batch so a retry next pass produces a clean draft.
      await db.from('inbox_batches').delete().eq('id', batch.id)
      console.error(`[schedules] item insert failed for "${s.name}":`, iErr.message)
      continue
    }

    await db.from('inbox_schedules').update({ last_materialised_for: gameDate }).eq('id', s.id)
    created++
    schedules++
    console.log(`[schedules] drafted "${batchName}" — ${withBatch.length} recipient(s), under permit ${permit.permit_no ?? '(no number)'}`)
  }

  return { created, schedules }
}
