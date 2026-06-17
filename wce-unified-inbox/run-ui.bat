@echo off
REM WCE Unified Inbox - CRM web UI. Double-click this to open the dashboard.
REM Always pulls the latest code first, so new UI changes (checkboxes, tabs,
REM filters) show up without any manual git steps. Then opens localhost:5173.
title WCE Unified Inbox - UI
cd /d "%~dp0"

echo [wce-ui] %date% %time%  pulling latest code...
git pull origin claude/laughing-ritchie-Xmvvk
echo [wce-ui] installing any new deps...
call npm install --no-audit --no-fund >nul 2>&1
echo [wce-ui] starting UI on http://localhost:5173  (close this window to stop)
echo [wce-ui] once it says "Local: http://localhost:5173", open that in your browser.
call npm run dev
