# add-defender-exclusion.bat — self-elevating: adds Windows Defender exclusion
# for the WhatsApp sessions folder so real-time scanning can never transiently
# lock session JSON files mid-send (EPERM "operation not permitted, open
# ...session-*.json" — messages delivered but reported as Failed).
# Double-click and accept the UAC prompt (one time only).
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\apps\rental_messaging\_scripts\whatsapp-sessions-exclusion.ps1' -Wait; Start-Sleep -Seconds 3"
echo Done. Exclusion applied. You can close this window.
pause
