# whatsapp-sessions-exclusion.ps1 — one-shot: add the Baileys sessions folder
# to Windows Defender exclusions so real-time scanning cannot transiently
# lock session JSON files mid-send (EPERM "operation not permitted, open ...").
# Runs scheduled as SYSTEM (highest privileges).
$ErrorActionPreference = 'Stop'
$path = 'C:\apps\rental_messaging\backend\whatsapp\sessions'
try {
  $current = (Get-MpPreference).ExclusionPath
  if ($current -contains $path) {
    Write-Output "already excluded: $path"
  } else {
    Add-MpPreference -ExclusionPath $path
    Write-Output "exclusion added: $path"
  }
} catch {
  Write-Output "FAILED: $($_.Exception.Message)"
  exit 1
}
