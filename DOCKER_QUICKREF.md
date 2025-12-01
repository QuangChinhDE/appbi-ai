# Docker Quick Reference - AppBI

## 🚀 Getting Started

```bash
# Start everything (first time - builds images)
docker-compose up --build

# Start everything (subsequent runs)
docker-compose up

# Start in background (detached)
docker-compose up -d

# Stop everything
docker-compose down

# Stop and remove all data
docker-compose down -v
```

## 🔧 Development Mode

```bash
# Start with hot reload
docker-compose -f docker-compose.dev.yml up

# Rebuild dev containers
docker-compose -f docker-compose.dev.yml up --build
```

## 📋 Common Commands

```bash
# View all logs
docker-compose logs -f

# View backend logs only
docker-compose logs -f backend

# Check service status
docker-compose ps

# Restart a service
docker-compose restart backend

# Rebuild specific service
docker-compose up --build backend

# Execute command in container
docker-compose exec backend bash
docker-compose exec db psql -U appbi -d appbi
```

## 🗄️ Database Operations

```bash
# Access database
docker-compose exec db psql -U appbi -d appbi

# Run migrations
docker-compose exec backend alembic upgrade head

# Create new migration
docker-compose exec backend alembic revision --autogenerate -m "description"

# Check migration status
docker-compose exec backend alembic current

# Backup database
docker-compose exec db pg_dump -U appbi appbi > backup.sql

# Restore database
cat backup.sql | docker-compose exec -T db psql -U appbi appbi
```

## 🧹 Cleanup

```bash
# Remove stopped containers
docker-compose rm

# Clean up all Docker resources
docker system prune -a

# Remove volumes (delete data)
docker volume prune

# Remove specific volume
docker volume rm appbi_db_data
```

## 🔍 Debugging

```bash
# View container resource usage
docker stats

# Inspect container
docker inspect appbi-backend

# View container processes
docker-compose top

# Check container health
docker inspect appbi-backend | grep -A 10 Health
```

## 🌐 Access Points

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:8000
- **API Docs:** http://localhost:8000/docs
- **Database:** localhost:5432

## 🔑 Default Credentials

**Database:**
- User: `appbi`
- Password: `appbi`
- Database: `appbi`

## 📊 Service Commands

```bash
# Backend only
docker-compose up backend

# Frontend only
docker-compose up frontend

# Database only
docker-compose up db

# Multiple services
docker-compose up db backend
```

## 🛠️ Troubleshooting

```bash
# View last 100 lines of logs
docker-compose logs --tail=100

# Check if port is in use (Windows)
netstat -ano | findstr :3000

# Restart with fresh build
docker-compose down && docker-compose up --build

# Force recreate containers
docker-compose up --force-recreate

# Remove and rebuild everything
docker-compose down -v && docker-compose up --build
```

## 📦 Image Management

```bash
# List images
docker images

# Remove specific image
docker rmi appbi-backend

# Remove all unused images
docker image prune -a

# Build without cache
docker-compose build --no-cache
```

## 🔐 Production Checklist

- [ ] Change database password
- [ ] Set SECRET_KEY to random value
- [ ] Configure CORS_ORIGINS for production domain
- [ ] Set LOG_LEVEL to WARNING or ERROR
- [ ] Don't expose database port (5432)
- [ ] Use environment file for secrets
- [ ] Set up HTTPS/SSL
- [ ] Configure backup strategy
- [ ] Set resource limits
- [ ] Enable restart policies

## 💡 Tips

**Save typing with aliases (PowerShell):**
```powershell
Set-Alias dc docker-compose
Set-Alias dcu 'docker-compose up'
Set-Alias dcd 'docker-compose down'
Set-Alias dcl 'docker-compose logs'
```

**Save typing with aliases (Bash/Zsh):**
```bash
alias dc='docker-compose'
alias dcu='docker-compose up'
alias dcd='docker-compose down'
alias dcl='docker-compose logs'
```

**Watch logs in real-time:**
```bash
docker-compose logs -f --tail=50
```

**Shell into running container:**
```bash
# Backend (bash)
docker-compose exec backend bash

# Frontend (sh - alpine)
docker-compose exec frontend sh

# Database (psql)
docker-compose exec db psql -U appbi -d appbi
```
