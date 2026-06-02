// LetsPoker tournament push — headless fire of the captured admin GraphQL mutation.
//
// Interim cookie stopgap (LetsPoker is being replaced). Invoked by pg_cron.
// Replays `sendTournamentPushNotification`; LetsPoker renders `timeRelative`
// server-side at send time, so the call is identical on every fire.
//
// Which game to push is resolved from public.tournament_events by Perth date:
//   - mode "countdown" (6x day-of)      -> today's game
//   - mode "teaser"    (night-before 9pm) -> tomorrow's game
// No row for that date => no game => no-op (not an error).
//
// Fail-loud: a dead cookie fails SILENTLY (sends just stop). So on any non-200
// or auth/UNAUTHENTICATED error we alert Justin to refresh the cookie.
//
// Cookie/session/club are read from edge-function env (set via
// `supabase secrets set ...`). The cookie never lives in code or in git.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const MUTATION = `mutation sendTournamentPushNotification($clubId: ID!, $tournamentEventId: ID!, $templateParts: [String!]!) {
  sendTournamentPushNotification(
    templateParts: $templateParts
    tournamentEventId: $tournamentEventId
    clubId: $clubId
  )
}`;

const TEMPLATE_PARTS = ["timeRelative", "eventName", "guarantee", "location"];

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

// Perth is UTC+8, no DST. Shift now by +8h (and optional day offset), then the
// UTC date components are the Perth wall-clock date. Returns YYYY-MM-DD.
function perthDate(dayOffset = 0): string {
  const shifted = new Date(Date.now() + (8 * 60 + dayOffset * 24 * 60) * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Look up the game scheduled for a Perth date via PostgREST (service role).
async function lookupEvent(date: string): Promise<string | null> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/tournament_events?event_date=eq.${date}&select=tournament_event_id`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) return rows[0].tournament_event_id ?? null;
  } catch (_e) {
    // fall through
  }
  return null;
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

// Fail-loud alert. Fires email (Resend) and/or a generic webhook (Beeper/SMS),
// whichever is configured. Warns to console if neither is set.
async function alertJustin(subject: string, message: string) {
  const tasks: Promise<unknown>[] = [];

  const resendKey = env("RESEND_API_KEY");
  const alertEmail = env("ALERT_EMAIL");
  const alertFrom = env("ALERT_FROM") ?? "letspoker-push@clubwestcoast.com.au";
  if (resendKey && alertEmail) {
    tasks.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
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
    console.error(
      "[ALERT — no channel configured] " + subject + " :: " + message +
        " (set RESEND_API_KEY+ALERT_EMAIL and/or ALERT_WEBHOOK_URL)",
    );
  }
  await Promise.allSettled(tasks);
}

// Treat the GraphQL body as failed auth if it carries an UNAUTHENTICATED-style error.
function looksUnauthenticated(status: number, text: string): boolean {
  if (status === 401 || status === 403) return true;
  const t = text.toLowerCase();
  return (
    t.includes("unauthenticated") ||
    t.includes("not authenticated") ||
    t.includes("unauthorized") ||
    t.includes("session expired") ||
    t.includes("invalid session")
  );
}

// Any GraphQL `errors` array means the send didn't go through cleanly.
function hasGraphqlErrors(text: string): boolean {
  try {
    const json = JSON.parse(text);
    const entries = Array.isArray(json) ? json : Object.values(json);
    return entries.some(
      (e) => e && typeof e === "object" && Array.isArray((e as any).errors) &&
        (e as any).errors.length > 0,
    );
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const cookie = env("LETSPOKER_COOKIE");
  // Not secret (constant group/club ids); overridable via env if they change.
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  // Request body controls behaviour:
  //   { "mode": "countdown" | "teaser" }   -> resolve game from tournament_events
  //   { "tournamentEventId": "..." }        -> explicit override (testing)
  let mode = "countdown";
  let overrideEventId: string | undefined;
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body.mode === "string") mode = body.mode;
      if (body && typeof body.tournamentEventId === "string") overrideEventId = body.tournamentEventId;
    }
  } catch {
    // no/invalid body — default to countdown
  }

  // teaser targets tomorrow's game; countdown targets today's.
  const targetDate = mode === "teaser" ? perthDate(1) : perthDate(0);
  const source = overrideEventId ? "manual" : mode;
  const tournamentEventId = overrideEventId ?? (await lookupEvent(targetDate));

  // Cookie/session/club must be present to send at all.
  const missing: string[] = [];
  if (!cookie) missing.push("LETSPOKER_COOKIE");
  if (!sessionGroupId) missing.push("LETSPOKER_SESSION_GROUPID");
  if (missing.length > 0) {
    const detail = `Missing config: ${missing.join(", ")}`;
    await logFire({ source, tournament_event_id: tournamentEventId, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push misconfigured", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // No game scheduled for that date => nothing to push. Not an error.
  if (!tournamentEventId) {
    const detail = `skipped — no game in tournament_events for ${targetDate} (mode=${mode})`;
    console.log(`[letspoker-push] SKIP ${detail}`);
    await logFire({ source, tournament_event_id: null, http_status: null, ok: true, detail });
    return new Response(JSON.stringify({ ok: true, skipped: true, date: targetDate }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Apollo-batched body shape, replicated from the captured cURL: a JSON array.
  const batchedBody = JSON.stringify([
    {
      operationName: "sendTournamentPushNotification",
      query: MUTATION,
      variables: { clubId, tournamentEventId, templateParts: TEMPLATE_PARTS },
    },
  ]);

  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "x-app-section": "admin",
        "x-app-version": "2.0.1",
        "x-session-groupid": sessionGroupId!,
        Cookie: cookie!,
      },
      body: batchedBody,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const detail = `Network error calling LetsPoker: ${e}`;
    await logFire({ source, tournament_event_id: tournamentEventId, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push failed (network)", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const unauth = looksUnauthenticated(status, text);
  const gqlErrors = hasGraphqlErrors(text);
  const ok = status === 200 && !unauth && !gqlErrors;

  const detail = `mode=${mode} date=${targetDate} status=${status} eventId=${tournamentEventId} body=${text.slice(0, 400)}`;
  console.log(`[letspoker-push] ${ok ? "OK" : "FAIL"} ${detail}`);
  await logFire({ source, tournament_event_id: tournamentEventId, http_status: status, ok, detail });

  if (!ok) {
    const subject = unauth
      ? "LetsPoker push: cookie likely expired — REFRESH NEEDED"
      : "LetsPoker push failed";
    const msg = unauth
      ? `The LetsPoker admin session cookie appears dead (status ${status}). ` +
        `Pushes have stopped. Re-capture the cURL and update LETSPOKER_COOKIE / ` +
        `LETSPOKER_SESSION_GROUPID.\n\n${detail}`
      : `A LetsPoker push fire did not succeed.\n\n${detail}`;
    await alertJustin(subject, msg);
  }

  return new Response(JSON.stringify({ ok, status, mode, date: targetDate, eventId: tournamentEventId }), {
    status: ok ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
});
