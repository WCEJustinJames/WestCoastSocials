-- Lock all inbox_ tables to the authenticated role only (logged-in users).
-- Removes anon/public access so the hosted UI's data + controls require a login.
-- The PC sync uses the service_role key, which bypasses RLS, so it is unaffected.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).

drop policy if exists inbox_batch_items_anon_all on inbox_batch_items;
create policy inbox_batch_items_auth_all on inbox_batch_items for all to authenticated using (true) with check (true);
drop policy if exists inbox_batches_anon_all on inbox_batches;
create policy inbox_batches_auth_all on inbox_batches for all to authenticated using (true) with check (true);
drop policy if exists inbox_conversations_anon_all on inbox_conversations;
create policy inbox_conversations_auth_all on inbox_conversations for all to authenticated using (true) with check (true);
drop policy if exists inbox_drafts_anon_all on inbox_drafts;
create policy inbox_drafts_auth_all on inbox_drafts for all to authenticated using (true) with check (true);
drop policy if exists inbox_group_post_anon_all on inbox_group_post;
create policy inbox_group_post_auth_all on inbox_group_post for all to authenticated using (true) with check (true);
drop policy if exists inbox_identities_anon_all on inbox_identities;
create policy inbox_identities_auth_all on inbox_identities for all to authenticated using (true) with check (true);
drop policy if exists inbox_list_members_anon_all on inbox_list_members;
create policy inbox_list_members_auth_all on inbox_list_members for all to authenticated using (true) with check (true);
drop policy if exists inbox_lists_anon_all on inbox_lists;
create policy inbox_lists_auth_all on inbox_lists for all to authenticated using (true) with check (true);
drop policy if exists inbox_messages_anon_all on inbox_messages;
create policy inbox_messages_auth_all on inbox_messages for all to authenticated using (true) with check (true);
drop policy if exists inbox_outreach_anon_all on inbox_outreach;
create policy inbox_outreach_auth_all on inbox_outreach for all to authenticated using (true) with check (true);
drop policy if exists inbox_people_anon_all on inbox_people;
create policy inbox_people_auth_all on inbox_people for all to authenticated using (true) with check (true);
drop policy if exists inbox_receipts_anon_all on inbox_receipts;
create policy inbox_receipts_auth_all on inbox_receipts for all to authenticated using (true) with check (true);
drop policy if exists inbox_sync_heartbeat_anon_all on inbox_sync_heartbeat;
create policy inbox_sync_heartbeat_auth_all on inbox_sync_heartbeat for all to authenticated using (true) with check (true);
drop policy if exists inbox_sent_log_all on inbox_sent_log;
create policy inbox_sent_log_auth_all on inbox_sent_log for all to authenticated using (true) with check (true);
drop policy if exists inbox_settings_all on inbox_settings;
create policy inbox_settings_auth_all on inbox_settings for all to authenticated using (true) with check (true);
