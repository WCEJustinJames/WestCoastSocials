-- The most recently imported Facebook friends list (just the names), stored as a
-- single JSON blob. The browser importer overwrites it on each import; the sync
-- re-matches it against the CRM on a cadence, so newly-added players who are on
-- the list get the fb_friend flag automatically (no re-import needed). You only
-- re-drop the export when your actual Facebook friends change.
create table if not exists inbox_fb_friends (
  id int primary key default 1,
  names jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
