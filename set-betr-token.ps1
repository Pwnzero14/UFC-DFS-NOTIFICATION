# Put a Betr refresh token into config.json - from a downloaded file, no clipboard.
#
# The clipboard route failed repeatedly because taking a screenshot puts an image
# on the clipboard and wipes the copied token. So the browser downloads the token
# to a file and this reads that, which nothing can clobber. Get it onto disk from
# the Betr tab's DevTools console:
#
#   (()=>{const t=JSON.parse(localStorage.getItem('user-session-storage')).state.session.refresh_token;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'text/plain'}));a.download='betr-token.txt';a.click();})()
#
# then run this. The token self-renews forever after this one grab (betr-auth.js).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'
$dl = Join-Path $env:USERPROFILE 'Downloads\betr-token.txt'

if (-not (Test-Path $dl)) {
    Write-Host "no $dl - download the refresh token from the Betr console first:" -ForegroundColor Red
    Write-Host "  (see the one-liner at the top of this script)"
    exit 1
}

# Strip ALL whitespace: a real JWT has none, so this only cleans a wrapped copy.
$token = ((Get-Content $dl -Raw) -replace '\s', '')
Remove-Item $dl -Force -ErrorAction SilentlyContinue

if ($token -notmatch '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
    Write-Host "that file is not a JWT (starts '$($token.Substring(0,[Math]::Min(6,$token.Length)))...', length $($token.Length))" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $cfgPath)) { throw "config.json not found at $cfgPath" }
$raw = Get-Content $cfgPath -Raw

# Replace only the value, so nothing else in the file is touched. A JWT has no
# double-quote, so "[^"]*" spans the whole old value; the script-block evaluator
# avoids $-substitution surprises in the replacement.
$pattern = '("refreshToken"\s*:\s*)"[^"]*"'
if ($raw -notmatch $pattern) { throw "no refreshToken field under betr in config.json" }
$updated = [regex]::Replace($raw, $pattern, { param($m) $m.Groups[1].Value + '"' + $token + '"' }, 1)

try { $null = $updated | ConvertFrom-Json } catch { throw "result would not be valid JSON - aborted" }

# Write WITHOUT a BOM. PowerShell's Set-Content -Encoding utf8 adds one, and
# Node's JSON.parse chokes on it - that cost an hour on 2026-09-10.
[System.IO.File]::WriteAllText($cfgPath, $updated, (New-Object System.Text.UTF8Encoding $false))

$masked = $token.Substring(0, 6) + ('*' * 8) + $token.Substring($token.Length - 4)
Write-Host "wrote betr.refreshToken = $masked  (length $($token.Length))" -ForegroundColor Green
Write-Host "no restart needed for the token; restart.ps1 to load the new code."
