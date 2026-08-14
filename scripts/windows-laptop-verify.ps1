[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This validation script is intentionally Windows-only.'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'NEXUS\validation-backups' } else { Join-Path $env:TEMP 'NEXUS-validation-backups' }
$BackupDir = Join-Path $BackupBase $Timestamp
$ValidationReportDir = Join-Path $BackupDir 'guardian-validation'
$WatchdogReport = Join-Path $ValidationReportDir 'watchdog.json'
$StartedDashboard = $false
$DashboardProcess = $null

$OriginalDashboardHost = $env:NEXUS_DASHBOARD_HOST
$OriginalDashboardPort = $env:NEXUS_DASHBOARD_PORT
$OriginalDashboardToken = $env:NEXUS_DASHBOARD_TOKEN
$OriginalGuardianHealthUrl = $env:NEXUS_GUARDIAN_HEALTH_URL
$OriginalGuardianReportDir = $env:NEXUS_GUARDIAN_REPORT_DIR
$OriginalWatchdogAutoRestart = $env:NEXUS_WATCHDOG_AUTO_RESTART

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Command
    )

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    & $Command
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

function Test-DashboardHealth {
    param([Parameter(Mandatory)][string]$Url)
    try {
        $headers = @{ Authorization = "Bearer $($env:NEXUS_DASHBOARD_TOKEN)" }
        $response = Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec 3
        return [bool]$response.ok
    }
    catch {
        return $false
    }
}

function Stop-StartedDashboard {
    if (-not $StartedDashboard -or $null -eq $DashboardProcess) { return }
    try {
        & taskkill.exe /PID $DashboardProcess.Id /T /F *> $null
    }
    catch {
        Write-Warning "Could not stop temporary dashboard process tree: $($_.Exception.Message)"
    }
}

Push-Location $RepoRoot
try {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'Node.js is not available in PATH.' }
    if ($null -eq $npm) { throw 'npm.cmd is not available in PATH.' }

    $nodeVersionText = (& node --version).Trim().TrimStart('v')
    $nodeVersion = [version]$nodeVersionText
    if ($nodeVersion -lt [version]'22.16.0') {
        throw "Node.js $nodeVersionText detected. NEXUS durable-core validation requires Node.js 22.16.0 or newer."
    }
    Write-Host "Node.js $nodeVersionText detected." -ForegroundColor Green

    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $dataDir = Join-Path $RepoRoot 'data'
    if (Test-Path -LiteralPath $dataDir -PathType Container) {
        Copy-Item -LiteralPath $dataDir -Destination (Join-Path $BackupDir 'data') -Recurse -Force
        Write-Host "Local NEXUS data backup: $BackupDir" -ForegroundColor Yellow
    }
    else {
        Write-Host "No existing data directory found; validation evidence will be retained at $BackupDir" -ForegroundColor Yellow
    }

    if (-not $SkipInstall) {
        Invoke-Checked -Name 'npm ci' -Command { & npm.cmd ci }
    }

    Invoke-Checked -Name 'Claude project runtime safety policy' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\verify-claude-runtime-policy.ps1')
    }
    Invoke-Checked -Name 'Claude Skill authority boundary self-test' -Command {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\verify-claude-skill-authority.ps1') -SelfTest
    }
    $skillsRoot = Join-Path $RepoRoot '.claude\skills'
    if ((Test-Path -LiteralPath $skillsRoot -PathType Container) -and @(Get-ChildItem -LiteralPath $skillsRoot -Recurse -File -Filter 'SKILL.md' -ErrorAction SilentlyContinue).Count -gt 0) {
        Invoke-Checked -Name 'Installed Claude Skill runtime-authority boundary' -Command {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\verify-claude-skill-authority.ps1') -SkillsRoot $skillsRoot
        }
    }
    Invoke-Checked -Name 'TypeScript check' -Command { & npm.cmd run check }
    Invoke-Checked -Name 'Production model promotion evidence rules' -Command { & npm.cmd run verify:model-promotion }
    Invoke-Checked -Name 'Claude runtime identity and usage evidence contract' -Command { & npm.cmd run verify:claude-runtime-evidence }
    Invoke-Checked -Name 'Claude runtime attestation and automatic capability degradation' -Command { & npm.cmd run verify:runtime-attestation }
    Invoke-Checked -Name 'Per-task Claude tool, MCP and Skill envelope' -Command { & npm.cmd run verify:claude-tool-envelope }
    Invoke-Checked -Name 'READY capability-backed Claude Skill admission' -Command { & npm.cmd run verify:claude-skill-admission }
    Invoke-Checked -Name 'Bounded Secure Bridge Claude executor' -Command { & npm.cmd run verify:secure-claude-executor }
    Invoke-Checked -Name 'Capability readiness verification' -Command { & npm.cmd run verify:capabilities }
    Invoke-Checked -Name 'Capability evidence drift/expiry invalidation' -Command { & npm.cmd run verify:capability-evidence }
    Invoke-Checked -Name 'Preview-first capability evidence recorder' -Command { & npm.cmd run verify:capability-recorder }
    Invoke-Checked -Name 'Persistent Goal Engine verification' -Command { & npm.cmd run verify:goals }
    Invoke-Checked -Name 'Fingerprint-bound Goal task approval verification' -Command { & npm.cmd run verify:goal-task-approvals }
    Invoke-Checked -Name 'NEXUS emergency stop verification' -Command { & npm.cmd run verify:emergency-stop }
    Invoke-Checked -Name 'Deterministic Goal task Verifier verification' -Command { & npm.cmd run verify:goal-task-verifier }
    Invoke-Checked -Name 'Stuck/dead-loop detector verification' -Command { & npm.cmd run verify:stuck }
    Invoke-Checked -Name 'Persistent diagnostics and bounded replan verification' -Command { & npm.cmd run verify:replan }
    Invoke-Checked -Name 'Deterministic automatic resume verification' -Command { & npm.cmd run verify:resume }
    Invoke-Checked -Name 'Deterministic NEXUS runtime cycle verification' -Command { & npm.cmd run verify:runtime-cycle }
    Invoke-Checked -Name 'Semantic Secure Bridge runtime integration verification' -Command { & npm.cmd run verify:secure-bridge-runtime }
    Invoke-Checked -Name 'Persistent goal dashboard verification' -Command { & npm.cmd run verify:goal-dashboard }
    Invoke-Checked -Name 'Deterministic collaboration-loop acceptance' -Command { & npm.cmd run verify:collaboration-e2e }
    Invoke-Checked -Name 'OpenAI strategy adapter verification (mock transport, no secret/network)' -Command { & npm.cmd run verify:openai-strategy }
    Invoke-Checked -Name 'SQLite durable-store verification' -Command { & npm.cmd run verify:sqlite }
    Invoke-Checked -Name 'Configured NEXUS system verification' -Command { & npm.cmd run verify:system }

    $originalStorageDriver = $env:NEXUS_STORAGE_DRIVER
    try {
        $env:NEXUS_STORAGE_DRIVER = 'json'
        Invoke-Checked -Name 'JSON rollback-path verification' -Command { & npm.cmd run verify:system }
    }
    finally {
        $env:NEXUS_STORAGE_DRIVER = $originalStorageDriver
    }

    $validationPort = Get-FreeLoopbackPort
    $env:NEXUS_DASHBOARD_HOST = '127.0.0.1'
    $env:NEXUS_DASHBOARD_PORT = [string]$validationPort
    $env:NEXUS_DASHBOARD_TOKEN = "nexus-verify-$([guid]::NewGuid().ToString('N'))"
    $env:NEXUS_GUARDIAN_HEALTH_URL = "http://127.0.0.1:$validationPort/api/health"
    $env:NEXUS_GUARDIAN_REPORT_DIR = $ValidationReportDir
    $env:NEXUS_WATCHDOG_AUTO_RESTART = 'false'

    $stdout = Join-Path $BackupDir 'dashboard.out.log'
    $stderr = Join-Path $BackupDir 'dashboard.err.log'
    $DashboardProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dashboard') -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $StartedDashboard = $true

    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-DashboardHealth -Url $env:NEXUS_GUARDIAN_HEALTH_URL) { $healthy = $true; break }
        if ($DashboardProcess.HasExited) { break }
    }
    if (-not $healthy) {
        $tail = ''
        if (Test-Path -LiteralPath $stderr) { $tail = (Get-Content -LiteralPath $stderr -Tail 30) -join "`n" }
        throw "Temporary dashboard did not become healthy at $($env:NEXUS_GUARDIAN_HEALTH_URL). $tail"
    }

    $dashboardHeaders = @{ Authorization = "Bearer $($env:NEXUS_DASHBOARD_TOKEN)" }
    $goalView = Invoke-RestMethod -Uri "http://127.0.0.1:$validationPort/api/goals" -Headers $dashboardHeaders -TimeoutSec 3
    if ($null -eq $goalView.summary -or $null -eq $goalView.goals -or [string]::IsNullOrWhiteSpace([string]$goalView.generatedAt)) {
        throw 'Authenticated /api/goals did not return the expected read-only goal dashboard envelope.'
    }
    Write-Host 'PASS authenticated persistent goal dashboard API' -ForegroundColor Green

    $goalApprovals = Invoke-RestMethod -Uri "http://127.0.0.1:$validationPort/api/goal-approvals" -Headers $dashboardHeaders -TimeoutSec 3
    if ($null -eq $goalApprovals.approvals) {
        throw 'Authenticated /api/goal-approvals did not return the expected approval envelope.'
    }
    Write-Host 'PASS authenticated fingerprint-bound goal approval API' -ForegroundColor Green

    $unauthorizedRejected = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$validationPort/api/goal-approvals" -TimeoutSec 3 | Out-Null
    }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
            $unauthorizedRejected = $true
        }
    }
    if (-not $unauthorizedRejected) {
        throw 'Unauthenticated /api/goal-approvals request was not rejected with HTTP 401.'
    }
    Write-Host 'PASS unauthenticated goal approval API rejection' -ForegroundColor Green

    Invoke-Checked -Name 'Guardian report' -Command { & npm.cmd run guardian:check }
    Invoke-Checked -Name 'Watchdog one-shot heartbeat' -Command { & npm.cmd run guardian:watchdog:once }

    if (-not (Test-Path -LiteralPath $WatchdogReport -PathType Leaf)) {
        throw "Watchdog report was not created: $WatchdogReport"
    }
    $watchdog = Get-Content -LiteralPath $WatchdogReport -Raw | ConvertFrom-Json
    if (-not $watchdog.ok) {
        throw "Watchdog heartbeat was not healthy. Details: $($watchdog.details)"
    }
    if ($watchdog.action -ne 'none') {
        throw "Watchdog attempted an unexpected recovery action during safe validation: $($watchdog.action)"
    }

    Write-Host "`nNEXUS WINDOWS LAPTOP VALIDATION: PASS" -ForegroundColor Green
    Write-Host 'Validated: Claude runtime safety policy, Claude Skill authority boundary, dependencies, TypeScript, production model-promotion evidence rules, Claude runtime identity/usage evidence, runtime attestation with fail-closed capability degradation/recovery, per-task Claude tool/MCP/Skill isolation, bounded Secure Bridge Claude execution, READY capability-backed exact Skill(name) admission, capability gating/drift/expiry invalidation, preview-first evidence recording with backup/rollback safeguards, persistent Goal Engine, fingerprint-bound per-attempt owner approvals, NEXUS emergency stop, deterministic Goal-task Verifier, stuck/dead-loop detector, persistent attempt diagnostics, bounded replanning, deterministic automatic resume, semantic Secure Bridge one-cycle orchestration, authenticated owner approval visibility, deterministic collaboration acceptance, OpenAI requested/resolved model contract, SQLite, configured system health, JSON rollback lane, isolated dashboard health, Guardian, and Watchdog heartbeat with recovery disabled.'
    Write-Host 'Provider evidence contract tests are deterministic and do not make paid OpenAI/Claude calls or require provider secrets.'
    Write-Host "Backup and validation evidence retained at: $BackupDir"
}
finally {
    Stop-StartedDashboard
    $env:NEXUS_DASHBOARD_HOST = $OriginalDashboardHost
    $env:NEXUS_DASHBOARD_PORT = $OriginalDashboardPort
    $env:NEXUS_DASHBOARD_TOKEN = $OriginalDashboardToken
    $env:NEXUS_GUARDIAN_HEALTH_URL = $OriginalGuardianHealthUrl
    $env:NEXUS_GUARDIAN_REPORT_DIR = $OriginalGuardianReportDir
    $env:NEXUS_WATCHDOG_AUTO_RESTART = $OriginalWatchdogAutoRestart
    Pop-Location
}
