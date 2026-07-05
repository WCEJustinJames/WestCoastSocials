-- Allow the static roster-review page (cash.html, using the anon publishable
-- key) to read and edit the cash plan + roster tables.
--
-- SECURITY NOTE: this exposes these two tables to anyone holding the public
-- anon key. Acceptable for an internal-only tool. Tighten with Supabase Auth
-- (or move reads/writes behind an authenticated edge function) before exposing
-- the page publicly.

create policy cash_plan_anon_rw on public.cash_plan
  for all to anon, authenticated using (true) with check (true);

create policy cash_seat_roster_anon_rw on public.cash_seat_roster
  for all to anon, authenticated using (true) with check (true);
