# Makes the watcher start automatically at every logon.
#
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#
# Tries a Scheduled Task first (better: auto-restarts on crash, survives without
# a visible window). Registering one needs elevation on most machines, so if
# that is denied it falls back to a Startup-folder shortcut, which needs no
# admin rights at all and starts the watcher minimised at logon.
#
# Uninstall:  .\install-task.ps1 -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$taskName = 'UFC Fantasy Prop Alerts'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Definition
$entry    = Join-Path $root 'src\index.js'
$launcher = Join-Path $root 'start-hidden.vbs'
$startup  = [Environment]::GetFolderPath('Startup')
$lnkPath  = Join-Path $startup "$taskName.lnk"

if ($Uninstall) {
    $removed = $false
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "Removed scheduled task."
            $removed = $true
        } catch {
            Write-Warning "Could not remove the scheduled task: $($_.Exception.Message)"
        }
    }
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "Removed Startup shortcut."
        $removed = $true
    }
    if (-not $removed) { Write-Host "Nothing was installed." }
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node)              { throw 'node.exe not found on PATH. Install Node 18+ first.' }
if (-not (Test-Path $entry)) { throw "Cannot find $entry" }

Write-Host "node   : $node"
Write-Host "script : $entry"
Write-Host ""

# ---------------------------------------------------------- try scheduled task

$taskInstalled = $false
try {
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $root

    # AtStartup is the one that matters at boot: it fires before anyone signs
    # in, so an overnight crash-reboot brings the watcher back without you.
    # AtLogOn is kept as a second trigger so a manual stop/start still recovers.
    #
    # Neither of those can recover a sleep. On 2026-09-04 the machine slept at
    # 03:55:47, five seconds after a poll; the watcher exited and stayed dead
    # for seven hours, through the PrizePicks fantasy drop. There had been no
    # reboot since Aug 27 so AtStartup never fired, and waking is not a logon.
    #
    # So the third trigger is a heartbeat: every five minutes, forever. With
    # MultipleInstances IgnoreNew and the pid lockfile below, a start against a
    # healthy watcher is a no-op, which makes this safe to fire constantly and
    # able to heal any death - sleep, crash, or a kill nobody noticed - rather
    # than only the two the other triggers cover.
    $revive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)
    # PowerShell 5.1 will not always set an unbounded duration from the
    # cmdlet, so pin it explicitly - empty string means "indefinitely".
    $revive.Repetition.Duration = ''

    $trigger = @(
        New-ScheduledTaskTrigger -AtStartup
        New-ScheduledTaskTrigger -AtLogOn
        $revive
    )

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew

    # Running as SYSTEM is what allows a boot trigger to work with no user
    # session present. Trade-off: SYSTEM has no desktop, so the Windows toast
    # cannot render - Discord carries the alerts, which is the channel that
    # reaches your phone anyway.
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'Alerts when UFC fantasy props drop on Underdog, PrizePicks, Betr and DK Pick6.' | Out-Null

    $taskInstalled = $true
    Write-Host "Installed as a Scheduled Task running as SYSTEM."
    Write-Host "  triggers : at startup (before sign-in) AND at logon"
    Write-Host "  recovery : restarts every minute on failure, no time limit"
    Write-Host ""

    # Two managers competing would just fight over the lock - drop the shortcut.
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "Removed the old Startup-folder shortcut (the task supersedes it)."
    }

    Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$taskName'"
}
catch {
    Write-Host "Scheduled Task registration failed: $($_.Exception.Message)"
    Write-Host "Falling back to a Startup-folder shortcut, which needs no admin rights."
    Write-Host ""
}

# ------------------------------------------------------- fall back to Startup

if (-not $taskInstalled) {
    if (-not (Test-Path $launcher)) { throw "Cannot find $launcher" }

    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnkPath)
    $s.TargetPath        = 'wscript.exe'
    $s.Arguments         = '"' + $launcher + '"'
    $s.WorkingDirectory  = $root
    $s.WindowStyle       = 7
    $s.Description       = 'Alerts when UFC fantasy props drop'
    $s.Save()

    if (-not (Test-Path $lnkPath)) { throw "Failed to create $lnkPath" }

    Write-Host "Installed a Startup shortcut:"
    Write-Host "  $lnkPath"
    Write-Host ""
    Write-Host "It launches start-hidden.vbs at every logon: no console window at all."
    Write-Host "The restart loop inside run.bat revives node if it ever exits."
    Write-Host ""
    Write-Host "Start it now with:"
    Write-Host "  wscript.exe `"$launcher`""
    Write-Host "Stop it with:  .\stop.bat"
}

Write-Host ""
Write-Host "Only one watcher can run at a time - a second one exits immediately"
Write-Host "rather than double-posting alerts (see watcher.lock)."
