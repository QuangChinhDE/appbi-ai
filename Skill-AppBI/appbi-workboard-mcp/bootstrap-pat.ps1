# One-time: mint an AppBI Personal Access Token and write it into .env.
# Uses the MCP's .venv (creates it if missing). Pass-through args go to
# bootstrap_pat.py, e.g.:  .\bootstrap-pat.ps1 --email you@co.vn
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host 'No .venv yet — creating it and installing dependencies…'
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { & py -3 -m venv (Join-Path $PSScriptRoot '.venv') }
    else { & python -m venv (Join-Path $PSScriptRoot '.venv') }
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
}

& $venvPython (Join-Path $PSScriptRoot 'bootstrap_pat.py') @args
