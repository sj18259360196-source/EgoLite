param(
  [ValidateSet('Edge', 'Chrome', 'Both')]
  [string]$Browser = 'Edge',
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'apps\companion-extension'
$nativeInstaller = Join-Path $root 'apps\native-host\install.ps1'
$manifest = Join-Path $extension 'manifest.json'

if (-not (Test-Path -LiteralPath $manifest)) {
  throw "Companion extension manifest not found: $manifest"
}

& $nativeInstaller -Browser $Browser -Rebuild:$Rebuild
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "Native Host installation failed with exit code $LASTEXITCODE"
}

npm --prefix $root run validate:extension
if ($LASTEXITCODE -ne 0) { throw "Extension validation failed with exit code $LASTEXITCODE" }

Set-Clipboard -Value $extension
Write-Host ""
Write-Host "Ego Companion is prepared. The extension directory is on the clipboard:"
Write-Host $extension
Write-Host ""
Write-Host "In the browser page that opens:"
Write-Host "  1. Enable Developer mode."
Write-Host "  2. Choose Load unpacked."
Write-Host "  3. Paste/select the directory above."
Write-Host "  4. Keep Ego Windows Companion enabled."

if ($Browser -in @('Edge', 'Both')) {
  $edge = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($edge) { Start-Process -FilePath $edge -ArgumentList 'edge://extensions/' }
}
if ($Browser -in @('Chrome', 'Both')) {
  $chrome = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/' }
}

Start-Process explorer.exe -ArgumentList "/select,`"$manifest`""
Write-Host ""
Write-Host "After loading the extension, run: npm run doctor:companion"
