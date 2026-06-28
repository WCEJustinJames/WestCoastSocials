-- Mark CRM players who appear on a downloaded Facebook friends list. When true
-- and the player has no Messenger thread yet, the CRM shows "DM to open": you're
-- friends on Facebook, so sending ONE Messenger message creates the thread the
-- auto-linker then connects to this record. Once linked, the chip flips to
-- "Messenger" on its own. Set in bulk by the in-app FB-friends importer.
alter table inbox_outreach
  add column if not exists fb_friend boolean not null default false;
