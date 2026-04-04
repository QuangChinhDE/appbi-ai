# AppBI — Self-Hosted Business Intelligence Platform

**AppBI** is a fully self-hosted BI platform for connecting data sources, building dataset models, creating interactive charts and dashboards, and running AI-assisted analysis flows. Deploy the full stack in minutes with a single `docker compose up` command.

---

## Features

### Core BI
- **Data Sources** — Connect PostgreSQL, MySQL, BigQuery, Google Sheets, or upload CSV/Excel files
- **Dataset Modeling** — Visual ERD canvas with drag-and-drop table cards, relationship lines (1:1, 1:N, N:1, N:N), auto-detected FK joins, and full manual add/edit/delete of relationships
- **Semantic Layer** — Auto-generated dimensions and measures per table; supports custom SQL and hidden fields
- **Explore** — Interactive chart builder with aggregation push-down to DuckDB, smart X-axis scroll, and DD/MM/YYYY date filtering
- **Dashboards** — Drag-and-drop grid, global dimension filters, per-chart HAVING filters
- **Public Links** — Password-protected dashboard sharing, multi-link per dashboard, iframe embed via `/embed/{token}`
- **Resource Sharing** — Share dashboards, charts, datasets, datasources, and chat sessions with specific users
- **Permissions** — Module permission matrix (`none / view / edit / full`) per user per module

### Chart Types
`BAR` · `STACKED_BAR` · `GROUPED_BAR` · `LINE` · `AREA` · `TIME_SERIES` · `PIE` · `SCATTER` · `TABLE` · `KPI`

### AI Capabilities
- **AI Chat** — Conversational data exploration with tool-calling, streaming responses, and persistent session history
- **AI Agent** — Structured brief → enriched plan → dashboard build in one guided wizard
- **AI Description** — Automatic description generation for dataset tables and charts
- **Anomaly Detection** — Proactive metric monitoring with z-score alerting
- **AI Feedback** — Flag incorrect AI responses for correction tracking

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    nginx (port 443 / 80)                     │
│  /        → frontend:3000     /api/v1/* → backend:8000       │
│  /chat/*  → ai-chat:8001      /agent/* → ai-agent:8002       │
└──────────────────────────┬──────────────────────────────────┘
                           │  internal Docker network (appbi-net)
        ┌──────────────────┼──────────────────────┐
        │                  │                      │
   ┌────▼────┐        ┌────▼────┐           ┌─────▼──────┐
   │frontend │        │backend  │           │     db      │
   │ :3000   │◄───────│ :8000   │◄──────────│ PostgreSQL  │
   └─────────┘        └────┬────┘           │ + pgvector  │
                           │                └────────────┘
             ┌─────────────┴─────────────┐
             │                           │
      ┌──────▼──────┐             ┌──────▼──────┐
      │ ai-chat-svc │             │ai-agent-svc │
      │   :8001     │             │   :8002     │
      └─────────────┘             └─────────────┘
```

| Service       | Internal port | Description                        |
|---------------|---------------|------------------------------------|
| frontend      | 3000          | Next.js 14 UI                      |
| backend       | 8000          | FastAPI — BI API, auth, sync, query |
| db            | 5432          | PostgreSQL 16 + pgvector            |
| ai-chat-svc   | 8001          | Streaming AI chat _(optional)_      |
| ai-agent-svc  | 8002          | AI report agent _(optional)_        |

All ports bind to `127.0.0.1` by default. In production, nginx routes external traffic.

---

## Quick Start

### Prerequisites
- Docker ≥ 24 and Docker Compose v2
- A machine with at least 2 GB RAM

### 1. Clone & configure

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
cp .env.example .env
```

Edit `.env` and fill in every `CHANGE_ME` value:

| Variable | Description |
|---|---|
| `DB_PASSWORD` | PostgreSQL password |
| `SECRET_KEY` | JWT signing key — run `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Fernet key for credentials — run `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `NEXTAUTH_SECRET` | NextAuth secret — run `openssl rand -hex 32` |
| `NEXT_PUBLIC_APP_URL` | Public URL of the app (e.g. `https://yourbi.example.com`) |

### 2. Start the core stack

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:3000** (or your configured domain).

Default admin credentials are set by `FIRST_ADMIN_EMAIL` / `FIRST_ADMIN_PASSWORD` in `.env`.

### 3. Optional AI services

```bash
# Both AI Chat + AI Agent
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build

# Chat only
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build

# Agent only
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

AI services require an `OPENAI_API_KEY` (or compatible endpoint) in `.env`.

### 4. Development (hot-reload)

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS, Radix UI, TanStack Query v5 |
| Backend | Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, APScheduler |
| Database | PostgreSQL 16 + pgvector |
| Query Engine | DuckDB (in-process analytics layer) |
| AI Layer | OpenAI API (GPT-4o / compatible), LangGraph, streaming SSE |
| Infrastructure | Docker Compose, nginx |

---

## Project Structure

```
appbi-ai/
├── backend/                  # FastAPI application
│   ├── app/
│   │   ├── api/              # REST endpoints (auth, datasets, charts, dashboards…)
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── schemas/          # Pydantic request/response schemas
│   │   └── services/         # Business logic (sync, query, ML, AI pipeline…)
│   ├── alembic/              # Database migrations
│   └── Dockerfile
├── frontend/                 # Next.js 14 application
│   └── src/
│       ├── app/              # App Router pages
│       ├── components/       # UI components (canvas, charts, dialogs…)
│       └── hooks/            # React Query data-fetching hooks
├── ai-service/               # Streaming AI chat service (optional)
├── ai-agent-service/         # AI report agent service (optional)
├── docker-compose.yml        # Core stack (db + backend + frontend)
├── docker-compose.ai.yml     # Overlay: both AI services
├── docker-compose.chat.yml   # Overlay: AI chat only
├── docker-compose.agent.yml  # Overlay: AI agent only
├── docker-compose.dev.yml    # Development (hot-reload) variant
├── nginx.conf                # Reverse proxy config
└── .env.example              # Environment variable template
```

---

## Environment Variables

Copy `.env.example` → `.env` and fill in all `CHANGE_ME` values before starting.

The `.env` file is **never committed** to version control. `.env.example` documents every variable with descriptions and safe defaults.

Key sections:
1. **Database** — `DB_USER`, `DB_PASSWORD`, `DB_NAME`
2. **Security** — `SECRET_KEY`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`
3. **Frontend** — `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`
4. **AI** — `OPENAI_API_KEY`, model configs, token limits
5. **Admin seed** — `FIRST_ADMIN_EMAIL`, `FIRST_ADMIN_PASSWORD`

---

## Database Migrations

Migrations run automatically on backend startup via Alembic.

To run manually:
```bash
docker compose exec backend alembic upgrade head
```

---

## Contributing

1. Fork the repo and create a feature branch
2. Make changes; ensure the TypeScript build passes: `cd frontend && ./node_modules/.bin/tsc --noEmit`
3. Submit a pull request with a clear description

---

## License

Proprietary — All rights reserved. Contact the maintainers for licensing inquiries.
