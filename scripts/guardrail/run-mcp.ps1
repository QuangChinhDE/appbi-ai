# AppBI Engineering Guardrail MCP launcher (Windows PowerShell).
# Read-only analyzer — no .env / PAT needed. Optionally set APPBI_REPO_ROOT if
# the AppBI repo is not two directories above this script.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $env:APPBI_REPO_ROOT) {
    $env:APPBI_REPO_ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    $bootstrap = $null
    if (Get-Command py -ErrorAction SilentlyContinue) { $bootstrap = @{ Cmd = 'py'; Args = @('-3') } }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { $bootstrap = @{ Cmd = 'python'; Args = @() } }
    else { Write-Error 'Python 3.10+ not found (py launcher or python.exe).'; exit 1 }
    & $bootstrap.Cmd @($bootstrap.Args + @('-m', 'venv', (Join-Path $PSScriptRoot '.venv')))
    & $venvPython -m pip install --upgrade pip | Out-Null
    & $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
}

& $venvPython (Join-Path $PSScriptRoot 'appbi_guardrail_mcp.py')
