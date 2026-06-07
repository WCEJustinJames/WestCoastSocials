import { readFile } from 'node:fs/promises'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { BeeperClient } from '../adapters/beeper/client'

type DB = SupabaseClient<Database>

export interface ReceiptResult {
  processed: number
  skipped: number
}

const PROMPT = `You are reading a photo that MIGHT be a West Coast Poker (WCP) "Banking / Cash Chips" payout form: a printed template with handwritten entries, fields stacked top-to-bottom (Date, Venue, Club, then "Player Details" with First Name / Surname / Mobile Number / Recipient Signature, then Payment Details with Total Winnings / TOTAL BANK TRANSFER AMOUNT).

If the image is NOT one of these forms (e.g. a photo of chips/cash, a screenshot, a chat message, anything else), return exactly: {"not_receipt": true}

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
    console.error(`[receipts] no group chat matching "${chatNeedle}" in recent results`)
    return { processed: 0, skipped: 0 }
  }

  const msgs = await beeper.searchMessages({ chatIDs: [chat.id], limit: 20 })
  const images = (msgs.items ?? []).filter((m) =>
    (m.attachments as { type?: string }[] | undefined)?.some((a) => a.type === 'img'),
  )

  let processed = 0
  let skipped = 0

  for (const m of images.slice(0, limit)) {
    const { data: exists } = await db
      .from('inbox_receipts')
      .select('id')
      .eq('external_message_id', m.id)
      .limit(1)
    if (exists && exists.length) {
      skipped++
      continue
    }

    const att = (m.attachments as { type?: string; srcURL?: string; mimeType?: string }[]).find(
      (a) => a.type === 'img' && a.srcURL,
    )
    const src = att?.srcURL
    if (!src) {
      skipped++
      continue
    }
    const path = decodeURIComponent(src.replace(/^file:\/\/\/?/, '').replace(/^([A-Za-z]):/, '$1:'))

    let b64: string
    try {
      b64 = (await readFile(path)).toString('base64')
    } catch {
      console.warn(`[receipts] cannot read image on disk (not cached?): ${path}`)
      skipped++
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
      const playerName = [x?.first_name, x?.surname].filter(Boolean).join(' ') || null
      // Many photos in this chat aren't receipts (chip pics, chatter). If we got
      // neither a name nor a mobile, file it as not_receipt so it's kept for
      // dedup but excluded from the review list.
      const usable = !!(playerName || x?.mobile)

      const { error } = await db.from('inbox_receipts').insert({
        review_status: usable ? 'pending' : 'not_receipt',
        external_message_id: m.id,
        chat_id: chat.id,
        captured_at: m.timestamp,
        image_file: path,
        receipt_date: x?.date ?? null,
        venue: x?.venue ?? null,
        club: x?.club ?? null,
        first_name: x?.first_name ?? null,
        surname: x?.surname ?? null,
        player_name: playerName,
        mobile: x?.mobile ? String(x.mobile) : null,
        game_type: x?.game_type ?? null,
        total_winnings: num(x?.total_winnings),
        amount: num(x?.amount),
        paid: typeof x?.paid === 'boolean' ? x.paid : null,
        raw_extract: (x ?? { text }) as Database['public']['Tables']['inbox_receipts']['Insert']['raw_extract'],
      })
      if (error) throw error
      processed++
      if (usable) {
        console.log(
          `[receipts] ${playerName ?? '(no name)'} — ${x?.mobile ?? 'no mobile'} · ${x?.venue ?? '?'} · win ${x?.total_winnings ?? '?'}`,
        )
      } else {
        console.log('[receipts] (not a receipt — skipped)')
      }
    } catch (e) {
      console.error(`[receipts] error on message ${m.id}:`, e instanceof Error ? e.message : e)
      skipped++
    }
  }

  return { processed, skipped }
}
