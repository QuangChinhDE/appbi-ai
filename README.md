# AppBI - Modern Open-Source BI Tool

A greenfield Business Intelligence application similar to Apache Superset, built with modern technologies and clean architecture principles.

## Features

### Core Capabilities (MVP)

- **Multi-Database Support**: Connect to PostgreSQL, MySQL, and BigQuery
- **Data Source Management**: Register and configure database connections
- **Ad-hoc SQL Queries**: Execute queries directly against connected data sources
- **Reusable Datasets**: Save queries as datasets with automatic schema inference
- **Interactive Charts**: Create bar, line, pie, and time-series visualizations
- **Custom Dashboards**: Compose multiple charts with drag-and-drop layouts
- **Single-User System**: Simplified MVP without complex authorization

## Tech Stack

### Backend
- **Python 3.x** with **FastAPI** - High-performance REST API
- **PostgreSQL** - Metadata storage
- **SQLAlchemy** + **Alembic** - ORM and database migrations
- **Database Drivers**:
  - `psycopg2` - PostgreSQL
  - `pymysql` - MySQL
  - `google-cloud-bigquery` - BigQuery

### Frontend
- **Next.js 14** (React + TypeScript) - Modern React framework
- **TailwindCSS** - Utility-first styling
- **shadcn/ui** - High-quality component library
- **TanStack Query** (react-query) - Server state management
- **Recharts** - Charting library
- **react-grid-layout** - Dashboard drag-and-drop

## Project Structure

```
appbi/
├── backend/
│   ├── alembic/                # Database migrations
│   │   ├── env.py
│   │   └── script.py.mako
│   ├── app/
│   │   ├── api/                # API route handlers
│   │   │   ├── datasources.py
│   │   │   ├── datasets.py
│   │   │   ├── charts.py
│   │   │   └── dashboards.py
│   │   ├── core/               # Core configuration
│   │   │   ├── config.py       # Settings management
│   │   │   ├── database.py     # DB connection
│   │   │   └── logging.py      # Logging setup
│   │   ├── models/             # SQLAlchemy models
│   │   │   └── models.py
│   │   ├── schemas/            # Pydantic schemas
│   │   │   └── schemas.py
│   │   ├── services/           # Business logic
│   │   │   ├── datasource_service.py
│   │   │   ├── datasource_crud_service.py
│   │   │   ├── dataset_service.py
│   │   │   ├── chart_service.py
│   │   │   └── dashboard_service.py
│   │   └── main.py             # FastAPI application
│   ├── requirements.txt
│   ├── alembic.ini
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── app/                # Next.js pages
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   ├── datasources/
│   │   │   ├── datasets/
│   │   │   ├── charts/
│   │   │   └── dashboards/
│   │   ├── components/         # Reusable components
│   │   ├── hooks/              # React Query hooks
│   │   │   ├── use-datasources.ts
│   │   │   ├── use-datasets.ts
│   │   │   ├── use-charts.ts
│   │   │   └── use-dashboards.ts
│   │   ├── lib/                # Utilities
│   │   │   ├── api-client.ts
│   │   │   ├── utils.ts
│   │   │   └── api/            # API functions
│   │   └── types/              # TypeScript types
│   ├── package.json
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   └── next.config.js
└── README.md
```

## Getting Started

### 🐳 Quick Start with Docker (Recommended)

The easiest way to run AppBI is using Docker Compose:

```bash
# Clone the repository
git clone <repository-url>
cd appbi

# Start all services (PostgreSQL, Backend, Frontend)
docker-compose up -d

# Verify everything is running
# PowerShell
.\verify-docker.ps1

# Bash/Zsh
bash verify-docker.sh
```

**Access the application:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Documentation: http://localhost:8000/docs

**Common commands:**
```bash
# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Stop and remove all data
docker-compose down -v

# Rebuild after code changes
docker-compose up --build
```

**For detailed Docker setup, troubleshooting, and production deployment, see:**
- [DOCKER_SETUP.md](DOCKER_SETUP.md) - Comprehensive Docker guide
- [DOCKER_QUICKREF.md](DOCKER_QUICKREF.md) - Quick command reference

---

### 💻 Manual Setup (Development)

If you prefer to run services manually without Docker:

#### Prerequisites

- **Python 3.10+**
- **Node.js 18+** and **npm**
- **PostgreSQL 12+** (for metadata storage)
- **Optional**: MySQL, PostgreSQL, or BigQuery for data sources

### Backend Setup

1. **Navigate to backend directory**:
   ```powershell
   cd backend
   ```

2. **Create and activate virtual environment**:
   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

3. **Install dependencies**:
   ```powershell
   pip install -r requirements.txt
   ```

4. **Configure environment**:
   ```powershell
   cp .env.example .env
   ```
   
   Edit `.env` and update the database URL:
   ```env
   DATABASE_URL=postgresql://username:password@localhost:5432/appbi_metadata
   ```

5. **Create the metadata database**:
   ```powershell
   # Connect to PostgreSQL
   psql -U postgres
   
   # Create database
   CREATE DATABASE appbi_metadata;
   \q
   ```

6. **Run database migrations**:
   ```powershell
   # Generate initial migration
   alembic revision --autogenerate -m "Initial migration"
   
   # Apply migrations
   alembic upgrade head
   ```

7. **Start the backend server**:
   ```powershell
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

   The API will be available at `http://localhost:8000`
   - API docs: `http://localhost:8000/docs`
   - Health check: `http://localhost:8000/health`

### Frontend Setup

1. **Navigate to frontend directory**:
   ```powershell
   cd frontend
   ```

2. **Install dependencies**:
   ```powershell
   npm install
   ```

3. **Configure environment**:
   ```powershell
   cp .env.local.example .env.local
   ```
   
   Edit `.env.local` if needed:
   ```env
   NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
   ```

4. **Start the development server**:
   ```powershell
   npm run dev
   ```

   The application will be available at `http://localhost:3000`

## Usage

### 1. Create a Data Source

Navigate to **Data Sources** and add a new connection:

**PostgreSQL Example**:
```json
{
  "name": "My PostgreSQL DB",
  "type": "postgresql",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "username": "user",
    "password": "password"
  }
}
```

**MySQL Example**:
```json
{
  "name": "My MySQL DB",
  "type": "mysql",
  "config": {
    "host": "localhost",
    "port": 3306,
    "database": "mydb",
    "username": "user",
    "password": "password"
  }
}
```

**BigQuery Example**:
```json
{
  "name": "My BigQuery Project",
  "type": "bigquery",
  "config": {
    "project_id": "my-project-id",
    "credentials_json": "{...service account JSON...}"
  }
}
```

### 2. Create a Dataset

Navigate to **Datasets** and create a reusable query:

```sql
SELECT 
  order_date,
  product_category,
  SUM(amount) as total_amount
FROM orders
WHERE order_date >= '2024-01-01'
GROUP BY order_date, product_category
ORDER BY order_date
```

The system will automatically infer column types and metadata.

### 3. Create a Chart

Navigate to **Charts** and configure a visualization:

**Bar Chart Config**:
```json
{
  "x_axis": "product_category",
  "y_axis": "total_amount"
}
```

**Time Series Config**:
```json
{
  "time_column": "order_date",
  "value_column": "total_amount"
}
```

### 4. Build a Dashboard

Navigate to **Dashboards** and add charts with custom layouts using drag-and-drop.

## API Documentation

### Data Sources

- `GET /api/v1/datasources/` - List all data sources
- `POST /api/v1/datasources/` - Create a data source
- `GET /api/v1/datasources/{id}` - Get data source by ID
- `PUT /api/v1/datasources/{id}` - Update data source
- `DELETE /api/v1/datasources/{id}` - Delete data source
- `POST /api/v1/datasources/test` - Test connection
- `POST /api/v1/datasources/query` - Execute ad-hoc query

### Datasets

- `GET /api/v1/datasets/` - List all datasets
- `POST /api/v1/datasets/` - Create a dataset
- `GET /api/v1/datasets/{id}` - Get dataset by ID
- `PUT /api/v1/datasets/{id}` - Update dataset
- `DELETE /api/v1/datasets/{id}` - Delete dataset
- `POST /api/v1/datasets/{id}/execute` - Execute dataset query

### Charts

- `GET /api/v1/charts/` - List all charts
- `POST /api/v1/charts/` - Create a chart
- `GET /api/v1/charts/{id}` - Get chart by ID
- `GET /api/v1/charts/{id}/data` - Get chart with data
- `PUT /api/v1/charts/{id}` - Update chart
- `DELETE /api/v1/charts/{id}` - Delete chart

### Dashboards

- `GET /api/v1/dashboards/` - List all dashboards
- `POST /api/v1/dashboards/` - Create a dashboard
- `GET /api/v1/dashboards/{id}` - Get dashboard by ID
- `PUT /api/v1/dashboards/{id}` - Update dashboard
- `DELETE /api/v1/dashboards/{id}` - Delete dashboard
- `POST /api/v1/dashboards/{id}/charts` - Add chart to dashboard
- `DELETE /api/v1/dashboards/{id}/charts/{chart_id}` - Remove chart
- `PUT /api/v1/dashboards/{id}/layout` - Update dashboard layout

## Architecture Highlights

### Backend Patterns

- **Layered Architecture**: Clear separation between API, Service, and Data layers
- **Dependency Injection**: FastAPI's dependency system for database sessions
- **Pydantic Validation**: Request/response schemas with automatic validation
- **Service Layer**: Business logic isolated from API handlers
- **Connection Pooling**: Efficient database connection management
- **Structured Logging**: Consistent logging throughout the application

### Frontend Patterns

- **Server State Management**: TanStack Query for caching and synchronization
- **TypeScript**: Full type safety across the application
- **Component Composition**: Reusable UI components with shadcn/ui
- **API Client Layer**: Centralized API communication
- **Custom Hooks**: Encapsulated data fetching logic

## Development

### Backend Development

**Run with auto-reload**:
```powershell
uvicorn app.main:app --reload
```

**Create a new migration**:
```powershell
alembic revision --autogenerate -m "Description"
alembic upgrade head
```

**Run tests** (when implemented):
```powershell
pytest
```

### Frontend Development

**Run development server**:
```powershell
npm run dev
```

**Build for production**:
```powershell
npm run build
npm start
```

**Lint code**:
```powershell
npm run lint
```

## Future Enhancements

- **Authentication & Authorization**: User management and role-based access
- **Multi-tenancy**: Organization and workspace support
- **Query History**: Track and reuse past queries
- **Scheduled Queries**: Automatic data refresh
- **Export Features**: Download charts and data as CSV/PDF
- **Advanced Visualizations**: More chart types and customization
- **Alerting**: Threshold-based notifications
- **Collaboration**: Share dashboards and charts

## Contributing

This is a greenfield project template. To contribute:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

## License

MIT License - feel free to use this project as a starting point for your own BI tool.

## Support

For issues, questions, or feature requests, please open an issue on the GitHub repository.

---

Built with ❤️ using FastAPI and Next.js
