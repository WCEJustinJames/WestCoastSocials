import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

/**
 * Login gate. Nothing renders (and the app does no data work) until there's a
 * Supabase auth session. Paired with authenticated-only RLS, this keeps the
 * hosted app's data + controls off-limits to anyone who isn't signed in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) setError(error.message)
  }

  if (session === undefined) return null // still checking
  if (session) return <>{children}</>

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 p-4">
      <form onSubmit={signIn} className="w-full max-w-xs space-y-3 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-center text-lg font-semibold">West Coast Poker</div>
        <input
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          type="email"
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

/** Sign-out button for the nav. */
export function SignOut() {
  return (
    <button
      onClick={() => supabase.auth.signOut()}
      className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
      title="Sign out"
    >
      Sign out
    </button>
  )
}
