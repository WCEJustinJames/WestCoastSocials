-- 0055_social_autopilot.sql
-- Social autopilot: tag generated posts with their origin so the weekly promo
-- generator is idempotent (one post per schedule x game-date x slot). Additive.
alter table public.social_posts add column if not exists source text;
alter table public.social_posts add column if not exists source_key text;
create unique index if not exists social_posts_source_key_uq
  on public.social_posts (source_key) where source_key is not null;
