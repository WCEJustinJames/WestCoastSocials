import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useVenues } from './useVenues'
import { IconChevronLeft, IconChevronRight } from './icons'
import type { Database } from '../types/database'

type Post = Database['public']['Tables']['social_posts']['Row']
type Push = Database['public']['Tables']['klaviyo_pushes']['Row']
// LetsPoker calendar row (tournament_events) — the API-synced game schedule.
interface LpEvent { event_date: string; label: string; buy_in: string | null; excluded: boolean }

/** Trim LP's promo-heavy label to a short calendar caption. */
function shortLabel(label: string): string {
  const clean = label.replace(/\$[\d,]+\s*(gtd|entry)?/gi, '').replace(/\s+/g, ' ').replace(/[|]+/g, ' ').trim()
  return (clean || label).slice(0, 22)
}

// 'lp-banner' is a pseudo-channel: the post's artwork also becomes the live
// LetsPoker club cover (what players see in the app) at publish time.
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'threads', 'linkedin', 'x', 'lp-banner'] as const
const platformLabel = (p: string): string => (p === 'lp-banner' ? 'LP banner' : p)
const REPEATS = ['none', 'daily', 'weekly', 'fortnightly', 'monthly'] as const
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Local YYYY-MM-DD for a date (calendar cells + post chips must agree). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Status square colour for a post's calendar marker. */
function statusSquare(status: string): string {
  switch (status) {
    case 'scheduled': return 'var(--color-accent)'
    case 'posted': return 'var(--color-neutral-700)'
    case 'failed': return 'var(--color-accent-700)'
    default: return 'var(--color-neutral-400)' // draft
  }
}

/** Row status tag: scheduled/queued = accent tint, posted/sent/ready = neutral,
    draft = outline, failed = accent fill (bad news is accent + weight). */
function StatusTag({ status }: { status: string }) {
  if (status === 'failed') {
    return (
      <span className="tag text-[10px] uppercase" style={{ background: 'var(--color-accent-700)', color: 'var(--color-bg)' }}>
        failed
      </span>
    )
  }
  const cls =
    status === 'scheduled' || status === 'queued'
      ? 'tag-accent'
      : status === 'posted' || status === 'sent' || status === 'ready'
        ? 'tag-neutral'
        : 'tag-outline'
  return <span className={`tag ${cls} text-[10px] uppercase`}>{status}</span>
}

/** Toggle chip (platform picker) — accent fill when on, 7% ink tint on hover. */
function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className="cursor-pointer whitespace-nowrap text-xs hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]"
      style={{
        flex: 'none',
        padding: '5px 12px',
        border: '1px solid var(--color-divider)',
        background: on ? 'var(--color-accent)' : undefined,
        color: on ? 'var(--color-bg)' : 'var(--color-text)',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

/**
 * Social tab — the marketing arm. A month calendar of posts (published through
 * Postiz to the connected socials, artwork via Canva links), repeat rules so a
 * weekly game promo rolls itself forward, and the Klaviyo email-blast bones:
 * pick a CRM segment, queue it, and the sync builds the Klaviyo list — the
 * campaign itself fires from Klaviyo so unsubscribes stay compliant.
 */
export function Social() {
  const VENUES = useVenues()
  const [posts, setPosts] = useState<Post[]>([])
  const [pushes, setPushes] = useState<Push[]>([])
  const [lpEvents, setLpEvents] = useState<LpEvent[]>([])
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
    // The LetsPoker calendar (synced from LP via API, ~weekly ahead) — mirrored
    // onto the calendar as a read-only reference so posts line up with real games.
    const lp = supabase as unknown as {
      from: (t: string) => { select: (c: string) => { order: (col: string) => { limit: (n: number) => Promise<{ data: LpEvent[] | null }> } } }
    }
    const { data: le } = await lp.from('tournament_events').select('event_date, label, buy_in, excluded').order('event_date').limit(400)
    setLpEvents(((le as LpEvent[]) ?? []).filter((e) => !e.excluded))
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

  const lpByDay = useMemo(() => {
    const map = new Map<string, LpEvent[]>()
    for (const e of lpEvents) {
      if (!e.event_date) continue
      map.set(e.event_date, [...(map.get(e.event_date) ?? []), e])
    }
    return map
  }, [lpEvents])

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
    if (cPlatforms.includes('lp-banner') && !cAsset.trim()) return flash('LP banner needs an artwork link (direct .png/.jpg URL).')
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
  /** Approve the week in one sitting: every dated draft goes live on the calendar. */
  async function scheduleAllDrafts() {
    const drafts = posts.filter((p) => p.status === 'draft' && p.scheduled_at)
    if (!drafts.length) return
    setBusy(true)
    const { error } = await supabase
      .from('social_posts')
      .update({ status: 'scheduled' })
      .in('id', drafts.map((d) => d.id))
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    flash(`${drafts.length} draft(s) scheduled.`)
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
  const datedDrafts = posts.filter((p) => p.status === 'draft' && p.scheduled_at)
  const cellBorder = { borderRight: '1px solid var(--color-divider)', borderBottom: '1px solid var(--color-divider)' }

  return (
    <div className="max-w-[760px]">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <p className="m-0 min-w-[240px] flex-1 text-[13px] muted">
          Posts publish through Postiz to the connected socials at their scheduled time (they hold safely until
          POSTIZ_API_KEY is in the PC .env). Design artwork in Canva, paste the share/export link as the asset.
        </p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {status && (
        <p className="m-0 mb-3 text-[13px] font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
      )}

      {/* ----- calendar ----- */}
      <div className="section-head">
        <span className="kicker">Calendar</span>
        <span className="flex items-center gap-1">
          <button
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="btn btn-ghost btn-icon"
            aria-label="Previous month"
          >
            <IconChevronLeft />
          </button>
          <span className="text-[13px] font-semibold tnum">{monthLabel}</span>
          <button
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="btn btn-ghost btn-icon"
            aria-label="Next month"
          >
            <IconChevronRight />
          </button>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-7 text-center text-[10px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>
        {DOW.map((d) => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7" style={{ borderTop: '1px solid var(--color-divider)', borderLeft: '1px solid var(--color-divider)' }}>
        {weeks.flat().map((d) => {
          const k = dayKey(d)
          const inMonth = d.getMonth() === month.getMonth()
          const dayPosts = postsByDay.get(k) ?? []
          const dayGames = lpByDay.get(k) ?? []
          return (
            <button
              key={k}
              onClick={() => pickDay(d)}
              className="min-h-[3.5rem] cursor-pointer bg-transparent p-1 text-left align-top sm:min-h-[4.5rem]"
              style={{
                ...cellBorder,
                background:
                  k === todayKey
                    ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
                    : inMonth
                      ? 'transparent'
                      : 'var(--color-surface)',
                opacity: inMonth ? 1 : 0.5,
              }}
            >
              <span
                className={`text-[11px] tnum ${k === todayKey ? 'font-extrabold' : 'muted-45'}`}
                style={k === todayKey ? { color: 'var(--color-accent-700)' } : undefined}
              >
                {d.getDate()}
              </span>
              <div className="mt-0.5 space-y-0.5">
                {/* LetsPoker calendar (API) — read-only game reference (hollow square) */}
                {dayGames.slice(0, 2).map((g, gi) => (
                  <span
                    key={gi}
                    title={`LetsPoker: ${g.label}${g.buy_in ? ` ($${g.buy_in})` : ''}`}
                    className="flex items-center gap-1 text-[10px] muted-60"
                  >
                    <span className="sq-sm" style={{ border: '1px solid var(--color-neutral-600)' }} />
                    <span className="min-w-0 truncate">{shortLabel(g.label)}</span>
                  </span>
                ))}
                {dayPosts.slice(0, 2).map((p) => (
                  <span key={p.id} title={`${p.title} (${p.status})`} className="flex items-center gap-1 text-[10px]">
                    <span className="sq-sm" style={{ background: statusSquare(p.status) }} />
                    <span className="min-w-0 truncate">{p.title}</span>
                  </span>
                ))}
                {dayPosts.length + dayGames.length > 4 && (
                  <span className="block text-[10px] muted-45 tnum">+{dayPosts.length + dayGames.length - 4} more</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
      <p className="m-0 mt-2 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] muted">
        <span>Tap a day to point the composer at it.</span>
        <span className="flex items-center gap-1.5">
          <span className="sq-sm" style={{ border: '1px solid var(--color-neutral-600)' }} />
          LetsPoker game (live from API)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="sq-sm" style={{ background: 'var(--color-accent)' }} />
          scheduled post
        </span>
      </p>

      {/* ----- composer ----- */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">New post</span>
        </div>
        <div className="mt-3 grid gap-x-4 gap-y-2 dt:grid-cols-2">
          <div className="field">
            <label>
              title
              <input value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="e.g. Thursday $2/5 Woodvale" className="input" />
            </label>
          </div>
          <div className="field">
            <label>
              Canva / image link (optional)
              <input value={cAsset} onChange={(e) => setCAsset(e.target.value)} placeholder="paste the Canva export or image URL" className="input" />
            </label>
          </div>
        </div>
        <div className="field mt-2">
          <label>
            caption (this is what gets posted; the title is just the calendar label)
            <textarea value={cBody} onChange={(e) => setCBody(e.target.value)} rows={3} className="input" placeholder="What goes under the artwork" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs muted-70">platforms</span>
          {PLATFORMS.map((pl) => {
            const on = cPlatforms.includes(pl)
            return (
              <Chip
                key={pl}
                on={on}
                title={pl === 'lp-banner' ? 'Also set this post’s artwork as the live LetsPoker app club cover' : undefined}
                onClick={() => setCPlatforms((prev) => on ? prev.filter((x) => x !== pl) : [...prev, pl])}
              >
                {platformLabel(pl)}
              </Chip>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="field">
            <label>
              date
              <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} className="input tnum" />
            </label>
          </div>
          <div className="field">
            <label>
              time
              <input type="time" value={cTime} onChange={(e) => setCTime(e.target.value)} className="input !w-28 tnum" />
            </label>
          </div>
          <div className="field">
            <label>
              repeat
              <select value={cRepeat} onChange={(e) => setCRepeat(e.target.value as (typeof REPEATS)[number])} className="input">
                {REPEATS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
          {cRepeat !== 'none' && (
            <div className="field">
              <label>
                until (optional)
                <input type="date" value={cUntil} onChange={(e) => setCUntil(e.target.value)} className="input tnum" />
              </label>
            </div>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={() => void savePost(true)} disabled={busy} className="btn btn-secondary text-[13px]">Save draft</button>
            <button onClick={() => void savePost(false)} disabled={busy} className="btn btn-primary text-[13px]">Schedule</button>
          </div>
        </div>
      </div>

      {/* ----- upcoming / recent posts ----- */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">Posts</span>
          <span className="flex flex-wrap items-center gap-3">
            {datedDrafts.length > 0 && (
              <button
                onClick={() => void scheduleAllDrafts()}
                disabled={busy}
                className="btn btn-secondary !text-xs tnum"
                title="Approve every dated draft (incl. this week's autopilot promos) in one go"
              >
                Schedule all drafts ({datedDrafts.length})
              </button>
            )}
            <label className="flex items-center gap-1.5 text-xs muted">
              <input type="checkbox" className="checkbox" checked={showPosted} onChange={(e) => setShowPosted(e.target.checked)} />
              show posted
            </label>
          </span>
        </div>
        <ul className="m-0 list-none p-0">
          {upcoming.map((p) => (
            <li key={p.id} className="row grid grid-cols-[96px_minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3">
              <span className="text-xs muted-60 tnum">
                {p.scheduled_at ? (
                  <>
                    <span className="block">
                      {new Date(p.scheduled_at).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                    <span className="block">
                      {new Date(p.scheduled_at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <div className="min-w-0">
                <div className="whitespace-pre-wrap text-sm" style={{ lineHeight: 1.45 }}>
                  {p.body
                    ? p.status === 'draft'
                      ? p.body
                      : `${p.body.slice(0, 120)}${p.body.length > 120 ? '…' : ''}`
                    : p.title}
                </div>
                <div className="mt-0.5 text-[11px] muted-50 tnum">
                  {p.body ? `${p.title} · ` : ''}
                  {p.source === 'autopilot' ? 'auto · ' : ''}
                  {p.repeat_rule !== 'none' ? `repeats ${p.repeat_rule}${p.repeat_until ? ` until ${p.repeat_until}` : ''} · ` : ''}
                  {p.platforms.map(platformLabel).join(' · ')}
                  {p.asset_url && (
                    <>
                      {' · '}
                      <a href={p.asset_url} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-accent-700)' }}>
                        artwork
                      </a>
                    </>
                  )}
                </div>
                {p.post_error && (
                  <div className="mt-0.5 text-xs font-semibold" style={{ color: 'var(--color-accent-700)' }}>
                    Failed: {p.post_error}
                  </div>
                )}
              </div>
              <span className="flex flex-col items-end gap-1">
                <StatusTag status={p.status} />
                {p.status === 'draft' && p.scheduled_at && (
                  <button onClick={() => void patchPost(p.id, { status: 'scheduled' })} className="btn-quiet">Schedule</button>
                )}
                {p.status === 'failed' && (
                  <button onClick={() => void patchPost(p.id, { status: 'scheduled', post_error: null })} className="btn-quiet">Retry</button>
                )}
                {p.status !== 'posted' && (
                  <button onClick={() => void delPost(p)} className="btn-quiet">delete</button>
                )}
              </span>
            </li>
          ))}
          {upcoming.length === 0 && (
            <li className="row py-3 text-[13px] muted">Nothing here yet — schedule your first post above.</li>
          )}
        </ul>
        <p className="m-0 mt-3 text-xs muted">
          Club page posts — scheduled alongside player messaging so matchday content and invites land together.
        </p>
      </div>

      {/* ----- klaviyo blasts ----- */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">Email blasts (Klaviyo)</span>
        </div>
        <p className="m-0 mt-2 text-xs muted">
          Queueing a blast builds a Klaviyo list from the CRM segment (emails only, excludes banned/hidden/staff).
          You then fire the campaign from Klaviyo itself — that keeps unsubscribe handling compliant. Holds until
          KLAVIYO_API_KEY is in the PC .env.
        </p>
        <div className="mt-3 grid gap-x-4 gap-y-2 dt:grid-cols-3">
          <div className="field">
            <label>
              blast name
              <input value={kName} onChange={(e) => setKName(e.target.value)} placeholder="e.g. July deepstack promo" className="input" />
            </label>
          </div>
          <div className="field">
            <label>
              subject (for your reference)
              <input value={kSubject} onChange={(e) => setKSubject(e.target.value)} className="input" />
            </label>
          </div>
          <div className="field">
            <label>
              segment
              <select value={kSegment} onChange={(e) => setKSegment(e.target.value)} className="input">
                <option value="everyone">everyone</option>
                <option value="cash">cash players</option>
                <option value="tourney">tourney players</option>
                {VENUES.map((v) => <option key={v} value={`venue:${v}`}>venue: {v}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="field min-w-[240px] flex-1">
            <label>
              notes / body draft (optional)
              <textarea value={kBody} onChange={(e) => setKBody(e.target.value)} rows={2} className="input" />
            </label>
          </div>
          <button onClick={() => void createPush()} disabled={busy} className="btn btn-secondary text-[13px]">Create</button>
        </div>
        <ul className="m-0 mt-4 list-none p-0" style={{ borderTop: '1px solid var(--color-divider)' }}>
          {pushes.map((k) => (
            <li key={k.id} className="row grid grid-cols-[96px_minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3">
              <span className="text-xs muted-60 tnum">
                {new Date(k.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold">{k.name}</div>
                <div className="mt-0.5 text-[11px] muted-50 tnum">
                  {k.segment}
                  {k.status === 'ready' && k.stats?.emails != null && ` · ${k.stats.emails} email(s) in Klaviyo — fire the campaign there`}
                  {k.status === 'queued' && ' · building on next sync…'}
                </div>
                {k.push_error && (
                  <div className="mt-0.5 text-xs font-semibold" style={{ color: 'var(--color-accent-700)' }}>
                    Failed: {k.push_error}
                  </div>
                )}
              </div>
              <span className="flex flex-col items-end gap-1">
                <StatusTag status={k.status} />
                {k.status === 'draft' && (
                  <button onClick={() => void patchPush(k.id, { status: 'queued' })} className="btn-quiet">Queue</button>
                )}
                {k.status === 'failed' && (
                  <button onClick={() => void patchPush(k.id, { status: 'queued', push_error: null })} className="btn-quiet">Re-queue</button>
                )}
                {k.status !== 'ready' && (
                  <button onClick={() => void delPush(k)} className="btn-quiet">delete</button>
                )}
              </span>
            </li>
          ))}
          {pushes.length === 0 && <li className="row py-3 text-[13px] muted">No blasts yet.</li>}
        </ul>
      </div>
    </div>
  )
}
