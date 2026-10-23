import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface Venue {
  name: string
  aliases: string[]
  active: boolean
  sort: number
}

/**
 * The list the app shipped with before venues became rows. It is the floor, not
 * the source: if the fetch fails we keep showing these rather than blanking
 * every venue picker in the app. A venue selector with nothing in it doesn't
 * read as "couldn't load" — it reads as "the club has no venues", and it breaks
 * eight screens at once.
 *
 * It does mean a failed read is quiet in the UI, so it is loud in the console.
 */
const FALLBACK = [
  'MCT', 'Gosnells', 'Woodvale', 'Bentley', 'Kenwick',
  'Kingsley', 'Leederville', 'Stirling', 'Planet Royale',
]

// One fetch shared by every mounted component. Eight screens import this; they
// should not each hit the database on mount.
let names: string[] = FALLBACK
let full: Venue[] = []
let started = false
const subs = new Set<() => void>()

async function fetchVenues(): Promise<void> {
  const { data, error } = await supabase
    .from('inbox_venues')
    .select('name, aliases, active, sort')
    .order('sort')
    .order('name')
  if (error || !data) {
    console.error('[venues] could not load venue list, using the built-in fallback:', error?.message)
    return
  }
  full = data as Venue[]
  names = full.filter((v) => v.active).map((v) => v.name)
  subs.forEach((f) => f())
}

/** Re-read after an edit, so every open picker updates without a refresh. */
export async function reloadVenues(): Promise<void> {
  await fetchVenues()
}

/** Active venue names, in display order. Safe to call from any component. */
export function useVenues(): string[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    subs.add(f)
    if (!started) {
      started = true
      void fetchVenues()
    }
    return () => { subs.delete(f) }
  }, [])
  return names
}

/** Full rows including aliases and inactive venues — for the manage screen. */
export function useVenueRows(): Venue[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    subs.add(f)
    if (!started) {
      started = true
      void fetchVenues()
    }
    return () => { subs.delete(f) }
  }, [])
  return full
}
