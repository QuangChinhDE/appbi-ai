# One-time setup for the AppBI Workboard MCP.
# Creates the virtualenv, installs requirements, and seeds .env from the
# template. Safe to re-run — it never overwrites an existing .env.
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

Write-Host '== AppBI Workboard MCP setup ==' -ForegroundColor Cyan

$venvPath = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venvPath 'Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    Write-Host 'Creating virtualenv (.venv) ...'
    $bootstrap = $null
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $bootstrap = @{ Cmd = 'py'; Args = @('-3') }
    }
    elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $bootstrap = @{ Cmd = 'python'; Args = @() }
    }
    if (-not $bootstrap) {
        Write-Error 'Python 3.10+ not found. Install it (or add to PATH) and re-run.'
        exit 1
    }
    & $bootstrap.Cmd @($bootstrap.Args + @('-m', 'venv', $venvPath))
}

Write-Host 'Installing requirements ...'
& $venvPython -m pip install --upgrade pip | Out-Null
& $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')

$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $PSScriptRoot '.env.example') $envPath
    Write-Host 'Created .env from .env.example.' -ForegroundColor Green
}
else {
    Write-Host '.env already exists — left untouched.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Set APPBI_BASE_URL in .env if it is not http://localhost:8000.'
Write-Host '  2. Mint your PAT (the connect token):  .\bootstrap-pat.ps1'
Write-Host '     (asks for AppBI email/password, writes APPBI_PAT into .env).'
Write-Host '  3. Run:  .\run-mcp.ps1            (full journey, profile=all)'
Write-Host '     Or register it in your MCP client config (see README.md).'
