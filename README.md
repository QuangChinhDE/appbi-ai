# AppBI AI

AppBI AI is a self-hosted business intelligence platform with governed data
access, dashboarding, AI-assisted analysis, and a Workboards module for building
small operational apps on top of existing dataset tables.

This repository is kept focused on runtime code. Local tests, demo data, audit
notes, generated artifacts, and private environment files are intentionally not
part of the Git payload.

## Core Capabilities

- Connect PostgreSQL, MySQL, BigQuery, Google Sheets, CSV, and Excel sources.
- Build datasets from physical tables, SQL queries, calculated tables, and
  semantic metadata.
- Explore data, save charts, assemble dashboards, and share dashboards through
  internal or public links.
- Use AI Chat for ad hoc analysis over governed datasets.
- Use AI Agent flows for saved analytical report generation.
- Build Workboards: CRUD-style mini apps with forms, lists, doc views, row
  validation, public links, and workspace links.

Report Template code has been removed. Workboards are the active replacement for
portable, dataset-backed operational apps.

## Architecture

```text
frontend/        Next.js application
backend/         FastAPI API, auth, permissions, datasets, dashboards, Workboards
ai-chat/         Optional AI Chat service
ai-report/       Optional AI Agent service
docker-compose*.yml
nginx.conf
```

Runtime flow:

```text
Browser -> Frontend -> Backend API -> PostgreSQL metadata DB
                         |
                         +-> External data sources
                         +-> Optional AI Chat / AI Agent services
```

PostgreSQL metadata can be external or the bundled `db` service. The bundled DB
starts only when the `local-db` profile is enabled.

## Git Scope

Included:

- `backend/`, `frontend/`, `ai-chat/`, `ai-report/`
- Alembic migrations and runtime service code
- Docker Compose files, Dockerfiles, and `nginx.conf`
- Safe environment templates such as `.env.example`
- Runtime helper scripts needed for migration or deployment

Excluded:

- `.env`, `.env.local`, and other local secret files
- `backend/tests/`, `tests/`, `test_*.py`, and local verification scripts
- demo seed data, generated bundles, local audit files, and `.artifacts/`
- `Skill-AppBI/`, design notes, and non-runtime research documents

## Quick Start

1. Create a runtime environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

2. Edit `.env` and set production-safe values:

- `SECRET_KEY`
- `DATASOURCE_ENCRYPTION_KEY`
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` or `DATABASE_URL`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- optional AI keys such as `GEMINI_API_KEY` or `OPENROUTER_API_KEY`

3. Start the base stack:

```bash
docker compose up -d --build backend frontend
```

If you only changed the frontend and want to rebuild only that service:

```bash
docker compose up -d --build --no-deps frontend
```

4. If you want the bundled PostgreSQL container:

```bash
docker compose --profile local-db up -d --build
```

Base URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

## Optional AI Services

Start both AI services:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Start only AI Chat:

```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

Start only AI Agent:

```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

With bundled PostgreSQL, add `--profile local-db` to the same command.

## Development

Hot reload stack:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Hot reload with bundled PostgreSQL:

```bash
docker compose --profile local-db -f docker-compose.dev.yml up -d --build
```

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
```

Frontend-only UI work:

```bash
docker compose -f docker-compose.dev.yml up -d --build backend
docker compose -f docker-compose.dev.yml up -d --build --no-deps frontend
```

After the first image build, most UI changes should not need another Docker
build at all because the whole `frontend/` folder is mounted into the container
and Next.js runs in hot-reload mode. For normal UI edits, keep the container up
and just save files.

If the backend is already running elsewhere, point the frontend dev container to
it and start only the frontend:

```powershell
$env:FRONTEND_BACKEND_URL="http://host.docker.internal:8000/api/v1"
docker compose -f docker-compose.dev.yml up -d --build --no-deps frontend
```

Frontend checks:

```bash
cd frontend
npm run build
```

Backend syntax check:

```bash
cd backend
python -m compileall app
```

## Database Migrations

The backend entrypoint runs Alembic migrations before starting the API.

Current migration flow includes:

- reserved placeholders for removed Report Template revisions
- dataset quality progress columns
- Workboards tables
- Workboard permission backfill
- public workspace and app-user login attempt tables

To run migrations manually inside the backend container:

```bash
docker compose exec backend alembic upgrade head
```

## Metadata Migration From An Old Docker DB

If an older AppBI deployment stores metadata in a Docker PostgreSQL container,
use the migration helpers:

- `scripts/migrate-metadata-postgres.ps1`
- `scripts/migrate-metadata-postgres.sh`

Windows:

```powershell
.\scripts\migrate-metadata-postgres.ps1 -SourceContainer <old-postgres-container-name>
```

Linux:

```bash
bash scripts/migrate-metadata-postgres.sh --source-container <old-postgres-container-name>
```

The scripts dump the old metadata DB, clean the target by default, strip
`pgvector` extension ownership DDL, and restore into the target configured by
`.env`.

## Deploy On Another VM

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
cp .env.example .env
docker compose up -d --build backend frontend
```

Update an existing VM:

```bash
git pull --rebase origin master
docker compose up -d --build backend frontend
```

If AI services are enabled, rebuild with the same overlay used during startup.

## Security Notes

- Never commit `.env` or real API keys.
- Use a generated `SECRET_KEY` for every production deployment.
- Set `DATASOURCE_ENCRYPTION_KEY` before adding production data sources.
- Keep public services behind nginx or another reverse proxy for domain
  deployments.
