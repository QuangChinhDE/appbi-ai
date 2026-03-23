# AppBI AI Agent — Technical Documentation

> **Single source-of-truth for the AI Agent subsystem.**
> Version 2.0 — March 2026

---

## Table of Contents

- [1. Architecture](#1-architecture)
- [2. Implementation Status](#2-implementation-status)
- [3. AI Service (ai-service/)](#3-ai-service)
  - [3.1 Endpoints & Protocol](#31-endpoints--protocol)
  - [3.2 Tools (LLM Function Calling)](#32-tools-llm-function-calling)
  - [3.3 Orchestrator & Session Management](#33-orchestrator--session-management)
  - [3.4 Context Builder](#34-context-builder)
  - [3.5 Configuration](#35-configuration)
- [4. Backend AI Features](#4-backend-ai-features)
  - [4.1 Auto-Tagging Service](#41-auto-tagging-service)
  - [4.2 Embedding Service](#42-embedding-service)
  - [4.3 Anomaly Detection](#43-anomaly-detection)
- [5. Frontend Components](#5-frontend-components)
- [6. Knowledge System (Auto-Description + Feedback UI)](#6-knowledge-system)
- [7. Security](#7-security)
- [8. Docker Deployment](#8-docker-deployment)
- [9. Known Issues](#9-known-issues)
- [10. What AI Can & Cannot Do](#10-what-ai-can--cannot-do)
- [11. Roadmap (Planned, Not Implemented)](#11-roadmap)
- [Appendix A: Cost Estimation](#appendix-a-cost-estimation)

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (User)                           │
│                                                              │
│  ┌────────────────┐       ┌──────────────────────────┐      │
│  │  BI App :3000  │       │  AI Chat (ChatPanel)     │      │
│  │  (Next.js 14)  │       │  WebSocket / SSE client  │      │
│  └────────────────┘       └────────────┬─────────────┘      │
└──────────────────────────────────────── │ ────────────────────┘
                                          │ ws:// or POST
                            ┌─────────────▼──────────────────┐
                            │  AI Service  :8001              │
                            │  FastAPI + WebSocket            │
                            │                                 │
                            │  ┌────────────┐                 │
                            │  │ LLM Engine │ (multi-provider)│
                            │  │ Tool Caller│                 │
                            │  └─────┬──────┘                 │
                            │        │ Tool calls (HTTP)      │
                            │  ┌─────▼─────────────────────┐  │
                            │  │   BI API Client            │  │
                            │  │   (→ backend:8000/api/v1)  │  │
                            │  └────────────────────────────┘  │
                            └──────────────────────────────────┘
                                          │ HTTP (Docker network)
                            ┌─────────────▼──────────────────┐
                            │  BI Backend  :8000              │
                            │  FastAPI + SQLAlchemy           │
                            │                                 │
                            │  AutoTaggingService (LLM)       │
                            │  EmbeddingService (Gemini)      │
                            │  AnomalyDetectionService        │
                            └─────────────┬──────────────────┘
                                          │
                            ┌─────────────▼──────────────────┐
                            │  PostgreSQL :5432 + pgvector    │
                            │  resource_embeddings (768-dim)  │
                            └─────────────────────────────────┘
```

**Key Design Principles:**
- AI Service **KHÔNG** kết nối trực tiếp PostgreSQL — chỉ gọi BI API
- Nếu `ai-service` container down → BI App hoạt động bình thường
- Auth: JWT token forwarded từ frontend → AI Service → BI Backend
- Session ownership: Mỗi session gắn `owner_user_id`, chỉ owner mới GET/DELETE/feedback

---

## 2. Implementation Status

### Phase 1 — Foundation: Metadata Enrichment & Vector Search — ✅ 100%

| Feature | Status | Details |
|---------|--------|---------|
| Column statistics (`column_stats` JSONB) | ✅ | `TableStatsService` — per-column dtype, cardinality, null%, min/max, samples via DuckDB |
| Auto-describe tables | ✅ | `AutoTaggingService.describe_table()` → `auto_description`, `column_descriptions`, `common_questions` |
| Auto-tag charts | ✅ | `AutoTaggingService.tag_chart()` → domain/intent/metrics/dimensions/tags + `auto_description`, `insight_keywords`, `common_questions` |
| Vector embeddings (pgvector) | ✅ | `resource_embeddings` table, Gemini `gemini-embedding-001` (768-dim) |
| Vector search endpoints | ✅ | `GET /charts/search?q=`, `GET /dataset-workspaces/tables/search?q=` — permission-aware |
| Auto-embed on CRUD | ✅ | BackgroundTask → embed on chart/table create/update, delete on delete |
| Description guard | ✅ | Skips regeneration if `description_source` = "user" or "feedback" (unless `force=True`) |

### Phase 2 — Smart Routing: Context Compression — ⚠️ 60%

| Feature | Status | Details |
|---------|--------|---------|
| Context Builder (per-turn vector search) | ✅ | `context_builder.py` — top-5 charts + top-5 tables (min similarity 0.3) |
| Context compression < 3K tokens | ✅ | Compact format: table names + columns + chart names |
| Conversation Memory (in-memory) | ✅ | `_sessions` dict, message history, title, charts, metrics, feedback |
| Sliding window (last 20 messages) | ✅ | `_trim_history` with boundary safety (advances to first `role: "user"`) |
| Query Classifier | ❌ | Not implemented — raw message passed directly to vector search |
| DB session persistence | ❌ | Sessions lost on service restart |
| Old-message summarization | ❌ | Not implemented |
| Usage-Based Ranking | ❌ | No `resource_views` table |

### Phase 3 — Enhanced Tools — ✅ 100%

| Feature | Status | Details |
|---------|--------|---------|
| `create_chart` | ✅ | `bi_client.ai_chart_preview(save=True)` → returns chart_id, data, row_count |
| `explore_data` | ✅ | `overview` / `distribution` / `time_patterns` analysis types |
| `explain_insight` | ✅ | Period comparison (WoW/MoM/QoQ/YoY) with dimension drill-down |
| `suggest_next` | ✅ | Post-response LLM call → 3 follow-up suggestions via `SuggestionsEvent` |
| `create_dashboard` | ✅ | Auto-detects column types → creates KPI/LINE/BAR/PIE/TABLE charts → dashboard |

### Phase 4 — Proactive Intelligence — ⚠️ 85%

| Feature | Status | Details |
|---------|--------|---------|
| Anomaly Detection — models | ✅ | `MonitoredMetric` + `AnomalyAlert` (z-score, change_pct, severity) |
| Anomaly Detection — service | ✅ | 7-day rolling z-score on DuckDB |
| Anomaly Detection — scheduler | ✅ | APScheduler cron daily at 02:00 UTC |
| Anomaly Detection — REST API | ✅ | CRUD metrics, alerts, manual scan |
| Data Storytelling | ❌ | Not started |

---

## 3. AI Service

### 3.1 Endpoints & Protocol

**Directory:** `ai-service/app/`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| WS | `/chat/ws?token=<jwt>&session_id=<uuid>` | JWT query param | Main chat (streaming events) |
| POST | `/chat/stream` | Bearer JWT | SSE-compatible NDJSON stream |
| POST | `/chat/sessions` | Bearer JWT | Create new session |
| GET | `/chat/sessions/{id}` | Bearer JWT (owner) | Get session + message history |
| DELETE | `/chat/sessions/{id}` | Bearer JWT (owner) | Delete session |
| POST | `/chat/sessions/{id}/messages/{msg_id}/feedback` | Bearer JWT (owner) | Thumbs up/down feedback |
| POST | `/chat/cleanup` | Bearer JWT | Remove expired sessions |

**WebSocket Event Types:**

```jsonc
{ "type": "thinking" }                          // Agent is processing
{ "type": "tool_call", "tool": "...", "args": {} }  // Tool invocation
{ "type": "tool_result", "tool": "...", "result": {} } // Tool response
{ "type": "text", "content": "..." }            // LLM text response
{ "type": "chart", "chart": { "id": 7, ... } } // Chart auto-emit
{ "type": "suggestions", "suggestions": [...] } // Follow-up suggestions
{ "type": "done" }                              // Turn complete
```

### 3.2 Tools (LLM Function Calling)

Defined in `ai-service/app/agents/tools.py`:

| Tool | Purpose | Backend Endpoint |
|------|---------|-----------------|
| `list_workspaces` | List accessible workspaces | `GET /dataset-workspaces` |
| `list_workspace_tables` | List tables in a workspace | `GET /dataset-workspaces/{id}` |
| `get_table_schema` | Get column names/types + stats | `GET /dataset-workspaces/{ws}/tables/{tbl}` |
| `get_sample_data` | Get first N rows | `GET /dataset-workspaces/{ws}/tables/{tbl}/preview` |
| `query_table` | Execute aggregation query | `POST /dataset-workspaces/{ws}/tables/{tbl}/execute` |
| `search_charts` | Vector search for charts | `GET /charts/search?q=` |
| `get_chart_data` | Get chart + its data | `GET /charts/{id}` + `GET /charts/{id}/data` |
| `get_chart_metadata` | Get chart metadata (domain/intent/tags) | `GET /charts/{id}/description` |
| `create_chart` | Create chart via AI preview | `POST /charts/ai-preview` |
| `analyze_field` | Analyze column distribution | `POST /dataset-workspaces/{ws}/tables/{tbl}/execute` |
| `explore_data` | Auto-analysis (overview/distribution/time) | Multiple queries |
| `explain_insight` | Period-over-period comparison with drill-down | Multiple queries |
| `create_dashboard` | Auto-create dashboard with multiple charts | Multiple endpoints |

**Tool-calling behavior:**
- First turn: `tool_choice="required"` (forces tool use immediately)
- Subsequent turns: `tool_choice="auto"` (LLM decides)
- `search_charts` auto-emits `ChartEvent` for each matching chart

### 3.3 Orchestrator & Session Management

**File:** `ai-service/app/agents/orchestrator.py`

- **Session model:** `ConversationSession` — `session_id`, `owner_user_id`, `messages[]`, `created_at`
- **Storage:** In-memory `_sessions` dict (no DB persistence)
- **Expiry:** Sessions auto-expire after 30 minutes of inactivity; cleanup via `POST /chat/cleanup`
- **Message loop:** User message → context build → LLM call → tool loop (repeat until LLM stops calling tools) → text response → suggestions
- **History trim:** Keep last 20 messages; advance cut point to first `role: "user"` to avoid orphaned tool results

### 3.4 Context Builder

**File:** `ai-service/app/agents/context_builder.py`

Each user turn triggers a context build:
1. Generate query embedding (Gemini `RETRIEVAL_QUERY`)
2. Vector search: top-5 charts + top-5 tables (cosine similarity ≥ 0.3)
3. Falls back to listing all accessible tables when no embeddings available
4. Builds `ContextPackage` with compact text (table names + columns, chart names)
5. Injected into system prompt as `[CONTEXT]` section

### 3.5 Configuration

**File:** `ai-service/app/config.py`

| Env Variable | Required | Description |
|-------------|----------|-------------|
| `LLM_PROVIDER` | Yes | `openai` / `anthropic` / `gemini` / `openrouter` |
| `LLM_MODEL` | Yes | e.g. `gpt-4o-mini`, `claude-sonnet-4-20250514`, `gemini-2.0-flash` |
| `OPENAI_API_KEY` | If openai | OpenAI API key |
| `ANTHROPIC_API_KEY` | If anthropic | Anthropic API key |
| `GEMINI_API_KEY` | If gemini | Google Gemini API key |
| `OPENROUTER_API_KEY` | If openrouter | OpenRouter API key |
| `BI_BACKEND_URL` | Yes | Backend URL (default: `http://backend:8000`) |
| `SECRET_KEY` | Yes | Same as backend — for JWT verification |

---

## 4. Backend AI Features

### 4.1 Auto-Tagging Service

**File:** `backend/app/services/auto_tagging_service.py`

Uses `LLMClient.complete_json()` via OpenRouter to generate semantic metadata.

**For tables** (`describe_table()`):
- `auto_description` — natural language description of the table
- `column_descriptions` — per-column descriptions (dict)
- `common_questions` — 3-5 example queries users might ask

**For charts** (`tag_chart()`):
- `domain` — business domain (sales, marketing, finance, etc.)
- `intent` — analysis intent (trend, comparison, ranking, etc.)
- `metrics` / `dimensions` / `tags` — categorical labels
- `auto_description`, `insight_keywords`, `common_questions`

**Guard system:** Skips knowledge fields if `description_source` is `"user"` or `"feedback"` (respects user edits). Use `force=True` endpoint to override.

**Trigger:** BackgroundTask on chart/table create and update.

### 4.2 Embedding Service

**File:** `backend/app/services/embedding_service.py`

| Feature | Detail |
|---------|--------|
| Model | Gemini `gemini-embedding-001` (768-dim via `outputDimensionality`) |
| Storage | `resource_embeddings` table (pgvector `vector(768)`) |
| Task types | `RETRIEVAL_DOCUMENT` for indexing, `RETRIEVAL_QUERY` for search |
| Index | IVFFlat with `vector_cosine_ops` (10 lists) |

**Source text construction:**
- **Charts:** name + type + metadata (domain/intent/metrics/tags) + auto_description + insight_keywords + common_questions + table info
- **Tables:** display_name + auto_description + column_descriptions + common_questions + column names/types

**Vector search** (`search_similar()`):
- Charts: permission-aware JOIN (owner_id OR resource_shares)
- Tables: returns all matches; caller filters by workspace access

**Endpoints:**
- `GET /charts/search?q=&limit=` — vector search for charts
- `GET /dataset-workspaces/tables/search?q=&limit=` — vector search for tables

### 4.3 Anomaly Detection

**Files:** `backend/app/services/anomaly_detection.py`, `anomaly_scheduler.py`, `backend/app/api/anomaly.py`

- **MonitoredMetric:** workspace_table_id, metric_column, aggregation, time_column, dimension_columns, threshold_z_score
- **AnomalyAlert:** z_score, change_pct, severity (info/warning/critical), explanation
- **Algorithm:** 7-day rolling z-score computed via DuckDB
- **Schedule:** APScheduler cron daily at 02:00 UTC
- **API:** CRUD for metrics, alerts list/read/delete, manual scan trigger

---

## 5. Frontend Components

### AI Chat Interface

| Component | Path | Purpose |
|-----------|------|---------|
| ChatPanel | `frontend/src/components/ai-chat/ChatPanel.tsx` | Main chat container with WebSocket |
| ChatMessage | `frontend/src/components/ai-chat/ChatMessage.tsx` | Message bubble rendering |
| ChatInput | `frontend/src/components/ai-chat/ChatInput.tsx` | User input with send button |
| ThinkingIndicator | `frontend/src/components/ai-chat/ThinkingIndicator.tsx` | "AI is thinking..." animation |

Charts returned by AI are rendered inline via `ChartEvent` streaming — not a separate component.

### AI Description Panels (Knowledge System UI)

| Component | Path | Purpose |
|-----------|------|---------|
| ChartDescriptionPanel | `frontend/src/components/explore/ChartDescriptionPanel.tsx` | View/edit chart auto_description, insight_keywords; regenerate; source badge |
| TableDescriptionPanel | `frontend/src/components/datasets/TableDescriptionPanel.tsx` | View/edit table auto_description; view column_descriptions, common_questions; regenerate; schema change warning |

**Permissions:** Edit/Regenerate buttons only shown when `canEdit=true`.

---

## 6. Knowledge System

The Knowledge System is the auto-description + embedding + feedback UI pipeline.

### Pipeline Flow

```
Table/Chart Created or Updated
       │
       ▼
  BackgroundTask
       │
       ├──▶ AutoTaggingService (LLM via OpenRouter)
       │       → auto_description, column_descriptions, common_questions
       │       → domain, intent, metrics, dimensions, tags (charts only)
       │
       └──▶ EmbeddingService (Gemini gemini-embedding-001)
               → 768-dim vector → pgvector upsert
               → Source text includes ALL auto-generated fields
```

### Description Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/dataset-workspaces/{ws}/tables/{tbl}/description` | Fetch table metadata |
| PUT | `/dataset-workspaces/{ws}/tables/{tbl}/description` | Update table auto_description (sets source="user") |
| POST | `/dataset-workspaces/{ws}/tables/{tbl}/description/regenerate` | Force AI regeneration |
| GET | `/charts/{id}/description` | Fetch chart metadata |
| PUT | `/charts/{id}/description` | Update chart auto_description + insight_keywords (sets source="user") |
| POST | `/charts/{id}/description/regenerate` | Force AI regeneration |

### Schema Change Detection

When a table's columns change, `schema_change_pending` flag is set to `true`. The UI displays a warning banner prompting the user to regenerate descriptions.

---

## 7. Security

| Risk | Mitigation |
|------|------------|
| Unauthorized API access | JWT Bearer auth on ALL AI Service REST endpoints |
| Session hijacking | `owner_user_id` bound on creation; GET/DELETE/feedback verify ownership (403) |
| AI accessing restricted data | BI Backend enforces permissions — AI Service forwards JWT token |
| AI calling write APIs | `bi_client` only implements read operations (except `create_chart`, `create_dashboard`) |
| Prompt injection from data | Tool results sanitized before LLM context injection |
| LLM API key leak | Keys only in `.env`, never returned via API |
| Data visibility leaks | Vector search is permission-aware (owner_id + resource_shares JOIN) |
| Rate limiting | Bounded by WebSocket connection + LLM API costs |

---

## 8. Docker Deployment

AI Service runs as a separate container, opt-in:

```bash
# Start full stack (backend + frontend + db + ai-service)
docker compose up --build -d

# Or start AI service separately
docker compose -f docker-compose.ai.yml up --build -d
```

**Required env vars for AI:**
```env
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-sonnet-4-20250514
OPENROUTER_API_KEY=sk-or-...
GEMINI_API_KEY=AIza...           # For embeddings (backend)
SECRET_KEY=same-as-backend       # For JWT verification
```

---

## 9. Known Issues

| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Count queries return 0 rows | High | ⚠️ Needs verification | `bi_client.py` may send `agg` instead of `function` — tool schema is correct but implementation needs re-test |
| Session/message IDs are None | Medium | ✅ Fixed | Sessions now have `session_id`, messages have `message_id` |
| Chart vector search empty results | High | ✅ Fixed | Type mismatch `varchar = integer` in `search_similar()` — fixed with `CAST(c.id AS varchar)` |
| `ChartMetadataResponse` incomplete | Low | Known | API response doesn't expose `auto_description`, `insight_keywords`, `common_questions` — data exists in DB, used by embedding service |

---

## 10. What AI Can & Cannot Do

### ✅ Can Do (Production)

| Capability | Example |
|------------|---------|
| Search & display charts | "Show me the revenue chart" |
| Query table data | "What's the average score by country?" |
| Cross-chart analysis | "Compare metrics between chart A and chart B" |
| Create new charts | "Create a bar chart of sales by region" |
| Create dashboards | "Build a dashboard for this workspace" |
| Explore data patterns | "Give me an overview of this table" |
| Explain insights | "Why did revenue drop this month?" |
| Multi-turn context | Follow-up questions within a session |
| Vietnamese + English | Multilingual support via LLM |

### ❌ Cannot Do (Current Limitations)

| Limitation | Reason |
|------------|--------|
| Remember across sessions | In-memory only; no DB persistence |
| Access data without permission | Backend enforces RBAC |
| Direct SQL execution | Only structured queries via `execute_table_query` |
| Real-time data monitoring | Anomaly detection is daily batch, not streaming |
| Multi-user collaboration | Each session is isolated |

---

## 11. Roadmap (Planned, Not Implemented)

> These features are designed but **not yet in codebase**. See previous specs for detailed design.

### High Priority

| Feature | Description | Effort |
|---------|-------------|--------|
| Query Classifier | Classify user intent before vector search for better routing | ~3 days |
| DB Session Persistence | Save sessions/messages to PostgreSQL for cross-restart continuity | ~3 days |
| Old-message Summarization | Summarize trimmed messages instead of dropping them | ~2 days |

### Medium Priority

| Feature | Description | Effort |
|---------|-------------|--------|
| Usage-Based Ranking | Track resource views, boost frequently-used items in search | ~2 days |
| Data Storytelling | Weekly auto-generated narrative from anomaly + trend data | ~5 days |
| Feedback-Driven Re-embedding | User corrections trigger re-embedding with improved metadata | ~4 days |

### Lower Priority

| Feature | Description | Effort |
|---------|-------------|--------|
| Export conversation as PDF | Generate report from chat history | ~3 days |
| Scheduled insights | AI auto-runs and sends via email/Slack | ~5 days |
| AI Feedback Capture | Structured feedback (correct resource, wrong resource) for training | ~4 days |

---

## Appendix A: Cost Estimation

| Component | Cost Driver | Estimate (monthly, 100 users) |
|-----------|------------|-------------------------------|
| LLM (chat) | ~50 req/user/day × 1K tokens avg | $150–400 (gpt-4o-mini) |
| LLM (auto-tagging) | 1 call per chart/table create | $5–20 |
| Embeddings (Gemini) | 768-dim per resource, re-embed on update | $1–5 |
| Anomaly Detection | Daily DuckDB queries | ~$0 (local compute) |
| pgvector | Part of existing PostgreSQL | $0 |
| **Total** | | **$160–430/month** |

> Using OpenRouter with cheaper models (e.g. `gemini-2.0-flash`) can reduce LLM costs by 70-80%.
