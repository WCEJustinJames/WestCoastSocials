-- Extracted "Poker Banking and Cash Chips" receipt photos. The receipts:extract
-- script reads each receipt image off the local Beeper media cache, runs it
-- through Claude vision, and writes the structured fields here for review. A
-- confirmed row with a mobile becomes a messageable recipient.
create table if not exists inbox_receipts (
  id uuid primary key default gen_random_uuid(),
  external_message_id text unique not null,
  chat_id text,
  captured_at timestamptz,
  image_file text,
  receipt_date text,
  venue text,
  club text,
  first_name text,
  surname text,
  player_name text,
  mobile text,
  game_type text,
  total_winnings numeric,
  amount numeric,
  paid boolean,
  raw_extract jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);
create index if not exists inbox_receipts_review_idx on inbox_receipts (review_status);
create index if not exists inbox_receipts_mobile_idx on inbox_receipts (mobile);

alter table inbox_receipts enable row level security;
create policy inbox_receipts_all on inbox_receipts for all using (true) with check (true);
grant select, insert, update, delete on inbox_receipts to anon, authenticated;
