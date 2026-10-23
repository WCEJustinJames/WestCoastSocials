-- Recent "people contacted" list, with names resolved server-side.
--
-- inbox_sent_log stores the raw recipient — a phone number for SMS, but a Beeper
-- room id (e.g. "!OyX1Adzq...:beeper.local") for Messenger. The Recent tab was
-- showing those room ids verbatim because it only resolved names via a direct
-- outreach_id link, which most sends don't carry. This view resolves the name
-- from every source we have, in priority order, and dedups to one row per
-- recipient (their most recent send). Scalar subqueries (not joins) keep it
-- strictly one row per recipient — no fan-out if a room maps to >1 row anywhere.
--
-- security_invoker = false so the browser's anon role reads through it even where
-- the underlying tables' RLS would otherwise get in the way (matches sync_freshness).
create or replace view public.inbox_recent_contacts
with (security_invoker = false) as
with ranked as (
  select
    l.recipient,
    l.sent_at,
    l.outreach_id,
    row_number() over (partition by l.recipient order by l.sent_at desc) as rn
  from inbox_sent_log l
)
select
  r.recipient,
  coalesce(
    -- 1. Send was linked straight to a CRM player.
    (select nullif(btrim(o.player_name), '') from inbox_outreach o where o.id = r.outreach_id),
    -- 2. CRM player carrying this exact Beeper room id.
    (select nullif(btrim(o.player_name), '') from inbox_outreach o
       where o.beeper_chat_id = r.recipient and btrim(coalesce(o.player_name, '')) <> '' limit 1),
    (select nullif(btrim(o.beeper_contact_name), '') from inbox_outreach o
       where o.beeper_chat_id = r.recipient and btrim(coalesce(o.beeper_contact_name, '')) <> '' limit 1),
    -- 3. The mirrored Beeper conversation / person for this room.
    (select nullif(btrim(p.display_name), '') from inbox_conversations c
       join inbox_people p on p.id = c.person_id
       where c.external_chat_id = r.recipient and btrim(coalesce(p.display_name, '')) <> '' limit 1),
    (select nullif(btrim(c.title), '') from inbox_conversations c
       where c.external_chat_id = r.recipient and btrim(coalesce(c.title, '')) <> '' limit 1),
    -- 4. Last resort: the raw recipient (room id or phone).
    r.recipient
  ) as name,
  r.sent_at
from ranked r
where r.rn = 1;

grant select on public.inbox_recent_contacts to anon, authenticated;
