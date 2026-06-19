import { useState } from 'react'
import { Inbox } from './ui/Inbox'
import { Batches } from './ui/Batches'
import { Receipts } from './ui/Receipts'
import { Players } from './ui/Players'
import { MergeReview } from './ui/MergeReview'
import { StopButton } from './ui/StopButton'
import { SignOut } from './ui/AuthGate'

type View = 'inbox' | 'batches' | 'receipts' | 'players' | 'merge'

export default function App() {
  const [view, setView] = useState<View>('inbox')
  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <nav className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5">
        <span className="mr-2 text-sm font-semibold">WCE Unified Inbox</span>
        <TabButton active={view === 'inbox'} onClick={() => setView('inbox')}>
          Inbox
        </TabButton>
        <TabButton active={view === 'batches'} onClick={() => setView('batches')}>
          Batches
        </TabButton>
        <TabButton active={view === 'receipts'} onClick={() => setView('receipts')}>
          Receipts
        </TabButton>
        <TabButton active={view === 'players'} onClick={() => setView('players')}>
          Players
        </TabButton>
        <TabButton active={view === 'merge'} onClick={() => setView('merge')}>
          Merge &amp; Review
        </TabButton>
        <div className="ml-auto flex items-center gap-2">
          <StopButton />
          <SignOut />
        </div>
      </nav>
      <div className="min-h-0 flex-1">
        {view === 'inbox' ? (
          <Inbox />
        ) : view === 'batches' ? (
          <Batches />
        ) : view === 'receipts' ? (
          <Receipts />
        ) : view === 'players' ? (
          <Players />
        ) : (
          <MergeReview />
        )}
      </div>
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
