import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../types/database'
import type { ChannelAdapter, NormalizedChat } from '../adapters/types'
import { resolvePersonId } from './identity'

type DB = SupabaseClient<Database>

export interface MirrorResult {
  accounts: number
  chats: number
  scanned: number
  inserted: number
}

/**
 * Inbound mirror: pull from an adapter and reconcile into Supabase.
 *   adapter -> people (unified) + identities + conversations + messages
 * Idempotent: messages dedupe on (adapter_source, external_message_id), so this
 * is safe to run on a loop.
 */
export async function mirrorInbound(
  db: DB,
  adapter: ChannelAdapter,
  since: Date,
): Promise<MirrorResult> {
  const accounts = await adapter.listAccounts()
  const { chats, messages } = await adapter.fetchInbound({ since })

  const convIdByChat = new Map<string, string>()
  const personIdByChat = new Map<string, string>()

  for (const chat of chats) {
    const personId = await resolvePersonId(db, {
      adapter: adapter.id,
      network: chat.network,
      accountId: chat.accountId,
      externalId: chat.externalChatId,
      handle: deriveHandle(chat),
      displayName: chat.title,
    })
    personIdByChat.set(chat.externalChatId, personId)

    const { data, error } = await db
      .from('inbox_conversations')
      .upsert(
        {
          person_id: personId,
          adapter: adapter.id,
          network: chat.network,
          account_id: chat.accountId,
          external_chat_id: chat.externalChatId,
          title: chat.title,
          type: chat.type,
          last_activity: chat.lastActivity,
          unread_count: chat.unreadCount,
        },
        { onConflict: 'adapter,account_id,external_chat_id' },
      )
      .select('id')
      .single()
    if (error) throw error
    convIdByChat.set(chat.externalChatId, data.id)
  }

  let inserted = 0
  for (const m of messages) {
    const conversationId = convIdByChat.get(m.externalChatId)
    if (!conversationId) continue
    const { data, error } = await db
      .from('inbox_messages')
      .upsert(
        {
          conversation_id: conversationId,
          person_id: personIdByChat.get(m.externalChatId) ?? null,
          adapter_source: adapter.id,
          network: m.network,
          external_message_id: m.externalMessageId,
          sort_key: m.sortKey,
          sender_id: m.senderId,
          sender_name: m.senderName,
          direction: m.direction,
          kind: '1to1',
          text: m.text,
          timestamp: m.timestamp,
          is_unread: m.isUnread,
          raw: (m.raw ?? null) as Json,
        },
        { onConflict: 'adapter_source,external_message_id', ignoreDuplicates: true },
      )
      .select('id')
    if (error) throw error
    inserted += data?.length ?? 0
  }

  return {
    accounts: accounts.length,
    chats: chats.length,
    scanned: messages.length,
    inserted,
  }
}

/** For a 1:1 chat the title is usually the contact's name or number. */
function deriveHandle(chat: NormalizedChat): string | null {
  return chat.title
}
