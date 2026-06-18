import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// inbox_settings isn't in the generated Database types yet — cast for this table.
const sb = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, v: number) => {
        maybeSingle: () => Promise<{ data: { sends_paused: boolean | null } | null }>
      }
    }
    update: (v: Record<string, unknown>) => {
      eq: (col: string, v: number) => Promise<{ error: { message?: string } | null }>
    }
  }
}

/**
 * The hard STOP button. Flips inbox_settings.sends_paused, which the PC sync
 * checks every pass — so this halts (or resumes) ALL outgoing messages instantly,
 * from any device, no restart. Polls every 5s so it always shows the live state
 * (e.g. if the cloud or another device flipped it).
 */
export function StopButton() {
  const [paused, setPaused] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    const { data } = await sb.from('inbox_settings').select('sends_paused').eq('id', 1).maybeSingle()
    setPaused(data?.sends_paused ?? false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function toggle() {
    if (paused === null || busy) return
    const next = !paused
    if (next && !window.confirm('Pause ALL outgoing messages now?')) return
    setBusy(true)
    const { error } = await sb
      .from('inbox_settings')
      .update({
        sends_paused: next,
        paused_reason: next ? 'paused from app' : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
    setBusy(false)
    if (!error) setPaused(next)
    else window.alert('Could not update — try again.')
  }

  if (paused === null) return null

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={paused ? 'Sends are paused — tap to resume' : 'Stop all outgoing messages'}
      className={`rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-60 ${
        paused ? 'bg-amber-600 hover:bg-amber-500' : 'bg-red-600 hover:bg-red-500'
      }`}
    >
      {paused ? '▶ Resume sends' : '■ STOP'}
    </button>
  )
}
