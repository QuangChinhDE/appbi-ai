# ──────────────────────────────────────────────────────────────
# migrate-metadata-postgres.ps1
#
# Dump AppBI metadata from an old PostgreSQL Docker container and
# restore it into the current metadata database.
#
# Defaults:
#   - Source DB settings are auto-detected from the source container env
#     (POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB) when possible.
#   - Target DB settings are read from .env (DATABASE_URL or DB_* vars)
#     unless you override them with parameters.
#
# Typical usage:
#   .\scripts\migrate-metadata-postgres.ps1 -SourceContainer appbi-db-old
#   .\scripts\migrate-metadata-postgres.ps1 -SourceContainer appbi-db-old -DumpOnly
#   .\scripts\migrate-metadata-postgres.ps1 -SourceContainer appbi-db-old -TargetHost db.example.com -TargetPort 5432 -TargetDbUser appbi -TargetDbPassword secret -TargetDbName appbi
#
# Notes:
#   1. The target database must already exist.
#   2. If the restored DB is older than current code, start/restart backend
#      after restore so Alembic upgrades it to head.
#   3. If DB_HOST in .env is localhost/127.0.0.1, the restore container uses
#      host.docker.internal automatically so Docker Desktop can reach it.
# ──────────────────────────────────────────────────────────────
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceContainer,

    [string]$SourceDbName,
    [string]$SourceDbUser,
    [string]$SourceDbPassword,

    [string]$TargetHost,
    [int]$TargetPort = 0,
    [string]$TargetDbName,
    [string]$TargetDbUser,
    [string]$TargetDbPassword,
    [string]$TargetDatabaseUrl,
    [string]$TargetNetwork = "appbi-net",

    [string]$DumpPath,

    [switch]$DumpOnly,
    [switch]$RestoreOnly,
    [switch]$SkipClean
)

$ErrorActionPreference = "Stop"

if ($DumpOnly -and $RestoreOnly) {
    throw "Use either -DumpOnly or -RestoreOnly, not both."
}

function Get-EnvMap([string]$filePath) {
    $map = @{}
    if (-not (Test-Path $filePath)) {
        return $map
    }

    Get-Content $filePath | ForEach-Object {
        if ($_ -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $_ -split '=', 2
            if (-not $map.ContainsKey($parts[0])) {
                $map[$parts[0]] = $parts[1].Trim()
            }
        }
    }

    return $map
}

function Get-DockerContainerEnv([string]$containerName) {
    $raw = & docker inspect $containerName --format '{{json .Config.Env}}' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect source container '$containerName'.`n$raw"
    }

    $map = @{}
    $items = $raw | ConvertFrom-Json
    foreach ($item in $items) {
        $parts = $item -split '=', 2
        if ($parts.Length -eq 2 -and -not $map.ContainsKey($parts[0])) {
            $map[$parts[0]] = $parts[1]
        }
    }

    return $map
}

function Get-DockerContainerRunning([string]$containerName) {
    $raw = & docker inspect $containerName --format '{{.State.Running}}' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect source container '$containerName'.`n$raw"
    }
    return $raw.ToString().Trim().ToLowerInvariant() -eq 'true'
}

function Test-DockerNetwork([string]$networkName) {
    if (-not $networkName) {
        return $false
    }
    & docker network inspect $networkName *> $null
    return $LASTEXITCODE -eq 0
}

function Get-FirstNonEmpty([object[]]$values) {
    foreach ($value in $values) {
        if ($null -eq $value) {
            continue
        }
        $text = [string]$value
        if ($text.Trim()) {
            return $text.Trim()
        }
    }
    return $null
}

function Parse-DatabaseUrl([string]$rawUrl) {
    $result = @{}
    if (-not $rawUrl -or -not $rawUrl.Trim()) {
        return $result
    }

    $normalized = $rawUrl.Trim() -replace '^postgresql\+psycopg2://', 'postgresql://'
    $uri = [System.Uri]$normalized

    $user = $null
    $password = $null
    if ($uri.UserInfo) {
        $userInfoParts = $uri.UserInfo -split ':', 2
        if ($userInfoParts.Length -ge 1) {
            $user = [System.Uri]::UnescapeDataString($userInfoParts[0])
        }
        if ($userInfoParts.Length -eq 2) {
            $password = [System.Uri]::UnescapeDataString($userInfoParts[1])
        }
    }

    $result['Host'] = $uri.Host
    $result['Port'] = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    $result['User'] = $user
    $result['Password'] = $password
    $result['DbName'] = $uri.AbsolutePath.TrimStart('/')
    return $result
}

function Ensure-AbsolutePath([string]$baseDir, [string]$candidatePath) {
    if ([System.IO.Path]::IsPathRooted($candidatePath)) {
        return [System.IO.Path]::GetFullPath($candidatePath)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $baseDir $candidatePath))
}

function Wait-ForPostgresInContainer(
    [string]$containerName,
    [string]$dbUser,
    [string]$dbName,
    [int]$timeoutSeconds = 60
) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        & docker exec $containerName pg_isready -U $dbUser -d $dbName *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Start-Sleep -Seconds 2
    }

    throw "Timed out waiting for PostgreSQL in container '$containerName' to become ready."
}

function New-RestoreReadyDump([string]$sourceDumpPath) {
    $sourceLines = Get-Content $sourceDumpPath
    $filteredLines = New-Object System.Collections.Generic.List[string]
    $removedCount = 0

    foreach ($line in $sourceLines) {
        if (
            $line -match '^DROP EXTENSION IF EXISTS vector;' -or
            $line -match '^CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;' -or
            $line -match '^COMMENT ON EXTENSION vector IS '
        ) {
            $removedCount++
            continue
        }
        [void]$filteredLines.Add($line)
    }

    if ($removedCount -eq 0) {
        return $sourceDumpPath
    }

    $restoreDumpPath = Join-Path (Split-Path -Parent $sourceDumpPath) (([System.IO.Path]::GetFileNameWithoutExtension($sourceDumpPath)) + '.restore.sql')
    Set-Content -Path $restoreDumpPath -Value $filteredLines -Encoding UTF8
    Write-Host "Prepared restore-safe dump at $restoreDumpPath (removed $removedCount pgvector extension statement(s))." -ForegroundColor Yellow
    return $restoreDumpPath
}

Push-Location (Split-Path $PSScriptRoot)
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "docker command not found in PATH."
    }

    $repoRoot = (Get-Location).Path
    $envMap = Get-EnvMap (Join-Path $repoRoot ".env")

    if (-not $DumpPath) {
        $artifactDir = Join-Path $repoRoot ".artifacts"
        New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
        $DumpPath = Join-Path $artifactDir ("appbi-metadata-" + (Get-Date -Format "yyyyMMddHHmmss") + ".sql")
    }
    $DumpPath = Ensure-AbsolutePath $repoRoot $DumpPath
    $dumpDir = Split-Path -Parent $DumpPath
    if (-not (Test-Path $dumpDir)) {
        New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
    }

    $sourceStartedHere = $false
    if (-not (Get-DockerContainerRunning $SourceContainer)) {
        Write-Host "Source container is stopped; starting it temporarily..." -ForegroundColor Yellow
        $startOutput = & docker start $SourceContainer 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not start source container '$SourceContainer'.`n$startOutput"
        }
        $sourceStartedHere = $true
    }

    $sourceEnv = Get-DockerContainerEnv $SourceContainer
    $SourceDbUser = Get-FirstNonEmpty @($SourceDbUser, $sourceEnv['POSTGRES_USER'], $sourceEnv['DB_USER'], 'appbi')
    $SourceDbPassword = Get-FirstNonEmpty @($SourceDbPassword, $sourceEnv['POSTGRES_PASSWORD'], $sourceEnv['DB_PASSWORD'])
    $SourceDbName = Get-FirstNonEmpty @($SourceDbName, $sourceEnv['POSTGRES_DB'], $sourceEnv['DB_NAME'], 'appbi')

    if (-not $RestoreOnly) {
        Write-Host "Waiting for PostgreSQL in '$SourceContainer' to become ready..." -ForegroundColor Cyan
        Wait-ForPostgresInContainer -containerName $SourceContainer -dbUser $SourceDbUser -dbName $SourceDbName
    }

    if (-not $RestoreOnly) {
        $tempDumpInContainer = "/tmp/appbi-metadata-migrate.sql"
        Write-Host "Dumping metadata from '$SourceContainer' ($SourceDbName)..." -ForegroundColor Cyan

        $dumpArgs = @('exec', '-e', "PGPASSWORD=$SourceDbPassword", $SourceContainer, 'pg_dump')
        if (-not $SkipClean) {
            $dumpArgs += @('--clean', '--if-exists')
        }
        $dumpArgs += @('--no-owner', '--no-privileges', '-U', $SourceDbUser, '-d', $SourceDbName, '-f', $tempDumpInContainer)

        $dumpOutput = & docker @dumpArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "pg_dump failed.`n$dumpOutput"
        }

        $copyOutput = & docker cp "${SourceContainer}:$tempDumpInContainer" $DumpPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not copy dump file from source container.`n$copyOutput"
        }

        & docker exec $SourceContainer rm -f $tempDumpInContainer *> $null
        Write-Host "Dump file written to $DumpPath" -ForegroundColor Green
    }

    if ($DumpOnly) {
        Write-Host "Dump completed. No restore performed because -DumpOnly was supplied." -ForegroundColor Green
        return
    }

    if (-not (Test-Path $DumpPath)) {
        throw "Dump file '$DumpPath' does not exist."
    }

    $RestoreDumpPath = New-RestoreReadyDump $DumpPath

    $targetUrlParts = Parse-DatabaseUrl (Get-FirstNonEmpty @($TargetDatabaseUrl, $envMap['DATABASE_URL']))
    $TargetHost = Get-FirstNonEmpty @($TargetHost, $targetUrlParts['Host'], $envMap['DB_HOST'], 'appbi-db')
    if (-not $TargetPort) {
        if ($targetUrlParts.ContainsKey('Port')) {
            $TargetPort = [int]$targetUrlParts['Port']
        } elseif ($envMap.ContainsKey('DB_PORT') -and $envMap['DB_PORT']) {
            $TargetPort = [int]$envMap['DB_PORT']
        } else {
            $TargetPort = 5432
        }
    }
    $TargetDbUser = Get-FirstNonEmpty @($TargetDbUser, $targetUrlParts['User'], $envMap['DB_USER'], 'appbi')
    $TargetDbPassword = Get-FirstNonEmpty @($TargetDbPassword, $targetUrlParts['Password'], $envMap['DB_PASSWORD'])
    $TargetDbName = Get-FirstNonEmpty @($TargetDbName, $targetUrlParts['DbName'], $envMap['DB_NAME'], 'appbi')

    if (-not $TargetHost -or -not $TargetDbUser -or -not $TargetDbName) {
        throw "Target connection is incomplete. Set DATABASE_URL in .env or pass -TargetHost/-TargetDbUser/-TargetDbName explicitly."
    }

    $dockerTargetHost = if ($TargetHost -in @('localhost', '127.0.0.1', '::1')) {
        'host.docker.internal'
    } else {
        $TargetHost
    }

    $networkArgs = @()
    if (Test-DockerNetwork $TargetNetwork) {
        $networkArgs = @('--network', $TargetNetwork)
    } elseif ($dockerTargetHost -eq 'appbi-db') {
        throw "Docker network '$TargetNetwork' was not found, so host '$dockerTargetHost' is unreachable from the restore client. Start the current stack first or pass -TargetHost to a reachable hostname."
    }

    $resolvedDumpDir = Split-Path -Parent $RestoreDumpPath
    $dumpFileName = Split-Path -Leaf $RestoreDumpPath

    Write-Host "Restoring dump into ${TargetHost}:$TargetPort/$TargetDbName ..." -ForegroundColor Cyan
    $restoreArgs = @('run', '--rm') + $networkArgs + @(
        '-e', "PGPASSWORD=$TargetDbPassword",
        '-v', "${resolvedDumpDir}:/work",
        'postgres:16',
        'psql',
        '-v', 'ON_ERROR_STOP=1',
        '-h', $dockerTargetHost,
        '-p', "$TargetPort",
        '-U', $TargetDbUser,
        '-d', $TargetDbName,
        '-f', "/work/$dumpFileName"
    )

    $restoreOutput = & docker @restoreArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Restore failed.`n$restoreOutput"
    }

    Write-Host "Restore completed successfully." -ForegroundColor Green
    Write-Host "Next step: start or restart backend so Alembic can upgrade the restored schema if needed." -ForegroundColor Yellow
    Write-Host "Example: docker compose up -d --build backend" -ForegroundColor DarkGray
}
finally {
    if ($sourceStartedHere) {
        & docker stop $SourceContainer *> $null
    }
    Pop-Location
}