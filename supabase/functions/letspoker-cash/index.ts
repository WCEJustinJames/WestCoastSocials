// LetsPoker cash automation — headless, fully-automated companion to
// letspoker-push. It opens cash games, seats reused player names onto events,
// and pushes per cash event. Same admin GraphQL endpoint, same cookie auth.
//
// Modes (request body { "mode": ... }):
//   - "sync"    -> diff getEventList(includeCash:true) vs the tournament-only list.
//   - "prefill" -> prefill upcoming rosters from the same weekly game last week.
//   - "open"    -> create the planned cash stakes + game types. dryRun supported.
//   - "seat"    -> register the plan's roster names onto its event. dryRun DEFAULT true.
//   - "push"    -> sendCashPushNotification for an event/table. dryRun supported.
//   - "tick"    -> orchestrate open + seat for today's plans (cron).
//
// Discovered LP cash schema (admin GraphQL, introspection off — mapped via
// field-suggestion probing):
//   createCashStake(clubId: ID!, input: SavedCashStakeInput!): CustomerPreferences!
//     SavedCashStakeInput { blinds: [Float!]!, currency: Currency!, text: String! }
//   createCashGameType(clubId: ID!, input: CashGameTypeInput!): CustomerPreferences!
//     CashGameTypeInput { name: String!, abbreviation: String! }
//   registerPlayerIntoEvent(clubId: ID!, eventId: ID!, buyinVariantId: ID!,
//     paymentMethod: String!, transactionId: ID!, playerId: ID): RegisterPlayerIntoEventResponse!
//   sendCashPushNotification(clubId: ID!, tableId: ID!, tournamentEventId: ID!, templateParts: [String!]!)
//
// Money-touching ops (seat) default to dryRun and fail loud. Only the cookie is
// a secret; club/session ids are constants overridable via env.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const CREATE_CASH_STAKE = `mutation createCashStake($clubId: ID!, $input: SavedCashStakeInput!) {
  createCashStake(clubId: $clubId, input: $input) { __typename }
}`;

const CREATE_CASH_GAME_TYPE = `mutation createCashGameType($clubId: ID!, $input: CashGameTypeInput!) {
  createCashGameType(clubId: $clubId, input: $input) { __typename }
}`;

const REGISTER_PLAYER = `mutation registerPlayerIntoEvent($clubId: ID!, $eventId: ID!, $buyinVariantId: ID!, $paymentMethod: String!, $transactionId: ID!, $playerId: ID) {
  registerPlayerIntoEvent(clubId: $clubId, eventId: $eventId, buyinVariantId: $buyinVariantId, paymentMethod: $paymentMethod, transactionId: $transactionId, playerId: $playerId) { __typename }
}`;

const CASH_PUSH = `mutation sendCashPushNotification($clubId: ID!, $tableId: ID!, $tournamentEventId: ID!, $templateParts: [String!]!) {
  sendCashPushNotification(clubId: $clubId, tableId: $tableId, tournamentEventId: $tournamentEventId, templateParts: $templateParts)
}`;

const LIST_QUERY = `query getList($clubId: ID!, $startDate: DateTime!, $endDate: DateTime!, $includeCash: Boolean!) {
  events: getEventList(clubId: $clubId, startDate: $startDate, endDate: $endDate, includeCash: $includeCash) {
    id scheduledDate config { general { eventName } }
  }
}`;

const CASH_TEMPLATE_PARTS = ["eventName", "location"];

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

// Perth is UTC+8, no DST. The UTC date of (now + 8h + dayOffset) is the Perth
// wall-clock date. Returns YYYY-MM-DD.
function perthDate(dayOffset = 0): string {
  return new Date(Date.now() + (8 * 60 + dayOffset * 24 * 60) * 60 * 1000)
    .toISOString().slice(0, 10);
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
  } catch {
    return null;
  }
}

function firstData(text: string): any {
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    return first?.data ?? null;
  } catch {
    return null;
  }
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

// PostgREST helper (service role).
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return await fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      apikey: key!,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
}

async function logCash(row: {
  source: string; op: string; ref: string | null;
  http_status: number | null; ok: boolean; detail: string;
}) {
  try {
    await rest(`/rest/v1/cash_open_log`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
  } catch (_e) { /* best-effort */ }
}

// Fail-loud alert (Resend email and/or webhook), mirroring letspoker-push.
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, text: message }),
    }).catch((e) => console.error("alert webhook failed:", e)));
  }
  if (tasks.length === 0) console.error("[ALERT — no channel] " + subject + " :: " + message);
  await Promise.allSettled(tasks);
}

// Fire one GraphQL operation (batched-array form, as the LP admin client sends).
async function gql(
  cookie: string, sessionGroupId: string, operationName: string, query: string, variables: unknown,
): Promise<{ status: number | null; text: string; ok: boolean; unauth: boolean; error: string | null }> {
  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers(cookie, sessionGroupId),
      body: JSON.stringify([{ operationName, query, variables }]),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return { status: null, text: "", ok: false, unauth: false, error: `network error: ${e}` };
  }
  const unauth = looksUnauthenticated(status, text);
  const gqlErr = firstGraphqlError(text);
  const ok = status === 200 && !unauth && !gqlErr;
  return { status, text, ok, unauth, error: gqlErr };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------- sync -------------------------------- */
// Cash events = events present with includeCash:true but absent with
// includeCash:false. Upsert those into public.cash_events.
async function runSync(cookie: string, sessionGroupId: string, clubId: string): Promise<Response> {
  const startDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const endDate = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();

  const withCash = await gql(cookie, sessionGroupId, "getList", LIST_QUERY,
    { clubId, startDate, endDate, includeCash: true });
  const noCash = await gql(cookie, sessionGroupId, "getList", LIST_QUERY,
    { clubId, startDate, endDate, includeCash: false });

  for (const r of [withCash, noCash]) {
    if (!r.ok) {
      const detail = `sync list failed status=${r.status} err=${r.error ?? r.text.slice(0, 200)}`;
      await logCash({ source: "sync", op: "sync", ref: null, http_status: r.status, ok: false, detail });
      await alertJustin(r.unauth ? "LetsPoker cash sync: cookie expired" : "LetsPoker cash sync failed", detail);
      return json({ ok: false, error: detail }, 502);
    }
  }

  const all = (firstData(withCash.text)?.events ?? []) as any[];
  const tourIds = new Set((firstData(noCash.text)?.events ?? []).map((e: any) => e.id));
  const cashRows = all
    .filter((e) => e?.id && e?.scheduledDate && !tourIds.has(e.id))
    .map((e) => ({
      event_id: e.id,
      event_date: perthDateOf(e.scheduledDate),
      label: e?.config?.general?.eventName ?? null,
      starts_at: e.scheduledDate,
      synced_at: new Date().toISOString(),
    }));

  if (cashRows.length) {
    const up = await rest(`/rest/v1/cash_events?on_conflict=event_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(cashRows),
    });
    if (!up.ok) {
      const detail = `cash_events upsert failed: ${up.status} ${(await up.text()).slice(0, 200)}`;
      await logCash({ source: "sync", op: "sync", ref: null, http_status: up.status, ok: false, detail });
      await alertJustin("LetsPoker cash sync: DB upsert failed", detail);
      return json({ ok: false, error: detail }, 500);
    }
  }

  const detail = `cash sync ok — ${all.length} total events, ${cashRows.length} cash`;
  await logCash({ source: "sync", op: "sync", ref: null, http_status: 200, ok: true, detail });
  return json({ ok: true, totalEvents: all.length, cashEvents: cashRows.length });
}

/* ------------------------------- plans ------------------------------- */
type Plan = {
  id: string; event_date: string; label: string | null; event_id: string | null;
  buyin_variant_id: string | null; stakes: any[]; game_types: any[];
  anticipated_tables: number | null; anticipated_players: number | null; status: string;
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

async function patchPlan(id: string, patch: Record<string, unknown>) {
  await rest(`/rest/v1/cash_plan?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

/* ------------------------------- open -------------------------------- */
// Create each planned stake + game type. dryRun reports the intended calls.
async function runOpen(
  cookie: string, sessionGroupId: string, clubId: string,
  opts: { planId?: string; date?: string; dryRun: boolean },
): Promise<Response> {
  const plans = await loadPlans(opts);
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });

  const results: unknown[] = [];
  for (const p of plans) {
    const intended = [
      ...p.stakes.map((s) => ({ op: "createCashStake", input: s })),
      ...p.game_types.map((g) => ({ op: "createCashGameType", input: g })),
    ];
    if (opts.dryRun) {
      results.push({ planId: p.id, date: p.event_date, dryRun: true, wouldFire: intended });
      continue;
    }
    if (!intended.length) {
      results.push({ planId: p.id, skipped: true, reason: "plan has no stakes/game_types" });
      continue;
    }
    await patchPlan(p.id, { status: "opening" });
    const fired: unknown[] = [];
    let allOk = true;
    for (const s of p.stakes) {
      const r = await gql(cookie, sessionGroupId, "createCashStake", CREATE_CASH_STAKE,
        { clubId, input: s });
      allOk &&= r.ok;
      const detail = `createCashStake ${JSON.stringify(s)} status=${r.status} ${r.ok ? "OK" : (r.error ?? r.text.slice(0, 200))}`;
      await logCash({ source: "open", op: "open", ref: p.id, http_status: r.status, ok: r.ok, detail });
      fired.push({ op: "createCashStake", input: s, ok: r.ok, status: r.status, error: r.error });
    }
    for (const g of p.game_types) {
      const r = await gql(cookie, sessionGroupId, "createCashGameType", CREATE_CASH_GAME_TYPE,
        { clubId, input: g });
      allOk &&= r.ok;
      const detail = `createCashGameType ${JSON.stringify(g)} status=${r.status} ${r.ok ? "OK" : (r.error ?? r.text.slice(0, 200))}`;
      await logCash({ source: "open", op: "open", ref: p.id, http_status: r.status, ok: r.ok, detail });
      fired.push({ op: "createCashGameType", input: g, ok: r.ok, status: r.status, error: r.error });
    }
    await patchPlan(p.id, allOk ? { status: "open", opened_at: new Date().toISOString() } : { status: "error" });
    if (!allOk) await alertJustin("LetsPoker cash open failed", `Plan ${p.id} (${p.event_date}) had failures: ${JSON.stringify(fired)}`);
    results.push({ planId: p.id, date: p.event_date, ok: allOk, fired });
  }
  const ok = results.every((r: any) => r.dryRun || r.skipped || r.ok);
  return json({ ok, mode: "open", dryRun: opts.dryRun, results }, ok ? 200 : 502);
}

/* ------------------------------- seat -------------------------------- */
// Resolve a roster name to an LP player id from already-harvested lp_entries.
async function resolvePlayerId(name: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  const parts = n.split(/\s+/);
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  let q = `select=player_id&limit=1&first_name=ilike.${encodeURIComponent(first)}`;
  if (last) q += `&last_name=ilike.${encodeURIComponent(last)}`;
  const res = await rest(`/rest/v1/lp_entries?${q}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.player_id ? String(rows[0].player_id) : null;
}

// Claim a player for a Perth day (one user/day across tournament + cash). Returns
// true only if WE claimed it (so the same name is never double-booked / billed).
async function claimDayUser(playDate: string, playerKey: string, meta: {
  player_name: string; player_id: string | null; event_id: string | null;
}): Promise<boolean> {
  const res = await rest(`/rest/v1/cash_day_user_ledger`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      play_date: playDate, player_key: playerKey, used_for: "cash",
      player_name: meta.player_name, player_id: meta.player_id, event_id: meta.event_id,
    }),
  });
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function releaseDayUser(playDate: string, playerKey: string) {
  await rest(`/rest/v1/cash_day_user_ledger?play_date=eq.${playDate}&player_key=eq.${encodeURIComponent(playerKey)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

async function patchRoster(id: string, patch: Record<string, unknown>) {
  await rest(`/rest/v1/cash_seat_roster?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });
}

// Seat the plan's roster onto its event. Money-touching → dryRun defaults true.
async function runSeat(
  cookie: string, sessionGroupId: string, clubId: string,
  opts: { planId?: string; date?: string; dryRun: boolean; paymentMethod?: string },
): Promise<Response> {
  const plans = await loadPlans(opts);
  if (!plans.length) return json({ ok: true, skipped: true, reason: "no matching cash_plan rows" });
  const paymentMethod = opts.paymentMethod ?? env("CASH_PAYMENT_METHOD");

  const results: unknown[] = [];
  for (const p of plans) {
    const rosterRes = await rest(`/rest/v1/cash_seat_roster?plan_id=eq.${p.id}&seat_status=eq.pending&select=*`);
    const roster = await rosterRes.json().catch(() => []) as any[];

    for (const row of roster) {
      const pid = row.player_id ?? await resolvePlayerId(row.player_name);
      const playerKey = pid ?? row.player_name.trim().toLowerCase();
      const playDate = p.event_date;

      if (!pid && row.player_id == null) {
        await patchRoster(row.id, { seat_status: "error", detail: "could not resolve player_id from lp_entries" });
        results.push({ roster: row.id, name: row.player_name, ok: false, reason: "unresolved player" });
        continue;
      }

      // One user/day guard.
      const claimed = await claimDayUser(playDate, playerKey, { player_name: row.player_name, player_id: pid, event_id: p.event_id });
      if (!claimed) {
        await patchRoster(row.id, { seat_status: "skipped", player_id: pid, detail: "already used this day (one user/day guard)" });
        results.push({ roster: row.id, name: row.player_name, skipped: true, reason: "already used today" });
        continue;
      }

      if (opts.dryRun) {
        await releaseDayUser(playDate, playerKey); // don't consume the day on a dry run
        results.push({
          roster: row.id, name: row.player_name, dryRun: true,
          wouldRegister: { eventId: p.event_id, buyinVariantId: p.buyin_variant_id, playerId: pid, paymentMethod: paymentMethod ?? "<unset>" },
        });
        continue;
      }

      // Live registration requires the full money-touching arg set.
      if (!p.event_id || !p.buyin_variant_id || !paymentMethod) {
        await releaseDayUser(playDate, playerKey);
        await patchRoster(row.id, { seat_status: "error", player_id: pid, detail: "missing event_id / buyin_variant_id / paymentMethod" });
        results.push({ roster: row.id, name: row.player_name, ok: false, reason: "missing event_id/buyin_variant_id/paymentMethod" });
        continue;
      }

      const transactionId = crypto.randomUUID();
      const r = await gql(cookie, sessionGroupId, "registerPlayerIntoEvent", REGISTER_PLAYER, {
        clubId, eventId: p.event_id, buyinVariantId: p.buyin_variant_id,
        paymentMethod, transactionId, playerId: pid,
      });
      const detail = `registerPlayerIntoEvent player=${row.player_name}(${pid}) event=${p.event_id} status=${r.status} ${r.ok ? "OK" : (r.error ?? r.text.slice(0, 200))}`;
      await logCash({ source: "seat", op: "seat", ref: p.id, http_status: r.status, ok: r.ok, detail });
      if (r.ok) {
        await patchRoster(row.id, { seat_status: "seated", player_id: pid, seated_at: new Date().toISOString(), detail: null });
      } else {
        await releaseDayUser(playDate, playerKey); // let it retry / free the name
        await patchRoster(row.id, { seat_status: "error", player_id: pid, detail: r.error ?? `status ${r.status}` });
        await alertJustin("LetsPoker cash seat failed", detail);
      }
      results.push({ roster: row.id, name: row.player_name, ok: r.ok, status: r.status, error: r.error });
    }
  }
  const ok = results.every((r: any) => r.dryRun || r.skipped || r.ok);
  return json({ ok, mode: "seat", dryRun: opts.dryRun, results }, ok ? 200 : 502);
}

/* ------------------------------- push -------------------------------- */
async function runPush(
  cookie: string, sessionGroupId: string, clubId: string,
  opts: { eventId?: string; tableId?: string; templateParts?: string[]; dryRun: boolean },
): Promise<Response> {
  if (!opts.eventId || !opts.tableId) {
    return json({ ok: false, error: "push needs eventId (tournamentEventId) and tableId" }, 400);
  }
  const templateParts = opts.templateParts ?? CASH_TEMPLATE_PARTS;
  if (opts.dryRun) {
    return json({ ok: true, dryRun: true, wouldPush: { eventId: opts.eventId, tableId: opts.tableId, templateParts } });
  }
  const r = await gql(cookie, sessionGroupId, "sendCashPushNotification", CASH_PUSH,
    { clubId, tableId: opts.tableId, tournamentEventId: opts.eventId, templateParts });
  const detail = `sendCashPushNotification event=${opts.eventId} table=${opts.tableId} status=${r.status} ${r.ok ? "OK" : (r.error ?? r.text.slice(0, 200))}`;
  await logCash({ source: "push", op: "push", ref: opts.eventId, http_status: r.status, ok: r.ok, detail });
  if (!r.ok) await alertJustin("LetsPoker cash push failed", detail);
  return json({ ok: r.ok, status: r.status, error: r.error }, r.ok ? 200 : 502);
}

/* ------------------------------ prefill ------------------------------ */
// Prefill upcoming events' rosters from the same weekly game last week, via the
// public.prefill_cash_from_history RPC (set-based matching lives in SQL).
async function runPrefill(opts: { horizonDays?: number; lookbackDays?: number }): Promise<Response> {
  const res = await rest(`/rest/v1/rpc/prefill_cash_from_history`, {
    method: "POST",
    body: JSON.stringify({
      horizon_days: opts.horizonDays ?? 14,
      lookback_days: opts.lookbackDays ?? 45,
    }),
  });
  const text = await res.text();
  let rows: unknown = text;
  try { rows = JSON.parse(text); } catch { /* keep text */ }
  const ok = res.ok;
  await logCash({ source: "prefill", op: "prefill", ref: null, http_status: res.status, ok,
    detail: `prefill ${ok ? "ok" : "failed"}: ${text.slice(0, 300)}` });
  return json({ ok, mode: "prefill", results: rows }, ok ? 200 : 502);
}

/* ------------------------------- tick -------------------------------- */
// Orchestrate today's plans: open (once) then seat. Push is left explicit
// because it needs a live tableId.
async function runTick(
  cookie: string, sessionGroupId: string, clubId: string, dryRun: boolean,
): Promise<Response> {
  const date = perthDate(0);
  const plans = await loadPlans({ date });
  const out: unknown[] = [];
  for (const p of plans) {
    if (p.status === "planned" || p.status === "error") {
      const r = await runOpen(cookie, sessionGroupId, clubId, { planId: p.id, dryRun });
      out.push({ planId: p.id, open: await r.json() });
    }
    const s = await runSeat(cookie, sessionGroupId, clubId, { planId: p.id, dryRun });
    out.push({ planId: p.id, seat: await s.json() });
  }
  return json({ ok: true, mode: "tick", date, dryRun, plans: plans.length, out });
}

/* -------------------------------- serve ------------------------------ */
Deno.serve(async (req) => {
  const cookie = await getCookie();
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  let body: any = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) body = await req.json();
  } catch { /* no body */ }
  const mode = typeof body.mode === "string" ? body.mode : "sync";
  // Seat is money-touching: dryRun defaults TRUE unless explicitly disabled.
  const dryRun = mode === "seat" || mode === "tick" ? body.dryRun !== false : body.dryRun === true;

  // prefill needs no cookie (pure DB).
  if (mode === "prefill") return await runPrefill({ horizonDays: body.horizonDays, lookbackDays: body.lookbackDays });

  if (!cookie) {
    const detail = "Missing config: no LetsPoker cookie (letspoker_auth / LETSPOKER_COOKIE)";
    await logCash({ source: mode, op: mode, ref: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker cash misconfigured", detail);
    return json({ ok: false, error: detail }, 500);
  }

  switch (mode) {
    case "sync": return await runSync(cookie, sessionGroupId, clubId);
    case "open": return await runOpen(cookie, sessionGroupId, clubId, { planId: body.planId, date: body.date, dryRun });
    case "seat": return await runSeat(cookie, sessionGroupId, clubId, { planId: body.planId, date: body.date, dryRun, paymentMethod: body.paymentMethod });
    case "push": return await runPush(cookie, sessionGroupId, clubId, { eventId: body.eventId, tableId: body.tableId, templateParts: body.templateParts, dryRun });
    case "tick": return await runTick(cookie, sessionGroupId, clubId, dryRun);
    default: return json({ ok: false, error: `unknown mode: ${mode}` }, 400);
  }
});
