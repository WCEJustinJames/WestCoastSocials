import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { BeeperClient } from '../adapters/beeper/client'
import { env } from '../lib/env'

type DB = SupabaseClient<Database>

/** Core 9 digits of an AU mobile, for blocklist comparison. */
const phoneCore = (raw: string): string => raw.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '')

export interface ReceiptResult {
  processed: number
  skipped: number
  /** False when the banking group could not be found at all — see below. */
  chatFound: boolean
  /** Unprocessed image messages this run set out to handle. */
  candidates: number
  /** Of those, how many failed on a fetch/vision/insert error.
   *
   *  `skipped` is close to this already — a not-a-receipt or a duplicate is
   *  inserted and counted in `processed`, not skipped — but it also absorbs
   *  images with no usable srcURL, which are not failures, and it carries that
   *  meaning only by implication. A caller deciding whether to publish a health
   *  signal should not have to infer it, so it is counted openly. */
  errors: number
}

const PROMPT = `You are reading a photo that MIGHT be a West Coast Poker (WCP) "Banking / Cash Chips" payout form: a printed template with handwritten entries, fields stacked top-to-bottom (Date, Venue, Club, then "Player Details" with First Name / Surname / Mobile Number / Recipient Signature, then Payment Details with Total Winnings / TOTAL BANK TRANSFER AMOUNT).

Only return {"not_receipt": true} if there is NO payout form in the image at all (e.g. a photo of just chips/cash, a screenshot, or a chat). If a WCP form with a "Player Details" section is visible — even faint, angled, shadowed, or partly filled — DO extract it: read what you can and use null for the rest. Err on the side of treating it as a receipt.

Otherwise return ONLY this JSON (no prose, no code fences):
{
  "date": string|null,
  "venue": string|null,
  "club": string|null,
  "first_name": string|null,      // the PLAYER's first name on the "First Name" line under Player Details
  "surname": string|null,         // the PLAYER's surname on the "Surname" line
  "mobile": string|null,          // ONLY the digits written on the "Mobile Number" line, keep leading 0
  "game_type": "cash"|"tournament"|null,
  "total_winnings": number|null,
  "amount": number|null,
  "paid": boolean|null
}

STRICT RULES:
- The player is the name on First Name + Surname. Do NOT use the Recipient Signature, any organiser/staff name, or a name printed in the header/footer.
- "mobile" comes ONLY from the Mobile Number line. NEVER use the date, an amount, an ABN, or any other number on the form as the mobile.
- If a field is blank, crossed out, or you cannot read it clearly, return null. Do NOT guess — a null is better than a wrong value.`

interface Extracted {
  not_receipt?: boolean
  date?: string | null
  venue?: string | null
  club?: string | null
  first_name?: string | null
  surname?: string | null
  mobile?: string | null
  game_type?: string | null
  total_winnings?: number | null
  amount?: number | null
  paid?: boolean | null
}

function parseJson(text: string): Extracted | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Extracted
  } catch {
    return null
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[^\d.]/g, '')) || null : null

/**
 * Read receipt photos from the "Poker Banking and Cash Chips" group chat off the
 * local Beeper media cache, run each through Claude vision, and store the
 * structured fields in inbox_receipts (review_status='pending'). Dedupes on the
 * Beeper message id, so it's safe to re-run.
 */
export async function extractReceipts(
  db: DB,
  beeper: BeeperClient,
  anthropic: Anthropic,
  model: string,
  limit: number,
  chatNeedle = 'banking',
): Promise<ReceiptResult> {
  const groups = await beeper.searchMessages({ chatType: 'group', limit: 20 })
  const chat = Object.values(groups.chats ?? {}).find((c) =>
    (c.title ?? '').toLowerCase().includes(chatNeedle),
  )
  if (!chat) {
    // Reported as chatFound:false rather than as an empty-but-successful run.
    // A caller that stamps a health signal off {processed:0, skipped:0} would
    // otherwise read this as "swept, nothing to do" and go green forever while
    // nothing reaches the CRM — the exact silent failure the nightly sweep and
    // its watchdog check exist to end. This is a live failure mode, not a
    // theoretical one: the lookup only scans the 20 most recent group chats,
    // so a quiet week or a rename drops the banking group out of range.
    console.error(`[receipts] no group chat matching "${chatNeedle}" in recent results`)
    return { processed: 0, skipped: 0, chatFound: false, candidates: 0, errors: 0 }
  }

  // Page backwards through the whole chat history, collecting image messages we
  // haven't processed yet, until we have `limit` of them (or run out). This walks
  // the full backlog across repeated runs rather than only seeing recent photos.
  type Msg = NonNullable<Awaited<ReturnType<typeof beeper.searchMessages>>['items']>[number]
  const todo: Msg[] = []
  let cursor: string | undefined
  for (let page = 0; page < 600 && todo.length < limit; page++) {
    const res = await beeper.searchMessages({
      chatIDs: [chat.id],
      limit: 20,
      cursor,
      direction: 'before',
    })
    for (const m of res.items ?? []) {
      if (todo.length >= limit) break
      const isImg = (m.attachments as { type?: string }[] | undefined)?.some((a) => a.type === 'img')
      if (!isImg) continue
      const { data: exists } = await db
        .from('inbox_receipts')
        .select('id')
        .eq('external_message_id', m.id)
        .limit(1)
      if (exists && exists.length) continue
      todo.push(m)
    }
    if (!res.hasMore || !res.oldestCursor) break
    cursor = res.oldestCursor
  }

  // Phone numbers already in the review queue / CRM-bound, so we don't surface
  // the same player twice (the same slip is often reposted in the chat).
  const { data: priorMobiles } = await db
    .from('inbox_receipts')
    .select('mobile')
    .in('review_status', ['pending', 'confirmed'])
  const seen = new Set(
    (priorMobiles ?? []).map((r) => (r.mobile ? phoneCore(r.mobile) : '')).filter(Boolean),
  )

  let processed = 0
  let skipped = 0
  let errors = 0

  for (const m of todo) {
    const att = (m.attachments as { type?: string; srcURL?: string; mimeType?: string }[]).find(
      (a) => a.type === 'img' && a.srcURL,
    )
    const src = att?.srcURL
    if (!src) {
      skipped++
      continue
    }

    let b64: string
    try {
      // Fetch through the bridge so it works for uncached (mxc://) media too.
      b64 = (await beeper.serveAsset(src)).toString('base64')
    } catch {
      console.warn(`[receipts] couldn't fetch image for message ${m.id}`)
      skipped++
      errors++
      continue
    }

    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (att?.mimeType as 'image/jpeg') ?? 'image/jpeg',
                  data: b64,
                },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      })
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const x = parseJson(text)

      // Guardrail: the recipient/operator signs every slip — never let their
      // name or number be extracted as the player. Null them out if matched.
      let firstName = x?.first_name ?? null
      let surname = x?.surname ?? null
      let mobile = x?.mobile ? String(x.mobile) : null
      let nameStr = [firstName, surname].filter(Boolean).join(' ').trim()
      if (nameStr && env.receiptBlockNames.includes(nameStr.toLowerCase())) {
        firstName = null
        surname = null
        nameStr = ''
      }
      if (mobile && env.receiptBlockPhones.includes(phoneCore(mobile))) {
        mobile = null
      }

      const playerName = nameStr || null
      const core = mobile ? phoneCore(mobile) : ''
      // Decide where this lands in the review queue:
      //  - not_receipt: not a form, or no usable mobile (a name with no number
      //    can't be messaged, so it's hidden from review)
      //  - duplicate:   we've already got this player's number from another slip
      //  - pending:     a real, messageable, not-yet-seen player
      let reviewStatus: 'pending' | 'not_receipt' | 'duplicate'
      if (x?.not_receipt || !mobile) {
        reviewStatus = 'not_receipt'
      } else if (seen.has(core)) {
        reviewStatus = 'duplicate'
      } else {
        reviewStatus = 'pending'
        seen.add(core)
      }

      const { error } = await db.from('inbox_receipts').insert({
        review_status: reviewStatus,
        external_message_id: m.id,
        chat_id: chat.id,
        captured_at: m.timestamp,
        image_file: src,
        receipt_date: x?.date ?? null,
        venue: x?.venue ?? null,
        club: x?.club ?? null,
        first_name: firstName,
        surname: surname,
        player_name: playerName,
        mobile: mobile,
        game_type: x?.game_type ?? null,
        total_winnings: num(x?.total_winnings),
        amount: num(x?.amount),
        paid: typeof x?.paid === 'boolean' ? x.paid : null,
        raw_extract: (x ?? { text }) as Database['public']['Tables']['inbox_receipts']['Insert']['raw_extract'],
      })
      if (error) throw error
      processed++
      if (reviewStatus === 'pending') {
        console.log(
          `[receipts] ${playerName ?? '(no name)'} — ${mobile} · ${x?.venue ?? '?'} · win ${x?.total_winnings ?? '?'}`,
        )
      } else if (reviewStatus === 'duplicate') {
        console.log(`[receipts] (duplicate of ${playerName ?? mobile} — skipped)`)
      } else {
        console.log('[receipts] (not a receipt / no mobile — skipped)')
      }
    } catch (e) {
      console.error(`[receipts] error on message ${m.id}:`, e instanceof Error ? e.message : e)
      skipped++
      errors++
    }
  }

  return { processed, skipped, chatFound: true, candidates: todo.length, errors }
}
