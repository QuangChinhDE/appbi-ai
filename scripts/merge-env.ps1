# ──────────────────────────────────────────────────────────────
# merge-env.ps1 — Safely merge new vars from .env.example → .env
#
# What it does:
#   1. Keeps ALL existing values in .env untouched
#   2. Appends vars that exist in .env.example but NOT in .env
#   3. Warns about vars in .env that no longer exist in .env.example
#   4. Shows a summary of what changed
#
# Usage:
#   .\scripts\merge-env.ps1                                # default
#   .\scripts\merge-env.ps1 -Source .env.google.example    # custom
# ──────────────────────────────────────────────────────────────
param(
    [string]$Source = ".env.example",
    [string]$Target = ".env"
)

$ErrorActionPreference = "Stop"

# Navigate to repo root
Push-Location (Split-Path $PSScriptRoot)
try {
    if (-not (Test-Path $Source)) {
        Write-Host "ERROR: $Source not found" -ForegroundColor Red; exit 1
    }

    # First-time setup
    if (-not (Test-Path $Target)) {
        Copy-Item $Source $Target
        Write-Host "Created $Target from $Source (first-time setup)" -ForegroundColor Green
        exit 0
    }

    # Extract KEY names (ignore comments, blank lines)
    function Get-EnvKeys([string]$file) {
        Get-Content $file |
            Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
            ForEach-Object { ($_ -split '=', 2)[0] } |
            Sort-Object -Unique
    }

    # Extract KEY=VALUE map
    function Get-EnvMap([string]$file) {
        $map = @{}
        Get-Content $file | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
            $parts = $_ -split '=', 2
            if (-not $map.ContainsKey($parts[0])) {
                $map[$parts[0]] = $parts[1]
            }
        }
        $map
    }

    $sourceKeys = Get-EnvKeys $Source
    $targetKeys = Get-EnvKeys $Target
    $sourceMap  = Get-EnvMap $Source

    $newKeys     = $sourceKeys | Where-Object { $_ -notin $targetKeys }
    $removedKeys = $targetKeys | Where-Object { $_ -notin $sourceKeys }

    # Nothing to do?
    if (-not $newKeys -and -not $removedKeys) {
        Write-Host "`u{2713} $Target is already up to date with $Source" -ForegroundColor Green
        exit 0
    }

    # Backup
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $backup = "${Target}.bak.${timestamp}"
    Copy-Item $Target $backup
    Write-Host "Backup: $backup" -ForegroundColor DarkGray

    # Add new keys
    $addedCount = 0
    if ($newKeys) {
        Write-Host ""
        Write-Host "-- Adding new variables --" -ForegroundColor Cyan
        Add-Content $Target ""
        Add-Content $Target "# -- Merged from $Source on $(Get-Date -Format 'yyyy-MM-dd') --"

        foreach ($key in $newKeys) {
            $val = $sourceMap[$key]
            $line = "${key}=${val}"
            Add-Content $Target $line
            Write-Host "  + $line" -ForegroundColor Green
            $addedCount++
        }
    }

    # Warn about removed keys
    $removedCount = 0
    if ($removedKeys) {
        Write-Host ""
        Write-Host "-- Variables in $Target but NOT in $Source (may be obsolete) --" -ForegroundColor Yellow
        foreach ($key in $removedKeys) {
            Write-Host "  ? $key" -ForegroundColor Yellow
            $removedCount++
        }
        Write-Host ""
        Write-Host "These were NOT auto-removed. Delete manually if no longer needed." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "Summary: +${addedCount} added, ${removedCount} possibly obsolete"
    Write-Host "Review $Target then run: docker compose up -d --build"

} finally {
    Pop-Location
}
