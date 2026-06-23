@echo off
REM WCE Unified Inbox - one-click redeploy of the hosted app (wce-inbox.vercel.app).
REM Pulls latest code, builds with your local .env (the VITE_ Supabase keys live
REM there), then pushes the built site to Vercel production. Double-click to run.
title WCE Unified Inbox - deploy
cd /d "%~dp0"
echo [deploy] %date% %time%  pulling latest code...
git pull origin claude/laughing-ritchie-Xmvvk
echo [deploy] installing any new deps...
call npm install --no-audit --no-fund >nul 2>&1
echo [deploy] building...
call npm run build
if errorlevel 1 ( echo [deploy] BUILD FAILED - not deploying. & pause & exit /b 1 )
echo [deploy] deploying to Vercel (production)...
cd dist
call npx vercel --prod
echo.
echo [deploy] done. Open https://wce-inbox.vercel.app on your phone.
pause
