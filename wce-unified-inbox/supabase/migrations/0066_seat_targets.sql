-- 0066_seat_targets.sql
-- Seat-target monitor: how many seats a game aims to fill. Cash games seat ~9
-- at a table; tournaments are uncapped (0 = not monitored). Additive.
alter table public.inbox_schedules add column if not exists seat_target int not null default 0;
update public.inbox_schedules set seat_target = 9 where game_type = 'cash' and seat_target = 0;
