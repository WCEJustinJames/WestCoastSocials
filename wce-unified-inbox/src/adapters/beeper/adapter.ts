import type {
  ChannelAdapter,
  FetchOptions,
  NormalizedAccount,
  NormalizedChat,
  NormalizedMessage,
  SendResult,
} from '../types'
import { BeeperClient } from './client'

/**
 * Beeper adapter — normalizes the Beeper Desktop bridge into the inbox's
 * channel-agnostic shapes. Covers WhatsApp, Messenger, SMS (per number),
 * Instagram, Facebook — each surfaces as its own Beeper `accountID` + network.
 */
export class BeeperAdapter implements ChannelAdapter {
  readonly id = 'beeper' as const

  constructor(private readonly client: BeeperClient) {}

  async listAccounts(): Promise<NormalizedAccount[]> {
    const accounts = await this.client.listAccounts()
    return accounts.map((a) => ({ accountId: a.accountID, network: a.network }))
  }

  async fetchInbound(opts: FetchOptions = {}): Promise<{
    chats: NormalizedChat[]
    messages: NormalizedMessage[]
  }> {
    const messages: NormalizedMessage[] = []
    const chats = new Map<string, NormalizedChat>()
    let cursor: string | undefined
    const dateAfter = opts.since?.toISOString()

    // Page from newest backwards until we run out or pass the lookback window.
    for (let page = 0; page < 50; page++) {
      const res = await this.client.searchMessages({
        chatType: 'single', // scope: 1:1 only (private DMs/SMS)
        dateAfter,
        limit: opts.limit ?? 200,
        cursor,
        direction: 'before',
      })

      for (const [chatId, c] of Object.entries(res.chats ?? {})) {
        if (chats.has(chatId)) continue
        chats.set(chatId, {
          externalChatId: c.id ?? chatId,
          accountId: c.accountID ?? null,
          network: c.network,
          title: c.title ?? null,
          type: c.type === 'group' ? 'group' : 'single',
          lastActivity: c.lastActivity ?? null,
          unreadCount: c.unreadCount ?? 0,
        })
      }

      for (const m of res.items ?? []) {
        const chat = res.chats?.[m.chatID]
        messages.push({
          externalMessageId: m.id ?? m.messageID,
          externalChatId: m.chatID,
          accountId: m.accountID ?? null,
          network: chat?.network ?? 'unknown',
          senderId: m.senderID ?? null,
          senderName: m.senderName ?? null,
          direction: m.isSender ? 'outbound' : 'inbound',
          text: m.text ?? null,
          timestamp: m.timestamp,
          sortKey: m.sortKey != null ? String(m.sortKey) : null,
          isUnread: m.isUnread ?? null,
          raw: m,
        })
      }

      if (!res.hasMore || !res.oldestCursor) break
      cursor = res.oldestCursor
    }

    return { chats: [...chats.values()], messages }
  }

  async sendMessage(
    externalChatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const r = await this.client.sendMessage(externalChatId, text, replyToMessageId)
    return { ok: r.success, pendingMessageId: r.pendingMessageID, error: r.error }
  }
}
