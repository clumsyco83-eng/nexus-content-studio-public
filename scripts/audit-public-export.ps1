[CmdletBinding()]
param(
    [switch]$SkipHistory,
    [string[]]$ForbiddenLiteral = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) { throw 'git is not available in PATH.' }

    $failures = New-Object System.Collections.Generic.List[string]

    $tracked = @(git ls-files)
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed.' }

    $forbiddenPathPatterns = @(
        '(^|/)(\.env)(\.|$)',
        '(^|/)\.npmrc$',
        '(^|/)\.netrc$',
        '(^|/)\.git-credentials$',
        '(^|/)\.claude/settings\.local\.json$',
        '(^|/)secrets/',
        '(^|/)credentials\.json$',
        '(^|/)service-account[^/]*\.json$',
        '\.(pem|key|p12|pfx|jks|keystore)$',
        '(^|/)(id_rsa|id_ed25519)[^/]*$',
        '\.(db|sqlite|sqlite3)$'
    )

    foreach ($path in $tracked) {
        $normalized = $path.Replace('\\', '/')
        if ($normalized -eq '.env.example') { continue }
        foreach ($pattern in $forbiddenPathPatterns) {
            if ($normalized -match $pattern) {
                $failures.Add("Forbidden tracked path: $normalized")
                break
            }
        }
    }

    $secretPatterns = @(
        @{ Name = 'GitHub fine-grained token'; Regex = 'github_pat_[A-Za-z0-9_]{20,}' },
        @{ Name = 'GitHub classic/app token'; Regex = 'gh[pousr]_[A-Za-z0-9]{20,}' },
        @{ Name = 'OpenAI project key'; Regex = 'sk-proj-[A-Za-z0-9_-]{20,}' },
        @{ Name = 'AWS access key'; Regex = 'AKIA[0-9A-Z]{16}' },
        @{ Name = 'Google API key'; Regex = 'AIza[0-9A-Za-z_-]{30,}' },
        @{ Name = 'Slack token'; Regex = 'xox[baprs]-[0-9A-Za-z-]{10,}' },
        @{ Name = 'Private key material'; Regex = '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' },
        @{ Name = 'Credential in URL'; Regex = 'https?://[^/\s:@]+:[^@\s/]+@' },
        @{ Name = 'Windows user profile path'; Regex = 'C:\\Users\\[^\\\s]+' }
    )

    foreach ($path in $tracked) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            $text = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
        }
        catch {
            continue
        }

        foreach ($entry in $secretPatterns) {
            if ($text -match $entry.Regex) {
                $failures.Add("$($entry.Name) pattern found in tracked file: $path")
            }
        }

        foreach ($literal in $ForbiddenLiteral) {
            if ([string]::IsNullOrWhiteSpace($literal)) { continue }
            if ($text.IndexOf($literal, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $failures.Add("Forbidden private literal found in tracked file: $path")
            }
        }
    }

    if (-not $SkipHistory) {
        $identityLines = @(git log --all --format='%H%x09%an%x09%ae%x09%cn%x09%ce')
        if ($LASTEXITCODE -ne 0) { throw 'git log identity scan failed.' }

        foreach ($line in $identityLines) {
            $parts = $line -split "`t"
            if ($parts.Count -lt 5) { continue }
            $sha = $parts[0]
            foreach ($email in @($parts[2], $parts[4])) {
                if ([string]::IsNullOrWhiteSpace($email)) { continue }
                $lower = $email.ToLowerInvariant()
                $allowed = $lower.EndsWith('@users.noreply.github.com') -or $lower -eq 'noreply@github.com'
                if (-not $allowed) {
                    $failures.Add("Non-private commit email in history at $sha")
                }
            }
        }
    }

    if ($failures.Count -gt 0) {
        Write-Host 'PUBLIC EXPORT PRIVACY AUDIT: FAIL' -ForegroundColor Red
        $failures | Sort-Object -Unique | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
        throw "Public export privacy audit found $($failures.Count) issue(s)."
    }

    Write-Host 'PUBLIC EXPORT PRIVACY AUDIT: PASS' -ForegroundColor Green
    Write-Host "Tracked files checked: $($tracked.Count)"
    if ($SkipHistory) {
        Write-Host 'Commit identity history scan: SKIPPED'
    }
    else {
        Write-Host 'Commit identity history scan: PASS'
    }
}
finally {
    Pop-Location
}
