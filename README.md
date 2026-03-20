# AppBI — Business Intelligence Dashboard

<p align="center">
  <strong>Self-hosted BI platform with drag-drop dashboards, AI chat, and granular permissions.</strong>
</p>

---

## Features

| Module | Description |
|--------|-------------|
| **Data Sources** | Connect PostgreSQL, MySQL, BigQuery, Google Sheets, or upload CSV/Excel. Test connection before saving. Auto-sync on schedule. |
| **Workspaces** | Combine tables from multiple sources into one workspace. Add computed columns with Excel-formula syntax. |
| **Explore** | Point-and-click chart builder — pick dimensions, metrics, filters, and chart type. Save & reuse. |
| **Charts** | 10+ types: Bar, Line, Area, Pie, Scatter, Grouped/Stacked Bar, Table, KPI, Time Series, Combo. |
| **Dashboards** | Drag-drop grid layout. Global filters, per-tile parameters, inline title editing. |
| **AI Chat** | Ask questions in natural language. Agent uses tools to search charts, run queries, and build answers. |
| **Permissions** | Module-level access control (none/view/edit/full) + resource-level sharing (view/edit). |
| **User Management** | Admin panel for user creation, deactivation, and permission assignment. |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, Recharts, TanStack Query, react-grid-layout |
| Backend | FastAPI, SQLAlchemy 2.0, Alembic, Pydantic v2, DuckDB, Python 3.10+ |
| AI Agent | FastAPI, WebSocket streaming, OpenAI / Anthropic / Gemini / OpenRouter |
| Database | PostgreSQL 16 (metadata), DuckDB + Parquet (analytics) |
| Infrastructure | Docker, Docker Compose |

---

## Quick Start

### Docker (Recommended)

```bash
git clone <repo-url> && cd Dashboard-App
cp .env.docker.example .env
# Edit .env — set SECRET_KEY and ADMIN_PASSWORD at minimum
docker compose up --build -d
```

Open http://localhost:3000 and log in with the admin credentials from `.env`.

### Local Development

**Prerequisites**: Python 3.10+, Node.js 18+, PostgreSQL 16

```bash
# 1. Database
createdb appbi

# 2. Backend (terminal 1)
cd backend
python -m venv ../venv && source ../venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 3. Frontend (terminal 2)
cd frontend
npm install && npm run dev

# 4. AI Service — optional (terminal 3)
cd ai-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000/api/v1/docs |
| AI Chat | http://localhost:8001 |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Yes | `appbi` | PostgreSQL credentials |
| `SECRET_KEY` | Yes | — | JWT signing secret (change in production) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Yes | `admin@appbi.io` | Auto-created admin account |
| `DATASOURCE_ENCRYPTION_KEY` | For external sources | — | Fernet key for credential encryption |
| `SEED_DEMO_DATA` | No | `false` | `true` to load demo data on first boot |
| `LLM_PROVIDER` | For AI chat | `openai` | `openai` / `anthropic` / `gemini` / `openrouter` |
| `LLM_MODEL` | For AI chat | `gpt-4o-mini` | Model name |
| `OPENAI_API_KEY` | If using OpenAI | — | API key |
| `ANTHROPIC_API_KEY` | If using Anthropic | — | API key |
| `GEMINI_API_KEY` | If using Gemini | — | API key |

Generate encryption key:
```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Full annotated template: `.env.docker.example`

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Frontend    │────▶│  Backend    │◀────│  AI Service  │
│  Next.js 14  │     │  FastAPI    │     │  FastAPI WS  │
│  :3000       │     │  :8000      │     │  :8001       │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────┴──────┐
                  PostgreSQL    DuckDB
                  (metadata)   (analytics)
```

- **PostgreSQL** stores metadata: users, datasource configs, chart/dashboard definitions, permissions, shares.
- **DuckDB** + **Parquet** files handle analytics queries. Synced data lives in `.data/`.
- **AI Service** connects to the Backend API to search charts, execute queries, and answer user questions via tool-calling.

### Data Model

```
DataSource → DatasetWorkspace → DatasetWorkspaceTable → Chart → Dashboard
```

- **DataSource**: External database/file connection (encrypted credentials)
- **DatasetWorkspace**: Container grouping tables from multiple sources
- **DatasetWorkspaceTable**: Single table (SQL query or physical import) with optional computed columns
- **Chart**: Visualization bound to one workspace table
- **Dashboard**: Grid of charts with shared filters

---

## Permission System

### Module-Level Access

Each user has per-module access levels:

| Level | Capabilities |
|-------|-------------|
| `none` | Module hidden, API returns 403 |
| `view` | Read-only access |
| `edit` | Create + update |
| `full` | Create + update + delete + share |

**Modules**: `dashboards`, `explore_charts`, `workspaces`, `data_sources`, `ai_chat`, `user_management`, `settings`

### Resource-Level Sharing

Resources can be shared with other users as `view` or `edit`. Sharing a dashboard cascades to its charts and workspaces.

---

## Demo Data

Set `SEED_DEMO_DATA=true` in `.env` for auto-loading on first boot, or run manually:

```bash
python seed_demo.py
```

Creates: 1 datasource (Football/FIFA), 3 workspaces, 18 charts, 3 dashboards.

### Test Accounts

```bash
python seed_test_users.py
```

| Email | Password | Access Level |
|-------|----------|-------------|
| `admin@appbi.io` | `admin123` | Full access (all modules) |
| `edit@appbi.io` | `edit123` | Editor (all modules) |
| `viewer@appbi.io` | `viewer123` | Viewer (all modules) |

---

## AI Chat Agent

Natural-language data Q&A powered by LLM tool-calling.

### Tools Available to the LLM

| Tool | Description |
|------|-------------|
| `search_charts(query)` | Semantic search across saved charts, returns top match data |
| `run_chart(chart_id)` | Execute a chart and stream its data + rendered chart |
| `execute_sql(datasource_id, sql)` | Run SELECT query against a datasource |
| `query_table(workspace_id, table_id, ...)` | Aggregation query on a workspace table |

### LLM Providers & Fallback Chain

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_FALLBACK_CHAIN=anthropic:claude-3-5-haiku-20241022,gemini:gemini-2.0-flash
```

Supported: `openai`, `anthropic`, `gemini`, `openrouter`

---

## Docker Compose Files

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Production: all services |
| `docker-compose.dev.yml` | Development: hot reload, volume mounts |
| `docker-compose.ai.yml` | AI service standalone |

```bash
# Production
docker compose up --build -d

# Development (hot reload)
docker compose -f docker-compose.dev.yml up --build -d
```

---

## API Reference

Interactive docs: http://localhost:8000/api/v1/docs

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/auth/login` | POST | Authenticate, returns JWT |
| `/auth/signup` | POST | Register new user |
| `/datasources` | GET, POST | List / create data sources |
| `/datasources/{id}` | GET, PUT, DELETE | Single data source |
| `/dataset-workspaces` | GET, POST | List / create workspaces |
| `/dataset-workspaces/{id}` | GET, PUT, DELETE | Single workspace |
| `/charts` | GET, POST | List / create charts |
| `/charts/{id}` | GET, PUT, DELETE | Single chart |
| `/charts/{id}/data` | GET | Execute chart query |
| `/dashboards` | GET, POST | List / create dashboards |
| `/dashboards/{id}` | GET, PUT, DELETE | Single dashboard |
| `/shares/{type}/{id}` | GET, POST, PUT, DELETE | Resource sharing |
| `/permissions/{user_id}` | GET, PUT | User module permissions |
| `/users` | GET | List users (admin) |

Full API documentation: [docs/API.md](docs/API.md)

---

## Data Sources Supported

| Type | Details |
|------|---------|
| **PostgreSQL** | Host, Port, Database, Username, Password, Schema (optional) |
| **MySQL** | Host, Port, Database, Username, Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID |
| **Manual (File Import)** | CSV or Excel (.xlsx/.xls) — all sheets imported with preview |

---

## License

Private — All rights reserved.
