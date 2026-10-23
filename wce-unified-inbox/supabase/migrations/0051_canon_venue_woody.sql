-- 0051_canon_venue_woody.sql
-- The TD sheets abbreviate venues ("02.07. Woody") — teach the canonicaliser the
-- nicknames so those sheets map to the right venue lists and transfer rows.
create or replace function public.canon_venue(p text)
returns text language sql immutable as $$
  select case
    when p is null then null
    when p ~* '(market city|\mmct\M)' then 'MCT'
    when p ~* '(woodvale|\mwoody\M)' then 'Woodvale'
    when p ~* '(leederville|\mleedy\M|\mleed\M)' then 'Leederville'
    when p ~* 'kenwick' then 'Kenwick'
    when p ~* '(kingsley|kingstack)' then 'Kingsley'
    when p ~* 'bentley' then 'Bentley'
    when p ~* 'stirling' then 'Stirling'
    when p ~* '(planet royale|\mpr\M)' then 'Planet Royale'
    else null
  end
$$;
