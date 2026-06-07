import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type ConvRow = Database['public']['Tables']['inbox_conversations']['Row'] & {
  inbox_people: { display_name: string | null; last_outbound_at: string | null } | null
}
type ItemRow = Database['public']['Tables']['inbox_batch_items']['Row']

const GUARD_WINDOW_MS = 24 * 60 * 60 * 1000

/** Fill {{name}} / {{first_name}} placeholders from the contact's display name. */
function fill(template: string, name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, name)
}

function messagedRecently(iso: string | null): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() < GUARD_WINDOW_MS
}

export function Batches() {
  const [conversations, setConversations] = useState<ConvRow[]>([])
  const [network, setNetwork] = useState('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // preview phase
  const [batchId, setBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<ItemRow[]>([])
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})

  useEffect(() => {
    supabase
      .from('inbox_conversations')
      .select('*, inbox_people(display_name, last_outbound_at)')
      .order('last_activity', { ascending: false, nullsFirst: false })
      .then(({ data }) => setConversations((data as unknown as ConvRow[]) ?? []))
  }, [])

  const networks = useMemo(
    () => Array.from(new Set(conversations.map((c) => c.network))).sort(),
    [conversations],
  )
  const visible = useMemo(
    () => conversations.filter((c) => network === 'all' || c.network === network),
    [conversations, network],
  )

  const nameOf = (c: ConvRow) =>
    c.inbox_people?.display_name ?? c.title ?? c.external_chat_id

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function selectAllVisible() {
    setSelected(new Set(visible.map((c) => c.id)))
  }
  function clearSelection() {
    setSelected(new Set())
  }

  async function buildPreview() {
    const recipients = conversations.filter((c) => selected.has(c.id))
    if (!name.trim() || !template.trim() || recipients.length === 0) {
      setStatus('Add a name, a template, and at least one recipient.')
      return
    }
    setBusy(true)
    setStatus('Building preview…')

    const { data: batch, error: bErr } = await supabase
      .from('inbox_batches')
      .insert({ name: name.trim(), template_body: template, status: 'draft', created_by: 'manual' })
      .select('id')
      .single()
    if (bErr || !batch) {
      setBusy(false)
      setStatus(`Error: ${bErr?.message ?? 'could not create batch'}`)
      return
    }

    const rows = recipients.map((c) => {
      const display = nameOf(c)
      const guarded = messagedRecently(c.inbox_people?.last_outbound_at ?? null)
      return {
        batch_id: batch.id,
        person_id: c.person_id,
        rendered_text: fill(template, display),
        data: { conversation_id: c.id, name: display, network: c.network },
        status: 'pending' as const,
        guard_flag: guarded,
        guard_reason: guarded ? 'Messaged in the last 24h' : null,
      }
    })
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
    setBatchId(batch.id)
    setBusy(false)
    setStatus(null)
  }

  const includedCount = items.filter((it) => include[it.id]).length

  async function approveSend() {
    if (!batchId || includedCount === 0) return
    setBusy(true)
    setStatus('Approving…')
    for (const it of items) {
      if (include[it.id]) {
        await supabase
          .from('inbox_batch_items')
          .update({ status: 'approved', rendered_text: edits[it.id] ?? it.rendered_text })
          .eq('id', it.id)
      } else {
        await supabase.from('inbox_batch_items').update({ status: 'skipped' }).eq('id', it.id)
      }
    }
    const { error } = await supabase
      .from('inbox_batches')
      .update({ status: 'approved' })
      .eq('id', batchId)
    setBusy(false)
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    resetAll()
    setStatus(`Approved ✓ — ${includedCount} message(s) send on the next sync, paced ~1.5s apart.`)
    setTimeout(() => setStatus(null), 8000)
  }

  function resetAll() {
    setBatchId(null)
    setItems([])
    setInclude({})
    setEdits({})
    setSelected(new Set())
    setName('')
    setTemplate('')
  }

  // ---- Preview phase ----
  if (batchId) {
    return (
      <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Preview — {name || 'batch'}</h2>
            <p className="text-sm text-slate-500">
              {includedCount} of {items.length} will send. Guarded contacts (messaged
              recently) are unticked by default.
            </p>
          </div>
          <div className="flex gap-2">
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

        <ul className="space-y-2">
          {items.map((it) => {
            const data = it.data as { name?: string; network?: string } | null
            return (
              <li
                key={it.id}
                className={`rounded-lg border p-3 ${
                  include[it.id] ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={include[it.id] ?? false}
                    onChange={() =>
                      setInclude((p) => ({ ...p, [it.id]: !p[it.id] }))
                    }
                  />
                  <span className="text-sm font-medium">{data?.name ?? 'Unknown'}</span>
                  <span className="text-xs text-slate-400">{data?.network}</span>
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
                  disabled={!include[it.id]}
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

      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm font-medium">
          Recipients ({selected.size} selected)
        </label>
        <div className="flex items-center gap-2 text-xs">
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="all">All channels</option>
            {networks.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button onClick={selectAllVisible} className="text-emerald-700 hover:underline">
            Select all
          </button>
          <button onClick={clearSelection} className="text-slate-500 hover:underline">
            Clear
          </button>
        </div>
      </div>

      <div className="mb-4 max-h-72 overflow-y-auto rounded-md border border-slate-200">
        {visible.map((c) => {
          const guarded = messagedRecently(c.inbox_people?.last_outbound_at ?? null)
          return (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="flex-1">{nameOf(c)}</span>
              <span className="text-xs text-slate-400">{c.network}</span>
              {guarded && (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                  recent
                </span>
              )}
            </label>
          )
        })}
        {visible.length === 0 && (
          <p className="p-3 text-sm text-slate-400">No conversations on this channel.</p>
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
