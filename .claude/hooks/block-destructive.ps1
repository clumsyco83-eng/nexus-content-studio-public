$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $callInput = $raw | ConvertFrom-Json
    $command = [string]$callInput.tool_input.command
    if ([string]::IsNullOrWhiteSpace($command)) { exit 0 }

    $patterns = @(
        @{ Pattern = '(?i)(^|\s)rm\s+-[^\r\n;|&]*r[^\r\n;|&]*f'; Reason = 'Recursive forced deletion is blocked. Use a narrower reviewed deletion path.' },
        @{ Pattern = '(?i)\bRemove-Item\b[^\r\n;|&]*\s-Recurse(?:\s|$)'; Reason = 'Recursive PowerShell deletion is blocked. Use a narrower reviewed deletion path.' },
        @{ Pattern = '(?i)(^|[;&|]\s*)(?:rmdir|rd)(?:\.exe)?\s+[^\r\n;|&]*(?:/s|/S)(?:\s|$)'; Reason = 'Recursive directory deletion is blocked. Use a narrower reviewed deletion path.' },
        @{ Pattern = '(?i)\bgit\s+reset\s+--hard\b'; Reason = 'Destructive git reset is blocked by NEXUS policy.' },
        @{ Pattern = '(?i)\bgit\s+clean\s+-[^\s]*f'; Reason = 'Forced git clean is blocked by NEXUS policy.' },
        @{ Pattern = '(?i)\bgit\s+push\b[^\r\n]*?(--force(?:-with-lease)?|-f)(\s|$)'; Reason = 'Force-push is blocked. Preserve history and use a reviewed branch/PR.' },
        @{ Pattern = '(?i)(--dangerously-skip-permissions|--permission-mode\s+bypassPermissions|--allow-dangerously-skip-permissions)'; Reason = 'Claude permission bypass is disabled for NEXUS work.' },
        @{ Pattern = '(?i)(\.nexus_security_token|\.claude[/\\]settings\.local\.json)'; Reason = 'Direct shell access to NEXUS/Claude local security state is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])\.env(?!\.example(?:$|[\\/\s"''=;|&]))(?:\.[A-Za-z0-9_-]+)?(?=$|[\\/\s"''=;|&])'; Reason = 'Shell access to .env credential files is blocked. Use runtime secret injection; .env.example remains non-secret documentation.' },
        @{ Pattern = '(?i)(?:^|\s|[=;|&])(?:\.[\\/])?secrets?[\\/]'; Reason = 'Shell access to secrets directories is blocked.' },
        @{ Pattern = '(?i)[\\/]secrets?[\\/]'; Reason = 'Shell access to secrets directories is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])\.ssh(?:[\\/]|$)'; Reason = 'Shell access to SSH credential material is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])\.aws[\\/]credentials(?:$|[\s"'';|&])'; Reason = 'Shell access to AWS credentials is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])\.config[\\/]gcloud(?:[\\/]|$)'; Reason = 'Shell access to Google Cloud credential state is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])\.azure(?:[\\/]|$)'; Reason = 'Shell access to Azure credential state is blocked.' },
        @{ Pattern = '(?i)(^|[\\/\s"''=;|&])(?:\.npmrc|\.netrc|\.git-credentials)(?:$|[\s"'';|&])'; Reason = 'Shell access to local credential files is blocked.' },
        @{ Pattern = '(?i)\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|NEXUS_DASHBOARD_TOKEN|YOUTUBE_CLIENT_SECRET|META_APP_SECRET|TIKTOK_CLIENT_SECRET|TIKTOK_ACCESS_TOKEN|META_ACCESS_TOKEN|YOUTUBE_REFRESH_TOKEN)\b'; Reason = 'Shell access to secret-bearing environment variables is blocked.' },
        @{ Pattern = '(?i)(^|[;&|]\s*)(?:env|printenv)(?:\s|$)|\b(?:Get-ChildItem|Get-Item|gci|gi|dir)\s+Env:'; Reason = 'Broad shell enumeration of environment variables is blocked because it may expose credentials.' },
        @{ Pattern = '(?i)(^|[;&|]\s*)(diskpart|format(?:\.com)?\b|Clear-Disk\b|Initialize-Disk\b|Remove-Partition\b)'; Reason = 'Disk-destructive commands are outside Claude executor authority.' },
        @{ Pattern = '(?i)(^|[;&|]\s*)(shutdown(?:\.exe)?\b|Stop-Computer\b|Restart-Computer\b)'; Reason = 'Machine power control is outside Claude executor authority.' }
    )

    foreach ($entry in $patterns) {
        if ($command -match $entry.Pattern) {
            @{
                hookSpecificOutput = @{
                    hookEventName = 'PreToolUse'
                    permissionDecision = 'deny'
                    permissionDecisionReason = $entry.Reason
                }
            } | ConvertTo-Json -Depth 5 -Compress
            exit 0
        }
    }

    exit 0
}
catch {
    @{
        hookSpecificOutput = @{
            hookEventName = 'PreToolUse'
            permissionDecision = 'deny'
            permissionDecisionReason = 'NEXUS command safety hook failed closed.'
        }
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
