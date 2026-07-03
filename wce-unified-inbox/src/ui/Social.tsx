import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES } from './usePlayers'
import type { Database } from '../types/database'

type Post = Database['public']['Tables']['social_posts']['Row']
type Push = Database['public']['Tables']['klaviyo_pushes']['Row']

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'threads', 'linkedin', 'x'] as const
const REPEATS = ['none', 'daily', 'weekly', 'fortnightly', 'monthly'] as const
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Local YYYY-MM-DD for a date (calendar cells + post chips must agree). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function statusChip(status: string): string {
  switch (status) {
    case 'scheduled': return 'bg-emerald-100 text-emerald-700'
    case 'posted': return 'bg-slate-100 text-slate-500'
    case 'failed': return 'bg-rose-100 text-rose-700'
    default: return 'bg-amber-100 text-amber-700' // draft
  }
}

/**
 * Social tab — the marketing arm. A month calendar of posts (published through
 * Postiz to the connected socials, artwork via Canva links), repeat rules so a
 * weekly game promo rolls itself forward, and the Klaviyo email-blast bones:
 * pick a CRM segment, queue it, and the sync builds the Klaviyo list — the
 * campaign itself fires from Klaviyo so unsubscribes stay compliant.
 */
export function Social() {
  const [posts, setPosts] = useState<Post[]>([])
  const [pushes, setPushes] = useState<Push[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPosted, setShowPosted] = useState(false)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  // composer
  const [cTitle, setCTitle] = useState('')
  const [cBody, setCBody] = useState('')
  const [cPlatforms, setCPlatforms] = useState<string[]>(['instagram', 'facebook'])
  const [cDate, setCDate] = useState('')
  const [cTime, setCTime] = useState('18:00')
  const [cRepeat, setCRepeat] = useState<(typeof REPEATS)[number]>('none')
  const [cUntil, setCUntil] = useState('')
  const [cAsset, setCAsset] = useState('')

  // klaviyo composer
  const [kName, setKName] = useState('')
  const [kSubject, setKSubject] = useState('')
  const [kBody, setKBody] = useState('')
  const [kSegment, setKSegment] = useState('everyone')

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(null), 4000) }

  async function load() {
    const { data: ps } = await supabase
      .from('social_posts').select('*').order('scheduled_at', { ascending: true }).limit(400)
    setPosts((ps as Post[]) ?? [])
    const { data: ks } = await supabase
      .from('klaviyo_pushes').select('*').order('created_at', { ascending: false }).limit(50)
    setPushes((ks as Push[]) ?? [])
  }
  useEffect(() => { void load() }, [])

  // ----- calendar grid for the displayed month (Mon-first weeks) -----
  const weeks = useMemo(() => {
    const first = new Date(month)
    const start = new Date(first)
    start.setDate(1 - ((first.getDay() + 6) % 7)) // back to Monday
    const out: Date[][] = []
    const cur = new Date(start)
    do {
      const week: Date[] = []
      for (let i = 0; i < 7; i++) { week.push(new Date(cur)); cur.setDate(cur.getDate() + 1) }
      out.push(week)
    } while (cur.getMonth() === month.getMonth())
    return out
  }, [month])

  const postsByDay = useMemo(() => {
    const map = new Map<string, Post[]>()
    for (const p of posts) {
      if (!p.scheduled_at) continue
      const k = dayKey(new Date(p.scheduled_at))
      map.set(k, [...(map.get(k) ?? []), p])
    }
    return map
  }, [posts])

  const todayKey = dayKey(new Date())
  const monthLabel = month.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

  function pickDay(d: Date) {
    setCDate(dayKey(d))
    flash(`Composer set to ${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}.`)
  }

  async function savePost(asDraft: boolean) {
    if (!cTitle.trim()) return flash('Give the post a title.')
    if (!asDraft && !cDate) return flash('Pick a date to schedule (or save as draft).')
    if (!asDraft && cPlatforms.length === 0) return flash('Pick at least one platform.')
    const when = cDate ? new Date(`${cDate}T${cTime || '18:00'}`) : null
    setBusy(true)
    const { error } = await supabase.from('social_posts').insert({
      title: cTitle.trim(),
      body: cBody.trim() || null,
      asset_url: cAsset.trim() || null,
      platforms: cPlatforms,
      scheduled_at: when ? when.toISOString() : null,
      repeat_rule: cRepeat,
      repeat_until: cRepeat !== 'none' && cUntil ? cUntil : null,
      status: asDraft ? 'draft' : 'scheduled',
    })
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setCTitle(''); setCBody(''); setCAsset('')
    flash(asDraft ? 'Draft saved.' : `Scheduled${cRepeat !== 'none' ? ` (repeats ${cRepeat})` : ''}.`)
    await load()
  }

  async function patchPost(id: string, p: Partial<Post>) {
    const { error } = await supabase.from('social_posts').update(p).eq('id', id)
    if (error) return flash(`Error: ${error.message}`)
    await load()
  }
  async function delPost(p: Post) {
    if (!window.confirm(`Delete "${p.title}"?${p.repeat_rule !== 'none' ? ' This stops the repeat series too.' : ''}`)) return
    await supabase.from('social_posts').delete().eq('id', p.id)
    await load()
  }

  async function createPush() {
    if (!kName.trim()) return flash('Name the blast.')
    setBusy(true)
    const { error } = await supabase.from('klaviyo_pushes').insert({
      name: kName.trim(), subject: kSubject.trim() || null, body: kBody.trim() || null, segment: kSegment,
    })
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setKName(''); setKSubject(''); setKBody('')
    flash('Blast drafted — hit Queue when ready.')
    await load()
  }
  async function patchPush(id: string, p: Partial<Push>) {
    const { error } = await supabase.from('klaviyo_pushes').update(p).eq('id', id)
    if (error) return flash(`Error: ${error.message}`)
    await load()
  }
  async function delPush(k: Push) {
    if (!window.confirm(`Delete blast "${k.name}"?`)) return
    await supabase.from('klaviyo_pushes').delete().eq('id', k.id)
    await load()
  }

  const upcoming = posts.filter((p) => showPosted || p.status !== 'posted')

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Social &amp; marketing</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Posts publish through Postiz to the connected socials at their scheduled time (they hold safely until
        POSTIZ_API_KEY is in the PC .env). Design artwork in Canva, paste the share/export link as the asset.
      </p>
      {status && <p className="mb-3 text-sm font-medium text-emerald-700">{status}</p>}

      {/* ----- calendar ----- */}
      <div className="card mb-5 p-3 sm:p-4">
        <div className="mb-2 flex items-center justify-between">
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="btn-ghost px-2">←</button>
          <span className="text-sm font-semibold">{monthLabel}</span>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="btn-ghost px-2">→</button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {DOW.map((d) => <div key={d} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {weeks.flat().map((d) => {
            const k = dayKey(d)
            const inMonth = d.getMonth() === month.getMonth()
            const dayPosts = postsByDay.get(k) ?? []
            return (
              <button key={k} onClick={() => pickDay(d)}
                className={`min-h-[3.5rem] rounded-lg border p-1 text-left align-top transition-colors sm:min-h-[4.5rem] ${
                  k === todayKey ? 'border-emerald-400 bg-emerald-50/60'
                  : inMonth ? 'border-slate-100 bg-white hover:border-emerald-200'
                  : 'border-transparent bg-slate-50 opacity-50'
                }`}>
                <span className={`text-[11px] ${k === todayKey ? 'font-bold text-emerald-700' : 'text-slate-400'}`}>{d.getDate()}</span>
                <div className="mt-0.5 space-y-0.5">
                  {dayPosts.slice(0, 3).map((p) => (
                    <span key={p.id} title={p.title} className={`chip block truncate ${statusChip(p.status)}`}>
                      {p.repeat_rule !== 'none' ? '🔁 ' : ''}{p.title}
                    </span>
                  ))}
                  {dayPosts.length > 3 && <span className="block text-[10px] text-slate-400">+{dayPosts.length - 3} more</span>}
                </div>
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Tap a day to point the composer at it.</p>
      </div>

      {/* ----- composer ----- */}
      <div className="card mb-5 p-3 sm:p-4">
        <p className="mb-2 text-sm font-semibold">New post</p>
        <div className="mb-2 grid gap-2 sm:grid-cols-2">
          <label className="field-label">title
            <input value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="e.g. Thursday $2/5 Woodvale" className="input" />
          </label>
          <label className="field-label">Canva / image link (optional)
            <input value={cAsset} onChange={(e) => setCAsset(e.target.value)} placeholder="paste the Canva export or image URL" className="input" />
          </label>
        </div>
        <label className="field-label mb-2">caption
          <textarea value={cBody} onChange={(e) => setCBody(e.target.value)} rows={3} className="input" placeholder="What goes under the artwork" />
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">platforms:</span>
          {PLATFORMS.map((pl) => {
            const on = cPlatforms.includes(pl)
            return (
              <button key={pl}
                onClick={() => setCPlatforms((prev) => on ? prev.filter((x) => x !== pl) : [...prev, pl])}
                className={`chip border ${on ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-emerald-400'}`}>
                {pl}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="field-label">date
            <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} className="input" />
          </label>
          <label className="field-label">time
            <input type="time" value={cTime} onChange={(e) => setCTime(e.target.value)} className="input w-28" />
          </label>
          <label className="field-label">repeat
            <select value={cRepeat} onChange={(e) => setCRepeat(e.target.value as (typeof REPEATS)[number])} className="input">
              {REPEATS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          {cRepeat !== 'none' && (
            <label className="field-label">until (optional)
              <input type="date" value={cUntil} onChange={(e) => setCUntil(e.target.value)} className="input" />
            </label>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={() => void savePost(true)} disabled={busy} className="btn-ghost border border-slate-300">Save draft</button>
            <button onClick={() => void savePost(false)} disabled={busy} className="btn-primary">Schedule</button>
          </div>
        </div>
      </div>

      {/* ----- upcoming / recent posts ----- */}
      <div className="card mb-6 p-3 sm:p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold">Posts</p>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={showPosted} onChange={(e) => setShowPosted(e.target.checked)} /> show posted
          </label>
        </div>
        <ul className="space-y-2">
          {upcoming.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2">
              <span className={`chip ${statusChip(p.status)}`}>{p.status}</span>
              <span className="text-sm font-medium">{p.title}</span>
              {p.repeat_rule !== 'none' && <span className="chip bg-slate-100 text-slate-500">🔁 {p.repeat_rule}{p.repeat_until ? ` → ${p.repeat_until}` : ''}</span>}
              {p.platforms.map((pl) => <span key={pl} className="chip bg-slate-100 text-slate-500">{pl}</span>)}
              {p.scheduled_at && (
                <span className="text-xs text-slate-400">
                  {new Date(p.scheduled_at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {p.asset_url && <a href={p.asset_url} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 hover:underline">artwork ↗</a>}
              {p.post_error && <span className="w-full text-xs text-rose-600">⚠ {p.post_error}</span>}
              <span className="ml-auto flex gap-2">
                {p.status === 'draft' && p.scheduled_at && (
                  <button onClick={() => void patchPost(p.id, { status: 'scheduled' })} className="text-xs font-medium text-emerald-700 hover:underline">Schedule</button>
                )}
                {p.status === 'failed' && (
                  <button onClick={() => void patchPost(p.id, { status: 'scheduled', post_error: null })} className="text-xs font-medium text-emerald-700 hover:underline">Retry</button>
                )}
                {p.status !== 'posted' && (
                  <button onClick={() => void delPost(p)} className="text-xs text-slate-400 hover:text-rose-600">delete</button>
                )}
              </span>
            </li>
          ))}
          {upcoming.length === 0 && <li className="text-sm text-slate-400">Nothing here yet — schedule your first post above.</li>}
        </ul>
      </div>

      {/* ----- klaviyo blasts ----- */}
      <div className="card mb-6 p-3 sm:p-4">
        <p className="mb-1 text-sm font-semibold">Email blasts (Klaviyo)</p>
        <p className="mb-3 text-xs text-slate-500">
          Queueing a blast builds a Klaviyo list from the CRM segment (emails only, excludes banned/hidden/staff).
          You then fire the campaign from Klaviyo itself — that keeps unsubscribe handling compliant. Holds until
          KLAVIYO_API_KEY is in the PC .env.
        </p>
        <div className="mb-2 grid gap-2 sm:grid-cols-3">
          <label className="field-label">blast name
            <input value={kName} onChange={(e) => setKName(e.target.value)} placeholder="e.g. July deepstack promo" className="input" />
          </label>
          <label className="field-label">subject (for your reference)
            <input value={kSubject} onChange={(e) => setKSubject(e.target.value)} className="input" />
          </label>
          <label className="field-label">segment
            <select value={kSegment} onChange={(e) => setKSegment(e.target.value)} className="input">
              <option value="everyone">everyone</option>
              <option value="cash">cash players</option>
              <option value="tourney">tourney players</option>
              {VENUES.map((v) => <option key={v} value={`venue:${v}`}>venue: {v}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-end gap-2">
          <label className="field-label flex-1">notes / body draft (optional)
            <textarea value={kBody} onChange={(e) => setKBody(e.target.value)} rows={2} className="input" />
          </label>
          <button onClick={() => void createPush()} disabled={busy} className="btn-primary shrink-0">Create</button>
        </div>
        <ul className="mt-3 space-y-2">
          {pushes.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2">
              <span className={`chip ${
                k.status === 'ready' ? 'bg-emerald-100 text-emerald-700'
                : k.status === 'queued' ? 'bg-sky-100 text-sky-700'
                : k.status === 'failed' ? 'bg-rose-100 text-rose-700'
                : 'bg-amber-100 text-amber-700'
              }`}>{k.status}</span>
              <span className="text-sm font-medium">{k.name}</span>
              <span className="chip bg-slate-100 text-slate-500">{k.segment}</span>
              {k.status === 'ready' && k.stats?.emails != null && (
                <span className="text-xs text-emerald-700">{k.stats.emails} email(s) in Klaviyo — fire the campaign there</span>
              )}
              {k.status === 'queued' && <span className="text-xs text-slate-400">building on next sync…</span>}
              {k.push_error && <span className="w-full text-xs text-rose-600">⚠ {k.push_error}</span>}
              <span className="ml-auto flex gap-2">
                {k.status === 'draft' && (
                  <button onClick={() => void patchPush(k.id, { status: 'queued' })} className="text-xs font-medium text-emerald-700 hover:underline">Queue</button>
                )}
                {k.status === 'failed' && (
                  <button onClick={() => void patchPush(k.id, { status: 'queued', push_error: null })} className="text-xs font-medium text-emerald-700 hover:underline">Re-queue</button>
                )}
                {k.status !== 'ready' && (
                  <button onClick={() => void delPush(k)} className="text-xs text-slate-400 hover:text-rose-600">delete</button>
                )}
              </span>
            </li>
          ))}
          {pushes.length === 0 && <li className="text-sm text-slate-400">No blasts yet.</li>}
        </ul>
      </div>
    </div>
  )
}
