-- WCE Unified Inbox — global runtime settings (single row, id=1).
-- Adds a send KILL-SWITCH the send paths check before every outbound, so sends
-- can be halted instantly from the UI, SQL, or the cloud without closing/
-- restarting the PC sync. Additive; permissive RLS to match the other inbox_
-- tables. Applied to project "WCE App" (dexdftcmcixppbuucjfd).

create table if not exists inbox_settings (
  id integer primary key default 1,
  sends_paused boolean not null default false,
  paused_reason text,
  updated_at timestamptz not null default now(),
  constraint inbox_settings_singleton check (id = 1)
);

-- Seed the single row so the sync always finds it (read fails open otherwise).
insert into inbox_settings (id, sends_paused) values (1, false)
  on conflict (id) do nothing;

alter table inbox_settings enable row level security;

drop policy if exists inbox_settings_all on inbox_settings;
create policy inbox_settings_all on inbox_settings for all using (true) with check (true);

grant select, insert, update, delete on inbox_settings to anon, authenticated, service_role;
