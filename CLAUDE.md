# CLAUDE.md — AppBI Dashboard Platform

> Comprehensive reference for AI agents working on this codebase.
> Last updated: 2026-03-21

---

## Project Overview

AppBI is a **full-stack Business Intelligence platform** with three services:

| Service | Tech | Port | Purpose |
|---------|------|------|---------|
| Backend | FastAPI + SQLAlchemy | 8000 | BI API, data connectors, permissions |
| Frontend | Next.js 14 (App Router) | 3000 | Dashboard UI, charts, explore |
| AI Service | FastAPI + WebSocket | 8001 | Natural-language chat with tool-calling |

**Database**: PostgreSQL 16 (metadata only) + DuckDB/Parquet (analytics data)

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Frontend    │────▶│  Backend    │◀────│  AI Service  │
│  Next.js 14  │     │  FastAPI    │     │  FastAPI WS  │
│  :3000       │     │  :8000      │     │  :8001       │
└──────┬───────┘     └──────┬───────┘     └──────────────┘
       │                    │
       │              ┌─────┴─────┐
       │              │           │
       │         PostgreSQL    DuckDB
       │         (metadata)   (analytics)
       │              │           │
       │              │      .data/synced/
       │              │      .data/workspaces/
       └──────────────┘
```

### Data Flow
- **Metadata** (users, datasource configs, chart/dashboard definitions, permissions) → PostgreSQL
- **Analytics data** (synced tables, query results) → Parquet files + DuckDB engine
- **Parquet storage**: `.data/synced/` (auto-synced), `.data/workspaces/` (workspace tables)

---

## Project Structure

```
/
├── backend/                    # FastAPI BI Backend
│   ├── app/
│   │   ├── main.py             # App entry + lifespan (scheduler, DuckDB)
│   │   ├── api/                # Route handlers (REST endpoints)
│   │   │   ├── auth.py         # Login/logout/signup
│   │   │   ├── charts.py       # Chart CRUD + data execution
│   │   │   ├── dashboards.py   # Dashboard CRUD + layout
│   │   │   ├── dataset_workspaces.py  # Workspace table ops
│   │   │   ├── datasources.py  # DataSource CRUD + test connection
│   │   │   ├── permissions.py  # Module permission management
│   │   │   ├── shares.py       # Resource sharing + cascade
│   │   │   └── users.py        # User management (admin)
│   │   ├── core/
│   │   │   ├── config.py       # Settings from env vars
│   │   │   ├── crypto.py       # Fernet encryption for credentials
│   │   │   ├── database.py     # SQLAlchemy engine + session
│   │   │   ├── dependencies.py # FastAPI deps (auth, permission guards)
│   │   │   ├── logging.py      # Logging config
│   │   │   └── permissions.py  # Permission check utilities
│   │   ├── models/
│   │   │   ├── models.py       # Core models (DataSource, Chart, Dashboard)
│   │   │   ├── user.py         # User + UserStatus enum
│   │   │   ├── dataset_workspace.py  # DatasetWorkspace + DatasetWorkspaceTable
│   │   │   ├── resource_share.py     # ResourceShare + ResourceType + SharePermission
│   │   │   ├── module_permission.py  # ModulePermission (per-user per-module)
│   │   │   └── semantic.py     # SemanticView model
│   │   ├── schemas/            # Pydantic request/response DTOs
│   │   ├── services/           # Business logic (19 service modules)
│   │   └── routers/
│   │       └── semantic.py     # Semantic layer routes
│   ├── alembic/                # Database migrations (24 versions)
│   ├── entrypoint.sh           # Docker entrypoint (migrate + seed + start)
│   ├── Dockerfile
│   └── requirements.txt
│
├── frontend/                   # Next.js 14 Frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── (auth)/         # Auth pages (login, signup)
│   │   │   ├── (main)/         # Protected pages
│   │   │   │   ├── dashboards/ # Dashboard list + detail [id]
│   │   │   │   ├── explore/    # Chart builder + detail [id]
│   │   │   │   ├── datasources/# DataSource list + detail [id]
│   │   │   │   ├── dataset-workspaces/ # Workspace list + detail [id]
│   │   │   │   ├── permissions/# Permission matrix (admin)
│   │   │   │   └── users/      # User management (admin)
│   │   │   └── api/            # Next.js API routes (auth proxy)
│   │   ├── components/
│   │   │   ├── ai-chat/        # AI chat interface
│   │   │   ├── charts/         # Chart rendering (ChartPreview)
│   │   │   ├── common/         # Shared UI (ShareDialog, DeleteConstraintModal)
│   │   │   ├── dashboard/      # Dashboard editor components
│   │   │   ├── dashboards/     # DashboardGrid, ChartTile, FilterBar
│   │   │   ├── datasets/       # Workspace table components (grid, modals)
│   │   │   ├── datasources/    # DataSource forms + TableDetailModal
│   │   │   ├── explore/        # Explore builder (ExploreChart, SourceSelector)
│   │   │   ├── layout/         # Sidebar, TopNav
│   │   │   └── visualizations/ # Recharts wrappers
│   │   ├── hooks/              # React Query hooks (8 hook files)
│   │   ├── lib/                # Utilities, API clients, auth
│   │   └── types/              # TypeScript type definitions
│   ├── middleware.ts            # Edge middleware (JWT verification)
│   ├── package.json
│   └── Dockerfile
│
├── ai-service/                 # AI Chat Agent
│   ├── app/
│   │   ├── main.py             # FastAPI entry
│   │   ├── config.py           # LLM provider config
│   │   ├── agents/             # Agent logic + tool definitions
│   │   ├── clients/            # BI backend client, LLM clients
│   │   ├── routers/            # WebSocket chat endpoint
│   │   └── schemas/            # Chat DTOs
│   ├── Dockerfile
│   └── requirements.txt
│
├── docs/                       # Documentation (9 files)
├── docker-compose.yml          # Full stack (prod)
├── docker-compose.dev.yml      # Dev with hot reload
├── docker-compose.ai.yml       # AI service standalone
├── .env.docker.example         # Environment template
├── seed_demo.py                # Football/FIFA demo data
├── seed_test_users.py          # 3-account test setup
└── test_permissions.py         # Permission test suite (41 tests)
```

---

## Key Concepts

### Data Model Hierarchy

```
DataSource (PostgreSQL / MySQL / BigQuery / Google Sheets / CSV)
  └── DatasetWorkspace (container for tables)
        └── DatasetWorkspaceTable (one query or physical table)
              └── Chart (visualization on a table)
                    └── Dashboard (grid of charts)
```

- **DataSource**: Connection to external database/service. Credentials encrypted with Fernet.
- **DatasetWorkspace**: Groups multiple tables from different datasources. Think "virtual schema".
- **DatasetWorkspaceTable**: A single table — either a SQL query result or a physical table import. Supports computed columns (Excel-formula syntax via formulajs).
- **Chart**: Visualization bound to one `workspace_table_id`. 10+ chart types.
- **Dashboard**: Grid layout of charts with global filters.

> **Note**: Legacy `Dataset` concept (v1, single SQL query) has been fully removed. All charts now use `workspace_table_id` exclusively.

### Chart Types
`bar`, `line`, `area`, `pie`, `scatter`, `grouped_bar`, `stacked_bar`, `table`, `kpi`, `time_series`, `combo`

### Permission System (Two Layers)

**Layer 1 — Module Permissions** (what you can access):

| Module Key | Controls |
|------------|----------|
| `dashboards` | Dashboard list, create, edit, delete |
| `explore_charts` | Chart/explore builder |
| `workspaces` | Dataset workspaces |
| `data_sources` | DataSource connections |
| `ai_chat` | AI chat agent |
| `user_management` | User admin panel |
| `settings` | System settings |

Levels: `none` → `view` → `edit` → `full`

- `none`: Module hidden in sidebar, API returns 403
- `view`: Read-only access
- `edit`: Create + update (not delete)
- `full`: Create + update + delete + share + manage permissions

**Layer 2 — Resource Sharing** (who sees what):

| Field | Values |
|-------|--------|
| `ResourceType` | `dashboard`, `chart`, `workspace`, `datasource`, `chat_session` |
| `SharePermission` | `view`, `edit` |

- Owner always has full access to their resources
- Shared resources appear in recipient's list with permission level
- Dashboard cascade: sharing a dashboard auto-shares its charts + workspaces

**Permission Guards** (backend):
- `get_effective_permission(db, user, resource)` → `"none" | "view" | "edit" | "full"`
- `require_edit_access(db, user, resource, module)` → raises 403 if insufficient
- `require_full_access(db, user, resource, module)` → raises 403 if insufficient

**Permission Guards** (frontend):
- `usePermissions()` hook → module-level access checks
- `useResourcePermission(resource)` → `{ canView, canEdit, canDelete, canShare }`

### Authentication
- **Backend**: JWT tokens (python-jose), httpOnly cookies
- **Frontend**: Edge middleware validates JWT on every request
- **Login flow**: Frontend `/api/auth/login` → proxies to backend `/api/v1/auth/login` → sets httpOnly cookie
- **User model**: UUID primary key, email (unique), hashed password, `UserStatus` (active/deactivated)

---

## Development Setup

### Prerequisites
- Python 3.10+ with venv
- Node.js 18+ with npm
- PostgreSQL 16
- Docker + Docker Compose (for containerized deployment)

### Local Development (without Docker)

```bash
# 1. Database
createdb appbi  # or use existing PostgreSQL

# 2. Backend
cd backend
python -m venv ../venv
source ../venv/bin/activate
pip install -r requirements.txt
alembic upgrade head          # run migrations
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 3. Frontend
cd frontend
npm install
npm run dev                    # http://localhost:3000

# 4. AI Service (optional)
cd ai-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

### Docker Deployment

```bash
cp .env.docker.example .env
# Edit .env — set SECRET_KEY, ADMIN_PASSWORD, API keys
docker compose up --build -d
# Frontend: http://localhost:3000
# Backend:  http://localhost:8000/api/v1/docs
# AI Chat:  http://localhost:8001
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Yes | PostgreSQL credentials |
| `SECRET_KEY` | Yes | JWT signing secret |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Yes | First admin account (auto-created) |
| `DATASOURCE_ENCRYPTION_KEY` | For external sources | Fernet key for credential encryption |
| `LLM_PROVIDER` | For AI chat | `openai` / `anthropic` / `gemini` / `openrouter` |
| `LLM_MODEL` | For AI chat | Model name (e.g. `gpt-4o-mini`) |
| `OPENAI_API_KEY` | If using OpenAI | API key |
| `SEED_DEMO_DATA` | Optional | `true` to load demo data on first boot |

---

## API Endpoints

Base URL: `/api/v1`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login → JWT token |
| POST | `/auth/signup` | Register new user |
| GET/POST | `/datasources` | List / create datasources |
| GET/PUT/DELETE | `/datasources/{id}` | CRUD single datasource |
| POST | `/datasources/{id}/test` | Test connection |
| GET/POST | `/dataset-workspaces` | List / create workspaces |
| GET/PUT/DELETE | `/dataset-workspaces/{id}` | CRUD single workspace |
| POST | `/dataset-workspaces/{id}/tables` | Add table to workspace |
| GET/POST | `/charts` | List / create charts |
| GET/PUT/DELETE | `/charts/{id}` | CRUD single chart |
| GET | `/charts/{id}/data` | Execute chart query |
| GET/POST | `/dashboards` | List / create dashboards |
| GET/PUT/DELETE | `/dashboards/{id}` | CRUD single dashboard |
| PUT | `/dashboards/{id}/layout` | Update chart positions |
| GET/POST/PUT/DELETE | `/shares/{type}/{id}` | Resource sharing |
| GET/PUT | `/permissions/{user_id}` | Module permissions |
| GET | `/users` | List users (admin) |
| GET/POST | `/semantic/views` | Semantic layer views |

---

## Database Schema (Core Tables)

```
users                  (id UUID PK, email, hashed_password, name, status, permissions JSONB)
data_sources           (id, name, type, encrypted_credentials, sync_config, owner_id)
dataset_workspaces     (id, name, description, owner_id)
dataset_workspace_tables (id, workspace_id FK, datasource_id FK, display_name, sql_query, columns, type_overrides, column_formats, computed_columns)
charts                 (id, name, workspace_table_id FK, chart_type, config JSONB, owner_id)
chart_metadata         (id, chart_id FK, domain, intent, metrics, dimensions, tags)
chart_parameters       (id, chart_id FK, parameter_name, parameter_type, column_mapping, default_value)
dashboards             (id, name, description, owner_id, filters_config)
dashboard_charts       (id, dashboard_id FK, chart_id FK, layout JSONB, parameters JSONB)
resource_shares        (id, resource_type, resource_id, user_id FK, permission, shared_by)
module_permissions     (id, user_id FK, module_key, level)
semantic_views         (id, name, sql_table_name, workspace_table_id, columns, owner_id)
```

---

## Build & Test Commands

```bash
# Backend
cd backend
source ../venv/bin/activate
alembic upgrade head                    # apply migrations
alembic revision --autogenerate -m "description"  # create migration
pytest                                  # run tests
python -m uvicorn app.main:app --reload # dev server

# Frontend
cd frontend
npm run dev                             # dev server (port 3000)
npm run build                           # production build
npx tsc --noEmit                        # type check only

# Permissions test suite
cd /path/to/project
source venv/bin/activate
python test_permissions.py              # 41 tests covering all permission scenarios

# Demo data
python seed_demo.py                     # seed Football/FIFA demo (idempotent)
python seed_test_users.py               # create 3 test accounts
```

### Test Accounts (from seed_test_users.py)

| Email | Password | Role | Description |
|-------|----------|------|-------------|
| `admin@appbi.io` | `admin123` | Full access | All modules = `full` |
| `edit@appbi.io` | `edit123` | Editor | All modules = `edit` |
| `viewer@appbi.io` | `viewer123` | Viewer | All modules = `view` |

---

## Coding Conventions

### Backend (Python)
- **Framework**: FastAPI with async support
- **ORM**: SQLAlchemy 2.0 (declarative mapping)
- **Validation**: Pydantic v2 models for all request/response
- **Auth pattern**: `current_user = Depends(get_current_user)` on every protected endpoint
- **Permission pattern**: Use `require_edit_access()` / `require_full_access()` for write operations
- **Visibility**: All list endpoints filter by `filter_by_visibility()` — returns only owned + shared resources
- **Owner tracking**: All resource create endpoints set `owner_id = current_user.id`
- **Response enrichment**: All resource responses include `owner_id` + `user_permission` fields

### Frontend (TypeScript)
- **Framework**: Next.js 14 App Router with `"use client"` components
- **State**: TanStack React Query for server state, React useState for local
- **Styling**: Tailwind CSS + Radix UI primitives
- **API calls**: Axios-based API clients in `lib/api/`
- **Permission UI**: `useResourcePermission(resource)` returns `{ canEdit, canDelete, canShare }`
- **Guard pattern**: `{resPerms.canEdit && <Button>Edit</Button>}`

### Migrations
- File naming: `YYYYMMDD_HHMM_revision_slug.py`
- Always run `alembic upgrade head` after code changes
- Migration chain must be linear (no branches)

---

## Recent Changes (2026-03)

### Auth + Permissions System (Complete)
- Replaced simple `role` field with granular module + resource permission model
- Users table: `permissions` JSONB column stores module-level access
- `module_permissions` table for admin-managed overrides
- `resource_shares` table for per-resource sharing
- All API endpoints protected with permission guards
- Frontend: sidebar hides unauthorized modules, buttons disabled for viewers
- 41-test permission suite validates all scenarios

### Legacy Dataset Cleanup (Complete)
- Removed entire legacy `Dataset` concept (v1: single SQL query on one datasource)
- Deleted: 12 backend files, 8 frontend files
- Cleaned: 15+ backend files, 10+ frontend files
- Migration `20260320_drop_datasets`: dropped 6 tables + 2 FK columns
- All charts now exclusively use `workspace_table_id`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Backend won't start | Check PostgreSQL is running, `alembic upgrade head` |
| Import error after model changes | Run `alembic upgrade head`, check `__init__.py` exports |
| Frontend TypeScript errors | `npx tsc --noEmit` to find issues |
| Permission denied (403) | Check `module_permissions` for user, verify `owner_id` on resource |
| Chart shows no data | Verify `workspace_table_id` is set, datasource is connected |
| Docker first boot fails | Ensure `.env` is configured, especially `SECRET_KEY` |
