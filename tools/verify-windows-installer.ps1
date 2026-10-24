param([string]$Installer = (Join-Path $PSScriptRoot '..\release\EgoLite-Setup-0.2.0-x64.exe'))
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$parent = Join-Path $project '.tmp\codex\windows-installer'
$registryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$existing = @(Get-ItemProperty $registryRoots -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'EgoLite')
if ($existing.Count) { throw 'An EgoLite installation already exists. Run this installer test in a clean Windows account.' }
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if (Test-Path -LiteralPath (Join-Path $folder 'EgoLite.lnk')) { throw 'An existing user shortcut must be preserved. Run this test in a clean Windows account.' }
}
$work = Join-Path $parent ([guid]::NewGuid().ToString('N'))
$installation = Join-Path $work '安装测试 EgoLite'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$previous = @{}
foreach ($name in @('TEMP','TMP','EGO_AGENT_INTEGRATION_DISABLED')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$uninstalled = $false
try {
  $env:TEMP = $work
  $env:TMP = $work
  $env:EGO_AGENT_INTEGRATION_DISABLED = '1'
  $setup = Start-Process -FilePath ([IO.Path]::GetFullPath($Installer)) -ArgumentList "/S /currentuser /D=$installation" -WindowStyle Hidden -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)" }
  $exe = Join-Path $installation 'EgoLite.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'The installer did not produce EgoLite.exe at the requested path' }
  & node (Join-Path $PSScriptRoot 'windows-suite-smoke.mjs') $exe
  if ($LASTEXITCODE -ne 0) { throw 'Installed application verification failed' }
}
finally {
  $uninstaller = Join-Path $installation 'Uninstall EgoLite.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $result = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -WindowStyle Hidden -Wait -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $installation 'EgoLite.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    $uninstalled = -not (Test-Path -LiteralPath (Join-Path $installation 'EgoLite.exe'))
  }
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  $resolved = [IO.Path]::GetFullPath($work)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($parent) + [IO.Path]::DirectorySeparatorChar)) { throw 'Cleanup escaped the test directory' }
  if ($uninstalled -or -not (Test-Path -LiteralPath $installation)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
if (-not $uninstalled) { throw 'Uninstallation did not finish' }
$reportPath = Join-Path $project 'release\validation-0.2.0.json'
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
$report | Add-Member -NotePropertyName installer -NotePropertyValue @{ installed = $true; uninstalled = $true; unicodeAndSpaces = $true; mode = 'current-user silent'; cleanVirtualMachine = $false } -Force
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Output 'Installer, installed application, Unicode path, and uninstaller passed.'
