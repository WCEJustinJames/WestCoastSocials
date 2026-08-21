import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface InboxSettings {
  sendsPaused: boolean
  repliesPaused: boolean
  rosterPaused: boolean
  pausedReason: string | null
  /** Google Messages bridge circuit-breaker: SMS sends are held while true. */
  smsBridgeDown: boolean
}

type SettingsRow = {
  sends_paused: boolean | null
  replies_paused: boolean | null
  roster_paused: boolean | null
  paused_reason: string | null
  sms_bridge_down: boolean | null
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
      .select('sends_paused, replies_paused, roster_paused, paused_reason, sms_bridge_down')
      .eq('id', 1)
      .maybeSingle()
    if (error) throw new Error(error.message ?? 'settings query error')
    return {
      sendsPaused: data?.sends_paused ?? false,
      repliesPaused: data?.replies_paused ?? false,
      rosterPaused: data?.roster_paused ?? false,
      pausedReason: data?.paused_reason ?? null,
      smsBridgeDown: data?.sms_bridge_down ?? false,
    }
  } catch (e) {
    console.error('[settings] read failed, assuming NOT paused:', e instanceof Error ? e.message : e)
    return { sendsPaused: false, repliesPaused: false, rosterPaused: false, pausedReason: null, smsBridgeDown: false }
  }
}

/** Trip / clear the Google Messages circuit-breaker (best-effort). */
export async function setSmsBridge(db: DB, down: boolean): Promise<void> {
  try {
    const q = db as unknown as {
      from: (t: string) => { update: (v: unknown) => { eq: (c: string, v2: number) => Promise<unknown> } }
    }
    await q
      .from('inbox_settings')
      .update({ sms_bridge_down: down, sms_bridge_since: down ? new Date().toISOString() : null })
      .eq('id', 1)
  } catch (e) {
    console.error('[bridge] flag write failed:', e instanceof Error ? e.message : e)
  }
}
