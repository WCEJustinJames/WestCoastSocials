// LetsPoker cash automation — headless companion to letspoker-push.
//
// Cash control is ALL done via one mutation, createTournamentLogItem, on the
// day's cash event (a tournament-shaped container resolved from getEventList as
// the entry with an empty eventName on that Perth date). See CASH_API.md.
//
// Modes (request body { "mode": ... }):
//   - "prefill" -> prefill upcoming rosters from the same weekly game last week.
//   - "open"    -> open the plan's tables_spec via AddTable. dryRun supported.
//                  Creates the day's cash container (createTournament with an
//                  empty name — the shape every existing cash day has) when it
//                  doesn't exist yet, and derives an empty tables_spec from the
//                  same weekly game's most recent run — the prefill only fills
//                  rosters, so without these nothing ever auto-opened.
//   - "seat"    -> Register -> Seat (-> AddCashBuyin) the plan's roster names
//                  into free seats on the day's cash tables. dryRun DEFAULT true.
//   - "push"    -> sendCashPushNotification per open table. dryRun DEFAULT true.
//   - "tick"    -> orchestrate open + seat for today's plans (cron).
//   - "finish"  -> mark a cash day Finished (Command{finish}). Default yesterday.
//   - "log"     -> read the cash event's tournament log (debug).
//
// Outward-facing / money-touching ops (seat, push) default to dryRun.
//
// AUTH: this function is automation-only — every caller must present the shared
// automation secret in the x-automation-secret header (the pg_cron jobs do).
// The Supabase gateway's verify_jwt check is NOT an authorisation control here:
// the publishable anon key is itself a structurally valid JWT, so without the
// gate below anyone holding the public key could drive cash operations.
// Rotation is a one-row UPDATE, no redeploy:
//   update public.wcp_admin_config set value = encode(digest('<new>','sha256'),'hex')
//   where key = 'automation_secret_sha256';

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const CREATE_LOG = `mutation createTournamentLogItem($data: CreateTournamentLogInput!, $tournamentId: ID!, $clubId: ID!) {
  createTournamentLogItem(data: $data, tournamentId: $tournamentId, clubId: $clubId) {
    id parentLogId playerId eventType __typename
  }
}`;

// Creating the day's cash container: it's a tournament with an EMPTY name at
// Perth midnight — the exact shape every existing cash day has in getEventList.
const CREATE_TOURNAMENT = `mutation createTournament($clubId: ID!, $name: String!, $scheduledDate: DateTime!) {
  createTournament(clubId: $clubId, name: $name, scheduledDate: $scheduledDate) {
    id
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

// Cash pushes accept a DIFFERENT token set from tournament pushes. Probed live
// 2026-08-13 (canary method: every call carried a known-bad token so the API
// rejected the whole list and sent nothing; tokens absent from the "Unknown
// notification template part(s)" error are valid):
//   valid:    tableName, playerCount, buyin, averageStack   (lowercase-i buyin!)
//   rejected: eventName, location, timeRelative, guarantee, prizePool,
//             lateEntry, identifier, stakes, blinds, gameType, tableSize,
//             buyIn, minBuyIn, maxBuyIn, venue, startTime, seats, ... (see log)
// Override per-call via body.templateParts or env CASH_PUSH_TEMPLATE_PARTS.
const CASH_TEMPLATE_PARTS = ["tableName", "playerCount", "buyin"];

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

/* ------------------------- automation-secret gate -------------------- */
// Shared with letspoker-inbox-sync / -cover / -harvest and the same shape as
// winners-photo-upload: the plaintext secret never lives in this source, only
// its SHA-256, and that comes from the database so rotation needs no redeploy.

const AUTOMATION_SECRET_KEY = "automation_secret_sha256";
const DIGEST_TTL_MS = 60_000;
let cachedDigest = "";
let cachedDigestAt = 0;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent, constant-time comparison of two hex digests. */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Expected secret digest, cached briefly so the gate costs one round trip a
 *  minute rather than one per request. Empty string means "deny everything". */
async function expectedAutomationDigest(): Promise<string> {
  if (cachedDigest && Date.now() - cachedDigestAt < DIGEST_TTL_MS) return cachedDigest;
  try {
    const res = await rest(`/rest/v1/wcp_admin_config?key=eq.${AUTOMATION_SECRET_KEY}&select=value`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      cachedDigest = String(rows[0].value).toLowerCase();
      cachedDigestAt = Date.now();
      return cachedDigest;
    }
  } catch (_e) { /* fall through to env */ }
  const envSecret = env("AUTOMATION_SECRET");
  return envSecret ? await sha256Hex(envSecret) : "";
}

/** Fails closed: no header, no configured digest, or a mismatch all deny. */
async function isAutomationCaller(req: Request): Promise<boolean> {
  const presented = req.headers.get("x-automation-secret");
  if (!presented) return false;
  const expected = await expectedAutomationDigest();
  if (!expected) return false;
  return digestsMatch(await sha256Hex(presented), expected);
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

// Create the day's cash container: a tournament with an EMPTY name scheduled at
// Perth midnight of the date — identical to how existing cash days look.
async function createCashDay(cookie: string, sgid: string, clubId: string, date: string):
  Promise<{ eventId: string | null; error: string | null }> {
  const scheduledDate = new Date(date + "T00:00:00+08:00").toISOString();
  const r = await gql(cookie, sgid, "createTournament", CREATE_TOURNAMENT, { clubId, name: "", scheduledDate });
  const id = firstData(r.text)?.createTournament?.id ?? null;
  await logCash({ source: "open", op: "create-day", ref: date, http_status: r.status, ok: r.ok && !!id, detail: `createTournament(name:\"\", ${scheduledDate}) -> ${id ?? (r.error ?? r.text.slice(0, 120))}` });
  if (r.ok && id) return { eventId: String(id), error: null };
  return { eventId: null, error: r.error ?? `status ${r.status}` };
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

// Rebuild an AddTable spec from a live table parsed out of a past day's log.
function specFromTable(t: TableInfo): any {
  const spec: any = { tableSize: t.tableSize };
  if (t.identifier) spec.identifier = t.identifier;
  if (t.stake) spec.stake = t.stake;
  if (t.gameType) spec.gameType = t.gameType;
  if (t.buyInLimits) spec.buyInLimits = t.buyInLimits;
  return spec;
}

// "Same tables as last week": walk back same-weekday dates until we find a cash
// day that actually ran tables, and copy their specs. The prefill only fills
// rosters (tables_spec arrives empty), so this is how "open" knows WHAT to open.
async function deriveTablesSpec(cookie: string, sgid: string, clubId: string, date: string, lookbackWeeks = 5):
  Promise<{ specs: any[]; sourceDate: string } | null> {
  for (let w = 1; w <= lookbackWeeks; w++) {
    const srcDate = new Date(new Date(date + "T00:00:00+08:00").getTime() - w * 7 * 86_400_000 + 8 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const eventId = await resolveCashEventId(cookie, sgid, clubId, srcDate);
    if (!eventId) continue;
    const tables = tableState(await getCashLog(cookie, sgid, clubId, eventId)).tables;
    if (tables.length) return { specs: tables.map(specFromTable), sourceDate: srcDate };
  }
  return null;
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
  /** Permit gate: never auto-open/seat before this instant. Null = first tick. */
  open_from: string | null;
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
// Open the day's cash tables via AddTable. Creates the day's cash container
// (createTournament, empty name) when it doesn't exist, and derives an empty
// tables_spec from the same weekly game's last run (persisted for audit).
// Idempotent: skips whenever the day already has live tables, so the 20-minute
// tick can never double-open. Auto-starts the day if no one has.
async function runOpen(cookie: string, sgid: string, clubId: string, opts: { planId?: string; date?: string; dryRun: boolean; start?: boolean }): Promise<Response> {
  const plans = await loadPlans(opts);
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });
  const results: unknown[] = [];
  for (const p of plans) {
    let eventId = await resolveCashEventId(cookie, sgid, clubId, p.event_date);

    if (!eventId && opts.dryRun) {
      const d0 = await deriveTablesSpec(cookie, sgid, clubId, p.event_date);
      const specs0 = Array.isArray(p.tables_spec) && p.tables_spec.length ? p.tables_spec : (d0?.specs ?? []);
      results.push({ planId: p.id, dryRun: true, wouldCreateDay: true, wouldStart: true, derivedFrom: d0?.sourceDate ?? null, wouldAddTables: specs0 });
      continue;
    }
    if (!eventId) {
      // No cash container for the date — create it (empty-name tournament at
      // Perth midnight, the shape every existing cash day has).
      const made = await createCashDay(cookie, sgid, clubId, p.event_date);
      eventId = made.eventId ?? await resolveCashEventId(cookie, sgid, clubId, p.event_date);
      if (!eventId) {
        await alertJustin("LetsPoker cash open failed", `No cash day for ${p.event_date} and createTournament failed: ${made.error}`);
        results.push({ planId: p.id, skipped: true, reason: `no cash event for date (create failed: ${made.error})` });
        continue;
      }
    }

    // Never double-open: if the day already has live tables (auto OR staff-made),
    // there's nothing to do. Also gives us the started state for auto-start.
    const log = await getCashLog(cookie, sgid, clubId, eventId);
    const state = tableState(log);
    if (state.tables.length) { results.push({ planId: p.id, eventId, skipped: true, reason: `tables already open (${state.tables.length})` }); continue; }
    const started = log.some((e) => e.eventType === "Command" && e.eventData?.command?.start === true);

    let specs = Array.isArray(p.tables_spec) ? p.tables_spec : [];
    let derivedFrom: string | null = null;
    if (!specs.length) {
      const d = await deriveTablesSpec(cookie, sgid, clubId, p.event_date);
      if (d) {
        specs = d.specs;
        derivedFrom = d.sourceDate;
        // Persist so the plan shows what was opened (and re-runs agree).
        await rest(`/rest/v1/cash_plan?id=eq.${p.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tables_spec: specs }) });
      }
    }
    if (!specs.length) {
      await logCash({ source: "open", op: "open", ref: p.id, http_status: null, ok: false, detail: `no tables_spec and no prior ${p.event_date} weekday run to copy` });
      results.push({ planId: p.id, eventId, skipped: true, reason: "no tables_spec and no prior week to copy" });
      continue;
    }
    if (opts.dryRun) { results.push({ planId: p.id, eventId, dryRun: true, derivedFrom, wouldStart: !started, wouldAddTables: specs }); continue; }

    const fired: unknown[] = [];
    if (!started || opts.start) {
      const c = await createLogItem(cookie, sgid, clubId, eventId, { eventType: "Command", eventData: { command: { start: true } } });
      await logCash({ source: "open", op: "start", ref: p.id, http_status: c.status, ok: c.ok, detail: `start day ${p.event_date} -> ${c.ok ? c.id : c.error}` });
      fired.push({ op: "start", ok: c.ok, error: c.error });
    }
    for (const spec of specs) {
      const c = await createLogItem(cookie, sgid, clubId, eventId, { eventType: "AddTable", eventData: spec });
      await logCash({ source: "open", op: "open", ref: p.id, http_status: c.status, ok: c.ok, detail: `AddTable${derivedFrom ? ` (copied from ${derivedFrom})` : ""} ${JSON.stringify(spec).slice(0, 180)} -> ${c.ok ? c.id : c.error}` });
      fired.push({ op: "AddTable", tableId: c.id, ok: c.ok, error: c.error });
    }
    const allOk = fired.every((f: any) => f.ok);
    if (!allOk) await alertJustin("LetsPoker cash open failed", `Plan ${p.id} (${p.event_date}): ${JSON.stringify(fired)}`);
    results.push({ planId: p.id, eventId, ok: allOk, derivedFrom, fired });
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

// 75-85% of a table's max buy-in (in chips). Default 80%.
function buyinChips(table: TableInfo, pct = 0.8): number {
  const bb = Array.isArray(table.stake?.blinds) ? Number(table.stake.blinds[table.stake.blinds.length - 1]) : 0;
  const maxBB = Number(table.buyInLimits?.max ?? 0);
  const max = bb * maxBB;
  return max > 0 ? Math.round(max * pct) : 0;
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
// Orchestrate open + seat for today's plans. A plan carrying open_from (the
// venue's permitted cash start) is HELD — not opened, not seated — until that
// instant passes; open_from null keeps the original behaviour (first tick).
async function runTick(cookie: string, sgid: string, clubId: string, dryRun: boolean): Promise<Response> {
  const date = perthDate(0);
  const plans = await loadPlans({ date });
  const out: unknown[] = [];
  for (const p of plans) {
    if (p.open_from && Date.now() < new Date(p.open_from).getTime()) {
      out.push({ planId: p.id, held: true, reason: `permit gate: opens at ${p.open_from}` });
      continue;
    }
    const o = await runOpen(cookie, sgid, clubId, { planId: p.id, dryRun });
    out.push({ planId: p.id, open: await o.json() });
    const s = await runSeat(cookie, sgid, clubId, { planId: p.id, dryRun });
    out.push({ planId: p.id, seat: await s.json() });
  }
  return json({ ok: true, mode: "tick", date, dryRun, plans: plans.length, out });
}

/* ------------------------------- finish ------------------------------ */
// Mark a cash day Finished (Command{finish}). Default date = yesterday Perth
// (the day that just ended). Idempotent: skips if not started / already finished.
async function runFinish(cookie: string, sgid: string, clubId: string, opts: { date?: string; dryRun: boolean }): Promise<Response> {
  const date = opts.date ?? perthDate(-1);
  const eventId = await resolveCashEventId(cookie, sgid, clubId, date);
  if (!eventId) return json({ ok: true, date, skipped: true, reason: "no cash event for date" });
  const cmds = (await getCashLog(cookie, sgid, clubId, eventId)).filter((e) => e.eventType === "Command");
  const started = cmds.some((c) => c.eventData?.command?.start === true);
  const finished = cmds.some((c) => c.eventData?.command?.finish === true);
  if (!started) return json({ ok: true, date, eventId, skipped: true, reason: "day not started" });
  if (finished) return json({ ok: true, date, eventId, skipped: true, reason: "already finished" });
  if (opts.dryRun) return json({ ok: true, date, eventId, dryRun: true, wouldFinish: true });
  const c = await createLogItem(cookie, sgid, clubId, eventId, { eventType: "Command", eventData: { command: { finish: true } } });
  await logCash({ source: "finish", op: "finish", ref: eventId, http_status: c.status, ok: c.ok, detail: `finish ${date} -> ${c.ok ? c.id : c.error}` });
  if (!c.ok) await alertJustin("LetsPoker cash finish failed", `date=${date} ${c.error}`);
  return json({ ok: c.ok, date, eventId, finished: c.ok }, c.ok ? 200 : 502);
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
  // Automation-only. Checked before anything else touches credentials, the
  // LetsPoker API or the request body.
  if (!await isAutomationCaller(req)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

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
    case "finish": return await runFinish(cookie, sgid, clubId, { date: body.date, dryRun: body.dryRun === true });
    default: return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
  }
});
