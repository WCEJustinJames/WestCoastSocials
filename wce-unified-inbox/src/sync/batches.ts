import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { env } from '../lib/env'
import { guardSend } from './guards'
import { textHash, alreadySent, recordSent } from './ledger'
import { runPass, type BatchRow, type EngineConfig, type EngineState, type Hooks, type PassResult } from './smsEngine'

type DB = SupabaseClient<Database>

// A thread with activity this recent is a LIVE conversation — a blast must not
// land in the middle of it (the invite-mid-chat incident).
const ACTIVE_CONVO_MS = 60 * 60_000

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
 * Batch send rail. The send itself is smsEngine.runPass (by-number SMS,
 * new-chat cap, read-back, parks, fenced write-backs, auto-pause); this file
 * supplies the engine's own guards and the outreach window as hooks.
 *
 * Nothing sends unless the human approved the batch, and nothing new is
 * claimed while inbox_settings.sends_paused is on (read by runPass itself,
 * failing CLOSED). Parks are still resolved while paused or in quiet hours.
 */
let busy = false

export async function processBatches(
  db: DB,
  cfg: EngineConfig,
  state: EngineState,
  opts: { allowClaims: boolean },
): Promise<PassResult | null> {
  // A pass that outlives PASS_TIMEOUT_MS keeps running while the next one
  // starts; two drains in one process would race the cap count (ENG-51).
  if (busy) return null
  busy = true
  try {
    return await runPass(
      {
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (m) => console.log(`[batch] ${m}`),
      },
      cfg,
      state,
      hooks(db),
      opts,
    )
  } finally {
    busy = false
  }
}

function hooks(db: DB): Hooks {
  const attachments = new Map<string, { dataBase64: string; fileName?: string; mimeType?: string } | undefined>()
  return {
    batchAllowed: (b: BatchRow) => {
      const now = Date.now()
      if (b.scheduled_for && new Date(b.scheduled_for).getTime() > now) return false
      if (b.is_outreach === false) return true
      // Daily outreach window: proactive blasts send between OUTREACH_START
      // and OUTREACH_CUTOFF, and a batch APPROVED inside today's window keeps
      // draining after the cutoff (Justin: a list teed up at 4:25 must not
      // strand half-sent).
      const local = new Date()
      const mins = (d: Date) => d.getHours() * 60 + d.getMinutes()
      const inWindow = (d: Date) => mins(d) >= env.outreachStartMins && mins(d) < env.outreachCutoffMins
      if (inWindow(local)) return true
      if (!b.approved_at) return false
      const a = new Date(b.approved_at)
      return a.toDateString() === local.toDateString() && inWindow(a)
    },

    guard: async ({ item, batch, threadChatId, recipientKey }) => {
      const data = item.data ?? {}
      const isOutreach = batch.is_outreach === true
      const verdict = await guardSend(db, {
        renderedText: item.rendered_text,
        isOutreach,
        outreachId: data.outreach_id,
        beeperChatId: data.beeper_chat_id,
        conversationId: data.conversation_id,
      })
      if (!verdict.ok) return verdict
      if (threadChatId && isOutreach) {
        const { data: convRows } = await db
          .from('inbox_conversations')
          .select('last_activity')
          .eq('adapter', 'beeper')
          .eq('external_chat_id', threadChatId)
          .limit(1)
        const la = convRows?.[0]?.last_activity
        if (la && Date.now() - new Date(la).getTime() < ACTIVE_CONVO_MS) return { ok: false, reason: 'Live conversation, not blasted' }
      }
      if (isOutreach && (await alreadySent(db, recipientKey, textHash(item.rendered_text ?? "")))) {
        return { ok: false, reason: 'already_sent' }
      }
      return { ok: true }
    },

    afterSent: async ({ item, recipientKey }) => {
      await recordSent(db, {
        outreachId: item.data?.outreach_id,
        recipient: recipientKey,
        hash: textHash(item.rendered_text ?? ""),
        batchItemId: item.id,
        text: item.rendered_text ?? "",
      })
    },

    attachmentFor: async (b: BatchRow) => {
      if (!b.attachment_name && !b.attachment_mime) return undefined
      if (!attachments.has(b.id)) {
        const { data } = await db
          .from('inbox_batches')
          .select('attachment_data, attachment_name, attachment_mime')
          .eq('id', b.id)
          .maybeSingle()
        attachments.set(b.id, data?.attachment_data
          ? { dataBase64: data.attachment_data, fileName: data.attachment_name ?? undefined, mimeType: data.attachment_mime ?? undefined }
          : undefined)
      }
      return attachments.get(b.id)
    },
  }
}
