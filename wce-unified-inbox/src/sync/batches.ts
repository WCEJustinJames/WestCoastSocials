import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'

type DB = SupabaseClient<Database>

export interface BatchResult {
  sent: number
  failed: number
}

// Beeper warns that sending volume can get accounts suspended, so batches are
// paced: a delay between every send and a hard cap per sync pass. A large batch
// drains across multiple passes rather than firing all at once.
const SEND_DELAY_MS = 1500
const MAX_PER_PASS = 20

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Normalise an Australian mobile to +E.164 (Beeper/gmessages wants +61…). */
export function normalizeAuMobile(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, '')
  if (/^\+61\d{9}$/.test(d)) return d
  if (/^61\d{9}$/.test(d)) return '+' + d
  if (/^0\d{9}$/.test(d)) return '+61' + d.slice(1)
  if (/^4\d{8}$/.test(d)) return '+61' + d
  return null
}

/**
 * Batch send rail (Roadmap item 2). Mirrors the Phase A outbox, but for
 * approved batch items. A batch the human approved in the UI has status
 * `approved`; its `approved` items each carry a pre-rendered message. We send
 * each one, mark it `sent`/`failed`, and flip the batch to `sent` once no
 * approved items remain. Nothing sends unless the human approved the batch —
 * same gate as everything else.
 */
export async function processBatches(db: DB, adapter: ChannelAdapter): Promise<BatchResult> {
  const { data: batches, error } = await db
    .from('inbox_batches')
    .select('id')
    .in('status', ['approved', 'sending'])
    // Hold scheduled batches until their time; send immediately when unscheduled.
    .or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`)
    .limit(5)
  if (error) throw error
  if (!batches || batches.length === 0) return { sent: 0, failed: 0 }

  let sent = 0
  let failed = 0

  for (const batch of batches) {
    if (sent + failed >= MAX_PER_PASS) break
    await db.from('inbox_batches').update({ status: 'sending' }).eq('id', batch.id)

    const remaining = MAX_PER_PASS - (sent + failed)
    const { data: items } = await db
      .from('inbox_batch_items')
      .select('id, rendered_text, data')
      .eq('batch_id', batch.id)
      .eq('status', 'approved')
      .limit(remaining)

    for (const item of items ?? []) {
      const data = item.data as {
        conversation_id?: string
        beeper_chat_id?: string
        phone?: string
        account_id?: string
        channel?: 'sms' | 'thread'
        outreach_id?: string
      } | null

      // Channel choice: 'sms' forces the phone path; 'thread' (or unset/auto)
      // prefers an existing chat, falling back to the phone.
      let chatId: string | null = null
      if (data?.channel !== 'sms') {
        if (data?.beeper_chat_id) {
          chatId = data.beeper_chat_id
        } else if (data?.conversation_id) {
          const { data: conv } = await db
            .from('inbox_conversations')
            .select('external_chat_id, adapter')
            .eq('id', data.conversation_id)
            .single()
          if (conv && conv.adapter === adapter.id) chatId = conv.external_chat_id
        }
      }

      const phone = !chatId && data?.phone ? normalizeAuMobile(data.phone) : null
      const canSend = chatId
        ? !!adapter.sendMessage
        : phone
          ? !!adapter.startChatAndSend
          : false
      if (!canSend) {
        await db.from('inbox_batch_items').update({ status: 'failed' }).eq('id', item.id)
        failed++
        continue
      }

      try {
        const r = chatId
          ? await adapter.sendMessage!(chatId, item.rendered_text)
          : await adapter.startChatAndSend!(
              data?.account_id ?? 'gmessages',
              phone!,
              item.rendered_text,
            )
        if (r.ok) {
          await db.from('inbox_batch_items').update({ status: 'sent' }).eq('id', item.id)
          // Stamp last_contacted so the per-player frequency cap is enforced.
          if (data?.outreach_id) {
            await db
              .from('inbox_outreach')
              .update({ last_contacted: new Date().toISOString().slice(0, 10) })
              .eq('id', data.outreach_id)
          }
          sent++
        } else {
          await db.from('inbox_batch_items').update({ status: 'failed' }).eq('id', item.id)
          failed++
          console.error(`[batch] send rejected for item ${item.id}: ${r.error ?? 'unknown'}`)
        }
      } catch (e) {
        await db.from('inbox_batch_items').update({ status: 'failed' }).eq('id', item.id)
        failed++
        console.error(`[batch] error sending item ${item.id}:`, e instanceof Error ? e.message : e)
      }

      await sleep(SEND_DELAY_MS)
    }

    // Flip the batch to `sent` only once no approved items are left to drain.
    const { data: stillApproved } = await db
      .from('inbox_batch_items')
      .select('id')
      .eq('batch_id', batch.id)
      .eq('status', 'approved')
      .limit(1)
    if (!stillApproved || stillApproved.length === 0) {
      await db.from('inbox_batches').update({ status: 'sent' }).eq('id', batch.id)
    }
  }

  return { sent, failed }
}
