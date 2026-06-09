// CSV export helper for the lp_* analysis views. Service-role read, returns
// text/csv so results can be fetched straight to disk. Guarded by a shared
// token on top of verify_jwt. Read-only; whitelisted views only.
//
//   POST { "guard": "...", "view": "lp_churn", "query": "select=*&order=drop_abs.desc&limit=1000&offset=0" }
//
// PostgREST caps each page at 1000 rows — paginate with limit/offset for larger views.

const GUARD = "wcp_probe_5f3a9c21d8b74e60aa17";
const ALLOWED = new Set(["lp_player_summary", "lp_churn", "lp_event_enriched", "lp_entry_enriched", "lp_event_summary"]);

Deno.serve(async (req) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  if (body?.guard !== GUARD) return new Response("forbidden", { status: 403 });
  const view = String(body?.view || "");
  if (!ALLOWED.has(view)) return new Response("bad view", { status: 400 });
  const qs = typeof body?.query === "string" && body.query.length ? body.query : "select=*";
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${url}/rest/v1/${view}?${qs}`, { headers: { apikey: key!, Authorization: `Bearer ${key}`, Accept: "text/csv" } });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "Content-Type": "text/csv; charset=utf-8" } });
});
