# AppBI

AppBI is a self-hosted BI platform for connecting operational data sources, modeling datasets, exploring data, building dashboards, and optionally attaching AI workflows.

This repository is the runtime repo for the app. The main stack is:

- `frontend`: Next.js UI
- `backend`: FastAPI API
- `db`: PostgreSQL 16 + `pgvector`

Optional services:

- `ai-service`
- `ai-agent-service`

## Current Runtime Notes

Latest committed base in this repo is:

- Commit: `911bc1a`
- Title: `feat: ship advanced table analytics and chart benchmarks`

Current local updates on top of that base focus on runtime behavior:

- smoother dataset and datasource tab switching in the frontend
- reduced unnecessary preview fetching and polling
- lighter client-side table formatting work
- BigQuery live preview guard raised from `10GB` to `60GB`
- BigQuery dataset preview on physical tables now widens `_PARTITIONDATE` from today backwards until the requested page is filled

Chart live queries keep their existing aggregation semantics. Only the BigQuery scan cap was raised for charts; chart queries are not auto-limited to recent partitions because that could silently change metrics.

## Main Capabilities

- Connect PostgreSQL, MySQL, BigQuery, Google Sheets, and manual tables
- Build datasets from physical tables or SQL queries
- Run in `live-query-first` mode by default
- Explore with tables, pivot tables, chart benchmarks, summaries, and formatting
- Build and share dashboards
- Optional AI chat and AI agent services

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
# basic/password login preset
cp .env.example .env

# or Google login preset
# cp .env.google.example .env
```

Then update `.env`.

Minimum variables to review before first run:

- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `SECRET_KEY`
- `DATASOURCE_ENCRYPTION_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS`

Optional but important depending on your setup:

- `GCP_SERVICE_ACCOUNT_JSON`
- `GCP_SERVICE_ACCOUNT_EMAIL`
- `AUTH_GOOGLE_ENABLED`
- `AUTH_GOOGLE_CLIENT_ID`
- `AUTH_GOOGLE_CLIENT_SECRET`
- `AUTH_GOOGLE_DATA_REDIRECT_URI`
- `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_1..5`
- `ENABLE_DATASOURCE_SYNC`
- `NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC`
- `BQ_MAX_BYTES_SCANNED`

### Google sign-in setup

If you want users to log in with Google instead of email/password:

- Create a Google Identity Services Web OAuth client in Google Cloud Console.
- Add your frontend origin (for example `http://localhost:3000`) to the authorized JavaScript origins.
- Set `AUTH_GOOGLE_ENABLED=true`
- Set `AUTH_GOOGLE_CLIENT_ID=<your Google Web client ID>`
- Set `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true`
- Set `NEXT_PUBLIC_GOOGLE_CLIENT_ID=<the same Google Web client ID>`
- Set `AUTH_PASSWORD_LOGIN_ENABLED=false` and `NEXT_PUBLIC_AUTH_PASSWORD_LOGIN_ENABLED=false` if you want Google-only login.
- Leave `AUTH_GOOGLE_AUTO_CREATE_USERS=false` if admins should pre-create users first, or set it to `true` if first Google sign-in should auto-create a user.

### Google data access for BigQuery / Sheets

If you want BigQuery and Google Sheets datasources to use each signed-in user's
Google account instead of a service account:

- Reuse the same Google Web OAuth client, or create another Web client for AppBI.
- Set `AUTH_GOOGLE_CLIENT_SECRET=<your Google Web client secret>`.
- Set `AUTH_GOOGLE_DATA_REDIRECT_URI=<your exact callback URI>`.
- Add that exact callback URI in Google Cloud Console, for example:
  - `http://localhost:3000/api/v1/auth/google/data-access/callback`
  - `https://bi.your-domain.com/api/v1/auth/google/data-access/callback`
- In the datasource form, choose `Use my Google account`, then click `Connect Google access`.

The original service-account flow still works, so you can mix both modes in the
same deployment.

### 2. Start the core production-style stack

```bash
docker compose up -d --build
```

Default URLs:

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:8000/health`

### 3. Start the hot-reload development stack

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

This dev stack mounts backend and frontend source code for live reload.

### 4. Optional AI overlays

Production-style stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

Dev stack:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
docker compose -f docker-compose.dev.yml -f docker-compose.chat.yml up -d --build
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

## Runtime Modes

### Default: live-query-first

By default:

- `ENABLE_DATASOURCE_SYNC=false`
- `NEXT_PUBLIC_ENABLE_DATASOURCE_SYNC=false`

That means datasets prefer querying the source directly instead of syncing data locally first.

### Sync-enabled mode

If you set both flags to `true`, datasource sync features become available again and dataset tables can use synced artifacts where supported.

## BigQuery Live Mode

The current runtime is tuned for live BigQuery access:

- `BQ_MAX_BYTES_SCANNED=64424509440` (`60GB`)
- BigQuery preview for dataset physical tables auto-detects the real time partition column from table metadata
- If the table uses ingestion-time partitioning, preview falls back to `_PARTITIONTIME`
- Preview starts from `CURRENT_DATE()`
- If the current partition window does not return enough rows for the requested page, the backend automatically widens the window to include older dates
- The widening stops as soon as the page is filled or the available partition history is exhausted

This behavior is intended for large partitioned operational tables where live mode is preferred over full sync.

## Useful Commands

Start core stack:

```bash
docker compose up -d --build
```

Start dev stack:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Rebuild backend only:

```bash
docker compose -f docker-compose.dev.yml up -d --build backend
```

Check running services:

```bash
docker compose ps
```

Backend health check:

```bash
curl http://localhost:8000/health
```

## What To Commit

For deployment-ready commits in this repo, prefer staging only runtime files.

Usually safe to commit:

- `backend/**`
- `frontend/**`
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `docker-compose.ai.yml`
- `docker-compose.chat.yml`
- `docker-compose.agent.yml`
- `nginx.conf`
- `.env.example`
- `README.md`
- `ai-service/**` and `ai-agent-service/**` when those services are part of the intended deploy

Avoid pushing local-only or non-runtime workspace content:

- `.env`
- `cube/`
- `TEMP_ACCESS_ISSUES.md`
- `.pytest_cache/`
- `.claude/`
- local notes
- scratch files
- ad-hoc debug scripts
- temporary test files that are not meant to stay in the runtime repo

## Current Commit Scope For This Working Tree

If you want to push the current runtime changes, the relevant tracked files are:

- `.env.example`
- `README.md`
- `backend/app/core/config.py`
- `backend/app/services/live_query_service.py`
- `frontend/src/app/(main)/datasets/[id]/page.tsx`
- `frontend/src/app/(main)/datasources/[id]/page.tsx`
- `frontend/src/components/datasets/DatasetTableGrid.tsx`
- `frontend/src/components/datasources/SyncSettingsTab.tsx`
- `frontend/src/hooks/use-datasets.ts`
- `frontend/src/hooks/use-datasources.ts`
- `frontend/src/lib/api-client.ts`

Files currently present in the workspace but not recommended for this push:

- `cube/`
- `TEMP_ACCESS_ISSUES.md`

## Suggested Commit Message

```text
feat: improve live BigQuery preview and smooth dataset navigation
```

## License

Proprietary. Contact the maintainers for licensing questions.
