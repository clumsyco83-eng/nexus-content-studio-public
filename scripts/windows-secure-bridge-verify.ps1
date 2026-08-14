[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This Secure Bridge validation addendum is intentionally Windows-only.'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$StartedDashboard = $false
$DashboardProcess = $null
$TempRoot = Join-Path $env:TEMP ("nexus-secure-bridge-verify-" + [guid]::NewGuid().ToString('N'))

$OriginalDashboardHost = $env:NEXUS_DASHBOARD_HOST
$OriginalDashboardPort = $env:NEXUS_DASHBOARD_PORT
$OriginalDashboardToken = $env:NEXUS_DASHBOARD_TOKEN
$OriginalStorageDriver = $env:NEXUS_STORAGE_DRIVER
$OriginalJsonDatabase = $env:NEXUS_JSON_DATABASE_FILE
$OriginalDatabase = $env:NEXUS_DATABASE_FILE
$OriginalGuardianReportDir = $env:NEXUS_GUARDIAN_REPORT_DIR
$OriginalGuardianHealthUrl = $env:NEXUS_GUARDIAN_HEALTH_URL
$OriginalWatchdogAutoRestart = $env:NEXUS_WATCHDOG_AUTO_RESTART

function Invoke-NpmVerification {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Script
    )

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    & npm.cmd run $Script
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
    Write-Host "PASS $Name" -ForegroundColor Green
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Stop-VerificationDashboard {
    if (-not $StartedDashboard -or $null -eq $DashboardProcess) { return }
    try {
        & taskkill.exe /PID $DashboardProcess.Id /T /F *> $null
    }
    catch {
        Write-Warning "Could not stop Secure Bridge verification dashboard process tree: $($_.Exception.Message)"
    }
}

Push-Location $RepoRoot
try {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'node.exe is not available in PATH.' }
    if ($null -eq $npm) { throw 'npm.cmd is not available in PATH.' }

    $packagePath = Join-Path $RepoRoot 'package.json'
    $cycleWrapperPath = Join-Path $RepoRoot 'scripts\run-secure-bridge-cycle.ps1'
    $lockedCliPath = Join-Path $RepoRoot 'src\orchestration\secure-bridge-locked-cli.ts'
    if (-not (Test-Path -LiteralPath $cycleWrapperPath -PathType Leaf)) { throw 'Locked Secure Bridge PowerShell cycle wrapper is missing.' }
    if (-not (Test-Path -LiteralPath $lockedCliPath -PathType Leaf)) { throw 'Locked Secure Bridge CLI is missing.' }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $expectedCycleCommand = 'powershell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File scripts/run-secure-bridge-cycle.ps1'
    $configuredCycleCommand = [string]$package.scripts.'secure-bridge:cycle'
    if ($configuredCycleCommand -ne $expectedCycleCommand) {
        throw "Canonical secure-bridge:cycle is not wired through the locked Windows wrapper. Expected '$expectedCycleCommand', got '$configuredCycleCommand'."
    }
    Write-Host 'PASS canonical Secure Bridge cycle is wired through the locked Windows wrapper.' -ForegroundColor Green

    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

    Invoke-NpmVerification -Name 'Bounded Secure Bridge Claude executor' -Script 'verify:secure-claude-executor'
    Invoke-NpmVerification -Name 'Fingerprint-bound Goal task approvals' -Script 'verify:goal-task-approvals'
    Invoke-NpmVerification -Name 'NEXUS emergency stop' -Script 'verify:emergency-stop'
    Invoke-NpmVerification -Name 'Deterministic Goal task Verifier' -Script 'verify:goal-task-verifier'
    Invoke-NpmVerification -Name 'Semantic Secure Bridge runtime integration' -Script 'verify:secure-bridge-runtime'

    $validationPort = Get-FreeLoopbackPort
    $env:NEXUS_DASHBOARD_HOST = '127.0.0.1'
    $env:NEXUS_DASHBOARD_PORT = [string]$validationPort
    $env:NEXUS_DASHBOARD_TOKEN = "nexus-secure-bridge-verify-$([guid]::NewGuid().ToString('N'))"
    $env:NEXUS_STORAGE_DRIVER = 'json'
    $env:NEXUS_JSON_DATABASE_FILE = Join-Path $TempRoot 'nexus-db.json'
    $env:NEXUS_DATABASE_FILE = $env:NEXUS_JSON_DATABASE_FILE
    $env:NEXUS_GUARDIAN_REPORT_DIR = Join-Path $TempRoot 'guardian'
    $env:NEXUS_GUARDIAN_HEALTH_URL = "http://127.0.0.1:$validationPort/api/health"
    $env:NEXUS_WATCHDOG_AUTO_RESTART = 'false'

    $stdout = Join-Path $TempRoot 'dashboard.out.log'
    $stderr = Join-Path $TempRoot 'dashboard.err.log'
    $DashboardProcess = Start-Process -FilePath 'node.exe' -ArgumentList @('--import', 'tsx', 'src/dashboard/server.ts') -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $StartedDashboard = $true

    $headers = @{ Authorization = "Bearer $env:NEXUS_DASHBOARD_TOKEN" }
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri $env:NEXUS_GUARDIAN_HEALTH_URL -Headers $headers -TimeoutSec 2
            if ($health.ok) { $ready = $true; break }
        }
        catch {}
        if ($DashboardProcess.HasExited) { break }
    }
    if (-not $ready) {
        $tail = ''
        if (Test-Path -LiteralPath $stderr) { $tail = (Get-Content -LiteralPath $stderr -Tail 30) -join "`n" }
        throw "Secure Bridge verification dashboard did not become healthy. $tail"
    }

    $approvals = Invoke-RestMethod -Uri "http://127.0.0.1:$validationPort/api/goal-approvals" -Headers $headers -TimeoutSec 3
    if ($null -eq $approvals.approvals) {
        throw 'Authenticated /api/goal-approvals did not return an approvals collection.'
    }

    $unauthorizedRejected = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$validationPort/api/goal-approvals" -TimeoutSec 3 | Out-Null
    }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
            $unauthorizedRejected = $true
        }
        else {
            throw
        }
    }
    if (-not $unauthorizedRejected) {
        throw 'Goal approval API accepted an unauthenticated request.'
    }

    Write-Host "`nNEXUS SECURE BRIDGE WINDOWS ADDENDUM: PASS" -ForegroundColor Green
    Write-Host 'Validated: locked canonical cycle wiring, bounded Claude execution, fingerprint-bound owner approval, fail-closed emergency stop, deterministic Goal-task verification, semantic Secure Bridge runtime integration, and authenticated owner approval visibility.'
    Write-Host 'No paid provider call, unrestricted shell authority, publishing, payment, credential mutation, permission bypass, or Computer Agent expansion was exercised.'
}
finally {
    Stop-VerificationDashboard
    $env:NEXUS_DASHBOARD_HOST = $OriginalDashboardHost
    $env:NEXUS_DASHBOARD_PORT = $OriginalDashboardPort
    $env:NEXUS_DASHBOARD_TOKEN = $OriginalDashboardToken
    $env:NEXUS_STORAGE_DRIVER = $OriginalStorageDriver
    $env:NEXUS_JSON_DATABASE_FILE = $OriginalJsonDatabase
    $env:NEXUS_DATABASE_FILE = $OriginalDatabase
    $env:NEXUS_GUARDIAN_REPORT_DIR = $OriginalGuardianReportDir
    $env:NEXUS_GUARDIAN_HEALTH_URL = $OriginalGuardianHealthUrl
    $env:NEXUS_WATCHDOG_AUTO_RESTART = $OriginalWatchdogAutoRestart
    Pop-Location
}
