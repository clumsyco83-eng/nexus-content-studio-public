[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$required = @('repository', 'owner', 'hostId', 'repositoryRoot', 'tokenFile')
foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace([string]$config.$name)) {
        throw "Remote worker config is missing '$name'."
    }
}

$repository = [string]$config.repository
$owner = [string]$config.owner
$hostId = [string]$config.hostId
$label = if ($config.label) { [string]$config.label } else { 'nexus-remote-command' }
$pollMs = if ($config.pollMs) { [int]$config.pollMs } else { 60000 }
if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Remote worker repository is invalid.' }
if ($owner -notmatch '^[A-Za-z0-9_.-]{1,120}$') { throw 'Remote worker owner login is invalid.' }
if ($hostId -notmatch '^[A-Za-z0-9._-]{1,120}$') { throw 'Remote worker hostId is invalid.' }
if ($label -notmatch '^[A-Za-z0-9_.:-]{1,120}$') { throw 'Remote worker label is invalid.' }
if ($pollMs -lt 30000 -or $pollMs -gt 300000) { throw 'Remote worker poll interval is outside the allowed range.' }

$expectedRepoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$repoRoot = [IO.Path]::GetFullPath([string]$config.repositoryRoot).TrimEnd('\')
if (-not $repoRoot.Equals($expectedRepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Configured repository root does not match the repository containing the fixed remote-worker launcher.'
}

$tokenFile = [IO.Path]::GetFullPath([string]$config.tokenFile)
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'Remote GitHub token file is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json') -PathType Leaf)) { throw 'Configured NEXUS repository root is invalid.' }

$env:NEXUS_REMOTE_GITHUB_ENABLED = 'true'
$env:NEXUS_REMOTE_GITHUB_REPOSITORY = $repository
$env:NEXUS_REMOTE_GITHUB_OWNER = $owner
$env:NEXUS_REMOTE_HOST_ID = $hostId
$env:NEXUS_REMOTE_GITHUB_LABEL = $label
$env:NEXUS_REMOTE_GITHUB_POLL_MS = [string]$pollMs
$env:NEXUS_REPOSITORY_ROOT = $repoRoot

function Invoke-RemotePollOnce {
    $secure = Import-Clixml -LiteralPath $tokenFile
    if ($secure -isnot [Security.SecureString]) { throw 'Remote GitHub token file did not contain a DPAPI-protected SecureString.' }

    $bstr = [IntPtr]::Zero
    $plain = $null
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Remote GitHub token decrypted to an empty value.' }

        $env:NEXUS_REMOTE_GITHUB_TOKEN = $plain
        Push-Location $repoRoot
        try {
            # Deliberately run one short worker process per poll. This ensures that a
            # successful repository sync becomes visible on the very next poll rather
            # than leaving a stale long-lived Node/tsx worker resident in memory.
            & npm.cmd run remote:github:once
            $exitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if ($exitCode -ne 0) { throw "Remote GitHub one-shot worker exited with code $exitCode." }
    }
    finally {
        Remove-Item Env:NEXUS_REMOTE_GITHUB_TOKEN -ErrorAction SilentlyContinue
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $plain = $null
    }
}

if ($Once) {
    Invoke-RemotePollOnce
    exit 0
}

$consecutiveFailures = 0
while ($true) {
    try {
        Invoke-RemotePollOnce
        $consecutiveFailures = 0
        Start-Sleep -Milliseconds $pollMs
    }
    catch {
        $consecutiveFailures += 1
        $exponent = [Math]::Min([Math]::Max($consecutiveFailures - 1, 0), 3)
        $retryMs = [int][Math]::Min(300000, $pollMs * [Math]::Pow(2, $exponent))
        Write-Warning "NEXUS remote supervisor poll failed safe; retrying in $retryMs ms: $($_.Exception.Message)"
        Start-Sleep -Milliseconds $retryMs
    }
}
