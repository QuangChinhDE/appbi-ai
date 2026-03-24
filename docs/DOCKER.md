# AppBI - Docker Guide

This document describes the current Docker layout for AppBI after the AI subsystem split.

## Stack Modes

Base stack:
- `db`
- `backend`
- `frontend`

Optional AI services:
- `ai-chat-service`
- `ai-agent-service`

Compose files:
- `docker-compose.yml` -> base stack only
- `docker-compose.ai.yml` -> full AI overlay, starts both chat and agent
- `docker-compose.chat.yml` -> chat-only overlay
- `docker-compose.agent.yml` -> agent-only overlay
- `docker-compose.dev.yml` -> hot reload dev stack

## Commands

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

Development stack:
```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Development stack + both AI services:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

## Expected Ports

- Frontend: `3000`
- Backend: `8000`
- AI Chat: `8001`
- AI Agent: `8002`

## Health Endpoints

- Backend: `http://localhost:8000/health`
- AI Chat: `http://localhost:8001/health`
- AI Agent: `http://localhost:8002/health`
- Frontend: `http://localhost:3000`

## Docker Desktop Expectations

Base stack only:
- `db-1`
- `backend-1`
- `frontend-1`

Full AI stack:
- `db-1`
- `backend-1`
- `frontend-1`
- `ai-chat-service-1`
- `ai-agent-service-1`

Agent-only stack:
- `db-1`
- `backend-1`
- `frontend-1`
- `ai-agent-service-1`

Chat-only stack:
- `db-1`
- `backend-1`
- `frontend-1`
- `ai-chat-service-1`

## Data Persistence

Persistent data is stored in Docker volumes.

Important consequences:
- `docker compose down` removes containers and networks only
- `docker compose down -v` also removes volumes and deletes persisted metadata/data
- container cleanup is safe for rebuilds
- volume cleanup is destructive

## Useful Commands

Show current containers:
```bash
docker compose ps
```

Show logs:
```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f ai-chat-service
docker compose logs -f ai-agent-service
```

Rebuild after code changes:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Stop everything without deleting volumes:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml down --remove-orphans
```

Stop everything and delete volumes:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml down -v --remove-orphans
```

## Troubleshooting

### Chat page loads but chat does not work
This usually means:
- `frontend` is running
- `ai-chat-service` is not running

Fix:
```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

or start the full AI stack:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

### Agent wizard exists but cannot generate
Check:
- `ai-agent-service` is running
- the user has `ai_agent >= edit`
- the user has `dashboards >= edit`
- the user has `explore_charts >= edit`
- at least one accessible workspace table exists

### Dev stack cannot see AI overlay
Use the current files together. The dev compose file was updated to share the same network name as the overlays.

Correct examples:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

## Notes

- `docker-compose.ai.yml` is now the combined AI overlay.
- The old mental model of a single `ai-service` for all AI behavior is no longer correct.
- Chat and Agent can be started, stopped, and debugged independently.
