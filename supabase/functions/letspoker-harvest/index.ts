// LetsPoker history harvester. Given a date window, pulls every tournament in
// that range (getEventList) with its full entrant roster and upserts into
// public.lp_events / public.lp_entries. Idempotent; safe to re-run / cron.
//
//   POST { "start": "2025-07-01T00:00:00.000Z", "end": "2025-08-01T00:00:00.000Z" }
//
// One row per (event, player): entry_count folds re-entries; position keeps the
// best (lowest) finish; winnings keeps the player's actual prize (payout.value).
// The session cookie stays server-side (env LETSPOKER_COOKIE or letspoker_auth).

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";
const CLUB_ID = Deno.env.get("LETSPOKER_CLUB_ID") || "8f025bf9ecfa14c8";
const SESSION_GROUP = Deno.env.get("LETSPOKER_SESSION_GROUPID") || "wcp";

const LIST_QUERY = `query($clubId: ID!, $startDate: DateTime!, $endDate: DateTime!){
  getEventList(clubId:$clubId, startDate:$startDate, endDate:$endDate, includeCash:false){
    id scheduledDate entries rebuys
    config { general { eventName } }
    players { playerId firstName lastName position payout { value } }
  }
}`;

function env(n: string): string | undefined {
  const v = Deno.env.get(n);
  return v && v.length > 0 ? v : undefined;
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

function perthDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function rest(path: string, init: RequestInit): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return await fetch(`${url}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const start = body.start as string | undefined;
  const end = body.end as string | undefined;
  if (!start || !end) {
    return new Response(JSON.stringify({ ok: false, error: "need start & end ISO datetimes" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const cookie = await getCookie();
  if (!cookie) return new Response(JSON.stringify({ ok: false, error: "no cookie" }), { status: 500, headers: { "Content-Type": "application/json" } });

  let text = "";
  let status = 0;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "x-app-section": "admin",
        "x-app-version": "2.0.1",
        "x-session-groupid": SESSION_GROUP,
        Cookie: cookie,
      },
      body: JSON.stringify([{ operationName: null, query: LIST_QUERY, variables: { clubId: CLUB_ID, startDate: start, endDate: end } }]),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: `fetch failed: ${e}` }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  let events: any[] = [];
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json) ? json[0] : json;
    if (first?.errors?.length) {
      return new Response(JSON.stringify({ ok: false, status, error: "graphql error", detail: JSON.stringify(first.errors).slice(0, 400) }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    events = first?.data?.getEventList ?? [];
  } catch {
    return new Response(JSON.stringify({ ok: false, status, error: "parse failed", body: text.slice(0, 300) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const eventRows: any[] = [];
  const entryRowsMap = new Map<string, any>();
  for (const e of events) {
    if (!e?.id || !e?.scheduledDate) continue;
    eventRows.push({
      id: e.id,
      scheduled_at: e.scheduledDate,
      event_date: perthDate(e.scheduledDate),
      event_name: e?.config?.general?.eventName ?? null,
      entries: typeof e.entries === "number" ? e.entries : null,
      rebuys: typeof e.rebuys === "number" ? e.rebuys : null,
      synced_at: new Date().toISOString(),
    });
    for (const p of e.players ?? []) {
      if (!p?.playerId) continue;
      const k = `${e.id}::${p.playerId}`;
      const pos = typeof p.position === "number" ? p.position : null;
      const win = p?.payout?.value ?? null;
      const existing = entryRowsMap.get(k);
      if (existing) {
        existing.entry_count += 1;
        if (pos !== null && (existing.position === null || pos < existing.position)) existing.position = pos;
        if (win !== null && (existing.winnings === null || win > existing.winnings)) existing.winnings = win;
      } else {
        entryRowsMap.set(k, {
          event_id: e.id, player_id: p.playerId,
          first_name: p.firstName ?? null, last_name: p.lastName ?? null,
          position: pos, winnings: win, entry_count: 1,
        });
      }
    }
  }
  const entryRows = [...entryRowsMap.values()];

  let eventsUp = 0, entriesUp = 0;
  if (eventRows.length) {
    const r = await rest(`/rest/v1/lp_events?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(eventRows),
    });
    if (!r.ok) return new Response(JSON.stringify({ ok: false, stage: "events", status: r.status, detail: (await r.text()).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
    eventsUp = eventRows.length;
  }
  for (let i = 0; i < entryRows.length; i += 1000) {
    const chunk = entryRows.slice(i, i + 1000);
    const r = await rest(`/rest/v1/lp_entries?on_conflict=event_id,player_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) return new Response(JSON.stringify({ ok: false, stage: "entries", status: r.status, detail: (await r.text()).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
    entriesUp += chunk.length;
  }

  return new Response(JSON.stringify({ ok: true, window: { start, end }, events: eventsUp, players: entriesUp, rawEntrants: entryRows.reduce((a, r) => a + r.entry_count, 0) }), { status: 200, headers: { "Content-Type": "application/json" } });
});
