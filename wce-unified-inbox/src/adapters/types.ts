/**
 * Pluggable channel adapter contract.
 *
 * Every message source (Beeper today; LetsPoker later) implements this and
 * returns the SAME normalized shapes. The mirror, identity-matching, and the
 * future batch/draft engine all speak these types — so a new adapter slots in
 * with zero schema change and zero changes to the inbox core.
 */

export type AdapterId = 'beeper' | 'letspoker'

export interface NormalizedAccount {
  /** Stable id for this channel instance (e.g. a Beeper accountID / one SMS number). */
  accountId: string
  /** whatsapp | sms | messenger | instagram | facebook | letspoker | ... */
  network: string
}

export interface NormalizedChat {
  externalChatId: string
  accountId: string | null
  network: string
  title: string | null
  type: 'single' | 'group'
  lastActivity: string | null
  unreadCount: number
}

export interface NormalizedMessage {
  externalMessageId: string
  externalChatId: string
  accountId: string | null
  network: string
  senderId: string | null
  senderName: string | null
  direction: 'inbound' | 'outbound'
  text: string | null
  /** ISO-8601 */
  timestamp: string
  sortKey: string | null
  isUnread: boolean | null
  /** Full original payload, preserved for future-proofing. */
  raw: unknown
}

export interface FetchOptions {
  since?: Date
  limit?: number
}

export interface SendResult {
  ok: boolean
  pendingMessageId?: string
  error?: string
}

/** An image (or other file) to attach to an outgoing message. */
export interface OutgoingAttachment {
  /** base64 file content, no `data:` prefix. */
  dataBase64: string
  fileName?: string
  mimeType?: string
}

export interface SendOptions {
  replyToMessageId?: string
  attachment?: OutgoingAttachment
}

export interface ChannelAdapter {
  readonly id: AdapterId

  /** Discover the channel instances behind this adapter. */
  listAccounts(): Promise<NormalizedAccount[]>

  /** Pull inbound (and own outbound) 1:1 messages + their chats. */
  fetchInbound(opts?: FetchOptions): Promise<{
    chats: NormalizedChat[]
    messages: NormalizedMessage[]
  }>

  /**
   * Send / reply. Optional on the interface because not every adapter can send
   * yet (LetsPoker is a read/manual-log placeholder for now). The mirror only
   * needs read; the draft-and-approve + batch engine will require this.
   */
  sendMessage?(
    externalChatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<SendResult>

  /**
   * Start (or resolve) a direct chat to a raw recipient (e.g. a phone number)
   * and send `text` in one step. Used by batches to reach people who have no
   * existing thread. Optional — only adapters that can cold-start a chat
   * implement it.
   */
  startChatAndSend?(
    accountId: string,
    participant: string,
    text: string,
    opts?: SendOptions,
  ): Promise<SendResult>
}
