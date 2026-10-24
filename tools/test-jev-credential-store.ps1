$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'jev-test-credential.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp\codex\jev-automation'))
$work = Join-Path $root ('credential-test-' + [Guid]::NewGuid().ToString('N'))
$path = Join-Path $work 'fixture-key.dpapi'
$secret = ConvertTo-SecureString 'synthetic-credential-test-only' -AsPlainText -Force
$loaded = $null
$pointer = [IntPtr]::Zero
try {
  if ($null -ne (Read-JevTestCredential -Path $path)) { throw 'Missing credential must return null.' }
  Save-JevTestCredential -Secret $secret -Path $path
  if ([IO.File]::ReadAllText($path).Contains('synthetic-credential-test-only')) { throw 'Plaintext credential found.' }
  $acl = Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesProtected) { throw 'Credential file inherited access rules.' }
  $loaded = Read-JevTestCredential -Path $path
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loaded)
  if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -cne 'synthetic-credential-test-only') { throw 'Credential did not round-trip.' }
  [IO.File]::WriteAllText($path, 'invalid-ciphertext', [Text.UTF8Encoding]::new($false))
  $rejected = $false
  try { [void](Read-JevTestCredential -Path $path) } catch { $rejected = $true }
  if (-not $rejected) { throw 'Invalid credential must not fall back to plaintext.' }
  Write-Output 'PASS: Windows DPAPI round-trip, no plaintext, protected ACL, missing key, corrupt key rejection.'
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($null -ne $loaded) { $loaded.Dispose() }
  $secret.Dispose()
  $resolved = [IO.Path]::GetFullPath($work)
  if (-not $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
