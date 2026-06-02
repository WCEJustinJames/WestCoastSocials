// LetsPoker tournament push — headless fire of the captured admin GraphQL mutation.
//
// Interim cookie stopgap (LetsPoker is being replaced). Invoked by pg_cron 6x/day.
// Replays `sendTournamentPushNotification`; LetsPoker renders `timeRelative`
// server-side at send time, so the call is identical on every fire.
//
// Fail-loud: a dead cookie fails SILENTLY (sends just stop). So on any non-200
// or auth/UNAUTHENTICATED error we alert Justin to refresh the cookie.
//
// Secrets are read from edge-function env (set via `supabase secrets set ...`).
// The cookie never lives in code or in git.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql";

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
        body: JSON.stringify({
          from: alertFrom,
          to: alertEmail,
          subject,
          text: message,
        }),
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
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID");
  const clubId = env("LETSPOKER_CLUB_ID");
  const envEventId = env("TOURNAMENT_EVENT_ID");

  // Allow a per-request override of the event id — used to validate against the
  // Private Deep Stack Freezeout (0 players) instead of blasting the live event.
  let overrideEventId: string | undefined;
  let source = "cron";
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body.tournamentEventId === "string") {
        overrideEventId = body.tournamentEventId;
        source = "manual";
      }
    }
  } catch {
    // no/invalid body — fine, fall back to env
  }

  const tournamentEventId = overrideEventId ?? envEventId;

  const missing: string[] = [];
  if (!cookie) missing.push("LETSPOKER_COOKIE");
  if (!sessionGroupId) missing.push("LETSPOKER_SESSION_GROUPID");
  if (!clubId) missing.push("LETSPOKER_CLUB_ID");
  if (!tournamentEventId) missing.push("TOURNAMENT_EVENT_ID");
  if (missing.length > 0) {
    const detail = `Missing config: ${missing.join(", ")}`;
    await logFire({ source, tournament_event_id: tournamentEventId ?? null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push misconfigured", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Apollo-batched body shape, replicated from the captured cURL: {"0": { ... }}.
  const batchedBody = JSON.stringify({
    "0": {
      operationName: "sendTournamentPushNotification",
      query: MUTATION,
      variables: {
        clubId,
        tournamentEventId,
        templateParts: TEMPLATE_PARTS,
      },
    },
  });

  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-version": "2.0.0",
        "x-session-groupid": sessionGroupId!,
        Cookie: cookie!,
      },
      body: batchedBody,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const detail = `Network error calling LetsPoker: ${e}`;
    await logFire({ source, tournament_event_id: tournamentEventId!, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push failed (network)", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const unauth = looksUnauthenticated(status, text);
  const gqlErrors = hasGraphqlErrors(text);
  const ok = status === 200 && !unauth && !gqlErrors;

  const detail = `status=${status} eventId=${tournamentEventId} body=${text.slice(0, 500)}`;
  console.log(`[letspoker-push] ${ok ? "OK" : "FAIL"} ${detail}`);
  await logFire({ source, tournament_event_id: tournamentEventId!, http_status: status, ok, detail });

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

  return new Response(JSON.stringify({ ok, status, eventId: tournamentEventId }), {
    status: ok ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
});
