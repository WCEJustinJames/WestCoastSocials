# letspoker-cash — deploy

This is the source of the `letspoker-cash` Supabase edge function (cash-table
automation on LetsPoker). It normally deploys via the Supabase MCP tool, but
this file is the version-controlled copy so it can also be deployed by hand.

## Deploy

```
supabase functions deploy letspoker-cash --project-ref dexdftcmcixppbuucjfd
```

`verify_jwt` is **true** (the function is called by pg_cron / the sync engine
with the service-role JWT).

## v14 — public tables

Cash tables now open **public** by default:

- `AddTable` sends `isPublic: true` in its `eventData`.
- Each opened table is then confirmed public with a follow-up
  `ModifyTable { isPublic: true }` (some LP builds ignore `isPublic` on create
  and fall back to private).
- `specFromTable` (the "same tables as last week" copier) also stamps
  `isPublic: true`, since older logs predate the flag.

Everything else (day creation, auto-start, idempotent no-double-open, seat /
push / finish, dryRun defaults) is unchanged from v13.
