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
  // The full-history backfill reads hundreds of sheets, so quota 429s (and the
  // occasional 5xx) get a couple of patient retries instead of failing the run.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
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

const TITLE_RE = /^\s*(\d{1,2})[/.](\d{1,2})\.?\s+(.+?)\s*$/ // "25/06 Woodvale", "02.07. Woody"

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
const FIN_LABEL = /profit|rake|drop|buy.?in|total|expense|fee|gst|wage|payout|float|takings|revenue|income|cost|balance|banked|turnover/i
const MONEY_RE = /^\(?-?\$?\s?-?\d[\d,]*(\.\d+)?\)?$/

export interface FinancialLine {
  row_num: number
  label: string
  norm_label: string
  value_num: number | null
  value_raw: string
}

/**
 * Pull label:value money lines out of a financial tab. Deliberately generic —
 * the first texty cell in a row is the label, the first money-looking cell
 * after it is the value — so layout changes don't need a code change; the
 * metric mapping lives in the inbox_financial_summary view.
 */
export function extractFinancials(rows: string[][]): FinancialLine[] {
  const out: FinancialLine[] = []
  for (let ri = 0; ri < Math.min(rows.length, 120); ri++) {
    const cells = (rows[ri] ?? []).map((c) => (c ?? '').toString().trim())
    const li = cells.findIndex((c) => /[a-z]/i.test(c) && c.length >= 3 && c.length <= 60)
    if (li < 0) continue
    const label = cells[li]
    if (!FIN_LABEL.test(label)) continue
    for (let ci = li + 1; ci < cells.length; ci++) {
      const raw = cells[ci]
      if (!raw || !MONEY_RE.test(raw)) continue
      // Bare small integers (headcounts, table numbers) aren't money.
      if (!/[$,.]/.test(raw) && raw.replace(/\D/g, '').length < 3) break
      const neg = raw.includes('(') || /-/.test(raw)
      const num = Number(raw.replace(/[^0-9.]/g, ''))
      out.push({
        row_num: ri + 1,
        label,
        norm_label: label.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(),
        value_num: Number.isFinite(num) ? (neg ? -num : num) : null,
        value_raw: raw,
      })
      break
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
  for (let i = 0; i < needles.length; i += 24) {
    const q =
      `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (` +
      needles.slice(i, i + 24).map((n) => `name contains '${n}'`).join(' or ') +
      `)`
    let pageToken: string | undefined
    do {
      const list = await gfetch<{ files?: { id: string; name: string; createdTime?: string }[]; nextPageToken?: string }>(
        `${DRIVE_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,createdTime)')}&pageSize=100` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
        token,
      )
      for (const f of list.files ?? []) byId.set(f.id, f)
      pageToken = list.nextPageToken
    } while (pageToken)
  }
  const cap = lookbackDays > 90 ? 2000 : lookbackDays > 1 ? 100 : 12
  const sheets = [...byId.values()].filter((f) => TITLE_RE.test(f.name)).slice(0, cap)

  // Transfer reconciliation stays a rolling ~5-week window: mirroring years of
  // transfer lines would put the EFTPOS auto-JL rule to work editing historical
  // sheets, which nobody wants. Older sheets contribute attendance only.
  const transferFloor = new Date(now.getTime() - 35 * 86_400_000).toISOString().slice(0, 10)

  let attendees = 0
  let sheetN = 0
  for (const f of sheets) {
    const m = f.name.match(TITLE_RE)
    if (!m) continue
    const venue = m[3].trim()
    const created = f.createdTime ? new Date(f.createdTime) : null
    const gameDate = isoDate(Number(m[1]), Number(m[2]), created && !isNaN(created.getTime()) ? created : now)
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
    // --all backfill fills the Home trend chart), read-only.
    for (const tab of tabs) {
      if (!FIN_TAB.test(tab.title)) continue
      const fins = extractFinancials(tab.rows)
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
  }

  return { sheets: sheets.length, attendees }
}
