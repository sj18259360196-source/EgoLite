param(
  [ValidateRange(1, 1000)]
  [int]$Cycles = 10
)

$ErrorActionPreference = 'Stop'
for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
  Write-Host "COMPANION CYCLE $cycle/$Cycles"
  node tools/companion-real-smoke.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Start-Sleep -Milliseconds 250
  $edgeLeft = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*ego-companion-edge-*'
  }
  if ($edgeLeft) { throw "Temporary Edge process leaked in cycle $cycle" }
}
Write-Host "$Cycles/$Cycles cycles passed with no temporary Edge leftovers"
