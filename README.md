# AppBI

AppBI is a self-hosted business intelligence platform for connecting data sources, modeling workspace tables, building charts and dashboards, and running AI-assisted analysis flows.

The platform runs as a Docker-first stack:
- `db` — PostgreSQL metadata store (pgvector)
- `backend` — FastAPI: BI API, auth, permissions, sync engine, query execution, AI Description pipeline
- `frontend` — Next.js: dashboards, explore, workspaces, permissions, AI UI
- `ai-chat-service` _(optional)_ — reactive AI assistant, session-based, streaming
- `ai-agent-service` _(optional)_ — proactive AI report builder, plan-first flow

All services communicate over an internal Docker bridge network. In production, `nginx` sits in front and routes public traffic.

---

## Key Capabilities

### Core BI

- Connect and manage data sources (PostgreSQL, MySQL, BigQuery, Google Sheets, CSV/Excel file upload)
- Streaming sync of source data into the AppBI DuckDB data layer
- Workspace tables — analysis-ready views backed by physical tables or custom SQL queries
- Explore — interactive chart builder with aggregation push-down to DuckDB
- Dashboards — drag-and-drop grid layout assembled from saved Explore charts
- PowerBI-style dashboard filters (global dimension filters + per-chart HAVING filters)
- Dashboard public links — password-protected, multi-link per dashboard
- Dashboard embed — embed any public link in an iframe via `/embed/{token}`
- Resource-level sharing (dashboards, charts, workspaces, datasets, datasources, chat sessions)
- Module permission matrix: `none / view / edit / full` per user per module

### Chart Types

`BAR` · `STACKED_BAR` · `GROUPED_BAR` · `LINE` · `AREA` · `TIME_SERIES` · `PIE` · `SCATTER` · `TABLE` · `KPI`

### AI Capabilities

- **AI Chat** — conversational data exploration, tool-calling, saved sessions with persistent message history
- **AI Agent** — structured brief → enriched plan → dashboard build in one guided wizard
- **AI Description** — backend-driven description generation for workspace tables and charts (states: `queued` / `processing` / `succeeded` / `failed` / `stale`)
- **Anomaly Detection** — proactive monitoring of workspace-table metrics with z-score alerting
- **AI Feedback** — users can flag incorrect AI responses (wrong table, wrong chart, unclear) for correction tracking

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            nginx (port 443/80)                       │
│  /          → frontend:3000   /api/v1/* → backend:8000               │
│  /chat/*   → ai-chat:8001    /agent/*  → ai-agent:8002               │
└────────────────────────────┬────────────────────────────────────────┘
                             │ internal Docker network (appbi-net)
         ┌───────────────────┼──────────────────────────────┐
         │                   │                              │
    ┌────▼────┐         ┌────▼────┐                  ┌──────▼──────┐
    │frontend │         │backend  │                  │    db        │
    │ :3000   │◄────────│ :8000   │◄─────────────────│ PostgreSQL   │
    └─────────┘         └────┬────┘                  │ + pgvector   │
                             │                       └─────────────┘
              ┌──────────────┴──────────────┐
              │                             │
       ┌──────▼──────┐               ┌──────▼──────┐
       │ai-chat-svc  │               │ai-agent-svc  │
       │   :8001     │               │   :8002      │
       └─────────────┘               └─────────────┘
```

Default host ports:

| Service       | Host port |
|---------------|-----------|
| Frontend      | `3000`    |
| Backend       | `8000`    |
| AI Chat       | `8001`    |
| AI Agent      | `8002`    |

All ports are bound to `127.0.0.1` (not publicly exposed). Production traffic goes through nginx.

---

## Data Sources

| Type            | Notes                                                                |
|-----------------|----------------------------------------------------------------------|
| PostgreSQL      | Connection string with optional schema selection                     |
| MySQL           | Connection string                                                    |
| BigQuery        | Service account JSON or platform GCP account                        |
| Google Sheets   | Spreadsheet URL or ID; service account or platform GCP account      |
| CSV / Excel     | File upload up to 250 MB (`.csv`, `.xlsx`, `.xls`); parsed server-side |

**Platform GCP Service Account**: when `GCP_SERVICE_ACCOUNT_EMAIL` and `GCP_SERVICE_ACCOUNT_JSON` are set in `.env`, users connecting Google Sheets or BigQuery only need to share their resource with that email — no per-user key upload required.

---

## Sync Engine

- Streaming row-by-row ingestion — safe for large datasets
- DuckDB resource guards and chart rendering caps prevent memory spikes
- Four sync strategies per table: `full_refresh`, `incremental`, `append_only`, `manual`
- Scheduled syncs with configurable frequency
- Sync status tracked per job: `pending`, `running`, `success`, `failed`

---

## Core Concepts

**Data Sources** — connection definitions for external databases or file imports.

**Sync** — imports source tables into the AppBI DuckDB data layer. Data is stored locally and queried via DuckDB for fast analytical performance.

**Workspace Tables** — analysis-ready tables inside a named workspace. Can be backed by a synced physical table or a custom SQL query. Support column transformations and carry optional AI Description metadata.

**Charts** — saved visualizations built in Explore from workspace tables. Carry AI Description metadata and can be added to multiple dashboards.

**Dashboards** — grid layouts assembled from saved charts. Support global dimension filters, per-chart HAVING filters, and public/embed sharing.

**Public Links** — password-protected shareable links to dashboards. Multiple links per dashboard are supported. Embed them in any iframe.

**Anomaly Monitoring** — define metric monitors on workspace tables (column, aggregation, time field, z-score threshold). Alerts fire when the metric deviates beyond the threshold.

---

## AI Modules

### AI Chat

Use AI Chat when you want to:
- ask questions about data in natural language
- inspect available workspace tables
- summarize patterns or generate a single chart mid-conversation
- revisit a saved conversation later

Characteristics:
- reactive, session-based
- tool-calling against the backend API
- WebSocket streaming + HTTP NDJSON streaming
- full conversation history persisted in the backend
- independent Docker lifecycle from AI Agent

### AI Agent

Use AI Agent when you want to:
- describe a business goal in a structured brief
- select specific workspace tables as the data scope
- review and edit an AI-generated dashboard plan before building
- automatically create multiple charts and a complete dashboard

Characteristics:
- proactive, brief-driven, plan-first flow
- LLM brief enrichment adds domain inference, KPIs, questions, table relationships, and narrative arc
- section-based section composition across multiple selected tables
- runs independently from AI Chat
- v1 does not perform cross-table SQL joins; multi-table means section-based composition

**AI Agent wizard steps** (`/ai-reports/new`):

1. **Select tables** — choose one or more workspace tables. Table descriptions and column counts are shown inline.
2. **Write brief** — fill in 6 fields: goal, audience, timeframe, comparison period, detail level, and notes. The brief is enriched by an LLM before planning.
3. **Review plan** — AI generates a dashboard plan with named sections and chart specs. Toggle charts on/off, edit titles, inspect technical details, and review quality-gate warnings.
4. **Build and view** — AI creates charts, assembles the dashboard, generates narrative insights, and displays results inline: executive summary, top findings, risks, priority actions, section-by-section analysis, and per-chart evidence.

**Planning pipeline** (8 ordered steps):
1. Rule-based brief parsing (baseline structure)
2. LLM brief enrichment (domain, KPIs, questions, relationships, narrative arc)
3. Table profiling (column types, metrics, dimensions, time fields)
4. Dataset fit scoring (per question, not global)
5. Quality gate (blockers, warnings, null risk, data freshness)
6. Analysis plan (question-to-table mapping)
7. LLM dashboard strategy (sections with business-intent titles, chart hypotheses)
8. Quality review and scoring

Key AI Agent features:
- saved report specs (`draft`, `ready`, `running`, `archived`) with full run history
- inline result viewing after build — no redirect required
- Vietnamese and English language support
- streaming progress during both planning and build phases
- per-phase LLM model routing via env vars

### AI Description

Backend-driven description generation for workspace tables and charts:
- runs inside the backend container — does not require an AI service container
- generation state tracked: `queued` → `processing` → `succeeded` / `failed` / `stale`
- auto-tagging service identifies business metrics and dimensions from column names
- the UI surfaces state and supports manual regeneration

### Anomaly Detection

- define `MonitoredMetric` records on workspace table columns
- configure aggregation, optional time and dimension columns, check frequency, and z-score threshold
- `AnomalyAlert` records are created when metric values deviate beyond the threshold
- manual scans can be triggered via API; scheduled scans run automatically

### AI Feedback

- authenticated users can submit correction feedback on any AI interaction
- feedback types: `wrong_table`, `wrong_chart`, `unclear`, `other`
- optional: specify the correct resource (chart or workspace table)
- admin stats endpoint for tracking feedback volume and patterns

---

## Docker Quick Start

### Option A — One-step setup on Ubuntu

```bash
./install-docker-and-run.sh
```

This script installs Docker Engine if missing, adds the current user to the `docker` group, creates `.env` from `.env.example`, and starts the base stack.

### Option B — Manual setup

**1. Prepare environment**

```bash
cp .env.example .env
# Fill in all CHANGE_ME values in .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

**2. Choose the stack mode**

Base BI stack only:

```bash
docker compose up -d --build
```

Base stack + both AI services:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Base stack + AI Chat only:

```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

Base stack + AI Agent only:

```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

**3. Open the application**

- Frontend: `http://localhost:3000`
- Backend API docs: `http://localhost:8000/api/v1/docs`

### Development stack (hot reload)

```bash
# Base dev stack
docker compose -f docker-compose.dev.yml up -d --build

# Dev + both AI services
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build

# Dev + AI Chat only
docker compose -f docker-compose.dev.yml -f docker-compose.chat.yml up -d --build

# Dev + AI Agent only
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

---

## Environment Variables

All variables are defined in a single `.env` file. See `.env.example` for the full annotated reference.

### Required for all stacks

| Variable | Description |
|----------|-------------|
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL credentials |
| `SECRET_KEY` | JWT signing key — shared by all services. Generate with `openssl rand -hex 32` |
| `COOKIE_SECURE` | `true` in production (HTTPS); `false` for local HTTP dev |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Admin account seeded on first boot |
| `DATASOURCE_ENCRYPTION_KEY` | Fernet key for encrypting datasource credentials at rest. Generate with `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |

### Ports

| Variable | Default | Description |
|----------|---------|-------------|
| `FRONTEND_PORT` | `3000` | Host port for the frontend |
| `BACKEND_PORT` | `8000` | Host port for the backend |
| `AI_CHAT_PORT` | `8001` | Host port for AI Chat service |
| `AI_AGENT_PORT` | `8002` | Host port for AI Agent service |

### Domain / URLs

| Variable | Notes |
|----------|-------|
| `NEXT_PUBLIC_API_URL` | Baked at build time. Default `/api/v1` works on any domain |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `NEXT_PUBLIC_AI_CHAT_WS_URL` / `NEXT_PUBLIC_AI_CHAT_HTTP_URL` / `NEXT_PUBLIC_AI_AGENT_HTTP_URL` | Only needed if AI services run on a different host from the frontend |

### OpenRouter API Keys

Keys are tried in order `OPENROUTER_API_KEY_1` → `2` → `3` → `4` → `5` → `OPENROUTER_API_KEY`. On quota/auth errors (401/402/403/429) the next key is tried automatically.

```env
OPENROUTER_API_KEY=
OPENROUTER_API_KEY_1=
OPENROUTER_API_KEY_2=
OPENROUTER_API_KEY_3=
OPENROUTER_API_KEY_4=
OPENROUTER_API_KEY_5=
```

### LLM Models

| Variable | Used by | Notes |
|----------|---------|-------|
| `LLM_MODEL` | all AI services | Default model, e.g. `openai/gpt-4o-mini` |
| `LLM_FALLBACK_CHAIN` | all AI services | Comma-separated fallback model chain |
| `AI_CHAT_MODEL` | ai-chat-service | Override for AI Chat (falls back to `LLM_MODEL`) |
| `AI_AGENT_MODEL` | ai-agent-service | Override for all Agent phases |
| `AI_AGENT_ENRICHMENT_MODEL` | ai-agent-service | Brief enrichment phase |
| `AI_AGENT_PLANNING_MODEL` | ai-agent-service | Dashboard strategy phase |
| `AI_AGENT_INSIGHT_MODEL` | ai-agent-service | Chart insight generation phase |
| `AI_AGENT_NARRATIVE_MODEL` | ai-agent-service | Executive summary narrative phase |
| `AI_DESCRIPTION_MODEL` | backend | Table/chart description generation |
| `OPENROUTER_EMBEDDING_MODEL` | backend | Embedding model for semantic search |

### AI Chat tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_SESSION_TTL_MINUTES` | `30` | Inactive session expiry |
| `AI_MAX_TOOL_CALLS` | `8` | Max tool calls per turn |
| `AI_WORKSPACE_TABLE_LIMIT` | `50` | Max workspace tables visible to chat |

### GCP Service Account (optional)

| Variable | Description |
|----------|-------------|
| `GCP_SERVICE_ACCOUNT_EMAIL` | Email of the platform GCP service account |
| `GCP_SERVICE_ACCOUNT_JSON` | Full JSON of the service account key |

When set, users connecting Google Sheets or BigQuery do not need to upload credentials — they only need to share their resource with the service account email.

### Demo data

Set `SEED_DEMO_DATA=true` on first boot to auto-load a Football/FIFA demo dataset. This creates admin/edit/viewer accounts, a datasource, workspaces, charts, and dashboards.

---

## Permissions

Module permission levels: `none` / `view` / `edit` / `full`

| Module | Available levels |
|--------|-----------------|
| `data_sources` | none, view, edit, full |
| `datasets` | none, view, edit, full |
| `workspaces` | none, view, edit, full |
| `explore_charts` | none, view, edit, full |
| `dashboards` | none, view, edit, full |
| `ai_chat` | none, view, edit, full |
| `ai_agent` | none, view, edit, full |
| `settings` | none, full |

**AI Chat** requires:
- `ai_chat >= view`
- object-level access to queried data

**AI Agent** requires:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level access to every selected workspace table

**Resource sharing** (view or edit):
- dashboards, charts, workspaces, datasets, datasources, chat sessions

Module permission alone is not sufficient — ownership and per-resource sharing are enforced on top.

---

## Domain Deployment (nginx + HTTPS)

A production-ready `nginx.conf` is included in the repo root. It handles:
- HTTP → HTTPS redirect
- TLSv1.2/1.3 only (TLS 1.0/1.1 disabled)
- URL routing: `/api/v1/*` → backend, `/chat/*` → AI Chat, `/agent/*` → AI Agent, everything else → frontend
- Cache headers: `no-store` for HTML, `immutable` for static assets
- Content Security Policy header
- Optional IP whitelist block (uncomment `allow x.x.x.x;` lines per permitted IP/CIDR)

```bash
# Setup steps
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp nginx.conf /etc/nginx/nginx.conf
# Edit server_name in nginx.conf to your domain
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

---

## First Workflow

Typical first-time flow:
1. Start the Docker stack.
2. Sign in with the admin account defined in `.env`.
3. Create a data source (DB connection or file upload).
4. Run a sync.
5. Create a workspace and add workspace tables.
6. Build charts in Explore.
7. Create a dashboard and add charts.
8. Optionally: enable AI Agent to generate charts and a dashboard automatically.
9. Share dashboards or charts with team members.

---

## Project Structure

```text
backend/                    FastAPI backend
  app/
    api/                    REST API routes (datasources, workspaces, charts,
                            dashboards, shares, public, anomaly, agent-report-specs …)
    models/                 SQLAlchemy models
    services/               Business logic (sync, DuckDB, descriptions, anomaly …)
    core/                   Config, auth, dependencies, logging

frontend/                   Next.js frontend
  src/app/(main)/           Authenticated pages
    datasources/            Data source management
    dataset-workspaces/     Workspace & table management
    explore/                Interactive chart builder
    charts/                 Saved charts list
    dashboards/             Dashboard grid + filters
    ai-reports/             AI Agent wizard (4-step)
    chat/                   AI Chat sessions
    users/ permissions/     Admin pages
  src/app/embed/            Public dashboard embed page

ai-service/                 AI Chat service
  app/
    routers/chat.py         Session and streaming endpoints
    agents/orchestrator.py  Tool-calling agent loop
    agents/tools.py         Backend API tools

ai-agent-service/           AI Agent service
  app/services/
    brief_parser.py         Rule-based brief parsing
    brief_enricher.py       LLM brief enrichment
    planner.py              Planning pipeline orchestration
    analysis_planner.py     Question-to-table mapping
    builder.py              Dashboard build orchestration
    insight_generator.py    Chart insight and narrative generation
    dashboard_composer.py   Dashboard blueprint composition
    llm_client.py           OpenRouter client with multi-key rotation + fallback

docs/                       Project documentation and guided API references
docker-compose.yml          Base BI stack
docker-compose.ai.yml       Both AI services overlay
docker-compose.chat.yml     AI Chat overlay only
docker-compose.agent.yml    AI Agent overlay only
docker-compose.dev.yml      Development stack with hot reload
nginx.conf                  Production nginx config (HTTPS + routing + CSP)
install-docker-and-run.sh   One-command Ubuntu setup script
```

---

## Recommended Documentation

- [docs/SETUP.md](./docs/SETUP.md) — environment setup guide
- [docs/DOCKER.md](./docs/DOCKER.md) — Docker operations reference
- [docs/API.md](./docs/API.md) — full REST API reference
- [docs/GUIDED.md](./docs/GUIDED.md) — end-to-end user onboarding guide
- [docs/AI_AGENT.md](./docs/AI_AGENT.md) — AI services architecture and contracts
- [docs/GUIDED_API_CHART.md](./docs/GUIDED_API_CHART.md) — chart API payload reference
- [docs/GUIDED_API_DASHBOARD.md](./docs/GUIDED_API_DASHBOARD.md) — dashboard API payload reference
- [docs/GUIDED_API_AI_AGENT_REPORT.md](./docs/GUIDED_API_AI_AGENT_REPORT.md) — AI Agent report spec API reference

---

## Notes

- `docker-compose.ai.yml` starts both AI services together. Use `chat.yml` or `agent.yml` to run them independently.
- The backend runs AI Description generation in-process — no AI service container is required for that feature.
- If only `ai-agent-service` is running, the `/chat` page loads but live chat is unavailable.
- If only `ai-chat-service` is running, AI Agent dashboard generation is unavailable.
- All LLM calls go through OpenRouter. Set at least one `OPENROUTER_API_KEY` in `.env`.
- Multiple OpenRouter keys can be set (`_1` through `_5`) for automatic rotation under quota pressure.
- Each AI Agent LLM phase (enrichment, planning, insight, narrative) can use a different model via phase-specific env vars.
- AI Report specs persist as `AgentReportSpec` records with full run history. Users can revisit, re-edit, and re-run any saved report.
- In production, backend and AI service ports are bound to `127.0.0.1` only — not reachable from the public internet without going through nginx.
