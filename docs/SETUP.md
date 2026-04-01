# AppBI - Setup Guide

This guide is the shortest path to a working AppBI environment.

## Prerequisites

- Docker Desktop
- Docker Compose v2
- Git
- free ports: `3000`, `8000`, `8001`, `8002`

Optional for local development without Docker:
- Python 3.10+
- Node.js 18+
- PostgreSQL 16

## Recommended Setup: Docker

1. Clone the repository.
2. Copy the environment template.
3. Start the stack mode you want.

```bash
git clone <repo-url>
cd Dashboard-App-v2
cp .env.example .env
```

### Start base stack only
```bash
docker compose up -d --build
```

### Start base stack plus both AI services
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

### Start base stack plus chat only
```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

### Start base stack plus agent only
```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

## First Verification

Open:
- `http://localhost:3000`
- `http://localhost:8000/api/v1/docs`

Recommended health checks:
```bash
curl http://localhost:8000/health
curl http://localhost:8001/health
curl http://localhost:8002/health
```

If you only started the base stack, `8001` and `8002` should be offline.
If you started only the agent overlay, `8001` should be offline and that is expected.

## Login

The backend bootstraps an admin user from `.env` on first boot.

Defaults in the template:
- email: `admin@appbi.io`
- password: `123456`

Change them in `.env` before real use.

## Which Stack Should You Use?

Use base stack only when you want:
- BI UI
- backend APIs
- no chat
- no agent

Use full AI stack when you want:
- chat page to work
- dashboards agent wizard to work
- Docker Desktop to show both AI services clearly

Use chat-only when you want:
- conversational AI only
- no dashboard agent

Use agent-only when you want:
- dashboard generation only
- no chat runtime

## Development with Hot Reload

Base dev stack:
```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Dev + both AI services:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.ai.yml up -d --build
```

Dev + agent only:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.agent.yml up -d --build
```

Dev + chat only:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.chat.yml up -d --build
```

## Local Non-Docker Setup

Backend:
```bash
cd backend
python -m venv ../venv
source ../venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Frontend:
```bash
cd frontend
npm install
npm run dev
```

AI Chat:
```bash
cd ai-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

AI Agent:
```bash
cd ai-agent-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8002 --reload
```

## Common Problems

### Chat page opens but chat does not work
You probably started:
- base stack only, or
- agent-only stack

Start chat:
```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
```

or start both AI services:
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

### Agent wizard opens but has no tables
Check:
- the user has `ai_agent` permission
- the user has dashboard/chart edit permissions
- at least one workspace table exists and is visible to the user

### Clean rebuild without deleting data
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml down --remove-orphans
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build --remove-orphans
```

### Full wipe including persisted data
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml down -v --remove-orphans
```

## Recommended Reading

- [README.md](../README.md)
- [DOCKER.md](./DOCKER.md)
- [SYSTEM_STATE.md](./SYSTEM_STATE.md)
- [AI_AGENT.md](./AI_AGENT.md)
- [GUIDED_API_AI_AGENT_REPORT.md](./GUIDED_API_AI_AGENT_REPORT.md)
