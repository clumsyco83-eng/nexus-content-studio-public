param(
    [Parameter(Mandatory = $false)]
    [string]$ZipPath = "$(Join-Path (Split-Path -Parent $PSScriptRoot) 'nexus-intelligence-foundation-v1.0.0.zip')",

    [Parameter(Mandatory = $false)]
    [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ClaudeRoot = Join-Path $RepoRoot '.claude'
$SkillsRoot = Join-Path $ClaudeRoot 'skills'
$BackupRoot = Join-Path $ClaudeRoot 'skills-backup'
$ExpectedPackageRoot = 'intelligence-skills'
$ExpectedZipSha256 = 'a4b546a141b8c9f163a84c607a9bc9210c39aa9a87b86aba20ce00311a01eba6'
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

function Write-Step([string]$Message) {
    Write-Host "[NEXUS INTELLIGENCE] $Message"
}

function Read-SkillName([string]$SkillFile) {
    $lines = Get-Content -LiteralPath $SkillFile -TotalCount 30
    $nameLine = $lines | Where-Object { $_ -match '^name:\s*(.+?)\s*$' } | Select-Object -First 1
    if (-not $nameLine) {
        throw "Missing YAML frontmatter name in $SkillFile"
    }
    return ($Matches[1]).Trim()
}

if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "ZIP not found: $ZipPath`nPlace nexus-intelligence-foundation-v1.0.0.zip in the repository root or pass -ZipPath with its full path."
}

$ResolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path
$ActualZipSha256 = (Get-FileHash -LiteralPath $ResolvedZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualZipSha256 -ne $ExpectedZipSha256) {
    throw "Intelligence Foundation package SHA-256 mismatch.`nExpected: $ExpectedZipSha256`nActual:   $ActualZipSha256`nRefusing to install a same-named but unverified package."
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nexus-intelligence-" + [Guid]::NewGuid().ToString('N'))
$ExtractRoot = Join-Path $TempRoot 'extract'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRunRoot = Join-Path $BackupRoot $Timestamp

try {
    Write-Step "Repository: $RepoRoot"
    Write-Step "Package: $ResolvedZip"
    Write-Step "SHA-256 verified: $ActualZipSha256"

    New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null
    Expand-Archive -LiteralPath $ResolvedZip -DestinationPath $ExtractRoot -Force

    $PackageRoot = Join-Path $ExtractRoot $ExpectedPackageRoot
    if (-not (Test-Path -LiteralPath $PackageRoot -PathType Container)) {
        throw "Package root '$ExpectedPackageRoot' was not found inside the ZIP."
    }

    foreach ($required in @('README.md', 'MANIFEST.md', 'SHARED-PRINCIPLES.md')) {
        $requiredPath = Join-Path $PackageRoot $required
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required package file is missing: $required"
        }
    }

    $SkillDirs = Get-ChildItem -LiteralPath $PackageRoot -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf
    }

    if ($SkillDirs.Count -ne 8) {
        throw "Expected exactly 8 skill folders, found $($SkillDirs.Count)."
    }

    $ResolvedSkills = @{}
    foreach ($dir in $SkillDirs) {
        $skillFile = Join-Path $dir.FullName 'SKILL.md'
        $testsFile = Join-Path $dir.FullName 'TESTS.md'
        if (-not (Test-Path -LiteralPath $testsFile -PathType Leaf)) {
            throw "Missing TESTS.md in $($dir.Name)"
        }

        $skillName = Read-SkillName -SkillFile $skillFile
        if ($ResolvedSkills.ContainsKey($skillName)) {
            throw "Duplicate skill name '$skillName' in package."
        }
        $ResolvedSkills[$skillName] = $dir.FullName
    }

    foreach ($expected in $ExpectedSkills) {
        if (-not $ResolvedSkills.ContainsKey($expected)) {
            throw "Expected skill '$expected' is missing from package."
        }
    }

    New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null

    if (-not $NoBackup) {
        New-Item -ItemType Directory -Force -Path $BackupRunRoot | Out-Null
    }

    foreach ($skillName in $ExpectedSkills) {
        $source = $ResolvedSkills[$skillName]
        $destination = Join-Path $SkillsRoot $skillName

        if (Test-Path -LiteralPath $destination) {
            if (-not $NoBackup) {
                Write-Step "Backing up existing $skillName"
                Copy-Item -LiteralPath $destination -Destination (Join-Path $BackupRunRoot $skillName) -Recurse -Force
            }
            Remove-Item -LiteralPath $destination -Recurse -Force
        }

        Write-Step "Installing $skillName"
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }

    Copy-Item -LiteralPath (Join-Path $PackageRoot 'SHARED-PRINCIPLES.md') -Destination (Join-Path $SkillsRoot 'SHARED-PRINCIPLES.md') -Force

    $FoundationDocs = Join-Path $SkillsRoot '_intelligence-foundation'
    New-Item -ItemType Directory -Force -Path $FoundationDocs | Out-Null
    Copy-Item -LiteralPath (Join-Path $PackageRoot 'README.md') -Destination (Join-Path $FoundationDocs 'README.md') -Force
    Copy-Item -LiteralPath (Join-Path $PackageRoot 'MANIFEST.md') -Destination (Join-Path $FoundationDocs 'MANIFEST.md') -Force

    foreach ($skillName in $ExpectedSkills) {
        $installedSkill = Join-Path (Join-Path $SkillsRoot $skillName) 'SKILL.md'
        $installedTests = Join-Path (Join-Path $SkillsRoot $skillName) 'TESTS.md'
        if (-not (Test-Path -LiteralPath $installedSkill -PathType Leaf)) { throw "Post-install verification failed: $installedSkill missing." }
        if (-not (Test-Path -LiteralPath $installedTests -PathType Leaf)) { throw "Post-install verification failed: $installedTests missing." }
        $installedName = Read-SkillName -SkillFile $installedSkill
        if ($installedName -ne $skillName) { throw "Post-install verification failed: folder '$skillName' contains skill '$installedName'." }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $SkillsRoot 'SHARED-PRINCIPLES.md') -PathType Leaf)) {
        throw 'Post-install verification failed: SHARED-PRINCIPLES.md missing.'
    }

    Write-Host ''
    Write-Step 'INSTALL FILE COPY: PASS'
    Write-Step "Installed 8 project-local skills under $SkillsRoot"
    if (-not $NoBackup) { Write-Step "Backup location (if replacements existed): $BackupRunRoot" }
    Write-Step 'No credentials, account permissions, publishing settings, Guardian/Watchdog controls, or runtime adapters were changed.'
    Write-Host ''
    Write-Step 'NEXT: open Claude Code at the repository root, confirm all 8 skills are discovered/routed, then complete issue #6 live-host verification.'
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
