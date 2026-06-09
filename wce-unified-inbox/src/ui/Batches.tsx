import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fileToBase64, type PickedImage } from '../lib/attachment'
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
  data: Json
}

function fill(template: string, name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
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

  // filters
  const [network, setNetwork] = useState('all')
  const [region, setRegion] = useState('all')
  const [stake, setStake] = useState('all')
  const [activity, setActivity] = useState('all')
  const [recipientQuery, setRecipientQuery] = useState('')
  // Which channel to contact CRM players on when more than one is available.
  const [channel, setChannel] = useState<'auto' | 'sms' | 'thread'>('auto')
  const [showHidden, setShowHidden] = useState(false)
  // weekly contact-slot filters + scheduled send time
  const [cDay, setCDay] = useState('all')
  const [cWindow, setCWindow] = useState('all')
  const [scheduleAt, setScheduleAt] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
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
  // previously-built batches you can reload the recipient list from
  const [pastBatches, setPastBatches] = useState<
    { id: string; name: string; status: string; created_at: string }[]
  >([])
  // per-recipient name/phone corrections made in the preview
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({})
  const [phoneEdits, setPhoneEdits] = useState<Record<string, string>>({})
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')

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
  const activities = useMemo(
    () => Array.from(new Set(outreach.map((o) => o.activity).filter(Boolean) as string[])).sort(),
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
        // Resolve which channel this batch will use for this player.
        const useThread = channel === 'thread' || (channel === 'auto' && hasThread)
        const sendable =
          channel === 'thread' ? hasThread : channel === 'sms' ? hasPhone : hasThread || hasPhone
        const chosen: 'thread' | 'sms' = useThread ? 'thread' : 'sms'
        const newSms = chosen === 'sms' && !hasThread // cold SMS to someone with no thread
        const channels = [hasPhone && 'SMS', hasThread && 'thread'].filter(Boolean).join(' + ')
        // Frequency cap: don't re-contact within the player's contact_frequency_days.
        const tooSoon =
          !!o.last_contacted &&
          !!o.contact_frequency_days &&
          Date.now() - new Date(o.last_contacted).getTime() <
            o.contact_frequency_days * 24 * 60 * 60 * 1000
        return {
          key: o.id,
          name: nm,
          sub: o.region ?? '—',
          sendable,
          guard: newSms || tooSoon,
          guardReason: !sendable
            ? channel === 'thread'
              ? 'No existing thread'
              : channel === 'sms'
                ? 'No phone'
                : 'No phone or thread'
            : tooSoon
              ? `Contacted < ${o.contact_frequency_days}d ago`
              : newSms
                ? 'Will start a NEW SMS chat'
                : null,
          badge: !sendable
            ? 'unavailable'
            : tooSoon
              ? 'too soon'
              : newSms
                ? 'new SMS'
                : channels || null,
          hidden: o.hidden,
          personId: null,
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
        if (activity !== 'all' && o.activity !== activity) return false
        if (cDay !== 'all' && o.contact_day !== cDay) return false
        if (cWindow !== 'all' && o.contact_window !== cWindow) return false
        if (q && !r.name.toLowerCase().includes(q)) return false
        return true
      })
  }, [source, conversations, outreach, network, region, stake, activity, recipientQuery, channel, cDay, cWindow])

  function switchSource(s: Source) {
    setSource(s)
    setSelected(new Set())
  }

  function loadPastBatches() {
    supabase
      .from('inbox_batches')
      .select('id, name, status, created_at')
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
    setSelected(keys)
    setStatus(`Loaded ${keys.size} recipients from that list — edit the template and Build preview.`)
    setTimeout(() => setStatus(null), 6000)
  }
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }
  function selectAllSendable() {
    setSelected(new Set(recipients.filter((r) => r.sendable).map((r) => r.key)))
  }
  function clearSelection() {
    setSelected(new Set())
  }

  async function buildPreview() {
    const chosen = recipients.filter((r) => selected.has(r.key))
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
      rendered_text: fill(template, r.name),
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
    setSelected(new Set())
    setName('')
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

        <ul className="space-y-2">
          {items.map((it) => {
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

      {pastBatches.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-slate-500">Reuse a past list:</span>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void loadList(e.target.value)
              e.target.value = ''
            }}
            className="max-w-xs flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a previous batch —</option>
            {pastBatches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {new Date(b.created_at).toLocaleDateString()} · {b.status}
              </option>
            ))}
          </select>
          <button onClick={loadPastBatches} className="text-xs text-emerald-700 hover:underline">
            refresh
          </button>
        </div>
      )}

      <label className="mb-1 block text-sm font-medium">Batch name (for your reference)</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Friday $5k freezeout reminder"
        className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />

      <label className="mb-1 block text-sm font-medium">Message template</label>
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        placeholder="Hey {{first_name}}, we've got a $5k freezeout this Friday 7pm — keen?"
        rows={3}
        className="mb-4 w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />

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
        <label className="text-sm font-medium">{selected.size} selected</label>
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
              <select value={activity} onChange={(e) => setActivity(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
                <option value="all">All activity</option>
                {activities.map((a) => (<option key={a} value={a}>{a}</option>))}
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
        </div>
      </div>

      <input
        value={recipientQuery}
        onChange={(e) => setRecipientQuery(e.target.value)}
        placeholder="Search recipients by name…"
        className="mb-2 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
      />

      <p className="mb-1 text-xs text-slate-400">
        {recipients.length} match · {recipients.filter((r) => r.sendable).length} sendable now
        {source === 'crm' && outreach.length === 0 && ' · (CRM empty — run the sync with AIRTABLE_API_KEY set)'}
      </p>

      <div className="mb-4 max-h-72 overflow-y-auto rounded-md border border-slate-200">
        {recipients.map((r) => (
          <div
            key={r.key}
            className={`group flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-50 ${
              r.sendable ? '' : 'opacity-60'
            }`}
          >
            <label className="flex flex-1 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
              <span className="flex-1">{r.name}</span>
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
            <button
              onClick={() => void toggleHide(r.key, r.hidden)}
              title={r.hidden ? 'Unhide' : 'Hide from this list'}
              className="text-xs text-slate-300 hover:text-rose-600"
            >
              {r.hidden ? 'unhide' : 'hide'}
            </button>
          </div>
        ))}
        {recipients.length === 0 && (
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
