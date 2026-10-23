import { useEffect, useState } from 'react'
import { Home } from './ui/Home'
import { Inbox } from './ui/Inbox'
import { Batches } from './ui/Batches'
import { Receipts } from './ui/Receipts'
import { Players } from './ui/Players'
import { Lists } from './ui/Lists'
import { Schedules } from './ui/Schedules'
import { Analytics } from './ui/Analytics'
import { Transfers } from './ui/Transfers'
import { MergeReview } from './ui/MergeReview'
import { Drafts } from './ui/Drafts'
import { Confirmed } from './ui/Confirmed'
import { Recent } from './ui/Recent'
import { Social } from './ui/Social'
import { Venues } from './ui/Venues'
import { SendShelf } from './ui/SendShelf'
import { SignOut } from './ui/AuthGate'
import { BridgeAlarm } from './ui/BridgeAlarm'
import { useInboxSettings } from './ui/useInboxSettings'
import {
  IconBanknote,
  IconHome,
  IconInbox,
  IconMegaphone,
  IconSend,
  IconTrophy,
  IconUsers,
} from './ui/icons'

/* Two-level navigation (2026-08 redesign): six AREAS — Home, Messaging,
   Players, Games, Money, Marketing — each with task sub-tabs. Desktop gets
   header tabs; ≤880px gets a fixed bottom tab bar. Both drive the same state.
   Sub-tab choice is remembered per area while the app is open. */

type Area = 'home' | 'messaging' | 'players' | 'games' | 'money' | 'marketing'
type MsgSub = 'inbox' | 'batches' | 'drafts'
type PlayersSub = 'players' | 'lists' | 'venues' | 'merge'
type GamesSub = 'schedules' | 'confirmed' | 'recent'
type MoneySub = 'transfers' | 'receipts' | 'analytics'

const AREAS: { area: Area; label: string; mobileLabel: string; icon: (p: { size?: number }) => JSX.Element }[] = [
  { area: 'home', label: 'Home', mobileLabel: 'Home', icon: IconHome },
  { area: 'messaging', label: 'Messaging', mobileLabel: 'Messages', icon: IconInbox },
  { area: 'players', label: 'Players', mobileLabel: 'Players', icon: IconUsers },
  { area: 'games', label: 'Games', mobileLabel: 'Games', icon: IconTrophy },
  { area: 'money', label: 'Money', mobileLabel: 'Money', icon: IconBanknote },
  { area: 'marketing', label: 'Marketing', mobileLabel: 'Marketing', icon: IconMegaphone },
]

const SUBTITLES: Record<Area, string> = {
  home: 'Everything that needs you, in one pass.',
  messaging: 'Every channel through the Beeper bridge — inbox, batches and the approval queue.',
  players: 'The CRM behind every send.',
  games: 'Weekly schedules, RSVPs and results from the TD sheets.',
  money: 'Transfers, receipts and the numbers over time.',
  marketing: 'Club page posts, scheduled alongside player messaging.',
}

const AREA_TITLES: Record<Area, string> = {
  home: 'Home',
  messaging: 'Messaging',
  players: 'Players',
  games: 'Games',
  money: 'Money',
  marketing: 'Marketing',
}

function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: [T, string][]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {tabs.map(([id, label]) => (
        <button key={id} className="seg-btn" aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** Auto-reply rail status + pause/resume, on the Messaging sub-tab row.
    Pausing is the guarded direction: first tap arms, second commits. */
function RailStatus() {
  const { settings, loaded, update } = useInboxSettings()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  if (!loaded) return null
  const stopped = settings.sendsPaused
  const paused = settings.repliesPaused
  const label = stopped
    ? 'All sends STOPPED'
    : paused
      ? 'Auto-reply paused — outreach still runs'
      : 'Auto-reply on — drafts need your approval'
  const sqStyle = {
    background: stopped || paused ? 'var(--color-accent)' : 'var(--color-neutral-700)',
  }
  async function toggle() {
    if (!paused && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    await update({ repliesPaused: !paused })
  }
  return (
    <>
      <span className="inline-flex items-center gap-2 text-xs muted-70">
        <span className="sq" style={sqStyle} />
        {label}
      </span>
      <button className="btn btn-secondary !text-xs" onClick={() => void toggle()}>
        {armed ? 'Tap again to pause' : paused ? 'Resume auto-reply' : 'Pause auto-reply'}
      </button>
    </>
  )
}

export default function App() {
  const [area, setArea] = useState<Area>('home')
  const [msgSub, setMsgSub] = useState<MsgSub>('inbox')
  const [playersSub, setPlayersSub] = useState<PlayersSub>('players')
  const [gamesSub, setGamesSub] = useState<GamesSub>('schedules')
  const [moneySub, setMoneySub] = useState<MoneySub>('transfers')
  const [playersSearch, setPlayersSearch] = useState('')

  // Deep links. Home cards open the Players tab with a filter pre-applied…
  const [playersFilter, setPlayersFilter] = useState<string | null>(null)
  const goPlayers = (filter: string | null) => {
    setPlayersFilter(filter)
    setArea('players')
    setPlayersSub('players')
  }
  // …or a player's thread (nonce forces re-selection of the same id)…
  const [inboxConv, setInboxConv] = useState<{ id: string; nonce: number } | null>(null)
  const goInbox = (conversationId: string) => {
    setInboxConv((prev) => ({ id: conversationId, nonce: (prev?.nonce ?? 0) + 1 }))
    setArea('messaging')
    setMsgSub('inbox')
  }
  // …or the Batches composer with a venue list pre-loaded.
  const [batchesList, setBatchesList] = useState<{ id: string; nonce: number } | null>(null)
  const goBatches = (listId: string | null) => {
    if (listId) setBatchesList((prev) => ({ id: listId, nonce: (prev?.nonce ?? 0) + 1 }))
    setArea('messaging')
    setMsgSub('batches')
  }
  const goNewBatch = () => {
    setArea('messaging')
    setMsgSub('batches')
  }

  const screen = () => {
    if (area === 'home')
      return <Home onNavigate={goPlayers} onOpenConversation={goInbox} onFillSeats={goBatches} />
    if (area === 'messaging') {
      if (msgSub === 'inbox') return <Inbox openConversation={inboxConv} />
      if (msgSub === 'batches') return <Batches initialListId={batchesList} />
      return <Drafts />
    }
    if (area === 'players') {
      if (playersSub === 'players') return <Players initialFilter={playersFilter} search={playersSearch} />
      if (playersSub === 'lists') return <Lists onStartBatch={goBatches} />
      if (playersSub === 'venues') return <Venues />
      return <MergeReview />
    }
    if (area === 'games') {
      if (gamesSub === 'schedules') return <Schedules onMessageList={goBatches} />
      if (gamesSub === 'confirmed') return <Confirmed />
      return <Recent />
    }
    if (area === 'money') {
      if (moneySub === 'transfers') return <Transfers />
      if (moneySub === 'receipts') return <Receipts />
      return <Analytics />
    }
    return <Social />
  }

  const subTabRow = () => {
    if (area === 'messaging')
      return (
        <div data-subtabs className="mb-5 flex flex-wrap items-center gap-3">
          <SubTabs
            tabs={[['inbox', 'Inbox'], ['batches', 'Batches'], ['drafts', 'Drafts']]}
            value={msgSub}
            onChange={setMsgSub}
          />
          <div className="flex-1" />
          <RailStatus />
        </div>
      )
    if (area === 'players')
      return (
        <div data-subtabs className="mb-5 flex flex-wrap items-center gap-3">
          <SubTabs
            tabs={[['players', 'Players'], ['lists', 'Lists'], ['venues', 'Venues'], ['merge', 'Merge & review']]}
            value={playersSub}
            onChange={setPlayersSub}
          />
          <div className="flex-1" />
          {playersSub === 'players' && (
            <input
              type="search"
              className="input !w-[200px]"
              placeholder="Search players"
              value={playersSearch}
              onChange={(e) => setPlayersSearch(e.target.value)}
            />
          )}
        </div>
      )
    if (area === 'games')
      return (
        <div data-subtabs className="mb-5 flex flex-wrap items-center gap-3">
          <SubTabs
            tabs={[['schedules', 'Schedules'], ['confirmed', 'Confirmed'], ['recent', 'Recent']]}
            value={gamesSub}
            onChange={setGamesSub}
          />
        </div>
      )
    if (area === 'money')
      return (
        <div data-subtabs className="mb-5 flex flex-wrap items-center gap-3">
          <SubTabs
            tabs={[['transfers', 'Transfers'], ['receipts', 'Receipts'], ['analytics', 'Analytics']]}
            value={moneySub}
            onChange={setMoneySub}
          />
        </div>
      )
    return null
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* ————— sticky header ————— */}
      <nav
        aria-label="Main"
        className="sticky top-0 z-30 flex items-center gap-4 bg-paper px-4 py-3"
        style={{ borderBottom: '2px solid var(--color-divider)' }}
      >
        {/* The brand gives way first when the row gets tight — at 375px the
            actions must stay whole rather than the wordmark. */}
        <span className="flex min-w-0 items-center gap-2.5 text-lg font-extrabold" style={{ letterSpacing: '-0.015em' }}>
          <span className="inline-block h-3 w-3 flex-none" style={{ background: 'var(--color-accent)' }} />
          <span className="truncate">West Coast Poker</span>
          <span className="hidden whitespace-nowrap text-[11px] font-normal uppercase muted dt:inline" style={{ letterSpacing: '0.06em' }}>
            Unified inbox &amp; CRM
          </span>
        </span>
        <div className="hidden items-center gap-5 dt:flex">
          {AREAS.map(({ area: a, label }) => (
            <button
              key={a}
              onClick={() => setArea(a)}
              className="whitespace-nowrap border-0 bg-transparent py-1 text-sm"
              style={{ color: area === a ? 'var(--color-accent)' : 'var(--color-text)', cursor: 'pointer' }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Icon-only below 881px: at 375px the wordmark and a labelled CTA
            cannot both fit, and the brand wins. 44px touch target either way. */}
        <button
          className="btn btn-primary h-11 w-11 !px-0 dt:h-auto dt:w-auto dt:!px-3.5"
          onClick={goNewBatch}
          title="New batch"
          aria-label="New batch"
        >
          <IconSend />
          <span className="hidden dt:inline">New batch</span>
        </button>
        {/* At 375px the wordmark plus the primary action fills the bar exactly,
            so sign-out moves to the foot of the page rather than squeezing the
            brand. Desktop keeps it here. */}
        <span className="hidden dt:inline-flex">
          <SignOut />
        </span>
      </nav>

      {/* ————— page ————— */}
      <main
        className="mx-auto w-full max-w-[1240px] pb-32 pt-[26px] dt:pb-[72px]"
        style={{ paddingLeft: 'clamp(16px, 4vw, 48px)', paddingRight: 'clamp(16px, 4vw, 48px)' }}
      >
        <BridgeAlarm />
        <header className="mb-4">
          <h2 className="m-0 text-[25px]">{AREA_TITLES[area]}</h2>
          <p className="m-0 mt-1 text-[13px] muted">{SUBTITLES[area]}</p>
        </header>
        {subTabRow()}
        {screen()}
        <div className="mt-8 pt-4 dt:hidden" style={{ borderTop: '1px solid var(--color-divider)' }}>
          <SignOut />
        </div>
      </main>

      {/* ————— mobile bottom tab bar ————— */}
      <nav
        aria-label="Areas"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 bg-paper dt:hidden"
        style={{
          borderTop: '2px solid var(--color-divider)',
          padding: '6px 2px calc(8px + env(safe-area-inset-bottom))',
        }}
      >
        {AREAS.map(({ area: a, mobileLabel, icon: Icon }) => (
          <button
            key={a}
            onClick={() => setArea(a)}
            className="flex min-h-12 cursor-pointer flex-col items-start gap-[3px] border-0 bg-transparent py-2 pl-2"
            style={{ color: a === area ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-text) 55%, transparent)' }}
          >
            <Icon size={18} />
            <span className="text-[8.5px] uppercase" style={{ letterSpacing: '0.06em' }}>
              {mobileLabel}
            </span>
          </button>
        ))}
      </nav>

      <SendShelf />
    </div>
  )
}
