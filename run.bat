@echo off
REM Restart loop for the UFC fantasy prop watcher.
REM Safe to run headless: no command here reads stdin, so it still works when
REM launched hidden by start-hidden.vbs with output redirected to a log.

cd /d "%~dp0"
title UFC Fantasy Prop Alerts

:loop
echo [%date% %time%] starting watcher
node src\index.js
echo [%date% %time%] watcher exited (code %errorlevel%) - restarting in 30s

REM ping instead of timeout: timeout aborts with "input redirection is not
REM supported" when stdin is not a console.
ping -n 31 127.0.0.1 >nul

goto loop
