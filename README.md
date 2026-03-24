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
cp .env.docker.example .env
```

On Windows PowerShell you can also use:

```powershell
Copy-Item .env.docker.example .env
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
- `OPENAI_API_KEY`
- `SECRET_KEY`
- `BI_API_URL`

See [`.env.docker.example`](./.env.docker.example) for the maintained baseline.

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

Current flow from `/dashboards`:
1. Open the AI Agent wizard.
2. Search and choose one or more workspace tables.
3. Review the selected scope panel.
4. Fill in the structured brief.
5. Generate a plan.
6. Review and edit sections and charts.
7. Build the dashboard.
8. Open the generated dashboard.

Current UX highlights:
- workspace search
- collapse and expand by workspace
- select shown or clear shown per workspace
- selected scope summary for large table sets
- editable plan before build

Current limitation:
- saved reusable report specs are not implemented yet
- if you want a new report variant, you currently go through the wizard again

## Project Structure

```text
backend/                  FastAPI backend
frontend/                 Next.js frontend
ai-service/               AI Chat service
ai-agent-service/         AI Agent service
docs/                     project documentation
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
