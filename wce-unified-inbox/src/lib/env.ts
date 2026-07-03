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
  // Airtable Player Outreach CRM — RETIRED. All 487 records (incl. the Source
  // field) were copied into Supabase inbox_outreach, which is now the sole source
  // of truth; new contacts arrive via Google Contacts / TD sheets / post-game /
  // manual entry, all writing straight to Supabase. The legacy mirror is kept
  // behind an explicit opt-in (AIRTABLE_SYNC=1) so a stale key left in .env can't
  // resurrect it or spam 401s — set the flag only to deliberately re-import.
  airtableSync: process.env.AIRTABLE_SYNC === '1',
  airtableKey: process.env.AIRTABLE_API_KEY ?? '',
  airtableBaseId: process.env.AIRTABLE_BASE_ID ?? 'appTPf6j5S1MdNXEf',
  airtableOutreachTable: process.env.AIRTABLE_OUTREACH_TABLE ?? 'Player Outreach',
  outreachSyncMinutes: Number(process.env.OUTREACH_SYNC_MINUTES ?? 10),
  // Google Contacts (People API) sync (optional — leave the refresh token unset
  // to disable). When set, the sync pulls contacts you've added (incrementally,
  // via a stored sync token) into inbox_outreach so new in-person contacts show
  // up in the CRM automatically. Read-only scope. See scripts/get-google-refresh-token.mjs.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
  contactsSyncMinutes: Number(process.env.CONTACTS_SYNC_MINUTES ?? 720),
  // TD-sheet attendee pull cadence (minutes). Reads tonight's "DD/MM Venue" Google
  // Sheets via the Google refresh token above (drive.metadata + spreadsheets read).
  tdSheetsSyncMinutes: Number(process.env.TD_SHEETS_SYNC_MINUTES ?? 30),
  // Auto-linker cadence (minutes): match no-contact players against Beeper threads
  // and phone-bearing records by name, linking/filling on exact unique matches.
  autoLinkMinutes: Number(process.env.AUTOLINK_MINUTES ?? 60),
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
  // The keyword (no-AI) seat-list fallback guesses the roster from reply TEXT and
  // can't tell a poker "yes" from a tradie's "sounds good" — it once posted non-
  // players and a dealer into the group. OFF by default; only the AI-classifier
  // roster posts unless this is explicitly turned on.
  rosterKeywordFallback: (process.env.ROSTER_KEYWORD_FALLBACK ?? 'off').toLowerCase() === 'on',
  // Hold a never-contacted contact's FIRST proactive outreach for one-tap review
  // (vet freshly imported numbers before a cold blast). Opt-in — Justin's rule is
  // "new contacts auto-join", so default off; VET_FIRST_TIMERS=on to enable.
  vetFirstTimers: (process.env.VET_FIRST_TIMERS ?? 'off').toLowerCase() === 'on',
  // Daily window (local time, HH:MM) for proactive OUTREACH (invite blasts):
  // it only fires between OUTREACH_START and OUTREACH_CUTOFF. Reply/confirmation
  // batches and the auto-reply are unaffected, so we can still confirm seats and
  // thank players outside this window.
  outreachStartMins: (() => {
    const [h, m] = (process.env.OUTREACH_START ?? '10:00').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  })(),
  outreachCutoffMins: (() => {
    const [h, m] = (process.env.OUTREACH_CUTOFF ?? '17:15').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  })(),
  // Hard quiet hours (local time): proactive OUTREACH is held between QUIET_START
  // and QUIET_END — no outreach batches, no approved drafts. EXEMPT, per Justin:
  // replies to players (the auto-reply path) and the live seat-list, which stay
  // open all hours so anyone who replies is answered. Held items flush once the
  // quiet window ends.
  quietStartMins: (() => {
    const [h, m] = (process.env.QUIET_START ?? '21:00').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  })(),
  quietEndMins: (() => {
    const [h, m] = (process.env.QUIET_END ?? '09:00').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  })(),
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
  // Postiz (social scheduling) — the Social tab's posts publish through it once
  // an API key is set. Cloud default; point POSTIZ_API_URL at a self-hosted
  // instance instead if one is stood up later.
  postizUrl: process.env.POSTIZ_API_URL ?? 'https://api.postiz.com',
  postizKey: process.env.POSTIZ_API_KEY ?? '',
  // Klaviyo (email blasts) — the Social tab's blast pushes build a Klaviyo list
  // from the CRM segment once this key is set.
  klaviyoKey: process.env.KLAVIYO_API_KEY ?? '',
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

/** True while inside the hard quiet-hours window (handles wrap past midnight). */
export function inQuietHours(d: Date = new Date()): boolean {
  const mins = d.getHours() * 60 + d.getMinutes()
  const { quietStartMins: start, quietEndMins: end } = env
  return start > end ? mins >= start || mins < end : mins >= start && mins < end
}

export function requireEnv(keys: (keyof typeof env)[]): void {
  const missing = keys.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
    )
  }
}
