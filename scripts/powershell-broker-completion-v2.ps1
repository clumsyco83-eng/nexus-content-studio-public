[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'nexus.verification.run',
        'nexus.intelligence-foundation.complete',
        'nexus.claude.live-readiness'
    )]
    [string]$Capability
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-BootstrapFailureCode {
    switch ($Capability) {
        'nexus.verification.run' { return 60 }
        'nexus.intelligence-foundation.complete' { return 70 }
        'nexus.claude.live-readiness' { return 90 }
    }
    return 1
}

function Resolve-TrustedSystemPowerShell {
    try {
        $windowsRoot = if ($env:SystemRoot) { $env:SystemRoot } elseif ($env:WINDIR) { $env:WINDIR } else { 'C:\Windows' }
        $candidate = Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    catch {}
    return $null
}

function Resolve-BrokerPathExecutable {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        $commands = @(Get-Command -Name $Name -CommandType Application -ErrorAction Stop)
        foreach ($command in $commands) {
            $source = [string]$command.Source
            if ([string]::IsNullOrWhiteSpace($source)) { continue }
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                return [IO.Path]::GetFullPath($source)
            }
        }
    }
    catch {}
    return $null
}

function Invoke-NpmStage {
    param(
        [Parameter(Mandatory = $true)][string]$NpmPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $NpmPath @Arguments *> $null
        $exitCode = [int]$LASTEXITCODE
        return ($exitCode -eq 0)
    }
    catch { return $false }
    finally { $ErrorActionPreference = $previousPreference }
}

function Invoke-NodeStage {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$PassOutput
    )
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($PassOutput) { & $NodePath @Arguments } else { & $NodePath @Arguments *> $null }
        $exitCode = [int]$LASTEXITCODE
        return ($exitCode -eq 0)
    }
    catch { return $false }
    finally { $ErrorActionPreference = $previousPreference }
}

function Invoke-NodeStageExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $NodePath @Arguments *> $null
        return [int]$LASTEXITCODE
    }
    catch { return -1 }
    finally { $ErrorActionPreference = $previousPreference }
}

function Invoke-PowerShellStage {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { return $false }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments *> $null
        $exitCode = [int]$LASTEXITCODE
        return ($exitCode -eq 0)
    }
    catch { return $false }
    finally { $ErrorActionPreference = $previousPreference }
}

function Invoke-PowerShellStageExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { return -1 }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $PowerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments *> $null
        return [int]$LASTEXITCODE
    }
    catch { return -1 }
    finally { $ErrorActionPreference = $previousPreference }
}

function Resolve-VerifiedPackage {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    try {
        if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { return $null }
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
    }
    catch {}
    return $null
}

$bootstrapFailureCode = Get-BootstrapFailureCode
$RepoRoot = $null
try {
    $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw 'Repository root is missing.' }
    Set-Location -LiteralPath $RepoRoot
}
catch { exit $bootstrapFailureCode }

switch ($Capability) {
    'nexus.verification.run' {
        $powerShell = Resolve-TrustedSystemPowerShell
        $npm = Resolve-BrokerPathExecutable -Name 'npm.cmd'
        if ([string]::IsNullOrWhiteSpace($powerShell) -or [string]::IsNullOrWhiteSpace($npm)) { exit 60 }
        $laptopExit = Invoke-PowerShellStageExitCode -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify-staged.ps1')
        if ($laptopExit -ne 0) {
            if ($laptopExit -ge 100 -and $laptopExit -le 160) { exit $laptopExit }
            exit 61
        }
        $secureBridgeExit = Invoke-PowerShellStageExitCode -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'windows-secure-bridge-verify-staged.ps1')
        if ($secureBridgeExit -ne 0) {
            if ($secureBridgeExit -ge 161 -and $secureBridgeExit -le 170) { exit $secureBridgeExit }
            exit 62
        }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:powershell-broker'))) { exit 63 }
        [pscustomobject]@{ ok = $true; capability = $Capability; action = 'laptop-verification-no-install'; installPerformed = $false } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.intelligence-foundation.complete' {
        $powerShell = Resolve-TrustedSystemPowerShell
        $npm = Resolve-BrokerPathExecutable -Name 'npm.cmd'
        if ([string]::IsNullOrWhiteSpace($powerShell) -or [string]::IsNullOrWhiteSpace($npm)) { exit 70 }
        $expectedHash = 'a4b546a141b8c9f163a84c607a9bc9210c39aa9a87b86aba20ce00311a01eba6'
        $zip = Resolve-VerifiedPackage -RepoRoot $RepoRoot -FileName 'nexus-intelligence-foundation-v1.0.0.zip' -ExpectedSha256 $expectedHash
        if ([string]::IsNullOrWhiteSpace([string]$zip)) { exit 71 }
        $skillsRoot = Join-Path $RepoRoot '.claude\skills'
        if (-not (Invoke-PowerShellStage -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'install-intelligence-foundation.ps1') -Arguments @('-ZipPath', $zip))) { exit 72 }
        if (-not (Invoke-PowerShellStage -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authoring.ps1') -Arguments @('-Profile','IntelligenceFoundation','-SkillsRoot',$skillsRoot))) { exit 73 }
        if (-not (Invoke-PowerShellStage -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'verify-claude-skill-authority.ps1') -Arguments @('-SkillsRoot',$skillsRoot))) { exit 74 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','check'))) { exit 75 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:claude-skill-admission'))) { exit 76 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:intelligence-routing'))) { exit 77 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:capabilities'))) { exit 78 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:stuck'))) { exit 79 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:openai-strategy'))) { exit 80 }
        if (-not (Invoke-NpmStage -NpmPath $npm -Arguments @('run','verify:system'))) { exit 81 }
        if (-not (Invoke-PowerShellStage -PowerShellPath $powerShell -ScriptPath (Join-Path $PSScriptRoot 'windows-laptop-verify.ps1') -Arguments @('-SkipInstall'))) { exit 82 }
        [pscustomobject]@{ ok = $true; capability = $Capability; packageSha256 = $expectedHash; deterministicHostGate = 'PASS'; liveClaudeRoutingStillRequired = $true } | ConvertTo-Json -Compress
        exit 0
    }

    'nexus.claude.live-readiness' {
        $node = Resolve-BrokerPathExecutable -Name 'node.exe'
        if ([string]::IsNullOrWhiteSpace($node)) { exit 90 }
        $liveExit = Invoke-NodeStageExitCode -NodePath $node -Arguments @('--import','tsx','src/testing/secure-claude-live-readiness.ts')
        if ($liveExit -ne 0) {
            if ($liveExit -ge 91 -and $liveExit -le 97) { exit $liveExit }
            exit 98
        }
        [pscustomobject]@{ ok = $true; capability = $Capability; action = 'bounded-one-turn-live-proof'; liveStage = 'PASS' } | ConvertTo-Json -Compress
        exit 0
    }
}
