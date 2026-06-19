-- Cash-game player segment, parallel to the tournament flag. Opt-in tag (default
-- false) so it can target cash-specific promos, the same way tournament targets
-- event promos. Surfaced as a per-player checkbox + a list filter in the UI.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_outreach add column if not exists cash boolean not null default false;
