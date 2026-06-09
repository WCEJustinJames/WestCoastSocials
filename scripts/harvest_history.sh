#!/usr/bin/env bash
# Sweep the full LetsPoker tournament history into Supabase, one month at a time,
# by invoking the letspoker-harvest edge function. Idempotent (upserts), so it is
# safe to re-run; running it for just the current month keeps the data fresh.
#
# Usage:
#   SUPABASE_ANON_KEY=... ./scripts/harvest_history.sh [START_YYYY-MM-01] [END_YYYY-MM-01]
# Defaults: 2024-01 .. current month.
set -euo pipefail

PROJECT_URL="${SUPABASE_PROJECT_URL:-https://dexdftcmcixppbuucjfd.supabase.co}"
ANON="${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
FN="$PROJECT_URL/functions/v1/letspoker-harvest"

start="${1:-2024-01-01}"
end="${2:-$(date +%Y-%m-01)}"

m="$start"
while [ "$(date -d "$m" +%Y%m)" -le "$(date -d "$end" +%Y%m)" ]; do
  s="${m}T00:00:00.000Z"
  e="$(date -d "$m +1 month" +%Y-%m-%d)T00:00:00.000Z"
  r=$(curl -sS -m 120 -X POST "$FN" \
        -H "Authorization: Bearer $ANON" -H "content-type: application/json" \
        --data "{\"start\":\"$s\",\"end\":\"$e\"}")
  printf '%s  %s\n' "${m:0:7}" "$r"
  m="$(date -d "$m +1 month" +%Y-%m-%d)"
done
