-- Daily outreach cutoff support. is_outreach=true marks a proactive invite
-- blast (blocked after OUTREACH_CUTOFF local time); false marks a reply /
-- confirmation batch, which always sends so seats can be confirmed late.
alter table inbox_batches add column if not exists is_outreach boolean not null default true;
comment on column inbox_batches.is_outreach is 'true = proactive invite (subject to daily outreach cutoff); false = reply/confirmation (always allowed)';
