param(
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId = 'omdijpknicgkhnpadadcggpnbojohpdc',
  [ValidateSet('Edge', 'Chrome', 'Both')]
  [string]$Browser = 'Both',
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'EgoCompat.NativeHost.csproj'
$publish = Join-Path $PSScriptRoot 'publish'
$exe = Join-Path $publish 'ego-native-host.exe'
$needsPublish = $Rebuild -or -not (Test-Path -LiteralPath $exe)
if ($needsPublish) {
  dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $publish
  if ($LASTEXITCODE -ne 0) { throw "Native Host publish failed with exit code $LASTEXITCODE" }
}
$manifest = Join-Path $publish 'com.egocompat.bridge.json'
$configDirectory = Join-Path $env:LOCALAPPDATA 'EgoCompat'
$configPath = Join-Path $configDirectory 'companion.json'
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $configPath)) {
  Add-Type -AssemblyName System.Security
  $secret = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($secret) } finally { $rng.Dispose() }
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $secret,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $configJson = @{
    pipeName = "ego-compat-companion-$([guid]::NewGuid().ToString('N'))"
    protectedSecret = [Convert]::ToBase64String($protected)
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.UTF8Encoding]::new($false))
}
$manifestJson = @{
  name = 'com.egocompat.bridge'
  description = 'Ego Windows Companion native messaging bridge'
  path = $exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($manifest, $manifestJson, [System.Text.UTF8Encoding]::new($false))

$registries = @()
if ($Browser -in @('Edge', 'Both')) { $registries += 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.egocompat.bridge' }
if ($Browser -in @('Chrome', 'Both')) { $registries += 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.egocompat.bridge' }
foreach ($registry in $registries) {
  New-Item -Path $registry -Force | Out-Null
  Set-Item -Path $registry -Value $manifest
}

Write-Host "Native host installed for $Browser. Manifest: $manifest"
Write-Host "Companion config: $configPath"
