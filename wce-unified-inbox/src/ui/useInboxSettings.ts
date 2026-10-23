import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// inbox_settings isn't in the generated Database types yet — cast for this table.
const sb = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, v: number) => {
        maybeSingle: () => Promise<{ data: Record<string, boolean | null> | null }>
      }
    }
    update: (v: Record<string, unknown>) => {
      eq: (col: string, v: number) => Promise<{ error: { message?: string } | null }>
    }
  }
}

export interface InboxSettings {
  repliesPaused: boolean
  sendsPaused: boolean
  rosterPaused: boolean
}

/**
 * Shared view of inbox_settings (id=1) — the auto-reply rail and kill-switch
 * flags that the Messaging status line, the Batches rail and the Inbox draft
 * cards all read. The PC sync re-reads these every pass, so a flip halts or
 * resumes instantly from any device. Polls every 5s to reflect changes made
 * elsewhere; `loaded` is false until the first read lands so callers can avoid
 * flashing the wrong state.
 */
export function useInboxSettings(): {
  settings: InboxSettings
  loaded: boolean
  update: (patch: Partial<InboxSettings>) => Promise<boolean>
} {
  const [settings, setSettings] = useState<InboxSettings>({
    repliesPaused: false,
    sendsPaused: false,
    rosterPaused: false,
  })
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const { data } = await sb
      .from('inbox_settings')
      .select('replies_paused, sends_paused, roster_paused')
      .eq('id', 1)
      .maybeSingle()
    if (data) {
      setSettings({
        repliesPaused: data.replies_paused ?? false,
        sendsPaused: data.sends_paused ?? false,
        rosterPaused: data.roster_paused ?? false,
      })
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const update = useCallback(async (patch: Partial<InboxSettings>): Promise<boolean> => {
    const cols: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.repliesPaused !== undefined) cols.replies_paused = patch.repliesPaused
    if (patch.sendsPaused !== undefined) {
      cols.sends_paused = patch.sendsPaused
      cols.paused_reason = patch.sendsPaused ? 'paused from app' : null
    }
    if (patch.rosterPaused !== undefined) cols.roster_paused = patch.rosterPaused
    const { error } = await sb.from('inbox_settings').update(cols).eq('id', 1)
    if (!error) setSettings((s) => ({ ...s, ...patch }))
    return !error
  }, [])

  return { settings, loaded, update }
}
