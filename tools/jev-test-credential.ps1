Set-StrictMode -Version Latest

function Get-JevTestCredentialPath {
  if ($env:OS -ne 'Windows_NT' -or -not $env:LOCALAPPDATA) {
    throw 'The Jev test credential store requires Windows and LOCALAPPDATA.'
  }
  return Join-Path $env:LOCALAPPDATA 'EgoLite\automation-testing\typesafe-key.dpapi'
}

function Save-JevTestCredential {
  param(
    [Parameter(Mandatory)][Security.SecureString]$Secret,
    [string]$Path = (Get-JevTestCredentialPath)
  )
  if ($env:OS -ne 'Windows_NT') { throw 'Plaintext credential fallback is prohibited.' }
  if ($Secret.Length -eq 0) { throw 'The TypeSafe key cannot be empty.' }
  $ciphertext = ConvertFrom-SecureString -SecureString $Secret -ErrorAction Stop
  $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
  [void][IO.Directory]::CreateDirectory($directory)
  $temporary = Join-Path $directory ([IO.Path]::GetRandomFileName())
  try {
    [IO.File]::WriteAllText($temporary, $ciphertext, [Text.UTF8Encoding]::new($false))
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $temporary -AclObject $acl -ErrorAction Stop
    [IO.File]::Move($temporary, $Path, $true)
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Read-JevTestCredential {
  param([string]$Path = (Get-JevTestCredentialPath))
  if (-not [IO.File]::Exists($Path)) { return $null }
  if ($env:OS -ne 'Windows_NT') { throw 'The encrypted key can only be read on Windows.' }
  try {
    $ciphertext = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    return ConvertTo-SecureString -String $ciphertext -ErrorAction Stop
  } catch {
    throw 'The saved TypeSafe key cannot be decrypted by this Windows user. Use -ReplaceKey to replace it.'
  }
}
