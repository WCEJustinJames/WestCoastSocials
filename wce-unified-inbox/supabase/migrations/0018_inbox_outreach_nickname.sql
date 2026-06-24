-- Optional nickname / preferred name. When the batch builder's "use nicknames"
-- option is on, this replaces {{first_name}} in rendered messages (falling back
-- to the real first name where no nickname is set).
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_outreach add column if not exists nickname text;
