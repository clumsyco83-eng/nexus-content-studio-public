[CmdletBinding()]
param(
    [switch]$RunFullLaptopVerification,
    [switch]$SelfTest,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This readiness audit is intentionally Windows-only.'
}

function Is-FloatingClaudeAlias {
    param([string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { return $false }
    return @('default','sonnet','opus','haiku','fable') -contains $Model.Trim().ToLowerInvariant()
}

function Test-RateValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = 0.0
    $parsedOk = [double]::TryParse($Value, [ref]$parsed)
    return $parsedOk -and -not [double]::IsNaN($parsed) -and -not [double]::IsInfinity($parsed) -and $parsed -ge 0
}

if ($SelfTest) {
    if (-not (Is-FloatingClaudeAlias 'sonnet')) { throw 'Self-test: sonnet alias must be classified as floating.' }
    if (-not (Is-FloatingClaudeAlias 'OPUS')) { throw 'Self-test: OPUS alias must be classified as floating.' }
    if (-not (Is-FloatingClaudeAlias 'fable')) { throw 'Self-test: fable alias must be classified as floating.' }
    if (Is-FloatingClaudeAlias 'claude-sonnet-4-20250514') { throw 'Self-test: exact Claude model ID must not be classified as floating.' }
    if (-not (Test-RateValue '0')) { throw 'Self-test: zero price rate must be accepted.' }
    if (-not (Test-RateValue '12.5')) { throw 'Self-test: positive finite price rate must be accepted.' }
    if (Test-RateValue '-0.01') { throw 'Self-test: negative price rate must be rejected.' }
    if (Test-RateValue 'NaN') { throw 'Self-test: NaN price rate must be rejected.' }
    if (Test-RateValue 'Infinity') { throw 'Self-test: Infinity price rate must be rejected.' }
    if (Test-RateValue '') { throw 'Self-test: blank price rate must be rejected.' }
    Write-Host 'PASS runtime readiness audit self-test: Claude alias and price-rate validation are Windows PowerShell compatible.' -ForegroundColor Green
    exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $base = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'NEXUS\readiness' } else { Join-Path $env:TEMP 'NEXUS-readiness' }
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $OutputPath = Join-Path $base "runtime-readiness-$Timestamp.json"
}

$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Ready,
        [Parameter(Mandatory)][string]$Details,
        [bool]$Required = $true
    )
    $checks.Add([pscustomobject]@{
        name = $Name
        ready = $Ready
        required = $Required
        details = $Details
    })
}

Push-Location $RepoRoot
try {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        Add-Check -Name 'git' -Ready $false -Details 'git is not available in PATH.'
        $gitHead = $null
        $gitBranch = $null
        $clean = $false
    }
    else {
        $gitHead = (& git rev-parse HEAD 2>$null | Out-String).Trim()
        $gitBranch = (& git branch --show-current 2>$null | Out-String).Trim()
        $status = (& git status --porcelain 2>$null | Out-String).Trim()
        $clean = [string]::IsNullOrWhiteSpace($status)
        Add-Check -Name 'git' -Ready (-not [string]::IsNullOrWhiteSpace($gitHead)) -Details "HEAD=$gitHead branch=$gitBranch"
        Add-Check -Name 'clean-worktree' -Ready $clean -Details $(if ($clean) { 'Working tree is clean.' } else { 'Working tree has uncommitted/untracked changes; reconcile before promotion.' })
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    Add-Check -Name 'node' -Ready ($null -ne $node) -Details $(if ($node) { (& node --version | Out-String).Trim() } else { 'Node.js is missing.' })
    Add-Check -Name 'npm' -Ready ($null -ne $npm) -Details $(if ($npm) { 'npm.cmd is available.' } else { 'npm.cmd is missing.' })

    $claude = Get-Command claude -ErrorAction SilentlyContinue
    $actualClaudeVersion = $null
    if ($null -eq $claude) {
        Add-Check -Name 'claude-code-installed' -Ready $false -Details 'Claude Code command is not available in PATH.'
    }
    else {
        $actualClaudeVersion = (& $claude.Source --version 2>&1 | Out-String).Trim()
        Add-Check -Name 'claude-code-installed' -Ready (-not [string]::IsNullOrWhiteSpace($actualClaudeVersion)) -Details "Detected version: $actualClaudeVersion"
    }

    $expectedClaudeVersion = $env:NEXUS_CLAUDE_EXPECTED_CODE_VERSION
    $versionReady = -not [string]::IsNullOrWhiteSpace($actualClaudeVersion) -and -not [string]::IsNullOrWhiteSpace($expectedClaudeVersion) -and $actualClaudeVersion.Trim() -eq $expectedClaudeVersion.Trim()
    Add-Check -Name 'claude-code-version-evaluated' -Ready $versionReady -Details $(
        if ([string]::IsNullOrWhiteSpace($expectedClaudeVersion)) { 'NEXUS_CLAUDE_EXPECTED_CODE_VERSION is not configured from a completed live evaluation.' }
        elseif ([string]::IsNullOrWhiteSpace($actualClaudeVersion)) { 'Actual Claude Code version is unavailable.' }
        elseif ($versionReady) { 'Installed Claude Code version matches the evaluated version.' }
        else { "Version drift: installed '$actualClaudeVersion' differs from evaluated '$expectedClaudeVersion'." }
    )

    $expectedPrimary = $env:NEXUS_CLAUDE_EXPECTED_DEFAULT_RESOLVED_MODEL
    $expectedEscalation = $env:NEXUS_CLAUDE_EXPECTED_ESCALATION_RESOLVED_MODEL
    $primaryReady = -not [string]::IsNullOrWhiteSpace($expectedPrimary) -and -not (Is-FloatingClaudeAlias $expectedPrimary)
    $escalationReady = -not [string]::IsNullOrWhiteSpace($expectedEscalation) -and -not (Is-FloatingClaudeAlias $expectedEscalation)
    Add-Check -Name 'claude-primary-evaluated-model' -Ready $primaryReady -Details $(if ($primaryReady) { "Expected resolved primary model recorded: $expectedPrimary" } else { 'NEXUS_CLAUDE_EXPECTED_DEFAULT_RESOLVED_MODEL must contain the exact evaluated resolved model ID, not a floating alias.' })
    Add-Check -Name 'claude-escalation-evaluated-model' -Ready $escalationReady -Details $(if ($escalationReady) { "Expected resolved escalation model recorded: $expectedEscalation" } else { 'NEXUS_CLAUDE_EXPECTED_ESCALATION_RESOLVED_MODEL must contain the exact evaluated resolved model ID, not a floating alias.' })

    $openAIRequested = $env:NEXUS_OPENAI_STRATEGY_MODEL
    $openAIResolved = $env:NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL
    Add-Check -Name 'openai-requested-model' -Ready (-not [string]::IsNullOrWhiteSpace($openAIRequested)) -Details $(if ($openAIRequested) { "Requested strategy model configured: $openAIRequested" } else { 'NEXUS_OPENAI_STRATEGY_MODEL is not configured.' })
    Add-Check -Name 'openai-evaluated-resolved-model' -Ready (-not [string]::IsNullOrWhiteSpace($openAIResolved)) -Details $(if ($openAIResolved) { "Expected provider-reported model configured: $openAIResolved" } else { 'NEXUS_OPENAI_EXPECTED_RESOLVED_MODEL is not configured from a successful live smoke/evaluation.' })
    Add-Check -Name 'openai-pricing-input' -Ready (Test-RateValue $env:NEXUS_OPENAI_INPUT_USD_PER_1M) -Details $(if (Test-RateValue $env:NEXUS_OPENAI_INPUT_USD_PER_1M) { 'Input rate configured.' } else { 'NEXUS_OPENAI_INPUT_USD_PER_1M is missing or invalid.' })
    Add-Check -Name 'openai-pricing-output' -Ready (Test-RateValue $env:NEXUS_OPENAI_OUTPUT_USD_PER_1M) -Details $(if (Test-RateValue $env:NEXUS_OPENAI_OUTPUT_USD_PER_1M) { 'Output rate configured.' } else { 'NEXUS_OPENAI_OUTPUT_USD_PER_1M is missing or invalid.' })
    Add-Check -Name 'openai-runtime-secret-present' -Ready (-not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) -Details $(if ($env:OPENAI_API_KEY) { 'OPENAI_API_KEY is present in the runtime environment (value not recorded).' } else { 'OPENAI_API_KEY is absent. The audit never reads or writes the secret value.' })

    if ($npm) {
        & npm.cmd run verify:model-promotion *> $null
        Add-Check -Name 'model-promotion-contract' -Ready ($LASTEXITCODE -eq 0) -Details 'Deterministic production model-promotion gate executed.'
        if ($LASTEXITCODE -ne 0) { throw 'verify:model-promotion failed.' }

        & npm.cmd run verify:claude-runtime-evidence *> $null
        Add-Check -Name 'claude-runtime-evidence-contract' -Ready ($LASTEXITCODE -eq 0) -Details 'Deterministic Claude runtime identity/usage contract test executed.'
        if ($LASTEXITCODE -ne 0) { throw 'verify:claude-runtime-evidence failed.' }

        & npm.cmd run verify:runtime-attestation *> $null
        Add-Check -Name 'runtime-attestation-contract' -Ready ($LASTEXITCODE -eq 0) -Details 'Deterministic runtime attestation/degradation/recovery contract test executed.'
        if ($LASTEXITCODE -ne 0) { throw 'verify:runtime-attestation failed.' }

        & npm.cmd run verify:runtime-cycle *> $null
        Add-Check -Name 'runtime-cycle-contract' -Ready ($LASTEXITCODE -eq 0) -Details 'Deterministic one-cycle NEXUS orchestration-order contract test executed.'
        if ($LASTEXITCODE -ne 0) { throw 'verify:runtime-cycle failed.' }

        & npm.cmd run verify:openai-strategy *> $null
        Add-Check -Name 'openai-strategy-contract' -Ready ($LASTEXITCODE -eq 0) -Details 'Deterministic OpenAI strategy/model/budget contract test executed.'
        if ($LASTEXITCODE -ne 0) { throw 'verify:openai-strategy failed.' }

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\verify-claude-runtime-policy.ps1') *> $null
        Add-Check -Name 'claude-project-safety-policy' -Ready ($LASTEXITCODE -eq 0) -Details 'Project permission/hook safety policy verification executed.'
        if ($LASTEXITCODE -ne 0) { throw 'Claude runtime safety policy verification failed.' }

        if ($RunFullLaptopVerification) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\windows-laptop-verify.ps1') -SkipInstall
            Add-Check -Name 'full-laptop-verification' -Ready ($LASTEXITCODE -eq 0) -Details 'Full deterministic laptop verification executed.'
            if ($LASTEXITCODE -ne 0) { throw 'Full laptop verification failed.' }
        }
        else {
            Add-Check -Name 'full-laptop-verification' -Ready $false -Required $false -Details 'Not run. Re-run this audit with -RunFullLaptopVerification for complete deterministic host verification.'
        }
    }

    $required = @($checks | Where-Object { $_.required })
    $failed = @($required | Where-Object { -not $_.ready })
    $report = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        repoRoot = $RepoRoot
        gitHead = $gitHead
        gitBranch = $gitBranch
        secretsIncluded = $false
        ready = ($failed.Count -eq 0)
        requiredChecks = $required.Count
        failedRequiredChecks = $failed.Count
        checks = @($checks)
        remainingRealHostGates = @(
            'Issue #10 Secure Bridge/Verifier reconciliation and live runtime-attestation/cycle integration',
            'Issue #6 Intelligence Foundation live discovery/routing evaluation',
            'Issue #50 six core engineering specialists project-local promotion and live routing evaluation',
            'Bounded Claude live runtime smoke for the evaluated primary model',
            'Issue #17 bounded OpenAI paid read-only live smoke with resolved-model evidence',
            'Issue #28 Business Profile live routing/collision evaluation',
            'Issue #49 exact live per-task Skill admission closure',
            'Full real scheduler/runtime-cycle integration and Owner -> NEXUS -> OpenAI -> NEXUS -> Claude -> Verifier acceptance',
            'Phone Mission Control verification from the real phone/Tailscale path'
        )
    }

    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

    Write-Host "Runtime readiness report: $OutputPath" -ForegroundColor Cyan
    Write-Host "Required checks: $($required.Count); failed: $($failed.Count)" -ForegroundColor $(if ($failed.Count -eq 0) { 'Green' } else { 'Yellow' })
    foreach ($check in $checks) {
        $prefix = if ($check.ready) { 'PASS' } elseif ($check.required) { 'BLOCK' } else { 'INFO' }
        Write-Host "$prefix $($check.name): $($check.details)"
    }

    if ($failed.Count -gt 0) {
        Write-Host 'NEXUS RUNTIME READINESS: NOT READY — see blocked checks above. No paid call or bridge apply was attempted.' -ForegroundColor Yellow
        exit 2
    }

    Write-Host 'NEXUS RUNTIME READINESS: PRECONDITIONS GREEN. Live provider/bridge gates still require their explicit commands/evidence.' -ForegroundColor Green
}
finally {
    Pop-Location
}
