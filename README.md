# AppBI — Business Intelligence Dashboard

A self-hosted BI platform for connecting data sources, building datasets with transformation pipelines, exploring data without SQL, and composing interactive dashboards. Separate Frontend / Backend / Database architecture, deployed with a single Docker Compose command.

---

## Features

| Module | Description |
|---|---|
| **Data Sources** | Connect to PostgreSQL, MySQL, BigQuery, Google Sheets, or import CSV/Excel (multi-sheet). **Test Connection** is enforced before saving. PostgreSQL supports `schema` (search_path) config. |
| **Datasets** | Create datasets from SQL queries on any data source. Automatic column type inference. Supports a visual **transformation pipeline** (add column, filter, group by, sort, limit, rename, cast, custom SQL, and more). |
| **Explore** | Point-and-click data exploration — choose X axis, metrics (SUM/AVG/COUNT/MIN/MAX), breakdown, filters, and parameters — no SQL required. 5 collapsible panels: Data · Visualization · Fields · Filters · Parameters. |
| **Charts** | Save Explore configurations as reusable charts. Supports Bar, Line, Area, Pie, Scatter, Grouped Bar, Stacked Bar, Table, KPI, and Time Series. |
| **Dashboards** | Compose multiple charts into a grid dashboard with drag-and-drop layout (react-grid-layout). **Global filter bar** (pre-aggregation, dimension fields). **Per-tile HAVING filter** (post-aggregation, metric fields). Inline tile rename. |
| **Dataset Workspaces** | Workspace environment combining multiple tables from one or more data sources. Add `js_formula` computed columns using Excel-style formulas (e.g. `IF([Points]>1800,"Elite","Other")`). Computed columns are highlighted in amber throughout the UI. |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router) · TypeScript · Tailwind CSS · Recharts · TanStack Query v5 · react-grid-layout · Sonner |
| **Backend** | FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · Python 3.10+ · DuckDB |
| **Database** | PostgreSQL 16 (metadata: datasources, datasets, charts, dashboards) |
| **Infrastructure** | Docker · Docker Compose |

---

## Running with Docker (recommended)

> Requires: [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine + Compose plugin.

### 1. Clone the repo

```bash
git clone https://github.com/bachbuiquang9/Dashboard-App.git
cd Dashboard-App
```

### 2. Configure environment

```bash
cp .env.docker.example .env
```

Edit `.env` if needed (defaults work out of the box):

```env
DB_USER=appbi
DB_PASSWORD=appbi
DB_NAME=appbi

SECRET_KEY=change-this-in-production
LOG_LEVEL=INFO

# Change if these ports are already in use on your machine
FRONTEND_PORT=3000
BACKEND_PORT=8000

# Load Football/FIFA demo data on first container start (optional)
SEED_DEMO_DATA=false
```

> **Note:** The PostgreSQL port is **not** exposed to the host — it only exists inside the Docker network. It will not conflict with a locally running Postgres instance.

### 3. Build and start

```bash
docker compose up --build -d
```

The first build takes a few minutes. Subsequent starts: `docker compose up -d`.

### 4. Open the app

| URL | Description |
|---|---|
| `http://localhost:3000` | Frontend UI |
| `http://localhost:8000/api/v1/docs` | Swagger API docs |
| `http://localhost:8000/health` | Backend health check |

### 5. Stop

```bash
docker compose down        # stop, keep database data
docker compose down -v     # stop and delete all database data
```

---

## Demo Data — Football / FIFA

The repo ships with a seed script that loads a complete Football / FIFA demo dataset.

### Option A — via Docker (automatic on first boot)

Set `SEED_DEMO_DATA=true` in `.env` before running `docker compose up`:

```env
SEED_DEMO_DATA=true
```

The seed runs automatically on the first container start and is guarded by a flag file so it never runs twice.

### Option B — manual (any running instance)

```bash
# Backend must be running (Docker or local)
pip install requests openpyxl
python seed_demo.py
```

**What gets created:**
- **1 Data Source** — Manual (from `scope-foodball-demo.xlsx`)
- **6 Datasets** — FIFA Rankings, WC History, Top Scorers, Confederation Stats, WC vs Continental Titles, Country Performance
- **3 Dataset Workspaces** (9 tables total) — each with `js_formula` computed columns:
  - *FIFA World Rankings* — `Rank_Group`, `Conf_Power_Score`, `Points_Rating`
  - *World Cup & Continental Titles* — `Title_Dominance`, `Points_Per_WC`, `WC_vs_Continental`
  - *Top Scorers Analysis* — `Scorer_Tier`, `Goal_Era`
- **18 Charts** — Bar, Grouped Bar, Pie, KPI, Table, Line charts
- **3 Dashboards** with global filters:
  - *FIFA World Rankings Overview*
  - *World Cup History & Champions*
  - *World Cup Top Scorers — Golden Boot Analysis*

---

## Local Development

### Requirements

- Python 3.10+
- Node.js 18+
- PostgreSQL 14+

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Create environment file
cp .env.example .env            # or create manually

alembic upgrade head            # initialise DB schema
uvicorn app.main:app --reload --port 8000
```

Minimum `backend/.env`:
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/appbi_metadata
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1" > .env.local
npm run dev
```

---

## Project Structure

```
Dashboard-App/
├── backend/
│   ├── app/
│   │   ├── api/              # FastAPI routers (datasources, datasets, charts, dashboards…)
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── schemas/          # Pydantic v2 request/response schemas
│   │   └── services/         # Business logic, query engine, connector classes
│   ├── alembic/              # Database migrations
│   ├── Dockerfile
│   ├── entrypoint.sh         # Wait for DB → alembic upgrade head → optional seed → uvicorn
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── app/(main)/       # Next.js App Router pages
│   │   │   ├── datasources/  # Data source list, create, edit
│   │   │   ├── datasets/     # Dataset management + transformation designer
│   │   │   ├── explore/      # Point-and-click data exploration
│   │   │   ├── dashboards/   # Dashboard grid + filter bar
│   │   │   └── dataset-workspaces/ # Workspace + formula columns
│   │   ├── components/       # Shared React components
│   │   ├── hooks/            # TanStack Query data hooks
│   │   └── lib/api/          # Axios API client
│   └── Dockerfile
├── docs/
│   ├── API.md                # Full REST API reference
│   ├── ARCHITECTURE.md       # System architecture
│   ├── DOCKER.md             # Docker configuration details
│   └── SETUP.md              # Development setup guide
├── seed_demo.py              # Demo data seed script (Football / FIFA)
├── scope-foodball-demo.xlsx  # Source data file for seed
├── docker-compose.yml        # Production Docker Compose
├── docker-compose.dev.yml    # Development Docker Compose
├── .env.docker.example       # Environment template
└── README.md
```

---

## Architecture

```
Browser
  │
  ├─► Frontend :3000  (Next.js — Node runtime)
  │       │
  │       └─► Backend :8000  (FastAPI / uvicorn)  ────── appbi-net (Docker bridge)
  │                   │
  │                   └─► Database :5432  (PostgreSQL — NOT exposed to host)
```

- PostgreSQL has **no host port binding** — no conflict with a local Postgres instance
- All services communicate through internal Docker network `appbi-net`
- **Migrations** run automatically in `entrypoint.sh` on every backend start
- **Database data** is stored in named volume `db_data` — survives container restarts

---

## API Reference

Full REST API documentation is in [docs/API.md](docs/API.md).

Interactive Swagger UI is available at `http://localhost:8000/api/v1/docs` while the app is running.

---

## Data Sources hỗ trợ

| Loại | Ghi chú |
|---|---|
| **PostgreSQL** | Host · Port · Database · Username · Password · Schema (tuỳ chọn, đặt search_path) |
| **MySQL** | Host · Port · Database · Username · Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID (snapshot toàn bộ sheet khi kết nối) |
| **Manual (File Import)** | Upload CSV hoặc Excel `.xlsx/.xls` — tất cả sheet được import, xem preview trước khi lưu |

> Với PostgreSQL và MySQL: bắt buộc nhấn **Test Connection** thành công trước khi nút Create được kích hoạt.

---

## Filter Architecture (Dashboards)

| Loại | Phạm vi | Khi nào áp dụng | Field hợp lệ |
|---|---|---|---|
| **Global Filter Bar** | Toàn dashboard | Trước aggregation (pre-agg) | Dimension / breakdown fields |
| **Per-tile HAVING** | Từng chart tile | Sau aggregation (post-agg) | Metric keys (e.g. `sum__point`) |

---

## License

MIT

