-- Optional table specs to open via AddTable (createTournamentLogItem). Each:
-- {identifier, stake:{id,blinds:[2,5],currency:"AUD",text:"2/5 AUD"}, gameType:"NLH",
--  tableSize:9, isPublic:true, buyInLimits:{min:20,max:200}, autoAddWaitingList:true}
alter table public.cash_plan
  add column if not exists tables_spec jsonb not null default '[]'::jsonb;
comment on column public.cash_plan.tables_spec is
  'Cash table specs to open via AddTable (createTournamentLogItem) for this event.';
