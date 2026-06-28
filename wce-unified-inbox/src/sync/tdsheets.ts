import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { accessToken } from './contacts'

type DB = SupabaseClient<Database>

export interface TdSheetsResult {
  sheets: number
  attendees: number
}

interface Attendee {
  name: string
  category: 'cash' | 'electronic' | 'tournament'
  winner: boolean
}

const DRIVE_URL = 'https://www.googleapis.com/drive/v3/files'
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets'

async function gfetch<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Google ${res.status} ${url.split('?')[0]}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  return (await res.json()) as T
}

// Today's and yesterday's date in the forms that show up in sheet titles
// ("25/06 Woodvale") — yesterday too, so a game that ran past midnight still matches.
function dateNeedles(now: Date): string[] {
  const out = new Set<string>()
  for (const off of [0, 1]) {
    const d = new Date(now.getTime() - off * 86_400_000)
    const day = d.getDate(), mon = d.getMonth() + 1
    const dd = String(day).padStart(2, '0'), mm = String(mon).padStart(2, '0')
    out.add(`${day}/${mm}`); out.add(`${dd}/${mm}`); out.add(`${day}/${mon}`); out.add(`${dd}/${mon}`)
  }
  return [...out]
}

const TITLE_RE = /^\s*(\d{1,2})\/(\d{1,2})\s+(.+?)\s*$/ // "25/06 Woodvale"

function isoDate(day: number, mon: number, now: Date): string {
  let year = now.getFullYear()
  // A month far ahead of "now" means the sheet is from last year (Dec/Jan wrap).
  if (mon - (now.getMonth() + 1) > 6) year -= 1
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function cleanName(raw: string | undefined): string | null {
  const n = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (n.length < 2) return null
  if (n.includes('@')) return null // emails (banking rows)
  if (/^[$\d]/.test(n)) return null // amounts / numbers
  if (/^[a-z]$/i.test(n)) return null // single-letter ("e"/"p" receipt markers)
  if (/tourny|chips|eftpos|payid|no_header|pending|total|^drop$|rake|dealer|^name$|^player$|^placing$|^amount$|^time$/i.test(n))
    return null
  return n
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Pull players from one sheet's tabs. Three player-bearing section shapes (matched
 * by their header row), per how the TD sheets are laid out:
 *  - "Player Full Name" column   -> electronic (PayID/EFTPOS) buy-ins & cash-outs
 *  - "Name | Amount | Time" row   -> cash-game transactions
 *  - "Placing | Player | Prize"   -> tournament results (placing 1 = winner)
 * Dealer / "Staff Status" / timesheet (Start+Finish) sections are skipped so we
 * never message staff. A blank in the active name column ends that section.
 */
function extractAttendees(tabs: string[][][]): Attendee[] {
  const found = new Map<string, Attendee>()
  const add = (name: string | null, category: Attendee['category'], winner = false) => {
    if (!name) return
    const k = norm(name)
    if (k.length < 2) return
    const prev = found.get(k)
    if (!prev) found.set(k, { name, category, winner })
    else if (winner) prev.winner = true
  }
  for (const rows of tabs) {
    let mode: Attendee['category'] | null = null
    let nameCol = -1
    let placingCol = -1
    for (const row of rows) {
      const cells = row.map((c) => (c ?? '').toString().trim())
      const lc = cells.map((c) => c.toLowerCase())
      // Excluded section (dealers / staff / timesheets) — stop extracting.
      if (
        lc.some((c) => /dealer|staff status|role class|croupier/.test(c)) ||
        (lc.includes('start') && lc.includes('finish'))
      ) {
        mode = null; nameCol = -1; placingCol = -1
        continue
      }
      const pfn = lc.indexOf('player full name')
      const placingIdx = lc.indexOf('placing')
      const playerIdx = lc.indexOf('player')
      const nameIdx = lc.indexOf('name')
      const hasAmt = lc.includes('amount'), hasTime = lc.includes('time')
      if (pfn >= 0) { mode = 'electronic'; nameCol = pfn; placingCol = -1; continue }
      if (placingIdx >= 0 && playerIdx >= 0) { mode = 'tournament'; nameCol = playerIdx; placingCol = placingIdx; continue }
      if (nameIdx >= 0 && hasAmt && hasTime) { mode = 'cash'; nameCol = nameIdx; placingCol = -1; continue }
      // Data row inside an active player section.
      if (mode && nameCol >= 0) {
        const name = cleanName(cells[nameCol])
        if (!name) { mode = null; nameCol = -1; placingCol = -1; continue } // blank ends the list
        const winner = mode === 'tournament' && placingCol >= 0 && cells[placingCol] === '1'
        add(name, mode, winner)
      }
    }
  }
  return [...found.values()]
}

/**
 * Find tonight's (and last night's) "DD/MM Venue" Google Sheets, read the
 * player-bearing sections out of each, and upsert the names into
 * inbox_td_attendees for the post-game tool to load. Read-only on Drive/Sheets.
 */
export async function syncTdSheets(
  db: DB,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TdSheetsResult> {
  const now = new Date()
  const token = await accessToken(clientId, clientSecret, refreshToken)
  const needles = dateNeedles(now)
  const q =
    `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (` +
    needles.map((n) => `name contains '${n}'`).join(' or ') +
    `)`
  const list = await gfetch<{ files?: { id: string; name: string }[] }>(
    `${DRIVE_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&pageSize=25`,
    token,
  )
  const sheets = (list.files ?? []).filter((f) => TITLE_RE.test(f.name)).slice(0, 12)

  let attendees = 0
  for (const f of sheets) {
    const m = f.name.match(TITLE_RE)
    if (!m) continue
    const venue = m[3].trim()
    const gameDate = isoDate(Number(m[1]), Number(m[2]), now)

    const meta = await gfetch<{ sheets?: { properties?: { title?: string } }[] }>(
      `${SHEETS_URL}/${f.id}?fields=${encodeURIComponent('sheets(properties(title))')}`,
      token,
    )
    const titles = (meta.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[]
    const tabs: string[][][] = []
    for (const t of titles) {
      try {
        const range = encodeURIComponent(`'${t.replace(/'/g, "''")}'`)
        const v = await gfetch<{ values?: string[][] }>(`${SHEETS_URL}/${f.id}/values/${range}`, token)
        if (v.values?.length) tabs.push(v.values)
      } catch {
        /* skip an unreadable tab */
      }
    }

    const people = extractAttendees(tabs)
    if (!people.length) continue
    const rows = people.map((p) => ({
      sheet_id: f.id,
      sheet_title: f.name,
      venue,
      game_date: gameDate,
      name: p.name,
      is_winner: p.winner,
      category: p.category,
      synced_at: now.toISOString(),
    }))
    const { error } = await db
      .from('inbox_td_attendees')
      .upsert(rows, { onConflict: 'sheet_id,name', ignoreDuplicates: false })
    if (!error) attendees += rows.length
  }

  return { sheets: sheets.length, attendees }
}
