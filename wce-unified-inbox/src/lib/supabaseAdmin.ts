import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { env, requireEnv } from './env'

requireEnv(['supabaseUrl', 'supabaseServiceKey'])

// Server-side client for the sync/mirror. Uses the service role key (bypasses RLS).
// This must only ever run on your machine — never bundle it into the browser app.
//
// Every request is bounded (ENG-49): a call that is accepted and never
// answered must fail into the caller's error path, not hang the pass. 60 s,
// not the batch sender's 20 s, because the sheet and contact sweeps run
// large writes through this client.
const SUPABASE_TIMEOUT_MS = 60_000

export const supabaseAdmin = createClient<Database>(
  env.supabaseUrl,
  env.supabaseServiceKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }),
    },
  },
)
