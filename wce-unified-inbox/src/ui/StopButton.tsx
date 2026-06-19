import { useEffect, useState } from 'react'
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

/**
 * Generic pause/play pill bound to one boolean column on inbox_settings (id=1).
 * The PC sync re-reads these every pass, so a flip halts/resumes instantly from
 * any device, no restart. Polls every 5s to reflect changes made elsewhere.
 */
function PauseToggle({
  column,
  reasonColumn,
  confirmText,
  liveLabel,
  pausedLabel,
  liveTitle,
  pausedTitle,
  liveClass,
}: {
  column: string
  reasonColumn?: string
  confirmText: string
  liveLabel: string
  pausedLabel: string
  liveTitle: string
  pausedTitle: string
  liveClass: string
}) {
  const [paused, setPaused] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    const { data } = await sb.from('inbox_settings').select(column).eq('id', 1).maybeSingle()
    setPaused((data?.[column] as boolean | null) ?? false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function toggle() {
    if (paused === null || busy) return
    const next = !paused
    if (next && !window.confirm(confirmText)) return
    setBusy(true)
    const patch: Record<string, unknown> = { [column]: next, updated_at: new Date().toISOString() }
    if (reasonColumn) patch[reasonColumn] = next ? 'paused from app' : null
    const { error } = await sb.from('inbox_settings').update(patch).eq('id', 1)
    setBusy(false)
    if (!error) setPaused(next)
    else window.alert('Could not update — try again.')
  }

  if (paused === null) return null

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={paused ? pausedTitle : liveTitle}
      className={`rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-60 ${
        paused ? 'bg-amber-600 hover:bg-amber-500' : liveClass
      }`}
    >
      {paused ? pausedLabel : liveLabel}
    </button>
  )
}

/**
 * The hard STOP button — master kill-switch (inbox_settings.sends_paused). Halts
 * ALL outgoing messages (outreach AND auto-replies) instantly, from any device.
 */
export function StopButton() {
  return (
    <PauseToggle
      column="sends_paused"
      reasonColumn="paused_reason"
      confirmText="Pause ALL outgoing messages now?"
      liveLabel="■ STOP"
      pausedLabel="▶ Resume sends"
      liveTitle="Stop all outgoing messages"
      pausedTitle="Sends are paused — tap to resume"
      liveClass="bg-red-600 hover:bg-red-500"
    />
  )
}

/**
 * Independent pause for just the AI auto-replies (inbox_settings.replies_paused).
 * Proactive outreach keeps running; only the reactive reply rail is held. The
 * master STOP above still halts replies too.
 */
export function RepliesToggle() {
  return (
    <PauseToggle
      column="replies_paused"
      confirmText="Pause AI auto-replies? (outreach keeps running)"
      liveLabel="⏸ Replies"
      pausedLabel="▶ Replies off"
      liveTitle="Pause the AI auto-replies only"
      pausedTitle="Auto-replies paused — tap to resume"
      liveClass="bg-slate-600 hover:bg-slate-500"
    />
  )
}
