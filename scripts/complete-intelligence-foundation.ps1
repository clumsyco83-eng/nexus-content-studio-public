[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ZipPath = "$(Join-Path (Split-Path -Parent $PSScriptRoot) 'nexus-intelligence-foundation-v1.0.0.zip')",

    [Parameter(Mandatory = $false)]
    [switch]$SkipClaudeUpdate,

    [Parameter(Mandatory = $false)]
    [switch]$SkipLaptopVerification
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This completion helper is intentionally Windows-only.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Installer = Join-Path $PSScriptRoot 'install-intelligence-foundation.ps1'
$QualityGate = Join-Path $PSScriptRoot 'verify-claude-skill-authoring.ps1'
$AuthorityGate = Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1'
$ExpectedSkills = @(
    'memory-intelligence',
    'knowledge-intelligence',
    'deep-research',
    'source-verification',
    'freshness-intelligence',
    'universal-retrieval',
    'contradiction-fact-check',
    'intelligence-router'
)

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Command
    )
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
    Write-Host "PASS $Name" -ForegroundColor Green
}

function Get-ClaudeVersion {
    $output = & claude --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "claude --version failed: $output" }
    return ($output | Out-String).Trim()
}

Push-Location $RepoRoot
try {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'Claude Code CLI is not available in PATH.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is not available in PATH.' }
    if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Installer missing: $Installer" }
    if (-not (Test-Path -LiteralPath $QualityGate -PathType Leaf)) { throw "Claude skill quality gate missing: $QualityGate" }
    if (-not (Test-Path -LiteralPath $AuthorityGate -PathType Leaf)) { throw "Claude skill authority gate missing: $AuthorityGate" }
    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "Intelligence Foundation ZIP missing: $ZipPath" }

    $before = Get-ClaudeVersion
    Write-Host "Claude Code before: $before" -ForegroundColor Yellow

    if (-not $SkipClaudeUpdate) {
        Invoke-Checked -Name 'Claude Code update' -Command { & claude update }
    }

    $after = Get-ClaudeVersion
    Write-Host "Claude Code after:  $after" -ForegroundColor Green
    Invoke-Checked -Name 'Claude Code doctor' -Command { & claude doctor }

    Write-Host "`n=== Install validated NEXUS Intelligence Foundation ===" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer -ZipPath $ZipPath
    if ($LASTEXITCODE -ne 0) { throw "NEXUS Intelligence Foundation installer failed with exit code $LASTEXITCODE" }

    $SkillsRoot = Join-Path $RepoRoot '.claude\skills'
    foreach ($skill in $ExpectedSkills) {
        $skillFile = Join-Path (Join-Path $SkillsRoot $skill) 'SKILL.md'
        $testsFile = Join-Path (Join-Path $SkillsRoot $skill) 'TESTS.md'
        if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { throw "Missing installed skill: $skillFile" }
        if (-not (Test-Path -LiteralPath $testsFile -PathType Leaf)) { throw "Missing installed tests: $testsFile" }
        $nameLine = Get-Content -LiteralPath $skillFile -TotalCount 30 | Where-Object { $_ -match '^name:\s*(.+?)\s*$' } | Select-Object -First 1
        if (-not $nameLine) { throw "Missing skill name frontmatter: $skillFile" }
        $installedName = ($Matches[1]).Trim()
        if ($installedName -ne $skill) { throw "Skill folder '$skill' contains '$installedName'." }
    }

    Invoke-Checked -Name 'Claude Skill authoring quality gate' -Command {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $QualityGate -Profile IntelligenceFoundation -SkillsRoot $SkillsRoot
    }
    Invoke-Checked -Name 'Claude Skill runtime-authority boundary gate' -Command {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $AuthorityGate -SkillsRoot $SkillsRoot
    }
    Invoke-Checked -Name 'TypeScript check' -Command { & npm.cmd run check }
    Invoke-Checked -Name 'READY-bound Claude Skill admission verification' -Command { & npm.cmd run verify:claude-skill-admission }
    Invoke-Checked -Name 'NEXUS intelligence router verification' -Command { & npm.cmd run verify:intelligence-routing }
    Invoke-Checked -Name 'NEXUS capability readiness verification' -Command { & npm.cmd run verify:capabilities }
    Invoke-Checked -Name 'NEXUS stuck/dead-loop detector verification' -Command { & npm.cmd run verify:stuck }
    Invoke-Checked -Name 'NEXUS OpenAI strategy contract verification' -Command { & npm.cmd run verify:openai-strategy }
    Invoke-Checked -Name 'NEXUS configured system verification' -Command { & npm.cmd run verify:system }

    if (-not $SkipLaptopVerification) {
        Write-Host "`n=== Full NEXUS Windows safety verification ===" -ForegroundColor Cyan
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -SkipInstall
        if ($LASTEXITCODE -ne 0) { throw "Full NEXUS laptop verification failed with exit code $LASTEXITCODE" }
    }

    Write-Host "`nNEXUS INTELLIGENCE FOUNDATION FILE/CLI/SAFETY GATE: PASS" -ForegroundColor Green
    Write-Host "Claude Code: $after"
    Write-Host 'Eight project-local skill directories are present, pass the static authoring + runtime-authority gates, and deterministic NEXUS checks passed.'
    Write-Host ''
    Write-Host 'REMAINING LIVE-HOST DISCOVERY GATE:' -ForegroundColor Yellow
    Write-Host 'Open fresh Claude Code sessions from this repository root and prove all eight skills are discoverable and route correctly.'
    Write-Host 'Run the required routing/TESTS.md suite on Sonnet (primary) and the critical routing/collision/safety subset on Opus (escalation) before marking each admitted skill capability READY.'
    Write-Host 'Only READY skill capabilities may be exposed to a real NEXUS task through exact Skill(name) admission.'
}
finally {
    Pop-Location
}
