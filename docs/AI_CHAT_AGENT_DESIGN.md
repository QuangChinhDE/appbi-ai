# AI Chat Agent — Design Document

> **Version**: 1.0 — Draft for Review  
> **Date**: March 15, 2026  
> **Status**: Pre-implementation review

---

## 1. Tổng quan / Overview

### Mục tiêu

Người dùng gõ câu hỏi bằng ngôn ngữ tự nhiên như:

> *"Cho tôi biết top 10 đội có điểm FIFA cao nhất"*  
> *"So sánh số World Cup titles giữa các confederation"*  
> *"Tổng số bàn thắng theo từng kỳ World Cup từ 1930 đến nay"*

AI Agent sẽ tự động:
1. **Hiểu ý định** — xác định loại dữ liệu cần tìm
2. **Tìm kiếm** — duyệt Charts, Workspaces, Datasets có trong hệ thống
3. **Thực thi** — chạy chart/query để lấy dữ liệu thực
4. **Tổng hợp** — phân tích data, viết phản hồi có ngữ cảnh
5. **Trả về** — text + chart embedded (user nhìn thấy chart trực tiếp trong chat)

### Nguyên tắc thiết kế

| Nguyên tắc | Mô tả |
|---|---|
| **Tách biệt hoàn toàn** | AI là microservice riêng — không chạm vào DB hiện tại, không sửa code BI |
| **Communicate qua API** | AI Service gọi sang BI Backend qua HTTP internal (Docker network) |
| **Zero impact khi build** | Có thể bật/tắt AI bằng 1 flag trong docker-compose — hệ thống BI vẫn chạy bình thường |
| **Streaming response** | LLM trả về từng token — user thấy phản hồi ngay, không phải chờ |
| **Tool-calling pattern** | LLM tự quyết định gọi tool nào, không hard-code logic phân tích |

---

## 2. Kiến trúc tổng thể / Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (User)                              │
│                                                                     │
│  ┌──────────────────┐          ┌──────────────────────────────┐    │
│  │  BI App :3000    │          │  /chat page  (new route)     │    │
│  │  (unchanged)     │          │  ChatPanel component          │    │
│  └──────────────────┘          └──────────────┬───────────────┘    │
└──────────────────────────────────────────────── │ ──────────────────┘
                                                  │ WebSocket / SSE
                                 ┌────────────────▼───────────────────┐
                                 │  AI Service  :8001                 │
                                 │  (NEW — Python FastAPI)             │
                                 │                                    │
                                 │  ┌─────────────┐                  │
                                 │  │ LLM Engine  │ (OpenAI/Claude)  │
                                 │  │ Tool Caller │                  │
                                 │  └──────┬──────┘                  │
                                 │         │ Tool calls               │
                                 │  ┌──────▼──────────────────────┐  │
                                 │  │    BI API Client             │  │
                                 │  │  (gọi backend:8000/api/v1)  │  │
                                 │  └──────────────────────────────┘  │
                                 └────────────────────────────────────┘
                                                  │ HTTP (internal Docker net)
                                 ┌────────────────▼───────────────────┐
                                 │  BI Backend  :8000                 │
                                 │  (UNCHANGED — read-only calls)     │
                                 │                                    │
                                 │  GET /api/v1/charts/               │
                                 │  GET /api/v1/charts/{id}/data      │
                                 │  GET /api/v1/dataset-workspaces/   │
                                 │  GET /api/v1/datasets/             │
                                 │  GET /api/v1/dashboards/           │
                                 └────────────────────────────────────┘
                                                  │
                                 ┌────────────────▼───────────────────┐
                                 │  PostgreSQL :5432  (unchanged)     │
                                 └────────────────────────────────────┘
```

### Điểm tách biệt quan trọng

- AI Service **KHÔNG** kết nối trực tiếp với PostgreSQL
- AI Service **CHỈ** đọc dữ liệu qua BI API — không bao giờ ghi (no POST/PUT/DELETE)
- Nếu `ai-service` container down → BI App hoạt động bình thường hoàn toàn
- `docker-compose.yml` của BI **KHÔNG** thay đổi — AI có file compose riêng

---

## 3. Cấu trúc thư mục / Directory Structure

```
Dashboard/
├── backend/                    # UNCHANGED
├── frontend/                   # MOSTLY UNCHANGED (chỉ thêm /chat route)
│   └── src/
│       ├── app/(main)/
│       │   └── chat/           # NEW — trang chat
│       │       └── page.tsx
│       └── components/
│           └── ai-chat/        # NEW — UI components
│               ├── ChatPanel.tsx
│               ├── ChatMessage.tsx
│               ├── ChatInput.tsx
│               ├── EmbeddedChart.tsx
│               └── ThinkingIndicator.tsx
│
├── ai-service/                 # NEW — hoàn toàn độc lập
│   ├── app/
│   │   ├── main.py             # FastAPI app
│   │   ├── config.py           # Settings (LLM API key, BI_API_URL, etc.)
│   │   ├── routers/
│   │   │   └── chat.py         # WebSocket + SSE endpoints
│   │   ├── agents/
│   │   │   ├── orchestrator.py # LLM conversation loop + tool dispatch
│   │   │   └── tools.py        # Tool definitions (search_charts, run_chart, …)
│   │   ├── clients/
│   │   │   └── bi_client.py    # HTTP client gọi BI Backend
│   │   └── schemas/
│   │       └── chat.py         # ChatMessage, ChatRequest, ToolCall, etc.
│   ├── Dockerfile
│   ├── requirements.txt
│   └── .env.example
│
├── docker-compose.yml          # UNCHANGED (BI only)
├── docker-compose.ai.yml       # NEW — chỉ thêm ai-service vào stack
└── docs/
    └── AI_CHAT_AGENT_DESIGN.md # This file
```

---

## 4. AI Service — Chi tiết thiết kế

### 4.1 Endpoints

```
POST   /chat          — single-turn Q&A (JSON response, không stream)
WS     /ws/chat       — WebSocket streaming (recommended)
GET    /sessions/{id} — lịch sử conversation
DELETE /sessions/{id} — xóa session
GET    /health        — health check
```

#### WebSocket protocol

```
Client → Server:
{
  "session_id": "abc-123",      // optional, tạo mới nếu không có
  "message": "Top 10 FIFA teams?",
  "context": {                  // optional hints
    "workspace_id": 1,
    "chart_ids": [5, 6]
  }
}

Server → Client (streamed events):
{ "type": "thinking",  "content": "Đang tìm kiếm charts liên quan..." }
{ "type": "tool_call", "tool": "search_charts", "args": {"q": "FIFA rankings"} }
{ "type": "tool_result", "tool": "search_charts", "count": 3 }
{ "type": "tool_call", "tool": "run_chart", "args": {"chart_id": 2} }
{ "type": "tool_result", "tool": "run_chart", "rows": 10 }
{ "type": "text",      "content": "Top 10 đội có điểm FIFA cao nhất:\n\n" }
{ "type": "text",      "content": "1. **Argentina** — 1947 điểm\n" }
{ "type": "chart",     "chart_id": 2, "chart_type": "bar", "data": [...] }
{ "type": "text",      "content": "\nArgentina dẫn đầu với..." }
{ "type": "done",      "session_id": "abc-123" }
```

### 4.2 Tool Definitions (LLM function calling)

AI được trang bị các tools sau:

#### Tool 1: `search_charts`
```
Mục đích: Tìm charts phù hợp với câu hỏi của user
Input:
  - query (string): từ khóa tìm kiếm
  - chart_type (optional): bar|line|pie|table|kpi|...
  - limit (default 10): số kết quả tối đa
Output:
  - Danh sách charts: [{id, name, description, chart_type, workspace_table_id}]
Calls BI API:
  → GET /api/v1/charts/?limit=50
  → lọc theo query (fuzzy match trên name + description)
```

#### Tool 2: `run_chart`
```
Mục đích: Thực thi chart và lấy data để AI phân tích
Input:
  - chart_id (int): ID của chart cần chạy
Output:
  - chart metadata: {id, name, chart_type, config}
  - rows: List[Dict] — data thực
  - row_count: int
  - columns: List[{name, type}]
Calls BI API:
  → GET /api/v1/charts/{chart_id}/data
```

#### Tool 3: `search_dashboards`
```
Mục đích: Tìm dashboard phù hợp
Input:
  - query (string)
Output:
  - [{id, name, description, chart_count}]
Calls BI API:
  → GET /api/v1/dashboards/
```

#### Tool 4: `list_workspace_tables`
```
Mục đích: Liệt kê các bảng dữ liệu trong workspace
Input:
  - workspace_id (optional int): nếu biết workspace cụ thể
Output:
  - workspaces: [{id, name, tables: [{id, display_name, columns}]}]
Calls BI API:
  → GET /api/v1/dataset-workspaces/
  → GET /api/v1/dataset-workspaces/{id} (để lấy tables)
```

#### Tool 5: `run_workspace_table`
```
Mục đích: Lấy data từ workspace table (khi không có chart phù hợp)
Input:
  - workspace_id (int)
  - table_id (int)
  - limit (default 200)
Output:
  - columns: List[{name, type}]
  - rows: List[Dict]
Calls BI API:
  → POST /api/v1/dataset-workspaces/{wid}/tables/{tid}/preview
      body: {"limit": 200}
```

#### Tool 6: `get_data_summary`
```
Mục đích: Lấy thông tin schema/metadata mà không cần chạy query nặng
Input:
  - chart_id (optional)
  - workspace_table_id (optional)
Output:
  - column names + types
  - sample stats (min/max/count cho numeric)
Xử lý: AI Service tự tính từ data trả về của run_chart/run_workspace_table
```

### 4.3 LLM Orchestration — Conversation Loop

```
User message
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  System Prompt (injected once per session)          │
│                                                     │
│  Bạn là AI analyst cho hệ thống AppBI.              │
│  Hệ thống có các charts, workspaces, datasets.      │
│  Khi user hỏi về dữ liệu:                           │
│  1. Dùng search_charts để tìm chart phù hợp        │
│  2. Dùng run_chart để lấy dữ liệu thực              │
│  3. Phân tích data và trả lời có số liệu cụ thể     │
│  4. Luôn kèm chart_id để frontend render chart      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────┐
         │  LLM API Call   │ (OpenAI gpt-4o / Claude 3.5)
         │  with tools     │
         └────────┬────────┘
                  │
          ┌───────▼──────────┐
          │ Tool call? ──Yes──► Execute tool → append result
          │              ▲                          │
          │              └──────────────────────────┘
          │ No (final response)
          └──► Stream text + chart references to client
```

**Max iterations**: 8 tool calls per user message để tránh infinite loop  
**Timeout**: 30 giây per tool call  

### 4.4 Session & Memory

```python
# In-memory session store (đủ cho MVP)
sessions: Dict[str, ConversationSession] = {}

class ConversationSession:
    session_id: str
    messages: List[Message]      # full conversation history
    created_at: datetime
    last_active: datetime
    context_hint: dict           # workspace_id, chart_ids user đang xem
```

- Session tồn tại **30 phút** sau lần cuối active
- Conversation history được gửi kèm mỗi LLM call (sliding window 20 messages)
- **Phase 2** (optional): persist sessions vào Redis hoặc PostgreSQL AI DB riêng

---

## 5. Frontend — Chi tiết thiết kế

### 5.1 Trang `/chat`

Layout kiểu chat toàn màn hình, chia 2 panel:

```
┌────────────────────────────────────────────────────────┐
│  AppBI  [Dashboards] [Explore] [Chat ✨] ...           │  ← Navbar (thêm 1 link)
├──────────────────────────┬─────────────────────────────┤
│                          │                             │
│   CHAT PANEL (left)      │  CONTEXT PANEL (right)      │
│                          │                             │
│  ┌────────────────────┐  │  Hiện workspace/dashboard   │
│  │  AI: Xin chào!     │  │  đang được đề cập           │
│  │  Tôi có thể giúp…  │  │                             │
│  └────────────────────┘  │  [Quick filters]            │
│                          │  ☐ FIFA Rankings WS         │
│  ┌────────────────────┐  │  ☐ WC History WS            │
│  │  You: Top 10 FIFA? │  │                             │
│  └────────────────────┘  │                             │
│                          │                             │
│  ┌────────────────────┐  │                             │
│  │ AI: 🔍 Searching…  │  │                             │
│  │ ▓ Đang chạy chart  │  │                             │
│  │                    │  │                             │
│  │ Top 10 FIFA Teams: │  │                             │
│  │ 1. Argentina 1947  │  │                             │
│  │                    │  │                             │
│  │  [BAR CHART HERE]  │  │                             │
│  │  ┌──────────────┐  │  │                             │
│  │  │ ████         │  │  │                             │
│  │  │ ███          │  │  │                             │
│  │  └──────────────┘  │  │                             │
│  │                    │  │                             │
│  │ Argentina dẫn đầu… │  │                             │
│  └────────────────────┘  │                             │
│                          │                             │
│  [Type your question…] ► │                             │
└──────────────────────────┴─────────────────────────────┘
```

### 5.2 Component Tree

```
/chat/page.tsx
└── ChatPage
    ├── ChatPanel
    │   ├── MessageList (scrollable)
    │   │   ├── ChatMessage (type=text)
    │   │   ├── ChatMessage (type=thinking)  ← pulse animation
    │   │   ├── ChatMessage (type=tool_call) ← tool progress
    │   │   └── ChatMessage (type=mixed)
    │   │       ├── MarkdownText
    │   │       └── EmbeddedChart            ← REUSE existing Recharts components
    │   └── ChatInput
    │       ├── Textarea (auto-resize)
    │       └── SendButton (loading state)
    └── ContextPanel (collapsible)
        ├── WorkspaceSelector
        └── QuickQuerySuggestions
```

### 5.3 EmbeddedChart Component

Chart trong chat **tái sử dụng toàn bộ** Recharts components đã có sẵn trong BI frontend. Không viết lại chart rendering.

```tsx
// Reuse existing chart component, inject data từ AI response
<EmbeddedChart
  chartType={event.chart_type}   // "bar" | "line" | "pie" | ...
  data={event.data}              // rows từ run_chart tool
  config={event.config}         // explore_config: {roleConfig: {dimension, metrics}}
  height={280}
  actionButton={
    <Link href={`/explore/${event.chart_id}`}>
      Mở trong Explore →
    </Link>
  }
/>
```

### 5.4 Streaming WebSocket Client

```typescript
// Pseudo-code
const ws = new WebSocket(`ws://localhost:8001/ws/chat`);

ws.send(JSON.stringify({
  session_id: sessionId,
  message: userInput,
  context: { workspace_id: activeWorkspaceId }
}));

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'thinking':   appendThinkingIndicator(msg.content); break;
    case 'tool_call':  showToolCallBadge(msg.tool); break;
    case 'tool_result':updateToolCallResult(msg.tool, msg); break;
    case 'text':       appendStreamingText(msg.content); break;
    case 'chart':      appendEmbeddedChart(msg); break;
    case 'done':       finalizeMessage(); break;
    case 'error':      showError(msg.content); break;
  }
};
```

---

## 6. Docker — Cấu hình tách biệt

### 6.1 `docker-compose.ai.yml` (file mới, độc lập)

```yaml
version: "3.8"

services:
  ai-service:
    build:
      context: .
      dockerfile: ai-service/Dockerfile
    container_name: appbi-ai
    ports:
      - "${AI_PORT:-8001}:8001"
    environment:
      BI_API_URL: "http://backend:8000/api/v1"   # internal Docker net
      LLM_PROVIDER: "${LLM_PROVIDER:-openai}"    # openai | anthropic
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
      LLM_MODEL: "${LLM_MODEL:-gpt-4o-mini}"
      AI_SESSION_TTL_MINUTES: "30"
      LOG_LEVEL: "${LOG_LEVEL:-INFO}"
    networks:
      - appbi-net                                 # join same network as backend
    depends_on:
      - backend
    restart: unless-stopped

networks:
  appbi-net:
    external: true                               # dùng network của BI stack
```

### 6.2 Khởi động

```bash
# Bật BI stack như bình thường (không thay đổi)
docker compose up -d

# Bật AI service riêng (opt-in)
docker compose -f docker-compose.ai.yml up -d

# Tắt AI service (BI vẫn chạy)
docker compose -f docker-compose.ai.yml down

# Bật cả 2 cùng lúc (convenience)
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d
```

### 6.3 `.env` bổ sung cho AI

```env
# AI Service settings (thêm vào .env, không ảnh hưởng BI)
AI_PORT=8001
LLM_PROVIDER=openai          # openai | anthropic
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=           # optional
LLM_MODEL=gpt-4o-mini        # gpt-4o | gpt-4o-mini | claude-3-5-sonnet-20241022
```

---

## 7. Luồng xử lý ví dụ / Example Flow

**User hỏi**: *"Top 5 cầu thủ ghi bàn nhiều nhất trong lịch sử World Cup là ai?"*

```
[1] User gửi message qua WebSocket
        │
[2] AI Service nhận, tạo system prompt với tools
        │
[3] LLM (gpt-4o-mini) nhận message, quyết định gọi tool:
    → tool_call: search_charts(query="World Cup top scorers goals")
        │
[4] AI Service stream event: {"type": "tool_call", "tool": "search_charts"}
        │
[5] bi_client.get("/charts/") → lọc → trả về:
    [
      {id: 11, name: "Top Scorers — Goals Scored", chart_type: "bar"},
      {id: 12, name: "Top Scorers Table",          chart_type: "table"}
    ]
        │
[6] LLM nhận kết quả search, quyết định gọi tool:
    → tool_call: run_chart(chart_id=11)
        │
[7] AI Service stream event: {"type": "tool_call", "tool": "run_chart"}
        │
[8] bi_client.get("/charts/11/data") → trả về rows:
    [
      {"Player": "Miroslav Klose", "Goals": 16, "Country": "Germany"},
      {"Player": "Ronaldo",        "Goals": 15, "Country": "Brazil"},
      ...
    ]
        │
[9] LLM có đủ data, bắt đầu generate response:
    Stream: "Top 5 cầu thủ ghi bàn nhiều nhất lịch sử World Cup:\n\n"
    Stream: "1. **Miroslav Klose** (Đức) — 16 bàn\n"
    Stream: "2. **Ronaldo** (Brazil) — 15 bàn\n"
    ...
        │
[10] LLM kết thúc text response, đính kèm chart:
     {"type": "chart", "chart_id": 11, "chart_type": "bar", "data": [...]}
        │
[11] LLM tiếp tục phân tích:
     Stream: "\nKlose là cầu thủ duy nhất tham dự **4 kỳ World Cup**..."
        │
[12] {"type": "done"}
        │
[13] Frontend render:
     ✅ Text analysis với số liệu cụ thể
     ✅ Bar chart embedded hiển thị top scorers
     ✅ Link "Mở trong Explore →" để deep-dive
```

---

## 8. AI Service Dependencies

```txt
# ai-service/requirements.txt
fastapi==0.115.0
uvicorn[standard]==0.34.0
websockets==13.0
httpx==0.28.0          # async HTTP client to call BI API
openai==1.58.0         # OpenAI SDK (tool calling)
anthropic==0.40.0      # Anthropic SDK (Claude tool use)
pydantic==2.10.0
python-dotenv==1.0.0
```

**Không dùng LangChain** — implement tool-calling loop trực tiếp với OpenAI/Anthropic SDK để kiểm soát tốt hơn và dependency nhẹ hơn.

---

## 9. Security Considerations

| Risk | Mitigation |
|---|---|
| AI gọi write APIs (POST/PUT/DELETE) | bi_client chỉ implement GET methods, không expose write |
| Prompt injection từ data BI trả về | Sanitize tool results trước khi đưa vào LLM context |
| LLM API key bị leak | Key chỉ trong `.env`, không bao giờ trả về qua API |
| Session isolation | Mỗi session_id độc lập, không cross-contaminate |
| Rate limiting | Max 10 req/phút/session để tránh API cost runaway |

---

## 10. Phân tích Use Cases / What AI Can & Cannot Do

### ✅ AI làm được

| Use Case | Ví dụ |
|---|---|
| Query saved charts | "Top 10 FIFA rankings chart cho tôi xem" |
| Cross-chart analysis | "So sánh điểm trung bình giữa UEFA và CONMEBOL" |
| Data summary | "Có bao nhiêu đội trong Top 25?" |
| Trend analysis | "Tổng goals World Cup tăng hay giảm qua các thập kỷ?" |
| Find relevant dashboard | "Dashboard nào liên quan đến World Cup?" |
| Multi-step reasoning | "Đội nào vừa lọt Top 10 FIFA vừa có nhiều WC titles nhất?" |

### ❌ AI không làm (ngoài phạm vi v1)

| Limitation | Lý do |
|---|---|
| Tạo chart mới | AI Service không có write access |
| Query ngoài dữ liệu đã có | Chỉ làm việc với charts/tables đã exist trong hệ thống |
| Nhớ thông tin qua session | Session expire sau 30 phút |
| Multi-user collaboration | Mỗi session là độc lập |

---

## 11. Phân giai đoạn / Phased Rollout

### Phase 1 — MVP (recommend implement trước)

- [ ] `ai-service/` — FastAPI + WebSocket endpoint + tool loop
- [ ] Tools: `search_charts`, `run_chart`, `list_workspace_tables`, `run_workspace_table`
- [ ] In-memory session store
- [ ] Frontend: `/chat` page với ChatPanel + EmbeddedChart (reuse Recharts)
- [ ] `docker-compose.ai.yml` — deploy độc lập
- [ ] Support **OpenAI gpt-4o-mini** (cost-effective)

### Phase 2 — Enhanced

- [ ] Tool: `search_dashboards` — gợi ý mở dashboard liên quan
- [ ] Tool: `get_column_stats` — AI tự tính min/max/mean từ data
- [ ] Persistent sessions (Redis)
- [ ] Support Anthropic Claude
- [ ] Chat history UI (lưu recent conversations)
- [ ] Floating chat widget (icon góc phải, không cần vào `/chat` page)

### Phase 3 — Advanced

- [ ] AI tự tạo Explore config (ad-hoc chart mà user chưa save)
- [ ] Export conversation as PDF report
- [ ] Scheduled insights (AI tự chạy và gửi email/Slack)

---

## 12. Câu hỏi cần review / Open Questions

1. **LLM Provider**: OpenAI hay Anthropic? Budget per month?
2. **Ngôn ngữ response**: AI nên trả lời tiếng Việt hay tiếng Anh? Hay tự detect?
3. **Session persistence**: In-memory (restart mất history) có acceptable không ở v1?
4. **Floating widget vs /chat page**: Muốn chat nằm trong layout BI (sidebar/modal) hay trang riêng?
5. **Tool scope**: Có cho AI đọc raw workspace table data không (có thể tốn nhiều token nếu table lớn)?
6. **Auth**: Hệ thống hiện tại không có auth — AI cũng không cần auth? Hay thêm simple API key?
