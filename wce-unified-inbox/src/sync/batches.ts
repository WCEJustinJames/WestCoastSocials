import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'
import { env } from '../lib/env'
import { guardSend } from './guards'

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
  const { data: allBatches, error } = await db
    .from('inbox_batches')
    .select('id, attachment_data, attachment_name, attachment_mime, scheduled_for, is_outreach')
    .in('status', ['approved', 'sending'])
    .limit(20)
  if (error) throw error
  // Daily outreach window: proactive invite blasts (is_outreach) only send
  // between OUTREACH_START and OUTREACH_CUTOFF (local time). Reply/confirmation
  // batches (is_outreach=false) always go, so seats can be confirmed and players
  // thanked outside the window.
  const local = new Date()
  const localMins = local.getHours() * 60 + local.getMinutes()
  const outreachWindowOpen =
    localMins >= env.outreachStartMins && localMins < env.outreachCutoffMins
  // Hold scheduled batches until their time; send unscheduled ones immediately.
  // (Filtered here, not in the query — a millisecond dot in an ISO timestamp
  // breaks PostgREST's dot-delimited .or() filter.)
  const now = Date.now()
  const batches = (allBatches ?? [])
    .filter((b) => !b.scheduled_for || new Date(b.scheduled_for).getTime() <= now)
    .filter((b) => b.is_outreach === false || outreachWindowOpen)
    .slice(0, 5)
  if (batches.length === 0) return { sent: 0, failed: 0 }

  // Reclaim items orphaned by a crashed worker. A healthy pass caps at
  // MAX_PER_PASS sends (~30s), so anything stuck in `sending` for minutes was
  // abandoned mid-send. The cutoff is well past a normal pass, so two healthy
  // windows running at once never reset each other's in-flight claims.
  const staleCutoff = new Date(now - 5 * 60_000).toISOString()
  await db
    .from('inbox_batch_items')
    .update({ status: 'approved', claimed_at: null })
    .eq('status', 'sending')
    .lt('claimed_at', staleCutoff)
  await db
    .from('inbox_batch_items')
    .update({ status: 'approved', claimed_at: null })
    .eq('status', 'sending')
    .is('claimed_at', null)

  let sent = 0
  let failed = 0
  // Recipients reached this pass — collapse duplicate items so one person never
  // gets the same blast twice (the Andy double-send), keyed by chat-id or phone.
  const sentKeys = new Set<string>()

  for (const batch of batches) {
    if (sent + failed >= MAX_PER_PASS) break
    await db.from('inbox_batches').update({ status: 'sending' }).eq('id', batch.id)

    // One image for the whole batch; re-uploaded per send (upload IDs are temporary).
    const attachment = batch.attachment_data
      ? {
          dataBase64: batch.attachment_data,
          fileName: batch.attachment_name ?? undefined,
          mimeType: batch.attachment_mime ?? undefined,
        }
      : undefined

    const remaining = MAX_PER_PASS - (sent + failed)
    const { data: items } = await db
      .from('inbox_batch_items')
      .select('id, rendered_text, data')
      .eq('batch_id', batch.id)
      .eq('status', 'approved')
      .limit(remaining)

    for (const item of items ?? []) {
      // Atomically claim the item: flip approved -> sending only if it's still
      // approved. This is a single conditional UPDATE, so if a second sync
      // window is running, exactly one wins the claim and the other skips —
      // no double-send. (The fix for the duplicate run-wce.bat window.)
      const { data: claimed } = await db
        .from('inbox_batch_items')
        .update({ status: 'sending', claimed_at: new Date().toISOString() })
        .eq('id', item.id)
        .eq('status', 'approved')
        .select('id')
      if (!claimed || claimed.length === 0) continue // another worker took it

      const data = item.data as {
        conversation_id?: string
        beeper_chat_id?: string
        phone?: string
        account_id?: string
        channel?: 'sms' | 'thread'
        outreach_id?: string
      } | null

      // Send-time guardrails (defense in depth): block half-rendered text always,
      // do_not_message / hidden always, and staff + the per-contact frequency cap
      // for proactive outreach. The batch was approved earlier; flags and
      // last_contacted may have changed since.
      const verdict = await guardSend(db, {
        renderedText: item.rendered_text,
        isOutreach: batch.is_outreach === true,
        outreachId: data?.outreach_id,
      })
      if (!verdict.ok) {
        await db
          .from('inbox_batch_items')
          .update({ status: 'skipped', guard_flag: true, guard_reason: verdict.reason })
          .eq('id', item.id)
        console.log(`[batch] skipped item ${item.id}: ${verdict.reason}`)
        continue
      }

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

      // In-pass dedupe: never reach the same recipient twice in one pass.
      const dedupeKey = chatId ?? phone
      if (dedupeKey && sentKeys.has(dedupeKey)) {
        await db
          .from('inbox_batch_items')
          .update({ status: 'skipped', guard_flag: true, guard_reason: 'dup_in_pass' })
          .eq('id', item.id)
        console.log(`[batch] skipped duplicate recipient (item ${item.id})`)
        continue
      }

      try {
        const r = chatId
          ? await adapter.sendMessage!(chatId, item.rendered_text, { attachment })
          : await adapter.startChatAndSend!(
              data?.account_id ?? 'gmessages',
              phone!,
              item.rendered_text,
              { attachment },
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
          if (dedupeKey) sentKeys.add(dedupeKey)
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

    // Flip the batch to `sent` only once nothing is left to drain — no
    // `approved` items waiting and none still mid-send (`sending`).
    const { data: stillPending } = await db
      .from('inbox_batch_items')
      .select('id')
      .eq('batch_id', batch.id)
      .in('status', ['approved', 'sending'])
      .limit(1)
    if (!stillPending || stillPending.length === 0) {
      await db.from('inbox_batches').update({ status: 'sent' }).eq('id', batch.id)
    }
  }

  return { sent, failed }
}
