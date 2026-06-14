// LP Cash Rosters — review/adjust the prefilled cash seat rosters before they
// go live. Talks to Supabase PostgREST directly with the publishable anon key.
// Requires the anon RLS policies in migration 20260609020000_cash_roster_ui_rls.

const SUPABASE_URL = 'https://dexdftcmcixppbuucjfd.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRleGRmdGNtY2l4cHBidXVjamZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MzkxMTksImV4cCI6MjA5NTIxNTExOX0.w81lAxMJ-ZM5avvypZQt8fmxUISmVO9m0VSOaFjTmV0';
const REST = `${SUPABASE_URL}/rest/v1`;

const H = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { plans: [], rostersByPlan: {}, activePlanId: null };

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2200);
}

async function api(path, init = {}) {
  const res = await fetch(`${REST}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

const todayISO = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // Perth

async function loadPlans() {
  const today = todayISO();
  const plans = await api(`/cash_plan?event_date=gte.${today}&order=event_date.asc&select=id,event_date,label,status,anticipated_players`);
  state.plans = plans || [];
  // roster counts for all upcoming plans in one query
  const ids = state.plans.map((p) => p.id);
  state.rostersByPlan = {};
  if (ids.length) {
    const inList = ids.map((i) => `"${i}"`).join(',');
    const rows = await api(`/cash_seat_roster?plan_id=in.(${inList})&select=id,plan_id,player_name,player_id,seat_status&order=player_name.asc`);
    for (const r of rows || []) (state.rostersByPlan[r.plan_id] ||= []).push(r);
  }
  renderEvents();
  if (!state.activePlanId && state.plans[0]) selectPlan(state.plans[0].id);
}

function counts(planId) {
  const rows = state.rostersByPlan[planId] || [];
  const c = { total: rows.length, seated: 0, pending: 0, skipped: 0, error: 0 };
  for (const r of rows) c[r.seat_status] = (c[r.seat_status] || 0) + 1;
  return c;
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderEvents() {
  const col = $('#eventsCol');
  if (!state.plans.length) { col.innerHTML = '<div class="muted">No upcoming events. Run a prefill first.</div>'; return; }
  col.innerHTML = state.plans.map((p) => {
    const c = counts(p.id);
    return `<div class="ev-card ${p.id === state.activePlanId ? 'active' : ''}" data-id="${p.id}">
      <div class="ev-date">${fmtDate(p.event_date)} · ${esc(p.status)}</div>
      <div class="ev-label">${esc(p.label || '(no label)')}</div>
      <div class="ev-counts">
        <span class="pill">${c.total} names</span>
        ${c.seated ? `<span class="pill seated">${c.seated} seated</span>` : ''}
        ${c.pending ? `<span class="pill pending">${c.pending} pending</span>` : ''}
        ${c.skipped ? `<span class="pill skipped">${c.skipped} skipped</span>` : ''}
        ${c.error ? `<span class="pill error">${c.error} error</span>` : ''}
      </div>
    </div>`;
  }).join('');
  $$('.ev-card', col).forEach((el) => el.addEventListener('click', () => selectPlan(el.dataset.id)));
}

function selectPlan(planId) {
  state.activePlanId = planId;
  renderEvents();
  renderRoster();
}

function renderRoster() {
  const p = state.plans.find((x) => x.id === state.activePlanId);
  const col = $('#rosterCol');
  if (!p) { col.innerHTML = '<div class="muted">Select an event.</div>'; return; }
  const rows = (state.rostersByPlan[p.id] || []).slice()
    .sort((a, b) => a.player_name.localeCompare(b.player_name));
  col.innerHTML = `
    <div class="roster-head">
      <h2>${esc(p.label || '(no label)')}</h2>
      <span class="muted">${fmtDate(p.event_date)} · ${rows.length} names</span>
    </div>
    <div class="add-row">
      <input id="addName" type="text" placeholder="Add a player name…" />
      <button class="btn btn-primary" id="addBtn">Add</button>
    </div>
    <table class="roster">
      <thead><tr><th>Player</th><th>Status</th><th>LP id</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr class="${r.seat_status === 'skipped' ? 'excluded' : ''}" data-id="${r.id}">
            <td>${esc(r.player_name)}</td>
            <td><span class="seat-badge pill ${r.seat_status}">${esc(r.seat_status)}</span></td>
            <td class="muted">${r.player_id ? esc(r.player_id) : '<span class="muted">—</span>'}</td>
            <td><div class="row-actions">
              ${r.seat_status === 'skipped'
                ? `<button class="icon-btn" data-act="include">Include</button>`
                : `<button class="icon-btn" data-act="exclude">Exclude</button>`}
              <button class="icon-btn" data-act="never" title="Never auto-seat in any event">🚫 Never</button>
              <button class="icon-btn danger" data-act="remove">Remove</button>
            </div></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  $('#addBtn').addEventListener('click', addName);
  $('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addName(); });
  $$('.roster tbody tr', col).forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-act="remove"]').addEventListener('click', () => removeRow(id));
    const inc = tr.querySelector('[data-act="include"]');
    const exc = tr.querySelector('[data-act="exclude"]');
    if (inc) inc.addEventListener('click', () => setStatus(id, 'pending'));
    if (exc) exc.addEventListener('click', () => setStatus(id, 'skipped'));
    tr.querySelector('[data-act="never"]').addEventListener('click', () => neverSeat(id));
  });
}

// Add a player to the global cash_exclusions list (never auto-seat in any
// future prefill) and skip them on this event too.
async function neverSeat(id) {
  const p = state.plans.find((x) => x.id === state.activePlanId);
  const row = (state.rostersByPlan[p.id] || []).find((r) => r.id === id);
  if (!row) return;
  try {
    await api(`/cash_exclusions?on_conflict=player_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ player_id: row.player_id, player_name: row.player_name, reason: 'via roster UI' }),
    });
    await setStatus(id, 'skipped');
    toast(`${row.player_name} won't be auto-seated again`);
  } catch (e) { toast(`Couldn't exclude: ${e.message}`, true); }
}

async function addName() {
  const input = $('#addName');
  const name = input.value.trim();
  const p = state.plans.find((x) => x.id === state.activePlanId);
  if (!name || !p) return;
  try {
    const created = await api(`/cash_seat_roster`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ plan_id: p.id, event_date: p.event_date, player_name: name, seat_status: 'pending' }),
    });
    (state.rostersByPlan[p.id] ||= []).push(created[0]);
    input.value = '';
    renderEvents(); renderRoster();
    toast(`Added ${name}`);
  } catch (e) { toast(`Add failed: ${e.message}`, true); }
}

async function removeRow(id) {
  const p = state.plans.find((x) => x.id === state.activePlanId);
  try {
    await api(`/cash_seat_roster?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    state.rostersByPlan[p.id] = (state.rostersByPlan[p.id] || []).filter((r) => r.id !== id);
    renderEvents(); renderRoster();
    toast('Removed');
  } catch (e) { toast(`Remove failed: ${e.message}`, true); }
}

async function setStatus(id, status) {
  const p = state.plans.find((x) => x.id === state.activePlanId);
  try {
    await api(`/cash_seat_roster?id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ seat_status: status }),
    });
    const row = (state.rostersByPlan[p.id] || []).find((r) => r.id === id);
    if (row) row.seat_status = status;
    renderEvents(); renderRoster();
    toast(status === 'skipped' ? 'Excluded' : 'Included');
  } catch (e) { toast(`Update failed: ${e.message}`, true); }
}

loadPlans().catch((e) => {
  $('#eventsCol').innerHTML = `<div class="muted">Failed to load: ${esc(e.message)}.<br>Has the anon RLS policy been applied?</div>`;
});
