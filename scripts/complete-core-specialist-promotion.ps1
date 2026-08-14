[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$SourceSkillsRoot = 'C:\NEXUS-WORK\nexus-godmode-studio\plugins\nexus-godmode-studio\skills',

    [Parameter(Mandatory = $false)]
    [string]$BackupDir,

    [Parameter(Mandatory = $false)]
    [switch]$Apply,

    [Parameter(Mandatory = $false)]
    [switch]$SkipFullLaptopVerification
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DestinationSkillsRoot = Join-Path (Join-Path $RepoRoot '.claude') 'skills'
$PromotionHelper = Join-Path $PSScriptRoot 'promote-core-specialists.ps1'
$CandidateGate = Join-Path $PSScriptRoot 'verify-core-specialist-candidates.ps1'
$AuthorityGate = Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1'
$LaptopVerifier = Join-Path $PSScriptRoot 'windows-laptop-verify.ps1'
$OuterApplyOptIn = 'I_ACKNOWLEDGE_CORE_SPECIALIST_PROJECT_PROMOTION'
$InnerApplyOptIn = 'I_ACKNOWLEDGE_CORE_SPECIALIST_PROMOTION'
$CapabilityApplyOptIn = 'I_ACKNOWLEDGE_CORE_SPECIALIST_CAPABILITY_REGISTRATION'
$CoreSkills = @(
    'technology-research-scout',
    'principal-architecture',
    'engineering-intelligence',
    'backend-data-engineer',
    'platform-sre-engineer',
    'nexus-qa-testing-director'
)

function Write-Step([string]$Message) { Write-Host "[NEXUS CORE SPECIALISTS COMPLETE] $Message" }

function Get-StringSha256 {
    param([Parameter(Mandatory)][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally { $sha.Dispose() }
}

function Get-SkillTreeSha256 {
    param([Parameter(Mandatory)][string]$SkillDir)
    $resolved = (Resolve-Path -LiteralPath $SkillDir).Path
    $files = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -File -ErrorAction Stop | Sort-Object FullName)
    if ($files.Count -eq 0) { throw "Candidate folder contains no files: $SkillDir" }
    $entries = @()
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($resolved.Length).TrimStart([char[]]'\/').Replace('\','/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $entries += "$relative`t$hash"
    }
    Get-StringSha256 -Text ($entries -join "`n")
}

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Command)
    Write-Step $Name
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

if ($env:OS -ne 'Windows_NT') { throw 'Core specialist promotion is intentionally Windows-host only.' }
if (-not (Test-Path -LiteralPath $SourceSkillsRoot -PathType Container)) { throw "Canonical core specialist source root not found: $SourceSkillsRoot" }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is required.' }
if ($Apply -and $env:NEXUS_CORE_SPECIALIST_PROMOTION_APPLY -ne $OuterApplyOptIn) {
    throw "Apply mode is disabled. Set NEXUS_CORE_SPECIALIST_PROMOTION_APPLY=$OuterApplyOptIn only for one deliberate local promotion."
}

$ResolvedSource = (Resolve-Path -LiteralPath $SourceSkillsRoot).Path
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nexus-core-specialists-complete-" + [guid]::NewGuid().ToString('N'))
$StageRoot = Join-Path $TempRoot 'stage'
$CapabilityManifest = Join-Path $TempRoot 'core-specialist-capabilities.json'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $BackupDir) {
    $backupBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'NEXUS\core-skill-promotion-backups' } else { Join-Path $env:TEMP 'NEXUS-core-skill-promotion-backups' }
    $BackupDir = Join-Path $backupBase $Timestamp
}
$CapabilityBackupDir = Join-Path $BackupDir 'capability-backups'

try {
    New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null

    Invoke-Checked -Name 'Validating exact six canonical source candidates' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CandidateGate -SkillsRoot $ResolvedSource
    }

    $candidates = @()
    foreach ($skill in $CoreSkills) {
        $source = Join-Path $ResolvedSource $skill
        $rootItem = Get-Item -LiteralPath $source -Force
        $nestedReparse = @(Get-ChildItem -LiteralPath $source -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $nestedReparse.Count -gt 0) {
            throw "$skill contains a symlink/reparse point. Refusing promotion."
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $StageRoot $skill) -Recurse -Force
        $treeSha = Get-SkillTreeSha256 -SkillDir $source
        $candidates += [ordered]@{
            name = $skill
            source = (Resolve-Path -LiteralPath $source).Path
            sourceSha256 = $treeSha
            version = "candidate-$($treeSha.Substring(0,12))"
        }
    }

    Invoke-Checked -Name 'Running hidden-authority gate on exact staged candidates' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AuthorityGate -SkillsRoot $StageRoot
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        sourceRoot = $ResolvedSource
        candidates = $candidates
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $CapabilityManifest -Encoding utf8

    Write-Host ''
    Write-Step 'FILE PROMOTION PREVIEW'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PromotionHelper -SourceSkillsRoot $ResolvedSource -DestinationSkillsRoot $DestinationSkillsRoot
    if ($LASTEXITCODE -ne 0) { throw 'Core specialist file-promotion preview failed.' }

    Write-Host ''
    Write-Step 'CAPABILITY REGISTRATION PREVIEW'
    & npm.cmd run core-specialists:capabilities -- --manifest $CapabilityManifest
    if ($LASTEXITCODE -ne 0) { throw 'Core specialist capability-registration preview failed.' }

    if (-not $Apply) {
        Write-Host ''
        Write-Step 'PREVIEW ONLY — no project skill files or NEXUS capability state were mutated.'
        Write-Step "To apply: set NEXUS_CORE_SPECIALIST_PROMOTION_APPLY=$OuterApplyOptIn and rerun this same command with -Apply."
        Write-Step 'Apply preserves/reports prior project-local copies and never modifies personal/user Claude skill copies.'
        exit 0
    }

    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    Copy-Item -LiteralPath $CapabilityManifest -Destination (Join-Path $BackupDir 'core-specialist-capability-manifest.json') -Force

    $oldInner = $env:NEXUS_CORE_SKILLS_APPLY
    try {
        $env:NEXUS_CORE_SKILLS_APPLY = $InnerApplyOptIn
        Invoke-Checked -Name 'Applying exact-six project-local file promotion with backup' -Command {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PromotionHelper -SourceSkillsRoot $ResolvedSource -DestinationSkillsRoot $DestinationSkillsRoot -BackupDir $BackupDir -Apply
        }
    }
    finally { $env:NEXUS_CORE_SKILLS_APPLY = $oldInner }

    Invoke-Checked -Name 'Revalidating promoted candidates' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CandidateGate -SkillsRoot $DestinationSkillsRoot
    }
    Invoke-Checked -Name 'Revalidating all project-local skills for hidden authority' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AuthorityGate -SkillsRoot $DestinationSkillsRoot
    }

    foreach ($candidate in $candidates) {
        $installedHash = Get-SkillTreeSha256 -SkillDir (Join-Path $DestinationSkillsRoot $candidate.name)
        if ($installedHash -ne $candidate.sourceSha256) { throw "Installed source hash mismatch for $($candidate.name)." }
    }

    $oldCapability = $env:NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY
    try {
        $env:NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY = $CapabilityApplyOptIn
        Invoke-Checked -Name 'Registering missing specialist capabilities as PACKAGED candidates only' -Command {
            & npm.cmd run core-specialists:capabilities -- --manifest $CapabilityManifest --apply --backup-dir $CapabilityBackupDir
        }
    }
    finally { $env:NEXUS_CORE_SPECIALIST_CAPABILITY_APPLY = $oldCapability }

    Invoke-Checked -Name 'Verifying capability-backed Claude skill admission after promotion' -Command { & npm.cmd run verify:claude-skill-admission }

    if (-not $SkipFullLaptopVerification) {
        Invoke-Checked -Name 'Running full Windows NEXUS verification after promotion' -Command {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $LaptopVerifier -SkipInstall
        }
    }

    Write-Host ''
    Write-Step 'PROMOTION COMPLETION: PASS'
    Write-Step 'Exactly six project-local specialist candidates are byte/hash traced to the canonical source.'
    Write-Step 'Missing capability records were created only as PACKAGED and remain NOT READY until fresh live discovery/routing/model/runtime/safety evidence is recorded.'
    Write-Step "Backup and source/capability manifest evidence: $BackupDir"
    Write-Step 'Personal/user Claude skill copies were not changed.'
    Write-Step 'NEXT: fresh-session Sonnet discovery/routing/negative/collision tests plus the critical Opus subset, then record READY evidence individually per specialist.'
}
finally {
    if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
