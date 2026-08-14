[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$RecordRuntimeObservation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$OptInValue = 'I_ACKNOWLEDGE_A_BOUNDED_READ_ONLY_CLAUDE_CALL'
$Prompt = 'Return exactly NEXUS_CLAUDE_RUNTIME_SMOKE_OK and nothing else. Do not use tools. Do not read, edit, create, delete, execute, publish, spend, authenticate, browse, or change any file, account, process, setting, or external resource.'

function New-ClaudeSmokeArgs {
    param([Parameter(Mandatory)][string]$RequestedModel)
    return @(
        '-p', $Prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '1',
        '--model', $RequestedModel,
        '--permission-mode', 'plan',
        '--safe-mode',
        '--disallowedTools', 'Read,Bash,Edit,Write,NotebookEdit,Skill'
    )
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This helper is currently Windows-only because it is part of the NEXUS laptop readiness path.'
}

if ($SelfTest) {
    $testArgs = @(New-ClaudeSmokeArgs -RequestedModel 'sonnet')
    $joined = $testArgs -join ' '
    if ($joined -notmatch '--output-format stream-json') { throw 'Self-test: stream-json output is required.' }
    if ($joined -notmatch '--max-turns 1') { throw 'Self-test: live smoke must remain one turn.' }
    if ($joined -notmatch '--permission-mode plan') { throw 'Self-test: live smoke must remain in plan mode.' }
    if ($joined -notmatch '--safe-mode') { throw 'Self-test: Claude safe mode must remain enabled.' }
    if ($joined -notmatch '--disallowedTools Read,Bash,Edit,Write,NotebookEdit,Skill') { throw 'Self-test: Read, Skill, mutation and shell tools must remain disallowed.' }
    if ($joined -match 'dangerously-skip-permissions|bypassPermissions') { throw 'Self-test: permission bypass must never appear in the live smoke command.' }
    if ($Prompt -notmatch 'Do not use tools') { throw 'Self-test: no-tool instruction must remain explicit.' }
    Write-Host 'PASS Claude live smoke self-test: one-turn stream-json plan-mode safe-mode command contains no permission bypass and disallows Read/Skill/write/edit/shell tools.' -ForegroundColor Green
    if ($RecordRuntimeObservation) {
        Write-Host 'PASS record-mode self-test: runtime observation remains a separate post-verification step and still requires its own explicit apply opt-in.' -ForegroundColor Green
    }
    exit 0
}

if ($env:NEXUS_CLAUDE_LIVE_SMOKE -ne $OptInValue) {
    throw "Claude live smoke is disabled. Set NEXUS_CLAUDE_LIVE_SMOKE=$OptInValue only for one deliberate bounded read-only runtime verification call."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Claude = Get-Command claude -ErrorAction SilentlyContinue
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $Claude) { throw 'Claude Code is not available in PATH.' }
if ($null -eq $Npm) { throw 'npm.cmd is not available in PATH.' }

$RequestedModel = if (-not [string]::IsNullOrWhiteSpace($env:NEXUS_CLAUDE_LIVE_SMOKE_MODEL)) {
    $env:NEXUS_CLAUDE_LIVE_SMOKE_MODEL.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:NEXUS_CLAUDE_DEFAULT_MODEL)) {
    $env:NEXUS_CLAUDE_DEFAULT_MODEL.Trim()
} else {
    'sonnet'
}

$ExpectedResolvedModel = if (-not [string]::IsNullOrWhiteSpace($env:NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL)) {
    $env:NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($env:NEXUS_CLAUDE_EXPECTED_DEFAULT_RESOLVED_MODEL)) {
    $env:NEXUS_CLAUDE_EXPECTED_DEFAULT_RESOLVED_MODEL.Trim()
} else {
    $null
}
if ([string]::IsNullOrWhiteSpace($ExpectedResolvedModel)) {
    throw 'Configure NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL (or NEXUS_CLAUDE_EXPECTED_DEFAULT_RESOLVED_MODEL) with the exact evaluated resolved model ID before this smoke can count as READY evidence.'
}
$env:NEXUS_CLAUDE_LIVE_SMOKE_EXPECTED_RESOLVED_MODEL = $ExpectedResolvedModel

$ExpectedVersion = $env:NEXUS_CLAUDE_EXPECTED_CODE_VERSION
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    throw 'NEXUS_CLAUDE_EXPECTED_CODE_VERSION is required. Record the exact claude --version string from the evaluation you are validating.'
}
$ActualVersion = (& $Claude.Source --version 2>&1 | Out-String).Trim()
if ($ActualVersion -ne $ExpectedVersion.Trim()) {
    throw "Claude Code version drift detected before live smoke: actual '$ActualVersion' != evaluated '$($ExpectedVersion.Trim())'. Re-run the affected skill/routing evaluation before READY."
}

$EvidencePath = Join-Path $env:TEMP "nexus-claude-live-smoke-$([guid]::NewGuid().ToString('N')).jsonl"
$ErrorPath = Join-Path $env:TEMP "nexus-claude-live-smoke-$([guid]::NewGuid().ToString('N')).err.txt"
$PreviousClaudeSafeMode = $env:CLAUDE_CODE_SAFE_MODE

Push-Location $RepoRoot
try {
    $env:CLAUDE_CODE_SAFE_MODE = '1'
    Write-Host "Running one bounded Claude runtime smoke: requested model=$RequestedModel, permission mode=plan, safe mode=on, max turns=1." -ForegroundColor Cyan
    Write-Host 'No permission bypass is used. Read, Skill, write/edit/shell tools are explicitly disallowed for this smoke.' -ForegroundColor Yellow

    $claudeArgs = @(New-ClaudeSmokeArgs -RequestedModel $RequestedModel)
    & $Claude.Source @claudeArgs 2> $ErrorPath | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
    $ClaudeExit = $LASTEXITCODE
    if ($ClaudeExit -ne 0) {
        $tail = if (Test-Path -LiteralPath $ErrorPath) { (Get-Content -LiteralPath $ErrorPath -Tail 30) -join "`n" } else { '' }
        throw "Claude live smoke failed with exit code $ClaudeExit. $tail"
    }

    & $Npm.Source exec -- tsx src/testing/claude-live-smoke-evidence.ts $EvidencePath
    if ($LASTEXITCODE -ne 0) { throw "Claude runtime evidence verification failed with exit code $LASTEXITCODE." }

    Write-Host "Claude Code version: $ActualVersion" -ForegroundColor Green
    Write-Host "Requested model: $RequestedModel" -ForegroundColor Green
    Write-Host "Expected resolved model: $ExpectedResolvedModel" -ForegroundColor Green
    Write-Host 'PASS bounded read-only Claude live runtime smoke.' -ForegroundColor Green

    if ($RecordRuntimeObservation) {
        Write-Host 'Previewing fresh claude-executor runtime-observation refresh against the configured durable NEXUS store.' -ForegroundColor Cyan
        & $Npm.Source exec -- tsx src/capabilities/claude-runtime-observation-cli.ts --evidence $EvidencePath --actual-version $ActualVersion
        if ($LASTEXITCODE -ne 0) { throw "Claude runtime-observation preview failed with exit code $LASTEXITCODE; durable state was not mutated." }

        Write-Host 'Applying only the verified runtime observation. The evaluated binding, readiness policy and readiness checks must remain unchanged.' -ForegroundColor Cyan
        & $Npm.Source exec -- tsx src/capabilities/claude-runtime-observation-cli.ts --evidence $EvidencePath --actual-version $ActualVersion --apply
        if ($LASTEXITCODE -ne 0) { throw "Claude runtime-observation apply failed with exit code $LASTEXITCODE." }
        Write-Host 'PASS fresh Claude runtime observation persisted through the repository-native preview/backup/rollback path.' -ForegroundColor Green
    }
}
finally {
    if ($null -eq $PreviousClaudeSafeMode) {
        Remove-Item Env:CLAUDE_CODE_SAFE_MODE -ErrorAction SilentlyContinue
    } else {
        $env:CLAUDE_CODE_SAFE_MODE = $PreviousClaudeSafeMode
    }
    Remove-Item -LiteralPath $EvidencePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ErrorPath -Force -ErrorAction SilentlyContinue
    Pop-Location
}
