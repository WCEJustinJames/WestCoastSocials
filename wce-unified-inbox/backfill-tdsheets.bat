@echo off
REM WCE Unified Inbox - re-read the TD sheets and repair the financials chart.
REM
REM Double-click this after the Google token has been re-authorised. It sweeps
REM the last 70 days of "DD/MM Venue" sheets and refills attendance AND the
REM per-game financial lines behind the Home trend chart.
REM
REM READ-ONLY on the sheets: the financial harvest never writes, and sheets
REM older than 5 weeks contribute attendance only, so no historical sheet can
REM be edited. Idempotent - safe to run as many times as you like.
REM
REM For the ENTIRE history (every year of sheets, slow):
REM     backfill-tdsheets.bat --all
title WCE Unified Inbox - TD sheet backfill
cd /d "%~dp0"

echo.
echo  Re-reading the TD sheets to repair attendance + the financials chart.
echo  This is read-only on the sheets and safe to re-run.
echo  Leave this window open - it is throttled to stay under Google's quota.
echo.

call npm run tdsheets:backfill -- %*

echo.
echo  ---------------------------------------------------------------
echo   Done. Reload the dashboard and check the Financials chart.
echo  ---------------------------------------------------------------
echo.
pause
