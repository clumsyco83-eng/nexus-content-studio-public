[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'nexus.verification.run',
        'nexus.intelligence-foundation.complete',
        'nexus.claude.live-readiness'
    )]
    [string]$Capability
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Exit-StageFailure {
    param([Parameter(Mandatory = $true)][ValidateRange(1,255)][int]$Code)
    exit $Code
}

function Invoke-NpmStage {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][ValidateRange(1,255)][int]$FailureCode
    )
    & npm.cmd @Arguments *> $null
    if ($LASTEXITCODE -ne 0) { Exit-StageFailure -Code $FailureCode }
}

function Invoke-NodeStage {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][ValidateRange(1,255)][int]$FailureCode,
        [switch]$PassOutput
    )
    if ($PassOutput) {
        & node.exe @Arguments
    }
    else {
        & node.exe @Arguments *> $null
    }
    if ($LASTEXITCODE -ne 0) { Exit-StageFailure -Code $FailureCode }
}

function Invoke-PowerShellStage {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][ValidateRange(1,255)][int]$FailureCode
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { Exit-StageFailure -Code $FailureCode }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments *> $null
    if ($LASTEXITCODE -ne 0) { Exit-StageFailure -Code $FailureCode }
}

function Resolve-VerifiedPackage {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][ValidateRange(1,255)][int]$FailureCode
    )

    try {
        if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid internal package digest.' }
        $candidates = @((Join-Path $RepoRoot $FileName))
        if ($env:USERPROFILE) {
            $candidates += @(
                (Join-Path $env:USERPROFILE "Downloads\$FileName"),
                (Join-Path $env:USERPROFILE "Desktop\$FileName"),
                (Join-Path $env:USERPROFILE "Documents\$FileName")
            )
        }

        foreach ($candidate in $candidates) {
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -eq $ExpectedSha256) { return (Resolve-Path -LiteralPath $candidate).Path }
        }

        foreach ($root in @('C:\NEXUS-WORK', 'D:\NEXUS-MASTER-ARCHIVE', 'V:\NEXUS')) {
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
            $found = @(Get-ChildItem -LiteralPath $root -Filter $FileName -File -Recurse -ErrorAction SilentlyContinue)
            foreach ($file in $found) {
                $actual = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -eq $ExpectedSha256) { return $file.FullName }
            }
        }
    }
    catch {}

    Exit-StageFailure -Code $FailureCode
}

Push-Location $RepoRoot
try {
    switch ($Capability) {
        'nexus.verification.run' {
            # Failure-code contract intentionally reveals only the failed fixed stage,
            # never raw verifier output or environment/secret material.
            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -Arguments @('-SkipInstall') -FailureCode 61
            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'windows-secure-bridge-verify.ps1') -FailureCode 62
            Invoke-NpmStage -Arguments @('run','verify:powershell-broker') -FailureCode 63
            [pscustomobject]@{
                ok = $true
                capability = $Capability
                action = 'laptop-verification-no-install'
                installPerformed = $false
            } | ConvertTo-Json -Compress
            exit 0
        }

        'nexus.intelligence-foundation.complete' {
            $expectedHash = 'a4b546a141b8c9f163a84c607a9bc9210c39aa9a87b86aba20ce00311a01eba6'
            $zip = Resolve-VerifiedPackage -FileName 'nexus-intelligence-foundation-v1.0.0.zip' -ExpectedSha256 $expectedHash -FailureCode 71
            $skillsRoot = Join-Path $RepoRoot '.claude\skills'

            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'install-intelligence-foundation.ps1') -Arguments @('-ZipPath', $zip) -FailureCode 72
            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authoring.ps1') -Arguments @('-Profile','IntelligenceFoundation','-SkillsRoot',$skillsRoot) -FailureCode 73
            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1') -Arguments @('-SkillsRoot',$skillsRoot) -FailureCode 74
            Invoke-NpmStage -Arguments @('run','check') -FailureCode 75
            Invoke-NpmStage -Arguments @('run','verify:claude-skill-admission') -FailureCode 76
            Invoke-NpmStage -Arguments @('run','verify:intelligence-routing') -FailureCode 77
            Invoke-NpmStage -Arguments @('run','verify:capabilities') -FailureCode 78
            Invoke-NpmStage -Arguments @('run','verify:stuck') -FailureCode 79
            Invoke-NpmStage -Arguments @('run','verify:openai-strategy') -FailureCode 80
            Invoke-NpmStage -Arguments @('run','verify:system') -FailureCode 81
            Invoke-PowerShellStage -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -Arguments @('-SkipInstall') -FailureCode 82

            [pscustomobject]@{
                ok = $true
                capability = $Capability
                packageSha256 = $expectedHash
                deterministicHostGate = 'PASS'
                liveClaudeRoutingStillRequired = $true
            } | ConvertTo-Json -Compress
            exit 0
        }

        'nexus.claude.live-readiness' {
            # The TypeScript helper prints only bounded non-secret readiness evidence.
            Invoke-NodeStage -Arguments @('--import','tsx','src/testing/secure-claude-live-readiness.ts') -FailureCode 91 -PassOutput
            exit 0
        }
    }
}
finally {
    Pop-Location
}
