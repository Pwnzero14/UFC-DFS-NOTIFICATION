# Start the tray status widget automatically at logon.
#
# The watcher runs as SYSTEM, which has no desktop - that is why the Windows
# toasts always fail with "Access is denied" and why the watcher cannot draw a
# tray icon itself. The widget runs in the signed-in user's session instead and
# only reads state.json and watcher.log, so starting or killing it can never
# disturb the watcher.
#
# It is a per-user shortcut in the Startup folder, not a scheduled task: it
# needs a desktop to draw on, so there is no point running it before sign-in.
# No elevation required.
#
#   .\install-tray-startup.ps1            install (or refresh) the shortcut
#   .\install-tray-startup.ps1 -Remove    take it out again

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs      = Join-Path $root 'tray-hidden.vbs'
$startup  = [Environment]::GetFolderPath('Startup')
$lnk      = Join-Path $startup 'UFC Alerts Tray.lnk'

if ($Remove) {
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force
        Write-Host "removed : $lnk" -ForegroundColor Green
    } else {
        Write-Host "nothing to remove - no shortcut at $lnk"
    }
    return
}

if (-not (Test-Path $vbs)) { throw "tray-hidden.vbs not found at $vbs" }

$sh = New-Object -ComObject WScript.Shell
$s  = $sh.CreateShortcut($lnk)
# Invoke wscript explicitly rather than pointing at the .vbs. A shortcut to the
# script itself obeys the .vbs file association, and if that has ever been
# repointed at an editor the widget silently opens as text at every logon.
$s.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
$s.Arguments        = '"' + $vbs + '"'
$s.WorkingDirectory = $root
$s.Description      = 'UFC prop watcher tray status widget (reads state only)'
$s.WindowStyle      = 7   # minimised; the vbs launcher hides the console anyway
$s.Save()

# Read it back - CreateShortcut succeeds against a path it failed to write.
$check = $sh.CreateShortcut($lnk)
if ((Test-Path $lnk) -and $check.Arguments -match [regex]::Escape($vbs)) {
    Write-Host "installed : $lnk" -ForegroundColor Green
    Write-Host "  runs    : wscript.exe $($check.Arguments)"
    Write-Host "  starts  : at logon, hidden. Start it now by double-clicking"
    Write-Host "            tray-hidden.vbs, or just sign out and back in."
} else {
    Write-Host "FAILED    : shortcut did not verify at $lnk" -ForegroundColor Red
    exit 1
}
