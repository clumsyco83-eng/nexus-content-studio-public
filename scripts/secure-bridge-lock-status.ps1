[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'The Secure Bridge lock inspector is intentionally Windows-only.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $RepoRoot
try {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'node.exe is not available in PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\tsx') -PathType Container)) {
        throw 'tsx is not installed in node_modules. Run the verified dependency install/laptop gate first.'
    }

    & node.exe --import tsx src/orchestration/secure-bridge-lock-status.ts
    $code = $LASTEXITCODE
    if ($code -eq 2) {
        Write-Warning 'A Secure Bridge cycle lock is present. Do not delete it or start another cycle until the owning process/task evidence has been inspected.'
        exit 2
    }
    if ($code -ne 0) { throw "Secure Bridge lock inspection failed with exit code $code." }
}
finally {
    Pop-Location
}
