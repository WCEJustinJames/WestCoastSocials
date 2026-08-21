-- "never messaged" is driven solely by inbox_outreach.last_contacted, which was
-- only written by the Airtable sync or the app's batch sender. Players messaged
-- manually in Messenger/SMS (mirrored as outbound inbox_messages) were never
-- stamped, so threads with real history still showed "never messaged" (e.g.
-- Gareth Crawford, a fb: Messenger contact with a full thread but no Airtable
-- "Last Contacted"). This trigger keeps last_contacted in step with the latest
-- outbound in the linked thread, so manual sends count too — no app change needed.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
create or replace function sync_outreach_last_contacted() returns trigger
language plpgsql as $$
begin
  if new.direction = 'outbound' then
    update inbox_outreach o
    set last_contacted = greatest(
      o.last_contacted,
      (new.timestamp at time zone 'Australia/Perth')::date
    )
    from inbox_conversations c
    where c.id = new.conversation_id
      and o.beeper_chat_id is not null
      and o.beeper_chat_id = c.external_chat_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_outreach_last_contacted on inbox_messages;
create trigger trg_outreach_last_contacted
after insert on inbox_messages
for each row execute function sync_outreach_last_contacted();

-- One-time back-fill for threads already mirrored.
update inbox_outreach o
set last_contacted = sub.d
from (
  select c.external_chat_id,
         (max(m.timestamp) at time zone 'Australia/Perth')::date as d
  from inbox_conversations c
  join inbox_messages m on m.conversation_id = c.id
  where m.direction = 'outbound'
  group by c.external_chat_id
) sub
where o.beeper_chat_id = sub.external_chat_id
  and o.last_contacted is null;
