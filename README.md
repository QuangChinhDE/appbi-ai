# AppBI AI

AppBI AI is a self-hosted BI platform focused on three workflows:

- connect data sources and model datasets
- explore data and build dashboards
- use AI chat / AI agent features on top of governed business data

The current system is built around a Next.js frontend, a FastAPI backend, PostgreSQL for application metadata, and optional AI services for chat and report generation.

## What The System Does

- Connects relational databases, BigQuery, Google Sheets, and file-based sources
- Lets users create datasets from physical tables, SQL queries, and calculated tables
- Supports dataset modeling, relationships, transformations, dictionary metadata, and data-quality rules
- Provides chart building, dashboard management, sharing, and public/embed flows
- Adds AI-assisted analytics through a chat service and an agent/report service

## Architecture

Core services:

- `frontend/`: Next.js application for datasets, explore, dashboards, auth, and admin UI
- `backend/`: FastAPI API for auth, permissions, datasets, charts, dashboards, and datasource logic
- `ai-service/`: AI chat service
- `ai-agent-service/`: AI agent/report service
- `db/`: PostgreSQL container for system metadata

Typical runtime:

```text
Frontend (Next.js)
  -> Backend API (FastAPI)
  -> PostgreSQL (metadata)
  -> External data sources (BigQuery, Postgres, MySQL, Sheets, files)

Optional:
Frontend / Backend -> AI Chat Service
Frontend / Backend -> AI Agent Service
```

## Main Product Areas

### Data Sources and Datasets

- Create datasources and import or query tables
- Build datasets with transformations and semantic metadata
- Manage table relationships, dictionary information, and data quality rules

### Explore and Dashboards

- Build charts from dataset tables
- Assemble dashboards and dashboard pages
- Share dashboards internally or through public/embed links

### AI

- AI Chat for question-answering over connected business data
- AI Agent for guided report generation and AI-assisted analysis flows

## Repository Layout

```text
frontend/                Next.js frontend
backend/                 FastAPI backend
ai-service/              AI chat service
ai-agent-service/        AI agent service
docker-compose.yml       base runtime
docker-compose.dev.yml   local development stack
docker-compose.ai.yml    AI services overlay
```

## Quick Start

### 1. Configure environment

Copy one of the environment templates:

```bash
cp .env.example .env
```

Set the important values in `.env`:

- `DB_PASSWORD`
- `SECRET_KEY`
- `DATASOURCE_ENCRYPTION_KEY`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

### 2. Start the base stack

```bash
docker compose up -d --build
```

Base local URLs:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

### 3. Start AI services if needed

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

You can also run only one AI service with:

```bash
docker compose -f docker-compose.yml -f docker-compose.chat.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

## Development

For local development with hot reload:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
```

## Notes

- The backend is the main integration layer for datasets, datasource access, permissions, and dashboard APIs.
- AI services are optional overlays, not mandatory for the base BI workflow.
- The repo currently includes active work on dataset quality, dashboard import flows, and explore/dashboard UX.
