[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This Secure Bridge cycle-lock verification is intentionally Windows-only.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $RepoRoot
try {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'node.exe is not available in PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\tsx') -PathType Container)) {
        throw 'tsx is not installed in node_modules.'
    }

    & node.exe --import tsx src/testing/secure-bridge-lock.ts
    if ($LASTEXITCODE -ne 0) { throw "Secure Bridge cycle-lock regression failed with exit code $LASTEXITCODE." }

    foreach ($relative in @(
        'scripts\run-secure-bridge-cycle.ps1',
        'scripts\secure-bridge-lock-status.ps1',
        'scripts\windows-secure-bridge-lock-verify.ps1'
    )) {
        $path = (Resolve-Path (Join-Path $RepoRoot $relative)).Path
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        if ($errors.Count -gt 0) {
            throw "$relative failed Windows PowerShell parser validation: $((($errors | ForEach-Object { $_.Message }) -join '; '))"
        }
    }

    $runner = Get-Content -LiteralPath (Join-Path $RepoRoot 'src\orchestration\secure-bridge-locked-cli.ts') -Raw
    if ($runner -notmatch 'acquireSecureBridgeCycleLock') { throw 'Locked Secure Bridge entry point does not acquire the cycle lock.' }
    if ($runner -notmatch 'finally') { throw 'Locked Secure Bridge entry point does not contain a finally release path.' }

    $lock = Get-Content -LiteralPath (Join-Path $RepoRoot 'src\orchestration\secure-bridge-lock.ts') -Raw
    if ($lock -match 'kill\(|taskkill|Stop-Process|process\.kill') {
        throw 'Cycle-lock layer must not infer stale ownership by killing processes.'
    }
    if ($lock -notmatch "open\(filePath, 'wx'") { throw 'Cycle-lock acquisition is not using exclusive file creation.' }
    if ($lock -notmatch 'refusing to delete another owner lock') { throw 'Cycle-lock release lacks ownership-safe refusal evidence.' }

    Write-Host 'PASS Secure Bridge Windows cycle-lock verification: exclusive cross-process lock, fail-closed stale/malformed handling, ownership-safe release, locked runner, and PowerShell wrappers.' -ForegroundColor Green
}
finally {
    Pop-Location
}
