$ErrorActionPreference = 'Stop'
$workspace = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$destination = Join-Path $env:LOCALAPPDATA 'CLIProxyManagementLauncher'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-Server.ps1') -Destination $destination -Force
@($workspace, (Get-Command bun).Source) | Set-Content -LiteralPath (Join-Path $destination 'workspace.txt')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icon = Join-Path $destination 'server.ico'
$desktopApp = Join-Path $env:USERPROFILE 'Downloads\EasyCLIProxyAPI-v0.3.51-Windows-amd64\EasyCLIProxyAPI-v0.3.51-Windows-amd64\EasyCLIProxyAPI.exe'
Add-Type -AssemblyName System.Drawing
$iconArgs = @()
if (Test-Path -LiteralPath $desktopApp) {
  $image = [System.Drawing.Icon]::ExtractAssociatedIcon($desktopApp)
  $stream = [System.IO.File]::Create($icon)
  try { $image.Save($stream) } finally { $stream.Dispose(); $image.Dispose() }
  $iconArgs = @("/win32icon:$icon")
}
$executable = Join-Path $destination 'CLI Proxy Server.exe'
& $compiler /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$executable" @iconArgs (Join-Path $PSScriptRoot 'ServerLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))) {
  $shortcut = $shell.CreateShortcut((Join-Path $folder 'CLI Proxy Server.lnk'))
  $shortcut.TargetPath = $executable
  $shortcut.WorkingDirectory = $destination
  $shortcut.Description = 'Start CLI Proxy Management Center and open Capacity forecast'
  $shortcut.IconLocation = "$executable,0"
  $shortcut.Save()
}
Write-Output "Launcher installed: $executable"
Start-Process -FilePath $executable -WindowStyle Hidden
