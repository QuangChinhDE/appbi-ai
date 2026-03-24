# AppBI - AI Services Architecture

This document describes the current AI subsystem after the split between chat and agent runtimes.

## Services

### AI Chat
- directory: `ai-service/`
- Docker service: `ai-chat-service`
- port: `8001`
- purpose: reactive Q and A, data exploration, chart assistance

### AI Agent
- directory: `ai-agent-service/`
- Docker service: `ai-agent-service`
- port: `8002`
- purpose: proactive report building from a structured brief

## Why The Split Exists

The repository previously treated AI as one service conceptually. That is no longer true.

The split gives us:
- independent Docker lifecycle for chat and agent
- independent failure domains
- cleaner frontend contracts
- clearer permission checks
- safer future iteration on the report builder without breaking chat

## Frontend Entry Points

AI Chat:
- page: `/chat`
- components: `frontend/src/components/ai-chat/`
- transport: WebSocket and HTTP NDJSON

AI Agent:
- page entry: `/dashboards`
- component: `frontend/src/components/ai-agent/DashboardAgentWizard.tsx`
- transport: HTTP only

## Auth Model

The backend issues JWTs that include:
- `ai_level` for chat compatibility
- `ai_chat_level`
- `ai_agent_level`

The backend also exposes module permissions via `/permissions/me`.

Agent-specific permission gate:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- view access on selected workspace tables

## AI Chat Contract

Health:
- `GET /health`

Session endpoints:
- `GET /chat/sessions`
- `POST /chat/sessions`
- `GET /chat/sessions/{session_id}`
- `DELETE /chat/sessions/{session_id}`
- `POST /chat/sessions/{session_id}/messages/{message_id}/feedback`

Streaming endpoints:
- `WS /chat/ws?token=<jwt>`
- `POST /chat/stream`

## AI Agent Contract

Health:
- `GET /health`

Planning and build:
- `POST /agent/plan`
- `POST /agent/build/stream`

See the detailed build contract in [GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md).

## Build Rules For AI Agent

The AI Agent builder must follow:
- [GUIDED_API_CHART.md](./GUIDED_API_CHART.md)
- [GUIDED_API_DASHBOARD.md](./GUIDED_API_DASHBOARD.md)
- [GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md)

Important implementation rules:
- chart payload must include `workspace_table_id`
- chart config must include `workspace_id`, `chartType`, `roleConfig`, and `filters`
- chart type must be uppercase
- dashboard layout update must use `dashboard_charts[].id`
- multi-dataset v1 means dashboard composition, not dataset blending

## Docker Commands

Base + both AI services:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Base + chat only:
```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

Base + agent only:
```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

Development + both AI services:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

## Operational Expectations

- If chat is down, the BI app still works and the agent can still run.
- If agent is down, the BI app still works and chat can still run.
- If only the agent is running, the chat page should warn that chat is offline.
- If only chat is running, the dashboard page still loads but the AI Agent flow is unavailable.

## Current Status

The split architecture has been implemented and verified in Docker:
- full AI stack works
- chat-only stack works
- agent-only stack works
- backend permissions and auth paths have regression tests
