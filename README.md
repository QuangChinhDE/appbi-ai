# AppBI — Business Intelligence Dashboard

A self-hosted BI platform with an integrated AI chat agent. Connect data sources, build datasets with transformation pipelines, explore data without SQL, compose interactive dashboards — and ask data questions in natural language via the AI Chat interface.

Three-service architecture (Frontend / Backend / AI Service + PostgreSQL), deployed with Docker Compose.

---

## Features

| Module | Description |
|---|---|
| **Data Sources** | Connect to PostgreSQL, MySQL, BigQuery, Google Sheets, or import CSV/Excel (multi-sheet). **Test Connection** is enforced before saving. PostgreSQL supports `schema` (search_path) config. |
| **Datasets** | Create datasets from SQL queries on any data source. Automatic column type inference. Supports a visual **transformation pipeline** (add column, filter, group by, sort, limit, rename, cast, custom SQL, and more). |
| **Explore** | Point-and-click data exploration — choose X axis, metrics (SUM/AVG/COUNT/MIN/MAX), breakdown, filters, and parameters — no SQL required. 5 collapsible panels: Data · Visualization · Fields · Filters · Parameters. |
| **Charts** | Save Explore configurations as reusable charts. Supports Bar, Line, Area, Pie, Scatter, Grouped Bar, Stacked Bar, Table, KPI, and Time Series. |
| **Dashboards** | Compose multiple charts into a grid dashboard with drag-and-drop layout (react-grid-layout). **Global filter bar** (pre-aggregation, dimension fields). **Per-tile HAVING filter** (post-aggregation, metric fields). Inline tile rename. |
| **Dataset Workspaces** | Workspace environment combining multiple tables from one or more data sources. Add `js_formula` computed columns using Excel-style formulas (e.g. `IF([Points]>1800,"Elite","Other")`). Computed columns are highlighted in amber throughout the UI. |
| **AI Chat Agent** | Natural-language data Q&A. The agent autonomously calls `search_charts`, `run_chart`, `execute_sql`, and `query_table` tools, streams the response token-by-token, embeds live charts in the chat, and shows per-message quality metrics + thumbs feedback. Supports OpenAI, Anthropic, Gemini, and OpenRouter with a configurable fallback chain. |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router) · TypeScript · Tailwind CSS · Recharts · TanStack Query v5 · react-grid-layout · Sonner |
| **Backend** | FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · Python 3.10+ · DuckDB |
| **AI Service** | FastAPI · WebSocket streaming · LLM tool-calling (OpenAI / Anthropic / Gemini / OpenRouter) · in-memory session store |
| **Database** | PostgreSQL 16 (metadata: datasources, datasets, charts, dashboards) |
| **Infrastructure** | Docker · Docker Compose (2 compose files: BI stack + AI stack) |

---

## Running with Docker (recommended)

> Requires: [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine + Compose plugin.

### Setup — 3 commands, that's it

```bash
# 1. Clone
git clone https://github.com/bachbuiquang9/Dashboard-App.git
cd Dashboard-App

# 2. Configure (copy example .env, then edit — see notes below)
cp .env.docker.example .env

# 3. Start everything
docker compose up --build -d
```

**What happens automatically:**
- PostgreSQL starts and applies migrations (`alembic upgrade head`)
- `.data/` folder is created with all subdirs (`synced/`, `datasets/`, `workspaces/`)
- BI Backend, Frontend, and AI Chat Agent all start in the correct order
- No manual directory creation, no separate commands for AI

### Configure `.env`

Open `.env` and set the values you need:

```env
# Required for external data sources (Google Sheets, PostgreSQL, MySQL, BigQuery)
# Generate: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
DATASOURCE_ENCRYPTION_KEY=your-fernet-key-here

# Required for AI Chat — fill in for your LLM provider
OPENAI_API_KEY=sk-...         # OpenAI
# ANTHROPIC_API_KEY=...       # Anthropic Claude
# GEMINI_API_KEY=...          # Google Gemini

# Optional: change ports if 3000/8000/8001 are already in use
FRONTEND_PORT=3000
BACKEND_PORT=8000
AI_PORT=8001
```

> All other variables have sensible defaults. The full annotated example is in `.env.docker.example`.

### Access the app

| URL | Service |
|---|---|
| `http://localhost:3000` | Frontend UI |
| `http://localhost:3000/chat` | AI Chat interface |
| `http://localhost:8000/api/v1/docs` | BI Backend Swagger docs |
| `http://localhost:8001/docs` | AI Service Swagger docs |
| `http://localhost:8000/health` | BI Backend health check |
| `http://localhost:8001/health` | AI Service health check |

### Stop / restart

```bash
docker compose down              # stop all, keep data volumes
docker compose down -v           # stop all + delete ALL data (fresh start)
docker compose restart backend   # restart one service only
docker compose logs -f backend   # follow logs
```

---

## Demo Data — Football / FIFA

The repo ships with a seed script that loads a complete Football / FIFA demo dataset.

### Option A — via Docker (automatic on first boot)

Set `SEED_DEMO_DATA=true` in `.env` before running `docker compose up`:

```env
SEED_DEMO_DATA=true
```

The seed runs automatically on the first container start and is guarded by a flag file so it never runs twice.

### Option B — manual (any running instance)

```bash
# Backend must be running (Docker or local)
pip install requests openpyxl
python seed_demo.py
```

**What gets created:**
- **1 Data Source** — Manual (from `scope-foodball-demo.xlsx`)
- **6 Datasets** — FIFA Rankings, WC History, Top Scorers, Confederation Stats, WC vs Continental Titles, Country Performance
- **3 Dataset Workspaces** (9 tables total) — each with `js_formula` computed columns:
  - *FIFA World Rankings* — `Rank_Group`, `Conf_Power_Score`, `Points_Rating`
  - *World Cup & Continental Titles* — `Title_Dominance`, `Points_Per_WC`, `WC_vs_Continental`
  - *Top Scorers Analysis* — `Scorer_Tier`, `Goal_Era`
- **18 Charts** — Bar, Grouped Bar, Pie, KPI, Table, Line charts
- **3 Dashboards** with global filters:
  - *FIFA World Rankings Overview*
  - *World Cup History & Champions*
  - *World Cup Top Scorers — Golden Boot Analysis*

---

## Local Development

### Requirements

- Python 3.10+
- Node.js 18+
- PostgreSQL 14+

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # minimum: set DATABASE_URL
alembic upgrade head            # initialise DB schema
uvicorn app.main:app --reload --port 8000
```

Minimum `backend/.env`:
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/appbi

# Optional: encrypt datasource credentials (highly recommended)
# Generate: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
DATASOURCE_ENCRYPTION_KEY=your-fernet-key-here

# Storage path for Parquet + DuckDB (default: .data/ relative to project root)
DATA_DIR=.data
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1" > .env.local
echo "NEXT_PUBLIC_AI_WS_URL=ws://localhost:8001/chat/ws" >> .env.local
npm run dev
```

### AI Service

```bash
cd ai-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Variables are read from the root .env
uvicorn app.main:app --reload --port 8001
```

The AI service reads all config from the **root `.env`** file automatically (via `pydantic-settings`). No separate env file needed.

---

## Project Structure

```
Dashboard-App/
├── backend/                       # BI Backend — FastAPI + SQLAlchemy
│   ├── app/
│   │   ├── api/                   # Routers: datasources, datasets, charts, dashboards
│   │   ├── models/                # SQLAlchemy ORM models
│   │   ├── schemas/               # Pydantic v2 request/response schemas
│   │   └── services/              # Business logic, query engine, connector classes
│   ├── alembic/                   # Database migrations
│   ├── entrypoint.sh              # Wait for DB → alembic upgrade head → optional seed → uvicorn
│   ├── Dockerfile
│   └── requirements.txt
├── ai-service/                    # AI Chat Agent — separate FastAPI microservice
│   ├── app/
│   │   ├── agents/
│   │   │   ├── orchestrator.py    # LLM conversation loop, streaming, metrics emission
│   │   │   └── tools.py           # Tool schemas + execute() coroutines
│   │   ├── clients/
│   │   │   └── bi_client.py       # HTTP client calling BI Backend API
│   │   ├── routers/
│   │   │   └── chat.py            # WebSocket /chat/ws + REST /chat/stream + feedback API
│   │   ├── schemas/
│   │   │   └── chat.py            # All streaming event types + session models
│   │   ├── config.py              # pydantic-settings — reads root .env
│   │   └── main.py                # FastAPI app, health endpoint
│   └── requirements.txt
├── frontend/                      # Next.js 14 App Router frontend
│   ├── src/
│   │   ├── app/(main)/            # Page routes
│   │   │   ├── datasources/
│   │   │   ├── datasets/
│   │   │   ├── explore/
│   │   │   ├── dashboards/
│   │   │   ├── dataset-workspaces/
│   │   │   └── chat/              # AI Chat route
│   │   ├── components/
│   │   │   └── ai-chat/           # Chat UI components
│   │   │       ├── ChatPanel.tsx  # WebSocket state machine, event handler
│   │   │       ├── ChatMessage.tsx # Bubble + metrics bar + feedback buttons
│   │   │       ├── ChatInput.tsx
│   │   │       ├── ChatSessionList.tsx
│   │   │       ├── EmbeddedChart.tsx  # Live chart renderer inside chat bubble
│   │   │       ├── ThinkingIndicator.tsx
│   │   │       └── types.ts       # Shared TypeScript types
│   │   ├── hooks/                 # TanStack Query data hooks
│   │   └── lib/api/               # Axios API client
│   └── Dockerfile
├── docs/                          # Extended design & implementation docs
│   ├── AI_CHAT_AGENT_DESIGN.md    # Agent design, tool logic, decision flow
│   ├── ARCHITECTURE.md            # Full folder structure & component map
│   ├── API.md                     # REST API reference
│   ├── CHART_STORAGE_AND_REUSE.md # Chart caching strategy
│   ├── IMPLEMENTATION_NOTES.md    # Day-by-day implementation notes & known issues
│   ├── DOCKER.md                  # Docker configuration details
│   └── SETUP.md                   # Development setup guide
├── seed_demo.py                   # Demo data seed script (Football / FIFA)
├── scope-foodball-demo.xlsx       # Source data file for seed
├── docker-compose.yml             # BI stack (backend + frontend + db)
├── docker-compose.ai.yml          # AI service (overlays onto BI stack network)
├── docker-compose.dev.yml         # Development overrides
├── .env.docker.example            # Environment template — copy to .env
└── README.md
```

---

## Architecture

```
Browser
  │
  ├─► :3000  Frontend (Next.js)
  │       │  REST calls → /api/v1/*
  │       │  WebSocket  → ws://localhost:8001/chat/ws
  │       ▼
  │   :8000  BI Backend (FastAPI)          ─────────────────────┐
  │                │                                            │ appbi-net
  │                └─► :5432  PostgreSQL (not exposed to host)  │
  │                                                             │
  └─► :8001  AI Service (FastAPI)  ────────────────────────────┘
                  │  calls BI Backend API (internal Docker network)
                  └─► http://backend:8000/api/v1/*
```

- All services share the internal Docker network `appbi-net`
- PostgreSQL has **no host port binding** — no conflict with a local Postgres instance
- AI Service is **optional** — the BI stack runs fully without it
- Alembic migrations run automatically in `entrypoint.sh` on every backend start
- Database data is persisted in named volume `db_data`

---

## AI Chat Agent

The AI Chat feature is a separate FastAPI microservice (`ai-service/`) that connects to the BI Backend over the internal Docker network and answers data questions in natural language.

### How it works

1. User sends a question via WebSocket from `/chat` page.
2. The orchestrator builds a conversation with the LLM (OpenAI / Anthropic / Gemini / OpenRouter).
3. The LLM autonomously calls one or more **tools** to fetch real data.
4. Results are streamed token-by-token back to the browser.
5. Charts referenced in tool results are auto-rendered inline in the chat bubble.
6. After the response is complete, a **MetricsEvent** is sent with latency, tool call count, data rows analyzed, and model info.
7. Users can give thumbs up/down feedback per message — stored in the in-memory session.

### Tools available to the LLM

| Tool | Description |
|---|---|
| `search_charts(query)` | Semantic search across all saved charts. Returns the top match's data rows immediately — avoiding a second round-trip in most cases. |
| `run_chart(chart_id)` | Execute a specific chart by ID and stream its data + rendered chart to the user. |
| `execute_sql(datasource_id, sql)` | Run a raw SELECT query against any connected datasource. Restricted to SELECT only. |
| `query_table(workspace_id, table_id, ...)` | Point-and-click aggregation query against a Dataset Workspace table. |

### LLM providers & fallback chain

Set `LLM_PROVIDER` + `LLM_MODEL` in `.env`.  
Optionally set `LLM_FALLBACK_CHAIN` to try other providers automatically on failure:

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_FALLBACK_CHAIN=anthropic:claude-3-5-haiku-20241022,gemini:gemini-2.0-flash
```

Supported providers: `openai`, `anthropic`, `gemini`, `openrouter`.

### Quality metrics per message

Every AI response shows a metrics bar with:
- **Latency** — total response time in ms
- **Tools** — number of tool calls made
- **Rows** — total data rows read from tool results
- **Chart** badge — if a chart was embedded
- **Model** — short model name used
- Warning badges — if no tool was called (answer from LLM memory) or tool errors occurred

### Session management

- Sessions are stored **in memory** in the AI service process (not in PostgreSQL).
- Default TTL: 30 minutes of inactivity (`AI_SESSION_TTL_MINUTES`).
- Sessions are restored from the AI service on page reload (`GET /chat/sessions/{id}`).
- WebSocket cancel: send `{"type": "cancel"}` to abort the in-progress response.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `WS` | `/chat/ws` | WebSocket streaming (preferred) |
| `POST` | `/chat/stream` | SSE/streaming HTTP fallback |
| `GET` | `/chat/sessions` | List all active sessions |
| `GET` | `/chat/sessions/{id}` | Get full session with message history |
| `POST` | `/chat/sessions/{id}/messages/{msg_id}/feedback` | Submit thumbs feedback |
| `GET` | `/health` | AI service health check |

---

## API Reference

Full REST API documentation is in [docs/API.md](docs/API.md).

Interactive Swagger UI:
- BI Backend: `http://localhost:8000/api/v1/docs`
- AI Service: `http://localhost:8001/docs`

---

## Data Sources hỗ trợ

| Loại | Ghi chú |
|---|---|
| **PostgreSQL** | Host · Port · Database · Username · Password · Schema (tuỳ chọn, đặt search_path) |
| **MySQL** | Host · Port · Database · Username · Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID (snapshot toàn bộ sheet khi kết nối) |
| **Manual (File Import)** | Upload CSV hoặc Excel `.xlsx/.xls` — tất cả sheet được import, xem preview trước khi lưu |

> Với PostgreSQL và MySQL: bắt buộc nhấn **Test Connection** thành công trước khi nút Create được kích hoạt.

---

## Filter Architecture (Dashboards)

| Loại | Phạm vi | Khi nào áp dụng | Field hợp lệ |
|---|---|---|---|
| **Global Filter Bar** | Toàn dashboard | Trước aggregation (pre-agg) | Dimension / breakdown fields |
| **Per-tile HAVING** | Từng chart tile | Sau aggregation (post-agg) | Metric keys (e.g. `sum__point`) |

---

## License

MIT


## Data Sources hỗ trợ

| Loại | Ghi chú |
|---|---|
| **PostgreSQL** | Host · Port · Database · Username · Password · Schema (tuỳ chọn, đặt search_path) |
| **MySQL** | Host · Port · Database · Username · Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID (snapshot toàn bộ sheet khi kết nối) |
| **Manual (File Import)** | Upload CSV hoặc Excel `.xlsx/.xls` — tất cả sheet được import, xem preview trước khi lưu |

> Với PostgreSQL và MySQL: bắt buộc nhấn **Test Connection** thành công trước khi nút Create được kích hoạt.

---

## Filter Architecture (Dashboards)

| Loại | Phạm vi | Khi nào áp dụng | Field hợp lệ |
|---|---|---|---|
| **Global Filter Bar** | Toàn dashboard | Trước aggregation (pre-agg) | Dimension / breakdown fields |
| **Per-tile HAVING** | Từng chart tile | Sau aggregation (post-agg) | Metric keys (e.g. `sum__point`) |

---

## License

MIT

