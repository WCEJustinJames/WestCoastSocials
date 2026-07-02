import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fileToBase64, type PickedImage } from '../lib/attachment'
import { sourceLabel } from './usePlayers'
import type { Database, Json } from '../types/database'

type ConvRow = Database['public']['Tables']['inbox_conversations']['Row'] & {
  inbox_people: { display_name: string | null; last_outbound_at: string | null } | null
}
type OutreachRow = Database['public']['Tables']['inbox_outreach']['Row']
type ItemRow = Database['public']['Tables']['inbox_batch_items']['Row']
type Source = 'inbox' | 'crm'

const GUARD_WINDOW_MS = 24 * 60 * 60 * 1000

/** A recipient, normalised from either source so the rest of the flow is shared. */
interface Recipient {
  key: string
  name: string
  sub: string
  sendable: boolean
  guard: boolean
  guardReason: string | null
  badge: string | null
  hidden: boolean
  personId: string | null
  nickname?: string | null
  whale?: boolean
  data: Json
}

function fill(template: string, name: string, nickname?: string | null): string {
  const nick = (nickname ?? '').trim()
  const first = nick || (name.trim().split(/\s+/)[0] ?? '')
  // Tolerant of spaces/underscores: {{first name}}, {{first_name}}, {{firstname}}.
  return template
    .replace(/\{\{\s*first[\s_]*name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, name)
}

function messagedRecently(iso: string | null): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() < GUARD_WINDOW_MS
}

export function Batches() {
  const [source, setSource] = useState<Source>('inbox')
  const [conversations, setConversations] = useState<ConvRow[]>([])
  const [outreach, setOutreach] = useState<OutreachRow[]>([])
  // Per-player send signals (last-messaged date + venue, and the unanswered-
  // outreach count that drives the 👻 ghost), keyed by outreach id. Precomputed
  // server-side in the inbox_outreach_signals view.
  type SignalRow = {
    outreach_id: string
    last_sent_at: string | null
    last_venue: string | null
    unanswered_outreach: number
  }
  const [signals, setSignals] = useState<Map<string, SignalRow>>(new Map())

  // filters
  const [network, setNetwork] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [region, setRegion] = useState('all')
  const [stake, setStake] = useState('all')
  const [venue, setVenue] = useState('all')
  const [activity, setActivity] = useState('all')
  const [recipientQuery, setRecipientQuery] = useState('')
  // Which channel to contact CRM players on when more than one is available.
  const [channel, setChannel] = useState<'auto' | 'sms' | 'thread'>('auto')
  const [showHidden, setShowHidden] = useState(false)
  // weekly contact-slot filters + scheduled send time
  const [cDay, setCDay] = useState('all')
  const [cWindow, setCWindow] = useState('all')
  const [scheduleAt, setScheduleAt] = useState('')

  const [picked, setPicked] = useState<Map<string, Recipient>>(new Map())
  // Recipients to auto-pick once a reused list's rows load for the active source.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('')
  const [attachImg, setAttachImg] = useState<PickedImage | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // preview phase
  const [batchId, setBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<ItemRow[]>([])
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  // Preview "why won't it send" filter — 'all' or a specific reason bucket.
  const [previewFilter, setPreviewFilter] = useState<string>('all')
  // previously-built batches you can reload the recipient list from
  const [pastBatches, setPastBatches] = useState<
    { id: string; name: string; status: string; created_at: string; venue: string | null }[]
  >([])
  // standing venue lists (Lists tab) you can load straight into the recipient picker
  const [venueLists, setVenueLists] = useState<
    { id: string; name: string; venue: string | null; game_type: string | null }[]
  >([])
  // draft batches the recurring scheduler built, awaiting your approval
  const [scheduledDrafts, setScheduledDrafts] = useState<
    { id: string; name: string; venue: string | null; created_at: string }[]
  >([])
  // tonight's games (from the schedules) with their resolved venue list, for one-tap targeting
  const [tonight, setTonight] = useState<{ venue: string; name: string; listId: string | null }[]>([])
  // AI-written invite options for the chosen venue (from the sync), to pick into the template
  const [inviteVariants, setInviteVariants] = useState<{ id: string; body: string }[]>([])
  // venue / weekly game this batch is tagged with (for recurring per-venue lists)
  const [batchVenue, setBatchVenue] = useState('')
  // per-recipient name/phone corrections made in the preview
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({})
  const [phoneEdits, setPhoneEdits] = useState<Record<string, string>>({})
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  // double-click / right-click inline edit of a CRM recipient's name + number
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editNick, setEditNick] = useState('')
  // auto-hide unreachable (no phone/thread) recipients from the picker
  const [showUnavailable, setShowUnavailable] = useState(false)
  // when on, {{first_name}} renders each player's nickname (where one is set)
  const [useNickname, setUseNickname] = useState(false)

  useEffect(() => {
    let q = supabase
      .from('inbox_conversations')
      .select('*, inbox_people(display_name, last_outbound_at)')
      .order('last_activity', { ascending: false, nullsFirst: false })
    if (!showHidden) q = q.eq('hidden', false)
    q.then(({ data }) => setConversations((data as unknown as ConvRow[]) ?? []))
  }, [showHidden])

  useEffect(() => {
    // Page through the whole CRM — PostgREST caps a single response at 1000
    // rows, and there are more players than that, so a plain select() silently
    // drops everyone past the first 1000 (names from the back of the alphabet).
    ;(async () => {
      const all: OutreachRow[] = []
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from('inbox_outreach')
          .select('*')
          .eq('do_not_message', false)
          .order('player_name', { ascending: true })
          .range(from, from + PAGE - 1)
        if (!showHidden) q = q.eq('hidden', false)
        const { data } = await q
        const rows = (data as OutreachRow[]) ?? []
        all.push(...rows)
        if (rows.length < PAGE) break
      }
      setOutreach(all)
    })()
  }, [source, showHidden])

  // Load per-player send signals once (only the ~135 messaged players carry one,
  // well under the 1k row cap, so a single filtered fetch is enough).
  useEffect(() => {
    const v = supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          not: (col: string, op: string, val: unknown) => Promise<{ data: SignalRow[] | null }>
        }
      }
    }
    v.from('inbox_outreach_signals')
      .select('outreach_id, last_sent_at, last_venue, unanswered_outreach')
      .not('last_sent_at', 'is', null)
      .then(({ data }) => {
        const m = new Map<string, SignalRow>()
        for (const s of data ?? []) m.set(s.outreach_id, s)
        setSignals(m)
      })
  }, [])

  async function toggleHide(key: string, currentlyHidden: boolean) {
    const table = source === 'inbox' ? 'inbox_conversations' : 'inbox_outreach'
    const next = !currentlyHidden
    await supabase.from(table).update({ hidden: next }).eq('id', key)
    const apply = <T extends { id: string; hidden: boolean }>(arr: T[]): T[] =>
      arr.map((x) => (x.id === key ? { ...x, hidden: next } : x)).filter((x) => showHidden || !x.hidden)
    if (source === 'inbox') setConversations((p) => apply(p as unknown as { id: string; hidden: boolean }[]) as unknown as ConvRow[])
    else setOutreach((p) => apply(p))
  }

  // Distinct filter values from the CRM.
  const regions = useMemo(
    () => Array.from(new Set(outreach.map((o) => o.region).filter(Boolean) as string[])).sort(),
    [outreach],
  )
  const stakesOpts = useMemo(
    () => Array.from(new Set(outreach.flatMap((o) => o.stakes ?? []))).sort(),
    [outreach],
  )
  const venuesOpts = useMemo(
    () => Array.from(new Set(outreach.flatMap((o) => o.venues ?? []))).sort(),
    [outreach],
  )
  // Most common home venue among the currently-picked recipients — used to
  // auto-tag the batch when you leave the venue blank, so "last messaged for
  // {venue}" always populates. CRM picks only (inbox picks have no home venue).
  const suggestedVenue = useMemo(() => {
    if (source !== 'crm') return ''
    const counts = new Map<string, number>()
    for (const key of picked.keys()) {
      const o = outreach.find((x) => x.id === key)
      for (const v of o?.venues ?? []) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    let best = ''
    let n = 0
    for (const [v, c] of counts) if (c > n) { best = v; n = c }
    return best
  }, [picked, outreach, source])
  // Venue / weekly-game labels you can tag a batch with: every venue seen on a
  // player plus any venue already used on a previous batch (so recurring weekly
  // games stay pickable even if no current recipient lists them).
  const batchVenuesOpts = useMemo(
    () =>
      Array.from(
        new Set([
          ...venuesOpts,
          ...pastBatches.map((b) => b.venue?.trim()).filter(Boolean) as string[],
        ]),
      ).sort(),
    [venuesOpts, pastBatches],
  )
  const activities = useMemo(
    () => Array.from(new Set(outreach.map((o) => o.activity).filter(Boolean) as string[])).sort(),
    [outreach],
  )
  const sourcesOpts = useMemo(
    () => Array.from(new Set(outreach.map((o) => sourceLabel(o)))).sort(),
    [outreach],
  )
  const networks = useMemo(
    () => Array.from(new Set(conversations.map((c) => c.network))).sort(),
    [conversations],
  )

  // Normalise the active source into a single recipient list, then filter.
  const recipients = useMemo<Recipient[]>(() => {
    const q = recipientQuery.trim().toLowerCase()
    if (source === 'inbox') {
      return conversations
        .map<Recipient>((c) => {
          const nm = c.inbox_people?.display_name ?? c.title ?? c.external_chat_id
          const guarded = messagedRecently(c.inbox_people?.last_outbound_at ?? null)
          return {
            key: c.id,
            name: nm,
            sub: c.network,
            sendable: true,
            guard: guarded,
            guardReason: guarded ? 'Messaged in the last 24h' : null,
            badge: guarded ? 'recent' : null,
            hidden: c.hidden,
            personId: c.person_id,
            data: { conversation_id: c.id, name: nm, network: c.network },
          }
        })
        .filter((r) => {
          if (network !== 'all' && r.sub !== network) return false
          if (q && !r.name.toLowerCase().includes(q)) return false
          return true
        })
    }
    return outreach
      .map<Recipient>((o) => {
        const nm = o.player_name || [o.first_name, o.last_name].filter(Boolean).join(' ') || '—'
        const hasThread = !!o.beeper_chat_id
        const hasPhone = !!o.phone
        // Resolve which channel this batch will use for this player. In "auto"
        // we default to their thread (Messenger/FB) — unless they've been toggled
        // to prefer SMS and we actually have a number for them.
        const useThread =
          channel === 'thread' ||
          (channel === 'auto' && hasThread && !(o.preferred_channel === 'sms' && hasPhone))
        const sendable =
          channel === 'thread' ? hasThread : channel === 'sms' ? hasPhone : hasThread || hasPhone
        const chosen: 'thread' | 'sms' = useThread ? 'thread' : 'sms'
        const newSms = chosen === 'sms' && !hasThread // cold SMS to someone with no thread
        const channels = [hasPhone && 'SMS', hasThread && 'thread'].filter(Boolean).join(' + ')
        return {
          key: o.id,
          name: nm,
          // A third of the CRM has only a first name on record (TD cash-sheet /
          // reservation captures never had a surname), so many rows read just
          // "Jack" — and they're DIFFERENT Jacks, each with their own number.
          // Show phone + venue so identical first names are tellable apart and
          // you can confirm the right person before sending.
          sub: [
            o.whale ? '🐋' : null,
            o.snooze_until && o.snooze_until >= new Date().toISOString().slice(0, 10) ? '❄ on ice' : null,
            o.phone, (o.venues ?? [])[0] ?? o.region,
          ].filter(Boolean).join(' · ') || '—',
          sendable,
          guard: newSms,
          guardReason: !sendable
            ? channel === 'thread'
              ? 'No existing thread'
              : channel === 'sms'
                ? 'No phone'
                : 'No phone or thread'
            : newSms
              ? 'Will start a NEW SMS chat'
              : null,
          badge: !sendable
            ? 'unavailable'
            : newSms
              ? 'new SMS'
              : channels || null,
          hidden: o.hidden,
          personId: null,
          nickname: o.nickname,
          whale: o.whale ?? false,
          data: {
            outreach_id: o.id,
            beeper_chat_id: o.beeper_chat_id,
            phone: o.phone,
            account_id: 'gmessages',
            channel: chosen,
            name: nm,
            region: o.region,
          },
        }
      })
      .filter((r) => {
        const o = outreach.find((x) => x.id === r.key)!
        if (region !== 'all') {
          const rg = (o.region ?? '').toLowerCase()
          // "All Areas" players always match any region search.
          if (!rg.includes('all area') && !rg.includes(region.toLowerCase())) return false
        }
        if (stake !== 'all' && !(o.stakes ?? []).includes(stake)) return false
        if (venue !== 'all' && !(o.venues ?? []).includes(venue)) return false
        if (activity !== 'all' && o.activity !== activity) return false
        if (sourceFilter !== 'all' && sourceLabel(o) !== sourceFilter) return false
        if (cDay !== 'all' && o.contact_day !== cDay) return false
        if (cWindow !== 'all' && o.contact_window !== cWindow) return false
        if (q && !r.name.toLowerCase().includes(q)) return false
        return true
      })
      // Whales float to the top of the picker (stable within each group).
      .sort((a, b) => Number(b.whale ?? false) - Number(a.whale ?? false))
  }, [source, conversations, outreach, network, region, stake, venue, activity, sourceFilter, recipientQuery, channel, cDay, cWindow])

  // When a reused list loads, pick its recipients once they appear for the now-
  // active source — so the picks survive the source switch (multi-source lists).
  useEffect(() => {
    if (pendingKeys.size === 0) return
    const add = recipients.filter((r) => pendingKeys.has(r.key))
    if (add.length === 0) return
    setPicked((prev) => {
      const m = new Map(prev)
      for (const r of add) m.set(r.key, r)
      return m
    })
    setPendingKeys((prev) => {
      const next = new Set(prev)
      for (const r of add) next.delete(r.key)
      return next
    })
  }, [recipients, pendingKeys])

  function switchSource(s: Source) {
    // Keep current picks — selecting across Inbox + CRM is the whole point.
    setSource(s)
  }

  // Inline edit (double-click / right-click) of a CRM recipient's name + number,
  // so a wrong or missing detail can be fixed without leaving the batch builder.
  function startEdit(r: Recipient) {
    if (source !== 'crm') return
    const o = outreach.find((x) => x.id === r.key)
    setEditKey(r.key)
    setEditName(o?.player_name ?? r.name)
    setEditPhone(o?.phone ?? '')
    setEditNick(o?.nickname ?? '')
  }
  async function saveEdit() {
    if (!editKey) return
    const name = editName.trim()
    const phone = editPhone.trim()
    const nickname = editNick.trim()
    await supabase
      .from('inbox_outreach')
      .update({ player_name: name || null, phone: phone || null, nickname: nickname || null })
      .eq('id', editKey)
    setOutreach((prev) =>
      prev.map((o) =>
        o.id === editKey ? { ...o, player_name: name || null, phone: phone || null, nickname: nickname || null } : o,
      ),
    )
    setEditKey(null)
  }

  // Ban a CRM recipient straight from the picker: flag do-not-message and drop
  // them from the list (and any current selection) so they can never be batched.
  async function banPlayer(r: Recipient) {
    if (source !== 'crm') return
    if (!window.confirm(`Ban ${r.name}? Flags do-not-message and drops them from every list.`)) return
    await supabase.from('inbox_outreach').update({ do_not_message: true }).eq('id', r.key)
    setOutreach((prev) => prev.filter((o) => o.id !== r.key))
    setPicked((prev) => {
      const m = new Map(prev)
      m.delete(r.key)
      return m
    })
  }

  function loadPastBatches() {
    supabase
      .from('inbox_batches')
      .select('id, name, status, created_at, venue')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setPastBatches((data as typeof pastBatches) ?? []))
  }
  useEffect(loadPastBatches, [])

  // Reload the recipients from a past batch into the current compose selection.
  async function loadList(id: string) {
    const { data } = await supabase.from('inbox_batch_items').select('data').eq('batch_id', id)
    const keys = new Set<string>()
    let isCrm = false
    for (const it of data ?? []) {
      const d = it.data as { outreach_id?: string; conversation_id?: string } | null
      if (d?.outreach_id) {
        keys.add(d.outreach_id)
        isCrm = true
      } else if (d?.conversation_id) {
        keys.add(d.conversation_id)
      }
    }
    setSource(isCrm ? 'crm' : 'inbox')
    setPendingKeys(keys)
    setStatus(`Loaded ${keys.size} recipients from that list — edit the template and Build preview.`)
    setTimeout(() => setStatus(null), 6000)
  }
  // Load the standing venue lists (Lists tab) for the recipient-source picker.
  useEffect(() => {
    supabase
      .from('inbox_lists')
      .select('id, name, venue, game_type')
      .order('venue', { nullsFirst: false })
      .order('name')
      .then(({ data }) => setVenueLists((data as typeof venueLists) ?? []))
  }, [])

  // Draft batches the recurring scheduler built (Schedules tab) and that are waiting
  // for approval. Loaded into the preview phase so you can review + Approve to send.
  function loadScheduledDrafts() {
    supabase
      .from('inbox_batches')
      .select('id, name, venue, created_at')
      .eq('status', 'draft')
      .eq('created_by', 'scheduler')
      .order('created_at', { ascending: false })
      .then(({ data }) => setScheduledDrafts((data as typeof scheduledDrafts) ?? []))
  }
  useEffect(loadScheduledDrafts, [])

  // Pre-game targeting: which venues run tonight (from the schedules) and the list to
  // load for each, so you can one-tap "message tonight's venue".
  useEffect(() => {
    const dow = new Date().getDay() // 0=Sun..6=Sat, matches Postgres extract(dow)
    supabase
      .from('inbox_schedules')
      .select('name, venue, game_type')
      .eq('active', true)
      .eq('day_of_week', dow)
      .then(async ({ data }) => {
        const scheds = (data as { name: string; venue: string | null; game_type: string }[]) ?? []
        const out: { venue: string; name: string; listId: string | null }[] = []
        for (const s of scheds) {
          if (!s.venue) continue
          // Match the venue list leniently (canonical 'Kenwick' -> 'Kenwick FC' etc); biggest first.
          const { data: ls } = await supabase
            .from('inbox_lists')
            .select('id')
            .ilike('venue', `%${s.venue}%`)
            .limit(1)
          out.push({ venue: s.venue, name: s.name, listId: (ls?.[0] as { id: string } | undefined)?.id ?? null })
        }
        setTonight(out)
      })
  }, [])

  // Fetch the AI-written invite options for the chosen venue (generated by the sync).
  useEffect(() => {
    const v = batchVenue.trim()
    if (!v) { setInviteVariants([]); return }
    supabase
      .from('inbox_invite_variants')
      .select('id, body')
      .eq('active', true)
      .ilike('venue', `%${v}%`)
      .order('created_at', { ascending: false })
      .limit(3)
      .then(({ data }) => setInviteVariants((data as { id: string; body: string }[]) ?? []))
  }, [batchVenue])

  // Open an existing batch (e.g. a scheduler draft) straight into the preview phase,
  // reusing the same review + Approve flow as a freshly-built batch.
  async function openBatch(id: string) {
    const { data: b } = await supabase.from('inbox_batches').select('*').eq('id', id).single()
    if (!b) return
    const batch = b as Database['public']['Tables']['inbox_batches']['Row']
    setName(batch.name)
    setTemplate(batch.template_body)
    setBatchVenue(batch.venue ?? '')
    const { data: created } = await supabase
      .from('inbox_batch_items')
      .select('*')
      .eq('batch_id', id)
      .order('guard_flag', { ascending: true })
    const list = (created as ItemRow[]) ?? []
    setItems(list)
    setInclude(Object.fromEntries(list.map((it) => [it.id, !it.guard_flag])))
    setEdits(Object.fromEntries(list.map((it) => [it.id, it.rendered_text])))
    setNameEdits(Object.fromEntries(list.map((it) => [it.id, ((it.data as { name?: string } | null)?.name ?? '')])))
    setPhoneEdits(Object.fromEntries(list.map((it) => [it.id, ((it.data as { phone?: string } | null)?.phone ?? '')])))
    setBatchId(id)
    setStatus('Opened scheduled draft — review and Approve to send.')
    setTimeout(() => setStatus(null), 6000)
  }

  // Load a standing list's members into the CRM recipient selection (same auto-pick
  // path as reusing a past batch). All send guards still apply downstream at build.
  async function loadVenueList(id: string) {
    const { data } = await supabase.from('inbox_list_members').select('outreach_id').eq('list_id', id)
    const keys = new Set<string>((data ?? []).map((m) => (m as { outreach_id: string }).outreach_id))
    const l = venueLists.find((x) => x.id === id)
    if (l?.venue && !batchVenue.trim()) setBatchVenue(l.venue)
    setSource('crm')
    setPendingKeys(keys)
    setStatus(`Loaded ${keys.size} from “${l?.name ?? 'list'}” — edit the template and Build preview.`)
    setTimeout(() => setStatus(null), 6000)
  }

  function toggle(r: Recipient) {
    setPicked((prev) => {
      const m = new Map(prev)
      m.has(r.key) ? m.delete(r.key) : m.set(r.key, r)
      return m
    })
  }
  function selectAllSendable() {
    setPicked((prev) => {
      const m = new Map(prev)
      for (const r of recipients.filter((x) => x.sendable)) m.set(r.key, r)
      return m
    })
  }
  function clearSelection() {
    setPicked(new Map())
  }

  async function buildPreview() {
    const chosen = Array.from(picked.values())
    if (!name.trim() || (!template.trim() && !attachImg) || chosen.length === 0) {
      setStatus('Add a name, a message or image, and at least one recipient.')
      return
    }
    setBusy(true)
    setStatus('Building preview…')

    const { data: batch, error: bErr } = await supabase
      .from('inbox_batches')
      .insert({
        name: name.trim(),
        template_body: template,
        status: 'draft',
        created_by: 'manual',
        venue: (batchVenue.trim() || suggestedVenue) || null,
        attachment_data: attachImg?.dataBase64 ?? null,
        attachment_name: attachImg?.name ?? null,
        attachment_mime: attachImg?.mime ?? null,
      })
      .select('id')
      .single()
    if (bErr || !batch) {
      setBusy(false)
      setStatus(`Error: ${bErr?.message ?? 'could not create batch'}`)
      return
    }

    const rows = chosen.map((r) => ({
      batch_id: batch.id,
      person_id: r.personId,
      rendered_text: fill(template, r.name, useNickname ? r.nickname : undefined),
      data: r.data,
      status: 'pending' as const,
      guard_flag: r.guard,
      guard_reason: r.guardReason,
    }))
    const { error: iErr } = await supabase.from('inbox_batch_items').insert(rows)
    if (iErr) {
      setBusy(false)
      setStatus(`Error: ${iErr.message}`)
      return
    }

    const { data: created } = await supabase
      .from('inbox_batch_items')
      .select('*')
      .eq('batch_id', batch.id)
      .order('guard_flag', { ascending: true })
    const list = (created as ItemRow[]) ?? []
    setItems(list)
    setInclude(Object.fromEntries(list.map((it) => [it.id, !it.guard_flag])))
    setEdits(Object.fromEntries(list.map((it) => [it.id, it.rendered_text])))
    setNameEdits(
      Object.fromEntries(
        list.map((it) => [it.id, ((it.data as { name?: string } | null)?.name ?? '')]),
      ),
    )
    setPhoneEdits(
      Object.fromEntries(
        list.map((it) => [it.id, ((it.data as { phone?: string } | null)?.phone ?? '')]),
      ),
    )
    setBatchId(batch.id)
    setBusy(false)
    setStatus(null)
  }

  const sendableItem = (it: ItemRow) => {
    const d = it.data as {
      conversation_id?: string
      beeper_chat_id?: string
      phone?: string
    } | null
    return !!(d?.beeper_chat_id || d?.conversation_id || d?.phone)
  }
  const includedCount = items.filter((it) => include[it.id] && sendableItem(it)).length

  // Why each contact will / won't send — drives the preview breakdown + filter.
  // 'Will send' for reachable, un-guarded rows; otherwise the guard reason
  // ("Will start a NEW SMS chat", "Messaged in the last 24h", "No phone or
  // thread", …) so you can see and isolate exactly why the rest are held back.
  const itemBucket = (it: ItemRow): string =>
    sendableItem(it) && !it.guard_flag
      ? 'Will send'
      : it.guard_reason || (sendableItem(it) ? 'Guarded' : 'Unreachable')
  const previewBuckets = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const b =
        sendableItem(it) && !it.guard_flag
          ? 'Will send'
          : it.guard_reason || (sendableItem(it) ? 'Guarded' : 'Unreachable')
      m.set(b, (m.get(b) ?? 0) + 1)
    }
    // 'Will send' first, then each held-back reason by descending count.
    return [...m.entries()].sort((a, b) =>
      a[0] === 'Will send' ? -1 : b[0] === 'Will send' ? 1 : b[1] - a[1],
    )
  }, [items])
  const shownItems =
    previewFilter === 'all' ? items : items.filter((it) => itemBucket(it) === previewFilter)

  async function approveSend() {
    if (!batchId || includedCount === 0) return
    setBusy(true)
    setStatus('Approving…')
    for (const it of items) {
      if (include[it.id] && sendableItem(it)) {
        const d = (it.data ?? {}) as Record<string, unknown> & { outreach_id?: string; name?: string; phone?: string }
        const newName = (nameEdits[it.id] ?? '').trim()
        const newPhone = (phoneEdits[it.id] ?? '').trim()
        // Corrected number/name flow into the send (and the CRM record below).
        const data = { ...d, name: newName || d.name, phone: newPhone || d.phone }
        await supabase
          .from('inbox_batch_items')
          .update({
            status: 'approved',
            rendered_text: edits[it.id] ?? it.rendered_text,
            data: data as Json,
          })
          .eq('id', it.id)
        // Persist name/number fixes back to the CRM player.
        if (d.outreach_id && (newName !== (d.name ?? '') || newPhone !== (d.phone ?? ''))) {
          await supabase
            .from('inbox_outreach')
            .update({
              ...(newName ? { player_name: newName } : {}),
              ...(newPhone ? { phone: newPhone } : {}),
            })
            .eq('id', d.outreach_id)
        }
      } else {
        await supabase.from('inbox_batch_items').update({ status: 'skipped' }).eq('id', it.id)
      }
    }
    const { error } = await supabase
      .from('inbox_batches')
      .update({
        status: 'approved',
        scheduled_for: scheduleAt ? new Date(scheduleAt).toISOString() : null,
      })
      .eq('id', batchId)
    setBusy(false)
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    const when = scheduleAt
      ? `scheduled for ${new Date(scheduleAt).toLocaleString()}`
      : 'send on the next sync'
    resetAll()
    setScheduleAt('')
    setStatus(`Approved ✓ — ${includedCount} message(s) ${when}, paced ~1.5s apart.`)
    setTimeout(() => setStatus(null), 8000)
  }

  function resetAll() {
    setBatchId(null)
    setItems([])
    setInclude({})
    setEdits({})
    setNameEdits({})
    setPhoneEdits({})
    setFindText('')
    setReplaceText('')
    setPicked(new Map())
    setName('')
    setBatchVenue('')
    setTemplate('')
    setAttachImg(null)
  }

  // Find & replace across every message in the preview (literal, all occurrences).
  function applyReplace() {
    if (!findText) return
    setEdits((prev) => {
      const next = { ...prev }
      for (const id in next) next[id] = next[id].split(findText).join(replaceText)
      return next
    })
    setStatus(`Replaced “${findText}” in all messages.`)
    setTimeout(() => setStatus(null), 2500)
  }

  // Tick/untick every sendable recipient at once.
  const allSendableIncluded =
    items.some((it) => sendableItem(it)) && items.every((it) => !sendableItem(it) || include[it.id])
  function toggleAllIncluded(checked: boolean) {
    setInclude((prev) => {
      const next = { ...prev }
      for (const it of items) if (sendableItem(it)) next[it.id] = checked
      return next
    })
  }

  // ---- Preview phase ----
  if (batchId) {
    return (
      <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Preview — {name || 'batch'}</h2>
            <p className="text-sm text-slate-500">
              {includedCount} of {items.length} will send. Guarded / un-sendable contacts are
              unticked by default.{attachImg ? ' · 🖼 image attached to every message.' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-slate-500">
              schedule
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
            </label>
            {scheduleAt && (
              <button onClick={() => setScheduleAt('')} className="text-xs text-slate-400 hover:underline">
                clear
              </button>
            )}
            <button
              onClick={resetAll}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Discard
            </button>
            <button
              onClick={() => void approveSend()}
              disabled={busy || includedCount === 0}
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Approve &amp; send ({includedCount})
            </button>
          </div>
        </div>
        {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

        {/* Find & replace across all messages — edit wording without rebuilding */}
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm">
          <span className="text-xs font-medium text-slate-500">Find &amp; replace:</span>
          <input
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            placeholder="find"
            className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
          />
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="replace with"
            className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
          />
          <button
            onClick={applyReplace}
            disabled={!findText}
            className="rounded-md bg-slate-700 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            Replace in all
          </button>
          <span className="text-xs text-slate-400">— edits apply to every message; your selection stays.</span>
        </div>

        <label className="mb-2 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={allSendableIncluded}
            onChange={(e) => toggleAllIncluded(e.target.checked)}
          />
          Select all ({includedCount}/{items.filter((it) => sendableItem(it)).length} sendable)
        </label>

        {/* Why each contact will / won't send — click a reason to show just those
            rows (e.g. everyone held back because it'd be a new cold SMS). */}
        {previewBuckets.length > 1 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {([['all', items.length], ...previewBuckets] as [string, number][]).map(([b, n]) => {
              const active = previewFilter === b
              const send = b === 'Will send'
              return (
                <button
                  key={b}
                  onClick={() => setPreviewFilter(active && b !== 'all' ? 'all' : b)}
                  title={b === 'all' ? 'Show everyone' : `Show only: ${b}`}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                    active
                      ? send
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                        : 'border-amber-400 bg-amber-50 text-amber-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {b === 'all' ? 'All' : b} ({n})
                </button>
              )
            })}
          </div>
        )}

        <ul className="space-y-2">
          {shownItems.map((it) => {
            const data = it.data as { network?: string; region?: string } | null
            const canSend = sendableItem(it)
            return (
              <li
                key={it.id}
                className={`rounded-lg border p-3 ${
                  include[it.id] && canSend
                    ? 'border-slate-200 bg-white'
                    : 'border-slate-200 bg-slate-50 opacity-70'
                }`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(include[it.id] ?? false) && canSend}
                    disabled={!canSend}
                    onChange={() => setInclude((p) => ({ ...p, [it.id]: !p[it.id] }))}
                  />
                  <input
                    value={nameEdits[it.id] ?? ''}
                    onChange={(e) => setNameEdits((p) => ({ ...p, [it.id]: e.target.value }))}
                    placeholder="name"
                    className="w-40 rounded-md border border-slate-200 px-2 py-0.5 text-sm font-medium outline-none focus:border-emerald-500"
                  />
                  <input
                    value={phoneEdits[it.id] ?? ''}
                    onChange={(e) => setPhoneEdits((p) => ({ ...p, [it.id]: e.target.value }))}
                    placeholder="number"
                    className="w-32 rounded-md border border-slate-200 px-2 py-0.5 text-xs outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-slate-400">{data?.network ?? data?.region}</span>
                  <button
                    onClick={() => setInclude((p) => ({ ...p, [it.id]: false }))}
                    title="Remove from this batch"
                    className="text-xs text-slate-300 hover:text-rose-600"
                  >
                    remove
                  </button>
                  {it.guard_flag && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                      ⚠ {it.guard_reason}
                    </span>
                  )}
                </div>
                <textarea
                  value={edits[it.id] ?? ''}
                  onChange={(e) => setEdits((p) => ({ ...p, [it.id]: e.target.value }))}
                  rows={2}
                  disabled={!include[it.id] || !canSend}
                  className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:bg-slate-100"
                />
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  // ---- Compose phase ----
  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
      <h2 className="text-lg font-semibold">New batch</h2>
      <p className="mb-4 text-sm text-slate-500">
        Write one template, pick who gets it, preview each rendered message, then approve.
        Use <code className="rounded bg-slate-100 px-1">{'{{name}}'}</code> or{' '}
        <code className="rounded bg-slate-100 px-1">{'{{first_name}}'}</code> to personalise.
      </p>

      <label className="mb-1 block text-sm font-medium">Venue / weekly game</label>
      <input
        list="batch-venues"
        value={batchVenue}
        onChange={(e) => setBatchVenue(e.target.value)}
        placeholder="e.g. Leederville Tuesday, Kingsley cash…"
        className="mb-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      <datalist id="batch-venues">
        {batchVenuesOpts.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      {!batchVenue.trim() && suggestedVenue ? (
        <p className="mb-3 text-xs text-emerald-700">
          Will tag as{' '}
          <button
            type="button"
            onClick={() => setBatchVenue(suggestedVenue)}
            className="font-semibold underline hover:text-emerald-800"
          >
            {suggestedVenue}
          </button>{' '}
          (most common venue of your picks) unless you set one — so each recipient&apos;s
          &ldquo;last messaged for {suggestedVenue}&rdquo; fills in.
        </p>
      ) : (
        <p className="mb-3 text-xs text-slate-500">
          Tags this batch so you can browse and rebuild this venue&apos;s weekly list below — and powers
          each player&apos;s &ldquo;last messaged for {'{venue}'}&rdquo; signal.
        </p>
      )}

      {tonight.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <span className="text-xs font-medium text-emerald-800">Tonight:</span>
          {tonight.map((t) => (
            <button
              key={t.venue + t.name}
              onClick={() => t.listId && void loadVenueList(t.listId)}
              disabled={!t.listId}
              title={t.listId ? `Load the ${t.venue} list` : `No list for ${t.venue} yet — create one in the Lists tab`}
              className={`rounded-full px-3 py-1 text-xs font-medium ${t.listId ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'cursor-not-allowed bg-slate-100 text-slate-400'}`}
            >
              {t.venue}{t.listId ? '' : ' (no list)'}
            </button>
          ))}
          <span className="text-[11px] text-slate-500">one tap to load tonight&apos;s venue list</span>
        </div>
      )}

      {scheduledDrafts.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="mb-1 text-sm font-medium text-amber-800">
            {scheduledDrafts.length} scheduled draft{scheduledDrafts.length > 1 ? 's' : ''} awaiting approval
          </p>
          <ul className="space-y-1">
            {scheduledDrafts.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {d.venue ? `${d.venue} · ` : ''}{d.name}
                  <span className="ml-1 text-[11px] text-slate-500">{new Date(d.created_at).toLocaleDateString()}</span>
                </span>
                <button onClick={() => void openBatch(d.id)}
                  className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700">
                  Open to approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {venueLists.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-slate-500">Load a venue list:</span>
          <select
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value
              if (id) void loadVenueList(id)
              e.target.value = ''
            }}
            className="max-w-xs flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a standing list —</option>
            {venueLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.venue ? `${l.venue} · ` : ''}{l.game_type ?? 'list'} · {l.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-slate-400">from the Lists tab · guards still apply at send</span>
        </div>
      )}

      {pastBatches.length > 0 &&
        (() => {
          const v = batchVenue.trim().toLowerCase()
          const list = v
            ? pastBatches.filter((b) => (b.venue ?? '').trim().toLowerCase() === v)
            : pastBatches
          return (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs font-medium text-slate-500">
                {v ? `Reuse a ${batchVenue.trim()} list:` : 'Reuse a past list:'}
              </span>
              <select
                defaultValue=""
                onChange={(e) => {
                  const id = e.target.value
                  if (id) {
                    const b = pastBatches.find((x) => x.id === id)
                    if (b?.venue && !batchVenue.trim()) setBatchVenue(b.venue)
                    void loadList(id)
                  }
                  e.target.value = ''
                }}
                className="max-w-xs flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="">
                  {list.length ? '— pick a previous batch —' : '— none for this venue —'}
                </option>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.venue ? `${b.venue} · ` : ''}
                    {new Date(b.created_at).toLocaleDateString()} · {b.name} · {b.status}
                  </option>
                ))}
              </select>
              <button onClick={loadPastBatches} className="text-xs text-emerald-700 hover:underline">
                refresh
              </button>
            </div>
          )
        })()}

      <label className="mb-1 block text-sm font-medium">Batch name (for your reference)</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Friday $5k freezeout reminder"
        className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />

      {inviteVariants.length > 0 && (
        <div className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2">
          <p className="mb-1 text-xs font-medium text-indigo-800">Suggested invites for {batchVenue.trim()} — tap to use</p>
          <ul className="space-y-1">
            {inviteVariants.map((v) => (
              <li key={v.id} className="flex items-start gap-2 text-sm">
                <button
                  onClick={() => setTemplate(v.body)}
                  className="rounded-md bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-700"
                >use</button>
                <span className="min-w-0 flex-1 text-slate-700">{v.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="mb-1 block text-sm font-medium">Message template</label>
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        placeholder="Hey {{first_name}}, we've got a $5k freezeout this Friday 7pm — keen?"
        rows={3}
        className="mb-2 w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      <label className="mb-4 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={useNickname} onChange={(e) => setUseNickname(e.target.checked)} />
        Use nicknames for{' '}
        <code className="rounded bg-slate-100 px-1">{'{{first_name}}'}</code> where one is set
      </label>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          📎 Attach image
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                setAttachImg(await fileToBase64(f))
                setStatus(null)
              } catch (err) {
                setStatus(err instanceof Error ? err.message : 'Could not read image')
              }
            }}
          />
        </label>
        {attachImg && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            🖼 {attachImg.name}
            <button onClick={() => setAttachImg(null)} className="text-slate-400 hover:text-rose-600">
              ×
            </button>
          </span>
        )}
        <span className="text-xs text-slate-400">Optional — the same image goes to every recipient.</span>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">Recipients from:</span>
        <button
          onClick={() => switchSource('inbox')}
          className={`rounded-full px-3 py-0.5 text-xs ${source === 'inbox' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}
        >
          Inbox threads
        </button>
        <button
          onClick={() => switchSource('crm')}
          className={`rounded-full px-3 py-0.5 text-xs ${source === 'crm' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}
        >
          Player Outreach (CRM)
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-medium">{picked.size} selected{picked.size > 0 ? ' · across all sources' : ''}</label>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {source === 'inbox' ? (
            <select value={network} onChange={(e) => setNetwork(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
              <option value="all">All channels</option>
              {networks.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          ) : (
            <>
              <input
                list="crm-region-list"
                value={region === 'all' ? '' : region}
                onChange={(e) => setRegion(e.target.value.trim() || 'all')}
                placeholder="Region…"
                className="w-32 rounded-md border border-slate-300 px-2 py-1"
              />
              <datalist id="crm-region-list">
                {regions.map((r) => (<option key={r} value={r} />))}
              </datalist>
              <select value={stake} onChange={(e) => setStake(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">All stakes</option>
                {stakesOpts.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
              <select value={venue} onChange={(e) => setVenue(e.target.value)} title="Filter by venue" className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">All venues</option>
                {venuesOpts.map((v) => (<option key={v} value={v}>{v}</option>))}
              </select>
              <select value={activity} onChange={(e) => setActivity(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">All activity</option>
                {activities.map((a) => (<option key={a} value={a}>{a}</option>))}
              </select>
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} title="Filter by contact source" className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">All sources</option>
                {sourcesOpts.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as 'auto' | 'sms' | 'thread')}
                title="Which channel to message players on"
                className="rounded-md border border-slate-300 px-2 py-1"
              >
                <option value="auto">Channel: auto</option>
                <option value="thread">Existing thread only</option>
                <option value="sms">SMS (text)</option>
              </select>
              <select value={cDay} onChange={(e) => setCDay(e.target.value)} title="Preferred contact day" className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">Any day</option>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <select value={cWindow} onChange={(e) => setCWindow(e.target.value)} title="Preferred contact time" className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">Any time</option>
                {['Morning', 'Afternoon', 'Evening'].map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </>
          )}
          <button onClick={selectAllSendable} className="text-emerald-700 hover:underline">
            Select all sendable
          </button>
          <button onClick={clearSelection} className="text-slate-500 hover:underline">
            Clear
          </button>
          <label className="flex items-center gap-1 text-slate-500">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            show hidden
          </label>
          <label className="flex items-center gap-1 text-slate-500">
            <input
              type="checkbox"
              checked={showUnavailable}
              onChange={(e) => setShowUnavailable(e.target.checked)}
            />
            show unavailable
          </label>
        </div>
      </div>

      <input
        value={recipientQuery}
        onChange={(e) => setRecipientQuery(e.target.value)}
        placeholder="Search recipients by name…"
        className="mb-2 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
      />

      {picked.size > 0 && (
        <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-emerald-800">
              Selected ({picked.size}) — kept across sources &amp; filters
            </span>
            <button onClick={clearSelection} className="text-xs text-slate-500 hover:underline">
              clear all
            </button>
          </div>
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {Array.from(picked.values()).map((r) => (
              <span
                key={r.key}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-xs"
              >
                {r.name}
                <button onClick={() => toggle(r)} title="Remove" className="text-slate-400 hover:text-rose-600">
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="mb-1 text-xs text-slate-400">
        {recipients.filter((r) => r.sendable).length} sendable ·{' '}
        {recipients.filter((r) => !r.sendable).length} unavailable {showUnavailable ? 'shown' : 'hidden'}
        {source === 'crm' && outreach.length === 0 && ' · (CRM empty — run the sync with AIRTABLE_API_KEY set)'}
      </p>

      <div className="mb-4 max-h-72 overflow-y-auto rounded-md border border-slate-200">
        {recipients.filter((r) => showUnavailable || r.sendable).map((r) => (
          <div
            key={r.key}
            onDoubleClick={() => startEdit(r)}
            onContextMenu={(e) => {
              if (source === 'crm') {
                e.preventDefault()
                startEdit(r)
              }
            }}
            className={`group flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-50 ${
              r.sendable ? '' : 'opacity-60'
            }`}
          >
            {editKey === r.key ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="name"
                  autoFocus
                  className="flex-1 rounded border border-slate-300 px-2 py-0.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  placeholder="phone"
                  className="w-32 rounded border border-slate-300 px-2 py-0.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  value={editNick}
                  onChange={(e) => setEditNick(e.target.value)}
                  placeholder="nickname"
                  className="w-24 rounded border border-slate-300 px-2 py-0.5 text-sm outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => void saveEdit()}
                  className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  Save
                </button>
                <button onClick={() => setEditKey(null)} className="px-1 text-xs text-slate-400 hover:underline">
                  cancel
                </button>
              </div>
            ) : (
              <>
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r)} />
                  <span className="flex-1">{r.name}</span>
                  {(() => {
                    const sig = source === 'crm' ? signals.get(r.key) : undefined
                    if (!sig?.last_sent_at) return null
                    const d = Math.max(
                      0,
                      Math.floor((Date.now() - new Date(sig.last_sent_at).getTime()) / 86_400_000),
                    )
                    const ghost = (sig.unanswered_outreach ?? 0) >= 2
                    return (
                      <span
                        className={`shrink-0 text-xs ${ghost ? 'text-rose-500' : 'text-slate-400'}`}
                        title={`Last messaged ${d} day${d === 1 ? '' : 's'} ago${
                          sig.last_venue ? ` for ${sig.last_venue}` : ''
                        }${ghost ? ` · no reply to the last ${sig.unanswered_outreach} outreach messages` : ''}`}
                      >
                        {ghost ? '👻 ' : ''}
                        {sig.last_venue ? `${sig.last_venue} · ` : ''}
                        {d}d
                      </span>
                    )
                  })()}
                  <span className="text-xs text-slate-400">{r.sub}</span>
                  {r.badge && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        !r.sendable ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {r.badge}
                    </span>
                  )}
                </label>
                {source === 'crm' && (
                  <button
                    onClick={() => startEdit(r)}
                    title="Edit name / number (or double-click the row)"
                    className="text-xs text-slate-300 hover:text-emerald-600"
                  >
                    edit
                  </button>
                )}
                {source === 'crm' && (
                  <button
                    onClick={() => void banPlayer(r)}
                    title="Ban — never message this player"
                    className="text-xs text-slate-300 hover:text-rose-700"
                  >
                    ban
                  </button>
                )}
                <button
                  onClick={() => void toggleHide(r.key, r.hidden)}
                  title={r.hidden ? 'Unhide' : 'Hide from this list'}
                  className="text-xs text-slate-300 hover:text-rose-600"
                >
                  {r.hidden ? 'unhide' : 'hide'}
                </button>
              </>
            )}
          </div>
        ))}
        {recipients.filter((r) => showUnavailable || r.sendable).length === 0 && (
          <p className="p-3 text-sm text-slate-400">No recipients match.</p>
        )}
      </div>

      {status && <p className="mb-3 text-sm text-slate-600">{status}</p>}

      <button
        onClick={() => void buildPreview()}
        disabled={busy}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
      >
        Build preview →
      </button>
    </div>
  )
}
