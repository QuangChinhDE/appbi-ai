# CLAUDE.md - AppBI Contributor Reference

This file is a concise architecture reference for contributors and coding agents working inside this repository.

## Runtime Overview

Base stack:
- `db`
- `backend`
- `frontend`

Optional AI services:
- `ai-chat-service`
- `ai-agent-service`

Ports:
- Frontend -> `3000`
- Backend -> `8000`
- AI Chat -> `8001`
- AI Agent -> `8002`

## AI Split

AI Chat:
- code in `ai-service/`
- reactive, conversational, tool-calling
- session-based

AI Agent:
- code in `ai-agent-service/`
- proactive dashboard builder
- plan plus build flow

Do not treat them as one combined runtime when editing architecture, docs, or Docker config.

## Compose Files

- `docker-compose.yml` -> base stack only
- `docker-compose.ai.yml` -> both AI services
- `docker-compose.chat.yml` -> chat only
- `docker-compose.agent.yml` -> agent only
- `docker-compose.dev.yml` -> hot reload dev stack

Common commands:
```bash
docker compose up -d --build
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

## Important Frontend Files

- `frontend/src/lib/ai-services.ts`
- `frontend/src/app/(main)/chat/page.tsx`
- `frontend/src/components/ai-chat/ChatPanel.tsx`
- `frontend/src/app/(main)/dashboards/page.tsx`
- `frontend/src/components/ai-agent/DashboardAgentWizard.tsx`

## Important Backend Files

- `backend/app/api/auth.py`
- `backend/app/api/permissions.py`
- `backend/app/core/dependencies.py`
- `backend/tests/test_auth_permissions.py`
- `backend/tests/test_auth_routes.py`

## Important AI Files

Chat:
- `ai-service/app/main.py`
- `ai-service/app/routers/chat.py`

Agent:
- `ai-agent-service/app/main.py`
- `ai-agent-service/app/routers/agent.py`
- `ai-agent-service/app/services/planner.py`
- `ai-agent-service/app/services/builder.py`

## Permission Facts

Module keys include:
- `ai_chat`
- `ai_agent`

Agent requires:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level access on selected tables

## Guided Docs

For AI Agent payload correctness, use:
- `docs/GUIDED_API_CHART.md`
- `docs/GUIDED_API_DASHBOARD.md`
- `docs/GUIDED_API_AI_AGENT_REPORT.md`

## Contributor Notes

- The backend also contains AI-related metadata features that are separate from the chat and agent containers.
- If you update Docker naming or ports, update the compose files, frontend env handling, and docs together.
- If you test only `ai-agent-service`, the chat page should not be treated as broken just because chat is offline.
