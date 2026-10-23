import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'

type DB = SupabaseClient<Database>

export interface OptOutResult {
  flagged: number
  escalated: number
}

// HARD opt-out: auto-ban (set do_not_message) AND escalate. Kept tight so a
// normal decline ("can't tonight") or "stop by later" never trips it.
const HARD_OPTOUT =
  /\bunsubscribe\b|\bopt[\s-]?out\b|^\s*stop[\s.!]*$|\bstop (texting|messaging|msging|contacting|msg)\b|\b(don'?t|do ?not|dont|never) (text|message|msg|contact) me\b|\bremove me\b|\btake me off\b|\bleave me alone\b|\blose my number\b|\bfuck off\b|\bpiss off\b/i

// SOFT cold-contact signal: escalate only, never auto-ban — let Justin decide.
const SOFT_SIGNAL =
  /\bwrong number\b|\bwho('?s| is) this\b|\bwho are (you|u)\b|\bdo i know (you|u)\b|\bnever signed up\b/i

function stripHtml(raw: string | null): string {
  if (!raw) return ''
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim()
}

/**
 * Auto opt-out (keyword-based, no AI needed — runs even when the classifier is
 * down). Scans recent unhandled inbound: a HARD opt-out flags the contact's CRM
 * row `do_not_message` (so guardrail 3 then blocks every future send to them) and
 * is escalated; a SOFT cold-contact signal is escalated only. Either way the
 * message is marked handled so the auto-reply never "acknowledges" an opt-out.
 *
 * Contact match is via the chat id (`inbox_outreach.beeper_chat_id` == the
 * conversation's `external_chat_id`) — Messenger always, and SMS once the send
 * linkage has recorded the chat. Unmatched opt-outs are still escalated so Justin
 * can ban them by hand.
 */
export async function processOptOuts(
  db: DB,
  adapter: ChannelAdapter,
  notifyPhone: string,
  notifyAccount = 'gmessages',
): Promise<OptOutResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await db
    .from('inbox_messages')
    .select(
      'id, sender_name, text, conversation:inbox_conversations!inner(external_chat_id, adapter)',
    )
    .eq('direction', 'inbound')
    .eq('auto_handled', false)
    .gt('timestamp', since)
    .order('timestamp', { ascending: true })
    .limit(100)
  if (!rows || rows.length === 0) return { flagged: 0, escalated: 0 }

  let flagged = 0
  const escalations: string[] = []
  const handledIds: string[] = []

  for (const m of rows) {
    const conv = m.conversation as unknown as { external_chat_id?: string; adapter?: string } | null
    if (conv?.adapter !== adapter.id) continue
    const txt = stripHtml(m.text)
    const hard = HARD_OPTOUT.test(txt)
    const soft = !hard && SOFT_SIGNAL.test(txt)
    if (!hard && !soft) continue

    const name = (m.sender_name || 'someone').trim()
    let matched = false
    if (hard && conv?.external_chat_id) {
      const { data: o } = await db
        .from('inbox_outreach')
        .select('id, do_not_message')
        .eq('beeper_chat_id', conv.external_chat_id)
        .limit(1)
        .maybeSingle()
      if (o?.id) {
        matched = true
        if (!o.do_not_message) {
          await db.from('inbox_outreach').update({ do_not_message: true }).eq('id', o.id)
          flagged++
        }
      }
    }

    const tag = hard
      ? matched
        ? 'opted out -> auto-banned'
        : 'opted out -> NOT matched in CRM, ban by hand'
      : 'cold/unknown -> check'
    escalations.push(`${name}: "${txt.slice(0, 50)}" (${tag})`)
    handledIds.push(m.id)
  }

  if (handledIds.length) {
    await db
      .from('inbox_messages')
      .update({ auto_handled: true, reply_intent: 'opt_out' })
      .in('id', handledIds)
  }

  if (escalations.length && adapter.startChatAndSend) {
    try {
      await adapter.startChatAndSend(
        notifyAccount,
        notifyPhone,
        `WCP opt-out / cold replies:\n${escalations.join('\n')}`,
      )
    } catch (e) {
      console.error('[optout] escalation send failed:', e instanceof Error ? e.message : e)
    }
  }

  return { flagged, escalated: escalations.length }
}
