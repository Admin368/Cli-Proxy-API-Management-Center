param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$mutex = New-Object System.Threading.Mutex($false, 'Local\CLIProxyManagementServerLauncher')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { exit }
  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'workspace.txt')
  $workspace = $config[0]
  $bun = $config[1]
  $url = 'http://127.0.0.1:5173/'
  $bindingPath = Join-Path $PSScriptRoot 'proxy-controller.txt'
  $controlled = Test-Path -LiteralPath $bindingPath
  if ($controlled) {
    $binding = Get-Content -LiteralPath $bindingPath
    $proxyConfig = Get-Content -LiteralPath $binding[0] -Raw
    $keyMatch = [regex]::Match($proxyConfig, '(?m)^management-secret-key\s*=\s*("(?:[^"\\]|\\.)*")')
    if (-not $keyMatch.Success) { throw 'The desktop management connection could not be read.' }
    $managementKey = ConvertFrom-Json $keyMatch.Groups[1].Value
    $headers = @{ Authorization = "Bearer $managementKey" }
    $controller = $binding[1] + '/v0/management/plugins/custom-web-ui/'
    try {
      $state = Invoke-RestMethod -Uri ($controller + 'status') -Headers $headers -TimeoutSec 10
      if (-not $state.running -and -not $state.managed) {
        $state = Invoke-RestMethod -Uri ($controller + 'start') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 15
      }
    } catch { throw 'Start EasyCLIProxyAPI and enable its Custom Web UI plugin first.' }
    $parsedUrl = [uri]$state.url
    if ($parsedUrl.Scheme -ne 'http' -or $parsedUrl.Host -ne '127.0.0.1') { throw 'The controller returned an unexpected server URL.' }
    $url = $state.url
  }
  function Test-Server {
    try { return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
    catch { return $false }
  }
  if (-not (Test-Server)) {
    if (-not (Test-Path -LiteralPath (Join-Path $workspace 'package.json'))) { throw 'The project folder could not be found.' }
    if (-not $controlled) {
      Start-Process -FilePath $bun -ArgumentList @('run','dev','--host','127.0.0.1','--port','5173','--strictPort') -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
    }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Server)) {
      if ((Get-Date) -gt $deadline) { throw "The server did not start. Check $PSScriptRoot\server-error.log" }
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $NoBrowser) { Start-Process ($url + '#/quota/forecast') }
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'CLI Proxy Server', 'OK', 'Error') | Out-Null
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
