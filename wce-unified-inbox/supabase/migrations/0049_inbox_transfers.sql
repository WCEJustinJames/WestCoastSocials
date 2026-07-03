-- 0049_inbox_transfers.sql
-- TD-sheet bank-transfer reconciliation. The sync mirrors every transfer line
-- (cash in/out, tournament in, winner payouts) WITH its cell coordinates, so a
-- dashboard confirmation can be written back into the sheet's Office Confirm
-- cell as JL (+ the last-4 receipt ref for outgoing). Additive.
create table if not exists public.inbox_transfers (
  id uuid primary key default gen_random_uuid(),
  sheet_id text not null,
  sheet_title text,
  tab_title text not null,
  game_date date,
  venue text,
  kind text not null,             -- transfer_in | transfer_out | winner_payout
  direction text not null,        -- in | out
  row_num int not null,           -- 1-based sheet row of the line
  name text,
  amount text,
  receipt text,
  wcp_verified text,
  time_stamp text,
  pay_method text,
  notes text,
  office_confirm text not null default '',
  confirm_col text not null,      -- A1 column letter of the Office Confirm cell
  receipt_col text,               -- A1 column letter of the receipt cell (out rows)
  confirm_state text not null default 'unconfirmed', -- unconfirmed | queued | written
  confirm_ref text,               -- last-4 receipt ref provided at confirmation
  pending boolean not null default false,
  synced_at timestamptz not null default now(),
  unique (sheet_id, tab_title, kind, row_num)
);
alter table public.inbox_transfers enable row level security;
drop policy if exists inbox_transfers_all on public.inbox_transfers;
create policy inbox_transfers_all on public.inbox_transfers for all using (true) with check (true);
grant all on public.inbox_transfers to anon, authenticated;
create index if not exists inbox_transfers_open_idx on public.inbox_transfers (confirm_state, game_date desc);
