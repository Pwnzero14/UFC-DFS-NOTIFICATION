# Restart the watcher and prove it actually restarted.
#
# Stop-ScheduledTask on its own stopped being enough on 2026-09-04, the day the
# five-minute revive trigger was added: it returns success, the process keeps
# running, and Start-ScheduledTask then has nothing to start. Nothing errors, so
# a deploy looks fine while the old code is still polling - which is exactly how
# an Underdog fix sat unloaded for twenty minutes while we tried to work out why
# the board had not changed.
#
# So this stops the task, kills the process named in watcher.lock if it is still
# alive, starts the task again, and then waits for a NEW startup banner to
# appear in watcher.log before claiming success. Run it elevated.

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'UFC Fantasy Prop Alerts'
$lockPath = Join-Path $root 'watcher.lock'
$logPath  = Join-Path $root 'watcher.log'

function Get-BannerCount {
    if (-not (Test-Path $logPath)) { return 0 }
    @(Select-String -Path $logPath -SimpleMatch -Pattern 'UFC Fantasy Prop Alerts').Count
}

$before = Get-BannerCount
$oldPid = if (Test-Path $lockPath) { (Get-Content $lockPath -Raw).Trim() } else { $null }
Write-Host "stopping  : task '$taskName'$(if ($oldPid) { " (pid $oldPid)" })"

try { Stop-ScheduledTask -TaskName $taskName } catch { Write-Host "  (stop returned: $($_.Exception.Message))" }

# Give the graceful stop a moment; it saves state and releases the lock itself.
Start-Sleep -Seconds 3

if ($oldPid) {
    $still = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($still) {
        Write-Host "  pid $oldPid survived the stop - terminating it"
        # state.json is written every cycle, so a hard kill costs seconds at most.
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

Write-Host "starting  : task '$taskName'"
Start-ScheduledTask -TaskName $taskName

# A new banner in the log is the only proof the new code is actually running.
# The lockfile is not enough: a stale lock can survive a hard kill.
Write-Host "verifying : waiting for a new startup banner..."
$ok = $false
foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    if ((Get-BannerCount) -gt $before) { $ok = $true; break }
}

if ($ok) {
    $newPid = if (Test-Path $lockPath) { (Get-Content $lockPath -Raw).Trim() } else { '?' }
    Write-Host "OK        : watcher restarted, now pid $newPid" -ForegroundColor Green
} else {
    Write-Host "FAILED    : no new banner after 40s - the old process may still" -ForegroundColor Red
    Write-Host "            be running. Check: Get-Content '$logPath' -Tail 5" -ForegroundColor Red
    exit 1
}
