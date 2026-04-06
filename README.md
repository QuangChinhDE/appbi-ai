# AppBI

AppBI is a self-hosted business intelligence platform for connecting data sources, modeling datasets, building charts and dashboards, and running AI-assisted analysis workflows.

You can run the core stack locally with a single Docker Compose command, then add optional AI services when needed.

## Features

### Core BI
- Data Sources: PostgreSQL, MySQL, BigQuery, Google Sheets, and manual CSV/Excel uploads
- Dataset Modeling: visual ERD canvas, relationship management, semantic fields, hidden fields, and manual join editing
- Query Modes: live-query-first execution by default, with optional datasource sync / DuckDB caching
- Explore: drag-and-drop chart builder plus generated SQL and editable custom SQL in the same workflow
- Dashboards: drag-and-drop layout, public filters, embed links, per-chart parameters, and shared access control
- Permissions: module-level `none / view / edit / full` permission model

### Explore / Charting
- Generated SQL and custom SQL can be switched inside Explore without losing chart context
- Custom SQL results now sync back into chart semantics more reliably
- Supported chart types:
  `BAR`, `HORIZONTAL_BAR`, `GROUPED_BAR`, `STACKED_BAR`, `BAR_LINE`, `LINE`, `AREA`, `TIME_SERIES`, `PIE`, `SCATTER`, `TABLE`, `KPI`

### AI
- AI Chat for conversational analysis
- AI Agent flow for guided report generation
- AI-generated descriptions for charts and dataset tables
- Embedding-backed semantic search for charts and tables
- Feedback pipeline for improving generated descriptions and aliases

## Recent Updates

This README update reflects the current worktree changes since the previous docs update.

### 1. Live-query-first runtime mode
- Datasource sync is now feature-flagged with `ENABLE_DATASOURCE_SYNC` and `NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC`
- When sync is disabled, AppBI runs in live-query-only mode and hides or disables datasource sync actions
- Dataset tables resolve their effective `query_mode` at runtime, so deployments can switch behavior cleanly without schema drift in the UI

### 2. Smarter dataset execution for large tables
- Dataset tables now carry query-mode metadata such as `query_mode`, estimated row count, and estimated size
- Large physical tables can be routed to live query execution instead of forced sync
- Table preview, chart execution, and stats services now respect the live/synced routing model

### 3. Type overrides and better dataset previews
- Dataset tables support user-defined type overrides
- Runtime casts are applied more consistently so previews and live queries reflect the chosen column type
- The dataset grid includes stronger display formatting behavior for typed values

### 4. Explore rebuild for SQL + chart round-tripping
- Explore now separates generated-query state from custom-SQL state
- Custom SQL can be edited, run, and returned to chart view without snapping back to the previous generated result
- The custom SQL flow now avoids duplicate `LIMIT` injection
- Query errors surface the real backend reason instead of a generic failure toast
- After running custom SQL, Explore infers chart semantics from the SQL result more reliably, including dimension and aggregate intent
- `Use Generated` now regenerates from the latest synced chart semantics instead of jumping back to stale config

### 5. New chart types and chart runtime improvements
- Added `HORIZONTAL_BAR` and `BAR_LINE` across backend schemas, migrations, chart config, and rendering
- Explore chart config and runtime adapters were updated to support richer pre-aggregated chart flows
- Dashboard chart tiles now handle parameter-driven server-side filtering more cleanly

### 6. Dataset model and dashboard UX improvements
- Data model canvas received a larger ERD/relationship handling update
- Add-chart and chart-tile flows were refined for dashboard editing
- Public dashboard and embed pages were updated to better surface applied public filters

## Architecture

### Core services
- `frontend`: Next.js 14 application
- `backend`: FastAPI API, auth, dataset/query logic, chart execution
- `db`: PostgreSQL 16 with pgvector

### Optional AI services
- `ai-service`: streaming AI chat service
- `ai-agent-service`: guided AI report / dashboard generation service

### Query path overview
- Live mode: query the source directly
- Synced mode: query cached data through DuckDB when datasource sync is enabled

## Quick Start

### Prerequisites
- Docker 24+
- Docker Compose v2
- At least 2 GB RAM for local development

### 1. Clone the repo

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
cp .env.example .env
```

### 2. Configure environment variables

Edit `.env` and replace every `CHANGE_ME` value.

Important variables:

| Variable | Description |
|---|---|
| `DB_PASSWORD` | PostgreSQL password |
| `SECRET_KEY` | JWT signing key |
| `ENCRYPTION_KEY` | Credential encryption key |
| `NEXTAUTH_SECRET` | NextAuth secret |
| `NEXT_PUBLIC_APP_URL` | Public app URL |
| `ENABLE_DATASOURCE_SYNC` | Backend flag for datasource sync / DuckDB mode |
| `NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC` | Frontend flag for showing sync UI |

### 3. Start the core stack

```bash
docker compose up -d --build
```

AppBI will be available at `http://localhost:3000` by default.

Default admin credentials are seeded from:
- `FIRST_ADMIN_EMAIL`
- `FIRST_ADMIN_PASSWORD`

### 4. Optional AI services

```bash
# AI Chat + AI Agent
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build

# AI Chat only
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build

# AI Agent only
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

### 5. Development mode

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## Deployment Modes

### Default mode: live-query-first
- `ENABLE_DATASOURCE_SYNC=false`
- Datasource sync endpoints stay disabled
- Dataset execution runs directly against the source

### Sync-enabled mode
- `ENABLE_DATASOURCE_SYNC=true`
- DuckDB-backed sync flows and schedulers are enabled
- Tables can use synced execution where appropriate

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS, TanStack Query |
| Backend | FastAPI, SQLAlchemy 2, Alembic, APScheduler |
| Database | PostgreSQL 16, pgvector |
| Query Engine | DuckDB |
| AI | OpenAI-compatible APIs, LangGraph, SSE streaming |
| Infra | Docker Compose, nginx |

## Project Structure

```text
appbi-ai/
|-- backend/
|   |-- app/
|   |   |-- api/
|   |   |-- models/
|   |   |-- schemas/
|   |   `-- services/
|   `-- alembic/
|-- frontend/
|   `-- src/
|       |-- app/
|       |-- components/
|       |-- hooks/
|       `-- lib/
|-- ai-service/
|-- ai-agent-service/
|-- docker-compose.yml
|-- docker-compose.dev.yml
|-- docker-compose.ai.yml
|-- docker-compose.chat.yml
|-- docker-compose.agent.yml
`-- .env.example
```

## Database Migrations

Run manually if needed:

```bash
docker compose exec backend alembic upgrade head
```

Recent migration additions include:
- dataset table query mode metadata
- new chart enum values for `HORIZONTAL_BAR` and `BAR_LINE`

## Verification

Useful verification commands for this codebase:

```bash
docker compose exec -T backend python -m compileall app
docker compose exec -T frontend npm run build
```

## Contributing

1. Create a feature branch
2. Make your changes
3. Run the relevant build or test commands
4. Open a pull request with a clear summary

## License

Proprietary. Contact the maintainers for licensing questions.
