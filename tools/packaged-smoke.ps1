param(
  [string]$Executable = (Join-Path $PSScriptRoot "..\release\win-unpacked\EgoLite.exe")
)

function Invoke-PipeRpc {
  param(
    [Parameter(Mandatory)][string]$PipeName,
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][hashtable]$Params
  )

  $deadline = (Get-Date).AddSeconds(25)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
      ".",
      $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      [System.IO.Pipes.PipeOptions]::Asynchronous
    )
    try {
      $pipe.Connect(500)
      $encoding = [System.Text.UTF8Encoding]::new($false)
      $writer = [System.IO.StreamWriter]::new($pipe, $encoding, 4096, $true)
      $reader = [System.IO.StreamReader]::new($pipe, $encoding, $false, 4096, $true)
      $writer.AutoFlush = $true
      $id = [Guid]::NewGuid().ToString("N")
      $writer.WriteLine((@{ jsonrpc = "2.0"; id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress))
      $response = $reader.ReadLine() | ConvertFrom-Json
      if ($response.error) { throw $response.error.message }
      return $response.result
    }
    catch {
      $lastError = $_
      Start-Sleep -Milliseconds 200
    }
    finally {
      $pipe.Dispose()
    }
  }
  throw "Unable to call $Method on pipe ${PipeName}: $lastError"
}

function Invoke-PackagedMcpStatus {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$RuntimeEntry,
    [Parameter(Mandatory)][string]$AutomationPipe
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.ArgumentList.Add($RuntimeEntry)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Environment["ELECTRON_RUN_AS_NODE"] = "1"
  $startInfo.Environment["EGO_DESKTOP_AUTOMATION_PIPE"] = "\\.\pipe\$AutomationPipe"
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  try {
    $initialize = @{
      jsonrpc = "2.0"
      id = 1
      method = "initialize"
      params = @{
        protocolVersion = "2025-11-25"
        capabilities = @{}
        clientInfo = @{ name = "egolite-package-smoke"; version = "1.0.0" }
      }
    } | ConvertTo-Json -Compress -Depth 8
    $process.StandardInput.WriteLine($initialize)
    $process.StandardInput.Flush()
    $initializeTask = $process.StandardOutput.ReadLineAsync()
    if (-not $initializeTask.Wait(10000)) { throw "Packaged MCP initialize timed out" }
    $initializeResponse = $initializeTask.Result | ConvertFrom-Json
    if ($initializeResponse.error) { throw $initializeResponse.error.message }

    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}')
    $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ego_desktop_status","arguments":{}}}')
    $process.StandardInput.Flush()
    $statusTask = $process.StandardOutput.ReadLineAsync()
    if (-not $statusTask.Wait(10000)) { throw "Packaged MCP status call timed out" }
    $statusResponse = $statusTask.Result | ConvertFrom-Json
    if ($statusResponse.error) { throw $statusResponse.error.message }
    $status = $statusResponse.result.content[0].text | ConvertFrom-Json
    return [bool]$status.ready
  }
  finally {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(2000)) { $process.Kill($true) }
    $process.Dispose()
  }
}

$ErrorActionPreference = "Stop"
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable)) { throw "Packaged executable not found: $Executable" }

$runId = [Guid]::NewGuid().ToString("N")
$brokerPipe = "egolite-package-broker-$runId"
$automationPipe = "egolite-package-automation-$runId"
$testRoot = Join-Path $env:TEMP "egolite-package-smoke-$runId"
$capturePath = Join-Path $testRoot "desktop.png"
$startedAt = Get-Date
$originalEnvironment = @{}
$names = @(
  "PATH",
  "EGO_DESKTOP_PIPE",
  "EGO_DESKTOP_AUTOMATION_PIPE",
  "EGO_DESKTOP_USER_DATA",
  "EGO_DESKTOP_STATE",
  "EGO_DESKTOP_CAPTURE",
  "OPENAI_API_KEY"
)

New-Item -ItemType Directory -Path $testRoot | Out-Null
foreach ($name in $names) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

try {
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $env:EGO_DESKTOP_PIPE = "\\.\pipe\$brokerPipe"
  $env:EGO_DESKTOP_AUTOMATION_PIPE = "\\.\pipe\$automationPipe"
  $env:EGO_DESKTOP_USER_DATA = Join-Path $testRoot "user-data"
  $env:EGO_DESKTOP_STATE = Join-Path $testRoot "desktop-tabs.json"
  $env:EGO_DESKTOP_CAPTURE = $capturePath
  $env:OPENAI_API_KEY = ""

  $process = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  $desktopStatus = Invoke-PipeRpc -PipeName $automationPipe -Method "desktop.status" -Params @{}
  $brokerHello = Invoke-PipeRpc -PipeName $brokerPipe -Method "hello" -Params @{ clientId = "package-smoke" }
  $runtimeEntry = Join-Path (Split-Path -Parent $Executable) "resources\runtime\desktop-mcp.mjs"
  $mcpBundled = Test-Path -LiteralPath $runtimeEntry
  $mcpReady = if ($mcpBundled) {
    Invoke-PackagedMcpStatus -Executable $Executable -RuntimeEntry $runtimeEntry -AutomationPipe $automationPipe
  } else {
    $null
  }

  $captureDeadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $capturePath) -and (Get-Date) -lt $captureDeadline) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $capturePath)) { throw "Packaged desktop screenshot was not created" }

  [pscustomobject]@{
    executable = $Executable
    nodeOnPath = [bool](Get-Command node -ErrorAction SilentlyContinue)
    desktopReady = [bool]$desktopStatus.ready
    desktopBackend = $desktopStatus.backend
    protocolVersion = $brokerHello.protocolVersion
    mcpBundled = $mcpBundled
    mcpReady = $mcpReady
    screenshot = $capturePath
    screenshotBytes = (Get-Item -LiteralPath $capturePath).Length
  } | ConvertTo-Json -Depth 8
}
finally {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CreationDate -ge $startedAt.AddSeconds(-2) -and
      ($_.ExecutablePath -eq $Executable -or $_.Name -eq "EgoLite.exe")
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process") }
}
