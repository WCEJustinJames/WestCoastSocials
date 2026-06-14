// LetsPoker cash automation — headless companion to letspoker-push.
//
// Cash control is ALL done via one mutation, createTournamentLogItem, on the
// day's cash event (a tournament-shaped container resolved from getEventList as
// the entry with an empty eventName on that Perth date). See CASH_API.md.
//
// Modes (request body { "mode": ... }):
//   - "prefill" -> prefill upcoming rosters from the same weekly game last week.
//   - "open"    -> open the plan's tables_spec via AddTable. dryRun supported.
//   - "seat"    -> Register -> Seat (-> AddCashBuyin) the plan's roster names
//                  into free seats on the day's cash tables. dryRun DEFAULT true.
//   - "push"    -> sendCashPushNotification per open table. dryRun DEFAULT true.
//   - "tick"    -> orchestrate open + seat for today's plans (cron).
//   - "log"     -> read the cash event's tournament log (debug).
//
// Outward-facing / money-touching ops (seat, push) default to dryRun.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const CREATE_LOG = `mutation createTournamentLogItem($data: CreateTournamentLogInput!, $tournamentId: ID!, $clubId: ID!) {
  createTournamentLogItem(data: $data, tournamentId: $tournamentId, clubId: $clubId) {
    id parentLogId playerId eventType __typename
  }
}`;

const LIST_QUERY = `query getList($clubId: ID!, $startDate: DateTime!, $endDate: DateTime!, $includeCash: Boolean!) {
  events: getEventList(clubId: $clubId, startDate: $startDate, endDate: $endDate, includeCash: $includeCash) {
    id scheduledDate config { general { eventName } }
  }
}`;

const LOG_QUERY = `query getTournamentLog($tournamentId: ID!, $clubId: ID!, $dateAfter: Float) {
  getTournamentLog(tournamentId: $tournamentId, clubId: $clubId, dateAfter: $dateAfter) {
    id tournamentEventId parentLogId playerId eventType eventData __typename
  }
}`;

const CASH_PUSH = `mutation sendCashPushNotification($clubId: ID!, $tableId: ID!, $tournamentEventId: ID!, $templateParts: [String!]!) {
  sendCashPushNotification(clubId: $clubId, tableId: $tableId, tournamentEventId: $tournamentEventId, templateParts: $templateParts)
}`;

const CASH_TEMPLATE_PARTS = ["eventName", "location"];

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

// Perth is UTC+8, no DST.
function perthDate(dayOffset = 0): string {
  return new Date(Date.now() + (8 * 60 + dayOffset * 24 * 60) * 60 * 1000).toISOString().slice(0, 10);
}
function perthDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function headers(cookie: string, sessionGroupId: string): HeadersInit {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-app-section": "admin",
    "x-app-version": "2.0.1",
    "x-session-groupid": sessionGroupId,
    Cookie: cookie,
  };
}

function looksUnauthenticated(status: number, text: string): boolean {
  if (status === 401 || status === 403) return true;
  const t = text.toLowerCase();
  return t.includes("unauthenticated") || t.includes("not authenticated") ||
    t.includes("unauthorized") || t.includes("session expired") || t.includes("invalid session");
}

function firstGraphqlError(text: string): string | null {
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    const errs = first?.errors;
    if (Array.isArray(errs) && errs.length) return String(errs[0]?.message ?? "graphql error");
    return null;
  } catch { return null; }
}
function firstData(text: string): any {
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    return first?.data ?? null;
  } catch { return null; }
}

async function getCookie(): Promise<string | undefined> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    try {
      const res = await fetch(`${url}/rest/v1/letspoker_auth?id=eq.1&select=cookie`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      const rows = await res.json();
      if (Array.isArray(rows) && rows[0]?.cookie) return rows[0].cookie as string;
    } catch (_e) { /* fall through */ }
  }
  return env("LETSPOKER_COOKIE");
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return await fetch(`${url}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

async function logCash(row: { source: string; op: string; ref: string | null; http_status: number | null; ok: boolean; detail: string; }) {
  try {
    await rest(`/rest/v1/cash_open_log`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
  } catch (_e) { /* best-effort */ }
}

async function alertJustin(subject: string, message: string) {
  const tasks: Promise<unknown>[] = [];
  const resendKey = env("RESEND_API_KEY");
  const alertEmail = env("ALERT_EMAIL");
  const alertFrom = env("ALERT_FROM") ?? "letspoker-push@clubwestcoast.com.au";
  if (resendKey && alertEmail) {
    tasks.push(fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: alertFrom, to: alertEmail, subject, text: message }),
    }).catch((e) => console.error("alert email failed:", e)));
  }
  const webhook = env("ALERT_WEBHOOK_URL");
  if (webhook) {
    tasks.push(fetch(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, text: message }),
    }).catch((e) => console.error("alert webhook failed:", e)));
  }
  if (tasks.length === 0) console.error("[ALERT — no channel] " + subject + " :: " + message);
  await Promise.allSettled(tasks);
}

// Fire one GraphQL operation (batched-array form, as the LP admin client sends).
async function gql(cookie: string, sgid: string, operationName: string, query: string, variables: unknown):
  Promise<{ status: number | null; text: string; ok: boolean; unauth: boolean; error: string | null }> {
  let status: number | null = null, text = "";
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: headers(cookie, sgid), body: JSON.stringify([{ operationName, query, variables }]) });
    status = res.status; text = await res.text();
  } catch (e) {
    return { status: null, text: "", ok: false, unauth: false, error: `network error: ${e}` };
  }
  const unauth = looksUnauthenticated(status, text);
  const gqlErr = firstGraphqlError(text);
  return { status, text, ok: status === 200 && !unauth && !gqlErr, unauth, error: gqlErr };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

/* --------------------------- cash event + log ------------------------ */

// The day's cash container: the getEventList entry with an empty eventName whose
// Perth date matches. Returns its id (used as tournamentId everywhere).
async function resolveCashEventId(cookie: string, sgid: string, clubId: string, date: string): Promise<string | null> {
  const start = new Date(new Date(date + "T00:00:00+08:00").getTime() - 36 * 3600 * 1000).toISOString();
  const end = new Date(new Date(date + "T00:00:00+08:00").getTime() + 36 * 3600 * 1000).toISOString();
  const r = await gql(cookie, sgid, "getList", LIST_QUERY, { clubId, startDate: start, endDate: end, includeCash: true });
  if (!r.ok) return null;
  const events = (firstData(r.text)?.events ?? []) as any[];
  const match = events.find((e) =>
    e?.id && e?.scheduledDate &&
    String(e?.config?.general?.eventName ?? "").trim() === "" &&
    perthDateOf(e.scheduledDate) === date);
  return match?.id ?? null;
}

async function getCashLog(cookie: string, sgid: string, clubId: string, eventId: string): Promise<any[]> {
  const r = await gql(cookie, sgid, "getTournamentLog", LOG_QUERY, { tournamentId: eventId, clubId, dateAfter: 0 });
  if (!r.ok) return [];
  return (firstData(r.text)?.getTournamentLog ?? []) as any[];
}

type TableInfo = { tableId: string; identifier: string | null; stake: any; gameType: string | null; tableSize: number; buyInLimits: any };

// Open tables + occupied seats + already-seated players, derived from the log.
function tableState(log: any[]): { tables: TableInfo[]; occupied: Record<string, Set<number>>; seatedPlayers: Set<string> } {
  const removed = new Set(log.filter((e) => e.eventType === "RemoveTable" && e.parentLogId).map((e) => e.parentLogId));
  const tables: TableInfo[] = log
    .filter((e) => e.eventType === "AddTable" && !removed.has(e.id))
    .map((e) => ({
      tableId: e.id,
      identifier: e.eventData?.identifier ?? null,
      stake: e.eventData?.stake ?? null,
      gameType: e.eventData?.gameType ?? null,
      tableSize: typeof e.eventData?.tableSize === "number" ? e.eventData.tableSize : 9,
      buyInLimits: e.eventData?.buyInLimits ?? null,
    }));
  const live = new Set(tables.map((t) => t.tableId));
  const occupied: Record<string, Set<number>> = {};
  const seatedPlayers = new Set<string>();
  for (const e of log) {
    if (e.eventType === "Seated" && e.eventData?.tableId && live.has(e.eventData.tableId)) {
      (occupied[e.eventData.tableId] ||= new Set()).add(e.eventData.seatIndex);
      if (e.playerId) seatedPlayers.add(e.playerId);
    }
  }
  return { tables, occupied, seatedPlayers };
}

function freeSlots(state: ReturnType<typeof tableState>): { tableId: string; seatIndex: number; table: TableInfo }[] {
  const slots: { tableId: string; seatIndex: number; table: TableInfo }[] = [];
  for (const t of state.tables) {
    const taken = state.occupied[t.tableId] ?? new Set<number>();
    for (let s = 0; s < t.tableSize; s++) if (!taken.has(s)) slots.push({ tableId: t.tableId, seatIndex: s, table: t });
  }
  return slots;
}

// 75-85% of a table's max buy-in (in chips). Default 80%.
function buyinChips(table: TableInfo, pct = 0.8): number {
  const bb = Array.isArray(table.stake?.blinds) ? Number(table.stake.blinds[table.stake.blinds.length - 1]) : 0;
  const maxBB = Number(table.buyInLimits?.max ?? 0);
  const max = bb * maxBB;
  return max > 0 ? Math.round(max * pct) : 0;
}

async function createLogItem(cookie: string, sgid: string, clubId: string, eventId: string, data: unknown):
  Promise<{ ok: boolean; id: string | null; error: string | null; status: number | null }> {
  const r = await gql(cookie, sgid, "createTournamentLogItem", CREATE_LOG, { tournamentId: eventId, clubId, data });
  let id: string | null = null;
  try { id = firstData(r.text)?.createTournamentLogItem?.id ?? null; } catch { /* */ }
  return { ok: r.ok, id, error: r.error, status: r.status };
}

/* ------------------------------- plans ------------------------------- */
type Plan = {
  id: string; event_date: string; label: string | null; status: string;
  tables_spec: any[]; anticipated_players: number | null;
};
async function loadPlans(opts: { planId?: string; date?: string }): Promise<Plan[]> {
  let q = "";
  if (opts.planId) q = `id=eq.${opts.planId}`;
  else if (opts.date) q = `event_date=eq.${opts.date}`;
  else return [];
  const res = await rest(`/rest/v1/cash_plan?${q}&select=*`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
async function patchRoster(id: string, patch: Record<string, unknown>) {
  await rest(`/rest/v1/cash_seat_roster?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
}
async function resolvePlayerId(name: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  const [first, ...rest_] = n.split(/\s+/);
  let q = `select=player_id&limit=1&first_name=ilike.${encodeURIComponent(first)}`;
  if (rest_.length) q += `&last_name=ilike.${encodeURIComponent(rest_.join(" "))}`;
  const res = await rest(`/rest/v1/lp_entries?${q}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.player_id ? String(rows[0].player_id) : null;
}
async function claimDayUser(playDate: string, playerKey: string, meta: { player_name: string; player_id: string | null; event_id: string | null }): Promise<boolean> {
  const res = await rest(`/rest/v1/cash_day_user_ledger`, {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ play_date: playDate, player_key: playerKey, used_for: "cash", ...meta }),
  });
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}
async function releaseDayUser(playDate: string, playerKey: string) {
  await rest(`/rest/v1/cash_day_user_ledger?play_date=eq.${playDate}&player_key=eq.${encodeURIComponent(playerKey)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/* -------------------------------- open ------------------------------- */
// Open the plan's tables_spec via AddTable. Optionally start the day first.
async function runOpen(cookie: string, sgid: string, clubId: string, opts: { planId?: string; date?: string; dryRun: boolean; start?: boolean }): Promise<Response> {
  const plans = await loadPlans(opts);
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });
  const results: unknown[] = [];
  for (const p of plans) {
    const eventId = await resolveCashEventId(cookie, sgid, clubId, p.event_date);
    if (!eventId) { results.push({ planId: p.id, skipped: true, reason: "no cash event for date (day not created yet)" }); continue; }
    const specs = Array.isArray(p.tables_spec) ? p.tables_spec : [];
    if (!specs.length) { results.push({ planId: p.id, eventId, skipped: true, reason: "plan has no tables_spec" }); continue; }
    if (opts.dryRun) { results.push({ planId: p.id, eventId, dryRun: true, wouldStart: !!opts.start, wouldAddTables: specs }); continue; }
    const fired: unknown[] = [];
    if (opts.start) {
      const c = await createLogItem(cookie, sgid, clubId, eventId, { eventType: "Command", eventData: { command: { start: true } } });
      fired.push({ op: "start", ok: c.ok, error: c.error });
    }
    for (const spec of specs) {
      const c = await createLogItem(cookie, sgid, clubId, eventId, { eventType: "AddTable", eventData: spec });
      await logCash({ source: "open", op: "open", ref: p.id, http_status: c.status, ok: c.ok, detail: `AddTable ${JSON.stringify(spec).slice(0, 200)} -> ${c.ok ? c.id : c.error}` });
      fired.push({ op: "AddTable", tableId: c.id, ok: c.ok, error: c.error });
    }
    const allOk = fired.every((f: any) => f.ok);
    if (!allOk) await alertJustin("LetsPoker cash open failed", `Plan ${p.id} (${p.event_date}): ${JSON.stringify(fired)}`);
    results.push({ planId: p.id, eventId, ok: allOk, fired });
  }
  const ok = results.every((r: any) => r.dryRun || r.skipped || r.ok);
  return json({ ok, mode: "open", dryRun: opts.dryRun, results }, ok ? 200 : 502);
}

/* -------------------------------- seat ------------------------------- */
// Register -> Seat (-> AddCashBuyin) the plan's pending roster into free seats.
async function runSeat(cookie: string, sgid: string, clubId: string,
  opts: { planId?: string; date?: string; dryRun: boolean; buyin?: boolean; buyinPct?: number; notes?: string }): Promise<Response> {
  const plans = await loadPlans(opts);
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });

  const results: unknown[] = [];
  for (const p of plans) {
    const eventId = await resolveCashEventId(cookie, sgid, clubId, p.event_date);
    if (!eventId) { results.push({ planId: p.id, skipped: true, reason: "no cash event for date (day not opened)" }); continue; }
    const state = tableState(await getCashLog(cookie, sgid, clubId, eventId));
    if (!state.tables.length) { results.push({ planId: p.id, eventId, skipped: true, reason: "no open cash tables — open one first" }); continue; }
    const slots = freeSlots(state);
    let slotIdx = 0;

    const rosterRes = await rest(`/rest/v1/cash_seat_roster?plan_id=eq.${p.id}&seat_status=eq.pending&select=*`);
    const roster = await rosterRes.json().catch(() => []) as any[];

    for (const row of roster) {
      const pid = row.player_id ?? await resolvePlayerId(row.player_name);
      if (!pid) { await patchRoster(row.id, { seat_status: "error", detail: "could not resolve player_id" }); results.push({ roster: row.id, name: row.player_name, ok: false, reason: "unresolved player" }); continue; }
      if (state.seatedPlayers.has(pid)) { await patchRoster(row.id, { seat_status: "seated", player_id: pid, detail: "already seated on a live table" }); results.push({ roster: row.id, name: row.player_name, skipped: true, reason: "already seated" }); continue; }

      const claimed = await claimDayUser(p.event_date, pid, { player_name: row.player_name, player_id: pid, event_id: eventId });
      if (!claimed) { await patchRoster(row.id, { seat_status: "skipped", player_id: pid, detail: "already used this day (one user/day guard)" }); results.push({ roster: row.id, name: row.player_name, skipped: true, reason: "already used today" }); continue; }

      if (slotIdx >= slots.length) { await releaseDayUser(p.event_date, pid); results.push({ roster: row.id, name: row.player_name, skipped: true, reason: "tables full" }); continue; }
      const slot = slots[slotIdx];
      const chips = opts.buyin ? buyinChips(slot.table, opts.buyinPct ?? 0.8) : 0;

      if (opts.dryRun) {
        await releaseDayUser(p.event_date, pid);
        results.push({ roster: row.id, name: row.player_name, dryRun: true, playerId: pid, wouldSeat: { tableId: slot.tableId, identifier: slot.table.identifier, seatIndex: slot.seatIndex }, wouldBuyin: opts.buyin ? { chipsAdded: chips, paymentMethod: "CASH" } : null });
        slotIdx++;
        continue;
      }

      // 1) Register (check in)
      const reg = await createLogItem(cookie, sgid, clubId, eventId, { playerId: pid, eventType: "Registered", eventData: { confirmed: true, paymentMethod: "", enforceMaxReentries: true } });
      if (!reg.ok || !reg.id) {
        await releaseDayUser(p.event_date, pid);
        await patchRoster(row.id, { seat_status: "error", player_id: pid, detail: `Register failed: ${reg.error ?? reg.status}` });
        await alertJustin("LetsPoker cash seat failed (register)", `player=${row.player_name} ${reg.error ?? reg.status}`);
        results.push({ roster: row.id, name: row.player_name, ok: false, stage: "register", error: reg.error });
        continue;
      }
      // 2) Seat
      const seat = await createLogItem(cookie, sgid, clubId, eventId, { playerId: pid, parentLogId: reg.id, eventType: "Seated", eventData: { tableId: slot.tableId, seatIndex: slot.seatIndex, allowSwap: true } });
      // 3) optional buy-in
      let buyinRes: any = null;
      if (seat.ok && opts.buyin && chips > 0) {
        buyinRes = await createLogItem(cookie, sgid, clubId, eventId, { playerId: pid, parentLogId: reg.id, eventType: "AddCashBuyin", eventData: { addCashBuyin: { currency: slot.table.stake?.currency ?? "AUD", chipsAdded: chips, source: "Table", notes: opts.notes ?? "", paymentMethod: "CASH" } } });
      }
      const ok = seat.ok && (!opts.buyin || (buyinRes?.ok ?? true));
      await logCash({ source: "seat", op: "seat", ref: p.id, http_status: seat.status, ok, detail: `seat ${row.player_name}(${pid}) table=${slot.tableId} seat=${slot.seatIndex} buyin=${chips} -> ${ok ? "OK" : (seat.error ?? buyinRes?.error)}` });
      if (ok) {
        state.seatedPlayers.add(pid);
        state.occupied[slot.tableId] = (state.occupied[slot.tableId] ?? new Set()).add(slot.seatIndex);
        slotIdx++;
        await patchRoster(row.id, { seat_status: "seated", player_id: pid, seated_at: new Date().toISOString(), detail: null });
      } else {
        await releaseDayUser(p.event_date, pid);
        await patchRoster(row.id, { seat_status: "error", player_id: pid, detail: seat.error ?? buyinRes?.error ?? "seat failed" });
        await alertJustin("LetsPoker cash seat failed", `player=${row.player_name} ${seat.error ?? buyinRes?.error}`);
      }
      results.push({ roster: row.id, name: row.player_name, ok, table: slot.tableId, seat: slot.seatIndex });
    }
  }
  const ok = results.every((r: any) => r.dryRun || r.skipped || r.ok);
  return json({ ok, mode: "seat", dryRun: opts.dryRun, results }, ok ? 200 : 502);
}

/* -------------------------------- push ------------------------------- */
async function runPush(cookie: string, sgid: string, clubId: string,
  opts: { planId?: string; date?: string; templateParts?: string[]; slot?: string; dryRun: boolean }): Promise<Response> {
  const templateParts = opts.templateParts ?? env("CASH_PUSH_TEMPLATE_PARTS")?.split(",").map((s) => s.trim()).filter(Boolean) ?? CASH_TEMPLATE_PARTS;
  const plans = await loadPlans({ planId: opts.planId, date: opts.date ?? perthDate(0) });
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });
  const results: unknown[] = [];
  for (const p of plans) {
    const eventId = await resolveCashEventId(cookie, sgid, clubId, p.event_date);
    if (!eventId) { results.push({ planId: p.id, skipped: true, reason: "no cash event for date" }); continue; }
    const tables = tableState(await getCashLog(cookie, sgid, clubId, eventId)).tables;
    if (!tables.length) { results.push({ planId: p.id, eventId, skipped: true, reason: "no open tables" }); continue; }
    const slotKey = opts.slot ?? p.event_date;
    for (const t of tables) {
      if (opts.dryRun) { results.push({ planId: p.id, table: t.tableId, dryRun: true, wouldPush: { eventId, tableId: t.tableId, templateParts } }); continue; }
      const claim = await rest(`/rest/v1/cash_fired`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ event_id: eventId, slot: `push-${t.tableId}-${slotKey}` }) });
      const claimed = (await claim.json().catch(() => []));
      if (!Array.isArray(claimed) || !claimed.length) { results.push({ planId: p.id, table: t.tableId, skipped: true, reason: "already pushed this slot" }); continue; }
      const r = await gql(cookie, sgid, "sendCashPushNotification", CASH_PUSH, { clubId, tableId: t.tableId, tournamentEventId: eventId, templateParts });
      await logCash({ source: "push", op: "push", ref: eventId, http_status: r.status, ok: r.ok, detail: `push table=${t.tableId} -> ${r.ok ? "OK" : (r.error ?? r.text.slice(0, 160))}` });
      if (!r.ok) { await rest(`/rest/v1/cash_fired?event_id=eq.${eventId}&slot=eq.${encodeURIComponent(`push-${t.tableId}-${slotKey}`)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); await alertJustin("LetsPoker cash push failed", `table=${t.tableId} ${r.error}`); }
      results.push({ planId: p.id, table: t.tableId, ok: r.ok, error: r.error });
    }
  }
  const ok = results.every((r: any) => r.dryRun || r.skipped || r.ok);
  return json({ ok, mode: "push", dryRun: opts.dryRun, results }, ok ? 200 : 502);
}

/* ------------------------------ prefill ------------------------------ */
async function runPrefill(opts: { horizonDays?: number; lookbackDays?: number }): Promise<Response> {
  const res = await rest(`/rest/v1/rpc/prefill_cash_from_history`, { method: "POST", body: JSON.stringify({ horizon_days: opts.horizonDays ?? 14, lookback_days: opts.lookbackDays ?? 45 }) });
  const text = await res.text();
  let rows: unknown = text;
  try { rows = JSON.parse(text); } catch { /* */ }
  await logCash({ source: "prefill", op: "prefill", ref: null, http_status: res.status, ok: res.ok, detail: `prefill ${res.ok ? "ok" : "failed"}: ${text.slice(0, 300)}` });
  return json({ ok: res.ok, mode: "prefill", results: rows }, res.ok ? 200 : 502);
}

/* -------------------------------- tick ------------------------------- */
async function runTick(cookie: string, sgid: string, clubId: string, dryRun: boolean): Promise<Response> {
  const date = perthDate(0);
  const plans = await loadPlans({ date });
  const out: unknown[] = [];
  for (const p of plans) {
    const o = await runOpen(cookie, sgid, clubId, { planId: p.id, dryRun });
    out.push({ planId: p.id, open: await o.json() });
    const s = await runSeat(cookie, sgid, clubId, { planId: p.id, dryRun });
    out.push({ planId: p.id, seat: await s.json() });
  }
  return json({ ok: true, mode: "tick", date, dryRun, plans: plans.length, out });
}

/* -------------------------------- log -------------------------------- */
async function runLog(cookie: string, sgid: string, clubId: string, opts: { date?: string }): Promise<Response> {
  const date = opts.date ?? perthDate(0);
  const eventId = await resolveCashEventId(cookie, sgid, clubId, date);
  if (!eventId) return json({ ok: true, date, eventId: null, reason: "no cash event for date" });
  const log = await getCashLog(cookie, sgid, clubId, eventId);
  const st = tableState(log);
  return json({ ok: true, date, eventId, tables: st.tables, seatedCount: st.seatedPlayers.size, freeSeats: freeSlots(st).length });
}

/* -------------------------------- serve ------------------------------ */
Deno.serve(async (req) => {
  const cookie = await getCookie();
  const sgid = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  let body: any = {};
  try { if (req.headers.get("content-type")?.includes("application/json")) body = await req.json(); } catch { /* */ }
  const mode = typeof body.mode === "string" ? body.mode : "log";
  // Outward-facing ops default dryRun TRUE unless explicitly disabled.
  const dryRun = (mode === "seat" || mode === "push" || mode === "tick") ? body.dryRun !== false : body.dryRun === true;

  if (mode === "prefill") return await runPrefill({ horizonDays: body.horizonDays, lookbackDays: body.lookbackDays });

  if (!cookie) {
    await logCash({ source: mode, op: mode, ref: null, http_status: null, ok: false, detail: "no cookie" });
    await alertJustin("LetsPoker cash misconfigured", "no LetsPoker cookie");
    return json({ ok: false, error: "no LetsPoker cookie (letspoker_auth / LETSPOKER_COOKIE)" }, 500);
  }

  switch (mode) {
    case "log": return await runLog(cookie, sgid, clubId, { date: body.date });
    case "open": return await runOpen(cookie, sgid, clubId, { planId: body.planId, date: body.date, dryRun, start: body.start === true });
    case "seat": return await runSeat(cookie, sgid, clubId, { planId: body.planId, date: body.date, dryRun, buyin: body.buyin === true, buyinPct: body.buyinPct, notes: body.notes });
    case "push": return await runPush(cookie, sgid, clubId, { planId: body.planId, date: body.date, templateParts: body.templateParts, slot: body.slot, dryRun });
    case "tick": return await runTick(cookie, sgid, clubId, dryRun);
    default: return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
  }
});
