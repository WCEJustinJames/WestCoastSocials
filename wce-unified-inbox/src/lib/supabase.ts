import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

// Browser client — uses the publishable/anon key. Read-only mirror view today.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient<Database>(url, anonKey)
