-- 0045_action_queue_tuneup.sql
-- Review fixes.
-- (a) The Home action queue flooded: every historical reply_intent='other' row
--     (including system noise the sync tags the same way) showed as "needs you".
--     Mark all pre-existing rows resolved so the queue starts from now; the sync
--     now tags system noise reply_intent='noise' instead of 'other'.
update public.inbox_messages set action_resolved = true
  where reply_intent = 'other' and action_resolved = false;

-- (b) materialise_due_schedules() derived "the upcoming game day" from the UTC
--     date, so a manual run on a Perth morning (before 08:00 UTC) could target
--     the wrong day. Compute from the Perth local date instead.
create or replace function public.materialise_due_schedules() returns int
language plpgsql security definer set search_path = public as $$
declare
  s record;
  today date := (now() at time zone 'Australia/Perth')::date;
  occ date;
  lid uuid;
  bid uuid;
  built int := 0;
  ins int;
begin
  for s in select * from public.inbox_schedules where active loop
    occ := today + s.lead_days;
    if extract(dow from occ)::int <> s.day_of_week then continue; end if;
    if s.last_materialised_for is not distinct from occ then continue; end if;

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
      continue;
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
        and (o.snooze_until is null or o.snooze_until < today)
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
      delete from public.inbox_batches where id = bid;
    else
      built := built + 1;
    end if;
    update public.inbox_schedules set last_materialised_for = occ where id = s.id;
  end loop;
  return built;
end $$;
