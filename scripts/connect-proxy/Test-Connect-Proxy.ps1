# Run with powershell -NoProfile -File scripts/connect-proxy/Test-Connect-Proxy.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\Connect-Proxy.ps1" -LibraryOnly
$result = New-Upstream 'http://100.64.0.2:8317' 'test-placeholder' @('model-a', 'model-a', 'model-b')
if ($result.models.Count -ne 2) { throw 'Models must be deduplicated.' }
if ($result.models[0].alias -ne 'main/model-a') { throw 'Explicit routing alias missing.' }
if ($result.'base-url' -ne 'http://100.64.0.2:8317/v1') { throw 'Incorrect upstream URL.' }
if ($result.keys[0].'api-key' -ne 'test-placeholder') { throw 'Incorrect v8 key shape.' }
$json = ConvertTo-Json -InputObject @($result) -Depth 100
if (!$json.StartsWith('[')) { throw 'Single provider must remain an array.' }
Write-Host 'Upstream serialization checks passed.'
