import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface InboxSettings {
  sendsPaused: boolean
  repliesPaused: boolean
  pausedReason: string | null
}

type SettingsRow = {
  sends_paused: boolean | null
  replies_paused: boolean | null
  paused_reason: string | null
}

/**
 * Read the global runtime settings (single row id=1). Best-effort: on ANY error
 * we fail OPEN (sends NOT paused) so a transient DB blip can't silently wedge all
 * outbound — the kill-switch defaults off and the row always exists once the 0012
 * migration is applied. Errors are logged, not thrown.
 *
 * `inbox_settings` isn't in the generated Database types yet, so we cast — same
 * pattern run.ts uses for the heartbeat table.
 */
export async function getSettings(db: DB): Promise<InboxSettings> {
  try {
    const q = db as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, val: number) => {
            maybeSingle: () => Promise<{ data: SettingsRow | null; error: { message?: string } | null }>
          }
        }
      }
    }
    const { data, error } = await q
      .from('inbox_settings')
      .select('sends_paused, replies_paused, paused_reason')
      .eq('id', 1)
      .maybeSingle()
    if (error) throw new Error(error.message ?? 'settings query error')
    return {
      sendsPaused: data?.sends_paused ?? false,
      repliesPaused: data?.replies_paused ?? false,
      pausedReason: data?.paused_reason ?? null,
    }
  } catch (e) {
    console.error('[settings] read failed, assuming NOT paused:', e instanceof Error ? e.message : e)
    return { sendsPaused: false, repliesPaused: false, pausedReason: null }
  }
}
