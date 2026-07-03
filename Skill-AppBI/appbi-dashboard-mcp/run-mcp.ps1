param(
    # Default is the lean `core` surface (discovery + materialize). Opt into
    # more with -Profile design / admin / all. For comma combos
    # (e.g. core,design) set $env:APPBI_MCP_PROFILE before launching instead.
    [ValidateSet('core', 'design', 'admin', 'all', 'report', 'dataset', 'explore')]
    [string]$Profile = 'core'
)

$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

$env:APPBI_MCP_PROFILE = $Profile

$envPath = Join-Path $PSScriptRoot '.env'

if (-not (Test-Path $envPath)) {
    Write-Error 'Missing .env. Copy .env.example to .env and fill APPBI_BASE_URL + APPBI_PAT first.'
    exit 1
}

$envContent = Get-Content $envPath -Raw
if ($envContent -match 'APPBI_PAT\s*=\s*$' -or $envContent -match 'replace_me') {
    Write-Error 'APPBI_PAT in .env is empty or still a placeholder. Edit .env first.'
    exit 1
}

$venvPath = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venvPath 'Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    $bootstrapPython = $null

    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        $bootstrapPython = @{ Cmd = 'py'; Args = @('-3') }
    }

    if (-not $bootstrapPython) {
        $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCmd) {
            $bootstrapPython = @{ Cmd = 'python'; Args = @() }
        }
    }

    if (-not $bootstrapPython) {
        $candidatePaths = @(
            "$env:LOCALAPPDATA\Programs\Python\Launcher\py.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
            "C:\Python312\python.exe",
            "C:\Python311\python.exe"
        )
        foreach ($candidate in $candidatePaths) {
            if (Test-Path $candidate) {
                if ($candidate -like '*py.exe') {
                    $bootstrapPython = @{ Cmd = $candidate; Args = @('-3') }
                }
                else {
                    $bootstrapPython = @{ Cmd = $candidate; Args = @() }
                }
                break
            }
        }
    }

    if (-not $bootstrapPython) {
        Write-Error 'Could not find Python (py launcher or python.exe). Install Python 3.10+ or add it to PATH.'
        exit 1
    }

    & $bootstrapPython.Cmd @($bootstrapPython.Args + @('-m', 'venv', $venvPath))

    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
}

& $venvPython (Join-Path $PSScriptRoot 'appbi_orchestrator_mcp.py')
