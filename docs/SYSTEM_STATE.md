# AppBI - System State

Last updated: 2026-03-24

This document records the current runtime architecture and the important implementation facts that contributors should trust first.

## Runtime Topology

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

## Current Source Of Truth

When docs disagree, prefer these files:
- [README.md](../README.md)
- [docker-compose.yml](../docker-compose.yml)
- [docker-compose.ai.yml](../docker-compose.ai.yml)
- [docker-compose.chat.yml](../docker-compose.chat.yml)
- [docker-compose.agent.yml](../docker-compose.agent.yml)
- [docs/GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md)
- [docs/GUIDED_API_CHART.md](./GUIDED_API_CHART.md)
- [docs/GUIDED_API_DASHBOARD.md](./GUIDED_API_DASHBOARD.md)

## AI Split

The repository no longer uses one generic AI runtime for everything.

AI Chat:
- code lives in `ai-service/`
- service name is `ai-chat-service`
- transport is WebSocket plus HTTP NDJSON streaming
- purpose is question answering and exploration

AI Agent:
- code lives in `ai-agent-service/`
- service name is `ai-agent-service`
- transport is HTTP only
- purpose is planning and generating a full dashboard

## Docker Modes

Base only:
```bash
docker compose up -d --build
```

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

Development stack:
```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Development + full AI:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

## Frontend Behavior

- `/chat` depends on `ai-chat-service`
- `/dashboards` can open the AI Agent wizard when `ai-agent-service` is available and permissions allow it
- the chat page now shows a clear warning when chat is offline instead of failing silently
- the dashboard page and the chat page are intentionally independent

## Permission Facts

Module permissions include:
- `ai_chat`
- `ai_agent`

The AI Agent requires:
- `ai_agent >= edit`
- `dashboards >= edit`
- `explore_charts >= edit`
- object-level visibility on selected workspace tables

Legacy user rows that predate `ai_agent` are backfilled logically so old editor/admin-style users are not accidentally locked out.

## Backend Facts

- Backend auth embeds both `ai_chat_level` and `ai_agent_level` in JWTs.
- Backend `/permissions/me` exposes the new `ai_agent` module.
- Object-level authorization hardening and auth regression tests are already in place.

## AI Chat Facts

Routes live under `/chat` on port `8001`.

Important endpoints:
- `GET /health`
- `WS /chat/ws?token=<jwt>`
- `POST /chat/stream`
- `GET /chat/sessions`
- `POST /chat/sessions`
- `GET /chat/sessions/{session_id}`
- `DELETE /chat/sessions/{session_id}`
- `POST /chat/sessions/{session_id}/messages/{message_id}/feedback`

## AI Agent Facts

Routes live under `/agent` on port `8002`.

Important endpoints:
- `GET /health`
- `POST /agent/plan`
- `POST /agent/build/stream`

The builder follows the guided docs for chart payloads and dashboard layout payloads.

## Known Operational Expectations

- If only `ai-agent-service` is running, `/chat` will load but live chat will be unavailable.
- If only `ai-chat-service` is running, `/dashboards` still works but the AI Agent flow is unavailable.
- `docker-compose.ai.yml` now means "start both AI services".
- `docker-compose.dev.yml` is compatible with the AI overlays.

## Current Validation Status

Recently verified in Docker:
- base stack builds and starts
- full AI stack builds and starts
- chat-only and agent-only overlays work independently
- backend auth regression tests pass in Docker
- chat session create/delete smoke test passes
- agent `/plan` smoke test passes
