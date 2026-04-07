# AppBI

AppBI is a self-hosted business intelligence platform for connecting data sources, modeling datasets, exploring data, building dashboards, and running optional AI-assisted workflows.

This repository is the runtime-focused app repo for the product. The core stack can be started with Docker Compose, while AI services can be added only when needed.

## Core Runtime

The main project runtime includes:

- `frontend`: Next.js app for Explore, dashboards, sharing, and embedded views
- `backend`: FastAPI API for auth, datasets, query execution, chart contracts, and chart runtime
- `db`: PostgreSQL 16 with `pgvector`

Optional services:

- `ai-service`: AI chat / streaming assistant features
- `ai-agent-service`: guided AI report and dashboard generation

## Main Capabilities

### Data and Modeling

- Connect PostgreSQL, MySQL, BigQuery, Google Sheets, and manual file uploads
- Build datasets with semantic fields, hidden fields, joins, and ERD-style relationship editing
- Support live-query-first execution with optional synced/cached execution paths

### Explore and Charts

- Generated query and custom SQL in one Explore workflow
- Chart types:
  `TABLE`, `BAR`, `HORIZONTAL_BAR`, `GROUPED_BAR`, `STACKED_BAR`, `BAR_LINE`, `LINE`, `AREA`, `TIME_SERIES`, `PIE`, `SCATTER`, `KPI`
- Table now stays in standard mode by default, with optional advanced features:
  - Dynamic pivot layout
  - Multiple summary rows
  - Sticky summary footer
  - Conditional formatting
  - Matrix heatmap
- Optional benchmark line for supported charts:
  - `BAR`
  - `HORIZONTAL_BAR`
  - `GROUPED_BAR`
  - `STACKED_BAR`
  - `LINE`
  - `AREA`
  - `TIME_SERIES`
  - `BAR_LINE`

### Dashboards and Sharing

- Drag-and-drop dashboard layout
- Public dashboard pages and embed mode
- Shared chart rendering behavior across Explore, dashboard tiles, public, and embed views

### Permissions

- Module-level permissions: `none / view / edit / full`
- Shared access control for dashboards and charts

## Recent Runtime-Ready Updates

This README reflects the current working tree on top of the latest local repo base commit:

- Base commit: `6ce52ef`
- Commit title: `feat: ship live-query runtime and explore sync updates`

### 1. Live-query runtime hardening

- Dataset tables now resolve effective query mode at runtime
- When datasource sync is globally disabled, existing synced tables with cached artifacts can still work
- Preview and execution flows now behave more safely after restart/redeploy

### 2. Dynamic pivot table for `TABLE`

- `TABLE` supports dynamic pivot mode with:
  - row dimension
  - dynamic header dimension
  - dynamic aggregated measure
- Query generation and live-query execution both support grouped pivot fetches
- Public and embed rendering use the same pivot-aware chart runtime

### 3. Advanced table analytics

- Standard table remains the default mode
- Optional features can be enabled independently:
  - conditional formatting
  - heatmap
  - summary rows
- Summary rows support:
  - multiple rows
  - custom labels
  - formula selection (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`, `COUNT DISTINCT`)
  - per-row column targeting
- Summary rows stay pinned at the bottom of the scroll area

### 4. Optional benchmark lines for charts

- Benchmark/reference line support was added for supported cartesian charts
- Users can control:
  - enable/disable
  - benchmark value
  - label
  - line color
  - line style
- Feature is optional and does not change existing charts until enabled

### 5. Explore / preview consistency

- Explore now previews `TABLE` using the actual table renderer instead of a simplified grid
- Dashboard tile, public page, and embed page now normalize style config more consistently
- Table enhancements and benchmark line behavior stay aligned across rendering contexts

## Quick Start

### Prerequisites

- Docker 24+
- Docker Compose v2
- At least 2 GB RAM for local development

### 1. Clone and configure

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
cp .env.example .env
```

Update `.env` and replace all `CHANGE_ME` values.

Important variables:

| Variable | Purpose |
| --- | --- |
| `DB_PASSWORD` | PostgreSQL password |
| `SECRET_KEY` | JWT signing key |
| `ENCRYPTION_KEY` | Encryption key for stored credentials |
| `NEXTAUTH_SECRET` | NextAuth secret |
| `NEXT_PUBLIC_APP_URL` | Frontend app URL |
| `ENABLE_DATASOURCE_SYNC` | Backend sync / cached runtime flag |
| `NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC` | Frontend sync UI flag |
| `FIRST_ADMIN_EMAIL` | Seed admin email |
| `FIRST_ADMIN_PASSWORD` | Seed admin password |

### 2. Start the core stack

```bash
docker compose up -d --build
```

Core app URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8000`

### 3. Development mode

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### 4. Optional AI services

```bash
# Full AI add-ons
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build

# Chat only
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build

# Agent only
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

## Runtime Modes

### Default mode: live-query-first

- `ENABLE_DATASOURCE_SYNC=false`
- Query execution prefers direct source access
- Sync-related UI/actions stay disabled

### Sync-enabled mode

- `ENABLE_DATASOURCE_SYNC=true`
- Synced execution paths are available
- Tables can use cached/synced runtime where configured

## Deployment-Safe Commit Scope

When preparing commits for the runtime repo, include only files that are needed to build or run the application.

Recommended to commit:

- `backend/`
- `frontend/`
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `docker-compose.ai.yml`
- `docker-compose.chat.yml`
- `docker-compose.agent.yml`
- `nginx.conf`
- `.env.example`
- `README.md`
- `ai-service/` and `ai-agent-service/` only if those services are part of the deploy target

Do not include local-only or non-runtime workspace content:

- `cube/`
- `TEMP_ACCESS_ISSUES.md`
- `.pytest_cache/`
- `.claude/`
- local notes, ad-hoc docs, caches, screenshots, and temporary test artifacts

## Project Structure

```text
appbi-ai/
|-- backend/
|   |-- app/
|   |-- alembic/
|-- frontend/
|   `-- src/
|-- ai-service/
|-- ai-agent-service/
|-- docker-compose.yml
|-- docker-compose.dev.yml
|-- docker-compose.ai.yml
|-- docker-compose.chat.yml
|-- docker-compose.agent.yml
|-- nginx.conf
|-- .env.example
`-- README.md
```

## Verification

Useful validation commands:

```bash
docker compose exec -T backend python -m compileall app
docker compose exec -T frontend npm run build
```

## License

Proprietary. Contact the maintainers for licensing questions.
