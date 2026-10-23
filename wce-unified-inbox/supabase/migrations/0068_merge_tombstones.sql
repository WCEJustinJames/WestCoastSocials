-- WCE Unified Inbox — merge tombstones.
-- A merge in Players / Merge & Review DELETES the duplicate rows it folds into
-- the keeper — but every import path (Google Contacts sync on both account
-- slots, the Airtable mirror) re-INSERTS any source key it no longer finds in
-- inbox_outreach. A Google sync-token expiry forces a full resync of every
-- contact, so each merged-away gcontact:/gcsv:/rec… duplicate quietly came back
-- within days, which is why the duplicate list never shrank.
-- This table records the source keys retired by a merge (and the keeper they
-- merged into); the sync skips any incoming row whose key is tombstoned.
-- Additive only. Apply to project "WCE App" (dexdftcmcixppbuucjfd).

create table if not exists inbox_merge_tombstones (
  airtable_id text primary key,
  merged_into uuid references inbox_outreach(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table inbox_merge_tombstones enable row level security;
drop policy if exists inbox_merge_tombstones_auth_all on inbox_merge_tombstones;
create policy inbox_merge_tombstones_auth_all on inbox_merge_tombstones
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on inbox_merge_tombstones to authenticated, service_role;
