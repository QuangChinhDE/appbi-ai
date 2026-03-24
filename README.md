# AppBI - Business Intelligence Dashboard Platform

AppBI is a self-hosted BI platform with a FastAPI backend, a Next.js frontend, and two optional AI services that can run independently:
- `ai-chat-service`: reactive chat assistant
- `ai-agent-service`: proactive dashboard report builder

## Architecture

Base stack:
- `db` -> PostgreSQL metadata store
- `backend` -> BI API, permissions, query execution
- `frontend` -> dashboard UI, explore UI, admin UI

Optional AI overlays:
- `ai-chat-service` -> chat sessions, WebSocket/SSE chat, tool-calling
- `ai-agent-service` -> dashboard planning and dashboard generation

Default ports:
- Frontend: `3000`
- Backend: `8000`
- AI Chat: `8001`
- AI Agent: `8002`

## What Is Split Now

AI Chat and AI Agent are separate systems.

AI Chat:
- conversational and reactive
- answers questions against accessible data
- may create an individual chart during a conversation
- runs from `ai-service/`

AI Agent:
- proactive report builder
- accepts a structured brief plus selected workspace tables
- generates a plan, multiple charts, and a complete dashboard
- runs from `ai-agent-service/`

The frontend is designed to degrade gracefully:
- if chat is offline, `/chat` still loads and shows a clear warning
- if agent is offline, `/dashboards` still loads and the agent wizard will fail cleanly
- you can run chat without agent, or agent without chat

## Docker Quick Start

1. Copy the environment template.
2. Choose the stack mode you want.
3. Start Docker Compose.

```bash
cp .env.docker.example .env
```

Base stack only:
```bash
docker compose up -d --build
```

Base stack + both AI services:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Base stack + chat only:
```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

Base stack + agent only:
```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

Open:
- `http://localhost:3000`
- `http://localhost:8000/api/v1/docs`

## Development Docker

Hot reload dev stack:
```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Hot reload dev stack + both AI services:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

Hot reload dev stack + chat only:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.chat.yml up -d --build
```

Hot reload dev stack + agent only:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

## Environment Variables

Core variables:
- `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `SECRET_KEY`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
- `SEED_DEMO_DATA`
- `DATASOURCE_ENCRYPTION_KEY`

Port variables:
- `FRONTEND_PORT`
- `BACKEND_PORT`
- `AI_CHAT_PORT`
- `AI_AGENT_PORT`

LLM variables for AI Chat:
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

AI Agent currently uses:
- `OPENAI_API_KEY`
- `SECRET_KEY`
- `BI_API_URL`

See [.env.docker.example](./.env.docker.example) for the maintained template.

## Feature Summary

Core BI platform:
- data source management
- workspace tables and transformations
- chart creation and chart execution
- dashboards and grid layout
- module permissions and resource sharing
- AI-powered metadata generation inside the backend

AI Chat:
- WebSocket chat at `/chat/ws`
- HTTP NDJSON streaming at `/chat/stream`
- persistent chat sessions and feedback
- uses backend APIs with forwarded JWT auth

AI Agent:
- dashboard wizard entry on `/dashboards`
- `POST /agent/plan`
- `POST /agent/build/stream`
- multi-chart dashboard build flow
- guided by `docs/GUIDED_API_CHART.md`, `docs/GUIDED_API_DASHBOARD.md`, and `docs/GUIDED_API_AI_AGENT_REPORT.md`

## Permissions

Module-level permissions include:
- `data_sources`
- `datasets`
- `workspaces`
- `explore_charts`
- `dashboards`
- `ai_chat`
- `ai_agent`
- `settings`

The AI Agent requires:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level access to the selected workspace tables

## Project Structure

```text
backend/                  FastAPI BI backend
frontend/                 Next.js frontend
ai-service/               AI Chat service
ai-agent-service/         AI Agent service
docs/                     project documentation
docker-compose.yml        base stack
docker-compose.ai.yml     full AI overlay (chat + agent)
docker-compose.chat.yml   chat-only overlay
docker-compose.agent.yml  agent-only overlay
docker-compose.dev.yml    development stack
```

## Recommended Docs

- [docs/DOCKER.md](./docs/DOCKER.md)
- [docs/SETUP.md](./docs/SETUP.md)
- [docs/SYSTEM_STATE.md](./docs/SYSTEM_STATE.md)
- [docs/AI_AGENT.md](./docs/AI_AGENT.md)
- [docs/GUIDED_API_AI_AGENT_REPORT.md](./docs/GUIDED_API_AI_AGENT_REPORT.md)

## Notes

- The backend also contains AI-assisted metadata generation and anomaly-related services. Those backend features are separate from the chat and agent containers.
- `docker-compose.ai.yml` now means "start both AI services", not "start the old single AI service".
- If you only start `ai-agent-service`, the chat page will load but the chat service itself will be offline by design.
