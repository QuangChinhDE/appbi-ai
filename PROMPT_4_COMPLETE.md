# Prompt 4 Complete: Docker & Docker Compose Setup

## ✅ Implementation Summary

Successfully dockerized the entire AppBI stack with production-ready containerization. The application can now be run with a single `docker-compose up` command, including PostgreSQL database, FastAPI backend, and Next.js frontend.

## 📦 Deliverables

### Docker Configuration Files

1. **backend/Dockerfile** (34 lines)
   - Python 3.11-slim base image
   - System dependencies for PostgreSQL, MySQL, BigQuery
   - Requirements installation
   - Application code copy
   - Entrypoint script execution

2. **backend/entrypoint.sh** (20 lines)
   - Wait for PostgreSQL to be ready
   - Run Alembic migrations
   - Start uvicorn server

3. **frontend/Dockerfile** (60 lines)
   - Multi-stage build (deps → builder → runner)
   - Node 18-alpine base
   - Production-optimized standalone build
   - Non-root user for security
   - Minimal runtime footprint

4. **frontend/Dockerfile.dev** (24 lines)
   - Development version with hot reload
   - Simplified single-stage build
   - npm run dev for development

5. **docker-compose.yml** (88 lines)
   - Production configuration
   - PostgreSQL 16 with health checks
   - Backend with auto-migrations
   - Frontend with optimized build
   - Persistent volumes and networking

6. **docker-compose.dev.yml** (70 lines)
   - Development configuration
   - Volume mounts for hot reload
   - Debug logging enabled
   - Development-friendly settings

### Support Files

7. **backend/.dockerignore** (40 lines)
   - Excludes Python cache files
   - Excludes virtual environments
   - Excludes IDE files
   - Optimizes build context

8. **frontend/.dockerignore** (32 lines)
   - Excludes node_modules
   - Excludes .next build directory
   - Excludes environment files
   - Optimizes build context

9. **.env.docker.example** (10 lines)
   - Template for environment variables
   - Database credentials
   - Secret key configuration
   - API URL configuration

### Documentation

10. **DOCKER_SETUP.md** (650+ lines)
    - Complete setup guide
    - Common commands reference
    - Configuration instructions
    - Troubleshooting section
    - Production deployment guide
    - Security best practices

11. **DOCKER_QUICKREF.md** (190+ lines)
    - Quick command reference
    - Database operations
    - Debugging commands
    - Production checklist
    - Tips and aliases

### Modified Files

12. **frontend/next.config.js**
    - Added `output: 'standalone'` for Docker optimization
    - Enables Next.js standalone build mode

## 🎯 Key Features Implemented

### 1. Three-Service Architecture

**PostgreSQL Database:**
- Image: postgres:16-alpine (lightweight)
- Persistent volume: db_data
- Health checks for dependency management
- Port 5432 exposed for local access
- Default credentials: appbi/appbi/appbi

**FastAPI Backend:**
- Custom Dockerfile with all dependencies
- Automatic migration on startup
- Waits for database to be ready
- Port 8000 exposed
- CORS configured for frontend

**Next.js Frontend:**
- Multi-stage optimized build
- Standalone production build
- Non-root user execution
- Port 3000 exposed
- Environment variable for API URL

### 2. Database Migration Automation

**Entrypoint Script Flow:**
```bash
1. Wait for PostgreSQL (health check with psql)
2. Run: alembic upgrade head
3. Start: uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Benefits:**
- No manual migration step
- Database always up-to-date
- Fails gracefully if migrations fail
- Idempotent (safe to restart)

### 3. Multi-Stage Frontend Build

**Stage 1 - Dependencies:**
- Install npm packages
- Separate layer for caching

**Stage 2 - Builder:**
- Build Next.js application
- Generate standalone output
- Optimize for production

**Stage 3 - Runner:**
- Minimal runtime image
- Copy only necessary files
- Non-root user (security)
- Small final image size

### 4. Development vs Production

**Production (docker-compose.yml):**
- Optimized builds
- No volume mounts
- Minimal logging
- Restart policies
- Production environment

**Development (docker-compose.dev.yml):**
- Hot reload enabled
- Source code mounted
- Debug logging
- Rapid iteration
- Development environment

### 5. Networking and Service Discovery

**Internal Network (appbi-network):**
- Backend → Database: `postgresql://db:5432`
- Frontend → Backend: `http://backend:8000`
- Services discover each other by name

**External Access:**
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Database: `localhost:5432` (optional)

### 6. Volume Management

**Persistent Data:**
- `db_data` volume for PostgreSQL
- Survives container restarts
- Independent of container lifecycle

**Development Mounts:**
- `./backend/app` → `/app/app` (hot reload)
- `./frontend/src` → `/app/src` (hot reload)
- Preserves node_modules in container

### 7. Health Checks and Dependencies

**Database Health Check:**
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U appbi"]
  interval: 5s
  timeout: 5s
  retries: 5
```

**Service Dependencies:**
- Backend depends on db (with health condition)
- Frontend depends on backend
- Ensures proper startup order

## 🔄 Usage Workflows

### Production Deployment

**Initial Setup:**
```bash
# Clone repository
cd appbi

# Start all services
docker-compose up --build -d

# View logs
docker-compose logs -f

# Check status
docker-compose ps
```

**Access Application:**
- Frontend: http://localhost:3000
- Backend: http://localhost:8000/docs
- Create data sources, datasets, charts, dashboards

**Maintenance:**
```bash
# View logs
docker-compose logs -f backend

# Restart service
docker-compose restart backend

# Update code and rebuild
docker-compose up --build backend

# Stop everything
docker-compose down

# Stop and remove data
docker-compose down -v
```

### Development Workflow

**Start Development Stack:**
```bash
# Start with hot reload
docker-compose -f docker-compose.dev.yml up

# Code changes automatically reload
# Edit files in ./backend/app or ./frontend/src
```

**Run Commands:**
```bash
# Run migrations
docker-compose exec backend alembic upgrade head

# Create migration
docker-compose exec backend alembic revision --autogenerate -m "add field"

# Access database
docker-compose exec db psql -U appbi -d appbi

# Run tests
docker-compose exec backend pytest
docker-compose exec frontend npm test
```

### Database Operations

**Backup:**
```bash
# Export database
docker-compose exec db pg_dump -U appbi appbi > backup_$(date +%Y%m%d).sql

# With compression
docker-compose exec db pg_dump -U appbi appbi | gzip > backup.sql.gz
```

**Restore:**
```bash
# Import database
cat backup.sql | docker-compose exec -T db psql -U appbi appbi

# From compressed
gunzip -c backup.sql.gz | docker-compose exec -T db psql -U appbi appbi
```

**Migrations:**
```bash
# Check current version
docker-compose exec backend alembic current

# View history
docker-compose exec backend alembic history

# Upgrade to specific version
docker-compose exec backend alembic upgrade <revision>

# Downgrade
docker-compose exec backend alembic downgrade -1
```

## 🏗️ Architecture Details

### Container Structure

```
appbi-network (bridge)
├── db (postgres:16-alpine)
│   ├── Volume: db_data → /var/lib/postgresql/data
│   ├── Port: 5432 → 5432
│   └── Health: pg_isready check
│
├── backend (custom Python image)
│   ├── Build: ./backend/Dockerfile
│   ├── Port: 8000 → 8000
│   ├── Depends: db (healthy)
│   └── Entrypoint: wait → migrate → serve
│
└── frontend (custom Node image)
    ├── Build: ./frontend/Dockerfile
    ├── Port: 3000 → 3000
    ├── Depends: backend
    └── Command: node server.js
```

### Image Layers

**Backend Image (~400MB):**
```
python:3.11-slim (base)
├── System packages (build-essential, libpq-dev, etc.)
├── Python packages (requirements.txt)
├── Application code (app/, alembic/)
└── Entrypoint script
```

**Frontend Image (~150MB):**
```
Stage 1: node:18-alpine + npm ci
Stage 2: Build Next.js app
Stage 3: node:18-alpine (runtime)
└── Standalone build (~50MB)
```

### Network Communication

**Internal (Container-to-Container):**
- Uses service names (db, backend, frontend)
- Network: appbi-network
- No exposure to host

**External (Host-to-Container):**
- Port mappings (3000:3000, 8000:8000, 5432:5432)
- Accessible via localhost
- Browser connects to host ports

## 🔧 Configuration Management

### Environment Variables

**Database (docker-compose.yml):**
```yaml
POSTGRES_USER: appbi
POSTGRES_PASSWORD: appbi
POSTGRES_DB: appbi
```

**Backend:**
```yaml
DATABASE_URL: postgresql+psycopg2://appbi:appbi@db:5432/appbi
DB_HOST: db
POSTGRES_USER: appbi
POSTGRES_PASSWORD: appbi
POSTGRES_DB: appbi
API_HOST: 0.0.0.0
API_PORT: 8000
CORS_ORIGINS: http://localhost:3000,http://frontend:3000
LOG_LEVEL: INFO
SECRET_KEY: your-secret-key-change-in-production
```

**Frontend:**
```yaml
NEXT_PUBLIC_API_URL: http://localhost:8000/api/v1
```

### Customization

**Change Database Credentials:**
```yaml
db:
  environment:
    POSTGRES_USER: myuser
    POSTGRES_PASSWORD: strongpassword
    POSTGRES_DB: mydatabase

backend:
  environment:
    DATABASE_URL: postgresql+psycopg2://myuser:strongpassword@db:5432/mydatabase
    POSTGRES_USER: myuser
    POSTGRES_PASSWORD: strongpassword
    POSTGRES_DB: mydatabase
```

**Change Ports:**
```yaml
frontend:
  ports:
    - "8080:3000"  # Access on port 8080

backend:
  ports:
    - "9000:8000"  # Access on port 9000
```

**Add Environment Variables:**
```yaml
backend:
  environment:
    LOG_LEVEL: DEBUG
    MAX_CONNECTIONS: 100
    TIMEOUT: 30
```

### Using .env File

**Create .env:**
```env
DB_USER=appbi_prod
DB_PASSWORD=super_secure_password
DB_NAME=appbi_prod
SECRET_KEY=random-secret-key-here
```

**Update docker-compose.yml:**
```yaml
db:
  environment:
    POSTGRES_USER: ${DB_USER}
    POSTGRES_PASSWORD: ${DB_PASSWORD}
    POSTGRES_DB: ${DB_NAME}
```

**Run with .env:**
```bash
docker-compose --env-file .env up -d
```

## 🔒 Security Considerations

### Implemented Security Features

**Non-Root User (Frontend):**
```dockerfile
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs
```

**Minimal Base Images:**
- Python: 3.11-slim (not full)
- Node: 18-alpine (minimal)
- PostgreSQL: 16-alpine

**Multi-Stage Build:**
- Build artifacts not in final image
- Smaller attack surface
- Fewer vulnerabilities

**Health Checks:**
- Ensures services are actually ready
- Prevents cascading failures

### Production Security Checklist

- [ ] **Change default passwords**
  - PostgreSQL password
  - SECRET_KEY in backend

- [ ] **Don't expose database port**
  - Remove `ports: 5432:5432` from db service

- [ ] **Use Docker secrets**
  - Store credentials securely
  - Don't use environment variables

- [ ] **Enable HTTPS**
  - Use reverse proxy (nginx/traefik)
  - SSL certificates (Let's Encrypt)

- [ ] **Scan images for vulnerabilities**
  ```bash
  docker scan appbi-backend
  docker scan appbi-frontend
  ```

- [ ] **Set resource limits**
  ```yaml
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 2G
  ```

- [ ] **Use read-only file systems**
  ```yaml
  read_only: true
  tmpfs:
    - /tmp
  ```

- [ ] **Network segmentation**
  - Separate backend network
  - Only frontend exposed publicly

- [ ] **Regular updates**
  - Keep base images updated
  - Update dependencies regularly

- [ ] **Log management**
  - Use log aggregation (ELK, Loki)
  - Don't log sensitive data

## 📊 Performance Optimization

### Build Optimization

**Docker Layer Caching:**
- Copy requirements.txt first
- Install dependencies (cached layer)
- Copy code last (changes frequently)

**Multi-Stage Builds:**
- Separate build and runtime
- Smaller final image
- Faster deployment

**.dockerignore:**
- Exclude unnecessary files
- Faster build context
- Smaller uploads

### Runtime Optimization

**Next.js Standalone:**
- Minimal runtime dependencies
- ~50MB vs ~300MB
- Faster startup

**Alpine Images:**
- Smaller image size
- Faster pulls
- Less disk usage

**Volume Caching:**
- node_modules persisted
- Build cache preserved
- Faster rebuilds

### Resource Management

**Default Limits:**
```yaml
# Add to production docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '1'
      memory: 1G
```

**Database Tuning:**
```yaml
db:
  command:
    - postgres
    - -c
    - max_connections=200
    - -c
    - shared_buffers=256MB
```

## 🧪 Testing

### Local Testing

**Build and Test:**
```bash
# Build all images
docker-compose build

# Check for errors
docker-compose config

# Start and test
docker-compose up -d
docker-compose ps
docker-compose logs

# Test endpoints
curl http://localhost:8000/docs
curl http://localhost:3000
```

**Test Migrations:**
```bash
# Start fresh
docker-compose down -v
docker-compose up -d

# Check migrations ran
docker-compose logs backend | grep "alembic"
docker-compose exec backend alembic current
```

**Test Data Persistence:**
```bash
# Create data
curl -X POST http://localhost:8000/api/v1/datasources -d '{...}'

# Restart
docker-compose restart backend

# Data should persist
curl http://localhost:8000/api/v1/datasources
```

### Integration Testing

**Full Stack Test:**
1. Start all services
2. Access frontend at http://localhost:3000
3. Create data source
4. Create dataset
5. Create chart
6. Create dashboard
7. Verify data persists after restart

**Network Testing:**
```bash
# Test internal communication
docker-compose exec frontend wget -O- http://backend:8000/docs
docker-compose exec backend psql -h db -U appbi -d appbi -c "SELECT 1"
```

## 🚀 Deployment Strategies

### Development Deployment

**Local Development:**
```bash
docker-compose -f docker-compose.dev.yml up
```

**Remote Development Server:**
```bash
# On remote server
git pull
docker-compose -f docker-compose.dev.yml up -d

# Access via server IP
http://SERVER_IP:3000
```

### Staging Deployment

**Create docker-compose.staging.yml:**
```yaml
version: '3.8'
services:
  # Similar to production
  # Use staging database
  # Enable more logging
  # Use staging domain
```

**Deploy:**
```bash
docker-compose -f docker-compose.staging.yml up -d
```

### Production Deployment

**With Reverse Proxy:**
```yaml
# Add nginx service
nginx:
  image: nginx:alpine
  volumes:
    - ./nginx.conf:/etc/nginx/nginx.conf
    - ./certs:/etc/nginx/certs
  ports:
    - "80:80"
    - "443:443"
  depends_on:
    - frontend
    - backend
```

**With Docker Swarm:**
```bash
docker stack deploy -c docker-compose.yml appbi
```

**With Kubernetes:**
```bash
# Convert to k8s manifests
kompose convert -f docker-compose.yml
kubectl apply -f .
```

## 🔍 Troubleshooting Guide

### Common Issues

**Issue: Backend can't connect to database**

```bash
# Check database is running
docker-compose ps db

# Check logs
docker-compose logs db

# Verify connection
docker-compose exec backend psql -h db -U appbi -d appbi -c "SELECT 1"

# Solution: Wait longer or check credentials
```

**Issue: Frontend can't reach backend**

```bash
# Check backend is running
curl http://localhost:8000/docs

# Check environment variable
docker-compose exec frontend env | grep NEXT_PUBLIC_API_URL

# Solution: Verify CORS settings in backend
```

**Issue: Port already in use**

```bash
# Windows - Find process
netstat -ano | findstr :3000

# Kill process or change port in docker-compose.yml
```

**Issue: Migrations not running**

```bash
# Check entrypoint script permissions
docker-compose exec backend ls -la entrypoint.sh

# Run manually
docker-compose exec backend alembic upgrade head

# Check alembic.ini configuration
```

**Issue: Out of disk space**

```bash
# Clean up
docker system prune -a
docker volume prune

# Check usage
docker system df
```

**Issue: Container keeps restarting**

```bash
# Check logs
docker-compose logs --tail=100 backend

# Disable restart to debug
# Set restart: "no" in docker-compose.yml
```

### Debug Commands

```bash
# Shell into container
docker-compose exec backend bash

# Check environment variables
docker-compose exec backend env

# Check processes
docker-compose exec backend ps aux

# Check network
docker network inspect appbi_appbi-network

# Check volumes
docker volume inspect appbi_db_data

# Inspect container
docker inspect appbi-backend
```

## 📈 Monitoring and Logging

### Log Management

**View Logs:**
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend

# Last N lines
docker-compose logs --tail=50 backend

# Since timestamp
docker-compose logs --since 2025-11-28 backend
```

**Log to File:**
```bash
docker-compose logs > app.log
```

**Configure Logging Driver:**
```yaml
backend:
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "3"
```

### Resource Monitoring

**Real-time Stats:**
```bash
docker stats
```

**Service Health:**
```bash
docker-compose ps
```

**Disk Usage:**
```bash
docker system df
```

## 🆙 Updates and Upgrades

### Updating Application Code

**Backend Updates:**
```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose up --build -d backend
```

**Frontend Updates:**
```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose up --build -d frontend
```

### Updating Base Images

**Update PostgreSQL:**
```yaml
# Change version in docker-compose.yml
db:
  image: postgres:17-alpine  # Updated from 16
```

```bash
docker-compose pull db
docker-compose up -d db
```

**Update Python/Node:**
```dockerfile
# Update in Dockerfile
FROM python:3.12-slim  # Updated from 3.11
```

```bash
docker-compose build --no-cache backend
docker-compose up -d backend
```

### Zero-Downtime Updates

**Rolling Updates:**
```bash
# Scale up new version
docker-compose up -d --scale backend=2

# Remove old version
docker rm -f appbi-backend-old

# Update load balancer
```

## 📚 Best Practices

### Development Best Practices

1. **Use docker-compose.dev.yml for development**
   - Hot reload enabled
   - Debug logging
   - Source code mounted

2. **Use .dockerignore effectively**
   - Smaller build context
   - Faster builds
   - No sensitive files

3. **Test in Docker before pushing**
   - Ensure works in containerized environment
   - Catch issues early

4. **Use volume mounts carefully**
   - Preserve node_modules
   - Mount only necessary directories

5. **Keep images small**
   - Multi-stage builds
   - Alpine images
   - Clean up after install

### Production Best Practices

1. **Use environment variables for configuration**
   - Never hardcode credentials
   - Use .env file
   - Use Docker secrets for sensitive data

2. **Implement health checks**
   - Ensure services are ready
   - Enable auto-restart
   - Monitor health status

3. **Set resource limits**
   - Prevent resource exhaustion
   - Ensure fair sharing
   - Plan capacity

4. **Regular backups**
   - Automated database backups
   - Test restore process
   - Store off-site

5. **Monitor and log**
   - Centralized logging
   - Resource monitoring
   - Alert on issues

6. **Security hardening**
   - Non-root users
   - Read-only file systems
   - Network segmentation
   - Regular updates

7. **Version control**
   - Tag images with versions
   - Document changes
   - Rollback capability

## ✅ Completion Checklist

**Docker Setup Complete:**
- ✅ Backend Dockerfile with Python 3.11-slim
- ✅ Backend entrypoint.sh with DB wait and migrations
- ✅ Frontend Dockerfile with multi-stage build
- ✅ Frontend standalone output configuration
- ✅ docker-compose.yml with all three services
- ✅ docker-compose.dev.yml for development
- ✅ PostgreSQL 16 with health checks
- ✅ Persistent volumes for data
- ✅ Network configuration
- ✅ .dockerignore files for optimization
- ✅ Environment variable configuration
- ✅ Comprehensive documentation
- ✅ Quick reference guide
- ✅ Production-ready setup

**Tested and Verified:**
- ✅ All Dockerfiles build without errors
- ✅ docker-compose.yml validates successfully
- ✅ Services start in correct order
- ✅ Database migrations run automatically
- ✅ Frontend communicates with backend
- ✅ Backend communicates with database
- ✅ Data persists across restarts

**Documentation Created:**
- ✅ DOCKER_SETUP.md (comprehensive guide)
- ✅ DOCKER_QUICKREF.md (quick commands)
- ✅ .env.docker.example (configuration template)
- ✅ This completion document

## 🎉 Success Criteria Met

1. **Single command startup:**
   ```bash
   docker-compose up -d
   ```

2. **All services running:**
   - PostgreSQL on port 5432
   - Backend on port 8000
   - Frontend on port 3000

3. **Automatic migrations:**
   - Alembic runs on backend startup
   - Database always up-to-date

4. **Production-ready:**
   - Optimized images
   - Security best practices
   - Resource management
   - Health checks
   - Restart policies

5. **Developer-friendly:**
   - Hot reload in dev mode
   - Easy debugging
   - Quick iteration
   - Comprehensive docs

---

**Implementation Date:** November 28, 2025  
**Docker Version:** 20.10+  
**Docker Compose Version:** 2.0+  
**PostgreSQL Version:** 16-alpine  
**Python Version:** 3.11-slim  
**Node Version:** 18-alpine
