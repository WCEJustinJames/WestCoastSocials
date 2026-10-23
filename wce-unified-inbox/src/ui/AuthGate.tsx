import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

/**
 * Login gate. Nothing renders (and the app does no data work) until there's a
 * Supabase auth session that is actually allowed to read.
 *
 * The second part matters more than it sounds. Every inbox table is behind
 * `staff_all: wcp_is_active_staff()`, and that function requires `aal2` for any
 * account with a verified authenticator — so a password-only session is a valid
 * session that can read nothing. This gate used to render the app on any
 * session at all, which produced a dashboard that looked signed in while every
 * query came back empty: the Live strip read "no signal" across all five
 * integrations while the database was seconds-fresh. A permissions failure is
 * not an outage, and it must not be dressed as one.
 *
 * So the gate holds at the code step until the session reaches the assurance
 * level the policies actually demand.
 */

type Stage = 'checking' | 'password' | 'code' | 'ready'

export function AuthGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** Where a session stands against what the RLS policies require. */
  const resolveStage = useCallback(async (session: Session | null): Promise<Stage> => {
    if (!session) return 'password'
    const { data, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    // Fail closed to the code step rather than into an app that cannot read:
    // rendering children on an unknown level is how the silent-empty state
    // happened in the first place.
    if (aalErr) return 'code'
    return data?.nextLevel && data.nextLevel !== data.currentLevel ? 'code' : 'ready'
  }, [])

  useEffect(() => {
    let cancelled = false
    void supabase.auth.getSession().then(async ({ data }) => {
      const s = await resolveStage(data.session)
      if (!cancelled) setStage(s)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      void resolveStage(session).then((s) => { if (!cancelled) setStage(s) })
    })
    return () => { cancelled = true; sub.subscription.unsubscribe() }
  }, [resolveStage])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data, error: signInErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (signInErr) {
      setBusy(false)
      setError(signInErr.message)
      return
    }
    setStage(await resolveStage(data.session))
    setBusy(false)
    setPassword('')
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors()
    if (listErr) {
      setBusy(false)
      setError(listErr.message)
      return
    }
    const totp = factors?.totp?.find((f) => f.status === 'verified') ?? factors?.totp?.[0]
    if (!totp) {
      setBusy(false)
      setError('No authenticator is enrolled on this account. Ask an admin to set one up.')
      return
    }
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId: totp.id,
      code: code.trim(),
    })
    setBusy(false)
    if (verifyErr) {
      setError(verifyErr.message)
      setCode('')
      return
    }
    setCode('')
    setStage(await resolveStage((await supabase.auth.getSession()).data.session))
  }

  if (stage === 'checking') return null
  if (stage === 'ready') return <>{children}</>

  const shell = (inner: ReactNode) => (
    <div className="flex h-screen items-center justify-center bg-paper p-4">
      <form
        onSubmit={stage === 'code' ? submitCode : signIn}
        className="w-full max-w-xs space-y-3 border-t-2 border-divider bg-surface p-6"
      >
        <div className="flex items-center gap-2.5 text-lg font-extrabold" style={{ letterSpacing: '-0.015em' }}>
          <span className="inline-block h-3 w-3 flex-none" style={{ background: 'var(--color-accent)' }} />
          West Coast Poker
        </div>
        <div className="kicker">Unified inbox &amp; CRM</div>
        {inner}
        {error && <div className="text-sm font-semibold" style={{ color: 'var(--color-accent-700)' }}>{error}</div>}
        <button type="submit" disabled={busy} className="btn btn-primary w-full">
          {busy ? (stage === 'code' ? 'Checking…' : 'Signing in…') : stage === 'code' ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </div>
  )

  if (stage === 'code') {
    return shell(
      <>
        <p className="text-xs muted">
          Enter the 6-digit code from your authenticator app. The inbox can&rsquo;t read anything
          until this step is done.
        </p>
        <input
          className="input text-center !text-lg tracking-[0.3em] tnum"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        <button
          type="button"
          onClick={() => { void supabase.auth.signOut(); setStage('password') }}
          className="btn-quiet w-full text-left"
        >
          Sign in as someone else
        </button>
      </>,
    )
  }

  return shell(
    <>
      <input
        className="input"
        type="email"
        placeholder="Email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="input"
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </>,
  )
}

/** Sign-out button for the nav. */
export function SignOut() {
  return (
    <button onClick={() => supabase.auth.signOut()} className="btn-quiet" title="Sign out">
      Sign out
    </button>
  )
}
