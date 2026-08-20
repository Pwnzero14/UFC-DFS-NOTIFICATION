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
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'Alerts when UFC fantasy props drop on Underdog, PrizePicks, Betr and DK Pick6.' | Out-Null

    $taskInstalled = $true
    Write-Host "Installed as a Scheduled Task - starts at every logon, restarts on crash."
    Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$taskName'"
}
catch {
    Write-Host "Scheduled Task registration was denied (needs an elevated PowerShell)."
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
