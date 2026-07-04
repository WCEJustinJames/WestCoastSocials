-- 0062_outgoings_overlay.sql
-- Add outgoings (total expenses) + overlay to the financial summary. Croupier
-- wages await confirmation of their sheet location, so not mapped yet.
drop view if exists public.inbox_financial_summary;
create view public.inbox_financial_summary as
select
  sheet_id,
  max(game_date) as game_date,
  coalesce(canon_venue(max(venue)), max(venue)) as venue,
  max(value_num) filter (where norm_label = 'net profit actual') as net_profit_actual,
  max(value_num) filter (where norm_label like '%net profit%' and norm_label <> 'net profit actual') as net_profit_calc,
  coalesce(
    max(value_num) filter (where norm_label = 'tournament in total'),
    max(value_num) filter (where norm_label like '%buy in%'),
    max(value_num) filter (where norm_label like '%total gross receipts%')
  ) as gross_buyins,
  max(value_num) filter (where norm_label = 'tournament in cash') as buyins_cash,
  max(value_num) filter (where norm_label = 'tournament in eftpos') as buyins_eftpos,
  max(value_num) filter (where norm_label = 'tournament in payid') as buyins_payid,
  max(value_num) filter (where norm_label = 'tournament prize pool') as prize_pool,
  max(value_num) filter (where norm_label = 'tournament overlay') as overlay,
  coalesce(
    max(value_num) filter (where norm_label = 'total expenses'),
    max(value_num) filter (where norm_label = 'total expenses club')
  ) as outgoings,
  coalesce(
    max(value_num) filter (where norm_label = 'cash rake income'),
    max(value_num) filter (where norm_label = 'cash game income')
  ) as cash_rake
from public.inbox_game_financials
group by sheet_id;
grant select on public.inbox_financial_summary to anon, authenticated;
