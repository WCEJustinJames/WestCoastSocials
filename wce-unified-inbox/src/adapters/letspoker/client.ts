/**
 * LetsPoker (lets.poker) operator API client.
 *
 * LetsPoker has no public/documented API, but the operator dashboard at
 * `wcp.admin.lets.poker` is a web app backed by a private REST API — including
 * the "App Chats" player messenger and per-tournament player lists. This client
 * talks to that backend.
 *
 * Because the exact routes/payloads aren't published, every path and the auth
 * scheme are env-overridable (see lib/env.ts). The defaults are best-guess
 * shapes; once we capture the real requests from the admin app (a HAR export),
 * pinning them is a config change, not a code change. The field mapping in
 * adapter.ts is likewise defensive (optional-chained) so a near-miss degrades
 * to empty rather than throwing.
 */

export interface LetsPokerConfig {
  baseUrl: string
  token: string
  clubId?: string
  chatsPath: string
  messagesPath: string
  sendPath: string
  entrantsPath: string
}

export interface LPChat {
  id: string
  playerName?: string
  playerId?: string
  lastActivity?: string
  unreadCount?: number
}

export interface LPMessage {
  id: string
  chatId: string
  text?: string
  fromPlayer?: boolean
  senderName?: string
  createdAt?: string
}

export interface LPEntrant {
  playerId?: string
  name: string
  entries?: number
}

export class LetsPokerClient {
  constructor(private readonly cfg: LetsPokerConfig) {}

  get configured(): boolean {
    return !!this.cfg.token
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.cfg.baseUrl}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.cfg.clubId ? { 'X-Club-Id': this.cfg.clubId } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LetsPoker ${res.status} ${path}: ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  private fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''))
  }

  /** Open App Chats threads. Tolerates either a bare array or {data:[…]}. */
  async listChats(): Promise<LPChat[]> {
    if (!this.configured) return []
    const r = await this.req<LPChat[] | { data?: LPChat[]; chats?: LPChat[] }>(this.cfg.chatsPath)
    return Array.isArray(r) ? r : (r.data ?? r.chats ?? [])
  }

  async listMessages(chatId: string): Promise<LPMessage[]> {
    if (!this.configured) return []
    const path = this.fill(this.cfg.messagesPath, { chatId })
    const r = await this.req<LPMessage[] | { data?: LPMessage[]; messages?: LPMessage[] }>(path)
    return Array.isArray(r) ? r : (r.data ?? r.messages ?? [])
  }

  async sendMessage(chatId: string, text: string): Promise<{ id?: string }> {
    if (!this.configured) throw new Error('LetsPoker not configured (set LETSPOKER_TOKEN)')
    const path = this.fill(this.cfg.sendPath, { chatId })
    return this.req<{ id?: string }>(path, { method: 'POST', body: JSON.stringify({ text }) })
  }

  /** Registered players for a tournament event (used to resolve cashier names). */
  async listEntrants(tournamentId: string): Promise<LPEntrant[]> {
    if (!this.configured) return []
    const path = this.fill(this.cfg.entrantsPath, { tournamentId })
    const r = await this.req<LPEntrant[] | { data?: LPEntrant[]; players?: LPEntrant[] }>(path)
    return Array.isArray(r) ? r : (r.data ?? r.players ?? [])
  }
}
