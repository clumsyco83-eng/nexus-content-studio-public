[CmdletBinding()]
param(
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-SecureBridgeFailureCode {
    param([Parameter(Mandatory = $true)][string]$Text)

    if ($Text -match 'Secure Bridge verification dashboard did not become healthy') { return 167 }
    if ($Text -match 'Authenticated /api/goal-approvals did not return') { return 168 }
    if ($Text -match 'Goal approval API accepted an unauthenticated request') { return 169 }

    $stageCodes = @{
        'Bounded Secure Bridge Claude executor' = 162
        'Fingerprint-bound Goal task approvals' = 163
        'NEXUS emergency stop' = 164
        'Deterministic Goal task Verifier' = 165
        'Semantic Secure Bridge runtime integration' = 166
    }

    $markers = [regex]::Matches($Text, '(?m)^=== (.+?) ===\s*$')
    if ($markers.Count -eq 0) { return 161 }

    $lastName = $markers[$markers.Count - 1].Groups[1].Value.Trim()
    if ($lastName -eq 'Semantic Secure Bridge runtime integration' -and $Text -match 'PASS Semantic Secure Bridge runtime integration') {
        return 170
    }
    if ($stageCodes.ContainsKey($lastName)) { return [int]$stageCodes[$lastName] }
    return 170
}

function Invoke-CapturedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $captured = @(
            & $PowerShellPath @Arguments 2>&1 |
                ForEach-Object { [string]$_ }
        )
        return [pscustomobject]@{
            ExitCode = [int]$LASTEXITCODE
            Output = @($captured)
        }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

$windowsRoot = if ($env:SystemRoot) { $env:SystemRoot } elseif ($env:WINDIR) { $env:WINDIR } else { 'C:\Windows' }
$powerShell = Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if ($SelfTest) {
    $cases = @(
        @{ Text = 'bootstrap failure'; Code = 161 },
        @{ Text = "=== Bounded Secure Bridge Claude executor ===`nfailed"; Code = 162 },
        @{ Text = "=== Fingerprint-bound Goal task approvals ===`nfailed"; Code = 163 },
        @{ Text = "=== NEXUS emergency stop ===`nfailed"; Code = 164 },
        @{ Text = "=== Deterministic Goal task Verifier ===`nfailed"; Code = 165 },
        @{ Text = "=== Semantic Secure Bridge runtime integration ===`nfailed"; Code = 166 },
        @{ Text = "=== Semantic Secure Bridge runtime integration ===`nPASS Semantic Secure Bridge runtime integration`nSecure Bridge verification dashboard did not become healthy."; Code = 167 },
        @{ Text = "=== Semantic Secure Bridge runtime integration ===`nPASS Semantic Secure Bridge runtime integration`nAuthenticated /api/goal-approvals did not return an approvals collection."; Code = 168 },
        @{ Text = "=== Semantic Secure Bridge runtime integration ===`nPASS Semantic Secure Bridge runtime integration`nGoal approval API accepted an unauthenticated request."; Code = 169 },
        @{ Text = "=== Semantic Secure Bridge runtime integration ===`nPASS Semantic Secure Bridge runtime integration`nunexpected post-stage failure"; Code = 170 }
    )

    foreach ($case in $cases) {
        $actual = Resolve-SecureBridgeFailureCode -Text ([string]$case.Text)
        if ($actual -ne [int]$case.Code) {
            throw "Secure Bridge staged verifier self-test mismatch. expected=$($case.Code) actual=$actual"
        }
    }

    Write-Host 'PASS staged Secure Bridge Windows addendum failure-code mapping.'
    exit 0
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verifier = Join-Path $PSScriptRoot 'windows-secure-bridge-verify.ps1'

if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) { exit 161 }
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { exit 161 }
if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { exit 161 }

try {
    $run = Invoke-CapturedPowerShell -PowerShellPath $powerShell -Arguments @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $verifier
    )
}
catch {
    exit 161
}

if ($run.ExitCode -eq 0) { exit 0 }

$text = @($run.Output) -join "`n"
exit (Resolve-SecureBridgeFailureCode -Text $text)
