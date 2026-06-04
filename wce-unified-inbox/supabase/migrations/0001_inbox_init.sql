-- WCE Unified Inbox — initial schema
-- Additive: coexists with existing LetsPoker tables (tournament_events,
-- letspoker_auth, wcp_sync, letspoker_push_log). All objects prefixed `inbox_`.
-- Applied to project "WCE App" (dexdftcmcixppbuucjfd).

create extension if not exists "pgcrypto";

create type inbox_adapter as enum ('beeper','letspoker');
create type inbox_direction as enum ('inbound','outbound');
create type inbox_message_kind as enum ('1to1','batch');
create type inbox_conversation_type as enum ('single','group');
create type inbox_draft_status as enum ('pending','approved','sent','rejected');
create type inbox_batch_status as enum ('draft','approved','sending','sent','canceled');
create type inbox_batch_item_status as enum ('pending','approved','skipped','sent','failed');

-- Unified person record
create table inbox_people (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  notes text,
  tags text[] not null default '{}',
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cross-channel identity: every channel handle hangs off a person
create table inbox_identities (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references inbox_people(id) on delete cascade,
  adapter inbox_adapter not null,
  network text not null,
  account_id text,
  external_id text not null,
  handle text,
  match_confidence real not null default 1.0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (adapter, account_id, external_id)
);
create index inbox_identities_person_idx on inbox_identities (person_id);

-- Conversations: one per chat/thread
create table inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references inbox_people(id) on delete set null,
  adapter inbox_adapter not null,
  network text not null,
  account_id text,
  external_chat_id text not null,
  title text,
  type inbox_conversation_type not null default 'single',
  last_activity timestamptz,
  unread_count integer not null default 0,
  auto_send_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (adapter, account_id, external_chat_id)
);
create index inbox_conversations_person_idx on inbox_conversations (person_id);
create index inbox_conversations_activity_idx on inbox_conversations (last_activity desc);

-- Batches: template + variation logic, approved once
create table inbox_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  template_body text not null,
  variation_schema jsonb not null default '{}'::jsonb,
  status inbox_batch_status not null default 'draft',
  created_by text,
  created_at timestamptz not null default now()
);

-- Batch items: one per recipient, rendered from its own data
create table inbox_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references inbox_batches(id) on delete cascade,
  person_id uuid references inbox_people(id) on delete set null,
  identity_id uuid references inbox_identities(id) on delete set null,
  rendered_text text not null,
  data jsonb not null default '{}'::jsonb,
  status inbox_batch_item_status not null default 'pending',
  guard_flag boolean not null default false,
  guard_reason text,
  sent_message_id uuid,
  created_at timestamptz not null default now()
);
create index inbox_batch_items_batch_idx on inbox_batch_items (batch_id);

-- Messages: the mirror
create table inbox_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references inbox_conversations(id) on delete cascade,
  person_id uuid references inbox_people(id) on delete set null,
  adapter_source inbox_adapter not null,
  network text not null,
  external_message_id text not null,
  sort_key text,
  sender_id text,
  sender_name text,
  direction inbox_direction not null,
  kind inbox_message_kind not null default '1to1',
  batch_item_id uuid references inbox_batch_items(id) on delete set null,
  text text,
  timestamp timestamptz not null,
  is_unread boolean,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (adapter_source, external_message_id)
);
create index inbox_messages_conv_idx on inbox_messages (conversation_id, timestamp);
create index inbox_messages_person_idx on inbox_messages (person_id, direction, timestamp desc);

alter table inbox_batch_items
  add constraint inbox_batch_items_sent_message_fk
  foreign key (sent_message_id) references inbox_messages(id) on delete set null;

-- Drafts: Phase A approve-and-send for 1:1 replies
create table inbox_drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references inbox_conversations(id) on delete cascade,
  content text not null,
  status inbox_draft_status not null default 'pending',
  generated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbox_drafts_conv_idx on inbox_drafts (conversation_id, status);

-- updated_at maintenance
create or replace function inbox_touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
create trigger trg_inbox_people_touch before update on inbox_people
  for each row execute function inbox_touch_updated_at();
create trigger trg_inbox_drafts_touch before update on inbox_drafts
  for each row execute function inbox_touch_updated_at();

-- Contact-data guard: maintain people.last_outbound_at from outbound messages
create or replace function inbox_maintain_last_outbound() returns trigger as $$
begin
  if new.direction = 'outbound' and new.person_id is not null then
    update inbox_people
      set last_outbound_at = greatest(coalesce(last_outbound_at, new.timestamp), new.timestamp)
      where id = new.person_id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger trg_inbox_msg_last_outbound after insert on inbox_messages
  for each row execute function inbox_maintain_last_outbound();

-- RLS — LOCAL SINGLE-USER PROTOTYPE: permissive policies.
-- TIGHTEN to authenticated-only before any remote/hosted deploy.
alter table inbox_people enable row level security;
alter table inbox_identities enable row level security;
alter table inbox_conversations enable row level security;
alter table inbox_batches enable row level security;
alter table inbox_batch_items enable row level security;
alter table inbox_messages enable row level security;
alter table inbox_drafts enable row level security;

create policy inbox_people_all on inbox_people for all using (true) with check (true);
create policy inbox_identities_all on inbox_identities for all using (true) with check (true);
create policy inbox_conversations_all on inbox_conversations for all using (true) with check (true);
create policy inbox_batches_all on inbox_batches for all using (true) with check (true);
create policy inbox_batch_items_all on inbox_batch_items for all using (true) with check (true);
create policy inbox_messages_all on inbox_messages for all using (true) with check (true);
create policy inbox_drafts_all on inbox_drafts for all using (true) with check (true);
