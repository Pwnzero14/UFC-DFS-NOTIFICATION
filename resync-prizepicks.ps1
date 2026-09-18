# One-off: reload the watcher AND re-detect PrizePicks props whose classification
# just changed (demon/goblin-only markets are now tracked, not silenced).
#
# Same stop/kill/start dance as restart.ps1, but with a strip of PrizePicks
# `known` props from state.json inserted while the process is dead - the only
# safe window, since the watcher loads state once at startup and re-saves it from
# memory every cycle. After this, the promoted knockdowns read as new `tracked`
# props and ping once. Run elevated. Use restart.ps1 for ordinary redeploys.

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'UFC Fantasy Prop Alerts'
$lockPath = Join-Path $root 'watcher.lock'
$logPath  = Join-Path $root 'watcher.log'
$stripper = Join-Path $root 'resync-prizepicks.mjs'

function Get-BannerCount {
    if (-not (Test-Path $logPath)) { return 0 }
    @(Select-String -Path $logPath -SimpleMatch -Pattern 'UFC Fantasy Prop Alerts').Count
}

$before = Get-BannerCount
$oldPid = if (Test-Path $lockPath) { (Get-Content $lockPath -Raw).Trim() } else { $null }
Write-Host "stopping  : task '$taskName'$(if ($oldPid) { " (pid $oldPid)" })"

try { Stop-ScheduledTask -TaskName $taskName } catch { Write-Host "  (stop returned: $($_.Exception.Message))" }
Start-Sleep -Seconds 3

if ($oldPid) {
    $still = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($still) {
        Write-Host "  pid $oldPid survived the stop - terminating it"
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# The process is dead now, so state.json is stable - safe to edit before start.
Write-Host "resyncing : stripping PrizePicks 'known' props from state.json"
node $stripper

Write-Host "starting  : task '$taskName'"
Start-ScheduledTask -TaskName $taskName

Write-Host "verifying : waiting for a new startup banner..."
$ok = $false
foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    if ((Get-BannerCount) -gt $before) { $ok = $true; break }
}

if ($ok) {
    $newPid = if (Test-Path $lockPath) { (Get-Content $lockPath -Raw).Trim() } else { '?' }
    Write-Host "OK        : watcher restarted, now pid $newPid" -ForegroundColor Green
    Write-Host "            PrizePicks knockdowns will ping on its next poll (up to ~5 min)."
} else {
    Write-Host "FAILED    : no new banner after 40s - the old process may still" -ForegroundColor Red
    Write-Host "            be running. Check: Get-Content '$logPath' -Tail 5" -ForegroundColor Red
    exit 1
}
