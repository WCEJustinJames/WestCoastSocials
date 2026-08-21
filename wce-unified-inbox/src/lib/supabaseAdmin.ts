import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { env, requireEnv } from './env'

requireEnv(['supabaseUrl', 'supabaseServiceKey'])

// Server-side client for the sync/mirror. Uses the service role key (bypasses RLS).
// This must only ever run on your machine — never bundle it into the browser app.
export const supabaseAdmin = createClient<Database>(
  env.supabaseUrl,
  env.supabaseServiceKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
)
