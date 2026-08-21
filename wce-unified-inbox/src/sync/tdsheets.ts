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
// Without these, drive/v3/files returns My Drive and "Shared with me" only —
// anything living in a Workspace SHARED DRIVE is invisible, however widely it is
// shared. That is silent: the request succeeds and simply omits them, so a game
// whose sheet sits in a shared drive looks exactly like a game that never ran.
const DRIVE_SCOPE = '&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives'
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets'

async function gfetch<T>(url: string, token: string): Promise<T> {
  // The full-history backfill reads hundreds of sheets, so quota 429s (and the
  // occasional 5xx) get a couple of patient retries instead of failing the run.
  //
  // A TIMEOUT is not an HTTP status — it rejects, so it used to skip the retry
  // logic entirely and abort the whole sweep. One slow spreadsheet ended a
  // 359-sheet run after six. Thrown errors now retry on the same terms.
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)))
        continue
      }
      throw e
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, res.status === 429 ? 20_000 : 3_000))
      continue
    }
    if (!res.ok) {
      throw new Error(`Google ${res.status} ${url.split('?')[0]}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
    return (await res.json()) as T
  }
}

// Sheet-title date forms ("25/06 Woodvale") for the last `lookbackDays` days.
// The live sync uses 1 (today + yesterday, so a game past midnight still matches);
// the backfill script passes ~70 to sweep the recent season. Titles carry no
// year, so 366 days of needles covers every possible DD/MM — i.e. a lookback of
// 366+ matches EVERY TD sheet ever named, whatever year it's from.
function dateNeedles(now: Date, lookbackDays = 1): string[] {
  const out = new Set<string>()
  for (let off = 0; off <= Math.min(lookbackDays, 366); off++) {
    const d = new Date(now.getTime() - off * 86_400_000)
    const day = d.getDate(), mon = d.getMonth() + 1
    const dd = String(day).padStart(2, '0'), mm = String(mon).padStart(2, '0')
    // Both separators are in the wild: "25/06 Woodvale" and "02.07. Woody".
    for (const sep of ['/', '.']) {
      out.add(`${day}${sep}${mm}`); out.add(`${dd}${sep}${mm}`)
      out.add(`${day}${sep}${mon}`); out.add(`${dd}${sep}${mon}`)
    }
  }
  return [...out]
}

// TD sheet names in the wild: "25/06 Woodvale", "02.07. Woody", and (per the
// missed 1 July MCT game) venue-first with a year: "mct 1/7/26". Accept
// date-first or venue-last, either separator, optional 2/4-digit year.
interface TitleInfo { day: number; mon: number; year: number | null; venue: string }
export function parseTitle(name: string): TitleInfo | null {
  const mk = (d: string, mo: string, y: string | undefined, venue: string): TitleInfo | null => {
    const day = Number(d), mon = Number(mo)
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null
    const v = venue.trim()
    if (!/[a-z]/i.test(v)) return null
    const year = y ? (Number(y) < 100 ? 2000 + Number(y) : Number(y)) : null
    return { day, mon, year, venue: v }
  }
  let m = name.match(/^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\.?\s+(.+?)\s*$/)
  if (m) return mk(m[1], m[2], m[3], m[4])
  m = name.match(/^\s*(.+?)\s+(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\.?\s*$/)
  if (m) return mk(m[2], m[3], m[4], m[1])
  return null
}

// Titles carry no year, so it's inferred: from the file's Drive createdTime when
// we have it (TD sheets are made on/near game day — right across years of
// history), else from "now" (the live sync's today/yesterday case). Either
// anchor gets the Dec/Jan wrap adjustment.
function isoDate(day: number, mon: number, anchor: Date): string {
  let year = anchor.getFullYear()
  const anchorMon = anchor.getMonth() + 1
  if (mon - anchorMon > 6) year -= 1 // "28/12" file created in January
  if (anchorMon - mon > 6) year += 1 // "02/01" file created in December
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

/** 0-based column index -> A1 letter ("0"->A, "26"->AA). */
function colLetter(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export interface TransferLine {
  kind: 'transfer_in' | 'transfer_out' | 'winner_payout'
  direction: 'in' | 'out'
  row_num: number // 1-based sheet row
  name: string
  amount: string | null
  receipt: string | null
  wcp_verified: string | null
  time_stamp: string | null
  pay_method: string | null
  notes: string | null
  office_confirm: string
  confirm_col: string
  receipt_col: string | null
}

/**
 * Pull the bank-transfer lines out of one tab, with cell coordinates so the
 * dashboard's JL confirmation can be written back to the exact Office Confirm
 * cell. Sections are found by their header rows (two can share one row — cash
 * IN on the left, cash OUT on the right):
 *  - "Player Full Name | ... Receipt # | WCP Verified | Time | Office Confirm"  (cash in)
 *  - "Player Full Name | Amount | ... Receipt # (Last 4) | Office Confirm"      (cash out)
 *  - "Name | Amount | Receipt # (last 4 dig) | WCP Verify | Time | Office Confirm" (tourney in)
 *  - "Placing | Player | Prize | Pay Method | Office Confirm"                   (winner payouts)
 * Direction: winners and no-timestamp sections are money OUT; the rest are IN.
 */
export function extractTransfers(rows: string[][]): TransferLine[] {
  const out: TransferLine[] = []
  for (let ri = 0; ri < rows.length; ri++) {
    const lc = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim().toLowerCase())
    // A header row can hold several sections side by side — find each name-column.
    const starts: number[] = []
    for (let ci = 0; ci < lc.length; ci++) {
      if (lc[ci] === 'player full name' || lc[ci] === 'placing' || (lc[ci] === 'name' && lc.some((c) => c.includes('office confirm')))) {
        starts.push(ci)
      }
    }
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s]
      const to = s + 1 < starts.length ? starts[s + 1] : lc.length
      const seg = lc.slice(from, to)
      const at = (pred: (c: string) => boolean): number => {
        const i = seg.findIndex(pred)
        return i < 0 ? -1 : from + i
      }
      const confirmIdx = at((c) => c.includes('office confirm'))
      if (confirmIdx < 0) continue // not a transfer section (e.g. bare winners grid)
      const isWinners = lc[from] === 'placing'
      const nameIdx = isWinners ? at((c) => c === 'player') : from
      if (nameIdx < 0) continue
      const amountIdx = at((c) => c === 'amount' || c === 'prize')
      const receiptIdx = at((c) => c.includes('receipt'))
      const verifyIdx = at((c) => c.includes('wcp'))
      const timeIdx = at((c) => c.includes('time'))
      const payIdx = at((c) => c.includes('pay method'))
      const accountIdx = at((c) => c === 'account')
      const notesIdx = at((c) => c === 'notes')
      const kind: TransferLine['kind'] = isWinners
        ? 'winner_payout'
        : verifyIdx >= 0 || timeIdx >= 0
          ? 'transfer_in'
          : 'transfer_out'

      for (let r = ri + 1; r < Math.min(rows.length, ri + 80); r++) {
        const cells = (rows[r] ?? []).map((c) => (c ?? '').toString().trim())
        const nm = cells[nameIdx] ?? ''
        if (!nm) break // a blank name ends the section
        if (/^(player full name|name|player|total)$/i.test(nm)) break
        out.push({
          kind,
          direction: kind === 'transfer_in' ? 'in' : 'out',
          row_num: r + 1, // values arrays start at sheet row 1
          name: nm,
          amount: amountIdx >= 0 ? cells[amountIdx] || null : null,
          receipt: receiptIdx >= 0 ? cells[receiptIdx] || null : null,
          wcp_verified: verifyIdx >= 0 ? cells[verifyIdx] || null : null,
          time_stamp: timeIdx >= 0 ? cells[timeIdx] || null : null,
          // pay method for winners; the Account channel (AC1/NAB/EFTPOS) for ins.
          pay_method: payIdx >= 0 ? cells[payIdx] || null : accountIdx >= 0 ? cells[accountIdx] || null : null,
          notes: notesIdx >= 0 ? cells[notesIdx] || null : null,
          office_confirm: (cells[confirmIdx] ?? '').trim(),
          confirm_col: colLetter(confirmIdx),
          receipt_col: receiptIdx >= 0 ? colLetter(receiptIdx) : null,
        })
      }
    }
  }
  return out
}

// ----- financial harvest (Home dashboard tiles + trend) -----
const FIN_TAB = /financial|reconcil|invoice/i
const FIN_LABEL = /profit|rake|drop|buy.?in|total|expense|fee|gst|wage|croupier|dealer|staff|payout|float|takings|revenue|income|cost|balance|banked|turnover/i
const MONEY_RE = /^\(?-?\$?\s?-?\d[\d,]*(\.\d+)?\)?$/

export interface FinancialLine {
  row_num: number
  label: string
  norm_label: string
  value_num: number | null
  value_raw: string
}

const isLabelCell = (c: string): boolean => /[a-z]/i.test(c) && c.length >= 3 && c.length <= 60
const isMoneyCell = (raw: string): boolean =>
  // Money-looking, but not a bare small integer (headcount / table number).
  !!raw && MONEY_RE.test(raw) && !(!/[$,.]/.test(raw) && raw.replace(/\D/g, '').length < 3)

/**
 * Pull label:value money lines out of a financial tab. Deliberately generic —
 * a texty cell is a label, the first money-looking cell to its right (before the
 * next label) is its value; the metric mapping lives in the inbox_financial_summary
 * view.
 *
 * Scans EVERY label on a row, not just the first — the older TD templates lay the
 * financials out in two side-by-side blocks (e.g. a Staff column at B and an
 * Expenses column at K), so "Croupiers" often sits in a right-hand column that a
 * first-cell-only reader never sees. The first captured line on a row keeps the
 * historic row_num (ri+1) so a re-harvest still overwrites the prior value; any
 * extra same-row lines get a high, collision-free key (10000+ri*100+ci) so they
 * add rather than clobber.
 */
export function extractFinancials(rows: string[][]): FinancialLine[] {
  const out: FinancialLine[] = []
  for (let ri = 0; ri < Math.min(rows.length, 120); ri++) {
    const cells = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim())
    let firstDone = false
    for (let ci = 0; ci < cells.length; ci++) {
      const label = cells[ci]
      if (!isLabelCell(label) || !FIN_LABEL.test(label)) continue
      // Look right for this label's value, stopping at the next label so we never
      // reach across into a neighbouring block's number.
      for (let cj = ci + 1; cj < Math.min(cells.length, ci + 9); cj++) {
        const raw = cells[cj]
        if (!raw) continue
        if (isLabelCell(raw)) break // next column's label — this one has no value
        if (!isMoneyCell(raw)) continue
        const neg = raw.includes('(') || /-/.test(raw)
        const num = Number(raw.replace(/[^0-9.]/g, ''))
        out.push({
          row_num: firstDone ? 10000 + ri * 100 + ci : ri + 1,
          label,
          norm_label: label.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(),
          value_num: Number.isFinite(num) ? (neg ? -num : num) : null,
          value_raw: raw,
        })
        firstDone = true
        break
      }
    }
  }
  return out
}

// The Tournament tab carries the real buy-in numbers — an entries table broken
// down by payment method (Chips | Cash | EFTPOS | PayID | Total), plus the
// prize-pool key financials. This is NOT one of the FIN_TAB tabs, so it gets
// its own extractor.
const TOURNEY_TAB = /tournament/i

/**
 * Pull tournament buy-ins (by payment method) + prize-pool figures from the
 * Tournament tab. The "Total In" row is the money actually collected from
 * entries; "Gross" is the prize pool after commission. Emits one line per
 * method so the summary can total them or break them out. Synthetic row_num
 * (ri*100+ci) keeps every emitted cell unique for the upsert.
 */
export function extractTournament(rows: string[][]): FinancialLine[] {
  const out: FinancialLine[] = []
  const num = (s?: string): number | null => {
    const v = Number((s ?? '').replace(/[^0-9.]/g, ''))
    return Number.isFinite(v) && (s ?? '').trim() !== '' ? v : null
  }

  // 1) Entries table — locate the header row (has Chips + EFTPOS), map columns.
  let headerRi = -1
  const cols: Record<string, number> = {}
  for (let ri = 0; ri < Math.min(rows.length, 80); ri++) {
    const lc = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim().toLowerCase())
    if (lc.includes('chips') && lc.includes('eftpos')) {
      headerRi = ri
      lc.forEach((c, ci) => {
        if (['chips', 'cash', 'eftpos', 'payid', 'total'].includes(c)) cols[c] = ci
        else if (c === 'in') cols.label = ci
      })
      break
    }
  }
  if (headerRi >= 0 && cols.total != null) {
    const labelCol = cols.label ?? 0
    for (let ri = headerRi + 1; ri < Math.min(rows.length, headerRi + 24); ri++) {
      const cells = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim())
      const label = (cells[labelCol] ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      const want = label === 'total in' ? 'in' : label === 'gross' ? 'gross' : null
      if (!want) continue
      for (const [method, ci] of Object.entries(cols)) {
        if (method === 'label') continue
        const v = num(cells[ci])
        if (v == null) continue
        out.push({
          row_num: ri * 100 + ci,
          label: `Tournament ${want} ${method}`,
          norm_label: `tournament ${want} ${method}`,
          value_num: v,
          value_raw: cells[ci],
        })
      }
    }
  }

  // 2) Key financials — "Tournament Gross (Prize pool)", "Guarantee", "Overlay":
  // label cell then the value a couple of cells to the right.
  for (let ri = 0; ri < Math.min(rows.length, 60); ri++) {
    const cells = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim())
    for (let ci = 0; ci < cells.length; ci++) {
      const l = cells[ci].toLowerCase()
      const key = /tournament gross|prize pool/.test(l) ? 'tournament prize pool'
        : /guarantee/.test(l) ? 'tournament guarantee'
        : /overlay/.test(l) ? 'tournament overlay'
        : null
      if (!key) continue
      for (let cj = ci + 1; cj < Math.min(cells.length, ci + 4); cj++) {
        if (!/[$0-9]/.test(cells[cj])) continue
        const v = num(cells[cj])
        if (v == null) continue
        out.push({ row_num: 8000 + ri * 100 + ci, label: cells[ci], norm_label: key, value_num: v, value_raw: cells[cj] })
        break
      }
    }
  }
  return out
}

/**
 * Write queued JL confirmations back into the sheets: 'JL' into the Office
 * Confirm cell, and (for outgoing money) the last-4 receipt ref into the
 * receipt cell when it's still empty. Requires the read-write spreadsheets
 * scope — a read-only token 403s, which is logged once and left queued.
 */
let sheetsWriteScopeMissing = false
export async function processTransferConfirms(
  db: DB,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ written: number }> {
  if (sheetsWriteScopeMissing) return { written: 0 }
  const q = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => {
          limit: (n: number) => Promise<{ data: Record<string, unknown>[] | null }>
        }
      }
    }
  }
  const { data: queued } = await q.from('inbox_transfers').select('*').eq('confirm_state', 'queued').limit(20)
  if (!queued || queued.length === 0) return { written: 0 }

  const token = await accessToken(clientId, clientSecret, refreshToken)
  let written = 0
  for (const t of queued) {
    const tab = String(t.tab_title).replace(/'/g, "''")
    const put = async (col: string, value: string) => {
      const range = encodeURIComponent(`'${tab}'!${col}${t.row_num}`)
      const res = await fetch(
        `${SHEETS_URL}/${t.sheet_id}/values/${range}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ values: [[value]] }),
          signal: AbortSignal.timeout(20_000),
        },
      )
      if (res.status === 403) {
        sheetsWriteScopeMissing = true
        console.warn('[transfers] Sheets WRITE scope missing — re-run scripts/get-google-refresh-token.mjs (now read-write) and update GOOGLE_REFRESH_TOKEN')
        throw new Error('scope')
      }
      if (!res.ok) throw new Error(`Sheets write ${res.status}`)
    }
    try {
      await put(String(t.confirm_col), 'JL')
      // Write the ref where the sheet lacks one: outgoing last-4s, and the
      // EFTPOS auto-rule's "1111" over the bare 'e' marker.
      const rec = String(t.receipt ?? '').trim()
      if (t.confirm_ref && t.receipt_col && (rec === '' || /^e$/i.test(rec))) {
        await put(String(t.receipt_col), String(t.confirm_ref))
      }
      await (db as unknown as {
        from: (t: string) => { update: (v: unknown) => { eq: (c: string, v: unknown) => Promise<unknown> } }
      })
        .from('inbox_transfers')
        .update({ confirm_state: 'written', office_confirm: 'JL' })
        .eq('id', t.id)
      written++
    } catch (e) {
      if ((e as Error).message === 'scope') break
      console.error('[transfers] write-back error:', e instanceof Error ? e.message : e)
    }
  }
  return { written }
}

/**
 * Find tonight's (and last night's) "DD/MM Venue" Google Sheets, read the
 * player-bearing sections out of each, and upsert the names into
 * inbox_td_attendees for the post-game tool to load. Also mirrors the sheets'
 * bank-transfer lines into inbox_transfers for the reconciliation tab.
 */
export async function syncTdSheets(
  db: DB,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  lookbackDays = 1,
): Promise<TdSheetsResult> {
  const now = new Date()
  const token = await accessToken(clientId, clientSecret, refreshToken)
  const needles = dateNeedles(now, lookbackDays)
  // Drive query strings have a length cap, so a long lookback is swept in chunks
  // of needles, merging the matches by file id. createdTime anchors the year for
  // history sweeps (titles have none). pageToken paging matters once the needle
  // set covers the whole calendar — a chunk can match >100 files across years.
  const byId = new Map<string, { id: string; name: string; createdTime?: string }>()
  // Full-history sweep: don't guess names with date needles — LIST EVERY
  // spreadsheet the account can see and let parseTitle() decide. Needle search
  // missed whole venues (Bentley, Planet Royale) whose names don't carry a
  // recognisable DD/MM. The needle path below stays for the cheap live pull.
  if (lookbackDays >= 366) {
    let pageToken: string | undefined
    do {
      const list = await gfetch<{ files?: { id: string; name: string; createdTime?: string }[]; nextPageToken?: string }>(
        `${DRIVE_URL}?q=${encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false")}` +
          `&fields=${encodeURIComponent('nextPageToken,files(id,name,createdTime)')}&pageSize=1000` +
          DRIVE_SCOPE +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
        token,
      )
      for (const f of list.files ?? []) byId.set(f.id, f)
      pageToken = list.nextPageToken
    } while (pageToken)
    console.log(`[tdsheets] full listing: ${byId.size} spreadsheet(s) visible, ${[...byId.values()].filter((f) => parseTitle(f.name)).length} parse as TD sheets`)
  } else
  for (let i = 0; i < needles.length; i += 24) {
    const q =
      `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (` +
      needles.slice(i, i + 24).map((n) => `name contains '${n}'`).join(' or ') +
      `)`
    let pageToken: string | undefined
    do {
      const list = await gfetch<{ files?: { id: string; name: string; createdTime?: string }[]; nextPageToken?: string }>(
        `${DRIVE_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,createdTime)')}&pageSize=100` +
          DRIVE_SCOPE +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
        token,
      )
      for (const f of list.files ?? []) byId.set(f.id, f)
      pageToken = list.nextPageToken
    } while (pageToken)
  }
  const cap = lookbackDays > 90 ? 2000 : lookbackDays > 1 ? 100 : 12
  // A file that matched the date but whose title won't parse is discarded here,
  // and until now that happened in silence — a sheet renamed "SS 06/08 Woodvale"
  // (parseTitle anchors the date to the start or the end, nothing in between) is
  // indistinguishable from a game that never happened. Name them.
  const rejected = [...byId.values()].filter((f) => parseTitle(f.name) == null)
  if (rejected.length) {
    console.warn(
      `[tdsheets] ${rejected.length} spreadsheet(s) matched but the title did not parse as "DD/MM Venue" — ` +
        rejected.slice(0, 6).map((f) => `"${f.name}"`).join(', ') +
        (rejected.length > 6 ? ` (+${rejected.length - 6} more)` : ''),
    )
  }
  const sheets = [...byId.values()].filter((f) => parseTitle(f.name) != null).slice(0, cap)

  // Transfer reconciliation stays a rolling ~5-week window: mirroring years of
  // transfer lines would put the EFTPOS auto-JL rule to work editing historical
  // sheets, which nobody wants. Older sheets contribute attendance only.
  const transferFloor = new Date(now.getTime() - 35 * 86_400_000).toISOString().slice(0, 10)

  let attendees = 0
  let sheetN = 0
  let skipped = 0
  for (const f of sheets) {
    // A sheet that will not read (permissions, a timeout that outlived its
    // retries, a malformed tab) must cost us that sheet, not the remaining
    // hundreds. Skip it loudly and carry on.
    try {
    const t = parseTitle(f.name)
    if (!t) continue
    const venue = t.venue
    const created = f.createdTime ? new Date(f.createdTime) : null
    // An explicit year in the title beats inference from createdTime.
    const gameDate = t.year
      ? `${t.year}-${String(t.mon).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`
      : isoDate(t.day, t.mon, created && !isNaN(created.getTime()) ? created : now)
    // Gentle pacing on long sweeps so hundreds of sheets don't trip quota.
    if (sheets.length > 30 && sheetN++ > 0) await new Promise((r) => setTimeout(r, 400))
    if (sheets.length > 30) console.log(`[tdsheets] ${sheetN}/${sheets.length} ${f.name} -> ${gameDate}`)

    const meta = await gfetch<{ sheets?: { properties?: { title?: string } }[] }>(
      `${SHEETS_URL}/${f.id}?fields=${encodeURIComponent('sheets(properties(title))')}`,
      token,
    )
    const titles = (meta.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[]
    const tabs: { title: string; rows: string[][] }[] = []
    for (const t of titles) {
      try {
        const range = encodeURIComponent(`'${t.replace(/'/g, "''")}'`)
        const v = await gfetch<{ values?: string[][] }>(`${SHEETS_URL}/${f.id}/values/${range}`, token)
        if (v.values?.length) tabs.push({ title: t, rows: v.values })
      } catch {
        /* skip an unreadable tab */
      }
    }

    // Mirror the bank-transfer lines (with cell coordinates) for reconciliation.
    // The upsert only carries sheet-derived columns, so a queued/written
    // confirmation state on an existing row is never clobbered by a re-sync.
    const tdb = db as unknown as {
      from: (t: string) => {
        upsert: (v: unknown, o: unknown) => Promise<{ error: { message?: string } | null }>
        update: (v: unknown) => {
          eq: (c: string, v2: unknown) => {
            eq: (c: string, v2: unknown) => {
              eq: (c: string, v2: unknown) => {
                or: (f: string) => Promise<{ error: { message?: string } | null }>
              }
            }
          }
        }
      }
    }
    // Financial lines harvest — runs for EVERY sheet (history included, so the
    // --all backfill fills the Home trend chart), read-only. The Tournament tab
    // gets the dedicated buy-in extractor; financial/invoice tabs the generic one.
    for (const tab of tabs) {
      const isTourney = TOURNEY_TAB.test(tab.title)
      if (!isTourney && !FIN_TAB.test(tab.title)) continue
      const fins = isTourney ? extractTournament(tab.rows) : extractFinancials(tab.rows)
      if (!fins.length) continue
      const { error: fErr } = await tdb.from('inbox_game_financials').upsert(
        fins.map((l) => ({ sheet_id: f.id, sheet_title: f.name, tab_title: tab.title, game_date: gameDate, venue, ...l })),
        { onConflict: 'sheet_id,tab_title,row_num' },
      )
      if (fErr) console.error('[financials] mirror error:', fErr.message)
    }

    for (const tab of tabs) {
      if (gameDate < transferFloor) break // history sweep: attendance only
      const lines = extractTransfers(tab.rows)
      console.log(`[transfers] ${f.name} · "${tab.title}": ${lines.length} transfer line(s)`)
      if (!lines.length) continue
      const { error: tErr } = await tdb.from('inbox_transfers').upsert(
        lines.map((l) => ({
          sheet_id: f.id,
          sheet_title: f.name,
          tab_title: tab.title,
          game_date: gameDate,
          venue,
          ...l,
        })),
        { onConflict: 'sheet_id,tab_title,kind,row_num' },
      )
      if (tErr) console.error('[transfers] mirror error:', tErr.message)
    }
    // Standing rule, per Justin: EFTPOS transfer-in lines auto-confirm — receipt
    // ref "1111" + JL initials — no manual tick needed. (Recent window only —
    // the mirror above never ingests older lines, so this can't touch history.)
    if (gameDate >= transferFloor) {
      try {
        await tdb
          .from('inbox_transfers')
          .update({ confirm_state: 'queued', confirm_ref: '1111' })
          .eq('confirm_state', 'unconfirmed')
          .eq('kind', 'transfer_in')
          .eq('office_confirm', '')
          .or('pay_method.ilike.%eftpos%,name.ilike.%eftpos%,receipt.ilike.e')
      } catch (e) {
        console.error('[transfers] eftpos auto-rule error:', e instanceof Error ? e.message : e)
      }
    }

    const people = extractAttendees(tabs.map((t) => t.rows))
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
    } catch (e) {
      console.error(`[tdsheets] skipped "${f.name}": ${e instanceof Error ? e.message : e}`)
      skipped++
    }
  }

  if (skipped) console.warn(`[tdsheets] ${skipped} sheet(s) skipped after retries — re-run to pick them up`)
  return { sheets: sheets.length, attendees }
}
