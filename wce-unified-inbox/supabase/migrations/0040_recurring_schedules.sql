-- 0040_recurring_schedules.sql
-- Roadmap #3: recurring per-venue/game schedules.
-- A config table seeded from the locked weekly map, plus materialise_due_schedules()
-- which builds next game's batch as a DRAFT for approval (never auto-sends) from the
-- matching venue list, the evening before. Driven by pg_cron. STRICTLY ADDITIVE.

create table if not exists public.inbox_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  venue text,                       -- canonical venue (canon_venue vocab)
  game_type text not null default 'tourney',
  day_of_week int not null,         -- Postgres dow: 0=Sun .. 6=Sat
  event_time text,                  -- display only, baked into the template
  list_id uuid references public.inbox_lists(id) on delete set null,  -- null => resolve by venue+type
  template_body text not null,
  lead_days int not null default 1, -- materialise this many days before the game (1 = evening before)
  active boolean not null default true,
  last_materialised_for date,       -- the occurrence date last built (idempotency)
  created_at timestamptz not null default now()
);

alter table public.inbox_schedules enable row level security;
drop policy if exists inbox_schedules_all on public.inbox_schedules;
create policy inbox_schedules_all on public.inbox_schedules for all using (true) with check (true);
grant all on public.inbox_schedules to anon, authenticated;

-- Seed the locked weekly map (idempotent on name). Templates are casual defaults
-- in Justin's voice with the venue/time baked in; edit per schedule in the UI.
insert into public.inbox_schedules (name, venue, game_type, day_of_week, event_time, template_body) values
  ('Mon Bentley',       'Bentley',       'tourney', 1, '6pm', 'Hi {{first_name}}, Bentley is on tonight from 6. Keen for a seat?'),
  ('Tue Kingsley',      'Kingsley',      'tourney', 2, '6pm', 'Hi {{first_name}}, Kingsley is on tonight from 6. Want me to save you a seat?'),
  ('Wed MCT',           'MCT',           'tourney', 3, '6pm', 'Hi {{first_name}}, Market City is on tonight from 6. Want a seat?'),
  ('Thu Woodvale',      'Woodvale',      'tourney', 4, '6pm', 'Hi {{first_name}}, Woodvale is on tonight from 6. Keen?'),
  ('Fri Kenwick',       'Kenwick',       'tourney', 5, '6pm', 'Hi {{first_name}}, Kenwick is on tonight from 6. Want me to save you a seat?'),
  ('Fri Leederville',   'Leederville',   'tourney', 5, 'day', 'Hi {{first_name}}, Leederville is on today. Want a seat?'),
  ('Sun Planet Royale', 'Planet Royale', 'tourney', 0, '6pm', 'Hi {{first_name}}, Planet Royale is on tonight. Keen for a seat?')
on conflict (name) do nothing;

-- Build the upcoming game's draft batch from the matching venue list. Idempotent per
-- occurrence (last_materialised_for). Skips do_not_message / staff / hidden / on-ice,
-- routes each recipient to their preferred channel, and renders {{first_name}}.
-- Creates the batch as status='draft' + items 'pending': it sits for Justin to approve
-- in the UI and only then drains through the normal send rail (window + guards).
create or replace function public.materialise_due_schedules() returns int
language plpgsql security definer set search_path = public as $$
declare
  s record;
  occ date;
  lid uuid;
  bid uuid;
  built int := 0;
  ins int;
begin
  for s in select * from public.inbox_schedules where active loop
    occ := current_date + s.lead_days;
    if extract(dow from occ)::int <> s.day_of_week then continue; end if;
    if s.last_materialised_for is not distinct from occ then continue; end if;

    -- resolve the venue list (explicit link, else the biggest matching venue+type list)
    lid := s.list_id;
    if lid is null then
      select l.id into lid
      from public.inbox_lists l
      where public.canon_venue(l.venue) = s.venue
        and coalesce(l.game_type, 'tourney') = coalesce(s.game_type, 'tourney')
      order by (select count(*) from public.inbox_list_members m where m.list_id = l.id) desc
      limit 1;
    end if;

    if lid is null then
      update public.inbox_schedules set last_materialised_for = occ where id = s.id;
      continue;  -- no list to draw from yet
    end if;

    insert into public.inbox_batches (name, template_body, status, created_by, is_outreach, venue)
    values (s.name || ' ' || to_char(occ, 'DD Mon'), s.template_body, 'draft', 'scheduler', true, s.venue)
    returning id into bid;

    with mem as (
      select o.id, o.player_name, o.phone, o.beeper_chat_id, o.preferred_channel
      from public.inbox_list_members m
      join public.inbox_outreach o on o.id = m.outreach_id
      where m.list_id = lid
        and coalesce(o.do_not_message, false) = false
        and coalesce(o.staff, false) = false
        and coalesce(o.hidden, false) = false
        and (o.snooze_until is null or o.snooze_until < current_date)
    ), routed as (
      select id, player_name,
        case when beeper_chat_id is not null and coalesce(preferred_channel,'') <> 'sms' then 'thread'
             when phone is not null then 'sms' else null end as ch,
        beeper_chat_id, phone
      from mem
    )
    insert into public.inbox_batch_items (batch_id, status, rendered_text, data)
    select bid, 'pending',
      regexp_replace(
        regexp_replace(s.template_body, '\{\{\s*first[\s_]*name\s*\}\}',
          coalesce(nullif(split_part(coalesce(player_name,''), ' ', 1), ''), 'mate'), 'gi'),
        '\{\{\s*name\s*\}\}', coalesce(player_name, ''), 'gi') as rendered_text,
      case when ch = 'thread' then jsonb_build_object('channel','thread','beeper_chat_id',beeper_chat_id,'outreach_id',id)
           when ch = 'sms'    then jsonb_build_object('channel','sms','phone',phone,'outreach_id',id)
           else jsonb_build_object('outreach_id', id) end as data
    from routed
    where ch is not null;
    get diagnostics ins = row_count;

    if ins = 0 then
      delete from public.inbox_batches where id = bid;  -- nothing reachable; drop the empty draft
    else
      built := built + 1;
    end if;
    update public.inbox_schedules set last_materialised_for = occ where id = s.id;
  end loop;
  return built;
end $$;
grant execute on function public.materialise_due_schedules() to anon, authenticated;

-- Run every evening (09:00 UTC = 17:00 Perth) so the next day's game draft is ready
-- the evening before. cron.schedule upserts by name, so re-running is safe.
select cron.schedule('wce-materialise-schedules', '0 9 * * *', $job$
  select public.materialise_due_schedules();
$job$);
