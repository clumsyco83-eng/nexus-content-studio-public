[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$SkillsRoot,

    [Parameter(Mandatory = $false)]
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ForbiddenFrontmatter = @(
    'allowed-tools',
    'disallowed-tools',
    'model',
    'effort',
    'context',
    'agent',
    'background',
    'hooks',
    'shell'
)

function Get-Frontmatter {
    param([Parameter(Mandatory)][string]$SkillFile)

    $lines = @(Get-Content -LiteralPath $SkillFile)
    if ($lines.Count -lt 3 -or $lines[0].Trim() -ne '---') {
        throw "SKILL.md must start with YAML frontmatter: $SkillFile"
    }
    $closing = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { $closing = $i; break }
    }
    if ($closing -lt 0) { throw "SKILL.md frontmatter is not closed: $SkillFile" }
    [pscustomobject]@{
        Lines = $lines
        Front = if ($closing -gt 1) { @($lines[1..($closing - 1)]) } else { @() }
    }
}

function Test-TruthyFrontmatter {
    param([string[]]$Front, [string]$Field)
    $pattern = '^(?i:' + [regex]::Escape($Field) + ')\s*:\s*(.+?)\s*$'
    foreach ($line in $Front) {
        $match = [regex]::Match($line, $pattern)
        if (-not $match.Success) { continue }
        $value = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
        return $value -match '^(?i:true|yes|on|1)$'
    }
    return $false
}

function Test-SkillAuthority {
    param([Parameter(Mandatory)][string]$SkillFile)

    $errors = @()
    $metadata = Get-Frontmatter -SkillFile $SkillFile
    $frontText = @($metadata.Front) -join "`n"
    $raw = @($metadata.Lines) -join "`n"
    $skillDir = Split-Path -Parent $SkillFile
    $skillName = Split-Path -Leaf $skillDir

    foreach ($field in $ForbiddenFrontmatter) {
        if ($frontText -match ('(?im)^' + [regex]::Escape($field) + '\s*:')) {
            $errors += "${skillName}: '$field' frontmatter is forbidden for NEXUS-managed skills; the Goal Contract/execution envelope owns runtime authority, model, effort, hooks and subagent behavior."
        }
    }

    if (Test-TruthyFrontmatter -Front $metadata.Front -Field 'disable-model-invocation') {
        $errors += "${skillName}: disable-model-invocation=true is incompatible with NEXUS exact Skill(name) task admission."
    }

    if ([regex]::IsMatch($raw, '!`[^`\r\n]+`')) {
        $errors += "${skillName}: inline dynamic shell context injection is forbidden."
    }
    if ([regex]::IsMatch($raw, '(?ms)^\s*```!\s*\r?\n.*?^\s*```\s*$')) {
        $errors += "${skillName}: fenced dynamic shell context injection is forbidden."
    }

    $pluginManifest = Join-Path (Join-Path $skillDir '.claude-plugin') 'plugin.json'
    if (Test-Path -LiteralPath $pluginManifest -PathType Leaf) {
        $errors += "${skillName}: embedded plugin manifest is forbidden."
    }
    foreach ($reservedDir in @('hooks', 'agents')) {
        if (Test-Path -LiteralPath (Join-Path $skillDir $reservedDir) -PathType Container) {
            $errors += "${skillName}: embedded '$reservedDir' directory is forbidden."
        }
    }
    $mcpFiles = @(Get-ChildItem -LiteralPath $skillDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)(^\.mcp\.json$|\.mcp\.json$)' })
    if ($mcpFiles.Count -gt 0) {
        $errors += "${skillName}: embedded MCP configuration is forbidden."
    }

    $reparseItems = @(Get-ChildItem -LiteralPath $skillDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    $rootItem = Get-Item -LiteralPath $skillDir -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $reparseItems.Count -gt 0) {
        $errors += "${skillName}: symlinks/reparse points are forbidden in NEXUS-managed skills; reviewed content must be pinned inside the package tree."
    }

    return $errors
}

function Invoke-SelfTest {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("nexus-skill-authority-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Force -Path $temp | Out-Null
        $valid = Join-Path $temp 'valid-skill'
        New-Item -ItemType Directory -Force -Path $valid | Out-Null
        @'
---
name: valid-skill
description: Provides reviewed deterministic guidance. Use when testing the NEXUS skill authority gate.
---
# Valid Skill
Read references and follow the bounded task contract.
'@ | Set-Content -LiteralPath (Join-Path $valid 'SKILL.md') -Encoding utf8
        $validErrors = @(Test-SkillAuthority -SkillFile (Join-Path $valid 'SKILL.md'))
        if ($validErrors.Count -ne 0) { throw "Valid fixture failed: $($validErrors -join '; ')" }

        $fencedShellFixture = @'
```!
Get-ChildItem Env:\
```
'@

        $cases = @(
            @{ Name = 'allowed-tools'; Front = 'allowed-tools: Bash(*)'; Body = 'No shell body.' },
            @{ Name = 'disallowed-tools'; Front = 'disallowed-tools: Read'; Body = 'No shell body.' },
            @{ Name = 'model'; Front = 'model: opus'; Body = 'No shell body.' },
            @{ Name = 'effort'; Front = 'effort: max'; Body = 'No shell body.' },
            @{ Name = 'context'; Front = 'context: fork'; Body = 'No shell body.' },
            @{ Name = 'agent'; Front = 'agent: Explore'; Body = 'No shell body.' },
            @{ Name = 'background'; Front = 'background: true'; Body = 'No shell body.' },
            @{ Name = 'hooks'; Front = 'hooks: {}'; Body = 'No shell body.' },
            @{ Name = 'shell'; Front = 'shell: powershell'; Body = 'No shell body.' },
            @{ Name = 'disable-model'; Front = 'disable-model-invocation: true'; Body = 'No shell body.' },
            @{ Name = 'inline-shell'; Front = ''; Body = 'Context: !`git status`' },
            @{ Name = 'fenced-shell'; Front = ''; Body = $fencedShellFixture }
        )

        foreach ($case in $cases) {
            $dir = Join-Path $temp ("bad-" + $case.Name)
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            @(
                '---',
                "name: bad-$($case.Name)",
                'description: Provides an invalid authority fixture. Use when self-testing rejection.',
                $case.Front,
                '---',
                '# Fixture',
                $case.Body
            ) | Where-Object { $_ -ne '' } | Set-Content -LiteralPath (Join-Path $dir 'SKILL.md') -Encoding utf8
            $errors = @(Test-SkillAuthority -SkillFile (Join-Path $dir 'SKILL.md'))
            if ($errors.Count -eq 0) { throw "Authority fixture was not rejected: $($case.Name)" }
        }
        Write-Host 'PASS Claude skill authority self-test: authority/model/effort/subagent/hooks/shell/dynamic-context overrides are rejected.' -ForegroundColor Green
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

if ([string]::IsNullOrWhiteSpace($SkillsRoot)) {
    $scriptRoot = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptRoot)) {
        $scriptPath = $MyInvocation.MyCommand.Path
        if ([string]::IsNullOrWhiteSpace($scriptPath)) {
            throw 'Cannot resolve the NEXUS script root for the default Claude skills path.'
        }
        $scriptRoot = Split-Path -Parent $scriptPath
    }
    $repoRoot = Split-Path -Parent $scriptRoot
    if ([string]::IsNullOrWhiteSpace($repoRoot)) {
        throw 'Cannot resolve the NEXUS repository root for the default Claude skills path.'
    }
    $SkillsRoot = Join-Path $repoRoot '.claude\skills'
}

if (-not (Test-Path -LiteralPath $SkillsRoot -PathType Container)) {
    throw "Skills root does not exist: $SkillsRoot"
}

$skillFiles = @(Get-ChildItem -LiteralPath $SkillsRoot -Recurse -File -Filter 'SKILL.md' -ErrorAction Stop)
if ($skillFiles.Count -eq 0) { throw "No SKILL.md files found under: $SkillsRoot" }

$allErrors = @()
foreach ($skillFile in $skillFiles) {
    try {
        $allErrors += @(Test-SkillAuthority -SkillFile $skillFile.FullName)
    }
    catch {
        $allErrors += "$(Split-Path -Leaf (Split-Path -Parent $skillFile.FullName)): $($_.Exception.Message)"
    }
}

if ($allErrors.Count -gt 0) {
    Write-Host 'Claude skill authority gate FAILED' -ForegroundColor Red
    foreach ($item in $allErrors) { Write-Host " - $item" -ForegroundColor Red }
    throw "$($allErrors.Count) skill authority error(s) detected."
}

Write-Host "PASS Claude skill authority gate: $($skillFiles.Count) reviewed skill file(s) contain no hidden runtime/model/subagent/shell authority." -ForegroundColor Green
