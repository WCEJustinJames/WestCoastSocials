-- Indefinite pause for the cash-games group seat-list posting, independent of the
-- sends/replies switches. When true, the sync never posts or updates the group
-- roster. Surfaced as the "Group" toggle in the app nav.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_settings add column if not exists roster_paused boolean not null default false;
