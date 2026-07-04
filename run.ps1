# ============================================================================
# AppBI — one-command bootstrap for Windows (PowerShell wrapper).
#
#   .\run.ps1                # sync env, build, start, wait until healthy
#   .\run.ps1 --pull         # (any run.sh flag is forwarded verbatim)
#   .\run.ps1 --down
#
# All the real logic lives in run.sh so behaviour is identical on Windows,
# macOS and Linux. This wrapper just finds a Bash (Git Bash / WSL) and runs it.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Bash {
    $cmd = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )) { if (Test-Path $p) { return $p } }
    return $null
}

$bash = Find-Bash
if (-not $bash) {
    Write-Host "ERROR: Bash not found." -ForegroundColor Red
    Write-Host "Install 'Git for Windows' (https://git-scm.com/download/win) — it bundles Git Bash — then re-run .\run.ps1"
    Write-Host "Or run inside WSL:  wsl ./run.sh"
    exit 1
}

& $bash "$root/run.sh" @args
exit $LASTEXITCODE
