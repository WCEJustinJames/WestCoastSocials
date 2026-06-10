import 'dotenv/config'

/**
 * Node-side environment (used by the sync/mirror and the Beeper probe).
 * The browser app uses Vite's import.meta.env instead — see src/lib/supabase.ts.
 */
export const env = {
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  beeperBaseUrl: process.env.BEEPER_BASE_URL ?? 'http://localhost:23373',
  beeperToken: process.env.BEEPER_ACCESS_TOKEN ?? '',
  beeperApiVersion: (process.env.BEEPER_API_VERSION ?? 'v1') as 'v0' | 'v1',
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 15000),
  syncLookbackDays: Number(process.env.SYNC_LOOKBACK_DAYS ?? 30),
  // AI drafting (optional — leave the key unset to disable). When set, the sync
  // loop generates suggested replies into inbox_drafts as `pending`.
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  // Receipt OCR can use a cheaper model than drafting without hurting quality.
  receiptsModel: process.env.RECEIPTS_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  draftMaxPerPass: Number(process.env.DRAFT_MAX_PER_PASS ?? 5),
  // Airtable Player Outreach CRM (optional — leave the key unset to disable).
  // When set, the sync mirrors the CRM into inbox_outreach for batch targeting.
  airtableKey: process.env.AIRTABLE_API_KEY ?? '',
  airtableBaseId: process.env.AIRTABLE_BASE_ID ?? 'appTPf6j5S1MdNXEf',
  airtableOutreachTable: process.env.AIRTABLE_OUTREACH_TABLE ?? 'Player Outreach',
  outreachSyncMinutes: Number(process.env.OUTREACH_SYNC_MINUTES ?? 10),
  // Auto-reply to inbound replies (poker game invites). When on, the sync reads
  // unhandled inbound messages, thanks/acknowledges the simple ones (confirm or
  // decline) automatically, and texts a confirmed-players digest to notifyPhone.
  // Anything needing a human (real questions, money) is escalated, not faked.
  autoReply: (process.env.AUTO_REPLY ?? 'on').toLowerCase() !== 'off',
  autoReplyMaxPerPass: Number(process.env.AUTO_REPLY_MAX_PER_PASS ?? 15),
  // Where the "who confirmed" digest texts go (Justin's mobile, +E.164).
  notifyPhone: process.env.NOTIFY_PHONE ?? '+61459686980',
  // Beeper GROUP chat to also post confirmations into (e.g. the cash-games
  // coordination group). Matched by title (case-insensitive contains). Empty
  // disables group posting.
  notifyGroupName: process.env.NOTIFY_GROUP_NAME ?? 'CASH GAMES West Coast Poker',
  // LetsPoker (lets.poker) operator integration — the App Chats player messenger
  // and tournament data behind the wcp.admin.lets.poker dashboard. Off until a
  // token is set. baseUrl/paths are env-overridable so they can be pinned to the
  // exact endpoints captured from the admin web app without a code change.
  letspokerBaseUrl: process.env.LETSPOKER_BASE_URL ?? 'https://wcp.admin.lets.poker',
  letspokerToken: process.env.LETSPOKER_TOKEN ?? '',
  letspokerClubId: process.env.LETSPOKER_CLUB_ID ?? '',
  letspokerChatsPath: process.env.LETSPOKER_CHATS_PATH ?? '/api/app-chats',
  letspokerMessagesPath: process.env.LETSPOKER_MESSAGES_PATH ?? '/api/app-chats/{chatId}/messages',
  letspokerSendPath: process.env.LETSPOKER_SEND_PATH ?? '/api/app-chats/{chatId}/messages',
  letspokerEntrantsPath:
    process.env.LETSPOKER_ENTRANTS_PATH ?? '/api/tournaments/{tournamentId}/players',
  // Receipt guardrail: the recipient/operator signs every slip, so their name
  // and number must never be extracted as a *player*. Comma-separated.
  receiptBlockNames: (process.env.RECEIPT_BLOCK_NAMES ?? 'justin lewis,jj lewis,j j lewis,lewis,justin')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  receiptBlockPhones: (process.env.RECEIPT_BLOCK_PHONES ?? '0466360662')
    .split(',')
    .map((s) => s.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, ''))
    .filter(Boolean),
}

export function requireEnv(keys: (keyof typeof env)[]): void {
  const missing = keys.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
    )
  }
}
