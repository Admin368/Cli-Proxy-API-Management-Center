# Requires Windows PowerShell 5.1. No modules or administrator rights required.
[CmdletBinding()]
param([string]$ProxyFolder, [switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'
function Read-Default($Prompt, $Default) {
  $value = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}
function Read-Key($Prompt) {
  $secret = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Get-Candidates {
  $addresses = @()
  $ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if (!$ts -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) {
    $ts = Get-Command "$env:ProgramFiles\Tailscale\tailscale.exe"
  }
  if ($ts) {
    try {
      $status = (& $ts.Source status --json 2>$null) | ConvertFrom-Json
      foreach ($peer in $status.Peer.PSObject.Properties.Value) {
        if ($peer.Online) { $addresses += $peer.TailscaleIPs | Where-Object { $_ -match '^\d+\.' } }
      }
    } catch { Write-Host 'Tailscale discovery unavailable; continuing with LAN discovery.' }
  }
  $addresses += Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.State -in @('Reachable', 'Stale', 'Delay', 'Probe') } |
    Select-Object -ExpandProperty IPAddress
  $local = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)
  return @($addresses | Sort-Object -Unique | Where-Object { $_ -notin $local -and $_ -notmatch '^(127|224|239|255)\.' })
}
function Find-Proxies($Addresses, $Port) {
  # Parallel TCP connects keep the default discovery lightweight.
  $pending = @($Addresses | ForEach-Object {
    $client = New-Object Net.Sockets.TcpClient
    [pscustomobject]@{ Address = $_; Client = $client; Task = $client.ConnectAsync($_, $Port) }
  })
  if ($pending.Count) { Start-Sleep -Milliseconds 900 }
  foreach ($probe in $pending) {
    try {
      if ($probe.Client.Connected) {
        $url = "http://$($probe.Address):$Port"
        try {
          $root = Invoke-RestMethod $url -TimeoutSec 2
          if ($root.message -match 'CLI Proxy API') { $url }
        } catch { }
      }
    } finally { $probe.Client.Dispose() }
  }
}
function New-Upstream($Url, $Key, $Models) {
  return [ordered]@{
    name = 'network-main'; 'base-url' = "$Url/v1"
    keys = @(@{ 'api-key' = $Key })
    models = @($Models | Sort-Object -Unique | ForEach-Object { @{ name = $_; alias = "main/$_" } })
  }
}
if ($LibraryOnly) { return }
try {
  Write-Host 'Start EasyCLIProxyAPI locally before continuing. This adds a network-main provider.'
  Write-Host 'Models use main/<model> aliases so requests explicitly choose the selected main machine.'
  if (!$ProxyFolder) { $ProxyFolder = (Get-Location).Path }
  if (!(Test-Path (Join-Path $ProxyFolder 'config.yaml'))) {
    $ProxyFolder = Read-Default 'Proxy folder containing config.yaml (or leave blank to use the default port)' $ProxyFolder
  }
  $port = '8317'
  $configPath = Join-Path $ProxyFolder 'config.yaml'
  if (Test-Path $configPath) {
    $match = [regex]::Match([IO.File]::ReadAllText($configPath), '(?m)^  port:\s*(\d+)\s*$')
    if ($match.Success) { $port = $match.Groups[1].Value }
  }
  $localPort = [int](Read-Default 'Local proxy port' $port)
  $remotePort = [int](Read-Default 'Port to discover on other machines' '8317')
  if ($localPort -lt 1 -or $localPort -gt 65535 -or $remotePort -lt 1 -or $remotePort -gt 65535) { throw 'Invalid port.' }
  $candidates = @(Get-Candidates)
  if ((Read-Default 'Also scan a LAN /24 (up to 254 addresses)? y/N' 'N') -eq 'y') {
    $prefix = Read-Host 'LAN prefix, for example 192.168.1'
    if ($prefix -notmatch '^(10\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3})$') { throw 'Use a private IPv4 LAN prefix.' }
    foreach ($part in $prefix.Split('.')) { if ([int]$part -gt 255) { throw 'Invalid prefix.' } }
    $candidates += 1..254 | ForEach-Object { "$prefix.$_" }
  }
  Write-Host "Checking $($candidates.Count) addresses..."
  $found = @(Find-Proxies ($candidates | Sort-Object -Unique) $remotePort)
  for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "$($i + 1). $($found[$i])" }
  $choice = Read-Host 'Select a number, or enter a full http(s)://host:port URL'
  $number = 0
  if ([int]::TryParse($choice, [ref]$number) -and $number -ge 1 -and $number -le $found.Count) { $choice = $found[$number - 1] }
  $uri = [uri]$choice
  if (!$uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Enter a root HTTP(S) URL without credentials or a path.' }
  $localAddresses = @(Get-NetIPAddress | Select-Object -ExpandProperty IPAddress) + @('127.0.0.1', '::1')
  $resolved = @([Net.Dns]::GetHostAddresses($uri.DnsSafeHost) | ForEach-Object { $_.ToString() })
  if ($resolved | Where-Object { $_ -in $localAddresses }) { throw 'Choose another machine to avoid forwarding loops.' }
  $url = $uri.AbsoluteUri.TrimEnd('/')
  Write-Host 'The source must allow LAN access. Use its client API key, not its management key.'
  $key = Read-Key 'Source client API key'
  $catalog = Invoke-RestMethod "$url/v1/models" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
  $models = @($catalog.data | ForEach-Object { $_.id } | Where-Object { $_ -is [string] -and $_ })
  if (!$models.Count) { throw 'Source returned no models.' }
  $management = Read-Key 'Local management key'
  $headers = @{ Authorization = "Bearer $management" }
  $api = "http://127.0.0.1:$localPort/v8/management"
  $config = Invoke-RestMethod "$api/config" -Headers $headers -TimeoutSec 10
  $groups = @($config.'api-keys'.'openai-compatibility' | Where-Object { $null -ne $_ })
  $next = @($groups | Where-Object { $_.name -ne 'network-main' }) + @(New-Upstream $url $key $models)
  Write-Host "Ready: $url with $($models.Count) main/ aliases. Other providers remain unchanged."
  if ((Read-Host 'Type APPLY to save (replaces any existing network-main provider)') -cne 'APPLY') { return }
  # Recheck immediately before mutation to avoid overwriting edits made during the prompts.
  $fresh = Invoke-RestMethod "$api/config" -Headers $headers -TimeoutSec 10
  if (($fresh.'api-keys' | ConvertTo-Json -Depth 100 -Compress) -cne ($config.'api-keys' | ConvertTo-Json -Depth 100 -Compress)) { throw 'Configuration changed. Run again.' }
  $body = ConvertTo-Json -InputObject @($next) -Depth 100
  Invoke-RestMethod "$api/config/api-keys/openai-compatibility" -Method Put -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
  Write-Host 'Saved. Select a main/<model> model in your client. Rerun to switch source or refresh models.'
} catch {
  # Avoid printing HTTP response bodies, which may contain credentials.
  Write-Host "Setup failed: $($_.Exception.GetType().Name). Check addresses, keys, local v8 support and network access."
  exit 1
}

