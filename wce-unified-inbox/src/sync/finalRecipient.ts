import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BatchRow, ItemRow } from './smsEngine'

// Owner-configured final SMS recipient. Personal contact details stay on the host.
// Read lazily so dotenv has loaded before the first batch pass.
export const FINAL_RECIPIENT = {
  get outreachId() { return process.env.BATCH_FINAL_OUTREACH_ID?.trim() ?? '' },
  get phone() { return process.env.BATCH_FINAL_PHONE?.trim() ?? '' },
  get chatId() { return process.env.BATCH_FINAL_CHAT_ID?.trim() ?? '' },
  get name() { return process.env.BATCH_FINAL_NAME?.trim() ?? '' },
  get nickname() { return process.env.BATCH_FINAL_NICKNAME?.trim() || this.name.split(/\s+/)[0] },
} as const

const key = (v: unknown) => String(v ?? '').replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '')
export function isTyRecipient(item: Pick<ItemRow, 'data'>): boolean {
  const d = item.data ?? {}
  return (!!FINAL_RECIPIENT.outreachId && d.outreach_id === FINAL_RECIPIENT.outreachId)
    || (!!FINAL_RECIPIENT.phone && key(d.phone) === key(FINAL_RECIPIENT.phone))
    || (!!FINAL_RECIPIENT.chatId && d.beeper_chat_id === FINAL_RECIPIENT.chatId)
}
export function isFinalRecipient(item: Pick<ItemRow, 'data'>): boolean {
  const d = item.data ?? {}
  return d.batch_final_recipient === true && d.channel === 'sms'
    && d.outreach_id === FINAL_RECIPIENT.outreachId && key(d.phone) === key(FINAL_RECIPIENT.phone)
}
export function finalRecipientId(batchId: string): string {
  const h = createHash('sha256').update('wce-final-recipient:' + batchId).digest('hex')
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16)
    + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32)
}
export function renderFinalMessage(template: string): string {
  return template.replace(/\{\{?\s*(nickname|first[\s_]*name|first|name)\s*\}\}?/gi,
    (_, token: string) => token.toLowerCase() === 'name' ? FINAL_RECIPIENT.name : FINAL_RECIPIENT.nickname)
    .replace(/\\n/g, '\n')
}

/** Idempotent, single-worker preparation. No send and no batch approval here. */
export async function prepareFinalRecipient(db: SupabaseClient<any>, batch: BatchRow): Promise<void> {
  if (!batch.is_outreach) return
  if (!FINAL_RECIPIENT.outreachId || !/^\+614\d{8}$/.test(FINAL_RECIPIENT.phone) || !FINAL_RECIPIENT.name) {
    throw new Error('Standing final SMS recipient configuration is incomplete')
  }
  const items: ItemRow[] = []
  for (let start = 0; ; start += 500) {
    const { data, error } = await db.from('inbox_batch_items')
      .select('id,batch_id,status,rendered_text,data,created_at,claimed_at,post_attempted_at')
      .eq('batch_id', batch.id).order('created_at').order('id').range(start, start + 499)
    if (error) throw error
    items.push(...(data ?? []))
    if ((data ?? []).length < 500) break
  }
  if (!items.length) return
  const ty = items.filter(isTyRecipient)
  const final = ty.find(isFinalRecipient)
  const posted = ty.find(i => !isFinalRecipient(i) && (i.status === 'sent' || i.status === 'sending' || i.post_attempted_at))
  if (posted) {
    // Never send a second copy when enabling this on an already-started batch.
    if (posted.status === 'sending') throw new Error('Ty already has a send in flight; waiting for resolution')
    if (final && ['approved', 'pending'].includes(final.status ?? '') && !final.post_attempted_at) {
      const { error } = await db.from('inbox_batch_items')
        .update({ status: 'skipped', guard_flag: true, guard_reason: 'Ty already received this batch' })
        .eq('id', final.id).in('status', ['approved', 'pending']).is('post_attempted_at', null)
      if (error) throw error
    }
    return
  }

  if (!final) {
    const { data: source, error } = await db.from('inbox_batches')
      .select('template_body,status').eq('id', batch.id).single()
    if (error) throw error
    if (!['approved', 'sending'].includes(source.status)) throw new Error('Batch is no longer approved')
    const existing = ty.find(i => ['approved', 'pending'].includes(i.status ?? ''))
    const text = existing?.rendered_text || renderFinalMessage(source.template_body ?? '')
    if (!text.trim() || /\{[^{}]+\}/.test(text)) throw new Error('Final recipient message needs a complete batch template')
    const { error: insertError } = await db.from('inbox_batch_items').upsert({
      id: finalRecipientId(batch.id), batch_id: batch.id, person_id: null,
      rendered_text: text, status: 'approved', guard_flag: false,
      data: { channel: 'sms', phone: FINAL_RECIPIENT.phone, outreach_id: FINAL_RECIPIENT.outreachId,
        name: FINAL_RECIPIENT.name, batch_final_recipient: true },
    }, { onConflict: 'id', ignoreDuplicates: true })
    if (insertError) throw insertError
  }
  // Replace an ordinary Ty entry with the one final SMS; never reset a posted row.
  for (const duplicate of ty.filter(i => !isFinalRecipient(i) && ['approved', 'pending'].includes(i.status ?? ''))) {
    const { error } = await db.from('inbox_batch_items')
      .update({ status: 'skipped', guard_flag: true, guard_reason: 'Included once as the final SMS recipient' })
      .eq('id', duplicate.id).in('status', ['approved', 'pending']).is('post_attempted_at', null)
    if (error) throw error
  }
}
