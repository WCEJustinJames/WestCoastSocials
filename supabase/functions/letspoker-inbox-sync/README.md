# letspoker-inbox-sync

Feeds the **LetsPoker** side of the unified inbox. The inbox schema
(`inbox_conversations` / `inbox_messages` / `inbox_people` / `inbox_identities`)
already supports an `inbox_adapter` enum of `{beeper, letspoker}`; Beeper is fed
by a separate host, this edge function fills the `letspoker` side.

## What it does

LetsPoker's in-app club chat is exposed over the same admin GraphQL endpoint the
tournament push uses (`wcp.admin.lets.poker/api/graphql`). Chat is **room-centric**,
not 1:1 — a fixed set of rooms each carry a flat message list:

| GraphQL | purpose |
| --- | --- |
| `getAllChats(clubId: ID!, roomName: String!): ClubChatMessages` | read a room (no pagination; **caps at the 200 most-recent** messages) |
| `sendClubMessage(clubId: ID!, roomName: AppChatRoomNames!, text: String!)` | post to a room as the club |
| `deleteChatMessage(clubId: ID!, messageId: ID!)` | delete a message |

`AppChatRoomNames` = `cash`, `tournaments`, `hospitality`, `support`, `massage`,
`CashFloor`, `TournamentFloor`, `announcements`.

Each room becomes a `group` conversation (`external_chat_id = roomName`,
`account_id = clubId`, `network = LetsPoker`). Each `ClubChatMessage` becomes an
`inbox_message`. `isHumanSender` / `sentByAdminUserId` decide direction; human
senders are matched to inbox people via `inbox_identities` (keyed on the LP
`appUserId`), so re-syncs never create duplicate people.

## Modes (POST body)

- `{"mode":"sync"}` (default) — poll every room, append new messages.
- `{"mode":"sync","dryRun":true}` — report per-room counts, write nothing.
- `{"mode":"send","roomName":"support","text":"..."}` — send via `sendClubMessage`,
  then re-sync that room so the sent message is ingested with its real LP id.

### Read / unread semantics

Ingestion is **append-only and idempotent** (insert on conflict
`adapter_source,external_message_id` ignore-duplicates), so inbox-managed read
state is never clobbered. The **first** import of a room is marked already-read
(calm backfill); afterwards only newly-arrived inbound messages are flagged unread
and the conversation's `unread_count` is incremented.

## Auth & config

- Reuses the session cookie in `public.letspoker_auth` (auto-refreshed by the
  `letspoker-push` `login` mode), falling back to the `LETSPOKER_COOKIE` secret.
- `clubId` / `sessionGroupId` default to the WCP constants and are overridable via
  `LETSPOKER_CLUB_ID` / `LETSPOKER_SESSION_GROUPID`.
- Writes via PostgREST as `service_role`; see
  `supabase/migrations/20260610000000_grant_service_role_inbox_for_letspoker_sync.sql`
  for the required grants.

## Deploy & schedule

```bash
supabase functions deploy letspoker-inbox-sync
```

A pg_cron job (`letspoker-inbox-sync`, every 5 min) invokes `{"mode":"sync"}` using
the `letspoker_inbox_sync_function_url` + `letspoker_push_function_token` vault
secrets — mirroring the existing `letspoker-*` jobs.
