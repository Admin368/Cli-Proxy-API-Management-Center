param(
  [ValidatePattern('^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$')]
  [string]$Domain = 'local.cli',
  [ValidateRange(1024, 65535)]
  [int]$Port = 5173,
  [switch]$SkipHosts
)

$ErrorActionPreference = 'Stop'
$proxyRoot = Join-Path $env:LOCALAPPDATA 'LocalDevProxy'
$binDir = Join-Path $proxyRoot 'bin'
$sitesDir = Join-Path $proxyRoot 'sites'
$caddyExe = Join-Path $binDir 'caddy.exe'
$configPath = Join-Path $proxyRoot 'Caddyfile'
New-Item -ItemType Directory -Force -Path $binDir, $sitesDir | Out-Null

if (!(Test-Path -LiteralPath $caddyExe)) {
  # Official release plus published SHA-512; nothing is installed into the repository.
  $release = Invoke-RestMethod 'https://api.github.com/repos/caddyserver/caddy/releases/latest'
  $archive = $release.assets | Where-Object name -Match '_windows_amd64.zip$'
  $checksums = $release.assets | Where-Object name -Match '_checksums.txt$'
  if (!$archive -or !$checksums) { throw 'Official Caddy release assets are missing.' }
  $archivePath = Join-Path $proxyRoot $archive.name
  Invoke-WebRequest $archive.browser_download_url -OutFile $archivePath
  $checksumText = (Invoke-WebRequest $checksums.browser_download_url).Content
  if ($checksumText -is [byte[]]) { $checksumText = [Text.Encoding]::UTF8.GetString($checksumText) }
  $checksumLine = ($checksumText -split "`n") | Where-Object { $_ -match ([regex]::Escape($archive.name) + '$') }
  $expectedHash = ($checksumLine.Trim() -split '\s+')[0]
  if (!$expectedHash -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA512).Hash -ne $expectedHash) {
    throw 'Caddy archive checksum verification failed.'
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $binDir -Force
}

if (!(Test-Path -LiteralPath $configPath)) {
  @'
{
  admin 127.0.0.1:2020
  auto_https off
}
import sites/*.caddy
'@ | Set-Content -LiteralPath $configPath -Encoding utf8
}

# One route per app. The shared listener is reachable only from this machine.
$sitePath = Join-Path $sitesDir "$Domain.caddy"
@"
http://$Domain {
  bind 127.0.0.1
  reverse_proxy 127.0.0.1:$Port
}
"@ | Set-Content -LiteralPath $sitePath -Encoding utf8
& $caddyExe validate --config $configPath --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration validation failed.' }

$startScript = Join-Path $proxyRoot 'Start-LocalDevProxy.ps1'
@'
$ErrorActionPreference = 'Stop'
$proxyRoot = $PSScriptRoot
$caddyExe = Join-Path $proxyRoot 'bin\caddy.exe'
$configPath = Join-Path $proxyRoot 'Caddyfile'
$existing = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $caddyExe }
if ($existing) {
  & $caddyExe reload --config $configPath --adapter caddyfile --address 127.0.0.1:2020
  if ($LASTEXITCODE -ne 0) { throw 'Caddy reload failed.' }
} else {
  $routerProcess = Start-Process -FilePath $caddyExe -ArgumentList @('run', '--config', "`"$configPath`"", '--adapter', 'caddyfile') -WorkingDirectory $proxyRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $proxyRoot 'stdout.log') -RedirectStandardError (Join-Path $proxyRoot 'stderr.log') -PassThru
  Start-Sleep -Milliseconds 500
  if ($routerProcess.HasExited) { throw "Caddy exited. Inspect $proxyRoot\stderr.log (ports 80 and 2020 may be occupied)." }
}
'@ | Set-Content -LiteralPath $startScript -Encoding utf8
& $startScript

# A per-user logon shortcut keeps the shared router available after a reboot.
$startupPath = [Environment]::GetFolderPath('Startup')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startupPath 'LocalDevProxy.lnk'))
$shortcut.TargetPath = (Get-Process -Id $PID).Path
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$shortcut.WindowStyle = 7
$shortcut.Save()

if (!$SkipHosts) {
  $hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
  $hostsText = Get-Content -LiteralPath $hostsPath -Raw
  $activeLines = ($hostsText -split "`n") | ForEach-Object { ($_ -split '#')[0].Trim() }
  $existingLines = $activeLines | Where-Object { ($_ -split '\s+' | Select-Object -Skip 1) -contains $Domain }
  if ($existingLines -and ($existingLines | Where-Object { ($_ -split '\s+')[0] -ne '127.0.0.1' })) {
    throw "$Domain already maps elsewhere in hosts. Resolve that entry before continuing."
  }
  if (!$existingLines) {
    try {
      Add-Content -LiteralPath $hostsPath -Value "`r`n127.0.0.1 $Domain # LocalDevProxy" -Encoding ascii
    } catch {
      throw "Router is ready, but hosts registration requires Administrator PowerShell. Run: Add-Content -LiteralPath '$hostsPath' -Value '127.0.0.1 $Domain # LocalDevProxy'"
    }
  }
}
Write-Output "Ready: http://$Domain -> http://127.0.0.1:$Port"
Write-Output "Routes: $sitesDir. Re-run with -Domain local.example -Port 3000 for another app."
if ($SkipHosts) { Write-Warning "Hostname registration was skipped; add 127.0.0.1 $Domain to hosts as Administrator." }
