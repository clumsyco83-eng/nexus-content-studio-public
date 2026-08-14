[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('IntelligenceFoundation', 'BusinessProfile')]
    [string]$Profile,

    [Parameter(Mandatory = $false)]
    [string]$SkillsRoot = "$(Join-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.claude') 'skills')",

    [Parameter(Mandatory = $false)]
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$IntelligenceSkills = @(
    'memory-intelligence',
    'knowledge-intelligence',
    'deep-research',
    'source-verification',
    'freshness-intelligence',
    'universal-retrieval',
    'contradiction-fact-check',
    'intelligence-router'
)

$BusinessSkills = @(
    'market-competitive-intelligence',
    'product-strategy-pmf',
    'finance-unit-economics',
    'business-systems-architect',
    'data-analytics-engineer',
    'growth-marketing-intelligence',
    'sales-conversion-systems'
)

function Get-SkillMetadata {
    param([Parameter(Mandatory)][string]$SkillFile)

    $lines = @(Get-Content -LiteralPath $SkillFile)
    if ($lines.Count -lt 4 -or $lines[0].Trim() -ne '---') {
        throw "SKILL.md must start with YAML frontmatter: $SkillFile"
    }

    $closing = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') {
            $closing = $i
            break
        }
    }
    if ($closing -lt 0) { throw "SKILL.md frontmatter is not closed: $SkillFile" }

    $front = if ($closing -gt 1) { @($lines[1..($closing - 1)]) } else { @() }
    $name = $null
    $description = $null

    for ($i = 0; $i -lt $front.Count; $i++) {
        $nameMatch = [regex]::Match($front[$i], '^name:\s*(.+?)\s*$')
        if ($nameMatch.Success) {
            $name = $nameMatch.Groups[1].Value.Trim().Trim('"').Trim("'")
        }

        $descriptionMatch = [regex]::Match($front[$i], '^description:\s*(.*?)\s*$')
        if ($descriptionMatch.Success) {
            $inline = $descriptionMatch.Groups[1].Value.Trim()
            if ($inline -match '^[>|][+-]?$' -or $inline -eq '') {
                $parts = @()
                for ($j = $i + 1; $j -lt $front.Count; $j++) {
                    $candidate = $front[$j]
                    if ($candidate -match '^\s+') {
                        $trimmed = $candidate.Trim()
                        if ($trimmed) { $parts += $trimmed }
                        continue
                    }
                    break
                }
                $description = ($parts -join ' ').Trim()
            } else {
                $description = $inline.Trim('"').Trim("'")
            }
        }
    }

    [pscustomobject]@{
        Name = $name
        Description = $description
        Lines = $lines
        Frontmatter = $front
    }
}

function Get-LocalMarkdownTargets {
    param([Parameter(Mandatory)][string]$Text)

    $targets = @()
    foreach ($match in [regex]::Matches($Text, '\[[^\]]*\]\(([^)]+)\)')) {
        $target = $match.Groups[1].Value.Trim().Trim('<').Trim('>')
        if (-not $target) { continue }
        if ($target -match '^(?i:https?://|mailto:|#)') { continue }
        $targets += $target
    }
    $targets
}

function Test-SkillAuthorityBoundary {
    param(
        [Parameter(Mandatory)][string]$SkillDirectory,
        [Parameter(Mandatory)][string]$ExpectedName,
        [Parameter(Mandatory)]$Metadata
    )

    $errors = @()
    $frontText = @($Metadata.Frontmatter) -join "`n"
    $raw = @($Metadata.Lines) -join "`n"

    if ($frontText -match '(?im)^allowed-tools\s*:') {
        $errors += "${ExpectedName}: allowed-tools frontmatter is forbidden for NEXUS-managed skills; task authority must come from the NEXUS Claude Execution Envelope."
    }
    if ($frontText -match '(?im)^model\s*:') {
        $errors += "${ExpectedName}: model frontmatter is forbidden; NEXUS model promotion/routing owns the exact production model identity."
    }
    if ($frontText -match '(?im)^context\s*:') {
        $errors += "${ExpectedName}: context/subagent frontmatter is forbidden; NEXUS Tool Envelope v1 does not admit skill-triggered forked execution."
    }
    if ($frontText -match '(?im)^agent\s*:') {
        $errors += "${ExpectedName}: agent frontmatter is forbidden; NEXUS remains the task router until nested child-envelope semantics are implemented."
    }
    if ([regex]::IsMatch($raw, '(?m)(^|\s)!`[^`]+`')) {
        $errors += "${ExpectedName}: dynamic shell context injection is forbidden; commands must execute through the bounded Claude/NEXUS tool path."
    }

    $pluginManifest = Join-Path (Join-Path $SkillDirectory '.claude-plugin') 'plugin.json'
    if (Test-Path -LiteralPath $pluginManifest -PathType Leaf) {
        $errors += "${ExpectedName}: embedded Claude plugin manifest is forbidden inside a NEXUS-managed skill."
    }

    foreach ($reservedDir in @('hooks', 'agents')) {
        if (Test-Path -LiteralPath (Join-Path $SkillDirectory $reservedDir) -PathType Container) {
            $errors += "${ExpectedName}: embedded '$reservedDir' directory is forbidden; skills may not add execution hooks/subagents."
        }
    }

    $mcpFiles = @(Get-ChildItem -LiteralPath $SkillDirectory -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)(^\.mcp\.json$|\.mcp\.json$)' })
    if ($mcpFiles.Count -gt 0) {
        $errors += "${ExpectedName}: embedded MCP configuration is forbidden; MCP availability must be admitted by the task execution envelope."
    }

    $errors
}

function Test-SkillFile {
    param(
        [Parameter(Mandatory)][string]$SkillDirectory,
        [Parameter(Mandatory)][string]$ExpectedName,
        [Parameter(Mandatory)][bool]$RequireTests
    )

    $errors = @()
    $skillFile = Join-Path $SkillDirectory 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
        return @("${ExpectedName}: SKILL.md is missing.")
    }

    try {
        $metadata = Get-SkillMetadata -SkillFile $skillFile
    } catch {
        return @("${ExpectedName}: $($_.Exception.Message)")
    }

    if (-not $metadata.Name) {
        $errors += "${ExpectedName}: frontmatter name is missing."
    } else {
        if ($metadata.Name.Length -gt 64) { $errors += "${ExpectedName}: name exceeds 64 characters." }
        if ($metadata.Name -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { $errors += "${ExpectedName}: name must use lowercase letters, numbers and hyphens only." }
        if ($metadata.Name -match '(?i:anthropic|claude)') { $errors += "${ExpectedName}: name contains a reserved word." }
        if ($metadata.Name -match '<[^>]+>') { $errors += "${ExpectedName}: name contains an XML-like tag." }
        if ($metadata.Name -ne $ExpectedName) { $errors += "${ExpectedName}: frontmatter name '$($metadata.Name)' does not match its directory." }
    }

    if (-not $metadata.Description) {
        $errors += "${ExpectedName}: description is missing or empty."
    } else {
        if ($metadata.Description.Length -gt 1024) { $errors += "${ExpectedName}: description exceeds 1024 characters." }
        if ($metadata.Description -match '<[^>]+>') { $errors += "${ExpectedName}: description contains an XML-like tag." }
        if ($metadata.Description -match '^(?i:I\s|I\x27m\s|I\x27ll\s|You\s|Your\s)') { $errors += "${ExpectedName}: description should use third-person discovery wording, not first/second person." }
        if ($metadata.Description -notmatch '(?i:\buse\b|\bwhen\b)') { $errors += "${ExpectedName}: description does not clearly state when to use the skill." }
    }

    if ($metadata.Lines.Count -gt 500) {
        $errors += "${ExpectedName}: SKILL.md has $($metadata.Lines.Count) lines; keep the body under 500 lines and move details to references."
    }

    $errors += @(Test-SkillAuthorityBoundary -SkillDirectory $SkillDirectory -ExpectedName $ExpectedName -Metadata $metadata)

    $raw = $metadata.Lines -join "`n"
    foreach ($target in @(Get-LocalMarkdownTargets -Text $raw)) {
        if ($target -match '\\') { $errors += "${ExpectedName}: markdown reference '$target' uses Windows-style backslashes." }
        $pathOnly = ($target -split '#', 2)[0]
        if ($pathOnly -match '(^|/)\.\./\.\./') { $errors += "${ExpectedName}: markdown reference '$target' traverses more than one parent level." }
    }

    if ($RequireTests) {
        $testsFile = Join-Path $SkillDirectory 'TESTS.md'
        if (-not (Test-Path -LiteralPath $testsFile -PathType Leaf)) {
            $errors += "${ExpectedName}: TESTS.md is required for the Intelligence Foundation profile."
        } else {
            $testText = Get-Content -LiteralPath $testsFile -Raw
            $scenarioCount = ([regex]::Matches($testText, '(?m)^###\s+')).Count
            if ($scenarioCount -lt 3) { $errors += "${ExpectedName}: TESTS.md must contain at least three concrete scenarios; found $scenarioCount." }
        }
    }

    $errors
}

function Test-Profile {
    param(
        [Parameter(Mandatory)][string]$ProfileName,
        [Parameter(Mandatory)][string]$Root
    )

    $errors = @()
    $expected = if ($ProfileName -eq 'IntelligenceFoundation') { $IntelligenceSkills } else { $BusinessSkills }
    $requireTests = $ProfileName -eq 'IntelligenceFoundation'

    foreach ($skill in $expected) {
        $dir = Join-Path $Root $skill
        $errors += @(Test-SkillFile -SkillDirectory $dir -ExpectedName $skill -RequireTests $requireTests)
    }

    if ($ProfileName -eq 'BusinessProfile') {
        $profileDocs = Join-Path $Root '_business-intelligence-profile'
        foreach ($required in @('EVALUATION-SUITE.md', 'ROUTING-MATRIX.md')) {
            if (-not (Test-Path -LiteralPath (Join-Path $profileDocs $required) -PathType Leaf)) {
                $errors += "BusinessProfile: required evaluation file is missing: $required"
            }
        }

        $evaluationFile = Join-Path $profileDocs 'EVALUATION-SUITE.md'
        $routingFile = Join-Path $profileDocs 'ROUTING-MATRIX.md'
        if ((Test-Path -LiteralPath $evaluationFile -PathType Leaf) -and (Test-Path -LiteralPath $routingFile -PathType Leaf)) {
            $evaluation = Get-Content -LiteralPath $evaluationFile -Raw
            $routing = Get-Content -LiteralPath $routingFile -Raw
            $scenarioCount = ([regex]::Matches($evaluation, '(?m)^##\s+E\d+\b')).Count
            if ($scenarioCount -lt 3) { $errors += "BusinessProfile: EVALUATION-SUITE.md must contain at least three E## scenarios; found $scenarioCount." }
            foreach ($skill in $BusinessSkills) {
                if (($evaluation -notmatch [regex]::Escape($skill)) -and ($routing -notmatch [regex]::Escape($skill))) {
                    $errors += "BusinessProfile: '$skill' is absent from both evaluation and routing evidence."
                }
            }
        }
    }

    $errors
}

function Invoke-SelfTest {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("nexus-skill-quality-selftest-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Force -Path $temp | Out-Null

        $validDir = Join-Path $temp 'valid-skill'
        New-Item -ItemType Directory -Force -Path $validDir | Out-Null
        @'
---
name: valid-skill
description: >
  Processes a deterministic test fixture. Use when verifying the NEXUS skill authoring quality gate.
---
# Valid Skill

Use [REFERENCE.md](REFERENCE.md) when the fixture needs detail.
'@ | Set-Content -LiteralPath (Join-Path $validDir 'SKILL.md') -Encoding utf8
        '# Reference' | Set-Content -LiteralPath (Join-Path $validDir 'REFERENCE.md') -Encoding utf8

        $validErrors = @(Test-SkillFile -SkillDirectory $validDir -ExpectedName 'valid-skill' -RequireTests $false)
        if ($validErrors.Count -ne 0) { throw "Self-test valid fixture failed: $($validErrors -join '; ')" }

        $authorityDir = Join-Path $temp 'authority-skill'
        New-Item -ItemType Directory -Force -Path $authorityDir | Out-Null
        @'
---
name: authority-skill
description: Tests unsafe authority-bearing skill metadata. Use when verifying fail-closed skill authority checks.
allowed-tools: Bash(git push *)
model: opus
context: fork
agent: Explore
---
# Unsafe Skill

Inject live context: !`git status`
'@ | Set-Content -LiteralPath (Join-Path $authorityDir 'SKILL.md') -Encoding utf8
        New-Item -ItemType Directory -Force -Path (Join-Path $authorityDir '.claude-plugin') | Out-Null
        '{"name":"unsafe-skill-plugin"}' | Set-Content -LiteralPath (Join-Path (Join-Path $authorityDir '.claude-plugin') 'plugin.json') -Encoding utf8
        '{"mcpServers":{}}' | Set-Content -LiteralPath (Join-Path $authorityDir '.mcp.json') -Encoding utf8

        $authorityErrors = @(Test-SkillFile -SkillDirectory $authorityDir -ExpectedName 'authority-skill' -RequireTests $false)
        foreach ($needle in @('allowed-tools', 'model frontmatter', 'context/subagent', 'agent frontmatter', 'dynamic shell', 'plugin manifest', 'MCP configuration')) {
            if (($authorityErrors -join "`n") -notmatch [regex]::Escape($needle)) {
                throw "Self-test unsafe authority fixture did not trigger '$needle'. Errors: $($authorityErrors -join '; ')"
            }
        }

        $badDir = Join-Path $temp 'bad_skill'
        New-Item -ItemType Directory -Force -Path $badDir | Out-Null
        $badLines = @('---', 'name: Bad_Skill', 'description: You can use this helper', '---')
        for ($i = 0; $i -lt 501; $i++) { $badLines += "line $i" }
        $badLines | Set-Content -LiteralPath (Join-Path $badDir 'SKILL.md') -Encoding utf8

        $badErrors = @(Test-SkillFile -SkillDirectory $badDir -ExpectedName 'bad_skill' -RequireTests $false)
        if ($badErrors.Count -lt 3) { throw "Self-test invalid fixture was not rejected strongly enough. Errors: $($badErrors -join '; ')" }

        Write-Host 'PASS Claude skill authoring quality-gate self-test' -ForegroundColor Green
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

if (-not $Profile) { throw 'Specify -Profile IntelligenceFoundation or -Profile BusinessProfile, or use -SelfTest.' }
if (-not (Test-Path -LiteralPath $SkillsRoot -PathType Container)) { throw "Skills root does not exist: $SkillsRoot" }

$profileErrors = @(Test-Profile -ProfileName $Profile -Root $SkillsRoot)
if ($profileErrors.Count -gt 0) {
    Write-Host "Claude skill authoring quality gate FAILED for $Profile" -ForegroundColor Red
    foreach ($item in $profileErrors) { Write-Host " - $item" -ForegroundColor Red }
    throw "$($profileErrors.Count) Claude skill authoring quality error(s) detected."
}

Write-Host "PASS Claude skill authoring quality gate: $Profile" -ForegroundColor Green
Write-Host 'Validated frontmatter, names/descriptions, instruction size, portable references, evaluation coverage, and the no-hidden-authority skill boundary.'
Write-Host 'This static gate does not prove runtime discovery or routing. Fresh-session Sonnet and Opus host evaluations remain required before READY.'