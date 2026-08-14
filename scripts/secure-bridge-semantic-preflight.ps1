[CmdletBinding()]
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedRemoteFragment = 'clumsyco83-eng/nexus-content-studio'
$HistoricalPrerequisites = @(
    @{ Sha = 'f37e546'; Label = 'Secure Bridge V1 verified baseline' },
    @{ Sha = '2f2c1ad'; Label = 'Secure Bridge V1.1 read-only controller verified' }
)
$VerifiedIncremental = @(
    @{ Sha = '19b8038'; Label = 'Secure Bridge V1.1 provider diagnostics hardening' },
    @{ Sha = 'c336f44'; Label = 'Secure Bridge V1.2 controlled orchestration' },
    @{ Sha = 'f6f91bb'; Label = 'Secure Bridge V1.3 remote job trigger' },
    @{ Sha = 'e33bfe4'; Label = 'bounded Claude job enablement' },
    @{ Sha = '22aefd5'; Label = 'deterministic acceptance criteria hardening' }
)

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    if ($exitCode -ne 0) { throw "git $($Arguments -join ' ') failed:`n$($output | Out-String)" }
    return $output
}

function Test-IsAncestor {
    param([Parameter(Mandatory)][string]$Ancestor, [Parameter(Mandatory)][string]$Descendant)
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & git merge-base --is-ancestor $Ancestor $Descendant 2>$null
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    if ($exitCode -eq 0) { return $true }
    if ($exitCode -eq 1) { return $false }
    throw "git merge-base --is-ancestor failed with exit code $exitCode."
}

if ($SelfTest) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required for self-test.' }
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('nexus-semantic-preflight-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Push-Location $root
    try {
        Invoke-Git init | Out-Null
        Invoke-Git config user.email 'nexus-ci@example.invalid' | Out-Null
        Invoke-Git config user.name 'NEXUS CI' | Out-Null
        Set-Content base.txt 'base' -Encoding ASCII
        Invoke-Git add base.txt | Out-Null
        Invoke-Git commit -m base | Out-Null
        $base = (Invoke-Git rev-parse HEAD | Out-String).Trim()
        Invoke-Git switch -c bridge-history | Out-Null
        Set-Content bridge.txt 'bridge' -Encoding ASCII
        Invoke-Git add bridge.txt | Out-Null
        Invoke-Git commit -m bridge | Out-Null
        $bridge = (Invoke-Git rev-parse HEAD | Out-String).Trim()
        Invoke-Git switch -c hardened $base | Out-Null
        Set-Content hardened.txt 'hardened' -Encoding ASCII
        Invoke-Git add hardened.txt | Out-Null
        Invoke-Git commit -m hardened | Out-Null
        $hardened = (Invoke-Git rev-parse HEAD | Out-String).Trim()
        if (Test-IsAncestor -Ancestor $bridge -Descendant $hardened) { throw 'Self-test expected diverged histories.' }
        Write-Host 'PASS Secure Bridge semantic preflight detects a diverged prerequisite history.' -ForegroundColor Green
        $global:LASTEXITCODE = 0
    }
    finally {
        Pop-Location
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

if ($env:OS -ne 'Windows_NT') { throw 'Run this preflight on the real Windows NEXUS checkout.' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $RepoRoot
try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not available in PATH.' }
    $inside = (& git rev-parse --is-inside-work-tree 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $inside -ne 'true') { throw "$RepoRoot is not a Git worktree." }

    $dirty = (& git status --porcelain=v1 --untracked-files=all | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
    if ($dirty) { throw "Working tree is not clean. Resolve/abort current Git operation first.`n$dirty" }

    $gitDir = (Invoke-Git rev-parse --git-dir | Out-String).Trim()
    if (Test-Path -LiteralPath (Join-Path (Resolve-Path $gitDir).Path 'CHERRY_PICK_HEAD')) {
        throw "A cherry-pick is in progress. Abort or resolve it before semantic reconciliation preflight. For the known 19b8038 conflict, run 'git cherry-pick --abort'."
    }

    $remote = (Invoke-Git remote get-url origin | Out-String).Trim()
    if ($remote -notlike "*$ExpectedRemoteFragment*") { throw "Unexpected origin remote: $remote" }

    foreach ($item in @($HistoricalPrerequisites + $VerifiedIncremental)) {
        $resolved = (& git rev-parse --verify "$($item.Sha)^{commit}" 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $resolved) { throw "Required historical commit missing: $($item.Sha) - $($item.Label)." }
        Write-Host "FOUND $((Invoke-Git show -s --format='%h %s' $resolved | Out-String).Trim())" -ForegroundColor Green
    }

    Invoke-Git fetch origin 'refs/heads/main:refs/remotes/origin/main' --prune | Out-Null
    $originMain = (Invoke-Git rev-parse origin/main | Out-String).Trim()
    Write-Host "origin/main: $originMain" -ForegroundColor Green

    $prerequisiteTip = $HistoricalPrerequisites[-1].Sha
    $directCherryPickSafe = Test-IsAncestor -Ancestor $prerequisiteTip -Descendant 'origin/main'
    $hasRuntimeCycle = Test-Path -LiteralPath (Join-Path $RepoRoot 'src/orchestration/runtime-cycle.ts')
    $hasLegacyComputerAgent = Test-Path -LiteralPath (Join-Path $RepoRoot 'src/computer-agent')

    Write-Host "`nSecure Bridge history assessment" -ForegroundColor Cyan
    Write-Host "Historical prerequisite tip: $prerequisiteTip"
    Write-Host "Prerequisite is ancestor of origin/main: $directCherryPickSafe"
    Write-Host "Current runRuntimeCycle kernel present: $hasRuntimeCycle"
    Write-Host "Legacy src/computer-agent present: $hasLegacyComputerAgent"

    if (-not $directCherryPickSafe) {
        Write-Host "`nSEMANTIC RECONCILIATION REQUIRED - DIRECT CHERRY-PICK MUST NOT RUN" -ForegroundColor Yellow
        Write-Host 'The five verified commits are incremental on a bridge baseline that is not in current main.'
        Write-Host 'Preserve the exact commits as evidence, but port their safety properties onto the current NEXUS runtime-cycle/capability/approval architecture.'
        Write-Host 'Do not resurrect a second queue, second approval store, deleted Computer Agent subsystem, or parallel source of truth.'
        exit 0
    }

    Write-Host "`nDIRECT-CHERRY-PICK PREREQUISITE PRESENT" -ForegroundColor Green
    Write-Host 'The historical prerequisite is already an ancestor of origin/main. A normal reconciliation review may proceed, subject to all other safety gates.'
}
finally { Pop-Location }
