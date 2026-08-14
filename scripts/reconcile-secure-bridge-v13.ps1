[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$RunSafeVerification,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'Secure Bridge reconciliation must run on the real Windows NEXUS checkout.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ExpectedRemoteFragment = 'clumsyco83-eng/nexus-content-studio'
$HistoricalPrerequisites = @(
    @{ Sha = 'f37e546'; Label = 'Secure Bridge V1 verified baseline' },
    @{ Sha = '2f2c1ad'; Label = 'Secure Bridge V1.1 read-only controller verified' }
)
$VerifiedCommits = @(
    @{ Sha = '19b8038'; Label = 'Secure Bridge V1.1 provider diagnostics hardening' },
    @{ Sha = 'c336f44'; Label = 'Secure Bridge V1.2 controlled orchestration' },
    @{ Sha = 'f6f91bb'; Label = 'Secure Bridge V1.3 remote job trigger' },
    @{ Sha = 'e33bfe4'; Label = 'bounded Claude job enablement' },
    @{ Sha = '22aefd5'; Label = 'deterministic acceptance criteria hardening' }
)

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    # Windows PowerShell 5.1 can promote native stderr merged with 2>&1 into
    # NativeCommandError records. Git uses stderr for benign status messages,
    # so trust LASTEXITCODE and keep ErrorActionPreference non-terminating only
    # for the native git invocation itself.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed:`n$($output | Out-String)"
    }
    return $output
}

function Test-IsAncestor {
    param(
        [Parameter(Mandatory)][string]$Ancestor,
        [Parameter(Mandatory)][string]$Descendant
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & git merge-base --is-ancestor $Ancestor $Descendant 2>$null
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    # Exit 1 is the documented false result, not an execution failure. Clear
    # LASTEXITCODE after handling it so Windows PowerShell does not leak a
    # successful semantic decision as a failing process exit.
    if ($exitCode -eq 0) {
        $global:LASTEXITCODE = 0
        return $true
    }
    if ($exitCode -eq 1) {
        $global:LASTEXITCODE = 0
        return $false
    }
    throw "git merge-base --is-ancestor failed with exit code $exitCode."
}

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

if ($SelfTest) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'git is not available in PATH for Secure Bridge helper self-test.'
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nexus-reconcile-selftest-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Push-Location $tempRoot
    try {
        Invoke-Git init | Out-Null
        Invoke-Git config user.email 'nexus-ci@example.invalid' | Out-Null
        Invoke-Git config user.name 'NEXUS CI' | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot 'base.txt') -Value 'base' -Encoding ASCII
        Invoke-Git add base.txt | Out-Null
        Invoke-Git commit -m 'base' | Out-Null
        $base = (Invoke-Git rev-parse HEAD | Out-String).Trim()

        Invoke-Git switch --create bridge-history | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot 'bridge.txt') -Value 'bridge' -Encoding ASCII
        Invoke-Git add bridge.txt | Out-Null
        Invoke-Git commit -m 'bridge prerequisite' | Out-Null
        $bridgeTip = (Invoke-Git rev-parse HEAD | Out-String).Trim()

        Invoke-Git switch --create hardened $base | Out-Null
        Set-Content -LiteralPath (Join-Path $tempRoot 'hardened.txt') -Value 'hardened' -Encoding ASCII
        Invoke-Git add hardened.txt | Out-Null
        Invoke-Git commit -m 'hardened' | Out-Null
        $hardenedTip = (Invoke-Git rev-parse HEAD | Out-String).Trim()

        if (Test-IsAncestor -Ancestor $bridgeTip -Descendant $hardenedTip) {
            throw 'Secure Bridge helper self-test expected diverged histories.'
        }
        if (-not (Test-IsAncestor -Ancestor $base -Descendant $hardenedTip)) {
            throw 'Secure Bridge helper self-test expected the base to remain an ancestor.'
        }
        Write-Host 'PASS Secure Bridge helper native git handling and direct-cherry-pick divergence guard on Windows PowerShell 5.1.' -ForegroundColor Green
    }
    finally {
        Pop-Location
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

Push-Location $RepoRoot
try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not available in PATH.' }

    $inside = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $inside -ne 'true') { throw "$RepoRoot is not a Git worktree." }

    $remote = (Invoke-Git remote get-url origin | Out-String).Trim()
    if ($remote -notlike "*$ExpectedRemoteFragment*") {
        throw "Unexpected origin remote: $remote. Expected repository containing '$ExpectedRemoteFragment'."
    }

    $dirty = (& git status --porcelain=v1 --untracked-files=all | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
    if ($dirty) {
        throw "Working tree is not clean. Preserve/stash/review local work before reconciliation.`n$dirty"
    }

    $gitDir = (Invoke-Git rev-parse --git-dir | Out-String).Trim()
    $cherryPickHead = Join-Path (Resolve-Path $gitDir).Path 'CHERRY_PICK_HEAD'
    if (Test-Path -LiteralPath $cherryPickHead) {
        throw 'A cherry-pick is already in progress. Resolve or abort it before running this helper.'
    }

    Write-Host "Repository: $RepoRoot" -ForegroundColor Green
    Write-Host "Origin:     $remote" -ForegroundColor Green
    Write-Host "`nChecking the exact historical Secure Bridge evidence from issue #10..." -ForegroundColor Cyan

    foreach ($item in @($HistoricalPrerequisites + $VerifiedCommits)) {
        $resolved = (& git rev-parse --verify "$($item.Sha)^{commit}" 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $resolved) {
            throw "Required historical Secure Bridge commit is missing: $($item.Sha) - $($item.Label). Do not reconstruct it from guesses."
        }
        $subject = (Invoke-Git show -s --format='%h %s' $resolved | Out-String).Trim()
        Write-Host "FOUND $subject" -ForegroundColor Green
    }

    Write-Host "`nFetching current origin/main without modifying the working tree..." -ForegroundColor Cyan
    Invoke-Git fetch origin 'refs/heads/main:refs/remotes/origin/main' --prune | Out-Null
    $originMain = (Invoke-Git rev-parse origin/main | Out-String).Trim()
    Write-Host "origin/main: $originMain" -ForegroundColor Green

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $lastVerified = $VerifiedCommits[-1].Sha
    $backupBranch = "backup/secure-bridge-v13-$timestamp"
    Invoke-Git branch $backupBranch $lastVerified | Out-Null
    Write-Host "Created immutable-preservation branch: $backupBranch -> $lastVerified" -ForegroundColor Yellow

    $prerequisiteTip = $HistoricalPrerequisites[-1].Sha
    $directCherryPickSafe = Test-IsAncestor -Ancestor $prerequisiteTip -Descendant 'origin/main'

    if (-not $Apply) {
        Write-Host "`nPREFLIGHT PASS - NO RECONCILIATION APPLIED" -ForegroundColor Green
        Write-Host 'All seven historical Secure Bridge commit objects exist and a backup branch preserves the verified incremental chain.'
        if (-not $directCherryPickSafe) {
            Write-Host 'SEMANTIC RECONCILIATION REQUIRED - DIRECT CHERRY-PICK DISABLED' -ForegroundColor Yellow
            Write-Host 'The historical bridge prerequisite line is not an ancestor of current origin/main.'
            Write-Host 'Use scripts/secure-bridge-semantic-preflight.ps1 and the hardened semantic Secure Bridge runtime. Do not use -Apply.'
        }
        else {
            Write-Host 'Historical prerequisite is already present in origin/main; direct reconciliation may be reviewed under the normal safety gates.'
        }
        return
    }

    if (-not $directCherryPickSafe) {
        throw 'DIRECT CHERRY-PICK DISABLED: historical Secure Bridge prerequisite history diverges from origin/main. The verified commits remain preserved as evidence. Use semantic reconciliation; do not resolve old bridge conflicts by ours/theirs or recreate the deleted Computer Agent control plane.'
    }

    $reconcileBranch = "reconcile/secure-bridge-v13-$timestamp"
    Invoke-Git switch --create $reconcileBranch origin/main | Out-Null
    Write-Host "Created reconciliation branch: $reconcileBranch" -ForegroundColor Yellow

    foreach ($item in $VerifiedCommits) {
        Write-Host "Cherry-picking $($item.Sha) - $($item.Label)" -ForegroundColor Cyan

        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = & git cherry-pick $item.Sha 2>&1
            $cherryPickExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }

        if ($cherryPickExitCode -ne 0) {
            Write-Host ($output | Out-String) -ForegroundColor Red
            throw "Cherry-pick stopped at $($item.Sha). Resolve with evidence or run 'git cherry-pick --abort'. Do not accept conflict resolutions that weaken Guardian, Watchdog, approvals, fingerprints, workspace/protected-path controls, Verifier behavior, budgets, or emergency stop."
        }
    }

    Write-Host "`nSECURE BRIDGE V1.3 RECONCILIATION COMMITS APPLIED" -ForegroundColor Green
    Write-Host "Branch: $reconcileBranch"
    Write-Host "Backup: $backupBranch"

    if ($RunSafeVerification) {
        if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
            throw 'npm.cmd is not available; reconciliation is preserved but verification cannot continue.'
        }
        Invoke-Checked -Name 'npm install' -Command { & npm.cmd install }
        Invoke-Checked -Name 'TypeScript check' -Command { & npm.cmd run check }
        if ((Get-Content package.json -Raw) -match '"verify:model-routing"') {
            Invoke-Checked -Name 'Model routing verification' -Command { & npm.cmd run verify:model-routing }
        }
        if ((Get-Content package.json -Raw) -match '"verify:intelligence-routing"') {
            Invoke-Checked -Name 'Intelligence routing verification' -Command { & npm.cmd run verify:intelligence-routing }
        }
        if ((Get-Content package.json -Raw) -match '"verify:capabilities"') {
            Invoke-Checked -Name 'Capability readiness verification' -Command { & npm.cmd run verify:capabilities }
        }
        if ((Get-Content package.json -Raw) -match '"verify:stuck"') {
            Invoke-Checked -Name 'Stuck/dead-loop detector verification' -Command { & npm.cmd run verify:stuck }
        }
        if ((Get-Content package.json -Raw) -match '"verify:openai-strategy"') {
            Invoke-Checked -Name 'OpenAI strategy contract verification' -Command { & npm.cmd run verify:openai-strategy }
        }
        Invoke-Checked -Name 'Configured NEXUS system verification' -Command { & npm.cmd run verify:system }
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1')) {
            Invoke-Checked -Name 'Full Windows NEXUS safety verification' -Command {
                & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -SkipInstall
            }
        }
    }

    Write-Host "`nNEXT REQUIRED GATE" -ForegroundColor Yellow
    Write-Host 'Run the issue #10 Secure Bridge real-host regression under current semantic runtime policy.'
    Write-Host 'Do not push/merge unreviewed runtime work. This helper intentionally does not read secrets, enable Computer Agent Phase 1F, or change permissions.'
}
finally {
    Pop-Location
}
