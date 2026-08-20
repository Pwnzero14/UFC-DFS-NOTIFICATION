@echo off
REM Stops the watcher completely.
REM
REM Order matters: the run.bat restart loop is node's PARENT, not its child, so
REM "taskkill /T" on the node pid does not touch it - the loop would simply
REM start a new watcher 30 seconds later. Kill the loop first, then node.

cd /d "%~dp0"

echo Stopping the restart loop...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*run.bat*' } | ForEach-Object { Write-Host ('  killing cmd pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Stopping the watcher...
if exist watcher.lock (
    set /p PID=<watcher.lock
    call :killpid
) else (
    echo   no watcher.lock found
)

REM Catch any node still running our entry point, lock file or not.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src\index.js*' } | ForEach-Object { Write-Host ('  killing node pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

if exist watcher.lock del /q watcher.lock

echo Stopped.
goto :eof

:killpid
echo   killing node pid %PID%
taskkill /PID %PID% /F >nul 2>&1
goto :eof
