# WCE Unified Inbox - make the sync bulletproof.
#
# Run this ONCE, in an **elevated** PowerShell (right-click > Run as administrator),
# from the wce-unified-inbox folder:
#
#     powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# What it does:
#  - Registers a Scheduled Task that launches run-wce.bat at logon.
#  - Restarts it automatically if it ever stops (every 1 min, indefinitely).
#  - Removes any run-time limit so it never gets killed for "running too long".
#  - Stops the PC sleeping/hibernating on mains power (the sync needs the PC awake
#    and Beeper Desktop running).
#
# After running: also open Beeper > Settings and enable "Open at login" so the
# Beeper Desktop API is up whenever the PC is.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat  = Join-Path $here 'run-wce.bat'
if (-not (Test-Path $bat)) { throw "run-wce.bat not found next to this script ($bat)" }

$taskName = 'WCE Inbox Sync'

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -Force `
  -Description 'Keeps the WCE Unified Inbox sync running (auto-start + auto-restart).'

Write-Host "[ok] Scheduled task '$taskName' registered (starts at logon, restarts if it stops)."

# Keep the machine awake on mains power so the sync + Beeper stay alive.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "[ok] Sleep/hibernate disabled on AC power."

# Kick it off now so you don't have to log out/in.
Start-ScheduledTask -TaskName $taskName
Write-Host "[ok] Started now. Check the new window, then it'll come back on every boot."
