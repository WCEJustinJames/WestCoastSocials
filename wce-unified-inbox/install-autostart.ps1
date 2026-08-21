# WCE Unified Inbox - make the sync survive a closed window and a reboot.
#
# Run this ONCE, in an **elevated** PowerShell (right-click > Run as administrator),
# from the wce-unified-inbox folder:
#
#     powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# Safe to re-run at any time: it replaces the task in place and never starts a
# second sync.
#
#
# WHY THIS SCRIPT CHANGED
#
# The first version registered the task with a single -AtLogOn trigger. That is
# enough to survive a reboot and nothing else, and on 9 Aug 2026 the difference
# cost six days of silence:
#
#   The task ran, then exited 0xC000013A - the code Windows returns when a
#   console window is closed. Somebody closed the sync window. A logon trigger
#   has already fired by then, so the task had no next run time and simply sat
#   there dead. Nobody logged out and back in, so nothing ever re-fired it. At
#   21:44 that night the loop was restarted by hand, by double-clicking the .bat
#   from Explorer, and every automation on this box has been hanging off that one
#   hand-opened window ever since.
#
# -RestartCount did not save it either. That setting covers a task that FAILS
# while the scheduler is still supervising it; it is not a supervisor that
# re-launches a task the scheduler considers finished.
#
# So the fix is a second trigger that keeps coming back:
#
#   trigger 1  at logon         - covers reboots
#   trigger 2  every 15 minutes - covers everything else
#
# With MultipleInstances = IgnoreNew, trigger 2 is a no-op while the sync is
# already running: Windows sees an instance and drops the new one. The moment
# there is NO instance - closed window, crash, killed process, someone tidying
# up the taskbar - the next tick starts it again. Worst case downtime goes from
# "forever, silently" to "under fifteen minutes".
#
# The console window is deliberately kept visible. It is where the operator
# reads [receipts], [tdsheets] and [bridges] lines, and hiding it would trade a
# real diagnostic for a risk that is now self-healing anyway.
#
#
# WHAT IT DOES
#  - Registers/repairs the "WCE Inbox Sync" scheduled task with both triggers.
#  - Never runs two syncs at once (MultipleInstances = IgnoreNew).
#  - Removes any run-time limit so it is never killed for "running too long".
#  - Stops the PC sleeping/hibernating on mains power (the sync needs the PC
#    awake and Beeper Desktop running).
#  - Prints the task's real state at the end, so you can see it took.
#
# AFTER RUNNING
#  - Open Beeper > Settings and enable "Open at login", so the Beeper Desktop
#    API is up whenever the PC is. The sync cannot read anything without it.
#  - Do NOT also put a shortcut in the Startup folder. That is outside Task
#    Scheduler, so IgnoreNew cannot see it, and you would get two sync windows.
#    One mechanism only.

[CmdletBinding()]
param(
  # Stop a sync that is running OUTSIDE the scheduled task (the hand-opened
  # window) and let the task take ownership. Without this the script refuses to
  # start a second one and tells you what to close - see the stray check below.
  [switch]$TakeOver
)

$ErrorActionPreference = 'Stop'

# Elevation check first - Register-ScheduledTask at -RunLevel Highest and
# powercfg both need it, and the failure without it is an unhelpful access
# denied halfway through.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Not elevated. Close this, right-click PowerShell > Run as administrator, and run it again."
}

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$bat = Join-Path $here 'run-wce.bat'
if (-not (Test-Path $bat)) { throw "run-wce.bat not found next to this script ($bat)" }

$taskName = 'WCE Inbox Sync'

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $here

# Trigger 2 is the supervisor. A -Once trigger with a repetition interval is
# used rather than setting .Repetition on the logon trigger, because the latter
# is the variant that intermittently fails XML validation across Windows builds.
#
# The duration is 10 years rather than [TimeSpan]::MaxValue for the same reason:
# MaxValue serialises to a value some builds reject outright. Ten years past the
# install date is indefinite by any standard this club cares about.
$supervisorInterval = New-TimeSpan -Minutes 15
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) `
      -RepetitionInterval $supervisorInterval `
      -RepetitionDuration (New-TimeSpan -Days 3650))
)

# IgnoreNew is what makes the 15-minute trigger safe to fire forever: while a
# sync is running the new instance is dropped, so this can never stack up a
# second window. It is set explicitly rather than left to the default, because
# the whole design depends on it.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers `
  -Settings $settings -RunLevel Highest -Force `
  -Description 'Keeps the WCE Unified Inbox sync running: starts at logon, and re-starts within 15 minutes if the window is ever closed or the process dies.'

Write-Host "[ok] Scheduled task '$taskName' registered (logon + every $($supervisorInterval.TotalMinutes)m supervisor)."

# Keep the machine awake on mains power so the sync + Beeper stay alive.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "[ok] Sleep/hibernate disabled on AC power."

# ---- stray (hand-opened) sync detection --------------------------------------
#
# IgnoreNew only protects against the scheduler starting a second instance. It
# knows nothing about a sync somebody launched by double-clicking the .bat from
# Explorer - which is exactly how this box has been running since 9 Aug. Start
# the task on top of that and you get two sync windows, which is the one thing
# the runbook says never to have.
#
# So: look for a live sync that the task does not own, and refuse to add to it.
function Get-StraySync {
  $procs = @()
  try {
    $procs += Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'run-wce' }
    $procs += Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'sync[\\/]run\.ts' }
  } catch {
    Write-Warning "Could not enumerate processes to check for a stray sync: $_"
  }
  # Anything parented by the scheduler is the task doing its job, not a stray.
  $procs | Where-Object {
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue)
    -not $parent -or $parent.Name -notmatch '^(svchost|taskeng)\.exe$'
  }
}

$state = (Get-ScheduledTask -TaskName $taskName).State
$strays = @(Get-StraySync)

if ($state -eq 'Running') {
  Write-Host "[ok] Task already running - left alone (no second window)."
} elseif ($strays.Count -gt 0 -and -not $TakeOver) {
  Write-Host ""
  Write-Warning "A sync is already running OUTSIDE the scheduled task - almost certainly the window opened by hand on 9 Aug:"
  foreach ($p in $strays) { Write-Host ("    PID {0}  {1}" -f $p.ProcessId, $p.Name) }
  Write-Host ""
  Write-Host "  The task is registered and armed, so a reboot is already covered."
  Write-Host "  To hand it over now WITHOUT ending up with two sync windows, either:"
  Write-Host "    a) close that console window yourself - the task picks it up within 15 minutes; or"
  Write-Host "    b) re-run this script with -TakeOver to stop it and start the task immediately."
  Write-Host ""
} else {
  if ($strays.Count -gt 0) {
    Write-Host "[..] -TakeOver: stopping the hand-opened sync so the task can own it."
    foreach ($p in $strays) {
      try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        Write-Host ("    stopped PID {0} ({1})" -f $p.ProcessId, $p.Name)
      } catch {
        Write-Warning ("    could not stop PID {0}: {1}" -f $p.ProcessId, $_)
      }
    }
    Start-Sleep -Seconds 2
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Host "[ok] Started under the scheduled task."
}

# Report the real state rather than assuming the registration took. A task that
# silently failed to arm is the exact failure this script exists to prevent, so
# it should not be discoverable only by noticing the club has gone quiet again.
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ""
Write-Host "---- WCE Inbox Sync ----------------------------------"
Write-Host ("  state          : {0}" -f $task.State)
Write-Host ("  last run       : {0}" -f $info.LastRunTime)
Write-Host ("  last result    : 0x{0:X}" -f $info.LastTaskResult)
Write-Host ("  next run       : {0}" -f $info.NextRunTime)
Write-Host ("  triggers       : {0}" -f (($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
Write-Host "------------------------------------------------------"
Write-Host ""
if (-not $info.NextRunTime) {
  Write-Warning "No next run time. The supervisor trigger did not arm - the sync will NOT come back on its own. Re-run this script and check for errors above."
} else {
  Write-Host "[ok] Supervisor armed. If the window is closed, it comes back by $($info.NextRunTime)."
}
Write-Host "Confirm it is really working: inbox_sync_heartbeat rows for host WESTCOAST1 should keep updating every few minutes."
