-- Independent pause for the AI auto-reply rail, separate from the master sends
-- kill-switch. Replies are held when sends_paused OR replies_paused is true:
-- the master STOP (sends_paused) still halts everything, while replies_paused
-- pauses ONLY the auto-reply rail and leaves proactive outreach running.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_settings add column if not exists replies_paused boolean not null default false;
