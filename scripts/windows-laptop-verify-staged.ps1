[CmdletBinding()]
param(
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-ValidationFailureCode {
    param([Parameter(Mandatory = $true)][string]$Text)

    if ($Text -match 'Temporary dashboard did not become healthy') { return 130 }
    if ($Text -match 'Authenticated /api/goals did not return') { return 131 }
    if ($Text -match 'Authenticated /api/goal-approvals did not return') { return 132 }
    if ($Text -match 'Unauthenticated /api/goal-approvals request was not rejected') { return 133 }
    if ($Text -match 'Watchdog report was not created|Watchdog heartbeat was not healthy|Watchdog attempted an unexpected recovery action') { return 136 }

    $stageCodes = @{
        'Claude project runtime safety policy' = 102
        'Claude Skill authority boundary self-test' = 103
        'Installed Claude Skill runtime-authority boundary' = 104
        'TypeScript check' = 105
        'Production model promotion evidence rules' = 106
        'Claude runtime identity and usage evidence contract' = 107
        'Claude runtime attestation and automatic capability degradation' = 108
        'Per-task Claude tool, MCP and Skill envelope' = 109
        'READY capability-backed Claude Skill admission' = 110
        'Bounded Secure Bridge Claude executor' = 111
        'Capability readiness verification' = 112
        'Capability evidence drift/expiry invalidation' = 113
        'Preview-first capability evidence recorder' = 114
        'Persistent Goal Engine verification' = 115
        'Fingerprint-bound Goal task approval verification' = 116
        'NEXUS emergency stop verification' = 117
        'Deterministic Goal task Verifier verification' = 118
        'Stuck/dead-loop detector verification' = 119
        'Persistent diagnostics and bounded replan verification' = 120
        'Deterministic automatic resume verification' = 121
        'Deterministic NEXUS runtime cycle verification' = 122
        'Semantic Secure Bridge runtime integration verification' = 123
        'Persistent goal dashboard verification' = 124
        'Deterministic collaboration-loop acceptance' = 125
        'OpenAI strategy adapter verification (mock transport, no secret/network)' = 126
        'SQLite durable-store verification' = 127
        'Configured NEXUS system verification' = 128
        'JSON rollback-path verification' = 129
        'Guardian report' = 134
        'Watchdog one-shot heartbeat' = 135
    }

    $markers = [regex]::Matches($Text, '(?m)^=== (.+?) ===\s*$')
    if ($markers.Count -eq 0) { return 101 }

    $lastName = $markers[$markers.Count - 1].Groups[1].Value.Trim()
    if ($lastName -eq 'JSON rollback-path verification' -and $Text -match 'PASS JSON rollback-path verification') {
        return 130
    }
    if ($lastName -eq 'Watchdog one-shot heartbeat' -and $Text -match 'PASS Watchdog one-shot heartbeat') {
        return 136
    }
    if ($stageCodes.ContainsKey($lastName)) { return [int]$stageCodes[$lastName] }
    return 160
}

function Invoke-CapturedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can surface a native child's stderr as an
        # ErrorRecord when streams are merged. The parent wrapper must capture
        # that diagnostic text without allowing it to terminate classification.
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
        @{ Text = 'bootstrap failure'; Code = 101 },
        @{ Text = "=== TypeScript check ===`nTypeScript check failed"; Code = 105 },
        @{ Text = "=== JSON rollback-path verification ===`nPASS JSON rollback-path verification`nTemporary dashboard did not become healthy"; Code = 130 },
        @{ Text = "=== JSON rollback-path verification ===`nPASS JSON rollback-path verification`nAuthenticated /api/goals did not return the expected read-only goal dashboard envelope."; Code = 131 },
        @{ Text = "=== Guardian report ===`nGuardian report failed"; Code = 134 },
        @{ Text = "=== Watchdog one-shot heartbeat ===`nPASS Watchdog one-shot heartbeat`nWatchdog report was not created"; Code = 136 }
    )
    foreach ($case in $cases) {
        $actual = Resolve-ValidationFailureCode -Text ([string]$case.Text)
        if ($actual -ne [int]$case.Code) {
            throw "Staged verifier self-test mismatch. expected=$($case.Code) actual=$actual"
        }
    }

    if (Test-Path -LiteralPath $powerShell -PathType Leaf) {
        $probe = Invoke-CapturedPowerShell -PowerShellPath $powerShell -Arguments @(
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "[Console]::Error.WriteLine('nexus-staged-stderr-probe'); exit 7"
        )
        if ($probe.ExitCode -ne 7) {
            throw "Native stderr capture self-test lost the child exit code. expected=7 actual=$($probe.ExitCode)"
        }
        if ((@($probe.Output) -join "`n") -notmatch 'nexus-staged-stderr-probe') {
            throw 'Native stderr capture self-test did not retain the bounded diagnostic marker.'
        }
    }

    Write-Host 'PASS staged Windows laptop verifier failure-code mapping and native stderr capture.'
    exit 0
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verifier = Join-Path $PSScriptRoot 'windows-laptop-verify.ps1'

if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) { exit 100 }
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { exit 100 }
if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { exit 100 }

try {
    $run = Invoke-CapturedPowerShell -PowerShellPath $powerShell -Arguments @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $verifier,
        '-SkipInstall'
    )
}
catch {
    exit 100
}

if ($run.ExitCode -eq 0) { exit 0 }

$text = @($run.Output) -join "`n"
$code = Resolve-ValidationFailureCode -Text $text
exit $code
