[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$SkillsRoot,

    [Parameter(Mandatory = $false)]
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedSkills = @(
    'technology-research-scout',
    'principal-architecture',
    'engineering-intelligence',
    'backend-data-engineer',
    'platform-sre-engineer',
    'nexus-qa-testing-director'
)

function Get-SkillMetadata {
    param([Parameter(Mandatory)][string]$SkillFile)

    $lines = @(Get-Content -LiteralPath $SkillFile)
    if ($lines.Count -lt 4 -or $lines[0].Trim() -ne '---') {
        throw "SKILL.md must start with YAML frontmatter: $SkillFile"
    }

    $closing = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { $closing = $i; break }
    }
    if ($closing -lt 0) { throw "SKILL.md frontmatter is not closed: $SkillFile" }

    $front = if ($closing -gt 1) { @($lines[1..($closing - 1)]) } else { @() }
    $name = $null
    $description = $null
    for ($i = 0; $i -lt $front.Count; $i++) {
        $nameMatch = [regex]::Match($front[$i], '^name:\s*(.+?)\s*$')
        if ($nameMatch.Success) { $name = $nameMatch.Groups[1].Value.Trim().Trim('"').Trim("'") }

        $descriptionMatch = [regex]::Match($front[$i], '^description:\s*(.*?)\s*$')
        if ($descriptionMatch.Success) {
            $inline = $descriptionMatch.Groups[1].Value.Trim()
            if ($inline -match '^[>|][+-]?$' -or $inline -eq '') {
                $parts = @()
                for ($j = $i + 1; $j -lt $front.Count; $j++) {
                    $candidate = $front[$j]
                    if ($candidate -notmatch '^\s+') { break }
                    $trimmed = $candidate.Trim()
                    if ($trimmed) { $parts += $trimmed }
                }
                $description = ($parts -join ' ').Trim()
            } else {
                $description = $inline.Trim('"').Trim("'")
            }
        }
    }

    [pscustomobject]@{ Name = $name; Description = $description; Lines = $lines }
}

function Get-LocalMarkdownTargets {
    param([Parameter(Mandatory)][string]$Text)
    $targets = @()
    foreach ($match in [regex]::Matches($Text, '\[[^\]]*\]\(([^)]+)\)')) {
        $target = $match.Groups[1].Value.Trim().Trim('<').Trim('>')
        if (-not $target -or $target -match '^(?i:https?://|mailto:|#)') { continue }
        $targets += $target
    }
    $targets
}

function Test-CoreSpecialistRoot {
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @("Skills root does not exist: $Root")
    }

    $errors = @()
    foreach ($skill in $ExpectedSkills) {
        $dir = Join-Path $Root $skill
        $skillFile = Join-Path $dir 'SKILL.md'
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            $errors += "${skill}: expected folder is missing."
            continue
        }
        if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
            $errors += "${skill}: SKILL.md is missing."
            continue
        }

        try { $metadata = Get-SkillMetadata -SkillFile $skillFile }
        catch { $errors += "${skill}: $($_.Exception.Message)"; continue }

        if ($metadata.Name -ne $skill) { $errors += "${skill}: frontmatter name '$($metadata.Name)' does not match its folder." }
        if (-not $metadata.Name -or $metadata.Name.Length -gt 64 -or $metadata.Name -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
            $errors += "${skill}: invalid skill name syntax."
        }
        if ($metadata.Name -match '(?i:anthropic|claude)') { $errors += "${skill}: name contains a reserved word." }

        if (-not $metadata.Description) { $errors += "${skill}: description is missing or empty." }
        else {
            if ($metadata.Description.Length -gt 1024) { $errors += "${skill}: description exceeds 1024 characters." }
            if ($metadata.Description -match '<[^>]+>') { $errors += "${skill}: description contains an XML-like tag." }
            if ($metadata.Description -match '^(?i:I\s|I\x27m\s|I\x27ll\s|You\s|Your\s)') { $errors += "${skill}: description should use third-person discovery wording." }
            if ($metadata.Description -notmatch '(?i:\buse\b|\bwhen\b)') { $errors += "${skill}: description does not clearly state when to use the skill." }
        }

        if ($metadata.Lines.Count -gt 500) { $errors += "${skill}: SKILL.md exceeds 500 lines." }
        $raw = $metadata.Lines -join "`n"
        foreach ($target in @(Get-LocalMarkdownTargets -Text $raw)) {
            if ($target -match '\\') { $errors += "${skill}: markdown reference '$target' uses Windows-style backslashes." }
            $pathOnly = ($target -split '#', 2)[0]
            if ($pathOnly -match '(^|/)\.\./\.\./') { $errors += "${skill}: markdown reference '$target' traverses more than one parent level." }
        }

        $reparse = @(Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        $rootItem = Get-Item -LiteralPath $dir -Force
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $reparse.Count -gt 0) {
            $errors += "${skill}: symlinks/reparse points are forbidden in promoted candidates."
        }

        $forbiddenFiles = @(Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match '^(?i:\.env(?:\..+)?|\.npmrc|\.netrc|\.git-credentials)$' -or $_.FullName -match '(?i)[\\/]secrets?[\\/]'
        })
        if ($forbiddenFiles.Count -gt 0) { $errors += "${skill}: secret/credential-shaped files are forbidden in a promoted skill package." }
    }
    $errors
}

function New-ValidFixture {
    param([Parameter(Mandatory)][string]$Root)
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    foreach ($skill in $ExpectedSkills) {
        $dir = Join-Path $Root $skill
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        @"
---
name: $skill
description: Provides reviewed $skill guidance. Use when NEXUS explicitly admits this specialist for a bounded task.
---
# $skill

Follow the Goal Contract and return evidence to NEXUS.
"@ | Set-Content -LiteralPath (Join-Path $dir 'SKILL.md') -Encoding utf8
    }
}

function Invoke-SelfTest {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("nexus-core-specialist-gate-" + [guid]::NewGuid().ToString('N'))
    try {
        New-ValidFixture -Root $temp
        $validErrors = @(Test-CoreSpecialistRoot -Root $temp)
        if ($validErrors.Count -ne 0) { throw "Valid core-specialist fixture failed: $($validErrors -join '; ')" }

        $badFile = Join-Path (Join-Path $temp 'principal-architecture') 'SKILL.md'
        (Get-Content -LiteralPath $badFile -Raw).Replace('name: principal-architecture', 'name: wrong-name') | Set-Content -LiteralPath $badFile -Encoding utf8
        $badErrors = @(Test-CoreSpecialistRoot -Root $temp)
        if (($badErrors -join "`n") -notmatch 'does not match') { throw "Wrong-name fixture was not rejected: $($badErrors -join '; ')" }

        Write-Host 'PASS core specialist candidate quality-gate self-test.' -ForegroundColor Green
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($SelfTest) { Invoke-SelfTest; exit 0 }
if (-not $SkillsRoot) { throw 'Specify -SkillsRoot or use -SelfTest.' }

$errors = @(Test-CoreSpecialistRoot -Root $SkillsRoot)
if ($errors.Count -gt 0) {
    Write-Host 'Core specialist candidate quality gate FAILED' -ForegroundColor Red
    foreach ($item in $errors) { Write-Host " - $item" -ForegroundColor Red }
    throw "$($errors.Count) core specialist candidate quality error(s) detected."
}

Write-Host 'PASS core specialist candidate quality gate: all six exact specialists have valid bounded skill metadata, portable references, no reparse points, and no credential-shaped files.' -ForegroundColor Green
Write-Host 'This static gate does not prove live discovery/routing. Each specialist remains NOT READY until fresh-session model/runtime/safety evidence is recorded.'
