[CmdletBinding()]
param(
    [string]$Repository = 'clumsyco83-eng/nexus-content-studio',
    [string]$Owner = 'clumsyco83-eng',
    [string]$HostId = $env:COMPUTERNAME.ToLowerInvariant(),
    [string]$Label = 'nexus-remote-command',
    [ValidateRange(30000,300000)][int]$PollMs = 60000,
    [string]$TaskName = 'NEXUS Remote GitHub Transport',
    [switch]$ReplaceToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Remote transport installer is Windows-only.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository must be owner/name.' }
if ($Owner -notmatch '^[A-Za-z0-9_.-]{1,120}$') { throw 'Owner login is invalid.' }
if ($HostId -notmatch '^[A-Za-z0-9._-]{1,120}$') { throw 'HostId is invalid.' }
if ($Label -notmatch '^[A-Za-z0-9_.:-]{1,120}$') { throw 'Label is invalid.' }

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-nexus-remote-github-worker.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Remote worker launcher is missing.' }

$configDir = Join-Path $env:LOCALAPPDATA 'NEXUS\remote-github'
$configPath = Join-Path $configDir 'config.json'
$tokenPath = Join-Path $configDir 'github-token.clixml'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if ($ReplaceToken -or -not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    Write-Host 'Enter a fine-grained GitHub token scoped only to this repository with Issues read/write and Metadata read.' -ForegroundColor Cyan
    $secureToken = Read-Host 'GitHub token' -AsSecureString
    $secureToken | Export-Clixml -LiteralPath $tokenPath
}

$secureToken = Import-Clixml -LiteralPath $tokenPath
$bstr = [IntPtr]::Zero
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainToken)) { throw 'Remote GitHub token decrypted to an empty value.' }

    $headers = @{
        Authorization = "Bearer $plainToken"
        Accept = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent' = 'nexus-remote-transport-installer-v1'
    }
    $encodedLabel = [Uri]::EscapeDataString($Label)
    $labelUri = "https://api.github.com/repos/$Repository/labels/$encodedLabel"
    $labelExists = $false
    try {
        Invoke-RestMethod -Method Get -Uri $labelUri -Headers $headers -TimeoutSec 15 | Out-Null
        $labelExists = $true
    }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            $labelExists = $false
        }
        else {
            throw
        }
    }

    if (-not $labelExists) {
        $createUri = "https://api.github.com/repos/$Repository/labels"
        $body = @{
            name = $Label
            color = '5319e7'
            description = 'Short-lived authenticated NEXUS remote command relay.'
        } | ConvertTo-Json
        Invoke-RestMethod -Method Post -Uri $createUri -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
        Write-Host "Created GitHub label '$Label'." -ForegroundColor Green
    }
    else {
        Write-Host "Verified GitHub label '$Label'." -ForegroundColor Green
    }
}
finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plainToken = $null
}

$config = [ordered]@{
    repository = $Repository
    owner = $Owner
    hostId = $HostId
    repositoryRoot = $repoRoot
    tokenFile = $tokenPath
    label = $Label
    pollMs = $PollMs
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$launcher`" -ConfigPath `"$configPath`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Disable-ScheduledTask -TaskName $TaskName | Out-Null

Write-Host "Remote GitHub transport configuration written to $configPath" -ForegroundColor Green
Write-Host "Scheduled Task '$TaskName' registered with RunLevel Limited, unlimited execution time, bounded restart-on-failure, and battery-safe persistence." -ForegroundColor Green
Write-Host 'Task is DISABLED. This installer intentionally cannot enable it; activation is a separate post-verification step.' -ForegroundColor Yellow
Write-Host 'The GitHub token is stored with Windows DPAPI through Export-Clixml and is not placed in the Scheduled Task command line.'
