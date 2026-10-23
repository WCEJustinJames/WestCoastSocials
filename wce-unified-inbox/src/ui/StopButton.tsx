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
 * The button shows the feature's CURRENT STATE at a glance — green ▶️ while it's
 * running, red ⏸️ while it's paused — and the hover explains the action you'll
 * take. The PC sync re-reads these every pass, so a flip halts/resumes instantly
 * from any device, no restart. Polls every 5s to reflect changes made elsewhere.
 */
function PauseToggle({
  column,
  reasonColumn,
  confirmText,
  name,
  activeTitle,
  pausedTitle,
}: {
  column: string
  reasonColumn?: string
  confirmText: string
  name: string
  activeTitle: string
  pausedTitle: string
}) {
  const [paused, setPaused] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  // Two-tap confirm for the guarded (pausing) direction — first tap arms, second
  // commits. Replaces window.confirm(), whose synchronous modal froze paint (the
  // INP "blocked UI for ~1s" warnings).
  const [armed, setArmed] = useState(false)
  const [err, setErr] = useState(false)

  async function load() {
    const { data } = await sb.from('inbox_settings').select(column).eq('id', 1).maybeSingle()
    setPaused((data?.[column] as boolean | null) ?? false)
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  // Auto-disarm if the confirming second tap doesn't come within 3s.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  async function toggle() {
    if (paused === null || busy) return
    const next = !paused
    // Pausing is the guarded direction: arm on the first tap, act on the second.
    // Resuming acts immediately.
    if (next && confirmText && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setBusy(true)
    const patch: Record<string, unknown> = { [column]: next, updated_at: new Date().toISOString() }
    if (reasonColumn) patch[reasonColumn] = next ? 'paused from app' : null
    const { error } = await sb.from('inbox_settings').update(patch).eq('id', 1)
    setBusy(false)
    if (!error) {
      setPaused(next)
    } else {
      setErr(true)
      setTimeout(() => setErr(false), 2500)
    }
  }

  if (paused === null) return null

  // State-at-a-glance: running = green ▶️, paused = red ⏸️, about-to-pause = amber.
  const label = err ? '⚠ retry' : armed ? '⚠ tap to confirm' : paused ? `⏸️ ${name}` : `▶️ ${name}`
  const color = err
    ? 'bg-red-600'
    : armed
      ? 'bg-amber-500 hover:bg-amber-400'
      : paused
        ? 'bg-red-600 hover:bg-red-500'
        : 'bg-emerald-600 hover:bg-emerald-500'

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={armed ? confirmText : paused ? pausedTitle : activeTitle}
      className={`rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-60 ${color}`}
    >
      {label}
    </button>
  )
}

/**
 * The hard STOP — master kill-switch (inbox_settings.sends_paused). Halts ALL
 * proactive outreach + batch sends instantly; auto-replies keep running. Shows
 * green ▶️ Sends while live, red ⏸️ Sends while stopped.
 */
export function StopButton() {
  return (
    <PauseToggle
      column="sends_paused"
      reasonColumn="paused_reason"
      confirmText="Stop all outreach + batch sends now? (auto-replies keep running)"
      name="Sends"
      activeTitle="Outreach + batch sends are active — press to pause (auto-replies stay on)"
      pausedTitle="Sends are paused — press to resume"
    />
  )
}

/**
 * Independent pause for just the AI auto-replies (inbox_settings.replies_paused).
 * Proactive outreach keeps running; only the reactive reply rail is held.
 */
export function RepliesToggle() {
  return (
    <PauseToggle
      column="replies_paused"
      confirmText="Pause AI auto-replies? (outreach keeps running)"
      name="Replies"
      activeTitle="AI auto-replies are active — press to pause"
      pausedTitle="Auto-replies are paused — press to resume"
    />
  )
}

/**
 * Pause/resume the cash-games group seat-list posting (inbox_settings.roster_paused).
 * When paused the sync never posts or updates the group roster.
 */
export function RosterToggle() {
  return (
    <PauseToggle
      column="roster_paused"
      confirmText="Pause the cash-games group seat-list updates?"
      name="Group"
      activeTitle="Group seat-list posting is active — press to pause"
      pausedTitle="Group seat-list is paused — press to resume"
    />
  )
}
