@echo off
REM Restart the rental server on port 3003.
REM RUN AS ADMINISTRATOR (right-click ^> Run as administrator).
REM Kills the node process listening on 3003; _watchdog.ps1 respawns it
REM automatically within ~15 seconds with the latest code.

cd /d C:\apps\rental_messaging

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3003.*LISTENING"') do (
  echo Killing node PID %%a on port 3003...
  taskkill /PID %%a /F
)

echo Waiting for watchdog to restart the server...
timeout /t 20 /nobreak >nul

netstat -ano | findstr ":3003.*LISTENING"
if %errorlevel%==0 (
  echo Server is BACK UP on port 3003.
) else (
  echo Server not listening yet - wait a moment and refresh the app.
)
pause
