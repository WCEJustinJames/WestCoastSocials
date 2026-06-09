// LetsPoker tournament push — headless, fully-automated.
//
// Modes (request body { "mode": ... }):
//   - "login"     -> mint a fresh session cookie (username+password+TOTP) into letspoker_auth
//   - "sync"      -> pull the calendar (getEventList) and upsert public.tournament_events
//   - "tick"      -> per-game scheduler (teaser + countdown + in-event); run every 30 min
//   - "countdown" -> push ALL of today's games   (legacy fixed-time fires)
//   - "teaser"    -> push ALL of tomorrow's games (legacy night-before fire)
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

// Headless login (discovered via field-suggestion probing; introspection is off).
// authToken is the TOTP 6-digit code; the session returns as Set-Cookie.
const LOGIN_MUTATION = `mutation adminLogin($username: String!, $password: String!, $authToken: String!) {
  adminLogin(username: $username, password: $password, authToken: $authToken) {
    user { id }
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

// Login headers — same as letspokerHeaders but with no Cookie (we're minting one).
function loginHeaders(sessionGroupId: string): HeadersInit {
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-app-section": "admin",
    "x-app-version": "2.0.1",
    "x-session-groupid": sessionGroupId,
  };
}

// RFC 4648 base32 decode (TOTP seeds are base32, no padding needed).
function base32Decode(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// RFC 6238 TOTP — the same 6-digit code an authenticator app shows.
async function totp(secret: string, timeStep = 30, digits = 6): Promise<string> {
  const key = base32Decode(secret);
  const msg = new Uint8Array(8);
  let counter = Math.floor(Date.now() / 1000 / timeStep);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const ck = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", ck, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

// The session cookie: prefer the auto-refreshed one in letspoker_auth, fall back
// to the LETSPOKER_COOKIE env secret (the manual stopgap).
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
    } catch (_e) {
      // fall through to env
    }
  }
  return env("LETSPOKER_COOKIE");
}

// All non-excluded games scheduled for a Perth date, via PostgREST (service role).
async function lookupEvents(date: string): Promise<string[]> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const res = await fetch(
      `${url}/rest/v1/tournament_events?event_date=eq.${date}&excluded=is.false&select=tournament_event_id`,
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
  templateParts: string[] = TEMPLATE_PARTS,
): Promise<{ ok: boolean; status: number | null; unauth: boolean }> {
  const batchedBody = JSON.stringify([
    { operationName: "sendTournamentPushNotification", query: MUTATION, variables: { clubId, tournamentEventId, templateParts } },
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

// Headless login: mint a fresh session cookie from username + password + TOTP and
// store it in letspoker_auth for getCookie(). On any failure the old cookie is
// left untouched (fail-safe) and Justin is alerted.
async function runLogin(overrideToken?: string): Promise<Response> {
  const username = env("LETSPOKER_USERNAME");
  const password = env("LETSPOKER_PASSWORD");
  const seed = env("LETSPOKER_TOTP_SECRET");
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");

  if (!username || !password || (!seed && !overrideToken)) {
    const detail = "login misconfigured: need LETSPOKER_USERNAME, LETSPOKER_PASSWORD, LETSPOKER_TOTP_SECRET";
    await logFire({ source: "login", tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker auto-login misconfigured", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let authToken: string;
  try {
    authToken = overrideToken ?? await totp(seed as string);
  } catch (e) {
    const detail = `login: TOTP failed — is LETSPOKER_TOTP_SECRET valid base32? ${e}`;
    await logFire({ source: "login", tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker auto-login: bad TOTP secret", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let status: number | null = null;
  let text = "";
  let setCookies: string[] = [];
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: loginHeaders(sessionGroupId),
      body: JSON.stringify([{ operationName: "adminLogin", query: LOGIN_MUTATION, variables: { username, password, authToken } }]),
    });
    status = res.status;
    setCookies = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    text = await res.text();
  } catch (e) {
    const detail = `login network error: ${e}`;
    await logFire({ source: "login", tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker auto-login failed (network)", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  if (status !== 200 || looksUnauthenticated(status, text) || hasGraphqlErrors(text)) {
    const detail = `login failed status=${status} body=${text.slice(0, 300)}`;
    await logFire({ source: "login", tournament_event_id: null, http_status: status, ok: false, detail });
    await alertJustin("LetsPoker auto-login failed", `Credentials/TOTP rejected, or the login shape changed.\n\n${detail}`);
    return new Response(JSON.stringify({ ok: false, status, error: "login failed" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  // Assemble the Cookie header from every non-empty Set-Cookie pair.
  const cookie = setCookies
    .map((c) => c.split(";")[0].trim())
    .filter((p) => { const i = p.indexOf("="); return i > 0 && p.slice(i + 1).length > 0; })
    .join("; ");

  if (!cookie) {
    const detail = `login returned 200 but no usable Set-Cookie (count=${setCookies.length})`;
    await logFire({ source: "login", tournament_event_id: null, http_status: status, ok: false, detail });
    await alertJustin("LetsPoker auto-login: no cookie returned", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  // Persist for getCookie() (id=1 singleton upsert). Never log the cookie itself.
  if (url && key) {
    const up = await fetch(`${url}/rest/v1/letspoker_auth?on_conflict=id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ id: 1, cookie, refreshed_at: new Date().toISOString() }),
    });
    if (!up.ok) {
      const detail = `login: cookie minted but DB store failed: ${up.status} ${(await up.text()).slice(0, 200)}`;
      await logFire({ source: "login", tournament_event_id: null, http_status: up.status, ok: false, detail });
      await alertJustin("LetsPoker auto-login: cookie store failed", detail);
      return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  const detail = `login ok — fresh cookie stored (${cookie.length} chars from ${setCookies.length} set-cookie)`;
  console.log(`[letspoker-push] ${detail}`);
  await logFire({ source: "login", tournament_event_id: null, http_status: 200, ok: true, detail });
  return new Response(JSON.stringify({ ok: true, stored: Boolean(url && key), cookieLength: cookie.length }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Tick scheduler. One cron fires every 30 min (mode "tick"); for each upcoming
// or in-progress game the function computes that game's own fire instants and
// sends any slot whose 30-min bucket is "now" and hasn't been sent yet.
//
// Buckets (auto, by Perth start time): start <= 14:00 -> daytime, else evening.
//   Evening  countdown (Perth): 06 09 12 15 17 18
//   Daytime  countdown (Perth): 06 09 10 11 12 12:30
//   Teaser:   20:30 the night before
//   In-event: start +30/+60/+90/+120/+150 (every 30 min, first 150 min)
// A countdown fire is kept only if it falls at/before start; later clock-times
// are dropped so they never collide with the in-event series (e.g. an 11:30
// start drops its 12:00/12:30 countdowns — in-event covers those instants).
// ---------------------------------------------------------------------------

const PERTH = "+08:00";
const TICK_MS = 30 * 60 * 1000;
const TEASER_HHMM = "20:30";
const IN_EVENT_OFFSETS_MIN = [30, 60, 90, 120, 150];
const COUNTDOWN: Record<"daytime" | "evening", string[]> = {
  evening: ["06:00", "09:00", "12:00", "15:00", "17:00", "18:00"],
  daytime: ["06:00", "09:00", "10:00", "11:00", "12:00", "12:30"],
};
// In-event pushes target an already-started game; "timeRelative" may read oddly
// there. Swap in a "live now" / "late reg" token once we confirm what LetsPoker
// exposes. Until then it mirrors the standard parts.
const IN_EVENT_TEMPLATE_PARTS = TEMPLATE_PARTS;

// Absolute instant for a Perth local date (YYYY-MM-DD) at HH:MM.
function perthInstant(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00${PERTH}`);
}

function bucketOf(startsAt: string | null): "daytime" | "evening" {
  if (!startsAt) return "evening";
  const d = new Date(startsAt);
  const minsOfDay = ((d.getUTCHours() + 8) % 24) * 60 + d.getUTCMinutes();
  return minsOfDay <= 14 * 60 ? "daytime" : "evening";
}

type Game = { tournament_event_id: string; event_date: string; starts_at: string | null };
type Fire = { slot: string; at: number };

// Every fire instant a game should produce, with a stable slot label for dedupe.
function firesFor(g: Game): Fire[] {
  const fires: Fire[] = [];
  const startMs = g.starts_at ? new Date(g.starts_at).getTime() : null;

  // Teaser: 20:30 the night before (= event-date 20:30 minus 24h).
  fires.push({ slot: "teaser", at: perthInstant(g.event_date, TEASER_HHMM).getTime() - 24 * 3600 * 1000 });

  // Countdown clock-times, dropped once they pass start (in-event covers those).
  for (const t of COUNTDOWN[bucketOf(g.starts_at)]) {
    const at = perthInstant(g.event_date, t).getTime();
    if (startMs !== null && at > startMs) continue;
    fires.push({ slot: `cd-${t.replace(":", "")}`, at });
  }

  // In-event series, relative to the game's own start.
  if (startMs !== null) {
    for (const m of IN_EVENT_OFFSETS_MIN) fires.push({ slot: `ie-${m}`, at: startMs + m * 60000 });
  }
  return fires;
}

// Non-excluded games on the given Perth dates (id, date, start).
async function lookupGames(dates: string[]): Promise<Game[]> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const inList = dates.map((d) => `"${d}"`).join(",");
    const res = await fetch(
      `${url}/rest/v1/tournament_events?event_date=in.(${inList})&excluded=is.false&select=tournament_event_id,event_date,starts_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    const rows = await res.json();
    if (Array.isArray(rows)) return rows as Game[];
  } catch (_e) {
    // fall through
  }
  return [];
}

// Claim a slot in letspoker_fired. Returns true only if WE inserted it (so the
// push fires exactly once); false if it was already claimed.
async function claimSlot(eventId: string, slot: string): Promise<boolean> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url}/rest/v1/letspoker_fired`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify({ event_id: eventId, slot }),
    });
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  } catch (_e) {
    return false;
  }
}

// Release a claim so a failed send retries on the next tick.
async function releaseSlot(eventId: string, slot: string) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/letspoker_fired?event_id=eq.${eventId}&slot=eq.${slot}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
    });
  } catch (_e) {
    // best-effort
  }
}

async function runTick(cookie: string, sessionGroupId: string, clubId: string): Promise<Response> {
  const nowBucket = Math.floor(Date.now() / TICK_MS);
  // today ±1 Perth day covers teaser (night before), countdown, and in-event spillover.
  const games = await lookupGames([perthDate(-1), perthDate(0), perthDate(1)]);

  const results: unknown[] = [];
  for (const g of games) {
    for (const f of firesFor(g)) {
      if (Math.floor(f.at / TICK_MS) !== nowBucket) continue; // not due in this tick
      if (!(await claimSlot(g.tournament_event_id, f.slot))) continue; // already sent
      const parts = f.slot.startsWith("ie-") ? IN_EVENT_TEMPLATE_PARTS : TEMPLATE_PARTS;
      const r = await sendPush(cookie, sessionGroupId, clubId, `tick:${f.slot}`, "tick", g.event_date, g.tournament_event_id, parts);
      if (!r.ok) await releaseSlot(g.tournament_event_id, f.slot); // let it retry next tick
      results.push({ eventId: g.tournament_event_id, slot: f.slot, ...r });
    }
  }

  const allOk = results.every((r) => (r as { ok: boolean }).ok);
  return new Response(JSON.stringify({ ok: allOk, mode: "tick", fired: results }), {
    status: allOk ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cookie = await getCookie();
  // Not secret (constant ids); overridable via env if they ever change.
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";

  let mode = "countdown";
  let overrideEventId: string | undefined;
  let overrideAuthToken: string | undefined;
  let dryRun = false;
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body.mode === "string") mode = body.mode;
      if (body && typeof body.tournamentEventId === "string") overrideEventId = body.tournamentEventId;
      if (body && typeof body.authToken === "string") overrideAuthToken = body.authToken;
      if (body && body.dryRun === true) dryRun = true;
    }
  } catch {
    // no/invalid body — default to countdown
  }

  // Debug: return the TOTP code we generate, to compare against the authenticator app.
  if (mode === "totpcheck") {
    const seed = env("LETSPOKER_TOTP_SECRET");
    if (!seed) return new Response(JSON.stringify({ ok: false, error: "no LETSPOKER_TOTP_SECRET" }), { status: 500, headers: { "Content-Type": "application/json" } });
    try {
      const code = await totp(seed);
      const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
      return new Response(JSON.stringify({ ok: true, code, secondsRemaining }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  // Headless login bootstraps the cookie — runs without one. Optional body.authToken
  // overrides the generated TOTP (used to isolate seed vs. login-shape problems).
  if (mode === "login") return await runLogin(overrideAuthToken);

  // Cookie is required for any LetsPoker call.
  if (!cookie) {
    const detail = "Missing config: LETSPOKER_COOKIE";
    await logFire({ source: mode, tournament_event_id: null, http_status: null, ok: false, detail });
    await alertJustin("LetsPoker push misconfigured", detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // Calendar sync.
  if (mode === "sync") return await runSync(cookie, sessionGroupId, clubId, dryRun);

  // Tick scheduler: per-game fire times (teaser + countdown + in-event).
  if (mode === "tick") return await runTick(cookie, sessionGroupId, clubId);

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
