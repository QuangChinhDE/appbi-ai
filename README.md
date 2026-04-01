# AppBI

AppBI is a self-hosted business intelligence platform for connecting data sources, modeling workspace tables, building charts and dashboards, and using AI-assisted analysis flows.

The platform runs as a Docker-first stack with:
- a FastAPI backend
- a Next.js frontend
- PostgreSQL for metadata
- two optional AI services that can run independently

AI services are split by responsibility:
- `ai-chat-service`: reactive assistant for question answering and chart-oriented exploration
- `ai-agent-service`: proactive report builder that turns a structured brief into a dashboard plan and a generated dashboard

## Key Capabilities

Core BI platform:
- connect and manage data sources
- sync source data into the AppBI data layer
- organize workspace tables for analysis
- build charts in Explore
- assemble dashboards from saved charts
- share dashboards, charts, workspaces, and other resources with resource-level access control
- manage module permissions

AI capabilities:
- AI Chat for ad hoc analysis and conversational exploration
- AI Agent for dashboard planning and report generation
- backend AI Description for workspace tables and charts

## Architecture

Base stack:
- `db`: PostgreSQL metadata store
- `backend`: BI API, security, permissions, sync, query execution, AI Description pipeline
- `frontend`: dashboards, explore, workspaces, permissions, AI UI

Optional AI overlays:
- `ai-chat-service`: persistent chat sessions, streaming chat, tool-calling
- `ai-agent-service`: dashboard planning and build orchestration

Default ports:
- Frontend: `3000`
- Backend: `8000`
- AI Chat: `8001`
- AI Agent: `8002`

## Core Concepts

`Data Sources`
- connection definitions for databases, files, or sheets

`Sync`
- imports source data into the AppBI data layer so it can be analyzed reliably

`Workspace Tables`
- analysis-ready tables inside a workspace
- can be based on physical tables or SQL queries
- can carry AI Description metadata

`Charts`
- saved visualizations built from workspace tables
- can also carry AI Description metadata

`Dashboards`
- layouts composed from saved charts

`AI Chat`
- reactive assistant for asking questions against accessible data

`AI Agent`
- proactive assistant for creating a full dashboard from selected workspace tables and a structured brief

## AI Modules

### AI Chat

Use AI Chat when you want to:
- ask questions in natural language
- inspect available data
- summarize patterns
- generate a single chart during a conversation
- continue a saved analysis session later

Characteristics:
- reactive
- conversational
- session-based
- runs independently from AI Agent

### AI Agent

Use AI Agent when you want to:
- define a business goal
- select one or more workspace tables
- generate a dashboard plan first
- review and edit that plan
- create multiple charts and a full dashboard automatically

Characteristics:
- proactive
- brief-driven
- plan-first flow
- dashboard-oriented
- runs independently from AI Chat

Current v1 rules:
- the Agent only uses the tables selected by the user
- multi-dataset means section-based composition across selected tables
- v1 does not do cross-dataset blending or SQL joins across selected tables

### AI Description

AppBI also includes backend-driven AI Description generation for:
- workspace tables
- charts

Important notes:
- AI Description is separate from AI Chat and AI Agent services
- it runs inside the backend
- table and chart descriptions now have explicit generation state such as `queued`, `processing`, `succeeded`, `failed`, and `stale`
- the UI surfaces this state and supports regeneration more clearly than before

## Docker Quick Start

### 1. Prepare environment

Create `.env` from the maintained Docker template:

```bash
cp .env.example .env
```

On Windows PowerShell you can also use:

```powershell
Copy-Item .env.example .env
```

### 2. Choose the stack mode

Base BI stack only:

```bash
docker compose up -d --build
```

Base stack plus both AI services:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Base stack plus AI Chat only:

```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

Base stack plus AI Agent only:

```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

### 3. Open the application

- Frontend: `http://localhost:3000`
- Backend API docs: `http://localhost:8000/api/v1/docs`

## Development Docker

Development stack with hot reload:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Development stack plus both AI services:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

Development stack plus AI Chat only:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.chat.yml up -d --build
```

Development stack plus AI Agent only:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

## Environment Variables

Core backend variables:
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `SECRET_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_NAME`
- `SEED_DEMO_DATA`
- `DATASOURCE_ENCRYPTION_KEY`

Port variables:
- `FRONTEND_PORT`
- `BACKEND_PORT`
- `AI_CHAT_PORT`
- `AI_AGENT_PORT`

Frontend build variables:
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_AI_CHAT_WS_URL`
- `NEXT_PUBLIC_AI_CHAT_HTTP_URL`
- `NEXT_PUBLIC_AI_AGENT_HTTP_URL`

AI Chat variables:
- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_FALLBACK_CHAIN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `AI_SESSION_TTL_MINUTES`
- `AI_MAX_TOOL_CALLS`
- `AI_WORKSPACE_TABLE_LIMIT`

AI Agent variables:
- `SECRET_KEY`
- `BI_API_URL`
- `OPENROUTER_API_KEY` (required for LLM calls)
- `LLM_MODEL` (default model, e.g. `openai/gpt-4o-mini`)
- `AI_AGENT_ENRICHMENT_MODEL` (override for brief enrichment phase)
- `AI_AGENT_PLANNING_MODEL` (override for dashboard strategy phase)
- `AI_AGENT_INSIGHT_MODEL` (override for insight generation phase)
- `AI_AGENT_NARRATIVE_MODEL` (override for blueprint narrative phase)
- `AI_AGENT_LLM_FALLBACK_CHAIN` (comma-separated fallback models)
- `AI_AGENT_LLM_TIMEOUT_SECONDS` (LLM call timeout)

See [`.env.example`](./.env.example) for the maintained baseline.

## Permissions

Primary module permissions include:
- `data_sources`
- `datasets`
- `workspaces`
- `explore_charts`
- `dashboards`
- `ai_chat`
- `ai_agent`
- `settings`

AI Chat requires:
- `ai_chat >= view`
- object-level access to the data being queried

AI Agent requires:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level access to every selected workspace table

Important:
- module permission alone is not enough
- ownership and resource sharing are enforced on top of module access

## First Workflow

Typical first-time flow:
1. Start the Docker stack.
2. Sign in with the admin account from `.env`.
3. Create a data source.
4. Run a sync.
5. Create a workspace.
6. Add one or more workspace tables.
7. Build charts in Explore.
8. Create or generate a dashboard.
9. Share the result with your team.

## AI Agent Workflow

The AI Agent wizard is accessible from `/ai-reports`. It follows a 4-step flow:

1. **Select tables** — pick one or more workspace tables. Table descriptions and column counts are shown inline to help you choose.
2. **Write brief** — fill in 6 fields: goal, audience, timeframe, comparison period, detail level, and notes. The AI enriches this brief with inferred KPIs, domain-specific questions, table relationships, and a narrative arc.
3. **Review plan** — the AI generates a dashboard plan with sections and charts. Each section shows its charts inline. You can toggle charts on/off, edit titles, and inspect technical details. Warnings from the quality gate are shown prominently.
4. **Build and view results** — the AI creates charts, assembles the dashboard, generates narrative insights, and shows results inline: executive summary, top findings, risks, priority actions, section-by-section analysis, and per-chart evidence.

Key features:
- saved and reusable report specs (draft, ready, running, archived)
- report run history with result persistence
- inline report viewing after build (no redirect required)
- full Vietnamese and English language support
- LLM brief enrichment for domain-aware planning
- streaming progress for both planning and build phases

AI Agent planning pipeline:
1. Rule-based brief parsing (baseline)
2. LLM brief enrichment (infer domain, KPIs, questions, table relationships, narrative arc)
3. Table profiling (column types, metrics, dimensions, time fields)
4. Dataset fit scoring (per question, not global)
5. Quality gate (blockers, warnings, null risk, freshness)
6. Analysis plan (question-to-table mapping with enriched context)
7. LLM dashboard strategy (sections with business-intent titles, chart selection with hypotheses)
8. Quality review and scoring

## Project Structure

```text
backend/                  FastAPI backend (BI API, auth, permissions, AI Description)
frontend/                 Next.js frontend (dashboards, explore, AI Reports wizard)
ai-service/               AI Chat service (conversational analysis)
ai-agent-service/         AI Agent service (report planning and dashboard building)
  app/services/
    brief_parser.py       rule-based brief parsing
    brief_enricher.py     LLM brief enrichment (domain, KPIs, questions)
    planner.py            planning pipeline orchestration
    analysis_planner.py   question-to-table mapping
    builder.py            dashboard build orchestration
    insight_generator.py  chart insight and narrative generation
    dashboard_composer.py dashboard blueprint composition
    llm_client.py         OpenRouter LLM client with fallback chain
docs/                     project documentation and guided API docs
docker-compose.yml        base BI stack
docker-compose.ai.yml     full AI overlay
docker-compose.chat.yml   AI Chat overlay
docker-compose.agent.yml  AI Agent overlay
docker-compose.dev.yml    development stack
```

## Recommended Documentation

- [docs/DOCKER.md](./docs/DOCKER.md)
- [docs/SETUP.md](./docs/SETUP.md)
- [docs/API.md](./docs/API.md)
- [docs/GUIDED.md](./docs/GUIDED.md)
- [docs/AI_AGENT.md](./docs/AI_AGENT.md)
- [docs/GUIDED_API_CHART.md](./docs/GUIDED_API_CHART.md)
- [docs/GUIDED_API_DASHBOARD.md](./docs/GUIDED_API_DASHBOARD.md)
- [docs/GUIDED_API_AI_AGENT_REPORT.md](./docs/GUIDED_API_AI_AGENT_REPORT.md)

## Notes

- `docker-compose.ai.yml` means both AI services together.
- The backend contains AI Description generation even when no optional AI service is running.
- If only `ai-agent-service` is running, the `/chat` page still loads but live chat actions are unavailable.
- If only `ai-chat-service` is running, dashboard generation via AI Agent is unavailable.
- AI Agent uses OpenRouter as the LLM provider. Set `OPENROUTER_API_KEY` in `.env`.
- Each LLM phase (enrichment, planning, insight, narrative) can use a different model via phase-specific env vars.
- AI Reports are persisted as `AgentReportSpec` with run history. Users can revisit, re-edit, and re-run reports.
- The AI Reports wizard at `/ai-reports/new` supports both modal and full-page modes.
