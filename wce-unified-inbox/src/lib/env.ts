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
  draftMaxPerPass: Number(process.env.DRAFT_MAX_PER_PASS ?? 5),
  // Airtable Player Outreach CRM (optional — leave the key unset to disable).
  // When set, the sync mirrors the CRM into inbox_outreach for batch targeting.
  airtableKey: process.env.AIRTABLE_API_KEY ?? '',
  airtableBaseId: process.env.AIRTABLE_BASE_ID ?? 'appTPf6j5S1MdNXEf',
  airtableOutreachTable: process.env.AIRTABLE_OUTREACH_TABLE ?? 'Player Outreach',
  outreachSyncMinutes: Number(process.env.OUTREACH_SYNC_MINUTES ?? 10),
}

export function requireEnv(keys: (keyof typeof env)[]): void {
  const missing = keys.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
    )
  }
}
