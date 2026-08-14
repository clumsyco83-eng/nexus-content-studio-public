param(
    [switch]$SelfTest,
    [switch]$RunLaptopVerification,
    [string]$IntelligenceZipPath,
    [string]$BusinessZipPath,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedIntelligenceZipSha256 = 'a4b546a141b8c9f163a84c607a9bc9210c39aa9a87b86aba20ce00311a01eba6'
$ExpectedBusinessZipSha256 = '183fc7c5fd5d3e82cc2118621f5b84e99ce743c0cd00c4b3cb7afcf00d33f3b6'

$VerifiedBridgeCommits = [ordered]@{
    '19b8038' = 'NEXUS Secure Bridge V1.1 controller provider-error diagnostics hardened'
    'c336f44' = 'NEXUS Secure Bridge V1.2 controlled orchestration verified'
    'f6f91bb' = 'NEXUS Secure Bridge V1.3 remote job trigger verified'
    'e33bfe4' = 'NEXUS Secure Bridge: bounded Claude job enablement verified'
    '22aefd5' = 'NEXUS Verifier deterministic acceptance criteria hardened'
}

$RequiredFiles = @(
    'scripts/reconcile-secure-bridge-v13.ps1',
    'scripts/complete-intelligence-foundation.ps1',
    'scripts/complete-core-specialist-promotion.ps1',
    'scripts/smoke-claude-live.ps1',
    'scripts/complete-business-intelligence-profile.ps1',
    'scripts/audit-runtime-readiness.ps1',
    'scripts/windows-laptop-verify.ps1',
    'million-dollar-project/REAL-HOST-COMPLETION-RUNBOOK.md'
)

function New-Check {
    param(
        [string]$Name,
        [ValidateSet('PASS', 'BLOCKED', 'INFO', 'WARN')][string]$Status,
        [string]$Detail
    )
    [pscustomobject]@{
        name = $Name
        status = $Status
        detail = $Detail
    }
}

function Test-CommandAvailable {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Normalize-PathText {
    param([string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Invoke-GitText {
    param([string[]]$Arguments)
    $output = & git @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
    return (($output | Out-String).Trim())
}

function Test-GitCommitObject {
    param([string]$Commit)
    & git cat-file -e "$Commit^{commit}" 2>$null
    return $LASTEXITCODE -eq 0
}

function Test-ZipHash {
    param(
        [string]$Path,
        [string]$ExpectedSha256,
        [string]$Label
    )
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return New-Check $Label 'INFO' 'Path not supplied; this package is not required until its later real-host gate.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return New-Check $Label 'BLOCKED' 'Supplied package path does not exist.'
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) {
        return New-Check $Label 'BLOCKED' "SHA-256 mismatch. Expected $ExpectedSha256; supplied file does not match the pinned package."
    }
    return New-Check $Label 'PASS' "Pinned SHA-256 verified: $ExpectedSha256"
}

function Env-IsPresent {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    return -not [string]::IsNullOrWhiteSpace($value)
}

function Write-HumanReport {
    param(
        [object[]]$Checks,
        [string]$NextGate,
        [string]$NextCommand,
        [bool]$ReadyForNextGate
    )
    Write-Host ''
    Write-Host 'NEXUS Million-Dollar Priority Completion — read-only preflight'
    Write-Host '================================================================'
    foreach ($check in $Checks) {
        Write-Host ("[{0}] {1}: {2}" -f $check.status, $check.name, $check.detail)
    }
    Write-Host ''
    Write-Host ("Ready for next gate: {0}" -f $ReadyForNextGate)
    Write-Host ("Next gate: {0}" -f $NextGate)
    if (-not [string]::IsNullOrWhiteSpace($NextCommand)) {
        Write-Host 'Next command:'
        Write-Host $NextCommand
    }
    Write-Host ''
    Write-Host 'This preflight does not install skills, reconcile commits, call providers, spend money, publish, change credentials, or enable Computer Agent authority.'
}

if ($SelfTest) {
    if ($VerifiedBridgeCommits.Count -ne 5) { throw 'Self-test failed: expected exactly five verified bridge commits.' }
    foreach ($commit in $VerifiedBridgeCommits.Keys) {
        if ($commit -notmatch '^[a-f0-9]{7}$') { throw "Self-test failed: invalid verified bridge short SHA $commit." }
    }
    if ($ExpectedIntelligenceZipSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Self-test failed: Intelligence Foundation SHA-256 is invalid.' }
    if ($ExpectedBusinessZipSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Self-test failed: Business Profile SHA-256 is invalid.' }
    if ($RequiredFiles.Count -lt 8) { throw 'Self-test failed: required completion file set is incomplete.' }
    $requiredNames = @(
        'reconcile-secure-bridge-v13.ps1',
        'complete-intelligence-foundation.ps1',
        'complete-core-specialist-promotion.ps1',
        'smoke-claude-live.ps1',
        'complete-business-intelligence-profile.ps1',
        'audit-runtime-readiness.ps1',
        'windows-laptop-verify.ps1',
        'REAL-HOST-COMPLETION-RUNBOOK.md'
    )
    foreach ($name in $requiredNames) {
        if (-not ($RequiredFiles | Where-Object { $_ -like "*$name" })) {
            throw "Self-test failed: required completion file missing from manifest: $name"
        }
    }
    $normalized = Normalize-PathText (Join-Path ([System.IO.Path]::GetTempPath()) 'nexus-preflight-test')
    if ([string]::IsNullOrWhiteSpace($normalized)) { throw 'Self-test failed: path normalization returned an empty path.' }
    Write-Host 'PASS priority-completion-preflight self-test: five verified bridge commits, pinned package hashes, canonical completion helpers, and Windows path normalization are encoded without mutation/provider execution.'
    exit 0
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Normalize-PathText (Join-Path $scriptRoot '..')
$checks = New-Object System.Collections.Generic.List[object]

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    $checks.Add((New-Check 'Repository' 'BLOCKED' 'Run this script from the real Git checkout; .git was not found beside the project root.'))
    $result = [pscustomobject]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        mode = 'read-only-preflight'
        readyForNextGate = $false
        nextGate = 'Gate 0 — locate real repository checkout'
        nextCommand = ''
        checks = $checks
    }
    if ($Json) { $result | ConvertTo-Json -Depth 6 } else { Write-HumanReport $checks $result.nextGate $result.nextCommand $false }
    exit 2
}

Push-Location $repoRoot
try {
    foreach ($tool in @('git', 'node', 'npm', 'powershell', 'claude')) {
        if (Test-CommandAvailable $tool) {
            $checks.Add((New-Check "Tool: $tool" 'PASS' 'Available on PATH.'))
        } else {
            $checks.Add((New-Check "Tool: $tool" 'BLOCKED' 'Required real-host tool is not available on PATH.'))
        }
    }

    foreach ($relative in $RequiredFiles) {
        $full = Join-Path $repoRoot $relative
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $checks.Add((New-Check "File: $relative" 'PASS' 'Present.'))
        } else {
            $checks.Add((New-Check "File: $relative" 'BLOCKED' 'Missing from this checkout; sync the canonical repository without overwriting verified local bridge history.'))
        }
    }

    if (Test-CommandAvailable 'git') {
        try {
            $top = Normalize-PathText (Invoke-GitText @('rev-parse', '--show-toplevel'))
            if ($top -eq $repoRoot) {
                $checks.Add((New-Check 'Git root' 'PASS' 'Script is running from the expected repository root.'))
            } else {
                $checks.Add((New-Check 'Git root' 'BLOCKED' 'Git reports a different repository root.'))
            }

            $status = Invoke-GitText @('status', '--porcelain=v1')
            if ([string]::IsNullOrWhiteSpace($status)) {
                $checks.Add((New-Check 'Worktree' 'PASS' 'Clean; no local mutation is required by this preflight.'))
            } else {
                $checks.Add((New-Check 'Worktree' 'BLOCKED' 'Uncommitted/untracked changes exist. Stop and identify them before reconciliation or installers.'))
            }

            $branch = Invoke-GitText @('branch', '--show-current')
            if ([string]::IsNullOrWhiteSpace($branch)) { $branch = '(detached HEAD)' }
            $checks.Add((New-Check 'Current branch' 'INFO' $branch))

            try {
                [void](Invoke-GitText @('remote', 'get-url', 'origin'))
                $checks.Add((New-Check 'Origin remote' 'PASS' 'Configured. URL intentionally not printed to avoid exposing embedded credentials.'))
            } catch {
                $checks.Add((New-Check 'Origin remote' 'BLOCKED' 'origin is not configured or cannot be read.'))
            }

            $bridgeMissing = New-Object System.Collections.Generic.List[string]
            foreach ($commit in $VerifiedBridgeCommits.Keys) {
                if (Test-GitCommitObject $commit) {
                    $checks.Add((New-Check "Bridge commit $commit" 'PASS' $VerifiedBridgeCommits[$commit]))
                } else {
                    $bridgeMissing.Add($commit)
                    $checks.Add((New-Check "Bridge commit $commit" 'BLOCKED' 'Verified local commit object not found. Do not recreate it from guesses or pull/rebase away the old checkout before recovering it.'))
                }
            }
            if ($bridgeMissing.Count -eq 0) {
                $checks.Add((New-Check 'Verified bridge chain' 'PASS' 'All five exact local commit objects are present for issue #10 preservation/reconciliation.'))
            }
        } catch {
            $checks.Add((New-Check 'Git inspection' 'BLOCKED' $_.Exception.Message))
        }
    }

    $checks.Add((Test-ZipHash -Path $IntelligenceZipPath -ExpectedSha256 $ExpectedIntelligenceZipSha256 -Label 'Intelligence Foundation package'))
    $checks.Add((Test-ZipHash -Path $BusinessZipPath -ExpectedSha256 $ExpectedBusinessZipSha256 -Label 'Business Intelligence package'))

    $openAiNames = @(
        'OPENAI_API_KEY',
        'NEXUS_OPENAI_STRATEGY_MODEL',
        'NEXUS_OPENAI_INPUT_USD_PER_1M',
        'NEXUS_OPENAI_OUTPUT_USD_PER_1M'
    )
    $openAiPresent = @($openAiNames | Where-Object { Env-IsPresent $_ }).Count
    $checks.Add((New-Check 'OpenAI live-smoke config' 'INFO' "$openAiPresent/$($openAiNames.Count) required runtime variables are present. Values are never printed; Gate 5 is later and must recheck current official model/pricing at execution time."))

    $claudeNames = @(
        'NEXUS_CLAUDE_LIVE_SMOKE_MODEL',
        'NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL',
        'NEXUS_CLAUDE_EXPECTED_CODE_VERSION'
    )
    $claudePresent = @($claudeNames | Where-Object { Env-IsPresent $_ }).Count
    $checks.Add((New-Check 'Claude live-smoke config' 'INFO' "$claudePresent/$($claudeNames.Count) identity variables are present. Values are never printed; configure only after the evaluated route is known."))

    if ($RunLaptopVerification) {
        if (-not (Test-CommandAvailable 'npm')) {
            $checks.Add((New-Check 'Safe laptop verification' 'BLOCKED' 'npm is unavailable, so verify:laptop could not run.'))
        } else {
            Write-Host 'Running existing safe laptop verification because -RunLaptopVerification was explicitly supplied...'
            & npm run verify:laptop
            if ($LASTEXITCODE -eq 0) {
                $checks.Add((New-Check 'Safe laptop verification' 'PASS' 'npm run verify:laptop completed successfully.'))
            } else {
                $checks.Add((New-Check 'Safe laptop verification' 'BLOCKED' "npm run verify:laptop failed with exit code $LASTEXITCODE."))
            }
        }
    } else {
        $checks.Add((New-Check 'Safe laptop verification' 'INFO' 'Not run. Supply -RunLaptopVerification to invoke the existing deterministic laptop verifier; this still makes no provider calls.'))
    }

    $blocking = @($checks | Where-Object { $_.status -eq 'BLOCKED' })
    $ready = $blocking.Count -eq 0
    $nextGate = if ($ready) { 'Gate 1 — issue #10 Secure Bridge preservation/reconciliation preflight' } else { 'Gate 0 — resolve preflight blockers before any reconciliation or installation' }
    $nextCommand = if ($ready) { 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reconcile-secure-bridge-v13.ps1' } else { '' }

    $result = [pscustomobject]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        mode = 'read-only-preflight'
        repoRoot = $repoRoot
        readyForNextGate = $ready
        blockerCount = $blocking.Count
        nextGate = $nextGate
        nextCommand = $nextCommand
        checks = $checks
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 6
    } else {
        Write-HumanReport $checks $nextGate $nextCommand $ready
    }

    if (-not $ready) { exit 2 }
    exit 0
}
finally {
    Pop-Location
}
