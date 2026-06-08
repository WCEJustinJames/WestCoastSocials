import type {
  ChannelAdapter,
  FetchOptions,
  NormalizedAccount,
  NormalizedChat,
  NormalizedMessage,
  OutgoingAttachment,
  SendOptions,
  SendResult,
} from '../types'
import { BeeperClient, type BeeperAttachmentInput } from './client'

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
    // Search returns at most 20 per page, so allow plenty of pages.
    for (let page = 0; page < 300; page++) {
      const res = await this.client.searchMessages({
        chatType: 'single', // scope: 1:1 only (private DMs/SMS)
        dateAfter,
        limit: opts.limit ?? 20,
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

  // Upload an attachment's bytes and shape it for the send call.
  private async uploadAttachment(a: OutgoingAttachment): Promise<BeeperAttachmentInput> {
    const up = await this.client.uploadAssetBase64(a.dataBase64, a.fileName, a.mimeType)
    if (up.error || !up.uploadID) throw new Error(up.error ?? 'asset upload failed')
    const mime = up.mimeType ?? a.mimeType ?? ''
    return {
      uploadID: up.uploadID,
      mimeType: mime || undefined,
      fileName: up.fileName ?? a.fileName,
      type: mime.startsWith('image/') ? 'image' : 'file',
      size: up.width && up.height ? { width: up.width, height: up.height } : undefined,
    }
  }

  async sendMessage(
    externalChatId: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    // The client throws on non-2xx, so reaching here means the bridge accepted it.
    const attachment = opts.attachment ? await this.uploadAttachment(opts.attachment) : undefined
    const r = await this.client.sendMessage(externalChatId, text, {
      replyToMessageID: opts.replyToMessageId,
      attachment,
    })
    return { ok: !r.error, pendingMessageId: r.pendingMessageID, error: r.error }
  }

  async startChatAndSend(
    accountId: string,
    participant: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    // POST /v1/chats resolves/creates the chat AND sends when messageText is set.
    // Verified against gmessages: participant is the +E.164 phone number.
    const chat = (await this.client.createChat(accountId, [participant], {
      type: 'single',
      messageText: text,
    })) as { id?: string; chatID?: string }
    const chatId = chat.id ?? chat.chatID
    if (!chatId) return { ok: false, error: 'could not create chat' }
    // New chats can't carry an attachment in the create call, so send the image
    // as a follow-up message to the chat we just created.
    if (opts.attachment) {
      return this.sendMessage(chatId, '', { attachment: opts.attachment })
    }
    return { ok: true, pendingMessageId: chatId }
  }
}
