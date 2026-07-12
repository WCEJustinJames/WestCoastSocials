// LetsPoker recurring events — fill the club calendar's regular weekly games
// for the rest of the month, headless.
//
// The club's schedule is week-shaped: each venue's game repeats on the same
// weekday at the same time ("Tuesday 7pm at the Woody"). This function reads
// the live LetsPoker calendar (getEventList), detects those weekly series from
// recent history, and creates the missing occurrences through end of month via
// createTournament — the same mutation the admin app fires, and the one
// letspoker-cash already uses for cash-day containers.
//
// Modes (request body { "mode": ... }):
//   - "plan"     -> DEFAULT. Read-only: list the detected weekly series and the
//                   dates each is missing through end of month. Writes nothing.
//   - "fill"     -> create the missing events. dryRun DEFAULT true (this is an
//                   outward-facing op — created events are player-visible).
//                   Pass { "dryRun": false } to really create.
//
// A filled event carries the series name and the same Perth wall-clock start
// time as its last run. Buy-in / blind structure are NOT copied — LetsPoker has
// no captured config-copy mutation, so createTournament sets name + start only
// and the club's defaults apply until the event is opened in the admin (same as
// how letspoker-cash seeds its cash-day containers).
//
// Options (all modes unless noted):
//   from        YYYY-MM-DD  first date to consider   (default: tomorrow, Perth)
//   to          YYYY-MM-DD  last date to consider    (default: end of Perth month)
//   recentDays  number      a series is "alive" only if it last ran within this
//                           many days (default 8 — a skipped week reads as
//                           deliberate and is NOT auto-resumed)
//   only        string      case-insensitive substring filter on event name
//
// Idempotent: a date that already has an event with the series' name is
// skipped, so re-runs (or a future cron) can never double-create. Failures log
// to cash_open_log (source "schedule") and alert Justin, matching house style.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

/* -------------------------------- plan -------------------------------- */

type LPEvent = { id: string; scheduledDate: string; name: string; date: string; time: string; buyIn: number | null };
type Series = {
  name: string; weekday: number; time: string;
  lastSeen: string; buyIn: number | null;
  scheduled: string[];       // future dates already on the calendar
  missing: string[];         // dates to create
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
  const from = typeof body?.from === "string" ? body.from : perthDate(1);
  const to = typeof body?.to === "string" ? body.to : perthEndOfMonth();
  const recentDays = Number.isFinite(body?.recentDays) ? Number(body.recentDays) : 8;
  const only = typeof body?.only === "string" ? body.only : null;
  const events = await fetchCalendar(cookie, sgid, clubId, perthDate(-LOOKBACK_DAYS), to);
  return { from, to, recentDays, series: detectSeries(events, from, to, recentDays, only) };
}

/* -------------------------------- fill -------------------------------- */
// Create every missing occurrence via createTournament. The new event carries
// the series name and the same Perth wall-clock start time as its last run;
// buy-in/structure config isn't copied (LetsPoker exposes no captured config
// mutation), so the club's defaults apply until the event is edited in admin.

async function runFill(cookie: string, sgid: string, clubId: string, body: any): Promise<Response> {
  const dryRun = body?.dryRun !== false; // outward-facing: default true
  let plan;
  try {
    plan = await buildPlan(cookie, sgid, clubId, body);
  } catch (e) {
    const detail = `fill: calendar read failed — ${e}`;
    await logSchedule({ op: "fill", ref: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker schedule fill failed", detail);
    return json({ ok: false, error: String(e) }, 502);
  }

  const results: unknown[] = [];
  let failures = 0;
  for (const s of plan.series) {
    for (const date of s.missing) {
      const scheduledDate = new Date(`${date}T${s.time}:00+08:00`).toISOString();
      if (dryRun) {
        results.push({ dryRun: true, wouldCreate: { name: s.name, date, time: s.time, scheduledDate } });
        continue;
      }
      const r = await gql(cookie, sgid, "createTournament", CREATE_TOURNAMENT, { clubId, name: s.name, scheduledDate });
      const id = firstData(r.text)?.createTournament?.id ?? null;
      const ok = r.ok && !!id;
      if (!ok) failures++;
      await logSchedule({
        op: "create", ref: date, http_status: r.status, ok,
        detail: `createTournament("${s.name}", ${scheduledDate}) -> ${ok ? id : (r.error ?? r.text.slice(0, 120))}`,
      });
      results.push({ name: s.name, date, time: s.time, ok, id, error: ok ? undefined : (r.error ?? `status ${r.status}`) });
    }
  }

  if (failures) {
    await alertJustin("LetsPoker schedule fill: some creates failed",
      `${failures} createTournament call(s) failed. See cash_open_log source="schedule".`);
  }
  const created = results.filter((r: any) => r.ok).length;
  await logSchedule({
    op: "fill", ref: `${plan.from}..${plan.to}`, http_status: 200, ok: failures === 0,
    detail: dryRun ? `dry run — ${results.length} would be created` : `${created} created, ${failures} failed`,
  });
  return json({ ok: failures === 0, mode: "fill", dryRun, from: plan.from, to: plan.to, created: dryRun ? 0 : created, results }, failures ? 502 : 200);
}

/* --------------------------------- serve ------------------------------ */

Deno.serve(async (req) => {
  let body: any = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) body = await req.json();
  } catch { /* default plan mode */ }
  const mode = typeof body?.mode === "string" ? body.mode : "plan";

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

  if (mode === "fill") return await runFill(cookie, sgid, clubId, body);

  // mode === "plan" (read-only default)
  try {
    const plan = await buildPlan(cookie, sgid, clubId, body);
    const toCreate = plan.series.reduce((a, s) => a + s.missing.length, 0);
    return json({ ok: true, mode: "plan", ...plan, toCreate });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
