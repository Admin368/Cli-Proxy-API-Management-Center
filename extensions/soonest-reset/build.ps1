$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  $env:CGO_ENABLED = '1'
  go test ./...
  if ($LASTEXITCODE -ne 0) { throw 'Plugin tests failed' }
  New-Item -ItemType Directory -Force bin | Out-Null
  go build -trimpath -buildmode=c-shared -o bin/soonest-reset.dll .
  if ($LASTEXITCODE -ne 0) { throw 'DLL build failed' }
  python abi_test.py
  if ($LASTEXITCODE -ne 0) { throw 'Native ABI tests failed' }
  Push-Location integration
  try {
    go test -count=1 -v ./...
    if ($LASTEXITCODE -ne 0) { throw 'Core affinity integration tests failed' }
  } finally { Pop-Location }
} finally { Pop-Location }
