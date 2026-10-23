-- 0053_marketing.sql
-- Marketing arm: social posts (calendar + repeat rules, published via Postiz,
-- artwork via Canva links) and Klaviyo email-blast bones. Additive.
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  asset_url text,            -- Canva export / image link attached to the post
  platforms text[] not null default '{}',  -- instagram, facebook, tiktok, ...
  scheduled_at timestamptz,
  repeat_rule text not null default 'none', -- none | daily | weekly | fortnightly | monthly
  repeat_until date,
  status text not null default 'draft',     -- draft | scheduled | posted | failed
  postiz_id text,
  post_error text,
  posted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.social_posts enable row level security;
drop policy if exists social_posts_all on public.social_posts;
create policy social_posts_all on public.social_posts for all using (true) with check (true);
grant all on public.social_posts to anon, authenticated;

create table if not exists public.klaviyo_pushes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text,
  body text,
  segment text not null default 'everyone', -- everyone | cash | tourney | venue:<Name>
  status text not null default 'draft',     -- draft | queued | ready | failed
  stats jsonb,
  push_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.klaviyo_pushes enable row level security;
drop policy if exists klaviyo_pushes_all on public.klaviyo_pushes;
create policy klaviyo_pushes_all on public.klaviyo_pushes for all using (true) with check (true);
grant all on public.klaviyo_pushes to anon, authenticated;
