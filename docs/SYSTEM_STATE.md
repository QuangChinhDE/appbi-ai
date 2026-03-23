# AppBI — System State & Implementation Reference

> **Last updated:** March 19, 2026  
> Tài liệu này ghi lại trạng thái kỹ thuật hiện tại của toàn hệ thống — cấu trúc, luồng dữ liệu, các quyết định thiết kế quan trọng, và những điểm cần xử lý tiếp. Clone ở đâu, đọc file này trước.

---

## 1. Tổng quan hệ thống

AppBI là BI platform self-hosted gồm **3 service + 1 database**:

| Service | Port | Stack | Mục đích |
|---|---|---|---|
| **frontend** | 3000 | Next.js 14 + TypeScript + Tailwind | UI và router |
| **backend** | 8000 | FastAPI + SQLAlchemy 2.0 + DuckDB | BI API, query engine, metadata store |
| **ai-service** | 8001 | FastAPI + WebSocket + LLM SDK | AI Chat Agent |
| **db** | (nội bộ) | PostgreSQL 16 | Metadata: datasources, datasets, charts, dashboards |

Docker network: `appbi-net` (bridge). PostgreSQL **không expose ra host**.

---

## 2. Cấu hình môi trường

Tất cả biến môi trường đặt trong **root `.env`** (copy từ `.env.docker.example`).  
AI service đọc trực tiếp từ root `.env` qua `pydantic-settings` — không cần file riêng.

Biến quan trọng:

```env
# DB
DB_USER / DB_PASSWORD / DB_NAME

# Backend
SECRET_KEY
LOG_LEVEL

# Ports
FRONTEND_PORT=3000
BACKEND_PORT=8000
AI_PORT=8001

# Demo data
SEED_DEMO_DATA=false   # true = auto-seed Football/FIFA data on first boot

# LLM
LLM_PROVIDER=openai          # openai | anthropic | gemini | openrouter
LLM_MODEL=gpt-4o-mini
LLM_FALLBACK_CHAIN=          # e.g. "anthropic:claude-3-5-haiku-20241022,gemini:gemini-2.0-flash"
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=

# AI Session / behaviour
AI_SESSION_TTL_MINUTES=30
AI_MAX_TOOL_CALLS=8
AI_WORKSPACE_TABLE_LIMIT=50
```

Khi đổi LLM provider/model: **không cần rebuild image** — chỉ sửa `.env` rồi restart container.

```bash
docker compose -f docker-compose.ai.yml restart ai-service
```

---

## 3. Khởi động

### Khởi động đầy đủ

```bash
# BI stack
docker compose up --build -d

# AI service
docker compose -f docker-compose.ai.yml up --build -d
```

### Khởi động local (dev)

```bash
# Backend
cd backend && source venv/bin/activate
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# AI service
cd ai-service && source venv/bin/activate
uvicorn app.main:app --reload --port 8001

# Frontend
cd frontend
NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
NEXT_PUBLIC_AI_WS_URL=ws://localhost:8001/chat/ws
npm run dev
```

---

## 4. BI Backend (`backend/`)

### Entrypoint

`entrypoint.sh` tự động:
1. Chờ PostgreSQL sẵn sàng (`pg_isready` loop)
2. Chạy `alembic upgrade head`
3. Nếu `SEED_DEMO_DATA=true` và chưa seed → chạy `seed_demo.py`
4. Khởi động `uvicorn`

### API structure

```
/api/v1/
  datasources/          CRUD + test-connection + execute-sql
  datasets/             CRUD + preview + transformation pipeline
  dataset-workspaces/   CRUD + tables + computed (js_formula) columns
  charts/               CRUD + /data (execute chart query)
  dashboards/           CRUD + layout save
  explore/              POST /query — point-and-click aggregation
  semantic/             POST /search — full-text search (FTS) across all entities
```

### Query engine (DuckDB)

- Manual/CSV/Excel datasources: DuckDB in-memory query
- Remote DB (PostgreSQL, MySQL, BigQuery, Sheets): connector + native driver
- SQL safety: `validate_select_only()` whitelist — chỉ cho phép SELECT

### Dataset Workspace

- Combine nhiều tables từ nhiều datasources vào 1 workspace
- `js_formula` computed columns: parser riêng chuyển Excel-style formula → Python expression
  - `IF([Points]>1800,"Elite","Other")` → `"Elite" if row["Points"] > 1800 else "Other"`
- Computed columns được highlight màu amber trong UI

---

## 5. AI Service (`ai-service/`)

### Kiến trúc

```
WebSocket /chat/ws
  │
  └─► orchestrator.py  (LLM conversation loop)
          │
          ├─► LLM API  (OpenAI / Anthropic / Gemini / OpenRouter)
          │
          └─► tools.py  (execute tool calls)
                  │
                  └─► bi_client.py  (HTTP → backend:8000/api/v1)
```

### Session management

- Sessions lưu **in-memory** trong dict `_sessions: Dict[str, ConversationSession]`
- TTL: `AI_SESSION_TTL_MINUTES` (default 30). Cleanup chạy theo request.
- **Không persist vào PostgreSQL** — restart AI service = mất history
- Session ID được trả về trong `DoneEvent` và lưu trong `localStorage` trên browser

### Streaming events (WebSocket protocol)

Tất cả events là JSON object có field `type`:

| type | Fields | Khi nào |
|---|---|---|
| `thinking` | `content` | LLM đang "suy nghĩ" (trước khi gọi tool) |
| `tool_call` | `tool`, `args` | LLM bắt đầu gọi tool |
| `tool_result` | `tool`, `summary`, `data` | Tool trả về kết quả |
| `text` | `content` | Incremental text chunk từ LLM |
| `chart` | `chart_id`, `chart_name`, `chart_type`, `data`, `role_config` | Chart data để render inline |
| `metrics` | xem bên dưới | Sau khi LLM hoàn thành — quality metrics |
| `done` | `session_id`, `cancelled?` | Kết thúc response |
| `error` | `content` | Lỗi |

Client gửi:
- `{"session_id": "...", "message": "...", "context": {...}}` — gửi câu hỏi
- `{"type": "cancel"}` — hủy response đang stream

### MetricsEvent — Quality metrics

Sau mỗi response hoàn chỉnh, orchestrator emit:

```json
{
  "type": "metrics",
  "message_id": "uuid",
  "latency_ms": 1234,
  "model": "gpt-4o-mini",
  "provider": "openai",
  "tool_calls": ["search_charts", "execute_sql"],
  "tool_call_count": 2,
  "tool_errors": 0,
  "has_chart": true,
  "has_data_backing": true,
  "data_rows_analyzed": 15,
  "input_tokens": null,
  "output_tokens": null
}
```

Hiện tại `input_tokens` / `output_tokens` chưa populate từ tất cả providers — để null.

### Tools

| Tool | Mô tả |
|---|---|
| `search_charts(query, chart_type?, limit?)` | FTS tìm charts. Trả về `top_chart_data.rows` ngay — tránh round-trip thứ 2 |
| `run_chart(chart_id)` | Execute chart → stream `ChartEvent` để render inline |
| `execute_sql(datasource_id, sql, limit?)` | Raw SELECT. Chỉ SELECT, có rate-limit dòng |
| `query_table(workspace_id, table_id, dimensions, measures, ...)` | Aggregation query trên workspace table |

### LLM Decision Flow (system prompt)

```
1. search_charts(query)
   → top_chart_data.rows có dữ liệu? → đọc rows, analyze
   → không? → đến bước 2

2. execute_sql(datasource_id, select_query ORDER BY x DESC LIMIT 15)
   → đọc data[] rows, analyze

3. Viết phân tích chỉ dùng số từ rows[]
   ⚠ Rows có thể KHÔNG sort theo metric user hỏi → scan toàn bộ tìm MAX/MIN
```

### Fallback chain

Khi primary LLM fail → tự động thử từng entry trong `LLM_FALLBACK_CHAIN`.  
Cơ chế: wrap từng provider call trong try/except, iterate qua `_build_provider_chain()`.

### Feedback API

```
POST /chat/sessions/{session_id}/messages/{message_id}/feedback
Body: {"rating": "up" | "down", "comment": "..."}
```

Feedback lưu vào `Message.feedback` trong session (in-memory). Hiện chưa persist.

---

## 6. Frontend (`frontend/`)

### AI Chat UI (`src/components/ai-chat/`)

| File | Mục đích |
|---|---|
| `ChatPanel.tsx` | WebSocket state machine. Tạo/restore session. Handle tất cả events. |
| `ChatMessage.tsx` | Render bubble + ThinkingIndicator + charts + metrics bar + feedback buttons |
| `EmbeddedChart.tsx` | Render Recharts chart từ data nhận trong `ChartEvent` |
| `ThinkingIndicator.tsx` | Collapsible panel hiển thị thinking steps và tool calls |
| `ChatSessionList.tsx` | Sidebar list sessions (fetch từ `/chat/sessions`) |
| `ChatInput.tsx` | Input box + send button + stop button |
| `types.ts` | TypeScript types cho tất cả chat state |

### ChatPanel WebSocket state machine

```
mount → loadHistory() → connectWs()
                            │
                      onmessage → handleWsEvent()
                                      │
                        ┌─────────────┼─────────────────────────┐
                    thinking      tool_call/result         text / chart
                        │              │                        │
                    upsertCurrentAiMsg() ← luôn update by currentAiMsgIdRef.current
                                                               │
                                                           'done' event
                                                               │
                                                  upsertCurrentAiMsg() TRƯỚC
                                                  rồi mới null currentAiMsgIdRef
```

**Bug đã fix (March 19, 2026):** Race condition trong `done` handler — trước đây `currentAiMsgIdRef.current = null` xảy ra trước khi `upsertCurrentAiMsg` trong `done` handler có thể chạy, khiến metrics không hiển thị ở response có chart. Fix: gọi `upsertCurrentAiMsg` trước, sau đó mới null ref.

### Metrics bar UI

Hiển thị sau mỗi response AI hoàn chỉnh (`!message.isThinking && metrics`):

- Clock pill: latency (ms → s nếu > 1000)
- Wrench pill: số tool calls (warn màu vàng nếu = 0)
- Database pill: số rows analyzed (chỉ hiện nếu > 0)
- BarChart3 pill: "chart" badge (chỉ hiện nếu `has_chart = true`)
- model name (lấy từ `metrics.model.split('/').pop()`)
- Warning "no data" nếu `has_data_backing = false`
- Error count nếu `tool_errors > 0`

### Feedback

- ThumbsUp / ThumbsDown buttons hiện sau metrics bar
- Gọi `POST /chat/sessions/{session_id}/messages/{message_id}/feedback`
- Sau khi submit: icon đổi màu, lưu vào `message.feedback` local state

---

## 7. Demo Data (Football / FIFA)

Seed script `seed_demo.py` tạo:

- **1 Datasource** — Manual (từ `scope-foodball-demo.xlsx`)
- **6 Datasets** — FIFA Rankings, WC History, Top Scorers, Confederation Stats, WC vs Continental Titles, Country Performance
- **3 Dataset Workspaces** (9 tables):
  - *FIFA World Rankings* — computed: `Rank_Group`, `Conf_Power_Score`, `Points_Rating`
  - *World Cup & Continental Titles* — computed: `Title_Dominance`, `Points_Per_WC`, `WC_vs_Continental`
  - *Top Scorers Analysis* — computed: `Scorer_Tier`, `Goal_Era`
- **18 Charts** — Bar, Grouped Bar, Pie, KPI, Table, Line
- **3 Dashboards** với global filters

Chạy thủ công:
```bash
pip install requests openpyxl
python seed_demo.py
```

---

## 8. Những điểm cần xử lý tiếp

### Short-term

| Task | Mức độ | Ghi chú |
|---|---|---|
| Persist AI sessions vào PostgreSQL | Medium | Hiện in-memory → mất khi restart AI service |
| Populate `input_tokens`/`output_tokens` | Low | Các SDK provider đều trả về, chỉ cần parse |
| Unit tests cho orchestrator tool calls | Medium | Hiện chưa có test coverage cho ai-service |
| Rate limiting trên `/chat/ws` | Medium | Tránh abuse LLM API |
| SSL / HTTPS cho production deploy | High | Hiện chỉ HTTP |

### Medium-term

| Task | Ghi chú |
|---|---|
| Persist feedback vào PostgreSQL | Hiện feedback chỉ lifetime của session |
| Multi-turn context window management | Khi conversation quá dài → cần summary/truncation |
| Chart caching | `run_chart` luôn re-execute — nên cache kết quả N phút |
| More LLM tool: `list_dashboards`, `get_dashboard` | Cho phép AI answer về dashboard structure |
| Streaming token count từ Anthropic/Gemini | Để hiển thị token usage trong metrics bar |

### Known limitations

- **AI session TTL**: Default 30 phút. Nếu user không chat trong 30 phút, session bị xóa, reload page tạo session mới (lịch sử mất).
- **DuckDB concurrency**: Manual datasources dùng DuckDB in-process — không phù hợp cho > 10 concurrent users.
- **Docker build time**: Frontend build (`npm run build`) mất 2-4 phút do bundle size. Cải thiện bằng cách bật `standalone` output trong `next.config.js`.
- **execute_sql security**: Đã có `validate_select_only()` nhưng nên thêm row-limit enforcement ở service layer.

---

## 9. Lịch sử thay đổi gần đây

### March 19, 2026

- **AI Chat quality metrics system** — orchestrator emit `MetricsEvent` sau mỗi response hoàn chỉnh: latency, tool calls, rows analyzed, has_chart, has_data_backing, model/provider
- **Feedback API** — `POST /chat/sessions/{id}/messages/{msg_id}/feedback` — thumbs up/down + comment
- **ChatMessage metrics bar** — hiển thị pills với latency, tool count, rows, chart badge, model name, warning states
- **Bug fix: metrics/feedback không hiện ở response có chart** — race condition trong `done` handler: `currentAiMsgIdRef.current` bị null trước khi `upsertCurrentAiMsg` chạy. Fix: đổi thứ tự — gọi `upsertCurrentAiMsg` trước, null ref sau.
- **ThinkingIndicator** — rewrite để hỗ trợ collapsible activity panel với typing/tool steps

---

## 10. Tham khảo thêm

| File | Nội dung |
|---|---|
| `docs/AI_AGENT.md` | AI Agent: architecture, tools, embedding, knowledge system, known issues, roadmap |
| `docs/ARCHITECTURE.md` | Sơ đồ folder structure đầy đủ |
| `docs/API.md` | REST API reference cho BI Backend |
| `docs/CHART_STORAGE_AND_REUSE.md` | Chiến lược chart caching và reuse |
| `docs/DOCKER.md` | Docker configuration chi tiết |
| `docs/SETUP.md` | Setup guide cho local dev |
