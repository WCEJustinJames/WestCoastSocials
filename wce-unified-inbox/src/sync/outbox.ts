import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'
import { guardSend } from './guards'

type DB = SupabaseClient<Database>

export interface OutboxResult {
  sent: number
  failed: number
}

/**
 * Phase A send rail. Finds drafts the human marked `approved` in the UI, sends
 * each via the adapter, and marks it `sent`. Nothing here sends unless a draft
 * is explicitly approved — that's the approve-to-send gate.
 *
 * Safety: each approved draft is attempted exactly once. On success it moves to
 * `sent`; on failure it moves back to `pending` (so it never silently
 * auto-resends and risks double-messaging a player).
 */
export async function processOutbox(db: DB, adapter: ChannelAdapter): Promise<OutboxResult> {
  const { data: drafts, error } = await db
    .from('inbox_drafts')
    .select('id, content, conversation_id, attachment_data, attachment_name, attachment_mime')
    .eq('status', 'approved')
    .limit(50)
  if (error) throw error
  if (!drafts || drafts.length === 0) return { sent: 0, failed: 0 }

  let sent = 0
  let failed = 0

  for (const d of drafts) {
    const { data: conv } = await db
      .from('inbox_conversations')
      .select('external_chat_id, adapter')
      .eq('id', d.conversation_id)
      .single()

    if (!conv || conv.adapter !== adapter.id || !adapter.sendMessage) {
      await db.from('inbox_drafts').update({ status: 'pending' }).eq('id', d.id)
      failed++
      continue
    }

    // Send-time guard on the reply rail (defense in depth): a reply resolves its
    // recipient via the conversation and is blocked if they are banned / opted
    // out (do_not_message) or the body is empty / half-rendered. Blocked replies
    // are rejected (terminal), never retried. isOutreach=false, so the staff /
    // no-reply / on-ice outreach checks don't gate a genuine reply.
    const verdict = await guardSend(db, {
      renderedText: d.content,
      isOutreach: false,
      conversationId: d.conversation_id,
    })
    if (!verdict.ok) {
      await db.from('inbox_drafts').update({ status: 'rejected' }).eq('id', d.id)
      console.log(`[outbox] blocked reply draft ${d.id}: ${verdict.reason}`)
      continue
    }

    const attachment = d.attachment_data
      ? {
          dataBase64: d.attachment_data,
          fileName: d.attachment_name ?? undefined,
          mimeType: d.attachment_mime ?? undefined,
        }
      : undefined

    try {
      const r = await adapter.sendMessage(conv.external_chat_id, d.content, { attachment })
      if (r.ok) {
        await db.from('inbox_drafts').update({ status: 'sent' }).eq('id', d.id)
        sent++
      } else {
        await db.from('inbox_drafts').update({ status: 'pending' }).eq('id', d.id)
        failed++
        console.error(`[outbox] send rejected for draft ${d.id}: ${r.error ?? 'unknown'}`)
      }
    } catch (e) {
      await db.from('inbox_drafts').update({ status: 'pending' }).eq('id', d.id)
      failed++
      console.error(`[outbox] error sending draft ${d.id}:`, e instanceof Error ? e.message : e)
    }
  }

  return { sent, failed }
}
