[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SettingsPath = Join-Path $RepoRoot '.claude\settings.json'
$HookPath = Join-Path $RepoRoot '.claude\hooks\block-destructive.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Assert-True (Test-Path -LiteralPath $SettingsPath -PathType Leaf) "Missing project Claude settings: $SettingsPath"
Assert-True (Test-Path -LiteralPath $HookPath -PathType Leaf) "Missing command safety hook: $HookPath"

$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
Assert-True ($settings.autoMemoryEnabled -eq $false) 'Claude auto memory must be disabled for deterministic NEXUS project execution.'
Assert-True ($settings.disableBundledSkills -eq $true) 'Bundled Claude skills must be disabled so NEXUS uses only reviewed project skills for production routing.'
Assert-True ($settings.disableSkillShellExecution -eq $true) 'Dynamic shell preprocessing inside project skills must be disabled.'
Assert-True ($settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS -eq '1') 'Background Claude tasks must remain disabled until NEXUS child-envelope/concurrency accounting is implemented.'
Assert-True ($settings.permissions.defaultMode -eq 'default') 'Interactive project defaultMode must remain default; NEXUS unattended envelopes override it with dontAsk.'
Assert-True ($settings.permissions.disableAutoMode -eq 'disable') 'Claude auto mode must be disabled for NEXUS project execution.'
Assert-True ($settings.permissions.disableBypassPermissionsMode -eq 'disable') 'Claude bypassPermissions mode must be disabled.'
Assert-True ($settings.permissions.PSObject.Properties.Name -notcontains 'allow') 'Project settings must not contain session-wide allow rules; unattended auto-approval belongs in the per-task execution envelope.'

$deny = @($settings.permissions.deny)
$protectedPatterns = @(
    '**/.env',
    '**/.env.local',
    '**/.env.production',
    '**/.env.development',
    '**/.env.test',
    'secrets/**',
    '**/.claude/settings.local.json',
    '**/.npmrc',
    '~/.ssh/**',
    '~/.aws/credentials',
    '~/.netrc',
    '~/.git-credentials'
)
foreach ($pattern in $protectedPatterns) {
    foreach ($tool in @('Read', 'Edit')) {
        $rule = "${tool}(${pattern})"
        Assert-True ($deny -contains $rule) "Claude sensitive file deny rule is missing: $rule"
    }
}

$preTool = @($settings.hooks.PreToolUse)
Assert-True ($preTool.Count -ge 1) 'A PreToolUse hook is required.'
$commandHook = $preTool | Where-Object { $_.matcher -eq 'Bash|PowerShell' } | Select-Object -First 1
Assert-True ($null -ne $commandHook) 'PreToolUse must cover Bash and PowerShell.'
$handler = @($commandHook.hooks) | Where-Object { $_.type -eq 'command' -and $_.command -eq 'powershell.exe' } | Select-Object -First 1
Assert-True ($null -ne $handler) 'The command safety hook must use the deterministic PowerShell handler.'
Assert-True ((@($handler.args) -join ' ') -match 'block-destructive\.ps1') 'The command safety hook must reference block-destructive.ps1.'

function Invoke-HookProbe {
    param([string]$Command)
    $payload = @{ tool_name = 'Bash'; tool_input = @{ command = $Command } } | ConvertTo-Json -Compress
    $output = $payload | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HookPath
    return ($output -join "`n").Trim()
}

$dangerousProbes = @(
    'rm -rf build',
    'Remove-Item C:\temp\build -Recurse -Force',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'git push origin main --force',
    'claude --dangerously-skip-permissions',
    'Get-Content C:\NEXUS\.nexus_security_token',
    'cat .env',
    'Get-Content packages\web\.env.local',
    'cat secrets/api-key.txt',
    'cat ~/.ssh/id_rsa',
    'Get-Content ~/.aws/credentials',
    'cat .npmrc',
    'cat ~/.npmrc',
    'echo $OPENAI_API_KEY',
    'Write-Output $env:ANTHROPIC_API_KEY',
    'printenv',
    'Get-ChildItem Env:',
    'diskpart',
    'shutdown /s /t 0'
)

foreach ($probe in $dangerousProbes) {
    $output = Invoke-HookProbe -Command $probe
    Assert-True (-not [string]::IsNullOrWhiteSpace($output)) "Dangerous/sensitive probe was not blocked: $probe"
    $decision = $output | ConvertFrom-Json
    Assert-True ($decision.hookSpecificOutput.permissionDecision -eq 'deny') "Dangerous/sensitive probe did not return deny: $probe"
}

$safeProbes = @(
    'npm run check',
    'cat README.md',
    'Get-Content .env.example'
)
foreach ($probe in $safeProbes) {
    $safeOutput = Invoke-HookProbe -Command $probe
    Assert-True ([string]::IsNullOrWhiteSpace($safeOutput)) "Safe command should defer to normal Claude permission flow without a hook decision: $probe"
}

Write-Host 'PASS Claude runtime policy: unmanaged memory/bundled skills disabled, skill shell/background execution locked down, session-wide allow rules absent, bypass/auto disabled, built-in secret reads/writes and shell secret access denied, destructive commands fail closed, and safe commands remain on normal permission flow.' -ForegroundColor Green
