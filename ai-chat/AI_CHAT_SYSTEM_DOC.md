# AI Chat System — Tài liệu kỹ thuật thực tế

> **Phiên bản:** 2.0 (post-upgrade)  
> **Cập nhật:** 2026-04-12  
> **Mục đích:** Review kiến trúc thực tế trước khi tiếp tục nâng cấp  
> **Trạng thái tổng thể:** Đang hoạt động — chưa ổn định ở tầng phân tích sâu

---

## 1. Vị trí hiện tại trên Capability Ladder

```
Tầng 5 — Hyper Personalization          ❌ Chưa có
Tầng 4 — Augmentation & Automation      ❌ Chưa có  
Tầng 3 — Advanced Analytics             🟡 Có cơ sở (InsightAgent) nhưng chưa ổn định
Tầng 2 — Pattern Recognition            🟡 explain_insight có, anomaly detection chưa có
Tầng 1 — Exploration & Discovery        ✅ Hoạt động, vừa fix explore_data total_rows
```

---

## 2. Kiến trúc hiện tại — Single Orchestrator với Intent Routing

```
User message (WebSocket /ws hoặc POST /stream)
        │
        ▼
[Rate Limiter] ─── check "default" intent ─── 429 nếu > 100 req/hour
        │
        ▼
[Intent Classifier]
  ├── Keyword pre-filter (instant, no LLM)
  └── LLM fallback (cheap model, 60 tokens)
        │
        ├── VAGUE   ──→ clarification question (không gọi tool)
        ├── LOOKUP  ──→ AgentConfig(max_tokens=512,  tools=6, force_tool=True)
        ├── EXPLORE ──→ AgentConfig(max_tokens=1024, tools=5, force_tool=True)
        ├── INSIGHT ──→ AgentConfig(max_tokens=3000, tools=8, force_tool=False)
        └── CREATE  ──→ AgentConfig(max_tokens=1024, tools=4, force_tool=True)
                │
                ▼
        [Context Builder]
          ├── Vector search: top 5 tables + top 5 charts
          └── Fallback: enumerate all (hard cap 50 tables)
                │
                ▼
        [Orchestrator — run_agent()]
          ├── Build turn context (scope + schema)
          ├── Select provider chain
          └── Provider loop (OpenAI / Anthropic / Gemini)
                │
          ┌─────┴─────────────────────────────┐
          ▼                                   ▼
    [LLM Call]                          [Tool Execution]
    max_tokens: dynamic                 execute_tool()
    tool_choice: required/auto          scope enforcement
    stream=True (OpenAI/Gemini)         result truncation (50 rows)
    stream=False (Anthropic)
          │
          ▼ (repeat up to tool_call_limit times)
          │
    [Metrics Event]                     [Suggestions Event]
    input_tokens, output_tokens         3 follow-up questions
    tool_calls, latency                 (non-blocking)
          │
          ▼
    [Done Event]
```

### So sánh với target architecture (ảnh 2)

| Component (target) | Hiện tại | Trạng thái |
|---|---|---|
| BI Orchestrator Agent | `orchestrator.py` — `run_agent()` | ✅ Có |
| Context Understanding Agent | `intent_classifier.py` | ✅ Có (hybrid keyword+LLM) |
| Analytical Thinking Agent | `insight_agent.py` — config only | 🟡 Config đúng, logic chưa deep |
| Data Processing Agent | `query_agent.py` — config only | 🟡 Config có, không có dedicated loop |
| Analysis & Viz Agent | `viz_agent.py` — config only | 🟡 Config có |
| Insight & Story Agent | `PROMPT_INSIGHT` | 🟡 Prompt narrative, chưa có narrative enforcer |
| Governance Agent | `governance.py` — `RateLimiter` | ✅ Rate limit + token budget |
| Feedback & Learning Agent | `feedback_analyzer.py` | 🟡 Logic có, chưa wired mặc định |
| Dashboard Agent | Không có | ❌ Chưa có |
| Business Domain Agent | Không có | ❌ Chưa có |

> **Vấn đề kiến trúc:** Các "specialized agent files" (`query_agent.py`, `insight_agent.py`, v.v.) hiện tại chỉ là **configuration constants** — không có dedicated loop riêng. Tất cả vẫn chạy qua cùng một `_openai_loop` / `_anthropic_loop`. Sự "chuyên biệt" chỉ là khác system prompt + tool set.

---

## 3. Intent Classifier — Chi tiết

### 3.1 Keyword Pre-filter (instant, no LLM)

```python
# Kiểm tra theo thứ tự này:
1. INSIGHT keywords: tại sao, vì sao, lý do, giải thích, why, explain,
                     nguyên nhân, xu hướng, trend, so sánh, biến động,
                     drop, spike, anomaly, phân tích sâu, deep dive
2. CREATE keywords:  tạo, create, build, vẽ, draw, make, generate,
                     biểu đồ, chart, dashboard, add chart
3. EXPLORE keywords: có gì, gồm gì, cấu trúc, dữ liệu gì, what data,
                     what columns, describe, mô tả, tổng quan, overview,
                     schema, cột nào, tell me about
4. LOOKUP keywords:  top, bao nhiêu, count, tổng, sum, max, min,
                     cao nhất, thấp nhất, xếp hạng, tỷ lệ, %, doanh thu
5. VAGUE patterns:   regex ^(phân tích|analyze)\.?$, words ≤ 2 với no keyword
```

**Test accuracy: 14/14 test cases (>90%) — verified 2026-04-11**

### 3.2 LLM Fallback (cho câu ambiguous)

- Model: cùng model với chat (không dùng model riêng)
- Max tokens: 60
- Temperature: 0.0
- Prompt: `_CLASSIFY_SYSTEM` — định nghĩa 5 categories + examples
- Timeout: 45s (dùng chung với LLM_TIMEOUT)

### 3.3 Config presets

| Intent | max_tokens | tool_limit | force_first_tool | Tool set |
|--------|-----------|-----------|-----------------|---------|
| LOOKUP | 512 | 6 | True | search_charts, run_chart, search_dashboards, inspect_dashboard, list_dataset_tables, query_table |
| EXPLORE | 1024 | 5 | True | list_dataset_tables, run_dataset_table, explore_data, search_charts, search_dashboards, inspect_dashboard |
| INSIGHT | 3000 | 15 | **False** | list_dataset_tables, query_table, explore_data, explain_insight, search_charts, run_chart, search_dashboards, inspect_dashboard |
| CREATE | 1024 | 8 | True | list_dataset_tables, create_chart, create_dashboard, query_table |
| VAGUE | 256 | 0 | False | (không dùng tools) |

### 3.4 Vấn đề đã biết của Intent Classifier

```
Vấn đề 1: Classify bằng LLM dùng cùng provider/model chính
  → Nếu model chính down/timeout, intent classify cũng fail
  → Fallback: default về LOOKUP (an toàn nhất)

Vấn đề 2: Rate limit check dùng "default" intent (pre-classification)
  → INSIGHT chỉ bị giới hạn 10/hour NHƯNG check thực tế là "default" 100/hour
  → Per-intent rate limit chưa thực sự hoạt động

Vấn đề 3: Không có carryover intent
  → Mỗi turn re-classify độc lập
  → User follow-up "vậy còn team B?" sau INSIGHT turn → có thể classify LOOKUP
```

---

## 4. Context Builder — Chi tiết

### 4.1 Flow

```python
async def build_context(user_message, token, dataset_id=None):
    # 1. Nếu có dataset_id: load tables từ dataset đó
    if dataset_id:
        scoped_tables = bi_client.get_dataset(dataset_id)  # hard boundary

    # 2. Vector search (ưu tiên)
    table_hits = bi_client.search_similar_tables(user_message, limit=5)
    if dataset_id: filter table_hits by dataset_id
    pkg.tables = [t for t if t.similarity >= 0.3]

    # 3. Chart search
    if dataset_id and scoped_tables:
        charts = bi_client.list_charts(limit=200)  # ← DÙNG FUZZY MATCH
        scored = [(fuzzy_score(user_message, chart.name), chart) ...]
    else:
        chart_hits = bi_client.search_similar_charts(user_message, limit=5)

    # 4. Fallback nếu không có tables từ vector search
    if not pkg.tables:
        if dataset_id → dùng scoped_tables[:5]
        else → enumerate ALL datasets (hard cap 50 tables)
```

### 4.2 Output format (inject vào system prompt)

```markdown
## DATA SCHEMA (relevant to this query)

### Dataset Tables
- **customer_onboarding** (dataset_id=1, table_id=1)
  Description: Thông tin onboarding khách hàng
  Columns: user_id:integer (range: 1–999999),
           status:varchar (values: 'Active', 'Pending', 'Suspended'),
           email:varchar,
           created_at:timestamp

### Pre-built Charts
- **Tỷ lệ trạng thái người dùng** (chart_id=5, type=PIE)
```

### 4.3 Vấn đề của Context Builder

```
Vấn đề 1: Chart search cho scoped dataset dùng FUZZY MATCH (word overlap)
  → Không dùng vector search khi dataset_id có sẵn
  → "revenue growth" sẽ không match chart tên "Doanh thu tăng trưởng"
  → Fix: cần dùng vector search cho charts dù có dataset_id

Vấn đề 2: list_charts(limit=200) cho toàn hệ thống
  → Load 200 charts rồi filter → lãng phí bandwidth
  → Nên filter by dataset_id ở API level

Vấn đề 3: column_stats không phải lúc nào cũng có
  → Nếu không có column_stats: chỉ show "col_name:type" không có sample values
  → AI không biết actual values → filter sai nhiều hơn
```

---

## 5. Tools — Chi tiết toàn bộ

### 5.1 Tool Inventory

| Tool | Inputs | Output key | Ghi chú |
|------|--------|-----------|---------|
| `search_charts` | query, chart_type?, limit? | charts[], top_chart_data? | Auto-execute top chart |
| `run_chart` | chart_id | rows[], row_count | Chart render tự động |
| `search_dashboards` | query | dashboards[] | |
| `inspect_dashboard` | dashboard_id | chart_count, charts[] | |
| `list_dataset_tables` | dataset_id? | datasets[{tables[{columns[]}]}] | Single source of truth |
| `query_table` | dataset_id, table_id, dimensions?, measures[], filters?, order_by?, limit?, date_bucket? | rows[], row_count | Measure alias: field_function |
| `run_dataset_table` | dataset_id, table_id, limit? | rows[], row_count | Tối đa 50 rows |
| `create_chart` | name, dataset_id, table_id, chart_type, config, save? | chart_id, rows[] | |
| `explore_data` | dataset_id, table_id, analysis_type?, focus_columns? | total_rows, columns[], column_stats{} | **Vừa fix: now includes total_rows** |
| `explain_insight` | dataset_id, table_id, metric_column, aggregation, time_column?, comparison?, dimension_columns[] | periods{change_pct}, drill_downs[] | |
| `create_dashboard` | topic, tables[], chart_count? | dashboard_id, chart_count | |

### 5.2 explore_data — Vừa fix (2026-04-12)

```python
# TRƯỚC: chỉ có sample_rows (tối đa 50)
return {
    "sample_rows": 50,
    "note": "Stats based on sample of up to 50 rows",
    ...
}

# SAU: lấy total_rows thực từ COUNT query
count_result = bi_client.execute_table_query(
    measures=[{"field": columns[0], "function": "count"}], limit=1
)
total_rows = count_result["rows"][0][f"{columns[0]}_count"]

return {
    "total_rows": 1247,  # ← số thực
    "note": "Column stats from 50-row sample. Total dataset: 1247 rows.",
    ...
}
```

### 5.3 Vấn đề của Tools

```
Vấn đề 1: date_bucket trong query_table
  → Schema đã thêm, nhưng backend có xử lý không phụ thuộc API backend
  → Chưa có test xác nhận

Vấn đề 2: explain_insight cần time_column
  → Nếu dataset không có date column → explain_insight gọi sai → error
  → Model không luôn luôn biết cột nào là date
  → Cần guide model check với explore_data trước

Vấn đề 3: search_charts luôn fetch top_chart_data
  → Dù model không dùng data đó → lãng phí ~500-2000 tokens/call
  → Không có option để skip data fetching

Vấn đề 4: query_table limit mặc định = 20 rows
  → Nếu user hỏi "top 50" và không set limit → chỉ nhận 20 rows → sai
  → Model cần explicitly set limit theo yêu cầu
```

---

## 6. Prompts — Nội dung thực tế

### 6.1 BASE_SYSTEM_PROMPT (~4,363 chars)

**Sections:**
1. Dataset scope boundary — hard boundary nếu có Active Dataset
2. Tool Reference — tất cả 11 tools và mô tả
3. ABSOLUTE RULES — không fabricate, luôn dùng Vietnamese, gọi tool trước
4. DATA QUALITY RULES:
   - Boolean columns = STRING ('0'/'1' hoặc 'TRUE'/'FALSE')
   - Ratio/% → GROUP BY category column
   - Column matching: "project" → project_name, "người" → assignee
   - Chart data relevance check
   - ORDER BY dùng aliased measure name

### 6.2 Prompt kích thước và đặc điểm

| Prompt | Size | Token ước tính | Đặc trưng |
|--------|------|---------------|----------|
| BASE | 4,363 chars | ~1,100 | Shared base |
| LOOKUP | 5,403 chars | ~1,350 | Bullet format, fast |
| EXPLORE | ~5,800 chars | ~1,450 | Business context, total rows |
| INSIGHT | 7,043 chars | ~1,760 | Narrative mode, 7-step plan |
| VIZ | 5,968 chars | ~1,490 | Chart type guide |

**Chi phí prompt riêng trước khi user gõ 1 chữ:**
- LOOKUP: ~1,350 tokens base + ~1,000 tool schemas + context = **~3,000-4,000 input tokens**
- INSIGHT: ~1,760 tokens base + ~1,000 tool schemas + context = **~3,500-4,500 input tokens**
- Actual đo được trong session `ddb5efa9`: **6,734 input tokens** cho câu EXPLORE đơn giản

### 6.3 Vấn đề của Prompts

```
Vấn đề 1: Prompt quá dài → đắt
  → EXPLORE prompt 5,800 chars → ~1,450 tokens chỉ cho system
  → Cộng tool schemas (~1,000) + context (~2,000) + history = ~5,000+ input/turn
  → Với gpt-4o-mini: ~$0.001/turn; với GPT-4o: ~$0.015/turn
  → Với INSIGHT + 15 tool calls: có thể lên ~$0.05-0.10/turn

Vấn đề 2: Tool Reference lặp trong BASE + mỗi intent prompt
  → BASE đã có tool reference
  → Lookup/Explore/Insight prompt lại describe tools lần nữa trong decision flow
  → Không cần thiết, tốn tokens

Vấn đề 3: INSIGHT prompt có investigation plan nhưng không enforce
  → Prompt nói "do NOT write final answer until 3 queries"
  → Nhưng không có cơ chế kỹ thuật enforce điều này
  → Model vẫn có thể trả lời sau 1 query nếu tự tin
```

---

## 7. Orchestrator Loop — Chi tiết kỹ thuật

### 7.1 `_openai_loop` flow

```python
while tool_calls_made <= tool_call_limit:
    # 1. Build message list (trim to 20 messages)
    llm_messages = _to_llm_messages(session, system_prompt=config.system_prompt)
    
    # 2. LLM call với streaming
    response = client.chat.completions.create(
        model=model,
        messages=llm_messages,
        tools=active_tools,       # filtered by intent
        tool_choice="required" if turn==0 and force_first else "auto",
        stream=True,
        temperature=0.2,
        max_tokens=config.max_tokens,  # 512-3000 dynamic
        stream_options={"include_usage": True},  # token counting
        timeout=45s
    )
    
    # 3. Stream chunks → TextEvent + collect tool calls
    async for chunk in response:
        if chunk.usage: extract input/output tokens  # ← Phase 1 fix
        if delta.content: yield TextEvent(content)
        if delta.tool_calls: accumulate tool call args
    
    # 4. Execute tool calls
    for tc in collected_tool_calls:
        tool_result = await execute_tool(name, args, token, scope)
        stored = _truncate_tool_result(tool_result)  # ← max 50 rows
        session.messages.append(Message(role="tool", content=json.dumps(stored)))
        yield ToolCallEvent + ToolResultEvent
    
    # 5. Check limit
    if tool_calls_made >= tool_call_limit:
        session.messages.append(Message("user", "[System: max tool calls reached. Provide final answer]"))
        break
```

### 7.2 Vấn đề kỹ thuật của Loop

```
Vấn đề 1: Message history ghi cả tool calls
  → Mỗi round trip: assistant msg (with tool_calls) + N tool result msgs
  → Với 15 tool calls: 30+ messages mới trong 1 turn
  → _trim_history(max=20) sẽ cắt hầu hết context của turn hiện tại
  → Model mất context của queries trước → có thể query trùng

Vấn đề 2: temperature=0.2 cho tất cả intents
  → Tốt cho LOOKUP (precise)
  → Quá thấp cho INSIGHT (cần creative synthesis)
  → INSIGHT nên dùng temperature=0.4-0.6

Vấn đề 3: Anthropic dùng non-streaming
  → _anthropic_loop: stream=False → đợi toàn bộ response trước khi yield
  → UX: user thấy blank screen cho đến khi LLM xong
  → OpenAI: token by token streaming → UX tốt hơn nhiều

Vấn đề 4: Gemini không thể rebuild tool history
  → Sau trim_history, tool_call/tool_result pairs bị mất
  → Gemini nhận context truncated → không biết gì đã query
  → Có thể re-query cùng thing nhiều lần
```

### 7.3 Message History Management

```python
def _trim_history(messages, max_messages=20):
    if len(messages) <= max_messages:
        return messages
    trimmed = messages[-max_messages:]
    # Advance until first 'user' message (safe starting point)
    for i, m in enumerate(trimmed):
        if m.role == "user":
            return trimmed[i:]
    return trimmed
```

**Vấn đề với 20 message limit + tool calls:**
- 1 turn INSIGHT với 10 tool calls = 1 (user) + 10 (assistant w/ tool_calls) + 10 (tool results) + 1 (assistant final) = 22 messages
- Nếu conversation có 2 INSIGHT turns: 44 messages → trim_history cắt phần lớn turn 1
- Model quên data đã query ở turn trước → hỏi lại

---

## 8. Governance — Trạng thái thực tế

### 8.1 Rate Limiter

```python
_RATE_LIMITS = {
    "LOOKUP":  (60,  3600),  # 60 req/hour
    "EXPLORE": (30,  3600),  # 30 req/hour
    "INSIGHT": (10,  3600),  # 10 req/hour
    "CREATE":  (20,  3600),  # 20 req/hour
    "VAGUE":   (100, 3600),  # 100 req/hour
    "default": (100, 3600),  # pre-classification check
}
```

**Vấn đề quan trọng:** Rate limit check trong WebSocket handler dùng `"default"` (100/hour), KHÔNG dùng intent cụ thể. Intent-specific limits ghi vào `_RATE_LIMITS` nhưng chưa được check trong WebSocket flow.

### 8.2 Token Budget

```python
_TOKEN_BUDGET_WARN  = 15_000  # warning log
_TOKEN_BUDGET_ALERT = 50_000  # critical log
# → Không block request, chỉ log
```

### 8.3 Session Usage

```python
# Estimated cost formula (GPT-4o-mini proxy):
cost = (input_tokens / 1_000_000) * 0.15 + (output_tokens / 1_000_000) * 0.60
```

### 8.4 Thực tế từ session `ddb5efa9`

- input_tokens: 6,734 | output_tokens: 534
- Estimated cost: (6734/1M)*0.15 + (534/1M)*0.60 ≈ **$0.001 per turn**
- Model: gpt-4o-mini → tạm chấp nhận được
- Nếu dùng GPT-4o ($5/$15 per 1M): **$0.034 per turn** → 1 conversation INSIGHT (10 turns) = ~$0.34

---

## 9. API Endpoints

### 9.1 Danh sách đầy đủ

| Method | Path | Mô tả | Auth |
|--------|------|--------|------|
| WS | `/chat/ws?token=...` | WebSocket streaming | JWT query param |
| POST | `/chat/stream` | REST SSE streaming | Bearer |
| GET | `/chat/sessions` | List sessions (DB) | Bearer |
| POST | `/chat/sessions` | Create session | Bearer |
| GET | `/chat/sessions/{id}` | Session detail + messages | Bearer |
| DELETE | `/chat/sessions/{id}` | Delete session | Bearer |
| POST | `/chat/sessions/{id}/messages/{mid}/feedback` | Rate message | Bearer |
| POST | `/chat/cleanup` | Remove expired sessions | Bearer |
| GET | `/chat/usage/{session_id}` | Token usage + cost | Bearer |
| GET | `/chat/rate-limits` | Rate limit status | Bearer |
| GET | `/chat/initial-suggestions?session_id=...` | Starter questions | Bearer |
| GET | `/chat/admin/feedback-stats` | Satisfaction analytics | Bearer |
| POST | `/chat/admin/feedback-reload` | Reload feedback cache | Bearer |

### 9.2 WebSocket Message Protocol

**Client → Server:**
```json
{"type": "message", "message": "...", "session_id": "...", "context": {"dataset_id": 1}}
{"type": "cancel"}
```

**Server → Client (event stream):**
```json
{"type": "thinking",     "content": "Đang phân tích câu hỏi..."}
{"type": "tool_call",    "tool": "query_table", "args": {...}}
{"type": "tool_result",  "tool": "query_table", "summary": "150 rows (aggregated)"}
{"type": "text",         "content": "Doanh thu tháng 3..."}
{"type": "chart",        "chart_id": 5, "chart_type": "BAR", "data": [...]}
{"type": "metrics",      "input_tokens": 6734, "output_tokens": 534, "tool_calls": [...], "intent": "LOOKUP"}
{"type": "suggestions",  "suggestions": ["Câu hỏi 1?", "Câu hỏi 2?"]}
{"type": "done",         "session_id": "..."}
{"type": "error",        "content": "..."}
```

---

## 10. Configuration — Settings thực tế

```ini
# .env (production)
ENVIRONMENT=production

# Primary model (hiện tại)
AI_CHAT_MODEL=openai/gpt-4o-mini
# Fallback
AI_CHAT_FALLBACK_MODELS=openai/gpt-4o

# Session limits
AI_SESSION_TTL_MINUTES=30       # In-memory session expire
AI_MAX_TOOL_CALLS=8             # Global default (override bởi AgentConfig)
AI_DATASET_TABLE_LIMIT=50       # run_dataset_table max rows

# Đang chạy trên Docker
# Port: 8001
# Container: dashboard-app-v3-ai-chat-service-1
```

---

## 11. Bug Map — Những gì CHƯA ổn định

### P0 — Ảnh hưởng chất lượng câu trả lời ngay bây giờ

| # | Bug | File | Mô tả | Fix |
|---|-----|------|--------|-----|
| B1 | ~~explore_data total rows sai~~ | `tools.py:930` | ~~AI nói "50 hàng" thay vì số thực~~ | ✅ Fixed 2026-04-12 |
| B2 | Rate limit check không dùng actual intent | `chat.py:151` | Kiểm tra "default" 100/hr, không phải per-intent | Cần fix |
| B3 | INSIGHT temperature quá thấp | `orchestrator.py:816` | `temperature=0.2` → trả lời conservative, không narrative | Cần fix |
| B4 | Chart search khi có dataset_id dùng fuzzy match | `context_builder.py:163` | "doanh thu" không match "revenue chart" | Cần fix |
| B5 | Anthropic non-streaming → blank screen | `orchestrator.py:1038` | User đợi toàn bộ response không thấy gì | Cần fix |

### P1 — Ảnh hưởng tính ổn định

| # | Bug | Mô tả |
|---|-----|--------|
| B6 | _trim_history(20) cắt tool calls giữa INSIGHT turn | Model mất context → re-query → tốn tokens |
| B7 | INSIGHT force_first_tool=False nhưng không có planning step | Model có thể skip planning → query ngay |
| B8 | Feedback enrichment chưa wired mặc định | `get_enriched_insight_prompt()` có logic nhưng không được gọi tự động |
| B9 | Suggestions generation dùng cùng expensive model | Gọi thêm 1 LLM call sau mỗi response → tăng cost ~20% |
| B10 | date_bucket không có backend test | Schema có, backend chưa chắc hỗ trợ |

### P2 — Performance / Cost

| # | Bug | Mô tả |
|---|-----|--------|
| B11 | search_charts luôn fetch data dù model không cần | ~500-2000 extra tokens/call |
| B12 | Tool schemas trong prompt ~1,000 tokens mỗi turn | Không thể optimize nếu dùng dynamic tools |
| B13 | _generate_suggestions dùng main model | Nên dùng model nhỏ hơn |

---

## 12. Khoảng cách so với target (Multi-Agent BI Orchestrator)

### Những gì thực sự hoạt động

```
✅ Intent routing (5 loại, hybrid keyword+LLM)
✅ Tool restriction per intent (mỗi intent chỉ thấy tools cần thiết)
✅ Dataset scope enforcement (hard boundary)
✅ Multi-provider fallback (OpenRouter → OpenAI → Anthropic → Gemini)
✅ Token counting (OpenAI streaming, Anthropic non-streaming)
✅ In-memory rate limiting (đúng logic, sai wiring)
✅ Feedback collection (thumbs up/down → DB)
✅ Session persistence (memory + PostgreSQL)
✅ JWT auth + RBAC (viewer vs editor)
✅ Streaming WebSocket + REST SSE
✅ Tool result truncation (max 50 rows in history)
✅ Context builder với sample values
✅ explore_data total_rows (just fixed)
```

### Những gì CẦN làm để ổn định

```
🔴 Fix rate limit check dùng actual intent (không phải "default")
🔴 Fix Anthropic streaming (blank screen issue)  
🔴 Fix INSIGHT temperature (0.2 → 0.4)
🔴 Fix chart search dùng vector search khi có dataset_id
🟡 Tăng _trim_history limit cho INSIGHT (20 → 40)
🟡 Wire feedback enrichment vào INSIGHT mặc định
🟡 Tách suggestions sang model nhỏ hơn
🟡 Planning step cho INSIGHT trước khi gọi tools
```

### Những gì CẦN BUILD MỚI để đạt target

```
⚪ Dedicated loop per agent (thực sự tách InsightAgent ra khỏi orchestrator)
⚪ Multi-step planning (hypothesis → test → refine cycle)
⚪ Cross-table analysis (join-equivalent via multi-query synthesis)
⚪ Anomaly detection tool
⚪ Predictive analytics (time series forecasting)
⚪ Automated narrative generation (báo cáo có structure)
⚪ User preference memory (personalization per user)
⚪ Dashboard Agent (auto-build complex dashboards)
```

---

## 13. Luồng thực tế của session `ddb5efa9` (Case study)

```
Câu hỏi: "Tổng quan về dữ liệu trong customer_onboarding là gì?"

1. Intent: EXPLORE (keyword "tổng quan" match EXPLORE_KEYWORDS)
2. AgentConfig: max_tokens=1024, tools=5, force_first=True
3. Context: scoped to dataset_id=1 (customer_onboarding)
4. Tools available: list_dataset_tables, run_dataset_table, explore_data, 
                    search_charts, search_dashboards, inspect_dashboard
5. Turn 1 (forced tool): list_dataset_tables()
   → Trả về: 1 dataset, 1 table, ~18 columns
6. Turn 2: explore_data(dataset_id=1, table_id=1, analysis_type="overview")
   → Trả về: 50 sample rows (BUG: không có total_rows ← đã fix)
   → column_stats cho 18 columns với sample values
7. AI response: 
   - Liệt kê 18 columns với type và sample
   - "50 hàng dữ liệu" (BUG: sample, không phải total ← đã fix)
   - "42 unique first_name" (BUG: không có giá trị business ← prompt đã fix)
8. Metrics: 6,734 input / 534 output | 2 tools | 13.8s | gpt-4o-mini

SAU FIX:
- explore_data sẽ có "total_rows": N (actual count)
- EXPLORE prompt yêu cầu mention total_rows as first fact
- "Điểm đáng chú ý" phải là business insight, không phải cardinality count
```

---

## 14. Deployment hiện tại

```yaml
Container: dashboard-app-v3-ai-chat-service-1
Port: 127.0.0.1:8001 → container:8001
Status: Up 18+ hours (healthy)
Model: openai/gpt-4o-mini (via OpenRouter)
Fallback: openai/gpt-4o (via OpenRouter)

Dependencies:
  - dashboard-app-v3-backend-1 (127.0.0.1:8000)  # BI API
  - dashboard-app-v3-db-1      (5432/tcp)         # PostgreSQL

Hot reload: NO (volume mount chưa config)
→ Mỗi code change cần: docker restart dashboard-app-v3-ai-chat-service-1
```

---

## 15. Recommendation — Thứ tự ưu tiên fix trước khi production

```
Sprint ngắn (1-3 ngày) — để chat ổn định cơ bản:

1. Fix rate limit check dùng intent thực (B2)
   File: chat.py — dùng session.context._last_intent sau run_agent
   
2. Fix INSIGHT temperature (B3)
   File: orchestrator.py — dynamic temperature per intent (0.2 LOOKUP, 0.4 INSIGHT)
   
3. Fix Anthropic streaming (B5)
   File: orchestrator.py:_anthropic_loop — bật stream=True cho Anthropic
   
4. Fix chart search vector khi có dataset_id (B4)
   File: context_builder.py — gọi search_similar_charts với dataset filter

5. Tăng trim_history cho INSIGHT (B6)
   File: orchestrator.py:_trim_history — max=20 → max=40 khi intent=INSIGHT

Sprint dài hơn (1-2 tuần) — để đạt tầng 3 capability:

6. INSIGHT planning step — inject investigation plan trước turn 1
7. Wire feedback enrichment
8. Dedicated InsightAgent loop với multi-step enforcement
9. Suggestions model nhỏ (gpt-4o-mini for suggestions regardless of main model)
```

---

*Tài liệu này phản ánh trạng thái code tính đến 2026-04-12. Cập nhật khi có thay đổi kiến trúc lớn.*
