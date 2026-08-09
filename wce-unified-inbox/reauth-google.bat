@echo off
REM WCE Unified Inbox - re-authorise the Google WORK account.
REM
REM Double-click this file. It opens the Google sign-in, then writes the new
REM refresh token straight into .env - there is nothing to copy by hand.
REM
REM This is the account TD sheets and the Gmail inbox pull read. For the
REM personal account that holds the phone contacts, run it as:
REM     reauth-google.bat contacts
title WCE Unified Inbox - Google re-auth
cd /d "%~dp0"

echo.
echo  Re-authorising a Google account for the sync.
echo.
echo   no argument  = justin.james@clubwestcoast.com.au  (TD sheets + Gmail)
echo   "contacts"   = jjlewis1804@gmail.com              (phone contacts)
echo.
echo  A browser will open. The script prints which account to sign in as -
echo  read it. The wrong account is accepted silently and points the sync
echo  at the wrong mailbox.
echo.

node scripts/get-google-refresh-token.mjs %*

echo.
echo  ---------------------------------------------------------------
echo   If that said "Updated" or "Added", you are done here.
echo   Now close the WCE sync window and double-click run-wce.bat.
echo  ---------------------------------------------------------------
echo.
pause
