-- "On ice until" date: snooze a player from proactive outreach until they're
-- back (e.g. they said "away in Thailand for a month", or you parked them).
-- The send-time guard skips outreach to anyone snoozed until this date passes;
-- replies/confirmations are never affected.
alter table inbox_outreach add column if not exists snooze_until date;
