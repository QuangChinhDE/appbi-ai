# Docker Startup Verification Script
# Run this after: docker-compose up -d

Write-Host "`n🐳 AppBI Docker Startup Verification" -ForegroundColor Cyan
Write-Host "====================================`n" -ForegroundColor Cyan

# Check if Docker is running
Write-Host "Checking Docker..." -ForegroundColor Yellow
try {
    docker --version | Out-Null
    Write-Host "✅ Docker is installed and running`n" -ForegroundColor Green
} catch {
    Write-Host "❌ Docker is not running or not installed`n" -ForegroundColor Red
    exit 1
}

# Check if docker-compose is available
Write-Host "Checking Docker Compose..." -ForegroundColor Yellow
try {
    docker-compose --version | Out-Null
    Write-Host "✅ Docker Compose is available`n" -ForegroundColor Green
} catch {
    Write-Host "❌ Docker Compose is not available`n" -ForegroundColor Red
    exit 1
}

# Check container status
Write-Host "Checking containers..." -ForegroundColor Yellow
$containers = docker-compose ps --format json | ConvertFrom-Json

$dbStatus = $containers | Where-Object { $_.Service -eq "db" } | Select-Object -ExpandProperty State -ErrorAction SilentlyContinue
$backendStatus = $containers | Where-Object { $_.Service -eq "backend" } | Select-Object -ExpandProperty State -ErrorAction SilentlyContinue
$frontendStatus = $containers | Where-Object { $_.Service -eq "frontend" } | Select-Object -ExpandProperty State -ErrorAction SilentlyContinue

if ($dbStatus -eq "running") {
    Write-Host "✅ Database (PostgreSQL) is running" -ForegroundColor Green
} else {
    Write-Host "❌ Database is not running (Status: $dbStatus)" -ForegroundColor Red
}

if ($backendStatus -eq "running") {
    Write-Host "✅ Backend (FastAPI) is running" -ForegroundColor Green
} else {
    Write-Host "❌ Backend is not running (Status: $backendStatus)" -ForegroundColor Red
}

if ($frontendStatus -eq "running") {
    Write-Host "✅ Frontend (Next.js) is running`n" -ForegroundColor Green
} else {
    Write-Host "❌ Frontend is not running (Status: $frontendStatus)`n" -ForegroundColor Red
}

# Check endpoints
Write-Host "Checking endpoints..." -ForegroundColor Yellow

# Backend health
try {
    $backend = Invoke-WebRequest -Uri "http://localhost:8000/docs" -UseBasicParsing -TimeoutSec 5
    Write-Host "✅ Backend API is responding (http://localhost:8000)" -ForegroundColor Green
} catch {
    Write-Host "❌ Backend API is not responding" -ForegroundColor Red
}

# Frontend health
try {
    $frontend = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
    Write-Host "✅ Frontend is responding (http://localhost:3000)`n" -ForegroundColor Green
} catch {
    Write-Host "❌ Frontend is not responding`n" -ForegroundColor Red
}

# Check database connection
Write-Host "Checking database connection..." -ForegroundColor Yellow
try {
    $dbCheck = docker-compose exec -T db psql -U appbi -d appbi -c "SELECT 1" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Database connection successful`n" -ForegroundColor Green
    } else {
        Write-Host "❌ Database connection failed`n" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Could not check database connection`n" -ForegroundColor Red
}

# Check migrations
Write-Host "Checking database migrations..." -ForegroundColor Yellow
try {
    $migration = docker-compose exec -T backend alembic current 2>&1
    if ($migration -match "head") {
        Write-Host "✅ Migrations are up to date`n" -ForegroundColor Green
    } else {
        Write-Host "⚠️ Migrations may not be current`n" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Could not check migrations`n" -ForegroundColor Red
}

# Summary
Write-Host "====================================`n" -ForegroundColor Cyan
Write-Host "🎯 Access Points:" -ForegroundColor Cyan
Write-Host "   Frontend:  http://localhost:3000" -ForegroundColor White
Write-Host "   Backend:   http://localhost:8000" -ForegroundColor White
Write-Host "   API Docs:  http://localhost:8000/docs" -ForegroundColor White
Write-Host "   Database:  localhost:5432 (appbi/appbi)`n" -ForegroundColor White

Write-Host "📊 Quick Commands:" -ForegroundColor Cyan
Write-Host "   View logs:     docker-compose logs -f" -ForegroundColor White
Write-Host "   Stop all:      docker-compose down" -ForegroundColor White
Write-Host "   Restart:       docker-compose restart" -ForegroundColor White
Write-Host "   Check status:  docker-compose ps`n" -ForegroundColor White

Write-Host "✅ Verification complete!`n" -ForegroundColor Green
