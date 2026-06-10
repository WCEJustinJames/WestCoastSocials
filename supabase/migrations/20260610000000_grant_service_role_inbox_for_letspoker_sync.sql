-- The letspoker-inbox-sync edge function writes the LetsPoker side of the
-- unified inbox via PostgREST (service_role). The inbox tables were created
-- without privileges for service_role (the beeper host writes via a direct
-- postgres connection), so grant exactly what the function needs.
grant select, insert, update on
  public.inbox_conversations,
  public.inbox_messages,
  public.inbox_people,
  public.inbox_identities
to service_role;

grant select, update on public.inbox_sync_heartbeat to service_role;
