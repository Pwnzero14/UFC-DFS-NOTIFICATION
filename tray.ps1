# System-tray status widget for the UFC prop watcher.
#
# The watcher itself runs as SYSTEM (so it starts at boot, before anyone signs
# in). SYSTEM has no desktop, so it cannot draw a tray icon - this helper runs
# in YOUR session instead and only reads state.json / watcher.lock. It never
# touches the watcher's data, so if this crashes the watcher is unaffected.
#
# Start:  wscript.exe tray-hidden.vbs      (or: powershell -File tray.ps1)
# Stop:   right-click the icon -> Hide this icon

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single instance. Two tray icons for one watcher is just confusing, and it is
# easy to launch twice - a Startup shortcut plus a manual run.
$mutexName = 'Global' + [char]92 + 'UFCPropAlertsTray'
$script:mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $script:mutex.WaitOne(0, $false)) { exit }

$root      = Split-Path -Parent $MyInvocation.MyCommand.Definition
$statePath = Join-Path $root 'state.json'
$lockPath  = Join-Path $root 'watcher.lock'
$logPath   = Join-Path $root 'watcher.log'
$taskName  = 'UFC Fantasy Prop Alerts'

function Get-WatcherPid {
    if (-not (Test-Path $lockPath)) { return $null }
    $raw = (Get-Content $lockPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($raw -match '^\d+$') { return [int]$raw }
    return $null
}

function Test-WatcherAlive {
    $p = Get-WatcherPid
    if (-not $p) { return $false }
    return [bool](Get-Process -Id $p -ErrorAction SilentlyContinue)
}

function Get-BookSummary {
    if (-not (Test-Path $statePath)) { return @() }
    try { $st = Get-Content $statePath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return @() }
    $names = [ordered]@{
        underdog      = 'Underdog'
        prizepicks    = 'PrizePicks'
        betr          = 'Betr'
        pick6         = 'Pick6'
        dksportsbook  = 'DK Sportsbook'
    }
    $rows = @()
    foreach ($k in $names.Keys) {
        $b = $st.books.$k
        if (-not $b) { continue }
        $props   = @($b.props.PSObject.Properties)
        $alerted = @($props | Where-Object { $_.Value.kind -eq 'fantasy' -or $_.Value.kind -eq 'tracked' })
        $mins    = if ($b.updatedAt) { [int]((Get-Date) - [datetime]$b.updatedAt).TotalMinutes } else { -1 }
        $rows += [pscustomobject]@{
            Name    = $names[$k]
            Healthy = ($b.healthy -ne $false)
            Props   = $props.Count
            Live    = $alerted.Count
            Age     = $mins
        }
    }
    return $rows
}

function Get-StatusText {
    $alive = Test-WatcherAlive
    $rows  = Get-BookSummary
    $lines = @()
    $lines += if ($alive) { "RUNNING  (pid $(Get-WatcherPid))" } else { "NOT RUNNING" }
    $lines += ''
    foreach ($r in $rows) {
        $mark = if ($r.Healthy) { 'OK  ' } else { 'DOWN' }
        $age  = if ($r.Age -lt 0) { '' } elseif ($r.Age -lt 60) { "$($r.Age)m ago" } else { "$([int]($r.Age/60))h ago" }
        $lines += ("{0} {1,-14} {2,3} props, {3,2} live   {4}" -f $mark, $r.Name, $r.Props, $r.Live, $age)
    }
    return ($lines -join "`n")
}

# --- tray icon -------------------------------------------------------------

$notify = New-Object System.Windows.Forms.NotifyIcon
try {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $notify.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($nodeExe)
} catch {
    $notify.Icon = [System.Drawing.SystemIcons]::Information
}
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# A balloon tip caps out around 255 characters, which truncates after two
# books. Use a small window instead so the whole board always fits.
function Show-StatusWindow {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'UFC Prop Alerts'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $form.ClientSize = New-Object System.Drawing.Size(430, 210)
    $form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 28)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.BorderStyle = 'None'
    $box.Font = New-Object System.Drawing.Font('Consolas', 10)
    $box.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 28)
    $box.ForeColor = [System.Drawing.Color]::Gainsboro
    $box.Location = New-Object System.Drawing.Point(14, 12)
    $box.Size = New-Object System.Drawing.Size(402, 150)
    $box.Text = (Get-StatusText) -replace "`n", "`r`n"
    $box.TabStop = $false
    $form.Controls.Add($box)

    $refresh = New-Object System.Windows.Forms.Button
    $refresh.Text = 'Refresh'
    $refresh.Location = New-Object System.Drawing.Point(240, 172)
    $refresh.Size = New-Object System.Drawing.Size(80, 26)
    $refresh.add_Click({ $box.Text = (Get-StatusText) -replace "`n", "`r`n" })
    $form.Controls.Add($refresh)

    $close = New-Object System.Windows.Forms.Button
    $close.Text = 'Close'
    $close.Location = New-Object System.Drawing.Point(330, 172)
    $close.Size = New-Object System.Drawing.Size(80, 26)
    $close.add_Click({ $form.Close() })
    $form.Controls.Add($close)

    $form.CancelButton = $close   # Esc closes it
    [void]$form.ShowDialog()
    $form.Dispose()
}

$miStatus = $menu.Items.Add('Show status')
$miStatus.add_Click({ Show-StatusWindow })

# A live tail is what you actually want: newest lines, already at the bottom,
# updating as it polls. Notepad opens a 120k-character file at line 1, which is
# this morning's entries and useless without a lot of scrolling.
$miTail = $menu.Items.Add('Watch log (live)')
$miTail.add_Click({
    if (-not (Test-Path $logPath)) { return }
    Start-Process powershell.exe -ArgumentList @(
        '-NoProfile','-NoExit','-Command',
        "`$host.UI.RawUI.WindowTitle='UFC watcher log'; Get-Content -LiteralPath '$logPath' -Tail 40 -Wait"
    )
})

$miLog = $menu.Items.Add('Open full log')
$miLog.add_Click({ if (Test-Path $logPath) { Start-Process notepad.exe $logPath } })

$miFolder = $menu.Items.Add('Open project folder')
$miFolder.add_Click({ Start-Process explorer.exe $root })

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# Stopping/starting a SYSTEM-owned task needs elevation - hence the UAC prompt.
$miRestart = $menu.Items.Add('Restart watcher (admin)')
$miRestart.add_Click({
    Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @(
        '-NoProfile','-Command',
        "Stop-ScheduledTask -TaskName '$taskName'; Start-ScheduledTask -TaskName '$taskName'"
    )
})

$miStop = $menu.Items.Add('Stop watcher (admin)')
$miStop.add_Click({
    Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @(
        '-NoProfile','-Command', "Stop-ScheduledTask -TaskName '$taskName'"
    )
})

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

# Closes only this icon. The watcher keeps running - made explicit so the two
# are never confused.
$miExit = $menu.Items.Add('Hide this icon (watcher keeps running)')
$miExit.add_Click({
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Show-StatusWindow })

# --- tooltip refresh -------------------------------------------------------
# NotifyIcon.Text is capped at 63 characters, so keep the hover text terse and
# put the detail in the balloon.

function Update-Tooltip {
    $rows = Get-BookSummary
    if (Test-WatcherAlive) {
        $down = @($rows | Where-Object { -not $_.Healthy }).Count
        $live = ($rows | Measure-Object -Property Live -Sum).Sum
        $t = if ($down -gt 0) {
            "UFC Alerts: running, $live live, $down book down"
        } else {
            "UFC Alerts: running, $live live lines"
        }
    } else {
        $t = 'UFC Alerts: NOT RUNNING'
    }
    if ($t.Length -gt 63) { $t = $t.Substring(0, 60) + '...' }
    $notify.Text = $t
}

Update-Tooltip
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ Update-Tooltip })
$timer.Start()

[System.Windows.Forms.Application]::Run()
$notify.Dispose()
