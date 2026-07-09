import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { ChannelAdapter } from '../adapters/types'

type DB = SupabaseClient<Database>

/** Beeper stores text as rich-text (HTML); flatten to readable plain text. */
function stripHtml(raw: string | null): string {
  if (!raw) return ''
  return raw
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .trim()
}

/** No em-dashes, per the messaging rules. */
const stripDashes = (t: string): string => t.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',')

/** Strip the venue/stake noise operators put in contact names, for display. */
function cleanName(raw: string): string {
  const c = raw
    .replace(/\$\s*\d[\d/]*/g, '')
    .replace(/\b(cash|poker|mct|mct's|tourney|tournament|game|games|and|vm|nlh|plo|woodvale|kenwick|kingsley|southside|south|north|central|leederville|leedy|adriatic|stirling|bentley|player)\b/gi, '')
    .replace(/[\/|]/g, ' ').replace(/\s+/g, ' ').trim()
  return c || raw.split(/\s+/)[0] || 'there'
}

// Conservative keyword classification for the PUBLIC seat list (no AI). Bias
// toward leaving people off rather than wrongly listing them: a name only makes
// the roster on a clear confirmation with no decline language.
const DECLINE = /\b(not tonight|no thanks|nah|can'?t|cant|won'?t|wont|unable|busy|next time|maybe not|another time|out tonight|no\b)\b/i
const CONFIRM = /\b(yes|yep|yeah|yup|keen|reserve|save me|lock me|book me|count me|i'?m in|im in|\bin\b|coming|be there|see you|sounds good|sweet|please do)\b/i
const STAKE = /(\$?\d\/\d+(?:\/\d+)?)/

/**
 * Keep ONE live confirmed seat list posted in the cash-games group, built from
 * today's inbound replies (keyword-classified, no AI required). When the roster
 * changes, the previous post is deleted and a fresh one put up, so only the
 * latest list is ever visible. Caller skips this during quiet hours.
 */
/**
 * Given conversation ids, return the subset that map to a CRM contact flagged
 * staff / do_not_message / hidden, so the seat list can drop them. Best-effort:
 * matches a conversation to inbox_outreach by beeper_chat_id == external_chat_id
 * (Messenger contacts); SMS-only contacts without a stored chat id won't match,
 * but the AI classifier already filters non-confirmations upstream.
 */
export async function flaggedConversationIds(
  db: DB,
  conversationIds: (string | null | undefined)[],
): Promise<Set<string>> {
  const excluded = new Set<string>()
  const ids = [...new Set(conversationIds.filter((x): x is string => !!x))]
  if (ids.length === 0) return excluded

  const { data: convs } = await db
    .from('inbox_conversations')
    .select('id, external_chat_id')
    .in('id', ids)
  const chatToConv = new Map<string, string>()
  for (const c of convs ?? []) {
    if (c.external_chat_id) chatToConv.set(c.external_chat_id, c.id)
  }
  const chatIds = [...chatToConv.keys()]
  if (chatIds.length === 0) return excluded

  const { data: flagged } = await db
    .from('inbox_outreach')
    .select('beeper_chat_id')
    .in('beeper_chat_id', chatIds)
    .or('do_not_message.eq.true,hidden.eq.true,staff.eq.true')
  for (const f of flagged ?? []) {
    const conv = f.beeper_chat_id ? chatToConv.get(f.beeper_chat_id) : undefined
    if (conv) excluded.add(conv)
  }
  return excluded
}

export async function postSeatList(db: DB, adapter: ChannelAdapter, groupChatId: string): Promise<void> {
  const since = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await db
    .from('inbox_messages')
    .select('conversation_id, sender_name, text, timestamp, conversation:inbox_conversations!inner(adapter, title)')
    .eq('direction', 'inbound')
    .gt('timestamp', since)
    .order('timestamp', { ascending: true })
    .limit(300)
  if (!rows) return

  // Latest inbound text per conversation (last word wins).
  const latest = new Map<string, { name: string; text: string }>()
  for (const m of rows) {
    const conv = m.conversation as unknown as { adapter?: string; title?: string | null } | null
    if (conv?.adapter !== adapter.id) continue
    const txt = stripHtml(m.text)
    if (!txt) continue
    const name = (m.sender_name || conv?.title || 'Player').trim()
    if (name.toLowerCase().includes('justin lewis')) continue
    latest.set(m.conversation_id ?? name, { name, text: txt })
  }

  // Drop anyone whose CRM row is staff / do_not_message / hidden (a dealer or a
  // non-player must never land on the public seat list).
  const excluded = await flaggedConversationIds(db, [...latest.keys()])
  const entries: string[] = []
  for (const [key, { name, text }] of latest) {
    if (excluded.has(key)) continue
    if (DECLINE.test(text)) continue
    if (!CONFIRM.test(text)) continue
    const stake = text.match(STAKE)?.[1]
    const nm = cleanName(name)
    entries.push(stake ? `${nm} (${stake})` : nm)
  }
  if (entries.length === 0) return // nothing confirmed yet; leave any existing post untouched

  const body = stripDashes(
    `CASH tonight, confirmed (${entries.length}):\n` + entries.map((e, i) => `${i + 1}. ${e}`).join('\n'),
  )
  const hash = String(entries.length) + ':' + entries.join('|')

  const { data: prevRows } = await db
    .from('inbox_group_post')
    .select('message_id, roster_hash')
    .eq('id', 1)
    .limit(1)
  const prev = (prevRows ?? [])[0] as { message_id?: string | null; roster_hash?: string | null } | undefined
  if (prev?.roster_hash === hash) return // unchanged, nothing to do

  // Delete the previous roster so only the latest remains.
  if (prev?.message_id && adapter.deleteMessage) {
    try {
      await adapter.deleteMessage(groupChatId, prev.message_id)
    } catch (e) {
      console.error('[roster] delete previous failed:', e instanceof Error ? e.message : e)
    }
  }
  if (!adapter.sendMessage) return
  const r = await adapter.sendMessage(groupChatId, body)
  await db
    .from('inbox_group_post')
    .update({
      chat_id: groupChatId,
      message_id: r.pendingMessageId ?? null,
      roster_hash: hash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  console.log(`[roster] seat list updated (${entries.length} confirmed)`)
}
