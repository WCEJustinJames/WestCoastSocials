-- Stores the Google People API sync token so each Contacts sync only fetches
-- contacts that changed since last run (incremental). One row, id=1.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
create table if not exists inbox_contacts_sync (
  id int primary key default 1,
  sync_token text,
  updated_at timestamptz default now()
);
insert into inbox_contacts_sync (id) values (1) on conflict (id) do nothing;
