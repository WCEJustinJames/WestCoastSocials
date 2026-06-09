@echo off
REM WCE Unified Inbox - keep the sync running, auto-update, auto-restart.
REM Double-click this file (or add a shortcut to it in your Startup folder).
title WCE Unified Inbox - sync
cd /d "%~dp0"

:loop
echo.
echo [wce] %date% %time%  pulling latest code...
git pull origin claude/laughing-ritchie-Xmvvk
echo [wce] installing any new deps...
call npm install --no-audit --no-fund >nul 2>&1
echo [wce] starting sync  (close this window to stop)
call npm run sync
echo.
echo [wce] sync stopped or crashed - restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
