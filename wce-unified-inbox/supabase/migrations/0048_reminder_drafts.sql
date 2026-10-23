-- 0048_reminder_drafts.sql
-- Day-of follow-ups: players who replied YES to an invite that said "tomorrow"
-- get a confirmation draft the next morning (built for approval, never auto-sent).
create or replace function public.build_reminder_drafts() returns int
language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  bname text := 'Reminders ' || to_char((now() at time zone 'Australia/Perth')::date, 'DD Mon');
  ins int := 0;
begin
  if exists (select 1 from public.inbox_batches where name = bname) then
    return 0; -- already built today
  end if;

  insert into public.inbox_batches (name, template_body, status, created_by, is_outreach, venue)
  values (bname, 'Hi {{first_name}}, confirming your seat for tonight. See you there.', 'draft', 'scheduler', true, null)
  returning id into bid;

  with inv as (
    -- yesterday's "tomorrow" invites (latest per chat)
    select distinct on (l.recipient) l.recipient as chat_id, l.rendered_text, l.sent_at
    from public.inbox_sent_log l
    where l.sent_at between now() - interval '40 hours' and now() - interval '10 hours'
      and l.rendered_text ~* '\mtomorrow\M'
    order by l.recipient, l.sent_at desc
  ), yes as (
    -- a YES in that chat after the invite
    select i.chat_id, i.rendered_text
    from inv i
    where exists (
      select 1 from public.inbox_messages m
      join public.inbox_conversations c on c.id = m.conversation_id
      where c.external_chat_id = i.chat_id
        and m.direction = 'inbound' and m.reply_intent = 'yes'
        and m.timestamp > i.sent_at)
  ), tgt as (
    select o.id, o.player_name, y.chat_id, public.canon_venue(y.rendered_text) as venue
    from yes y
    join public.inbox_outreach o on o.beeper_chat_id = y.chat_id
    where coalesce(o.do_not_message,false)=false
      and coalesce(o.staff,false)=false
      and coalesce(o.hidden,false)=false
      and (o.snooze_until is null or o.snooze_until < current_date)
  )
  insert into public.inbox_batch_items (batch_id, status, rendered_text, data)
  select bid, 'pending',
    'Hi ' || coalesce(nullif(split_part(coalesce(player_name,''),' ',1),''),'mate')
      || ', confirming your seat for tonight' || coalesce(' at ' || venue, '') || '. See you there.',
    jsonb_build_object('channel','thread','beeper_chat_id',chat_id,'outreach_id',id,'name',player_name)
  from tgt;
  get diagnostics ins = row_count;

  if ins = 0 then
    delete from public.inbox_batches where id = bid; -- nothing owed today
    return 0;
  end if;
  return ins;
end $$;
grant execute on function public.build_reminder_drafts() to anon, authenticated;

-- 09:30 Perth daily (01:30 UTC), well inside the outreach window for approval.
select cron.schedule('wce-reminder-drafts', '30 1 * * *', $job$
  select public.build_reminder_drafts();
$job$);
