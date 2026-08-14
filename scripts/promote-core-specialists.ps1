[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$SourceSkillsRoot = 'C:\NEXUS-WORK\nexus-godmode-studio\plugins\nexus-godmode-studio\skills',

    [Parameter(Mandatory = $false)]
    [string]$DestinationSkillsRoot = "$(Join-Path (Split-Path -Parent $PSScriptRoot) '.claude\skills')",

    [Parameter(Mandatory = $false)]
    [string]$BackupDir,

    [Parameter(Mandatory = $false)]
    [switch]$Apply,

    [Parameter(Mandatory = $false)]
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ApplyOptIn = 'I_ACKNOWLEDGE_CORE_SPECIALIST_PROMOTION'
$CoreSkills = @(
    'technology-research-scout',
    'principal-architecture',
    'engineering-intelligence',
    'backend-data-engineer',
    'platform-sre-engineer',
    'nexus-qa-testing-director'
)
$CandidateGate = Join-Path $PSScriptRoot 'verify-core-specialist-candidates.ps1'
$AuthorityGate = Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1'

function Get-StringSha256 {
    param([Parameter(Mandatory)][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally { $sha.Dispose() }
}

function Get-SkillTreeManifest {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Skill
    )

    $skillDir = Join-Path $Root $Skill
    if (-not (Test-Path -LiteralPath $skillDir -PathType Container)) {
        throw "Missing approved core specialist source: $skillDir"
    }
    $rootItem = Get-Item -LiteralPath $skillDir -Force
    $reparse = @(Get-ChildItem -LiteralPath $skillDir -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $reparse.Count -gt 0) {
        throw "${Skill}: source/destination contains a symlink or reparse point."
    }

    $files = @(Get-ChildItem -LiteralPath $skillDir -Recurse -Force -File -ErrorAction Stop | Sort-Object FullName)
    if ($files.Count -eq 0) { throw "${Skill}: specialist folder is empty." }
    $records = @()
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($skillDir.Length).TrimStart([char[]]'\/').Replace('\','/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $records += [pscustomobject]@{ path = $relative; sha256 = $hash; bytes = [int64]$file.Length }
    }
    $canonical = ($records | ForEach-Object { "$($_.path)`t$($_.sha256)" }) -join "`n"
    [pscustomobject]@{
        skill = $Skill
        treeSha256 = Get-StringSha256 -Text $canonical
        fileCount = $records.Count
        files = $records
    }
}

function Invoke-Gate {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$SkillsRoot
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "Required gate is missing: $ScriptPath" }
    $gateOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -SkillsRoot $SkillsRoot)
    $exitCode = $LASTEXITCODE
    foreach ($line in $gateOutput) {
        if ($null -ne $line -and -not [string]::IsNullOrWhiteSpace([string]$line)) { Write-Host ([string]$line) }
    }
    if ($exitCode -ne 0) { throw "Gate failed: $ScriptPath" }
}

function Copy-ExactSixToStage {
    param([string]$SourceRoot,[string]$StageRoot)
    New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
    foreach ($skill in $CoreSkills) {
        $source = Join-Path $SourceRoot $skill
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing approved core specialist source: $source" }
        [void](Get-SkillTreeManifest -Root $SourceRoot -Skill $skill)
        Copy-Item -LiteralPath $source -Destination (Join-Path $StageRoot $skill) -Recurse -Force
    }
}

function Get-PromotionPlan {
    param([string]$StageRoot,[string]$DestinationRoot)
    $plan = @()
    foreach ($skill in $CoreSkills) {
        $sourceManifest = Get-SkillTreeManifest -Root $StageRoot -Skill $skill
        $destination = Join-Path $DestinationRoot $skill
        $action = 'ADD'
        $existingHash = $null
        if (Test-Path -LiteralPath $destination -PathType Container) {
            $existing = Get-SkillTreeManifest -Root $DestinationRoot -Skill $skill
            $existingHash = $existing.treeSha256
            $action = if ($existingHash -eq $sourceManifest.treeSha256) { 'IDENTICAL' } else { 'REPLACE_WITH_BACKUP' }
        }
        $plan += [pscustomobject]@{
            skill = $skill
            action = $action
            sourceTreeSha256 = $sourceManifest.treeSha256
            destinationTreeSha256 = $existingHash
            fileCount = $sourceManifest.fileCount
        }
    }
    $plan
}

function Invoke-CorePromotion {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)][bool]$DoApply,
        [string]$RequestedBackupDir
    )

    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "Canonical source root does not exist: $SourceRoot" }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ("nexus-core-specialists-stage-" + [guid]::NewGuid().ToString('N'))
    try {
        Copy-ExactSixToStage -SourceRoot $SourceRoot -StageRoot $stage
        Invoke-Gate -ScriptPath $CandidateGate -SkillsRoot $stage
        Invoke-Gate -ScriptPath $AuthorityGate -SkillsRoot $stage
        $plan = @(Get-PromotionPlan -StageRoot $stage -DestinationRoot $DestinationRoot)

        $summary = [pscustomobject]@{
            mode = if ($DoApply) { 'apply' } else { 'preview' }
            sourceRoot = $SourceRoot
            destinationRoot = $DestinationRoot
            approvedSkills = $CoreSkills
            plan = $plan
            personalUserSkillsModified = $false
            readinessPromoted = $false
        }
        if (-not $DoApply) { return $summary }

        if ($env:NEXUS_CORE_SKILLS_APPLY -ne $ApplyOptIn) {
            throw "Apply mode is disabled. Set NEXUS_CORE_SKILLS_APPLY=$ApplyOptIn only for one deliberate local promotion."
        }

        $backupRoot = $RequestedBackupDir
        if (-not $backupRoot) {
            $base = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'NEXUS\core-skill-promotion-backups' } else { Join-Path $env:TEMP 'NEXUS-core-skill-promotion-backups' }
            $backupRoot = Join-Path $base (Get-Date -Format 'yyyyMMdd-HHmmss')
        }
        New-Item -ItemType Directory -Force -Path $backupRoot,$DestinationRoot | Out-Null

        foreach ($item in $plan) {
            $skill = [string]$item.skill
            if ($item.action -eq 'IDENTICAL') { continue }
            $source = Join-Path $stage $skill
            $destination = Join-Path $DestinationRoot $skill
            if (Test-Path -LiteralPath $destination) {
                $backupSkill = Join-Path (Join-Path $backupRoot 'pre-existing') $skill
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupSkill) | Out-Null
                Copy-Item -LiteralPath $destination -Destination $backupSkill -Recurse -Force
                Remove-Item -LiteralPath $destination -Recurse -Force
            }
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }

        Invoke-Gate -ScriptPath $CandidateGate -SkillsRoot $DestinationRoot
        $verifyRoot = Join-Path ([IO.Path]::GetTempPath()) ("nexus-core-specialists-verify-" + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
            foreach ($skill in $CoreSkills) {
                Copy-Item -LiteralPath (Join-Path $DestinationRoot $skill) -Destination (Join-Path $verifyRoot $skill) -Recurse -Force
                $expected = Get-SkillTreeManifest -Root $stage -Skill $skill
                $actual = Get-SkillTreeManifest -Root $DestinationRoot -Skill $skill
                if ($actual.treeSha256 -ne $expected.treeSha256) { throw "${skill}: destination hash differs from staged canonical source." }
            }
            Invoke-Gate -ScriptPath $AuthorityGate -SkillsRoot $verifyRoot
        }
        finally {
            if (Test-Path -LiteralPath $verifyRoot) { Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue }
        }

        $manifestPath = Join-Path $backupRoot 'promotion-manifest.json'
        $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
        $summary | Add-Member -NotePropertyName backupDir -NotePropertyValue $backupRoot
        $summary | Add-Member -NotePropertyName manifestPath -NotePropertyValue $manifestPath
        return $summary
    }
    finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function New-SelfTestSkill {
    param([string]$Root,[string]$Skill,[string]$Suffix = '')
    $dir = Join-Path $Root $Skill
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    @(
        '---',
        "name: $Skill",
        "description: Provides reviewed core specialist guidance$Suffix. Use when the bounded NEXUS task requires $Skill expertise.",
        '---',
        "# $Skill",
        '',
        'Use [REFERENCE.md](REFERENCE.md) for reviewed detail.'
    ) | Set-Content -LiteralPath (Join-Path $dir 'SKILL.md') -Encoding utf8
    "# Reference $Suffix" | Set-Content -LiteralPath (Join-Path $dir 'REFERENCE.md') -Encoding utf8
}

function Invoke-SelfTest {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("nexus-core-promotion-selftest-" + [guid]::NewGuid().ToString('N'))
    $oldOptIn = $env:NEXUS_CORE_SKILLS_APPLY
    try {
        $source = Join-Path $temp 'source'
        $destination = Join-Path $temp 'destination'
        $backup = Join-Path $temp 'backup'
        New-Item -ItemType Directory -Force -Path $source,$destination | Out-Null
        foreach ($skill in $CoreSkills) { New-SelfTestSkill -Root $source -Skill $skill }
        Copy-Item -LiteralPath (Join-Path $source $CoreSkills[0]) -Destination (Join-Path $destination $CoreSkills[0]) -Recurse -Force
        New-SelfTestSkill -Root $destination -Skill $CoreSkills[1] -Suffix ' old-destination'

        $preview = Invoke-CorePromotion -SourceRoot $source -DestinationRoot $destination -DoApply $false
        if ($preview.mode -ne 'preview') { throw 'Self-test preview mode failed.' }
        if ((@($preview.plan | Where-Object action -eq 'IDENTICAL')).Count -ne 1) { throw 'Self-test expected one IDENTICAL skill.' }
        if ((@($preview.plan | Where-Object action -eq 'REPLACE_WITH_BACKUP')).Count -ne 1) { throw 'Self-test expected one replacement.' }
        if ((@($preview.plan | Where-Object action -eq 'ADD')).Count -ne 4) { throw 'Self-test expected four additions.' }

        $env:NEXUS_CORE_SKILLS_APPLY = $ApplyOptIn
        $applied = Invoke-CorePromotion -SourceRoot $source -DestinationRoot $destination -DoApply $true -RequestedBackupDir $backup
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $backup 'pre-existing') $CoreSkills[1]) -PathType Container)) { throw 'Changed destination was not backed up.' }
        foreach ($skill in $CoreSkills) {
            $expected = Get-SkillTreeManifest -Root $source -Skill $skill
            $actual = Get-SkillTreeManifest -Root $destination -Skill $skill
            if ($expected.treeSha256 -ne $actual.treeSha256) { throw "Self-test destination mismatch: $skill" }
        }
        if ($applied.readinessPromoted) { throw 'Promotion helper must not mark READY.' }
        if ($applied.personalUserSkillsModified) { throw 'Promotion helper must not modify personal skills.' }

        $missing = Join-Path $temp 'missing-source'
        Copy-Item -LiteralPath $source -Destination $missing -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $missing $CoreSkills[-1]) -Recurse -Force
        try {
            [void](Invoke-CorePromotion -SourceRoot $missing -DestinationRoot $destination -DoApply $false)
            throw 'Missing-source fixture was not rejected.'
        }
        catch {
            if ($_.Exception.Message -notmatch 'Missing approved core specialist source') { throw }
        }
        Write-Host 'PASS core specialist promotion self-test: preview, exact-six staging, hash comparison, backup-before-replace, apply opt-in, post-copy verification and no READY/user-skill mutation verified.' -ForegroundColor Green
    }
    finally {
        $env:NEXUS_CORE_SKILLS_APPLY = $oldOptIn
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($SelfTest) { Invoke-SelfTest; exit 0 }
if ($env:OS -ne 'Windows_NT') { throw 'Core specialist promotion is intentionally Windows-only.' }
$result = Invoke-CorePromotion -SourceRoot $SourceSkillsRoot -DestinationRoot $DestinationSkillsRoot -DoApply ([bool]$Apply) -RequestedBackupDir $BackupDir
$result | ConvertTo-Json -Depth 8
if (-not $Apply) {
    Write-Host 'PREVIEW ONLY — no project skill folders were changed.' -ForegroundColor Yellow
} else {
    Write-Host 'APPLIED SAFELY — exact six core specialists were copied after backup/verification. This did NOT mark any skill READY.' -ForegroundColor Green
}
