import { useState } from 'react'
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
import { StopButton, RepliesToggle, RosterToggle } from './ui/StopButton'
import { SignOut } from './ui/AuthGate'
import { SyncStrip } from './ui/SyncStrip'

type View =
  | 'home' | 'inbox' | 'batches' | 'drafts' | 'confirmed' | 'recent' | 'receipts'
  | 'players' | 'lists' | 'venues' | 'schedules' | 'analytics' | 'transfers' | 'merge' | 'social'

// Grouped navigation: the sidebar (desktop) and drawer (phone) render from this.
const NAV: { group: string; items: { view: View; label: string; icon: string }[] }[] = [
  {
    group: 'Overview',
    items: [{ view: 'home', label: 'Home', icon: '🏠' }],
  },
  {
    group: 'Messaging',
    items: [
      { view: 'inbox', label: 'Inbox', icon: '💬' },
      { view: 'batches', label: 'Batches', icon: '📤' },
      { view: 'drafts', label: 'Drafts', icon: '📝' },
    ],
  },
  {
    group: 'Players',
    items: [
      { view: 'players', label: 'Players', icon: '👥' },
      { view: 'lists', label: 'Lists', icon: '📋' },
      { view: 'venues', label: 'Venues', icon: '📍' },
      { view: 'merge', label: 'Merge & Review', icon: '🔀' },
    ],
  },
  {
    group: 'Games',
    items: [
      { view: 'schedules', label: 'Schedules', icon: '📅' },
      { view: 'confirmed', label: 'Confirmed', icon: '✅' },
      { view: 'recent', label: 'Recent', icon: '🕘' },
    ],
  },
  {
    group: 'Money',
    items: [
      { view: 'transfers', label: 'Transfers', icon: '💸' },
      { view: 'receipts', label: 'Receipts', icon: '🧾' },
      { view: 'analytics', label: 'Analytics', icon: '📊' },
    ],
  },
  {
    group: 'Marketing',
    items: [{ view: 'social', label: 'Social', icon: '📣' }],
  },
]

const TITLES: Record<View, string> = Object.fromEntries(
  NAV.flatMap((g) => g.items.map((i) => [i.view, i.label])),
) as Record<View, string>

export default function App() {
  const [view, setView] = useState<View>('home')
  const [drawer, setDrawer] = useState(false)
  // Desktop sidebar collapse (icon rail). Remembered across reloads.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('wce_nav_collapsed') === '1' } catch { return false }
  })
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem('wce_nav_collapsed', c ? '0' : '1') } catch { /* ignore */ }
      return !c
    })
  }
  // A Home dashboard card can deep-link into the Players tab with a filter
  // pre-applied (e.g. the "No contact" card opens the no-contact list to work through).
  const [playersFilter, setPlayersFilter] = useState<string | null>(null)
  const goPlayers = (filter: string | null) => {
    setPlayersFilter(filter)
    setView('players')
  }
  // Home's "Who's out" panel can deep-link straight into a player's thread so you
  // can re-invite them. A nonce forces re-selection even if the same id is clicked.
  const [inboxConv, setInboxConv] = useState<{ id: string; nonce: number } | null>(null)
  const goInbox = (conversationId: string) => {
    setInboxConv((prev) => ({ id: conversationId, nonce: (prev?.nonce ?? 0) + 1 }))
    setView('inbox')
  }
  // Home's seat monitor deep-links into Batches with a venue list pre-loaded.
  const [batchesList, setBatchesList] = useState<{ id: string; nonce: number } | null>(null)
  const goBatches = (listId: string | null) => {
    if (listId) setBatchesList((prev) => ({ id: listId, nonce: (prev?.nonce ?? 0) + 1 }))
    setView('batches')
  }

  const nav = (v: View) => {
    if (v === 'players') setPlayersFilter(null)
    setView(v)
    setDrawer(false)
  }

  const sidebar = (mini: boolean) => (
    <>
      <div className={`flex items-center gap-2.5 border-b border-white/10 py-4 ${mini ? 'justify-center px-2' : 'px-4'}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500 text-base font-black text-slate-950">W</span>
        {!mini && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight text-white">West Coast Poker</p>
            <p className="text-[10px] text-slate-500">Unified inbox &amp; CRM</p>
          </div>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((g) => (
          <div key={g.group}>
            {mini ? (
              <div className="mx-2 mt-3 border-t border-white/10" />
            ) : (
              <p className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{g.group}</p>
            )}
            {g.items.map((i) => (
              <button
                key={i.view}
                onClick={() => nav(i.view)}
                title={mini ? i.label : undefined}
                className={`flex w-full items-center gap-2.5 rounded-lg py-2 text-sm transition-colors ${mini ? 'justify-center px-0' : 'px-3'} ${
                  view === i.view
                    ? 'bg-emerald-600 font-medium text-white shadow-sm'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                }`}
              >
                <span className="w-5 text-center text-base leading-none">{i.icon}</span>
                {!mini && i.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {/* collapse toggle — desktop only (hidden inside the phone drawer) */}
      <button
        onClick={toggleCollapsed}
        title={mini ? 'Expand the sidebar' : 'Collapse to icons'}
        className="hidden items-center justify-center gap-2 border-t border-white/10 py-2.5 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-200 md:flex"
      >
        {mini ? '»' : '« collapse'}
      </button>
    </>
  )

  return (
    <div className="flex h-screen bg-slate-100 text-slate-900">
      {/* desktop sidebar */}
      <aside className={`hidden shrink-0 flex-col bg-slate-950 transition-[width] duration-150 md:flex ${collapsed ? 'w-16' : 'w-56'}`}>
        {sidebar(collapsed)}
      </aside>

      {/* phone drawer — always full-width labels */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-950/60" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col bg-slate-950 shadow-2xl">
            {sidebar(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            className="rounded-lg px-2 py-1 text-lg leading-none text-slate-600 hover:bg-slate-100 md:hidden"
          >
            ☰
          </button>
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden rounded-lg px-2 py-1 text-base leading-none text-slate-500 hover:bg-slate-100 md:block"
          >
            {collapsed ? '☰' : '⇤'}
          </button>
          <h1 className="text-sm font-semibold">{TITLES[view]}</h1>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <RepliesToggle />
            <RosterToggle />
            <StopButton />
            <SignOut />
          </div>
        </header>
        <SyncStrip />
        <div className="min-h-0 flex-1">
          {view === 'home' ? (
            <Home onNavigate={goPlayers} onOpenConversation={goInbox} onFillSeats={goBatches} />
          ) : view === 'inbox' ? (
            <Inbox openConversation={inboxConv} />
          ) : view === 'batches' ? (
            <Batches initialListId={batchesList} />
          ) : view === 'drafts' ? (
            <Drafts />
          ) : view === 'confirmed' ? (
            <Confirmed />
          ) : view === 'recent' ? (
            <Recent />
          ) : view === 'receipts' ? (
            <Receipts />
          ) : view === 'players' ? (
            <Players initialFilter={playersFilter} />
          ) : view === 'lists' ? (
            <Lists />
          ) : view === 'venues' ? (
            <Venues />
          ) : view === 'schedules' ? (
            <Schedules />
          ) : view === 'analytics' ? (
            <Analytics />
          ) : view === 'transfers' ? (
            <Transfers />
          ) : view === 'social' ? (
            <Social />
          ) : (
            <MergeReview />
          )}
        </div>
        <SendShelf />
      </div>
    </div>
  )
}
