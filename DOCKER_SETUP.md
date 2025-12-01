# Docker Setup Guide - AppBI

## 🐳 Overview

This guide explains how to run the entire AppBI stack (PostgreSQL, FastAPI backend, and Next.js frontend) using Docker and docker-compose.

## 📋 Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- At least 4GB of available RAM
- Ports 3000, 8000, and 5432 available

**Check your Docker installation:**
```bash
docker --version
docker-compose --version
```

## 🚀 Quick Start

### 1. Clone and Navigate to Repository

```bash
cd /path/to/appbi
```

### 2. Build and Start All Services

```bash
docker-compose up --build
```

This will:
- Build the backend and frontend images
- Pull the PostgreSQL 16 image
- Start all three services
- Run database migrations automatically
- Make the application available

### 3. Access the Application

- **Frontend (Next.js):** http://localhost:3000
- **Backend API (FastAPI):** http://localhost:8000
- **API Documentation:** http://localhost:8000/docs
- **PostgreSQL Database:** localhost:5432

## 📦 Services

### Database (PostgreSQL)

- **Image:** postgres:16-alpine
- **Container name:** appbi-db
- **Port:** 5432
- **Database:** appbi
- **Username:** appbi
- **Password:** appbi
- **Volume:** db_data (persistent storage)

### Backend (FastAPI)

- **Build context:** ./backend
- **Container name:** appbi-backend
- **Port:** 8000
- **Dependencies:** PostgreSQL database
- **Auto-runs:** Alembic migrations on startup

### Frontend (Next.js)

- **Build context:** ./frontend
- **Container name:** appbi-frontend
- **Port:** 3000
- **Dependencies:** Backend service
- **Production build:** Optimized standalone build

## 🎯 Common Commands

### Start Services (Detached Mode)

```bash
docker-compose up -d
```

### Stop Services

```bash
docker-compose down
```

### Stop and Remove Volumes (Delete Data)

```bash
docker-compose down -v
```

### View Logs

**All services:**
```bash
docker-compose logs -f
```

**Specific service:**
```bash
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f db
```

### Rebuild Services

**Rebuild all:**
```bash
docker-compose up --build
```

**Rebuild specific service:**
```bash
docker-compose up --build backend
```

### Restart Services

```bash
docker-compose restart
```

**Restart specific service:**
```bash
docker-compose restart backend
```

### Check Service Status

```bash
docker-compose ps
```

### Execute Commands in Containers

**Backend shell:**
```bash
docker-compose exec backend bash
```

**Database shell:**
```bash
docker-compose exec db psql -U appbi -d appbi
```

**Frontend shell:**
```bash
docker-compose exec frontend sh
```

## 🔧 Configuration

### Environment Variables

The docker-compose.yml file contains all necessary environment variables. Key configurations:

**Database:**
- `POSTGRES_USER=appbi`
- `POSTGRES_PASSWORD=appbi`
- `POSTGRES_DB=appbi`

**Backend:**
- `DATABASE_URL=postgresql+psycopg2://appbi:appbi@db:5432/appbi`
- `CORS_ORIGINS=http://localhost:3000,http://frontend:3000`
- `API_HOST=0.0.0.0`
- `API_PORT=8000`

**Frontend:**
- `NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1`

### Customizing Configuration

To customize, edit `docker-compose.yml`:

**Change database credentials:**
```yaml
db:
  environment:
    POSTGRES_USER: myuser
    POSTGRES_PASSWORD: mypassword
    POSTGRES_DB: mydatabase
```

**Change ports:**
```yaml
frontend:
  ports:
    - "8080:3000"  # Map to port 8080 instead
```

**Add environment variables:**
```yaml
backend:
  environment:
    LOG_LEVEL: DEBUG
    SECRET_KEY: your-production-secret
```

## 🗄️ Database Management

### Access Database

```bash
docker-compose exec db psql -U appbi -d appbi
```

### Run Migrations Manually

```bash
docker-compose exec backend alembic upgrade head
```

### Create New Migration

```bash
docker-compose exec backend alembic revision --autogenerate -m "description"
```

### Rollback Migration

```bash
docker-compose exec backend alembic downgrade -1
```

### Database Backup

```bash
docker-compose exec db pg_dump -U appbi appbi > backup.sql
```

### Database Restore

```bash
docker-compose exec -T db psql -U appbi appbi < backup.sql
```

## 🛠️ Development Workflow

### Development with Hot Reload

For development, you might want to use volume mounts instead of building images:

**Create docker-compose.dev.yml:**
```yaml
version: '3.8'

services:
  db:
    # Same as production
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: appbi
      POSTGRES_PASSWORD: appbi
      POSTGRES_DB: appbi
    volumes:
      - db_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    networks:
      - appbi-network

  backend:
    build: ./backend
    volumes:
      - ./backend:/app
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql+psycopg2://appbi:appbi@db:5432/appbi
    command: uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
    depends_on:
      - db
    networks:
      - appbi-network

  frontend:
    build: ./frontend
    volumes:
      - ./frontend:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:8000/api/v1
    command: npm run dev
    depends_on:
      - backend
    networks:
      - appbi-network

volumes:
  db_data:

networks:
  appbi-network:
```

**Run development stack:**
```bash
docker-compose -f docker-compose.dev.yml up
```

### Hybrid Development (Some Services in Docker)

**Run only database in Docker:**
```bash
docker-compose up db
```

**Then run backend and frontend locally:**
```bash
# Terminal 1 - Backend
cd backend
uvicorn app.main:app --reload

# Terminal 2 - Frontend
cd frontend
npm run dev
```

## 🔍 Troubleshooting

### Backend Can't Connect to Database

**Check database is running:**
```bash
docker-compose ps db
```

**Check logs:**
```bash
docker-compose logs db
```

**Wait for database to be ready:**
The backend has a health check and waits for PostgreSQL. Check:
```bash
docker-compose logs backend
```

### Frontend Can't Reach Backend

**Verify backend is running:**
```bash
curl http://localhost:8000/docs
```

**Check CORS settings:**
Ensure `CORS_ORIGINS` includes your frontend URL.

**Check environment variable:**
```bash
docker-compose exec frontend env | grep NEXT_PUBLIC_API_URL
```

### Port Already in Use

**Find process using port:**
```bash
# Windows
netstat -ano | findstr :3000
netstat -ano | findstr :8000

# Linux/Mac
lsof -i :3000
lsof -i :8000
```

**Kill process or change port in docker-compose.yml**

### Migrations Not Running

**Run manually:**
```bash
docker-compose exec backend alembic upgrade head
```

**Check Alembic configuration:**
```bash
docker-compose exec backend alembic current
docker-compose exec backend alembic history
```

### Out of Disk Space

**Clean up Docker:**
```bash
docker system prune -a
docker volume prune
```

**Check disk usage:**
```bash
docker system df
```

### Container Keeps Restarting

**Check logs:**
```bash
docker-compose logs --tail=100 backend
```

**Disable restart policy temporarily:**
```yaml
backend:
  restart: "no"
```

## 📊 Monitoring

### View Resource Usage

```bash
docker stats
```

### Container Health

```bash
docker-compose ps
```

### Inspect Container

```bash
docker inspect appbi-backend
docker inspect appbi-frontend
docker inspect appbi-db
```

## 🚀 Production Deployment

### Production Checklist

- [ ] Change `POSTGRES_PASSWORD` to a strong password
- [ ] Change `SECRET_KEY` to a cryptographically random value
- [ ] Set `LOG_LEVEL=WARNING` or `ERROR`
- [ ] Remove port mapping for database (don't expose 5432)
- [ ] Use reverse proxy (nginx/traefik) for frontend and backend
- [ ] Enable HTTPS with SSL certificates
- [ ] Set up regular database backups
- [ ] Configure log aggregation
- [ ] Set resource limits for containers
- [ ] Use Docker secrets for sensitive data

### Production docker-compose Example

```yaml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - db_data:/var/lib/postgresql/data
    # Don't expose port in production
    networks:
      - appbi-network
    restart: always

  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql+psycopg2://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}
      SECRET_KEY: ${SECRET_KEY}
      LOG_LEVEL: WARNING
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
    networks:
      - appbi-network
    restart: always

  frontend:
    build: ./frontend
    environment:
      NEXT_PUBLIC_API_URL: https://api.yourdomain.com/api/v1
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
    networks:
      - appbi-network
    restart: always

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./certs:/etc/nginx/certs
    depends_on:
      - frontend
      - backend
    networks:
      - appbi-network
    restart: always

volumes:
  db_data:

networks:
  appbi-network:
```

### Environment Variables (.env file)

```env
DB_USER=appbi_prod
DB_PASSWORD=super_secure_password_here
DB_NAME=appbi_prod
SECRET_KEY=your-very-long-random-secret-key
```

**Run with .env:**
```bash
docker-compose --env-file .env up -d
```

## 🧪 Testing

### Run Backend Tests in Container

```bash
docker-compose exec backend pytest
```

### Run Frontend Tests in Container

```bash
docker-compose exec frontend npm test
```

## 📚 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Docker Host                         │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────┐ │
│  │   Frontend      │  │    Backend      │  │ PostgreSQL │ │
│  │   (Next.js)     │  │   (FastAPI)     │  │  Database  │ │
│  │                 │  │                 │  │            │ │
│  │  Port: 3000     │◄─┤  Port: 8000     │◄─┤ Port: 5432 │ │
│  │                 │  │                 │  │            │ │
│  └─────────────────┘  └─────────────────┘  └────────────┘ │
│         │                     │                    │        │
│         └─────────────────────┴────────────────────┘        │
│                    appbi-network (bridge)                   │
└─────────────────────────────────────────────────────────────┘
         │                     │
         │                     │
    localhost:3000        localhost:8000
```

**Container Communication:**
- Frontend → Backend: `http://backend:8000` (internal)
- Backend → Database: `postgresql://db:5432` (internal)
- Browser → Frontend: `http://localhost:3000` (external)
- Browser → Backend: `http://localhost:8000` (external)

## 🔐 Security Best Practices

1. **Never commit credentials** - Use .env files (add to .gitignore)
2. **Use Docker secrets** for production
3. **Run containers as non-root** (frontend already does this)
4. **Scan images regularly:**
   ```bash
   docker scan appbi-backend
   docker scan appbi-frontend
   ```
5. **Keep base images updated**
6. **Minimize attack surface** - Don't expose unnecessary ports
7. **Use read-only file systems** where possible
8. **Implement network segmentation**

## 📝 Additional Resources

- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Next.js Docker Deployment](https://nextjs.org/docs/deployment#docker-image)
- [FastAPI Docker Documentation](https://fastapi.tiangolo.com/deployment/docker/)
- [PostgreSQL Docker Hub](https://hub.docker.com/_/postgres)

## 🆘 Getting Help

If you encounter issues:

1. Check logs: `docker-compose logs -f`
2. Verify services are running: `docker-compose ps`
3. Check health: `docker inspect appbi-backend | grep -A 10 Health`
4. Review this documentation
5. Open an issue on GitHub

---

**Setup Date:** November 28, 2025  
**Docker Version:** 20.10+  
**Docker Compose Version:** 2.0+  
**PostgreSQL Version:** 16  
**Python Version:** 3.11  
**Node Version:** 18
