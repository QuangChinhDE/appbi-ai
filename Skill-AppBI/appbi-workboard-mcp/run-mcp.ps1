param(
    # Stage profiles shrink the tool surface for power users. Default is `all`
    # (the whole Source -> Dataset -> Data Model -> Workboard journey) so a
    # tester needs zero configuration. Combine with commas by setting
    # $env:APPBI_MCP_PROFILE before launching (e.g. "discover,build").
    [ValidateSet('all', 'discover', 'source', 'dataset', 'model', 'build', 'deliver')]
    [string]$Profile = 'all'
)

$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

$env:APPBI_MCP_PROFILE = $Profile

$envPath = Join-Path $PSScriptRoot '.env'

if (-not (Test-Path $envPath)) {
    Write-Error 'Missing .env. Run .\setup-mcp.ps1 (or copy .env.example to .env) and fill APPBI_BASE_URL + APPBI_PAT first.'
    exit 1
}

$envContent = Get-Content $envPath -Raw
if ($envContent -match 'APPBI_PAT\s*=\s*$' -or $envContent -match 'replace_me') {
    Write-Error 'APPBI_PAT in .env is empty or still a placeholder. Run .\bootstrap-pat.ps1 to mint one (or set APPBI_PAT manually).'
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

& $venvPython (Join-Path $PSScriptRoot 'appbi_workboard_mcp.py')
