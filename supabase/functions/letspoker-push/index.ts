// LetsPoker tournament push — headless, fully-automated.
//
// Modes (request body { "mode": ... }):
//   - "sync"      -> pull the calendar (getEventList) and upsert public.tournament_events
//   - "countdown" -> push ALL of today's games (the 6x day-of fires)
//   - "teaser"    -> push ALL of tomorrow's games (the night-before 9pm fire)
//   - { "tournamentEventId": "..." } -> explicit single-event push override (testing)
//   - sync + { "dryRun": true }       -> list upcoming events, write nothing
//
// A night can have several tournaments (different venues); each is its own row in
// tournament_events and gets its own push. The sync keeps the table current, so
// the whole cycle repeats with no manual input. LetsPoker renders `timeRelative`
// server-side, so each push is identical fire-to-fire.
//
// Fail-loud: a dead cookie fails SILENTLY. On any non-200 / UNAUTHENTICATED we
// alert Justin. Only the cookie is a secret; group/club ids are constants below.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const MUTATION = `mutation sendTournamentPushNotification($clubId: ID!, $tournamentEventId: ID!, $templateParts: [String!]!) {
  sendTournamentPushNotification(
    templateParts: $templateParts
    tournamentEventId: $tournamentEventId
    clubId: $clubId
  )
}`;

// Minimal slice of the admin's getTournamentList — just the calendar feed.
const LIST_QUERY = `query getTournamentList($clubId: ID!, $startDate: DateTime!, $endDate: DateTime!, $includeCash: Boolean = false) {
  events: getEventList(clubId: $clubId, startDate: $startDate, endDate: $endDate, includeCash: $includeCash) {
    id
    scheduledDate
    config { general { eventName } }
  }
}`;

const TEMPLATE_PARTS = ["timeRelative", "eventName", "guarantee", "location"];

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

// Perth is UTC+8, no DST. Add +8h (and optional day offset); the UTC date of the
// shifted instant is the Perth wall-clock date. Returns YYYY-MM-DD.
function perthDate(dayOffset = 0): string {
  return new Date(Date.now() + (8 * 60 + dayOffset * 24 * 60) * 60 * 1000)
    .toISOString().slice(0, 10);
}
function perthDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function letspokerHeaders(cookie: string, sessionGroupId: string): HeadersInit {
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-app-section": "admin",
    "x-app-version": "2.0.1",
    "x-session-groupid": sessionGroupId,
    Cookie: cookie,
  };
}

// All games scheduled for a Perth date, via PostgREST (service role).
async function lookupEvents(date: string): Promise<string[]> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const res = await fetch(
      `${url}/rest/v1/tournament_events?event_date=eq.${date}&select=tournament_event_id`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    const rows = await res.json();
    if (Array.isArray(rows)) return rows.map((r) => r.tournament_event_id).filter(Boolean);
  } catch (_e) {
    // fall through
  }
  return [];
}

// Best-effort log to public.letspoker_push_log. Never throws.
async function logFire(row: {
  source: string;
  tournament_event_id: string | null;
  http_status: number | null;
  ok: boolean;
  detail: string;
}) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/letspoker_push_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (_e) {
    // logging is best-effort; swallow
  }
}

// Fail-loud alert. Email (Resend) and/or a generic webhook (Beeper/SMS).
async function alertJustin(subject: string, message: string) {
  const tasks: Promise<unknown>[] = [];

  const resendKey = env("RESEND_API_KEY");
  const alertEmail = env("ALERT_EMAIL");
  const alertFrom = env("ALERT_FROM") ?? "letspoker-push@clubwestcoast.com.au";
  if (resendKey && alertEmail) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
        body: JSON.stringify({ from: alertFrom, to: alertEmail, subject, text: message }),
      }).catch((e) => console.error("alert email failed:", e)),
    );
  }
  const webhook = env("ALERT_WEBHOOK_URL");
  if (webhook) {
    tasks.push(
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, text: message }),
      }).catch((e) => console.error("alert webhook failed:", e)),
    );
  }
  if (tasks.length === 0) {
    console.error("[ALERT — no channel configured] " + subject + " :: " + message);
  }
  await Promise.allSettled(tasks);
}

function looksUnauthenticated(status: number, text: string): boolean {
  if (status === 401 || status === 403) return true;
  const t = text.toLowerCase();
  return (
    t.includes("unauthenticated") || t.includes("not authenticated") ||
    t.includes("unauthorized") || t.includes("session expired") || t.includes("invalid session")
  );
}

function hasGraphqlErrors(text: string): boolean {
  try {
    const json = JSON.parse(text);
    const entries = Array.isArray(json) ? json : Object.values(json);
    return entries.some(
      (e) => e && typeof e === "object" && Array.isArray((e as any).errors) && (e as any).errors.length > 0,
    );
  } catch {
    return false;
  }
}

// Fire one push for one tournament event. Logs + alerts on failure.
async function sendPush(
  cookie: string, sessionGroupId: string, clubId: string,
  source: string, mode: string, targetDate: string, tournamentEventId: string,
): Promise<{ ok: boolean; status: number | null; unauth: boolean }> {
  const batchedBody = JSON.stringify([
    { operationName: "sendTournamentPushNotification", query: MUTATION, variables: { clubId, tournamentEventId, templateParts: TEMPLATE_PARTS } },
  ]);

  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: letspokerHeaders(cookie, sessionGroupId), body: batchedBody });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const detail = `Network error calling LetsPoker: ${e}`;
    await logFire({ source, tournament_event_id: tournamentEventId, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push failed (network)", detail);
    return { ok: false, status: null, unauth: false };
  }

  const unauth = looksUnauthenticated(status, text);
  const ok = status === 200 && !unauth && !hasGraphqlErrors(text);
  const detail = `mode=${mode} date=${targetDate} status=${status} eventId=${tournamentEventId} body=${text.slice(0, 300)}`;
  console.log(`[letspoker-push] ${ok ? "OK" : "FAIL"} ${detail}`);
  await logFire({ source, tournament_event_id: tournamentEventId, http_status: status, ok, detail });

  if (!ok) {
    const subject = unauth ? "LetsPoker push: cookie likely expired — REFRESH NEEDED" : "LetsPoker push failed";
    const msg = unauth
      ? `The LetsPoker admin session cookie appears dead (status ${status}). Pushes have stopped. Re-capture the cURL and update LETSPOKER_COOKIE.\n\n${detail}`
      : `A LetsPoker push fire did not succeed.\n\n${detail}`;
    await alertJustin(subject, msg);
  }
  return { ok, status, unauth };
}

// Pull the calendar and upsert every tournament (one row per event id).
async function runSync(cookie: string, sessionGroupId: string, clubId: string, dryRun = false): Promise<Response> {
  const supaUrl = env("SUPABASE_URL");
  const supaKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const startDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const endDate = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();

  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: letspokerHeaders(cookie, sessionGroupId),
      body: JSON.stringify([
        { operationName: "getTournamentList", query: LIST_QUERY, variables: { clubId, startDate, endDate, includeCash: false } },
      ]),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const detail = `sync network error: ${e}`;
    await logFire({ source: "sync", tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker calendar sync failed (network)", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  if (status !== 200 || looksUnauthenticated(status, text) || hasGraphqlErrors(text)) {
    const unauth = looksUnauthenticated(status, text);
    const detail = `sync failed status=${status} body=${text.slice(0, 400)}`;
    await logFire({ source: "sync", tournament_event_id: null, http_status: status, ok: false, detail });
    await alertJustin(
      unauth ? "LetsPoker sync: cookie likely expired — REFRESH NEEDED" : "LetsPoker calendar sync failed",
      detail,
    );
    return new Response(JSON.stringify({ ok: false, status, error: "sync failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  let events: any[] = [];
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    events = first?.data?.events ?? [];
  } catch {
    events = [];
  }

  // Inspection mode: list every event in the next few Perth days (no DB write).
  if (dryRun) {
    const horizon = new Set([perthDate(0), perthDate(1), perthDate(2)]);
    const peek = events
      .filter((e) => e?.scheduledDate && horizon.has(perthDateOf(e.scheduledDate)))
      .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime())
      .map((e) => ({ id: e.id, date: perthDateOf(e.scheduledDate), startsUtc: e.scheduledDate, name: e?.config?.general?.eventName ?? null }));
    return new Response(JSON.stringify({ ok: true, dryRun: true, count: events.length, peek }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // One row per tournament (every venue/game kept).
  const rows = events
    .filter((e) => e?.id && e?.scheduledDate)
    .map((e) => ({
      tournament_event_id: e.id,
      event_date: perthDateOf(e.scheduledDate),
      label: e?.config?.general?.eventName ?? null,
      starts_at: e.scheduledDate,
      synced_at: new Date().toISOString(),
    }));

  let upserted = 0;
  if (rows.length && supaUrl && supaKey) {
    const up = await fetch(`${supaUrl}/rest/v1/tournament_events?on_conflict=tournament_event_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    upserted = up.ok ? rows.length : 0;
    if (!up.ok) {
      const detail = `sync upsert failed: ${up.status} ${(await up.text()).slice(0, 300)}`;
      await logFire({ source: "sync", tournament_event_id: null, http_status: up.status, ok: false, detail });
      await alertJustin("LetsPoker sync: DB upsert failed", detail);
      return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  const detail = `sync ok — ${events.length} events, ${rows.length} tournaments upserted`;
  console.log(`[letspoker-push] ${detail}`);
  await logFire({ source: "sync", tournament_event_id: null, http_status: 200, ok: true, detail });
  return new Response(JSON.stringify({ ok: true, events: events.length, tournaments: upserted }), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const cookie = env("LETSPOKER_COOKIE");
  // Not secret (constant ids); overridable via env if they ever change.
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  let mode = "countdown";
  let overrideEventId: string | undefined;
  let dryRun = false;
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body.mode === "string") mode = body.mode;
      if (body && typeof body.tournamentEventId === "string") overrideEventId = body.tournamentEventId;
      if (body && body.dryRun === true) dryRun = true;
    }
  } catch {
    // no/invalid body — default to countdown
  }

  // Cookie is required for any LetsPoker call.
  if (!cookie) {
    const detail = "Missing config: LETSPOKER_COOKIE";
    await logFire({ source: mode, tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push misconfigured", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // Calendar sync.
  if (mode === "sync") return await runSync(cookie, sessionGroupId, clubId, dryRun);

  // teaser targets tomorrow's games; countdown targets today's.
  const targetDate = mode === "teaser" ? perthDate(1) : perthDate(0);
  const source = overrideEventId ? "manual" : mode;
  const ids = overrideEventId ? [overrideEventId] : await lookupEvents(targetDate);

  // No game scheduled for that date => nothing to push. Not an error.
  if (ids.length === 0) {
    const detail = `skipped — no game in tournament_events for ${targetDate} (mode=${mode})`;
    console.log(`[letspoker-push] SKIP ${detail}`);
    await logFire({ source, tournament_event_id: null, http_status: null, ok: true, detail });
    return new Response(JSON.stringify({ ok: true, skipped: true, date: targetDate }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Push every game scheduled for the date.
  const results = [];
  for (const id of ids) {
    results.push({ eventId: id, ...(await sendPush(cookie, sessionGroupId, clubId, source, mode, targetDate, id)) });
  }
  const allOk = results.every((r) => r.ok);
  return new Response(JSON.stringify({ ok: allOk, mode, date: targetDate, pushed: results }), {
    status: allOk ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
});
