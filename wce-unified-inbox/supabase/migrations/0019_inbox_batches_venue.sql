-- Optional venue / weekly-game tag on a batch. Lets the builder browse and
-- rebuild a given venue's recurring weekly invite list ("Reuse a past list",
-- filtered by venue). Free text so weekly-game labels (e.g. "Leederville
-- Tuesday") aren't constrained to the player-venue vocabulary.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_batches add column if not exists venue text;
