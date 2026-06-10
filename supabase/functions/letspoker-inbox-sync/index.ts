// LetsPoker app-chat -> unified inbox adapter.
//
// The unified inbox (inbox_conversations / inbox_messages / inbox_people /
// inbox_identities) already supports an adapter enum of {beeper, letspoker};
// beeper is fed by a separate host, this function fills the letspoker side.
//
// LetsPoker exposes its in-app club chat over the same admin GraphQL endpoint
// the tournament push uses. Chat is ROOM-centric (not 1:1): a fixed set of
// rooms (cash, tournaments, support, ...) each carry a flat message list.
//   read:  getAllChats(clubId: ID!, roomName: String!): ClubChatMessages
//   send:  sendClubMessage(clubId: ID!, roomName: AppChatRoomNames!, text: String!)
//   del:   deleteChatMessage(clubId: ID!, messageId: ID!)
// We model each room as a `group` conversation (external_chat_id = roomName)
// and each ClubChatMessage as an inbox_message. Human senders become people /
// identities; club + admin messages are outbound with no person.
//
// Modes (POST body { "mode": ... }):
//   - "sync" (default)            -> poll every room, upsert conversations/people/messages
//   - "sync" + { "dryRun": true } -> report per-room counts, write nothing
//   - "send" + { roomName, text } -> sendClubMessage, then re-sync that room so the
//                                    just-sent message is ingested with its real id
//
// Auth: the session cookie in public.letspoker_auth (auto-refreshed by
// letspoker-push "login" mode), falling back to the LETSPOKER_COOKIE secret.
// Only the cookie is secret; club / session-group ids are constants below.

const ENDPOINT = "https://wcp.admin.lets.poker/api/graphql?ngsw-bypass=true";

const ADAPTER = "letspoker";
const NETWORK = "LetsPoker";

// AppChatRoomNames enum values (from the admin app bundle) -> display titles.
const ROOMS: Record<string, string> = {
  cash: "Cash Games",
  tournaments: "Tournaments",
  hospitality: "Food/Drink Service",
  support: "Support & Feedback",
  massage: "Poker Massage",
  CashFloor: "Cash Floor",
  TournamentFloor: "Tournament Floor",
  announcements: "Announcements",
};

const CHAT_QUERY = `query getAllChats($clubId: ID!, $roomName: String!) {
  getAllChats(clubId: $clubId, roomName: $roomName) {
    totalCount
    edges {
      id
      clubId
      createdAt
      text
      isHumanSender
      isDeleted
      sentByAdminUserId
      sender { id firstName lastName }
      senderFull { id firstName lastName displayName nickName email phoneNumber country avatarUrl }
    }
  }
}`;

const SEND_MUTATION = `mutation sendClubMessage($clubId: ID!, $roomName: AppChatRoomNames!, $text: String!) {
  sendClubMessage(clubId: $clubId, roomName: $roomName, text: $text)
}`;

// ----------------------------- small helpers -----------------------------

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type AppUser = {
  id?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  nickName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
};

type ChatMessage = {
  id: string;
  clubId?: string | null;
  createdAt: string;
  text?: string | null;
  isHumanSender?: boolean | null;
  isDeleted?: boolean | null;
  sentByAdminUserId?: string | null;
  sender?: AppUser | null;
  senderFull?: AppUser | null;
};

function displayNameOf(u: AppUser | null | undefined): string | null {
  if (!u) return null;
  if (u.displayName && u.displayName.trim()) return u.displayName.trim();
  if (u.nickName && u.nickName.trim()) return u.nickName.trim();
  const full = [u.firstName, u.lastName].filter((x) => x && x.trim()).join(" ").trim();
  return full || null;
}

// ----------------------------- LetsPoker GQL -----------------------------

function lpHeaders(cookie: string, sessionGroupId: string): HeadersInit {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-app-section": "admin",
    "x-app-version": "2.0.1",
    "x-session-groupid": sessionGroupId,
    Cookie: cookie,
  };
}

// Prefer the auto-refreshed cookie in letspoker_auth, fall back to the env secret.
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

// Run one batched GraphQL operation. Returns the first response's `data`, or
// throws an Error carrying the GraphQL/HTTP failure for the caller to surface.
async function lpGraphql(
  cookie: string, sessionGroupId: string,
  operationName: string, query: string, variables: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: lpHeaders(cookie, sessionGroupId),
    body: JSON.stringify([{ operationName, query, variables }]),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`LP ${operationName} HTTP ${res.status}: ${text.slice(0, 300)}`);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`LP ${operationName} non-JSON: ${text.slice(0, 200)}`); }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.errors?.length) throw new Error(`LP ${operationName} errors: ${first.errors.map((e: any) => e.message).join("; ")}`);
  return first?.data;
}

// ------------------------------- Supabase --------------------------------

function sbHeaders(extra: HeadersInit = {}): HeadersInit {
  const key = env("SUPABASE_SERVICE_ROLE_KEY")!;
  return { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, ...extra };
}
function sbUrl(path: string): string { return `${env("SUPABASE_URL")}/rest/v1/${path}`; }

async function sbSelect(path: string): Promise<any[]> {
  const res = await fetch(sbUrl(path), { headers: sbHeaders() });
  if (!res.ok) throw new Error(`select ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}
// Upsert (merge) and return the rows. on_conflict must be set by the caller in `path`.
async function sbUpsert(table: string, rows: unknown[], onConflict: string): Promise<any[]> {
  if (!rows.length) return [];
  const res = await fetch(sbUrl(`${table}?on_conflict=${onConflict}`), {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}
async function sbInsert(table: string, rows: unknown[]): Promise<any[]> {
  if (!rows.length) return [];
  const res = await fetch(sbUrl(table), {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}
// Append-only insert: existing rows (matched on `onConflict`) are left untouched,
// so inbox-managed state (read flags, edits) is never clobbered. Returns only the
// rows that were actually inserted.
async function sbInsertIgnore(table: string, rows: unknown[], onConflict: string): Promise<any[]> {
  if (!rows.length) return [];
  const res = await fetch(sbUrl(`${table}?on_conflict=${onConflict}`), {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert-ignore ${table} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}
async function sbPatch(path: string, patch: unknown): Promise<void> {
  const res = await fetch(sbUrl(path), {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Ensure an inbox person + letspoker identity exists for each human app user.
// Returns a map of LP appUserId -> inbox person_id. Reuses existing identities
// so re-syncs don't create duplicate people.
async function ensurePeople(accountId: string, users: AppUser[]): Promise<Map<string, string>> {
  const byId = new Map<string, AppUser>();
  for (const u of users) if (u?.id) byId.set(u.id, u);
  const ids = [...byId.keys()];
  const out = new Map<string, string>();
  if (!ids.length) return out;

  const inList = ids.map((i) => `"${i}"`).join(",");
  const existing = await sbSelect(
    `inbox_identities?adapter=eq.${ADAPTER}&account_id=eq.${accountId}&external_id=in.(${inList})&select=external_id,person_id`,
  );
  for (const row of existing) out.set(row.external_id, row.person_id);

  const missing = ids.filter((i) => !out.has(i));
  if (missing.length) {
    // One person per missing user, then one identity each (FK person_id is NOT NULL).
    const people = await sbInsert(
      "inbox_people",
      missing.map((id) => ({ display_name: displayNameOf(byId.get(id)) })),
    );
    const newIdentities = missing.map((id, idx) => {
      const u = byId.get(id)!;
      return {
        person_id: people[idx].id,
        adapter: ADAPTER,
        network: NETWORK,
        account_id: accountId,
        external_id: id,
        handle: displayNameOf(u) ?? u.email ?? u.phoneNumber ?? null,
        is_primary: true,
      };
    });
    const upserted = await sbUpsert("inbox_identities", newIdentities, "adapter,account_id,external_id");
    for (const row of upserted) out.set(row.external_id, row.person_id);
  }
  return out;
}

type RoomResult = { room: string; totalCount: number; ingested: number; unread: number; conversationId?: string };

const directionOf = (m: ChatMessage): "inbound" | "outbound" =>
  m.sentByAdminUserId ? "outbound" : (m.isHumanSender ? "inbound" : "outbound");

// Pull one room and append new messages into the inbox. Idempotent and
// non-destructive: existing messages keep their inbox-managed read state.
// The first time a room is seen it is imported as already-read (calm backfill);
// after that, only newly-arrived inbound messages are flagged unread and the
// conversation's unread_count is incremented (never recomputed/resurrected).
//
// Note: getAllChats has no pagination and caps at the 200 most-recent messages
// per room, so only recent history is backfilled.
async function syncRoom(
  cookie: string, sessionGroupId: string, clubId: string, accountId: string,
  roomName: string, dryRun: boolean,
): Promise<RoomResult> {
  const data = await lpGraphql(cookie, sessionGroupId, "getAllChats", CHAT_QUERY, { clubId, roomName });
  const conn = data?.getAllChats ?? { edges: [] };
  const edges: ChatMessage[] = Array.isArray(conn.edges) ? conn.edges : [];
  const totalCount: number = edges.length; // LP's totalCount is unreliable (always 0)

  const lastActivity = edges.reduce<string | null>(
    (acc, m) => (!acc || new Date(m.createdAt) > new Date(acc) ? m.createdAt : acc), null,
  );

  if (dryRun) {
    const inbound = edges.filter((m) => directionOf(m) === "inbound" && !m.isDeleted).length;
    return { room: roomName, totalCount, ingested: edges.length, unread: inbound };
  }

  // 1) Find or create the room's conversation. Whether it already existed
  //    decides backfill (read) vs incremental (unread) treatment.
  const existingConvs = await sbSelect(
    `inbox_conversations?adapter=eq.${ADAPTER}&account_id=eq.${accountId}&external_chat_id=eq.${encodeURIComponent(roomName)}&select=id,unread_count,last_activity`,
  );
  const isNewConversation = existingConvs.length === 0;
  const [conv] = await sbUpsert("inbox_conversations", [{
    adapter: ADAPTER, network: NETWORK, account_id: accountId,
    external_chat_id: roomName, title: ROOMS[roomName] ?? roomName, type: "group",
  }], "adapter,account_id,external_chat_id");
  const conversationId = conv.id as string;
  const priorUnread = existingConvs[0]?.unread_count ?? 0;
  const priorActivity = existingConvs[0]?.last_activity ?? null;

  let newInbound = 0;
  if (edges.length) {
    // 2) People / identities for human senders (idempotent).
    const humanUsers = edges
      .filter((m) => directionOf(m) === "inbound")
      .map((m) => m.senderFull ?? m.sender)
      .filter((u): u is AppUser => Boolean(u?.id));
    const personByUser = await ensurePeople(accountId, humanUsers);

    // 3) Append messages. On backfill everything is read; afterwards inbound is unread.
    const rows = edges.map((m) => {
      const dir = directionOf(m);
      const u = m.senderFull ?? m.sender ?? null;
      const personId = dir === "inbound" && u?.id ? personByUser.get(u.id) ?? null : null;
      return {
        conversation_id: conversationId,
        person_id: personId,
        adapter_source: ADAPTER,
        network: NETWORK,
        external_message_id: m.id,
        sort_key: m.createdAt,
        sender_id: u?.id ?? m.sentByAdminUserId ?? null,
        sender_name: dir === "inbound" ? displayNameOf(u) : (m.sentByAdminUserId ? "Admin" : ROOMS[roomName] ?? "Club"),
        direction: dir,
        kind: "1to1",
        text: m.text ?? null,
        timestamp: m.createdAt,
        is_unread: isNewConversation ? false : (dir === "inbound" && !m.isDeleted),
        raw: m,
      };
    });
    const inserted = await sbInsertIgnore("inbox_messages", rows, "adapter_source,external_message_id");
    newInbound = inserted.filter((r) => r.direction === "inbound" && r.is_unread).length;
  }

  // 4) Roll forward conversation state without clobbering inbox-managed reads.
  const nextActivity = [priorActivity, lastActivity]
    .filter(Boolean)
    .sort((a, b) => new Date(b as string).getTime() - new Date(a as string).getTime())[0] ?? null;
  const nextUnread = isNewConversation ? 0 : priorUnread + newInbound;
  await sbPatch(`inbox_conversations?id=eq.${conversationId}`, { last_activity: nextActivity, unread_count: nextUnread });

  return { room: roomName, totalCount, ingested: edges.length, unread: nextUnread, conversationId };
}

async function runSync(
  cookie: string, sessionGroupId: string, clubId: string, accountId: string, dryRun: boolean,
): Promise<Response> {
  const rooms: RoomResult[] = [];
  const errors: { room: string; error: string }[] = [];
  for (const room of Object.keys(ROOMS)) {
    try {
      rooms.push(await syncRoom(cookie, sessionGroupId, clubId, accountId, room, dryRun));
    } catch (e) {
      errors.push({ room, error: String(e) });
    }
  }
  // Heartbeat so the inbox knows the letspoker side is alive (best-effort).
  if (!dryRun) {
    try {
      await fetch(sbUrl("inbox_sync_heartbeat?id=eq.1"), {
        method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ last_run: new Date().toISOString(), note: "letspoker-inbox-sync" }),
      });
    } catch (_e) { /* best-effort */ }
  }
  const ingested = rooms.reduce((n, r) => n + r.ingested, 0);
  return json({ ok: errors.length === 0, mode: "sync", dryRun, ingested, rooms, errors }, errors.length ? 207 : 200);
}

async function runSend(
  cookie: string, sessionGroupId: string, clubId: string, accountId: string,
  roomName: string, text: string,
): Promise<Response> {
  if (!ROOMS[roomName]) return json({ ok: false, error: `unknown roomName "${roomName}"; valid: ${Object.keys(ROOMS).join(", ")}` }, 400);
  if (!text || !text.trim()) return json({ ok: false, error: "text is required" }, 400);

  const data = await lpGraphql(cookie, sessionGroupId, "sendClubMessage", SEND_MUTATION, { clubId, roomName, text });
  // Re-sync the room so the just-sent message lands with its real LP id.
  let synced: RoomResult | undefined;
  try {
    synced = await syncRoom(cookie, sessionGroupId, clubId, accountId, roomName, false);
  } catch (e) {
    return json({ ok: true, sent: data?.sendClubMessage ?? true, room: roomName, syncError: String(e) });
  }
  return json({ ok: true, sent: data?.sendClubMessage ?? true, room: roomName, synced });
}

Deno.serve(async (req) => {
  const cookie = await getCookie();
  const sessionGroupId = env("LETSPOKER_SESSION_GROUPID") ?? "wcp";
  const clubId = env("LETSPOKER_CLUB_ID") ?? "8f025bf9ecfa14c8";
  // Group all letspoker rows under the club as the inbox "account".
  const accountId = clubId;

  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) {
    return json({ ok: false, error: "missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }
  if (!cookie) return json({ ok: false, error: "missing LetsPoker cookie (letspoker_auth / LETSPOKER_COOKIE)" }, 500);

  let mode = "sync";
  let dryRun = false;
  let roomName = "";
  let text = "";
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      if (typeof body?.mode === "string") mode = body.mode;
      if (body?.dryRun === true) dryRun = true;
      if (typeof body?.roomName === "string") roomName = body.roomName;
      if (typeof body?.text === "string") text = body.text;
    }
  } catch { /* default sync */ }

  try {
    if (mode === "send") return await runSend(cookie, sessionGroupId, clubId, accountId, roomName, text);
    return await runSync(cookie, sessionGroupId, clubId, accountId, dryRun);
  } catch (e) {
    return json({ ok: false, mode, error: String(e) }, 500);
  }
});
