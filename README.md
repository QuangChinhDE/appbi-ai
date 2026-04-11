<p align="center">
  <h1 align="center">AppBI</h1>
  <p align="center">
    <strong>Open-core, self-hosted Business Intelligence platform with AI superpowers.</strong>
  </p>
  <p align="center">
    Connect your databases &middot; Model datasets &middot; Explore data &middot; Build dashboards &middot; Ask AI
  </p>
</p>

---

## Why AppBI?

Most BI tools force you to choose: either a cloud-hosted solution that locks in your data, or a self-hosted tool that takes weeks to set up. AppBI gives you both — a production-ready BI platform you can deploy in **under 5 minutes** with `docker compose`, while keeping 100% of your data under your control.

| Pain Point | How AppBI Solves It |
|---|---|
| **Data lives in many places** | Connect PostgreSQL, MySQL, BigQuery, Google Sheets, or upload CSV/Excel — all in one platform |
| **Non-technical users can't access data** | Drag-and-drop dashboard builder, 12+ chart types, no SQL required for end users |
| **AI hype but no real BI integration** | Built-in AI Chat (ask questions in natural language) and AI Agent (auto-generate reports) |
| **Permissions are an afterthought** | Module-level + resource-level permissions out of the box, public/embed sharing with password protection |
| **Complex deployment** | Single `docker compose up` — frontend, backend, database, AI services all configured |

---

## Key Features

### Data Connectivity

- **PostgreSQL** and **MySQL** — connect any relational database
- **Google BigQuery** — optimized live-query mode with smart partition detection and configurable scan limits (default 60 GB)
- **Google Sheets** — use a shared service account or per-user Google OAuth
- **Manual tables** — upload CSV or Excel files directly

### Dataset Modeling

- Build datasets from physical tables, SQL queries, or calculated tables
- **Power Query-style transformation pipeline**: select, rename, cast, filter, deduplicate, join, aggregate, regex replace, and more
- Calendar dimension tables with timezone support
- Table relationships and foreign key management
- Schema auto-detection and column type inference

### Data Exploration

- **12+ chart types**: Bar, Line, Area, Pie, Scatter, KPI, Time Series, Table, Horizontal Bar, Stacked Bar, Grouped Bar, Bar-Line combo
- Interactive chart configuration with real-time preview
- Conditional formatting and color heatmaps for tables
- Summary rows (SUM, AVG, COUNT, MIN, MAX, COUNT DISTINCT)
- Export to Excel (`.xlsx`)

### Dashboard Builder

- Drag-and-drop grid layout powered by `react-grid-layout`
- Multi-page dashboards with tab navigation
- Cross-chart filtering and dashboard-level parameters
- Clone and rearrange charts across dashboards

### Sharing & Embedding

- **Public links** — share dashboards with anyone via a password-protected URL
- **Embed mode** — `<iframe>`-embeddable dashboards with proper CSP headers
- **Resource sharing** — grant view/edit/full access per user or to the whole team

### AI-Powered Analytics (Optional)

- **AI Chat** — ask questions about your data in natural language; the AI writes and executes SQL, returns charts and tables in real-time via WebSocket streaming
- **AI Agent Reports** — multi-phase report generator (enrich, plan, build, narrate) with domain templates for Finance, HR, Sales, Marketing, Operations, and Customer Service
- **Smart metadata** — auto-generated column descriptions, semantic tagging, and vector-based table search (pgvector)
- **Anomaly detection** — scheduled daily analysis to flag outliers in your data
- **Flexible LLM routing** — works with any model via OpenRouter (GPT-4o, Claude, Gemini, etc.) with up to 5 API keys and automatic fallback

### Access Control

- **Module-level permissions**: `none` | `view` | `edit` | `full` across 7 modules (Data Sources, Datasets, Charts, Dashboards, AI Chat, AI Agent, Settings)
- **Resource-level sharing**: owner-based ownership with granular share permissions
- **Authentication**: email/password, Google OAuth 2.0, or both simultaneously
- **Security**: JWT with refresh tokens, encrypted credentials at rest (Fernet), rate limiting, token revocation, audit logging

### Internationalization

- English and Vietnamese built-in (easily extensible)
- Browser language auto-detection with user preference override

---

## Architecture

```
                          ┌─────────────┐
                          │   nginx     │  SSL termination, reverse proxy
                          │  (port 80/  │  security headers, IP whitelist
                          │   443)      │
                          └──────┬──────┘
                                 │
          ┌──────────────┬───────┴────────┬──────────────┐
          │              │                │              │
   ┌──────▼──────┐ ┌────▼─────┐  ┌───────▼──────┐ ┌────▼─────────┐
   │  Frontend   │ │ Backend  │  │  AI Chat     │ │  AI Agent    │
   │  Next.js 14 │ │ FastAPI  │  │  Service     │ │  Service     │
   │  port 3000  │ │ port 8000│  │  port 8001   │ │  port 8002   │
   └──────┬──────┘ └────┬─────┘  └───────┬──────┘ └────┬─────────┘
          │              │                │              │
          │         ┌────▼─────┐          │              │
          │         │PostgreSQL│◄─────────┘              │
          │         │16+pgvec. │◄─────────────────────────┘
          │         │port 5432 │
          │         └──────────┘
          │
          └──► Your Data Sources (PostgreSQL, MySQL, BigQuery, Sheets)
```

| Service | Stack | Role |
|---|---|---|
| **Frontend** | Next.js 14 (App Router), TypeScript, Tailwind CSS, Radix UI, Recharts, TanStack Query | UI, dashboards, chart builder, AI chat interface |
| **Backend** | FastAPI, SQLAlchemy 2.0, Alembic, DuckDB, PyArrow, SQLGlot | REST API, data connectors, query engine, permissions, auth |
| **Database** | PostgreSQL 16 + pgvector | Metadata store, vector embeddings, session storage |
| **AI Chat** | FastAPI, WebSocket, OpenAI/Anthropic SDKs | Natural language to SQL, conversational analytics |
| **AI Agent** | FastAPI, streaming NDJSON | Multi-phase report generation with domain templates |

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (v2+)

### 1. Clone and configure

```bash
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai

# Password login preset (default)
cp .env.example .env

# — OR — Google login preset
# cp .env.google.example .env
```

Open `.env` and update the required values:

```bash
DB_PASSWORD=<your-database-password>
SECRET_KEY=<run: openssl rand -hex 32>
DATASOURCE_ENCRYPTION_KEY=<run: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=<your-admin-password>
```

### 2. Start

```bash
# Production stack (frontend + backend + database)
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) and log in with your admin credentials.

### 3. (Optional) Enable AI services

```bash
# Add both AI Chat and AI Agent
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build

# Or add only one
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build    # Chat only
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build   # Agent only
```

> AI services require at least one OpenRouter API key in `.env`. Get one at [openrouter.ai/keys](https://openrouter.ai/keys).

### 4. (Optional) Demo data

Set `SEED_DEMO_DATA=true` in `.env` before the first boot to auto-load a Football/FIFA demo dataset with sample charts and dashboards.

---

## Development

```bash
# Hot-reload dev stack (mounts source code, enables live reload)
docker compose -f docker-compose.dev.yml up -d --build

# With AI services in dev mode
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Frontend | http://localhost:3000 | Next.js hot reload |
| Backend | http://localhost:8000 | Uvicorn auto-reload |
| Database | localhost:5432 | Direct access for debugging |
| API docs | http://localhost:8000/docs | FastAPI Swagger UI |

### Useful commands

```bash
docker compose ps                                           # Check running services
docker compose -f docker-compose.dev.yml up -d --build backend  # Rebuild backend only
docker compose logs -f backend                              # Tail backend logs
curl http://localhost:8000/health                            # Backend health check
```

---

## Production Deployment

### Domain deployment with nginx + SSL

```bash
# 1. Install nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# 2. Copy and edit the included nginx config
sudo cp nginx.conf /etc/nginx/nginx.conf
# Edit server_name to your domain

# 3. Test and reload
sudo nginx -t && sudo systemctl reload nginx

# 4. Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

Update `.env` for production:

```bash
CORS_ORIGINS=https://your-domain.com
COOKIE_SECURE=true
```

The included `nginx.conf` provides:

- HTTP to HTTPS redirect
- TLS 1.2/1.3 with modern cipher suites
- Security headers (HSTS, CSP, X-Frame-Options, XSS protection)
- Gzip compression
- Static asset caching (1 year for immutable assets)
- Separate routing for `/api/v1`, `/chat`, `/agent`, and `/embed`
- Configurable IP whitelist

---

## Google Authentication Setup

### Google Sign-In

1. Create a Web OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add your frontend origin to authorized JavaScript origins
3. Set in `.env`:
   ```bash
   AUTH_GOOGLE_ENABLED=true
   AUTH_GOOGLE_CLIENT_ID=<your-client-id>
   NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true
   NEXT_PUBLIC_GOOGLE_CLIENT_ID=<your-client-id>
   ```

### Per-User Google Data Access (BigQuery / Sheets)

For users to connect BigQuery or Google Sheets with their own Google account:

1. Set `AUTH_GOOGLE_CLIENT_SECRET` and `AUTH_GOOGLE_DATA_REDIRECT_URI` in `.env`
2. Add the callback URI in Google Cloud Console:
   - Local: `http://localhost:3000/api/v1/auth/google/data-access/callback`
   - Domain: `https://your-domain.com/api/v1/auth/google/data-access/callback`
3. In the datasource form, choose "Use my Google account"

> The service-account flow still works alongside per-user OAuth — you can mix both in the same deployment.

---

## Configuration Reference

All configuration is in a single `.env` file shared by all services.

<details>
<summary><strong>Click to expand full variable reference</strong></summary>

| Category | Variable | Required | Description |
|---|---|---|---|
| **Database** | `DB_USER` | Yes | PostgreSQL username |
| | `DB_PASSWORD` | Yes | PostgreSQL password |
| | `DB_NAME` | Yes | PostgreSQL database name |
| **Security** | `SECRET_KEY` | Yes | JWT signing secret (shared by all services) |
| | `DATASOURCE_ENCRYPTION_KEY` | Yes | Fernet key for credential encryption |
| | `COOKIE_SECURE` | No | `true` for HTTPS, `false` for local HTTP |
| **Admin** | `ADMIN_EMAIL` | Yes | Bootstrap admin email |
| | `ADMIN_PASSWORD` | Yes | Bootstrap admin password |
| **Auth** | `AUTH_PASSWORD_LOGIN_ENABLED` | No | Enable email/password login (default: `true`) |
| | `AUTH_GOOGLE_ENABLED` | No | Enable Google OAuth (default: `false`) |
| | `AUTH_GOOGLE_CLIENT_ID` | If Google | Google OAuth Web client ID |
| | `AUTH_GOOGLE_CLIENT_SECRET` | If data access | Google OAuth client secret |
| | `AUTH_GOOGLE_AUTO_CREATE_USERS` | No | Auto-create users on first Google sign-in |
| **URLs** | `CORS_ORIGINS` | No | Comma-separated allowed origins |
| | `NEXT_PUBLIC_API_URL` | No | API base path (default: `/api/v1`) |
| **Data** | `ENABLE_DATASOURCE_SYNC` | No | Enable sync mode (default: `false`, live-query) |
| | `BQ_MAX_BYTES_SCANNED` | No | BigQuery scan limit in bytes (default: 60 GB) |
| | `SEED_DEMO_DATA` | No | Load demo data on first boot |
| **AI** | `OPENROUTER_API_KEY` | For AI | Primary OpenRouter API key |
| | `OPENROUTER_API_KEY_1..5` | No | Fallback keys (tried in order on quota errors) |
| | `LLM_MODEL` | No | Default LLM model (default: `openai/gpt-4o-mini`) |
| | `AI_CHAT_MODEL` | No | Override model for AI Chat |
| | `AI_AGENT_MODEL` | No | Override model for AI Agent |
| **GCP** | `GCP_SERVICE_ACCOUNT_EMAIL` | No | Shared GCP service account email |
| | `GCP_SERVICE_ACCOUNT_JSON` | No | Shared GCP service account credentials |
| **Ports** | `FRONTEND_PORT` | No | Frontend port (default: `3000`) |
| | `BACKEND_PORT` | No | Backend port (default: `8000`) |
| | `AI_CHAT_PORT` | No | AI Chat port (default: `8001`) |
| | `AI_AGENT_PORT` | No | AI Agent port (default: `8002`) |

</details>

---

## Runtime Modes

### Live-query-first (default)

Queries are executed directly against your data sources in real-time. No data is copied into AppBI — your dashboards always show the latest data.

```bash
ENABLE_DATASOURCE_SYNC=false
```

### Sync-enabled mode

Datasource sync features become available and dataset tables can use locally synced artifacts for faster queries on large datasets.

```bash
ENABLE_DATASOURCE_SYNC=true
```

### BigQuery optimizations

- Smart partition column detection from table metadata
- Automatic partition window widening for preview (starts from today, expands backwards until page is filled)
- Configurable scan cap via `BQ_MAX_BYTES_SCANNED` (default: 60 GB)

---

## Project Structure

```
appbi-ai/
├── frontend/               # Next.js 14 UI (TypeScript, Tailwind, Radix UI)
│   └── src/
│       ├── app/            # App Router pages and API routes
│       ├── components/     # React components (charts, dashboards, AI, etc.)
│       ├── hooks/          # Custom React hooks
│       ├── lib/            # API client, utilities, auth config
│       ├── i18n/           # Internationalization (en, vi)
│       └── types/          # TypeScript type definitions
│
├── backend/                # FastAPI REST API (Python 3.11)
│   └── app/
│       ├── api/            # Endpoint handlers
│       ├── core/           # Config, database, auth, permissions, crypto
│       ├── models/         # SQLAlchemy ORM models
│       ├── schemas/        # Pydantic request/response schemas
│       └── services/       # Business logic (20+ service modules)
│
├── ai-service/             # AI Chat microservice (WebSocket streaming)
├── ai-agent-service/       # AI Agent microservice (NDJSON streaming)
│
├── docker-compose.yml      # Production base stack
├── docker-compose.dev.yml  # Development with hot reload
├── docker-compose.ai.yml   # Both AI services overlay
├── docker-compose.chat.yml # AI Chat only overlay
├── docker-compose.agent.yml# AI Agent only overlay
├── nginx.conf              # Production reverse proxy config
├── .env.example            # Password login config template
└── .env.google.example     # Google login config template
```

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | Next.js 14, React 18, TypeScript, Tailwind CSS, Radix UI, Recharts, TanStack React Query, Axios |
| **Backend** | Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, DuckDB, PyArrow, SQLGlot |
| **Database** | PostgreSQL 16, pgvector |
| **AI** | OpenRouter (GPT-4o, Claude, Gemini), OpenAI SDK, Anthropic SDK, vector embeddings |
| **Infrastructure** | Docker, Docker Compose, nginx, Let's Encrypt |
| **Security** | JWT (HS256), Fernet encryption, bcrypt, rate limiting (slowapi), CSP headers |

---

## License

Proprietary. Contact the maintainers for licensing questions.
