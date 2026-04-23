# AppBI AI

AppBI AI is a self-hosted BI platform focused on three workflows:

- connect data sources and model datasets
- explore data and build dashboards
- use AI chat / AI agent features on top of governed business data

The current system is built around a Next.js frontend, a FastAPI backend, PostgreSQL for application metadata, and optional AI services for chat and report generation.

## What The System Does

- Connects relational databases, BigQuery, Google Sheets, and file-based sources
- Lets users create datasets from physical tables, SQL queries, and calculated tables
- Supports dataset modeling, relationships, transformations, dictionary metadata, and data-quality rules
- Provides chart building, dashboard management, sharing, and public/embed flows
- Adds AI-assisted analytics through a chat service and an agent/report service

## Architecture

Core services:

- `frontend/`: Next.js application for datasets, explore, dashboards, auth, and admin UI
- `backend/`: FastAPI API for auth, permissions, datasets, charts, dashboards, and datasource logic
- `ai-service/`: AI chat service
- `ai-agent-service/`: AI agent/report service
- `db/`: PostgreSQL container for system metadata (optional when backend points to external PostgreSQL)

Typical runtime:

```text
Frontend (Next.js)
  -> Backend API (FastAPI)
  -> PostgreSQL (metadata)
  -> External data sources (BigQuery, Postgres, MySQL, Sheets, files)

Optional:
Frontend / Backend -> AI Chat Service
Frontend / Backend -> AI Agent Service
```

## Main Product Areas

### Data Sources and Datasets

- Create datasources and import or query tables
- Build datasets with transformations and semantic metadata
- Manage table relationships, dictionary information, and data quality rules

### Explore and Dashboards

- Build charts from dataset tables
- Assemble dashboards and dashboard pages
- Share dashboards internally or through public/embed links

### AI

- AI Chat for question-answering over connected business data
- AI Agent for guided report generation and AI-assisted analysis flows

## Repository Layout

```text
frontend/                Next.js frontend
backend/                 FastAPI backend
ai-chat/                 AI chat service
ai-report/               AI agent service
docker-compose.yml       base runtime
docker-compose.dev.yml   local development stack
docker-compose.ai.yml    AI services overlay
```

## Runtime-Only Git Scope

This repository is kept focused on the files required to build and run AppBI.

Included in Git for runtime:

- `frontend/`, `backend/`, `ai-chat/`, `ai-report/`
- `docker-compose*.yml`, `nginx.conf`
- `.env.example` and other safe environment templates
- `scripts/` needed for metadata migration and environment setup
- the root `README.md`

Excluded from Git for runtime hygiene:

- backend tests under `backend/tests/`
- demo/example assets under `dashboard_example/`
- internal design / audit / upgrade notes
- local artifacts under `.artifacts/`
- helper content under `Skill-AppBI/`

These files may still exist locally on a developer machine, but they are not part of the runtime-focused Git payload.

## Quick Start

### 1. Configure environment

Copy one of the environment templates:

```bash
cp .env.example .env
```

Set the important values in `.env`:

- `DB_HOST` / `DB_PORT` when using external PostgreSQL
- `DB_PASSWORD`
- `SECRET_KEY`
- `DATASOURCE_ENCRYPTION_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

### 2. Start the base stack

```bash
docker compose up -d --build
```

This starts only the app services. The bundled PostgreSQL container is now opt-in.

If you want to use the bundled local PostgreSQL instead of an external DB, run:

```bash
docker compose --profile local-db up -d --build
```

Base local URLs:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

### Use external PostgreSQL for metadata

AppBI can now store its internal metadata in an external PostgreSQL instead of the bundled `db` container.

Set either:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- or `DATABASE_URL` directly when you need URI options such as `sslmode=require`

If you want to skip starting the bundled PostgreSQL container entirely, start only the app services:

```bash
docker compose up -d --build backend frontend
```

With AI overlays, target the same explicit services, for example:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build backend frontend ai-chat-service ai-agent-service
```

### 3. Start AI services if needed

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

If AI services should run together with the bundled local PostgreSQL, add the same profile:

```bash
docker compose --profile local-db -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

You can also run only one AI service with:

```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

## Development

For local development with hot reload:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

For local development with the bundled PostgreSQL container:

```bash
docker compose --profile local-db -f docker-compose.dev.yml up -d --build
```

For hot reload against an external PostgreSQL without the bundled `db` container:

```bash
docker compose -f docker-compose.dev.yml up -d --build backend frontend
```

## Migrate Metadata From Old Docker PostgreSQL

If your old AppBI stack still has data inside its PostgreSQL container, migrate it with one of the helper scripts:

- Windows PowerShell: [scripts/migrate-metadata-postgres.ps1](scripts/migrate-metadata-postgres.ps1)
- Ubuntu/Linux bash: [scripts/migrate-metadata-postgres.sh](scripts/migrate-metadata-postgres.sh)

Minimum flow on Windows:

```powershell
.\scripts\migrate-metadata-postgres.ps1 -SourceContainer <old-postgres-container-name>
```

Minimum flow on Ubuntu/Linux:

```bash
bash scripts/migrate-metadata-postgres.sh --source-container <old-postgres-container-name>
```

Both scripts behave the same way by default:

- dump with `--clean --if-exists`
- wipe existing target metadata objects before recreating them from the old Docker DB dump
- strip `pgvector` extension DDL from the restore stream so managed/external PostgreSQL can accept the restore without superuser extension ownership problems

If you intentionally do not want the target metadata DB cleaned first, use:

- PowerShell: `-SkipClean`
- Bash: `--skip-clean`

What the script does:

- reads source DB settings from the old container when possible
- reads target DB settings from `.env` (`DATABASE_URL` or `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`)
- creates a SQL dump under `.artifacts/`
- restores that dump into the current metadata database

Useful variants:

```powershell
# Only create a dump from the old container
.\scripts\migrate-metadata-postgres.ps1 -SourceContainer <old-postgres-container-name> -DumpOnly

# Restore from an existing dump file
.\scripts\migrate-metadata-postgres.ps1 -SourceContainer <old-postgres-container-name> -RestoreOnly -DumpPath .\.artifacts\appbi-metadata.sql

# Override the target DB instead of using .env
.\scripts\migrate-metadata-postgres.ps1 -SourceContainer <old-postgres-container-name> -TargetHost db.example.com -TargetPort 5432 -TargetDbUser appbi -TargetDbPassword secret -TargetDbName appbi
```

Before running restore:

- make sure the target database already exists
- make sure the target PostgreSQL supports the extensions your AppBI metadata DB needs, especially `pgvector`
- stop or at least avoid writing to the old and new AppBI stacks during the migration window

After restore, start or restart backend so Alembic upgrades the restored schema if the old DB came from an earlier version:

```bash
docker compose up -d --build backend
```

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
```

## Run On Another VM

Initial setup on a new VM:

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
cp .env.example .env
```

If the VM runs Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` with the values for that VM, especially:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` or `DATABASE_URL`
- `SECRET_KEY`
- `DATASOURCE_ENCRYPTION_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Start the base runtime:

```bash
docker compose up -d --build backend frontend
```

If that VM should also run the bundled PostgreSQL:

```bash
docker compose --profile local-db up -d --build
```

If that VM should also run AI services:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build backend frontend ai-chat-service ai-agent-service
```

## Get The Latest Updates On That VM

If the VM has no local edits:

```bash
git pull --rebase origin master
docker compose up -d --build backend frontend
```

If the VM also runs AI services, rebuild with the AI overlay again after pull:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build backend frontend ai-chat-service ai-agent-service
```

If the VM has local edits that you want to keep temporarily:

```bash
git stash push -u
git pull --rebase origin master
git stash pop
```

Recommended update flow on every VM:

1. `git pull --rebase origin master`
2. `docker compose up -d --build ...` for the services used on that VM
3. `docker compose ps`
4. `docker compose logs -f backend`

## Notes

- The backend is the main integration layer for datasets, datasource access, permissions, and dashboard APIs.
- AI services are optional overlays, not mandatory for the base BI workflow.
- The repo currently includes active work on dataset quality, dashboard import flows, and explore/dashboard UX.
