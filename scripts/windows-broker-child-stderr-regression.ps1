[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BrokerPath = Join-Path $PSScriptRoot 'powershell-broker-v1.ps1'
if (-not (Test-Path -LiteralPath $BrokerPath -PathType Leaf)) {
    throw 'Production PowerShell broker was not found.'
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($BrokerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
    throw "Production broker does not parse: $($parseErrors[0].Message)"
}

$wanted = @('Invoke-NpmCheckedQuiet', 'Invoke-PowerShellScriptCheckedQuiet')
foreach ($name in $wanted) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $functionAst) { throw "Production broker helper missing: $name" }
    Invoke-Expression $functionAst.Extent.Text
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('nexus-broker-stderr-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null

    $packageJson = @'
{
  "name": "nexus-broker-stderr-fixture",
  "private": true,
  "scripts": {
    "stderr-ok": "node -e \"process.stderr.write('harmless npm stderr\\n'); process.exit(0)\"",
    "stderr-fail": "node -e \"process.stderr.write('real npm failure\\n'); process.exit(7)\""
  }
}
'@
    Set-Content -LiteralPath (Join-Path $temp 'package.json') -Value $packageJson -Encoding ascii

    $psOk = Join-Path $temp 'stderr-ok.ps1'
    @'
[Console]::Error.WriteLine('harmless PowerShell stderr')
exit 0
'@ | Set-Content -LiteralPath $psOk -Encoding ascii

    $psFail = Join-Path $temp 'stderr-fail.ps1'
    @'
[Console]::Error.WriteLine('real PowerShell failure')
exit 9
'@ | Set-Content -LiteralPath $psFail -Encoding ascii

    Push-Location $temp
    try {
        $beforePreference = $ErrorActionPreference

        Invoke-NpmCheckedQuiet -Arguments @('run', 'stderr-ok', '--silent')
        if ($ErrorActionPreference -ne $beforePreference) { throw 'npm helper did not restore ErrorActionPreference.' }

        $npmRejected = $false
        try { Invoke-NpmCheckedQuiet -Arguments @('run', 'stderr-fail', '--silent') }
        catch { $npmRejected = ($_.Exception.Message -match 'exitCode=7') }
        if (-not $npmRejected) { throw 'npm helper did not reject the real nonzero child exit.' }
        if ($ErrorActionPreference -ne $beforePreference) { throw 'npm failure path did not restore ErrorActionPreference.' }

        Invoke-PowerShellScriptCheckedQuiet -ScriptPath $psOk
        if ($ErrorActionPreference -ne $beforePreference) { throw 'PowerShell helper did not restore ErrorActionPreference.' }

        $psRejected = $false
        try { Invoke-PowerShellScriptCheckedQuiet -ScriptPath $psFail }
        catch { $psRejected = ($_.Exception.Message -match 'exitCode=9') }
        if (-not $psRejected) { throw 'PowerShell helper did not reject the real nonzero child exit.' }
        if ($ErrorActionPreference -ne $beforePreference) { throw 'PowerShell failure path did not restore ErrorActionPreference.' }
    }
    finally {
        Pop-Location
    }

    Write-Host 'PASS broker child stderr classification: harmless native stderr is ignored when exit=0; real npm/PowerShell nonzero exits remain fail-closed.' -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
