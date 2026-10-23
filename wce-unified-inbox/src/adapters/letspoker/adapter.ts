import type {
  ChannelAdapter,
  FetchOptions,
  NormalizedAccount,
  NormalizedChat,
  NormalizedMessage,
  SendOptions,
  SendResult,
} from '../types'
import { LetsPokerClient } from './client'

/**
 * LetsPoker adapter — surfaces the App Chats player messenger as just another
 * channel in the unified inbox, using the same normalized shapes as Beeper.
 *
 * Read + send are implemented against LetsPokerClient. There's no cold-start
 * (`startChatAndSend`): LP chats only exist with players who already use the
 * app, so we can only reply within existing threads. When the client isn't
 * configured (no token) fetchInbound returns empty, so wiring this into the
 * mirror is safe before credentials are in place.
 */
export class LetsPokerAdapter implements ChannelAdapter {
  readonly id = 'letspoker' as const
  private readonly network = 'letspoker'

  constructor(
    private readonly client: LetsPokerClient,
    private readonly accountId = 'letspoker',
  ) {}

  async listAccounts(): Promise<NormalizedAccount[]> {
    if (!this.client.configured) return []
    return [{ accountId: this.accountId, network: this.network }]
  }

  async fetchInbound(_opts: FetchOptions = {}): Promise<{
    chats: NormalizedChat[]
    messages: NormalizedMessage[]
  }> {
    if (!this.client.configured) return { chats: [], messages: [] }

    const lpChats = await this.client.listChats()
    const chats: NormalizedChat[] = lpChats.map((c) => ({
      externalChatId: c.id,
      accountId: this.accountId,
      network: this.network,
      title: c.playerName ?? null,
      type: 'single',
      lastActivity: c.lastActivity ?? null,
      unreadCount: c.unreadCount ?? 0,
    }))

    const messages: NormalizedMessage[] = []
    for (const c of lpChats) {
      const msgs = await this.client.listMessages(c.id)
      for (const m of msgs) {
        messages.push({
          externalMessageId: m.id,
          externalChatId: c.id,
          accountId: this.accountId,
          network: this.network,
          senderId: c.playerId ?? null,
          senderName: m.senderName ?? c.playerName ?? null,
          // A message "from the player" is inbound; anything else is our own send.
          direction: m.fromPlayer ? 'inbound' : 'outbound',
          text: m.text ?? null,
          timestamp: m.createdAt ?? new Date().toISOString(),
          sortKey: m.createdAt ?? null,
          isUnread: null,
          raw: m,
        })
      }
    }

    return { chats, messages }
  }

  async sendMessage(
    externalChatId: string,
    text: string,
    _opts: SendOptions = {},
  ): Promise<SendResult> {
    try {
      const r = await this.client.sendMessage(externalChatId, text)
      return { ok: true, pendingMessageId: r.id }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
