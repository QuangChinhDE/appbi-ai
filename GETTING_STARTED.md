# 🚀 Getting Started with AppBI - Quick Checklist

## ✅ Installation Checklist

### 1. Prerequisites
- [ ] Docker Desktop installed (version 20.10+)
- [ ] Docker Compose available (version 2.0+)
- [ ] Git installed
- [ ] At least 4GB free RAM
- [ ] Ports 3000, 8000, and 5432 available

**Verify:**
```bash
docker --version
docker-compose --version
git --version
```

### 2. Clone Repository
- [ ] Clone the repository
- [ ] Navigate to project root

```bash
git clone <repository-url>
cd appbi
```

### 3. Start Services
- [ ] Start all services with Docker Compose
- [ ] Wait for services to be ready (1-2 minutes)

```bash
docker-compose up -d
```

### 4. Verify Installation
- [ ] Run verification script
- [ ] Check all services are running

```powershell
# PowerShell
.\verify-docker.ps1

# Or Bash
bash verify-docker.sh
```

Expected output:
```
✅ Docker is installed and running
✅ Docker Compose is available
✅ Database (PostgreSQL) is running
✅ Backend (FastAPI) is running
✅ Frontend (Next.js) is running
✅ Backend API is responding (http://localhost:8000)
✅ Frontend is responding (http://localhost:3000)
✅ Database connection successful
✅ Migrations are up to date
```

### 5. Access Application
- [ ] Open frontend in browser
- [ ] Access API documentation
- [ ] Verify pages load correctly

**URLs:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Docs: http://localhost:8000/docs

## 📊 Usage Checklist

### Create Your First Data Source
- [ ] Navigate to Data Sources page
- [ ] Click "Add Data Source"
- [ ] Enter connection details:
  - Name: "My Database"
  - Type: PostgreSQL/MySQL/BigQuery
  - Host, Port, Database, Username, Password
- [ ] Test connection
- [ ] Save data source

**Example PostgreSQL:**
```json
{
  "name": "Analytics DB",
  "type": "postgresql",
  "config": {
    "host": "your-db-host",
    "port": 5432,
    "database": "analytics",
    "username": "user",
    "password": "pass"
  }
}
```

### Create Your First Dataset
- [ ] Navigate to Datasets page
- [ ] Click "Create Dataset"
- [ ] Select data source
- [ ] Write SQL query:
```sql
SELECT 
  date_trunc('month', order_date) as month,
  COUNT(*) as total_orders,
  SUM(amount) as total_revenue
FROM orders
WHERE order_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY 1
ORDER BY 1
```
- [ ] Preview data
- [ ] Name dataset: "Monthly Sales"
- [ ] Save dataset

### Create Your First Chart
- [ ] Navigate to Charts page
- [ ] Click "Create Chart"
- [ ] Select dataset: "Monthly Sales"
- [ ] Configure chart:
  - Type: Line Chart
  - X-axis: month
  - Y-axis: total_revenue
  - Title: "Revenue Trend"
- [ ] Preview chart
- [ ] Save chart

### Create Your First Dashboard
- [ ] Navigate to Dashboards page
- [ ] Click "Create Dashboard"
- [ ] Name: "Sales Dashboard"
- [ ] Click "Add Chart"
- [ ] Select chart: "Revenue Trend"
- [ ] Set size: Width 12, Height 4
- [ ] Add more charts (optional)
- [ ] Drag to arrange layout
- [ ] Layout auto-saves

## 🔧 Troubleshooting Checklist

### Services Not Starting
- [ ] Check Docker is running: `docker ps`
- [ ] Check logs: `docker-compose logs -f`
- [ ] Check ports are available: `netstat -ano | findstr :3000`
- [ ] Rebuild: `docker-compose up --build`
- [ ] Remove volumes and restart: `docker-compose down -v && docker-compose up -d`

### Frontend Can't Connect to Backend
- [ ] Check backend is running: `curl http://localhost:8000/docs`
- [ ] Check CORS settings in docker-compose.yml
- [ ] Check NEXT_PUBLIC_API_URL in frontend environment
- [ ] Restart frontend: `docker-compose restart frontend`

### Database Connection Issues
- [ ] Check database is healthy: `docker-compose ps db`
- [ ] Check credentials in docker-compose.yml
- [ ] Test connection: `docker-compose exec backend psql -h db -U appbi -d appbi -c "SELECT 1"`
- [ ] Check logs: `docker-compose logs db`

### Migrations Not Running
- [ ] Check entrypoint script: `docker-compose logs backend | grep alembic`
- [ ] Run manually: `docker-compose exec backend alembic upgrade head`
- [ ] Check Alembic status: `docker-compose exec backend alembic current`

### Port Already in Use
- [ ] Find process: `netstat -ano | findstr :3000`
- [ ] Kill process or change port in docker-compose.yml
- [ ] Restart services

## 📚 Documentation Checklist

### Read Documentation
- [ ] [README.md](README.md) - Project overview
- [ ] [DOCKER_SETUP.md](DOCKER_SETUP.md) - Detailed Docker guide
- [ ] [DOCKER_QUICKREF.md](DOCKER_QUICKREF.md) - Quick commands
- [ ] [PROMPT_4_COMPLETE.md](PROMPT_4_COMPLETE.md) - Implementation details

### Feature Guides
- [ ] [PROMPT_2B_COMPLETE.md](PROMPT_2B_COMPLETE.md) - Data Sources
- [ ] [PROMPT_3A_COMPLETE.md](PROMPT_3A_COMPLETE.md) - Datasets
- [ ] [PROMPT_3B_COMPLETE.md](PROMPT_3B_COMPLETE.md) - Charts
- [ ] [PROMPT_3C_COMPLETE.md](PROMPT_3C_COMPLETE.md) - Dashboards

## 🎯 Development Checklist

### Set Up Development Environment
- [ ] Start dev stack: `docker-compose -f docker-compose.dev.yml up`
- [ ] Verify hot reload works by editing files
- [ ] Access backend shell: `docker-compose exec backend bash`
- [ ] Access database: `docker-compose exec db psql -U appbi -d appbi`

### Make Code Changes
- [ ] Edit backend files in `./backend/app`
- [ ] Edit frontend files in `./frontend/src`
- [ ] Changes auto-reload (no restart needed)
- [ ] Check logs: `docker-compose logs -f`

### Database Operations
- [ ] Create migration: `docker-compose exec backend alembic revision --autogenerate -m "description"`
- [ ] Apply migration: `docker-compose exec backend alembic upgrade head`
- [ ] Rollback: `docker-compose exec backend alembic downgrade -1`
- [ ] Backup: `docker-compose exec db pg_dump -U appbi appbi > backup.sql`

### Testing
- [ ] Run backend tests: `docker-compose exec backend pytest`
- [ ] Run frontend tests: `docker-compose exec frontend npm test`
- [ ] Test full workflow (data source → dataset → chart → dashboard)

## 🚀 Production Checklist

### Pre-Production
- [ ] Change database password in docker-compose.yml
- [ ] Set SECRET_KEY to random value
- [ ] Set LOG_LEVEL to WARNING or ERROR
- [ ] Update CORS_ORIGINS for production domain
- [ ] Remove database port exposure (5432)
- [ ] Configure HTTPS with reverse proxy
- [ ] Set resource limits for containers

### Deployment
- [ ] Deploy to production server
- [ ] Run: `docker-compose up -d`
- [ ] Verify all services: `docker-compose ps`
- [ ] Check logs: `docker-compose logs -f`
- [ ] Test application access

### Post-Deployment
- [ ] Set up automated backups
- [ ] Configure monitoring and alerts
- [ ] Set up log aggregation
- [ ] Document runbook for operations
- [ ] Test disaster recovery procedures

## ✅ Success Criteria

You've successfully set up AppBI when:

- ✅ All services start with `docker-compose up -d`
- ✅ Frontend loads at http://localhost:3000
- ✅ Backend API docs available at http://localhost:8000/docs
- ✅ Can create and test data sources
- ✅ Can create datasets with SQL queries
- ✅ Can build and preview charts
- ✅ Can compose dashboards with drag-and-drop
- ✅ Data persists after restart
- ✅ Logs are accessible and readable
- ✅ Services restart automatically on failure

## 🎉 Next Steps

After completing this checklist:

1. **Explore Features:**
   - Connect to your real databases
   - Create business datasets
   - Build meaningful visualizations
   - Share dashboards with team

2. **Customize:**
   - Add custom chart types
   - Extend data source connectors
   - Customize UI theme
   - Add authentication (future)

3. **Scale:**
   - Deploy to cloud (AWS, Azure, GCP)
   - Set up CI/CD pipeline
   - Configure load balancing
   - Implement caching

4. **Contribute:**
   - Report issues
   - Submit feature requests
   - Contribute code
   - Improve documentation

---

**Need Help?**
- Check [DOCKER_SETUP.md](DOCKER_SETUP.md) for detailed troubleshooting
- Review [DOCKER_QUICKREF.md](DOCKER_QUICKREF.md) for common commands
- See feature-specific guides for detailed instructions
- Check logs: `docker-compose logs -f`

**Happy Analyzing! 📊🎉**
