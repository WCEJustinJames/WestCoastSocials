-- Mirror the Airtable "Player Outreach" Source field (e.g. "Facebook Messenger",
-- "Google Contacts", "Raffle cards May-Jun 2024", "Cash Games Reservations PDF")
-- so the app can show a contact's REAL origin instead of the generic "airtable"
-- roll-up. Populated by the outreach sync (a dedicated source upsert that doesn't
-- clobber manual edits). Applied to project "WCE App" (dexdftcmcixppbuucjfd).
alter table inbox_outreach add column if not exists source text;
