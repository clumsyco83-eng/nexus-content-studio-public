[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'system.process.inspect',
        'nexus.health.check',
        'nexus.verification.run',
        'nexus.service.status',
        'nexus.service.start',
        'nexus.service.restart',
        'nexus.repo.status',
        'nexus.repo.sync',
        'nexus.intelligence-foundation.complete',
        'nexus.core-specialists.complete',
        'nexus.business-profile.complete'
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

    # Windows PowerShell 5.1 promotes native stderr redirected through 2>&1 into
    # ErrorRecord objects. With the broker-wide ErrorActionPreference=Stop this can
    # terminate a successful Git command (notably fetch/merge progress) before the
    # child exit code is inspected. Treat native stderr as output while the trusted
    # Git process runs, then make the process exit code authoritative.
    $previousPreference = $ErrorActionPreference
    $output = @()
    $exitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Git -C $RepoRoot @Arguments 2>&1)
        $exitCode = [int]$LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        $detail = ($output | Out-String).Trim()
        throw "Git command failed safe (exitCode=$exitCode): $detail"
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

function Wait-NexusHealth {
    $healthUri = 'http://127.0.0.1:8787/api/health'
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
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
        throw 'NEXUS Assistant did not become healthy at the fixed loopback health endpoint.'
    }
    return $health
}

function Invoke-NpmCheckedQuiet {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    # Windows PowerShell 5.1 can promote native stderr into ErrorRecord objects
    # while the broker-wide ErrorActionPreference is Stop. Child process exit code
    # is authoritative; harmless stderr from a successful npm command must not be
    # treated as a broker failure.
    $previousPreference = $ErrorActionPreference
    $exitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        & npm.cmd @Arguments *> $null
        $exitCode = [int]$LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        throw "Fixed npm verification failed safe (exitCode=$exitCode): npm $($Arguments -join ' ')"
    }
}

function Invoke-PowerShellScriptCheckedQuiet {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Required repository-owned helper is missing: $([IO.Path]::GetFileName($ScriptPath))"
    }

    # Apply the same native-child rule to repository-owned Windows PowerShell
    # helpers: suppress child streams, capture the real process exit code, and
    # restore the broker's Stop preference before classifying success/failure.
    $previousPreference = $ErrorActionPreference
    $exitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments *> $null
        $exitCode = [int]$LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        throw "Fixed repository-owned helper failed safe (exitCode=$exitCode): $([IO.Path]::GetFileName($ScriptPath))"
    }
}

function Resolve-VerifiedPackage {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'Internal package SHA-256 policy is invalid.'
    }

    $candidates = @((Join-Path $RepoRoot $FileName))
    if ($env:USERPROFILE) {
        $candidates += @(
            (Join-Path $env:USERPROFILE "Downloads\$FileName"),
            (Join-Path $env:USERPROFILE "Desktop\$FileName"),
            (Join-Path $env:USERPROFILE "Documents\$FileName")
        )
    }

    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -eq $ExpectedSha256) { return (Resolve-Path -LiteralPath $candidate).Path }
    }

    foreach ($root in @('C:\NEXUS-WORK', 'D:\NEXUS-MASTER-ARCHIVE', 'V:\NEXUS')) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $found = @(Get-ChildItem -LiteralPath $root -Filter $FileName -File -Recurse -ErrorAction SilentlyContinue)
        foreach ($file in $found) {
            $actual = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -eq $ExpectedSha256) { return $file.FullName }
        }
    }

    throw "Verified package not found for fixed file $FileName. No installation was attempted."
}

function Invoke-IntelligenceFoundationCompletion {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $expectedHash = 'a4b546a141b8c9f163a84c607a9bc9210c39aa9a87b86aba20ce00311a01eba6'
    $zip = Resolve-VerifiedPackage -RepoRoot $RepoRoot -FileName 'nexus-intelligence-foundation-v1.0.0.zip' -ExpectedSha256 $expectedHash
    $skillsRoot = Join-Path $RepoRoot '.claude\skills'

    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'install-intelligence-foundation.ps1') -Arguments @('-ZipPath', $zip)
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authoring.ps1') -Arguments @('-Profile', 'IntelligenceFoundation', '-SkillsRoot', $skillsRoot)
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1') -Arguments @('-SkillsRoot', $skillsRoot)
    Invoke-NpmCheckedQuiet -Arguments @('run','check')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:claude-skill-admission')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:intelligence-routing')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:capabilities')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:stuck')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:openai-strategy')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:system')
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -Arguments @('-SkipInstall')

    return [pscustomobject]@{
        ok = $true
        capability = $Capability
        packageSha256 = $expectedHash
        deterministicHostGate = 'PASS'
        liveClaudeRoutingStillRequired = $true
    }
}

function Invoke-CoreSpecialistsCompletion {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $sourceRoot = 'C:\NEXUS-WORK\nexus-godmode-studio\plugins\nexus-godmode-studio\skills'
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw 'Fixed canonical core-specialist source root is missing. No promotion was attempted.'
    }

    $oldOuter = $env:NEXUS_CORE_SPECIALIST_PROMOTION_APPLY
    try {
        $env:NEXUS_CORE_SPECIALIST_PROMOTION_APPLY = 'I_ACKNOWLEDGE_CORE_SPECIALIST_PROJECT_PROMOTION'
        Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'complete-core-specialist-promotion.ps1') -Arguments @('-SourceSkillsRoot', $sourceRoot, '-Apply')
    }
    finally {
        $env:NEXUS_CORE_SPECIALIST_PROMOTION_APPLY = $oldOuter
    }

    return [pscustomobject]@{
        ok = $true
        capability = $Capability
        specialistCount = 6
        deterministicHostGate = 'PASS'
        liveClaudeRoutingStillRequired = $true
    }
}

function Invoke-BusinessProfileCompletion {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $expectedHash = '183fc7c5fd5d3e82cc2118621f5b84e99ce743c0cd00c4b3cb7afcf00d33f3b6'
    $zip = Resolve-VerifiedPackage -RepoRoot $RepoRoot -FileName 'nexus-professional-intelligence-pack-v1.0.0.zip' -ExpectedSha256 $expectedHash
    $skillsRoot = Join-Path $RepoRoot '.claude\skills'

    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'install-business-intelligence-profile.ps1') -Arguments @('-ZipPath', $zip)
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authoring.ps1') -Arguments @('-Profile', 'BusinessProfile', '-SkillsRoot', $skillsRoot)
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1') -Arguments @('-SkillsRoot', $skillsRoot)
    Invoke-NpmCheckedQuiet -Arguments @('run','check')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:claude-skill-admission')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:intelligence-routing')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:capabilities')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:goals')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:stuck')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:openai-strategy')
    Invoke-NpmCheckedQuiet -Arguments @('run','verify:system')
    Invoke-PowerShellScriptCheckedQuiet -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -Arguments @('-SkipInstall')

    return [pscustomobject]@{
        ok = $true
        capability = $Capability
        packageSha256 = $expectedHash
        specialistCount = 7
        deterministicHostGate = 'PASS'
        liveClaudeRoutingStillRequired = $true
    }
}

switch ($Capability) {
    'system.process.inspect' {
        Assert-NoUnexpectedParameters -Allowed @('ProcessName')
        if ($ProcessName -notmatch '^[A-Za-z0-9_.-]{1,80}$') { throw 'Unsafe ProcessName.' }
        $items = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object Id, ProcessName)
        [pscustomobject]@{ ok = $true; capability = $Capability; running = ($items.Count -gt 0); processes = $items } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    'nexus.health.check' {
        Assert-NoUnexpectedParameters -Allowed @('Url')
        $uri = [Uri]$Url
        if ($uri.Scheme -ne 'http') { throw 'Health URL must use HTTP.' }
        if ($uri.Host -notin @('127.0.0.1', '::1')) { throw 'Health URL must use a literal loopback address.' }
        if ($uri.AbsolutePath -ne '/api/health' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) { throw 'Health URL must be the exact /api/health endpoint without credentials, query, or fragment.' }
        $response = Invoke-RestMethod -Uri $uri.AbsoluteUri -Method Get -TimeoutSec 5
        if (-not $response.ok) { throw 'NEXUS health endpoint did not report ok=true.' }
        [pscustomobject]@{ ok = $true; capability = $Capability; health = $response } | ConvertTo-Json -Depth 10 -Compress
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
        [pscustomobject]@{ ok = $true; capability = $Capability; action = 'laptop-verification-no-install'; installPerformed = $false } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.service.status' {
        Assert-NoUnexpectedParameters -Allowed @()
        $status = Get-NexusTaskStatus
        [pscustomobject]@{ ok = $true; capability = $Capability; service = $status } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }

    'nexus.service.start' {
        Assert-NoUnexpectedParameters -Allowed @()
        $taskName = 'NEXUS Assistant'
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
        $health = Wait-NexusHealth
        [pscustomobject]@{ ok = $true; capability = $Capability; taskName = $taskName; health = $health } | ConvertTo-Json -Depth 10 -Compress
        exit 0
    }

    'nexus.service.restart' {
        Assert-NoUnexpectedParameters -Allowed @()
        $taskName = 'NEXUS Assistant'
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                Start-Sleep -Milliseconds 250
                $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
            } while ($task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
            if ($task.State -eq 'Running') { throw 'NEXUS Assistant Scheduled Task did not stop within the bounded restart window.' }
        }
        Start-ScheduledTask -TaskName $taskName
        $health = Wait-NexusHealth
        [pscustomobject]@{ ok = $true; capability = $Capability; taskName = $taskName; restarted = $true; health = $health } | ConvertTo-Json -Depth 10 -Compress
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
        [pscustomobject]@{ ok = $true; capability = $Capability; head = $head; branch = $branch; clean = ($changes.Count -eq 0); origin = $remote } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.repo.sync' {
        Assert-NoUnexpectedParameters -Allowed @('ExpectedHead')
        if ($ExpectedHead -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedHead must be one full 40-character Git commit SHA.' }

        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        $git = Resolve-TrustedGit
        $remote = Assert-ExpectedOrigin -Git $git -RepoRoot $repoRoot
        $branch = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')) | Out-String).Trim()
        if ($branch -ne 'main') { throw "Repository sync is restricted to the main branch; current branch is '$branch'." }

        $changes = @((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('status', '--porcelain')))
        if ($changes.Count -ne 0) { throw 'Repository sync requires a completely clean worktree.' }

        $beforeHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) | Out-String).Trim().ToLowerInvariant()
        try {
            Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('fetch', '--prune', 'origin', 'main') | Out-Null
        }
        catch {
            exit 41
        }
        $fetchedHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'FETCH_HEAD')) | Out-String).Trim().ToLowerInvariant()
        $expected = $ExpectedHead.ToLowerInvariant()
        if ($fetchedHead -ne $expected) { exit 42 }

        $changedPaths = @(
            (Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('diff', '--name-only', 'HEAD', 'FETCH_HEAD')) |
                ForEach-Object { ([string]$_).Trim().Replace('\', '/') } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $manualBootstrapExact = @(
            'package.json',
            'package-lock.json',
            'npm-shrinkwrap.json',
            '.npmrc',
            'scripts/powershell-broker-v1.ps1',
            'scripts/run-nexus-remote-github-worker.ps1',
            'scripts/install-nexus-remote-github-worker.ps1'
        )
        $blockedPaths = @($changedPaths | Where-Object {
            $_ -in $manualBootstrapExact -or
            $_.StartsWith('src/powershell-broker/', [StringComparison]::OrdinalIgnoreCase) -or
            $_.StartsWith('src/remote-transport/', [StringComparison]::OrdinalIgnoreCase)
        })
        if ($blockedPaths.Count -gt 0) { exit 43 }

        & $git -C $repoRoot merge-base --is-ancestor HEAD FETCH_HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { exit 44 }

        try {
            Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('merge', '--ff-only', 'FETCH_HEAD') | Out-Null
        }
        catch {
            exit 45
        }
        $afterHead = ((Invoke-GitChecked -Git $git -RepoRoot $repoRoot -Arguments @('rev-parse', 'HEAD')) | Out-String).Trim().ToLowerInvariant()
        if ($afterHead -ne $expected) { exit 46 }

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

    'nexus.intelligence-foundation.complete' {
        Assert-NoUnexpectedParameters -Allowed @()
        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        (Invoke-IntelligenceFoundationCompletion -RepoRoot $repoRoot) | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.core-specialists.complete' {
        Assert-NoUnexpectedParameters -Allowed @()
        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        (Invoke-CoreSpecialistsCompletion -RepoRoot $repoRoot) | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.business-profile.complete' {
        Assert-NoUnexpectedParameters -Allowed @()
        $repoRoot = [IO.Path]::GetFullPath((Get-Location).Path)
        (Invoke-BusinessProfileCompletion -RepoRoot $repoRoot) | ConvertTo-Json -Compress
        exit 0
    }

    default {
        throw "Unsupported capability: $Capability"
    }
}
