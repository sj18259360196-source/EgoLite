param(
  [switch]$ReplaceKey,
  [switch]$UseSavedOnly,
  [switch]$Corpus,
  [switch]$CodexPilot,
  [switch]$CodexRepairPilot,
  [switch]$CodexCorpus,
  [switch]$Sdk,
  [switch]$Repair,
  [switch]$Probe,
  [switch]$CompactProbe,
  [switch]$Relevance,
  [ValidatePattern('^[a-z0-9-]{1,80}$')][string]$CorpusFilter
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'jev-test-credential.ps1')
if ($ReplaceKey -and $UseSavedOnly) { throw 'Choose ReplaceKey or UseSavedOnly, not both.' }
if (@($Probe, $CompactProbe, $Relevance, $Corpus, $CodexPilot, $CodexRepairPilot, $CodexCorpus, $Sdk, $Repair).Where({ $_ }).Count -gt 1) { throw 'Choose one test mode.' }
if ($CorpusFilter -and -not ($Corpus -or $CodexPilot -or $CodexRepairPilot)) { throw 'CorpusFilter requires Corpus or a Codex pilot.' }
if ($CompactProbe) { Write-Host 'This runs paid TypeSafe decisions against synthetic English and Chinese inputs; no browser actions.' }
else { Write-Host 'This runs paid TypeSafe requests against local English and Chinese browser fixtures.' }
$secure = if (-not $ReplaceKey) { Read-JevTestCredential } else { $null }
if ($null -eq $secure) {
  if ($UseSavedOnly) { throw 'No saved TypeSafe test key. Run this script once without -UseSavedOnly to save it securely.' }
  $secure = Read-Host 'TypeSafe API Key (hidden; saved with Windows current-user encryption)' -AsSecureString
  try { Save-JevTestCredential -Secret $secure } catch { $secure.Dispose(); throw }
  Write-Host 'Saved with Windows current-user encryption. Future runs will reuse it.'
} else {
  Write-Host 'Using the Windows-encrypted saved TypeSafe key.'
}
$pointer = [IntPtr]::Zero
$previous = $env:TYPESAFE_API_KEY
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $env:TYPESAFE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  Push-Location (Split-Path $PSScriptRoot -Parent)
  try {
    do {
      $arguments = @('tools/automation-smoke.mjs', '--bundled', '--live')
      if ($Corpus) { $arguments += '--corpus' }
      if ($CodexPilot) { $arguments += '--codex-pilot' }
      if ($CodexRepairPilot) { $arguments += '--codex-repair-pilot' }
      if ($CodexCorpus) { $arguments += '--codex-corpus' }
      if ($Sdk) { $arguments += '--sdk-automation' }
      if ($Repair) { $arguments += '--repair' }
      if ($Relevance) { $arguments += '--relevance' }
      if ($CorpusFilter) { $arguments += "--corpus-filter=$CorpusFilter" }
      if ($Probe) { $arguments = @('tools/jev-prompt-probe.mjs') }
      if ($CompactProbe) { $arguments = @('tools/jev-compact-probe.mjs') }
      & node @arguments
      $testExitCode = $LASTEXITCODE
      if ($testExitCode -eq 0) { break }
      if ($CompactProbe) { Write-Warning 'Live Jev input comparison failed. See output/jev-compact-validation for the fixed report.' }
      elseif ($Relevance) { Write-Warning 'Live relevance verification failed. See output/jev-automation-validation-live-relevance/result.json.' }
      else { Write-Warning 'Live Jev verification failed. See output/jev-automation-validation-live/result.json.' }
      if ($UseSavedOnly) { break }
      Write-Host 'Each retry makes paid requests. The encrypted saved key remains available after exit.'
      $retrySecret = Read-Host 'After a code fix, enter R to retry; any other input exits (input hidden)' -AsSecureString
      $retryPointer = [IntPtr]::Zero
      try {
        $retryPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($retrySecret)
        $retry = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($retryPointer)
      } finally {
        if ($retryPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($retryPointer) }
        $retrySecret.Dispose()
      }
    } while ($retry -ieq 'R')
    if ($testExitCode -ne 0) { throw 'Live Jev verification has not passed.' }
  } finally {
    Pop-Location
  }
} finally {
  $env:TYPESAFE_API_KEY = $previous
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $secure.Dispose()
}
