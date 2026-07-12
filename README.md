# AppBI

> A governed business-intelligence platform where **AI is the output**.

AppBI is more than a dashboard builder. Every layer — data sources, the semantic
model, the knowledge that grounds the assistant, the reports themselves — exists to
feed **a trustworthy AI layer**: one that answers in the business's own language,
cites the knowledge it used, and stays usable by non-technical people.

- **Backend** — FastAPI (Python), PostgreSQL + `pgvector`, Alembic migrations.
- **Frontend** — Next.js (App Router, standalone output), TypeScript, a Linear-inspired design system.
- **Delivery** — Docker Compose; one command brings the whole stack up.
- **Automation** — three MCP servers let an AI assistant build dashboards and mini-apps for you.

---

## Table of contents

1. [Quick start](#quick-start)
2. [What AppBI is](#what-appbi-is)
3. [Modules](#modules)
4. [Grounding the AI](#grounding-the-ai)
5. [MCP — automated building for non-tech users](#mcp--automated-building-for-non-tech-users)
6. [Architecture & repo layout](#architecture--repo-layout)
7. [Configuration](#configuration)
8. [Deploy to a VM](#deploy-to-a-vm)
9. [Development](#development)

---

## Quick start

**Prerequisites**

- Docker (Docker Desktop or Docker Engine) with the **`docker compose` v2** plugin, daemon running.
- `openssl` **or** Python on `PATH` (used once to generate secrets).

**Run it — one command, zero manual setup**

```bash
# macOS / Linux / WSL / Git Bash
./run.sh

# Windows PowerShell
.\run.ps1
```

`run` does everything in order and **exits non-zero if the stack is not fully healthy** (never a false "success"):

1. Checks the environment (docker, compose v2, running daemon, secret tooling).
2. Syncs `.env` from `.env.example` and **auto-generates secrets** (`SECRET_KEY`, the datasource encryption key, a local DB password) — see [`scripts/bootstrap-env.sh`](scripts/bootstrap-env.sh).
3. `docker compose up -d --build`. The backend entrypoint then **runs the Alembic migrations, creates storage dirs, and seeds the admin user automatically**.
4. Waits for every service to become healthy and validates the HTTP endpoints.

When it finishes you get:

| | URL |
|---|---|
| **Frontend** | http://localhost:3000 |
| **Backend health** | http://localhost:8000/health |
| **Login** | `admin@appbi.io` / `123456` *(default — `run` prints the real values and warns you to change them for production)* |

> A bundled `pgvector/pgvector:pg16` Postgres container is used automatically **unless** you set `DATABASE_URL` in `.env` (then that managed database is used and the local container is skipped).

**`run` flags**

| Flag | Effect |
|---|---|
| `--pull` | Fast-forward the current git branch first (never auto-merges) |
| `--no-build` | Start without rebuilding images |
| `--recreate` | Force-recreate containers (clean restart) |
| `--down` | Stop the stack and exit |
| `--logs` | Follow logs once it's up |
| `--skip-validate` | Start without the health-gate |

---

## What AppBI is

Data flows bottom-up: raw sources are modelled into semantics, semantics are enriched
into knowledge, and knowledge becomes output that both humans and the AI consume.
Governance and observability run across every layer.

```
                ┌─────────────────────────────────────────────┐
   Activation   │  MCP  ·  Public links / Embed / PDF          │
                └─────────────────────────────────────────────┘
   Layer 4      Outputs        Dashboards · Explore · AI Bot · Workboards
                                          ▲
   Layer 3      Intelligence   AI Readiness · AI Suggestions · Metrics & Terms
                (the focus)    · AI Guidance · Documents
                                          ▲
   Layer 2      Semantic model Datasets: relationships · measures · calendar/geo
                                          ▲
   Layer 1      Data sources   BigQuery · Google Sheets · PostgreSQL · Snowflake · Airbyte · files

   Cross-cutting ⟂ Governance (single review ledger, certification gate, always-inject caveats)
                 ⟂ Observability (data quality, incidents/MTTR, semantic lineage)
```

**The thesis.** The classic blind spot of every BI tool is an *invisible semantic layer* —
metrics live in a few people's heads and nobody knows what the AI relied on when it
answered. AppBI inverts that: knowledge is a first-class, visible asset with an owner
and a lifecycle, every AI answer is traceable to the knowledge it used, and non-technical
users get in through **review**, **authoring**, and **✨ AI-compose** (describe it in plain
language, the AI drafts it, you review and save).

---

## Modules

The sidebar mirrors the data flow. Each module has one job, one owner, one lifecycle.

### Build

| Module | Route | Purpose |
|---|---|---|
| Data Sources | `/datasources` | Declare & authenticate connections to where data lives (read-only). |
| Datasets | `/datasets` | The **semantic model**: tables, relationships/joins, measures, calendar & geo tables. |
| Explore | `/explore` | Ad-hoc charts on the semantic model — dozens of chart types. |
| Dashboards | `/dashboards` | Grid & free canvas, 4-layer filters, cross-highlight, public links, PDF, snapshots, co-editing. |
| Observability | `/observability` | Data-quality checks, incident lifecycle & MTTR, semantic lineage impact graph. |

### Intelligence — *the layer that grounds the AI*

| Module | Route | Purpose |
|---|---|---|
| AI Readiness | `/intelligence` | Cockpit: knowledge coverage & readiness, "what the AI uses", quality scorecard. |
| AI Suggestions | `/ai-inbox` | The single review ledger — AI-proposed knowledge with confidence & evidence to approve/certify. |
| Metrics & Terms | `/semantics` | The business contract: metric definitions (formula **read-only from the model**), glossary, data caveats. |
| AI Guidance | `/ai-guidance` | Playbooks, Rules (IF→THEN), Verified Q&A (pinned as regression tests), Data scope, versioned AI instructions. |
| Documents | `/govern` | Knowledge hub: markdown docs linked to KPIs/dashboards/datasets, auto AI summaries, RAG, knowledge graph. |

### Operate

| Module | Route | Purpose |
|---|---|---|
| Workboards | `/workboards` | No-code app builder: form/list/doc/dashboard screens, mandatory RLS, AppSheet-style formulas & relationships, theming, field widgets (photo/OCR/signature/barcode/GPS), POS, QR, offline-first mini-apps. |

*Plus* **Overview** (`/overview`) as the landing page and **Settings** (`/permissions`) for workspace administration and the per-module permission matrix.

---

## Grounding the AI

The Intelligence layer doesn't just *hold* knowledge — it **constrains how the AI uses it**.
When a user asks the AI Bot, the system automatically assembles: scoped AI instructions →
pinned Verified Q&A → applicable Rules → Playbooks → data caveats. Every turn records
**which knowledge it used** (provenance), so a wrong answer can be traced to its root and fixed.

Only **certified** knowledge reaches the AI, and certifying a metric is *blocked* until its
formula binds to the semantic model — so a bad definition never silently flows to the output.

Two-layer access keeps it approachable:

- **Review** — business users (view permission) certify, approve, and flag the AI's suggestions. No formula knowledge required.
- **Author** — data stewards (edit permission) define metrics, rules, and scope.
- **✨ AI-compose** — anyone describes what they want in plain language; the AI drafts it, the user edits and saves.

---

## MCP — automated building for non-tech users

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) lets an AI assistant such as
Claude operate AppBI through **controlled tools** instead of the user clicking through the UI.
You describe what you want; the assistant discovers the data, designs, and **creates it for real**.
Two guarantees hold across every server: the **backend is the single gatekeeper** (every write
is validated by a backend endpoint — e.g. `/charts/dry-run-create` — before it commits), and
**preview-then-confirm** (mutating tools return a plan and change nothing until `user_confirmed=true`).

| Server | Tools | What it does |
|---|---|---|
| [`appbi-dashboard-mcp`](Skill-AppBI/appbi-dashboard-mcp/) | ~164 (lean default ~91) | Discover data → design (in-chat) → materialize a full dashboard: dataset, model, measures, charts, filters. A blueprint (propose→commit) forces a design pass so metrics stay bound to the model. |
| [`appbi-workboard-mcp`](Skill-AppBI/appbi-workboard-mcp/) | 60 | Build a working mini-app end-to-end: `Source → Dataset → Model → Workboard → Share`. Ships an in-MCP `bootstrap_personal_access_token` tool that mints a scoped PAT from an email + password on first run. |
| [`appbi-guardrail-mcp`](Skill-AppBI/appbi-guardrail-mcp/) | 11 (read-only) | An engineering-safety advisor for editing the AppBI codebase — answers architecture/impact/invariant questions from `guardrail_rules.yaml`; never writes code or calls the API. |

Each server has its own `README.md` with setup and the full tool list.

---

## Architecture & repo layout

```
appbi-ai/
├── backend/            FastAPI app, models, services, Alembic migrations
│   └── app/            (runtime code — routes, services, semantic engine, AI bot)
├── frontend/           Next.js app (App Router, standalone build)
│   └── src/            (runtime code — pages, components, i18n, lib)
├── Skill-AppBI/        MCP servers (dashboard / workboard / guardrail)
├── scripts/            bootstrap-env.sh, db-init (pgvector provisioning), tooling
├── .githooks/          pre-push preflight gate (alembic + tsc + import smoke)
├── docker-compose.yml       base stack (db · backend · frontend)
├── docker-compose.dev.yml   local development overrides
├── nginx.conf               single-origin reverse proxy (production front)
├── run.sh / run.ps1         one-command bootstrap
└── .env.example             every configurable variable, documented inline
```

The frontend and backend bind to `127.0.0.1` in the base compose file, so in production
they are reached through **nginx** (`nginx.conf`) as a single origin rather than exposed directly.

---

## Configuration

Everything is driven by `.env` (created from `.env.example` on first `run`). `bootstrap-env.sh`
adds any new keys on future pulls and generates real secrets for placeholders — **without ever
overwriting a value you've set**. Key groups:

| Group | Notable keys |
|---|---|
| Database | `DATABASE_URL` (managed PG; leave blank to use the bundled container), or `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` |
| Security | `SECRET_KEY`, `DATASOURCE_ENCRYPTION_KEY` (auto-generated), `COOKIE_SECURE` |
| First admin | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` |
| Ports / URLs | `FRONTEND_PORT` (3000), `BACKEND_PORT` (8000), `NEXT_PUBLIC_API_URL`, `CORS_ORIGINS` |
| Modules | `METADATA_CATALOG_ENABLED`, `GOVERN_ENABLED`, `OBSERVABILITY_ENABLED`, `WORKBOARDS_ENABLED` — **forced ON by `run`** |
| AI providers | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` — *optional; at least one is needed for the AI Bot, AI summaries, and ✨ AI-compose. Models are fixed in code.* |
| Auth | password login (on by default) and optional Google OAuth (`AUTH_GOOGLE_*`) |
| Performance | `WEB_CONCURRENCY`, snapshot materialization, live-query cache limits |

> The core modules migrate their schema automatically on boot — no extra setup. The AI features
> degrade gracefully when no provider key is set (the modules still author/review; only the AI
> answers and drafts are unavailable).

---

## Deploy to a VM

```bash
# 1. Clone
git clone https://github.com/QuangChinhDE/appbi-ai.git
cd appbi-ai
git checkout demo          # or master

# 2. (optional) point at a managed database and set an admin password
#    nano .env   — set DATABASE_URL and ADMIN_PASSWORD; run keeps whatever you set

# 3. Bring it up
./run.sh

# Later, to update the running box:
./run.sh --pull            # fast-forward this branch, rebuild, migrate, re-validate
```

`run.sh` is idempotent — safe to re-run on every deploy. Migrations are additive and run
automatically in the backend entrypoint.

**Making it reachable from outside the VM.** The services bind to `127.0.0.1`. Choose one:

- **Production:** put nginx in front using the provided `nginx.conf` (single origin, TLS terminated there).
- **Quick test:** SSH-tunnel from your machine — `ssh -L 3000:localhost:3000 user@vm` — then open http://localhost:3000.

---

## Development

- **Branches** — `master` is the main branch; `demo` is the current deploy target.
- **Push gate** — `.githooks/pre-push` runs a preflight (Alembic single-head check, frontend `tsc --noEmit`, backend import smoke) and blocks the push if anything fails. Enable it once with `git config core.hooksPath .githooks`.
- **Local dev** — `docker-compose.dev.yml` provides development overrides; iterate against the running containers rather than rebuilding the world each change.
- **Migrations** — additive, chained; create with Alembic and keep a single head.

---

*Internal project. Do not commit `.env` or any credential/service-account key.*
