[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'The live Secure Bridge cycle wrapper is intentionally Windows-only.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $RepoRoot
try {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'node.exe is not available in PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\tsx') -PathType Container)) {
        throw 'tsx is not installed in node_modules. Run the verified dependency install/laptop gate first.'
    }

    & node.exe --import tsx src/orchestration/secure-bridge-locked-cli.ts
    if ($LASTEXITCODE -ne 0) {
        throw "Locked Secure Bridge cycle failed with exit code $LASTEXITCODE. Do not bypass the cycle lock or start a second cycle."
    }
}
finally {
    Pop-Location
}
