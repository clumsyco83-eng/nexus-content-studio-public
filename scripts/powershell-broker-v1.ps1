[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'system.process.inspect',
        'nexus.health.check',
        'nexus.verification.run',
        'nexus.service.status',
        'nexus.service.start',
        'nexus.repo.status',
        'nexus.repo.sync'
    )]
    [string]$Capability,

    [string]$ProcessName,
    [string]$Url,
    [string]$ExpectedHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NoUnexpectedParameters {
    param([string[]]$Allowed)
    foreach ($name in @('ProcessName', 'Url', 'ExpectedHead')) {
        $value = Get-Variable -Name $name -ValueOnly
        if ($name -notin $Allowed -and -not [string]::IsNullOrEmpty([string]$value)) {
            throw "Parameter $name is not valid for capability $Capability."
        }
    }
}

function Resolve-TrustedGit {
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'Git\cmd\git.exe')
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'Trusted Git executable was not found in the standard Program Files locations.'
}

function Invoke-GitChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = @(& $Git -C $RepoRoot @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $detail = ($output | Out-String).Trim()
        throw "Git command failed safe (exitCode=$LASTEXITCODE): $detail"
    }
    return $output
}

function Assert-ExpectedOrigin {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $remote = ((Invoke-GitChecked -Git $Git -RepoRoot $RepoRoot -Arguments @('remote', 'get-url', 'origin')) | Out-String).Trim()
    $allowed = @(
        'https://github.com/clumsyco83-eng/nexus-content-studio.git',
        'https://github.com/clumsyco83-eng/nexus-content-studio',
        'git@github.com:clumsyco83-eng/nexus-content-studio.git'
    )
    if ($remote -notin $allowed) {
        throw "origin remote is not the fixed NEXUS repository: $remote"
    }
    return $remote
}

function Get-NexusTaskStatus {
    $taskName = 'NEXUS Assistant'
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{
            exists = $false
            taskName = $taskName
            state = 'Missing'
        }
    }
    return [pscustomobject]@{
        exists = $true
        taskName = $taskName
        state = [string]$task.State
    }
}

switch ($Capability) {
    'system.process.inspect' {
        Assert-NoUnexpectedParameters -Allowed @('ProcessName')
        if ($ProcessName -notmatch '^[A-Za-z0-9_.-]{1,80}$') {
            throw 'Unsafe ProcessName.'
        }
        $items = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object Id, ProcessName)
        [pscustomobject]@{
            ok = $true
            capability = $Capability
            running = ($items.Count -gt 0)
            processes = $items
        } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    'nexus.health.check' {
        Assert-NoUnexpectedParameters -Allowed @('Url')
        $uri = [Uri]$Url
        if ($uri.Scheme -ne 'http') { throw 'Health URL must use HTTP.' }
        if ($uri.Host -notin @('127.0.0.1', '::1')) { throw 'Health URL must use a literal loopback address.' }
        if ($uri.AbsolutePath -ne '/api/health' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
            throw 'Health URL must be the exact /api/health endpoint without credentials, query, or fragment.'
        }
        $response = Invoke-RestMethod -Uri $uri.AbsoluteUri -Method Get -TimeoutSec 5
        if (-not $response.ok) { throw 'NEXUS health endpoint did not report ok=true.' }
        [pscustomobject]@{
            ok = $true
            capability = $Capability
            health = $response
        } | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }

    'nexus.verification.run' {
        Assert-NoUnexpectedParameters -Allowed @()

        $secureBridgeVerifier = Join-Path $PSScriptRoot 'windows-secure-bridge-verify.ps1'
        $laptopVerifier = Join-Path $PSScriptRoot 'windows-laptop-verify.ps1'

        & $laptopVerifier -SkipInstall
        & $secureBridgeVerifier
        & npm.cmd run verify:powershell-broker
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        [pscustomobject]@{
            ok = $true
            capability = $Capability
            action = 'laptop-verification-no-install'
            installPerformed = $false
        } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.service.status' {
        Assert-NoUnexpectedParameters -Allowed @()
        $status = Get-NexusTaskStatus
        [pscustomobject]@{
            ok = $true
            capability = $Capability
            service = $status
        } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    'nexus.service.start' {
        Assert-NoUnexpectedParameters -Allowed @()
        $taskName = 'NEXUS Assistant'
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($task.State -ne 'Running') {
            Start-ScheduledTask -TaskName $taskName
        }

        $healthUri = 'http://127.0.0.1:8787/api/health'
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $health = $null
        do {
            Start-Sleep -Milliseconds 500
            try {
                $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 3
            }
            catch {
                $health = $null
            }
        } while ((-not $health -or -not $health.ok) -and [DateTime]::UtcNow -lt $deadline)

        if (-not $health -or -not $health.ok) {
            throw 'NEXUS Assistant did not become healthy after the fixed Scheduled Task start.'
        }

        [pscustomobject]@{
            ok = $true
            capability = $Capability
            taskName = $taskName
            health = $health
        } | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }

    'nexus.repo.status' {
        Assert-NoUnexpectedParameters -Allowed @()
        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        $git = Resolve-TrustedGit
        $remote = Assert-ExpectedOrigin -Git $git -RepoRoot $repoRoot
        $head = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) | Out-String).Trim()
        $branch = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')) | Out-String).Trim()
        $changes = @((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('status', '--porcelain')))
        [pscustomobject]@{
            ok = $true
            capability = $Capability
            head = $head
            branch = $branch
            clean = ($changes.Count -eq 0)
            origin = $remote
        } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.repo.sync' {
        Assert-NoUnexpectedParameters -Allowed @('ExpectedHead')
        if ($ExpectedHead -notmatch '^[0-9a-fA-F]{40}$') {
            throw 'ExpectedHead must be one full 40-character Git commit SHA.'
        }

        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        $git = Resolve-TrustedGit
        $remote = Assert-ExpectedOrigin -Git $git -RepoRoot $repoRoot
        $branch = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')) | Out-String).Trim()
        if ($branch -ne 'main') {
            throw "Repository sync is restricted to the main branch; current branch is '$branch'."
        }

        $changes = @((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('status', '--porcelain')))
        if ($changes.Count -ne 0) {
            throw 'Repository sync requires a completely clean worktree.'
        }

        $beforeHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) | Out-String).Trim().ToLowerInvariant()
        Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('fetch', '--prune', 'origin', 'main') | Out-Null
        $fetchedHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'FETCH_HEAD')) | Out-String).Trim().ToLowerInvariant()
        $expected = $ExpectedHead.ToLowerInvariant()
        if ($fetchedHead -ne $expected) {
            throw "Fetched origin/main does not match the owner-approved expectedHead. expected=$expected fetched=$fetchedHead"
        }

        $changedPaths = @(
            (Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('diff', '--name-only', 'HEAD', 'FETCH_HEAD')) |
                ForEach-Object { ([string]$_).Trim().Replace('\', '/') } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $manualBootstrapPaths = @(
            'package.json',
            'package-lock.json',
            'npm-shrinkwrap.json',
            '.npmrc',
            'scripts/run-nexus-remote-github-worker.ps1',
            'scripts/install-nexus-remote-github-worker.ps1'
        )
        $blockedPaths = @($changedPaths | Where-Object { $_ -in $manualBootstrapPaths })
        if ($blockedPaths.Count -gt 0) {
            throw "Repository sync requires manual bootstrap because the approved update changes runtime/bootstrap files: $($blockedPaths -join ', ')"
        }

        & $git -C $repoRoot merge-base --is-ancestor HEAD FETCH_HEAD 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'Repository sync refused a non-fast-forward update.'
        }

        Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('merge', '--ff-only', 'FETCH_HEAD') | Out-Null
        $afterHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) | Out-String).Trim().ToLowerInvariant()
        if ($afterHead -ne $expected) {
            throw "Repository sync verification failed. expected=$expected actual=$afterHead"
        }

        [pscustomobject]@{
            ok = $true
            capability = $Capability
            origin = $remote
            beforeHead = $beforeHead
            afterHead = $afterHead
            expectedHead = $expected
            updated = ($beforeHead -ne $afterHead)
            changedFileCount = $changedPaths.Count
            manualBootstrapRequired = $false
            mode = 'clean-main-fast-forward-only'
        } | ConvertTo-Json -Compress
        exit 0
    }

    default {
        throw "Unsupported capability: $Capability"
    }
}
