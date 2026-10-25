$ErrorActionPreference = 'SilentlyContinue'

# Start the watchdog
Start-Process -FilePath "powershell" -ArgumentList "-ExecutionPolicy Bypass -File C:\apps\rental_messaging\_watchdog.ps1" -WindowStyle Hidden -PassThru | Out-Null
