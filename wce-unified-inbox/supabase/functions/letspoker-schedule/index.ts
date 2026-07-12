// LetsPoker recurring events — stage the club's regular weekly games for the
// rest of the month behind a review gate, then publish the approved ones.
//
// LetsPoker tournaments (unlike cash tables) expose no private/public flag, and
// there is no un-create, so we DON'T create straight onto the live calendar.
// Instead every missing weekly occurrence is staged in our own DB
// (public.letspoker_scheduled_events, status='pending') — a private review list
// that players can't see — and only the rows Justin APPROVES are created on
// LetsPoker via createTournament (the mutation letspoker-cash already uses).
//
// Flow:  plan → queue → review → approve/reject → publish
//
// Modes (request body { "mode": ... }):
//   - "plan"    -> DEFAULT. Read-only: detect the weekly series and the dates
//                  each is missing through end of month. Touches nothing.
//   - "queue"   -> Stage the missing occurrences into the queue as 'pending'
//                  (idempotent — a date already on the LP calendar or already
//                  queued is skipped). Writes only to our DB; nothing on LP.
//   - "review"  -> Read-only: list queue rows (default status='pending').
//   - "approve" -> Mark selected pending rows 'approved'.  Selector required.
//   - "reject"  -> Mark selected pending rows 'rejected'.  Selector required.
//   - "publish" -> Create the 'approved' rows on LetsPoker via createTournament
//                  and record the id. dryRun DEFAULT true (this is the only mode
//                  that touches the live calendar). Re-checks the calendar first
//                  and skips anything already there.
//
// Selectors (approve / reject / publish): choose which rows to act on —
//   ids: [1,2,3]     specific queue-row ids
//   only: "woodvale" case-insensitive substring on the series name
//   all: true        every matching row in the status/date window
//   from / to        YYYY-MM-DD date window (default: all future)
// approve/reject require a selector; publish with no selector = all 'approved'.
//
// Detection options (plan / queue): from, to (default tomorrow → end of Perth
// month), recentDays (a series must have run within this many days to count as
// alive; default 8, so a deliberately-skipped week isn't auto-resumed), only.
//
// Failures log to cash_open_log (source "schedule") and alert Justin.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";
const QUEUE_TABLE = "letspoker_scheduled_events";

const LIST_QUERY = `query getList($clubId: ID!, $startDate: DateTime!, $endDate: DateTime!, $includeCash: Boolean!) {
  events: getEventList(clubId: $clubId, startDate: $startDate, endDate: $endDate, includeCash: $includeCash) {
    id scheduledDate config { general { eventName } buyin { variants { prizeAdded feeAdded bountyCost } } }
  }
}`;

const CREATE_TOURNAMENT = `mutation createTournament($clubId: ID!, $name: String!, $scheduledDate: DateTime!) {
  createTournament(clubId: $clubId, name: $name, scheduledDate: $scheduledDate) {
    id
  }
}`;

const LOOKBACK_DAYS = 35; // history window for series detection (5 weeks)

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

/* ------------------------------ time / dates -------------------------- */
// Perth is UTC+8, no DST.
function perthDate(dayOffset = 0): string {
  return new Date(Date.now() + (8 * 60 + dayOffset * 24 * 60) * 60 * 1000).toISOString().slice(0, 10);
}
function perthDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function perthTimeOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
}
function perthEndOfMonth(): string {
  const today = perthDate(0);
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${today.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}
// Pure date arithmetic on YYYY-MM-DD strings (timezone-free).
function weekdayOf(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}
function addDays(date: string, days: number): string {
  return new Date(new Date(date + "T00:00:00Z").getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
function isDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* ------------------------------ LP transport -------------------------- */
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

// Fire one GraphQL operation (batched-array form, as the LP admin client sends).
async function gql(cookie: string, sgid: string, operationName: string | null, query: string, variables: unknown):
  Promise<{ status: number | null; text: string; ok: boolean; unauth: boolean; error: string | null }> {
  let status: number | null = null, text = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST", headers: headers(cookie, sgid),
      body: JSON.stringify([{ operationName, query, variables }]),
    });
    status = res.status; text = await res.text();
  } catch (e) {
    return { status: null, text: "", ok: false, unauth: false, error: `network error: ${e}` };
  }
  const unauth = looksUnauthenticated(status, text);
  const gqlErr = firstGraphqlError(text);
  return { status, text, ok: status === 200 && !unauth && !gqlErr, unauth, error: gqlErr };
}

/* ------------------------------ Supabase ------------------------------ */
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return await fetch(`${url}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

async function logSchedule(row: { op: string; ref: string | null; http_status: number | null; ok: boolean; detail: string }) {
  try {
    await rest(`/rest/v1/cash_open_log`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ source: "schedule", ...row }),
    });
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
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, text: message }),
    }).catch((e) => console.error("alert webhook failed:", e)));
  }
  if (tasks.length === 0) console.error("[ALERT — no channel] " + subject + " :: " + message);
  await Promise.allSettled(tasks);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

/* -------------------------- series detection -------------------------- */

type LPEvent = { id: string; scheduledDate: string; name: string; date: string; time: string; buyIn: number | null };
type Series = {
  name: string; weekday: number; time: string;
  lastSeen: string; buyIn: number | null;
  scheduled: string[];       // future dates already on the calendar
  missing: string[];         // dates with no event yet
};

function buyInOf(e: any): number | null {
  const v = e?.config?.buyin?.variants?.[0];
  if (!v) return null;
  const n = Number(v.prizeAdded ?? 0) + Number(v.feeAdded ?? 0) + Number(v.bountyCost ?? 0);
  return Number.isFinite(n) ? n : null;
}

async function fetchCalendar(cookie: string, sgid: string, clubId: string, startDate: string, endDate: string): Promise<LPEvent[]> {
  const r = await gql(cookie, sgid, "getList", LIST_QUERY, {
    clubId,
    startDate: new Date(startDate + "T00:00:00+08:00").toISOString(),
    endDate: new Date(endDate + "T23:59:59+08:00").toISOString(),
    includeCash: false,
  });
  if (!r.ok) throw new Error(r.error ?? `getEventList failed (status ${r.status}${r.unauth ? ", unauthenticated" : ""})`);
  const events = (firstData(r.text)?.events ?? []) as any[];
  return events
    .filter((e) => e?.id && e?.scheduledDate)
    .map((e) => ({
      id: String(e.id),
      scheduledDate: String(e.scheduledDate),
      name: String(e?.config?.general?.eventName ?? "").trim(),
      date: perthDateOf(e.scheduledDate),
      time: perthTimeOf(e.scheduledDate),
      buyIn: buyInOf(e),
    }))
    .filter((e) => e.name !== ""); // empty name = cash-day container, not a tournament
}

// Detect weekly series from history and compute the missing dates in [from, to].
function detectSeries(events: LPEvent[], from: string, to: string, recentDays: number, only: string | null): Series[] {
  const today = perthDate(0);
  const byKey = new Map<string, LPEvent[]>();
  for (const e of events) {
    const key = `${weekdayOf(e.date)}|${e.name.toLowerCase()}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(e);
  }

  const out: Series[] = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    const past = group.filter((e) => e.date <= today);
    if (!past.length) continue; // future-only names have no cadence to repeat
    const last = past[past.length - 1];
    if (addDays(last.date, recentDays) < today) continue; // series has gone quiet — don't resurrect it
    if (only && !last.name.toLowerCase().includes(only.toLowerCase())) continue;

    const scheduledDates = new Set(group.map((e) => e.date));
    const weekday = weekdayOf(last.date);
    const missing: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (weekdayOf(d) === weekday && !scheduledDates.has(d)) missing.push(d);
    }
    out.push({
      name: last.name, weekday, time: last.time, lastSeen: last.date, buyIn: last.buyIn,
      scheduled: group.filter((e) => e.date > today).map((e) => e.date),
      missing,
    });
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.name.localeCompare(b.name));
}

async function buildPlan(cookie: string, sgid: string, clubId: string, body: any):
  Promise<{ from: string; to: string; recentDays: number; series: Series[] }> {
  const from = isDate(body?.from) ? body.from : perthDate(1);
  const to = isDate(body?.to) ? body.to : perthEndOfMonth();
  const recentDays = Number.isFinite(body?.recentDays) ? Number(body.recentDays) : 8;
  const only = typeof body?.only === "string" ? body.only : null;
  const events = await fetchCalendar(cookie, sgid, clubId, perthDate(-LOOKBACK_DAYS), to);
  return { from, to, recentDays, series: detectSeries(events, from, to, recentDays, only) };
}

/* -------------------------------- queue ------------------------------- */
// Stage every missing occurrence as a 'pending' queue row. Idempotent: the
// (event_date, series_name) unique key + ignore-duplicates means a re-run adds
// only genuinely new occurrences and never disturbs an already-decided row.
async function runQueue(cookie: string, sgid: string, clubId: string, body: any): Promise<Response> {
  let plan;
  try {
    plan = await buildPlan(cookie, sgid, clubId, body);
  } catch (e) {
    const detail = `queue: calendar read failed — ${e}`;
    await logSchedule({ op: "queue", ref: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker schedule queue failed", detail);
    return json({ ok: false, error: String(e) }, 502);
  }

  const source = `queue ${plan.from}..${plan.to}`;
  const rows = plan.series.flatMap((s) =>
    s.missing.map((date) => ({
      series_name: s.name,
      event_date: date,
      start_time: s.time,
      scheduled_at: new Date(`${date}T${s.time}:00+08:00`).toISOString(),
      weekday: s.weekday,
      buy_in: s.buyIn,
      status: "pending",
      source,
    })));

  if (!rows.length) {
    await logSchedule({ op: "queue", ref: source, http_status: 200, ok: true, detail: "nothing to queue (calendar already full)" });
    return json({ ok: true, mode: "queue", from: plan.from, to: plan.to, staged: 0, alreadyQueued: 0, rows: [] });
  }

  // ignore-duplicates => only genuinely new (event_date, series_name) rows come
  // back; existing pending/approved/created rows are left exactly as they are.
  const res = await rest(`/rest/v1/${QUEUE_TABLE}?on_conflict=event_date,series_name`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = `queue: insert failed ${res.status} ${(await res.text()).slice(0, 200)}`;
    await logSchedule({ op: "queue", ref: source, http_status: res.status, ok: false, detail });
    await alertJustin("LetsPoker schedule queue: DB insert failed", detail);
    return json({ ok: false, error: detail }, 500);
  }
  const inserted = (await res.json().catch(() => [])) as any[];

  const staged = Array.isArray(inserted) ? inserted.length : 0;
  await logSchedule({ op: "queue", ref: source, http_status: 200, ok: true, detail: `staged ${staged} of ${rows.length} candidate(s)` });
  return json({
    ok: true, mode: "queue", from: plan.from, to: plan.to,
    staged, alreadyQueued: rows.length - staged,
    rows: inserted.map((r) => ({ id: r.id, name: r.series_name, date: r.event_date, time: r.start_time, status: r.status })),
  });
}

/* -------------------------------- review ------------------------------ */
async function runReview(body: any): Promise<Response> {
  const status = typeof body?.status === "string" ? body.status : "pending";
  const parts = [`select=id,series_name,event_date,start_time,buy_in,status,tournament_event_id,note,created_at,decided_at,published_at`];
  if (status !== "all") parts.push(`status=eq.${encodeURIComponent(status)}`);
  if (isDate(body?.from)) parts.push(`event_date=gte.${body.from}`);
  if (isDate(body?.to)) parts.push(`event_date=lte.${body.to}`);
  if (typeof body?.only === "string" && body.only) parts.push(`series_name=ilike.*${encodeURIComponent(body.only)}*`);
  parts.push(`order=event_date.asc,series_name.asc`);

  const res = await rest(`/rest/v1/${QUEUE_TABLE}?${parts.join("&")}`);
  if (!res.ok) return json({ ok: false, error: `review read failed: ${res.status} ${(await res.text()).slice(0, 200)}` }, 500);
  const rows = (await res.json().catch(() => [])) as any[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return json({ ok: true, mode: "review", filter: { status, from: body?.from ?? null, to: body?.to ?? null, only: body?.only ?? null }, count: rows.length, byStatus, rows });
}

/* ---------------------- selectors for decide/publish ------------------ */
// Build the PostgREST filter for the rows a decide/publish call should touch.
// `fromStatus` scopes to the states a transition is valid from (pending for
// approve/reject, approved for publish). Returns null when a required selector
// is missing.
function selectorParts(body: any, fromStatus: string, requireSelector: boolean): string[] | null {
  const parts: string[] = [];
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => Number.isInteger(x)) : [];
  const hasOnly = typeof body?.only === "string" && body.only.length > 0;
  const all = body?.all === true;

  if (requireSelector && ids.length === 0 && !hasOnly && !all) return null;

  parts.push(`status=eq.${fromStatus}`);
  if (ids.length) parts.push(`id=in.(${ids.join(",")})`);
  if (hasOnly) parts.push(`series_name=ilike.*${encodeURIComponent(body.only)}*`);
  if (isDate(body?.from)) parts.push(`event_date=gte.${body.from}`);
  if (isDate(body?.to)) parts.push(`event_date=lte.${body.to}`);
  return parts;
}

async function runDecide(body: any, action: "approve" | "reject"): Promise<Response> {
  const parts = selectorParts(body, "pending", true);
  if (!parts) return json({ ok: false, error: `select rows to ${action} with ids:[…], only:"name", or all:true` }, 400);
  const newStatus = action === "approve" ? "approved" : "rejected";
  const now = new Date().toISOString();
  const patch = { status: newStatus, decided_at: now, updated_at: now };
  const res = await rest(`/rest/v1/${QUEUE_TABLE}?${parts.join("&")}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
  });
  if (!res.ok) return json({ ok: false, error: `${action} failed: ${res.status} ${(await res.text()).slice(0, 200)}` }, 500);
  const rows = (await res.json().catch(() => [])) as any[];
  await logSchedule({ op: action, ref: null, http_status: 200, ok: true, detail: `${action}d ${rows.length} row(s)` });
  return json({ ok: true, mode: action, changed: rows.length, rows });
}

/* -------------------------------- publish ----------------------------- */
// Create the 'approved' rows on LetsPoker. dryRun defaults true. Re-reads the
// live calendar first and skips any date/name already present, so a game added
// by hand in the meantime is never duplicated (LP has no un-create).
async function runPublish(cookie: string, sgid: string, clubId: string, body: any): Promise<Response> {
  const dryRun = body?.dryRun !== false;
  const parts = selectorParts(body, "approved", false)!; // publish w/o selector = all approved
  parts.push(`select=id,series_name,event_date,start_time,scheduled_at`);
  parts.push(`order=event_date.asc,series_name.asc`);

  const listRes = await rest(`/rest/v1/${QUEUE_TABLE}?${parts.join("&")}`);
  if (!listRes.ok) return json({ ok: false, error: `publish: queue read failed ${listRes.status}` }, 500);
  const approved = (await listRes.json().catch(() => [])) as any[];
  if (!approved.length) return json({ ok: true, mode: "publish", dryRun, created: 0, results: [], note: "no approved rows to publish" });

  // Guard against duplicates: pull the live calendar over the span we're about
  // to write and index existing events by date|lowercased-name.
  const dates = approved.map((r) => r.event_date).sort();
  let present = new Set<string>();
  try {
    const cal = await fetchCalendar(cookie, sgid, clubId, dates[0], dates[dates.length - 1]);
    present = new Set(cal.map((e) => `${e.date}|${e.name.toLowerCase()}`));
  } catch (e) {
    const detail = `publish: calendar re-check failed — ${e}`;
    await logSchedule({ op: "publish", ref: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker schedule publish failed", detail);
    return json({ ok: false, error: String(e) }, 502);
  }

  const results: unknown[] = [];
  let created = 0, skipped = 0, failures = 0;
  for (const row of approved) {
    const already = present.has(`${row.event_date}|${row.series_name.toLowerCase()}`);
    if (already) {
      skipped++;
      if (!dryRun) {
        await rest(`/rest/v1/${QUEUE_TABLE}?id=eq.${row.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "skipped", note: "already on LP calendar at publish time", updated_at: new Date().toISOString() }),
        });
      }
      results.push({ id: row.id, name: row.series_name, date: row.event_date, skipped: true, reason: "already on calendar" });
      continue;
    }
    if (dryRun) {
      results.push({ id: row.id, name: row.series_name, date: row.event_date, time: row.start_time, dryRun: true, wouldCreate: row.scheduled_at });
      continue;
    }
    const r = await gql(cookie, sgid, "createTournament", CREATE_TOURNAMENT, { clubId, name: row.series_name, scheduledDate: row.scheduled_at });
    const id = firstData(r.text)?.createTournament?.id ?? null;
    const ok = r.ok && !!id;
    if (!ok) failures++; else created++;
    await rest(`/rest/v1/${QUEUE_TABLE}?id=eq.${row.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify(ok
        ? { status: "created", tournament_event_id: String(id), published_at: new Date().toISOString(), note: null, updated_at: new Date().toISOString() }
        : { status: "failed", note: (r.error ?? `status ${r.status}`).slice(0, 300), updated_at: new Date().toISOString() }),
    });
    await logSchedule({ op: "create", ref: row.event_date, http_status: r.status, ok, detail: `createTournament("${row.series_name}", ${row.scheduled_at}) -> ${ok ? id : (r.error ?? r.text.slice(0, 120))}` });
    results.push({ id: row.id, name: row.series_name, date: row.event_date, time: row.start_time, ok, tournamentEventId: id, error: ok ? undefined : (r.error ?? `status ${r.status}`) });
  }

  if (failures) {
    await alertJustin("LetsPoker schedule publish: some creates failed",
      `${failures} createTournament call(s) failed. See ${QUEUE_TABLE} (status='failed') and cash_open_log source="schedule".`);
  }
  await logSchedule({
    op: "publish", ref: `${dates[0]}..${dates[dates.length - 1]}`, http_status: 200, ok: failures === 0,
    detail: dryRun ? `dry run — ${approved.length - skipped} would be created, ${skipped} already present` : `${created} created, ${skipped} skipped, ${failures} failed`,
  });
  return json({ ok: failures === 0, mode: "publish", dryRun, created: dryRun ? 0 : created, skipped, failed: failures, results }, failures ? 502 : 200);
}

/* --------------------------------- serve ------------------------------ */

Deno.serve(async (req) => {
  let body: any = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) body = await req.json();
  } catch { /* default plan mode */ }
  const mode = typeof body?.mode === "string" ? body.mode : "plan";

  // review/approve/reject touch only our DB (service role), no LP cookie needed.
  if (mode === "review") return await runReview(body);
  if (mode === "approve") return await runDecide(body, "approve");
  if (mode === "reject") return await runDecide(body, "reject");

  const cookie = await getCookie();
  if (!cookie) {
    const detail = "Missing config: no cookie in letspoker_auth and no LETSPOKER_COOKIE";
    await logSchedule({ op: mode, ref: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker schedule misconfigured", detail);
    return json({ ok: false, error: detail }, 500);
  }
  // Not secret (constant ids); overridable via env if they ever change.
  const sgid = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  if (mode === "queue") return await runQueue(cookie, sgid, clubId, body);
  if (mode === "publish") return await runPublish(cookie, sgid, clubId, body);

  // mode === "plan" (read-only default)
  try {
    const plan = await buildPlan(cookie, sgid, clubId, body);
    const toCreate = plan.series.reduce((a, s) => a + s.missing.length, 0);
    return json({ ok: true, mode: "plan", ...plan, toCreate });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
