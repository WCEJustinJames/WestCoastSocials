/**
 * Thin typed client for the Beeper Desktop API (http://localhost:23373).
 *
 * Verified against Beeper's developer docs (see README "Beeper API — verified").
 * Supports both the current `v1` paths and the deprecated `v0` paths so we can
 * fall back if a given Beeper Desktop build hasn't shipped v1 yet.
 *
 *   accounts        GET  /v1/accounts
 *   search messages GET  /v1/messages/search        (v0: /v0/search-messages)
 *   send / reply    POST /v1/chats/{chatID}/messages (v0: /v0/send-message)
 *   info            GET  /v1/info
 */

export interface BeeperClientOptions {
  baseUrl: string
  token: string
  apiVersion?: 'v0' | 'v1'
}

export interface BeeperAccount {
  accountID: string
  network: string
  [k: string]: unknown
}

export interface BeeperMessage {
  id: string
  messageID?: string
  chatID: string
  accountID: string
  senderID: string
  senderName: string | null
  timestamp: string
  sortKey: number | string
  text: string | null
  isSender: boolean
  isUnread: boolean | null
  attachments?: unknown[]
  reactions?: unknown[]
}

export interface BeeperChat {
  id: string
  accountID: string
  network: string
  title: string
  type: 'single' | 'group'
  lastActivity: string | null
  unreadCount: number
  [k: string]: unknown
}

export interface SearchMessagesResponse {
  items: BeeperMessage[]
  chats: Record<string, BeeperChat>
  hasMore: boolean
  oldestCursor: string | null
  newestCursor: string | null
}

export interface SearchMessagesParams {
  chatType?: 'single' | 'group'
  accountIDs?: string[]
  chatIDs?: string[]
  sender?: 'me' | 'others' | string
  dateAfter?: string
  dateBefore?: string
  limit?: number
  cursor?: string
  direction?: 'before' | 'after'
}

export interface SendMessageResponse {
  // v1 has no `success` field — a 200 with a pendingMessageID is success.
  success?: boolean
  chatID?: string
  pendingMessageID?: string
  error?: string
}

export class BeeperClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly v: 'v0' | 'v1'

  constructor(opts: BeeperClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.v = opts.apiVersion ?? 'v1'
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Beeper ${path} -> ${res.status} ${res.statusText} ${body}`.trim())
    }
    return (await res.json()) as T
  }

  getInfo(): Promise<unknown> {
    return this.request(`/${this.v}/info`)
  }

  async listAccounts(): Promise<BeeperAccount[]> {
    const data = await this.request<BeeperAccount[] | { accounts?: BeeperAccount[] }>(
      `/${this.v}/accounts`,
    )
    return Array.isArray(data) ? data : (data.accounts ?? [])
  }

  searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResponse> {
    const qs = new URLSearchParams()
    if (params.chatType) qs.set('chatType', params.chatType)
    if (params.sender) qs.set('sender', params.sender)
    if (params.dateAfter) qs.set('dateAfter', params.dateAfter)
    if (params.dateBefore) qs.set('dateBefore', params.dateBefore)
    // /v1/messages/search caps limit at 20; clamp so we never 422.
    if (params.limit != null) qs.set('limit', String(Math.min(params.limit, 20)))
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.direction) qs.set('direction', params.direction)
    for (const a of params.accountIDs ?? []) qs.append('accountIDs', a)
    for (const c of params.chatIDs ?? []) qs.append('chatIDs', c)
    const path = this.v === 'v1' ? '/v1/messages/search' : '/v0/search-messages'
    return this.request<SearchMessagesResponse>(`${path}?${qs.toString()}`)
  }

  /** Merged contact book for an account (used to add new recipients by name/number). */
  listContacts(accountID: string, limit = 20): Promise<unknown> {
    const qs = new URLSearchParams({ limit: String(limit) })
    return this.request(
      `/v1/accounts/${encodeURIComponent(accountID)}/contacts/list?${qs.toString()}`,
    )
  }

  sendMessage(
    chatID: string,
    text: string,
    replyToMessageID?: string,
  ): Promise<SendMessageResponse> {
    if (this.v === 'v1') {
      return this.request<SendMessageResponse>(
        `/v1/chats/${encodeURIComponent(chatID)}/messages`,
        { method: 'POST', body: JSON.stringify({ text, replyToMessageID }) },
      )
    }
    return this.request<SendMessageResponse>('/v0/send-message', {
      method: 'POST',
      body: JSON.stringify({ chatID, text, replyToMessageID }),
    })
  }
}
