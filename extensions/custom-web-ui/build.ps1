$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
 $env:CGO_ENABLED='1'
 go test -count=1 ./...
 if ($LASTEXITCODE -ne 0) { throw 'Controller tests failed' }
 New-Item -ItemType Directory -Force bin | Out-Null
 go build -trimpath -buildmode=c-shared -o bin/custom-web-ui.dll .
 if ($LASTEXITCODE -ne 0) { throw 'DLL build failed' }
 python -m unittest seed_history_test.py
 if ($LASTEXITCODE -ne 0) { throw 'Quota recovery tests failed' }
 python abi_test.py
 if ($LASTEXITCODE -ne 0) { throw 'Native ABI tests failed' }
} finally { Pop-Location }
