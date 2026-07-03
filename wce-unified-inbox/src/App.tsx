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
import { SendShelf } from './ui/SendShelf'
import { StopButton, RepliesToggle, RosterToggle } from './ui/StopButton'
import { SignOut } from './ui/AuthGate'

type View = 'home' | 'inbox' | 'batches' | 'drafts' | 'confirmed' | 'recent' | 'receipts' | 'players' | 'lists' | 'schedules' | 'analytics' | 'transfers' | 'merge'

export default function App() {
  const [view, setView] = useState<View>('home')
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
  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <nav className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5">
        <span className="mr-2 text-sm font-semibold">WCE Unified Inbox</span>
        <TabButton active={view === 'home'} onClick={() => setView('home')}>
          Home
        </TabButton>
        <TabButton active={view === 'inbox'} onClick={() => setView('inbox')}>
          Inbox
        </TabButton>
        <TabButton active={view === 'batches'} onClick={() => setView('batches')}>
          Batches
        </TabButton>
        <TabButton active={view === 'drafts'} onClick={() => setView('drafts')}>
          Drafts
        </TabButton>
        <TabButton active={view === 'confirmed'} onClick={() => setView('confirmed')}>
          Confirmed
        </TabButton>
        <TabButton active={view === 'recent'} onClick={() => setView('recent')}>
          Recent
        </TabButton>
        <TabButton active={view === 'receipts'} onClick={() => setView('receipts')}>
          Receipts
        </TabButton>
        <TabButton active={view === 'players'} onClick={() => goPlayers(null)}>
          Players
        </TabButton>
        <TabButton active={view === 'lists'} onClick={() => setView('lists')}>
          Lists
        </TabButton>
        <TabButton active={view === 'schedules'} onClick={() => setView('schedules')}>
          Schedules
        </TabButton>
        <TabButton active={view === 'analytics'} onClick={() => setView('analytics')}>
          Analytics
        </TabButton>
        <TabButton active={view === 'transfers'} onClick={() => setView('transfers')}>
          Transfers
        </TabButton>
        <TabButton active={view === 'merge'} onClick={() => setView('merge')}>
          Merge &amp; Review
        </TabButton>
        <div className="ml-auto flex items-center gap-2">
          <RepliesToggle />
          <RosterToggle />
          <StopButton />
          <SignOut />
        </div>
      </nav>
      <div className="min-h-0 flex-1">
        {view === 'home' ? (
          <Home onNavigate={goPlayers} onOpenConversation={goInbox} />
        ) : view === 'inbox' ? (
          <Inbox openConversation={inboxConv} />
        ) : view === 'batches' ? (
          <Batches />
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
        ) : view === 'schedules' ? (
          <Schedules />
        ) : view === 'analytics' ? (
          <Analytics />
        ) : view === 'transfers' ? (
          <Transfers />
        ) : (
          <MergeReview />
        )}
      </div>
      <SendShelf />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-sm ${
        active ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  )
}
