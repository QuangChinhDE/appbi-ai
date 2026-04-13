# AI Chat — Upgrade Plan v2

> **Phiên bản:** 2.0  
> **Ngày:** 2026-04-12  
> **Căn cứ:** AI review + measurements thực tế từ codebase  
> **Mục tiêu:** Từ "LLM + tool calling + prompt dài" → "Reasoning Architecture"

---

## Tóm tắt vấn đề (có số thực)

### Token budget thực tế mỗi turn

```
BASE_SYSTEM_PROMPT:     4,817 chars ≈ 1,200 tokens
+ Intent prompt thêm:     640–2,305 chars ≈ 160–576 tokens
+ Tool schemas (11 tools): ~6,000 chars ≈ 1,500 tokens
+ Context builder output:   600–1,500 chars ≈ 150–375 tokens
+ History (20 messages):  variable (0–10,000 tokens)
───────────────────────────────────────────────────────
Tổng tối thiểu trước user message:  ~3,010–3,651 tokens
Thực đo (session ddb5efa9):         6,734 input tokens cho câu EXPLORE đơn giản
```

### Bugs tìm thấy trong quá trình audit

```
BUG-01: SYSTEM_PROMPT undefined — orchestrator.py lines 131, 159 dùng
        variable đã bị xóa. Code không crash vì bị override ngay sau,
        nhưng là ticking time bomb.

BUG-02: temperature=0.2 cứng tất cả intents
        Cả 4 nơi: openai_loop:834, anthropic_loop:1075,
        gemini_config:132, openrouter:159

BUG-03: _trim_history(max=20) giết INSIGHT
        1 INSIGHT turn = ~22 messages → model quên queries vừa làm

BUG-04: Rate limit check dùng "default" intent (100/hr)
        INSIGHT limit 10/hr không được check thực sự

BUG-05: BASE_SYSTEM_PROMPT (4,817 chars) copy nguyên vào 4 prompts
        = 19,268 chars lặp lại không cần thiết

BUG-06: Không có planning step thật cho INSIGHT
        force_first_tool=False nhưng không có cơ chế enforce plan trước
```

---

## Nguyên nhân gốc rễ (theo đánh giá)

```
Vấn đề không phải: model yếu, data ít, tool thiếu
Vấn đề thực sự:    thiếu "reasoning architecture"

Hiện tại:  USER → [1 LLM + prompt dài + nhiều tools] → ANSWER
Cần đạt:   USER → [PLAN] → [EXECUTE với plan] → [SYNTHESIZE] → ANSWER
```

---

## Kiến trúc Target v2

```
User Message
      │
      ▼
[Intent Router]  ──────────────────────────────────────────┐
  keyword/LLM                                              │
      │                                                    │
  ┌───┴────────────────────────────────────────┐          │
  │                                            │          │
VAGUE              LOOKUP / EXPLORE / CREATE   INSIGHT    │
  │                        │                    │         │
  ▼                        ▼                    ▼         │
[Clarify]        [Single-phase loop]    [TWO-PHASE LOOP]  │
  return              existing               NEW          │
                                             │            │
                                    ┌────────┴────────┐   │
                                    │  Phase A:       │   │
                                    │  Planning Call  │   │
                                    │  (no tools,     │   │
                                    │   temperature=  │   │
                                    │   0.5, 500tok)  │   │
                                    │  → structured   │   │
                                    │    plan output  │   │
                                    └────────┬────────┘   │
                                             │            │
                                    ┌────────▼────────┐   │
                                    │  Phase B:       │   │
                                    │  Execution Loop │   │
                                    │  (tools=8 INSIGHT│  │
                                    │   tools, 0.4,   │   │
                                    │   max=2500 tok  │   │
                                    │   plan injected │   │
                                    │   as context)   │   │
                                    └────────┬────────┘   │
                                             │            │
                                             ▼            │
                                        [ANSWER]          │
                                                          │
                                    Governance Layer ─────┘
                              (rate limit với actual intent)
```

---

## Sprint A — Critical Bugs (1–2 ngày)
**Không có Sprint A thì Sprint B/C/D đều sẽ build trên nền không vững**

### A1 — Fix undefined SYSTEM_PROMPT variable

**File:** `ai-chat/app/agents/orchestrator.py`

Tìm và xóa 3 references đến `SYSTEM_PROMPT` (biến không còn tồn tại):

| Line | Code hiện tại | Fix |
|------|---------------|-----|
| ~131 | `system_instruction=SYSTEM_PROMPT,` (Gemini) | Dùng `_get_base_prompt()` |
| ~159 | `system_instruction=SYSTEM_PROMPT,` (OpenRouter) | Dùng `_get_base_prompt()` |
| ~187 | `system = SYSTEM_PROMPT` (Anthropic fallback) | Dùng `_get_base_prompt()` |

### A2 — Dynamic temperature theo intent

**File:** `ai-chat/app/agents/intent_classifier.py` — thêm `temperature` vào `AgentConfig`

```python
@dataclass
class AgentConfig:
    intent: IntentType
    max_tokens: int
    tool_call_limit: int
    system_prompt: str
    force_first_tool: bool
    temperature: float = 0.2      # ← THÊM MỚI
    tool_names: Optional[List[str]] = None
    clarification_question: Optional[str] = None
```

**Presets:**
```python
IntentType.LOOKUP:  temperature = 0.1   # factual, không cần creative
IntentType.EXPLORE: temperature = 0.2   # description, slight flexibility
IntentType.INSIGHT: temperature = 0.5   # narrative synthesis, cần creative
IntentType.CREATE:  temperature = 0.2   # precise chart config
IntentType.VAGUE:   temperature = 0.0   # deterministic clarification
```

**File:** `ai-chat/app/agents/orchestrator.py` — dùng dynamic temperature:
```python
# Thay thế tất cả hardcode temperature=0.2 trong:
# _openai_loop:   line 834
# _anthropic_loop: line 1075

# Bằng:
temperature = agent_config.temperature if agent_config else 0.2
```

### A3 — Dynamic history limit theo intent

**File:** `ai-chat/app/agents/orchestrator.py` — `_trim_history()`

```python
# Trước:
def _trim_history(messages, max_messages=20):
    ...

# Sau:
def _trim_history(messages, max_messages=20):
    ...

# Và trong _to_llm_messages:
def _to_llm_messages(session, turn_context="", system_prompt="", max_history=20):
    ...
    for m in _trim_history(session.messages, max_messages=max_history):
```

**AgentConfig thêm `max_history`:**
```python
IntentType.LOOKUP:  max_history = 20
IntentType.EXPLORE: max_history = 20
IntentType.INSIGHT: max_history = 50   # ← đủ cho 15 tool calls + turns trước
IntentType.CREATE:  max_history = 20
```

### A4 — Fix rate limit dùng actual intent

**File:** `ai-chat/app/routers/chat.py`

```python
# Hiện tại (sai — check "default" trước khi biết intent):
allowed, remaining = rate_limiter.check(user_id, "default")

# Cần: check sau khi run_agent emit MetricsEvent với intent
# Cách pragmatic: check 2 lần:
# 1. Pre-check với "default" (100/hr) — chặn spam rõ ràng
# 2. Post-intent-check: sau khi AgentConfig tạo xong, check lại với actual intent

# Sửa trong run_agent() sau classify_intent():
async def run_agent(user_message, session):
    ...
    agent_config = await classify_intent(...)
    
    # Phase 3 rate limit check với actual intent
    from app.agents.governance import rate_limiter
    user_id = session.context.get("user_id", "")
    if user_id:
        intent_str = agent_config.intent.value
        allowed, remaining = rate_limiter.check(user_id, intent_str)
        if not allowed:
            yield ErrorEvent(
                content=f"Bạn đã đạt giới hạn {intent_str} queries. Thử lại sau."
            ).model_dump()
            return
        rate_limiter.record(user_id, intent_str)
```

### A5 — Fix Anthropic streaming (blank screen)

**File:** `ai-chat/app/agents/orchestrator.py` — `_anthropic_loop()`

```python
# Hiện tại: stream=False → đợi toàn bộ rồi mới yield
response = await client.messages.create(
    ...
    stream=False,   # ← BUG: UX xấu
)

# Sau: dùng streaming async context manager
async with client.messages.stream(
    model=model,
    max_tokens=max_tokens,
    system=system_prompt + ...,
    messages=anthropic_messages,
    tools=anthropic_tools,
    temperature=temperature,
) as stream:
    async for text in stream.text_stream:
        text_content += text
        yield TextEvent(content=text).model_dump()
    
    # Lấy final message để check tool_uses
    final_message = await stream.get_final_message()
    # Extract token usage
    if final_message.usage:
        metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + final_message.usage.input_tokens
        metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + final_message.usage.output_tokens
    # Process tool_uses từ final_message.content
```

### Checklist Sprint A

- [ ] **A1** Fix 3 references `SYSTEM_PROMPT` undefined (orchestrator.py lines ~131, ~159, ~187)
- [ ] **A2** Thêm `temperature` vào `AgentConfig`, set dynamic per intent, dùng trong tất cả loops
- [ ] **A3** Thêm `max_history` vào `AgentConfig`, INSIGHT=50, dùng trong `_to_llm_messages`
- [ ] **A4** Rate limit check với actual intent trong `run_agent()` sau `classify_intent()`
- [ ] **A5** Sửa `_anthropic_loop()` dùng `client.messages.stream()` thay vì `create(stream=False)`
- [ ] **A-test** Chạy lại session `ddb5efa9` type question → verify không còn blank screen, INSIGHT temperature khác

---

## Sprint B — Prompt Optimization (2–3 ngày)
**Mục tiêu: Giảm system prompt từ ~3,000 xuống < 1,800 tokens trước context**

### Vấn đề hiện tại — Token breakdown chi tiết

```
COMBINED PROMPT khi INSIGHT turn:
┌─────────────────────────────────────────────────────────────┐
│ BASE_SYSTEM_PROMPT                    4,817 chars ~1,204 tok │
│   ├─ Intro (dataset scope)              220 chars   ~55 tok  │
│   ├─ TOOL REFERENCE (all 11 tools)      385 chars   ~96 tok  │  ← DÙNG
│   ├─ ABSOLUTE RULES                     345 chars   ~86 tok  │  ← DÙNG
│   └─ DATA QUALITY RULES               3,867 chars  ~967 tok  │  ← DÙNG (nhiều nhất)
│                                                               │
│ + INSIGHT specific content             3,122 chars  ~780 tok  │
│   ├─ Duplicates BASE intro                                    │  ← LOẠI
│   ├─ Investigation methodology         1,500 chars  ~375 tok │  ← DÙNG
│   └─ Response format                    800 chars   ~200 tok │  ← DÙNG
│                                                               │
│ + Tool SCHEMAS (11 full JSON schemas)                        │
│   Descriptions only:                   2,175 chars  ~544 tok │  ← CẦN
│   Parameter schemas:                  ~3,500 chars  ~875 tok │  ← CẦN (không thể cắt)
│                                                               │
│ + Context (tables + charts)           600-1,500 chars ~375 tok│  ← CẦN
└─────────────────────────────────────────────────────────────┘
```

### B1 — Tách BASE thành 2 lớp: CORE + QUALITY

**Vấn đề:** BASE_SYSTEM_PROMPT có 2 loại nội dung rất khác nhau:
- **CORE** (~800 chars): scope, absolute rules — mọi intent đều cần
- **QUALITY** (~3,800 chars): data quality rules — quan trọng nhưng có thể trim

```python
# app/prompts/base.py — tách thành 2 constants:

CORE_SYSTEM_PROMPT = """
You are a BI analyst inside AppBI. Answer data questions using real numbers from tools only.
[Active Dataset scope rule — 2 lines]
[ABSOLUTE RULES — 8 bullets, mỗi bullet ≤ 15 words]
"""
# Target: ~800 chars / ~200 tokens

DATA_QUALITY_RULES = """
[BOOLEAN: '0'/'1', 'TRUE'/'FALSE' — never Python booleans]
[RATIO: GROUP BY category column, compute % manually]  
[COLUMN MATCH: project→project_name, person→assignee]
[CHART RELEVANCE: verify columns before using chart data]
[ORDER BY: use aliased measure name e.g. revenue_sum]
[FILTER: use exact string values from data]
"""
# Target: ~600 chars / ~150 tokens
```

### B2 — Loại bỏ TOOL REFERENCE trong BASE

**Vấn đề:** Tool reference trong system prompt (~385 chars) + full tool schemas JSON (~5,500 chars) = TRÙNG LẶP.

Model đã có full tool descriptions trong function calling schemas. Không cần repeat trong system prompt.

```python
# XÓA khỏi BASE_SYSTEM_PROMPT:
"""
TOOL REFERENCE

search_charts(query) -> charts[] + top_chart_data.rows...
run_chart(chart_id) -> rows[]...
... (385 chars)
"""

# Thay bằng 1 dòng:
"""
Use the available tools to answer. Call list_dataset_tables before query_table.
"""
# ~80 chars
```

### B3 — Compact tool descriptions trong TOOL_SCHEMAS

**Hiện tại:** Tool descriptions trung bình 198 chars/tool, query_table 343 chars

Descriptions trong JSON schemas không cần narrative dài — model hiểu từ tên + parameters:

```python
# Trước: query_table description = 343 chars
"Run an aggregated analytical query on a dataset table. Supports GROUP BY (dimensions), 
aggregations (measures: sum/avg/count/min/max/count_distinct), WHERE filters, ORDER BY, 
and LIMIT. Always prefer this over run_dataset_table to avoid loading raw data. Measure 
result columns are aliased as {field}_{function} (e.g. total_points_sum). Use order_by 
with the aliased measure name to rank results."

# Sau: ~120 chars
"Aggregated query: GROUP BY dimensions, aggregate measures. 
Measure columns aliased as {field}_{function}. Use aliased name in order_by."
```

**Target:** Giảm total description từ 2,175 → ~1,000 chars (tiết kiệm ~300 tokens)

### B4 — Intent-specific prompts chỉ chứa NEW content

**Hiện tại:** Mỗi intent prompt = BASE (copy nguyên) + content riêng

```python
# Hiện tại (trong lookup.py):
PROMPT_LOOKUP = BASE_SYSTEM_PROMPT + """
LOOKUP MODE — DECISION FLOW
...
"""
# = 4,817 + 1,365 = 6,182 chars TRƯỚC khi tool schemas

# Sau khi optimize (lookup.py chỉ chứa delta):
LOOKUP_EXTENSION = """
LOOKUP MODE

Decision: search_charts first (check column match) → query_table → query dashboard.
For ratios: GROUP BY category column → compute % from counts.
For top-N: scan all rows, find MAX — do NOT assume first row = answer.

Response: **[Direct answer — top result + value]**
• Item: value (list 3–7 from data)
[1 observation]
"""
# = ~400 chars

# Và _make_config() sẽ compose:
# system_prompt = CORE_SYSTEM_PROMPT + DATA_QUALITY_RULES + LOOKUP_EXTENSION
```

**Kết quả sau B1-B4:**
```
BEFORE:
  BASE + INSIGHT: (4,817+3,122) + tool schemas = ~14,500 chars total
  ≈ 3,625 tokens system prompt
  
AFTER target:
  CORE + QUALITY + INSIGHT_EXTENSION: (800+600+1,200) + schemas = ~8,100 chars
  ≈ 2,025 tokens system prompt
  
Tiết kiệm: ~1,600 tokens per INSIGHT turn
At $0.15/1M tokens (gpt-4o-mini): ~$0.00024/turn = $0.024/100 turns
At $5/1M tokens (GPT-4o): ~$0.008/turn = $0.80/100 turns
```

### Checklist Sprint B

- [ ] **B1** Tách `BASE_SYSTEM_PROMPT` thành `CORE_SYSTEM_PROMPT` + `DATA_QUALITY_RULES`
- [ ] **B2** Xóa TOOL REFERENCE section khỏi BASE (redundant với JSON schemas)
- [ ] **B3** Compact tool descriptions: target mỗi tool ≤ 120 chars
- [ ] **B4** Refactor intent prompts: chỉ chứa delta (decision flow + response format)
- [ ] **B5** Cập nhật `_make_config()`: compose từ CORE + QUALITY + INTENT_EXTENSION
- [ ] **B-test** Đo lại `input_tokens` sau refactor — verify < 4,000 cho EXPLORE, < 5,000 cho INSIGHT
- [ ] **B-quality** Chạy 10 test questions — verify quality không giảm

---

## Sprint C — Real INSIGHT Planning Loop (3–5 ngày)
**Đây là thứ quyết định system có phải "Agentic AI" hay chỉ "LLM + tools"**

### Vấn đề cốt lõi

```
Hiện tại — 1 phase:
User: "Tại sao doanh thu tháng 10 giảm?"
→ LLM có tools → gọi tool đầu tiên nó nghĩ ra → gọi tool tiếp → trả lời

Vấn đề: LLM không có "plan" → thường query thiếu chiều → insight nông
         Giống việc cho analyst data và bảo "trả lời" mà không cho nghĩ

Cần — 2 phase:
Phase A: LLM đọc câu hỏi + schema → tạo investigation plan (không có tools)
Phase B: LLM thực thi plan với tools, plan là context
```

### C1 — Tạo `_insight_loop()` riêng biệt

**File:** `ai-chat/app/agents/orchestrator.py`

```python
async def _insight_loop(
    client,
    model: str,
    session: ConversationSession,
    chart_data_cache: Dict[int, Dict],
    metrics_ctx: Dict[str, Any],
    token: str = "",
    turn_context: str = "",
    agent_config=None,
) -> AsyncGenerator[Dict, None]:
    """
    Two-phase reasoning loop for deep analytical questions.
    
    Phase A: Planning — LLM structures investigation without calling tools
    Phase B: Execution — LLM executes plan with full tool access
    """
    from app.agents.tools import get_tool_schemas
    
    # ── Phase A: Planning ──────────────────────────────────────────
    yield ThinkingEvent(content="Đang lên kế hoạch phân tích...").model_dump()
    
    planning_prompt = _get_insight_planning_prompt()
    planning_messages = _to_llm_messages(
        session,
        turn_context=turn_context,
        system_prompt=planning_prompt,
        max_history=10,  # Ít history cho planning — tiết kiệm tokens
    )
    
    plan_text = ""
    try:
        plan_response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=planning_messages,
                tools=[],           # NO tools in planning phase
                tool_choice="none",
                stream=False,       # Plan is short, no need to stream
                temperature=0.5,    # Creative planning
                max_tokens=600,     # Plan structure, không cần dài
            ),
            timeout=30,
        )
        plan_text = plan_response.choices[0].message.content or ""
        
        # Track planning tokens
        if plan_response.usage:
            metrics_ctx["input_tokens"] = (metrics_ctx["input_tokens"] or 0) + plan_response.usage.prompt_tokens
            metrics_ctx["output_tokens"] = (metrics_ctx["output_tokens"] or 0) + plan_response.usage.completion_tokens
        
        yield ThinkingEvent(content=f"Kế hoạch: {plan_text[:100]}...").model_dump()
    except Exception as e:
        logger.warning("Insight planning failed: %s — proceeding without plan", e)
        plan_text = ""
    
    # ── Phase B: Execution with plan as context ─────────────────────
    yield ThinkingEvent(content="Đang thực hiện phân tích...").model_dump()
    
    execution_system = (
        agent_config.system_prompt
        + ("\n\n## INVESTIGATION PLAN (from planning phase)\n" + plan_text if plan_text else "")
    )
    
    # Rewrite the last user message to include plan context
    session.context["_insight_plan"] = plan_text  # Store for context
    
    # Run execution loop with tools
    active_tools = get_tool_schemas(agent_config.tool_names)
    max_tokens = agent_config.max_tokens or 3000
    tool_call_limit = agent_config.tool_call_limit or 12
    max_history = getattr(agent_config, "max_history", 50)
    
    tool_calls_made = 0
    while tool_calls_made <= tool_call_limit:
        exec_messages = _to_llm_messages(
            session,
            turn_context=turn_context,
            system_prompt=execution_system,
            max_history=max_history,
        )
        
        # ... (standard tool calling loop same as _openai_loop) ...
        # KEY DIFFERENCES:
        # - temperature=0.4 (more creative than lookup)
        # - max_tokens=max_tokens (3000 for narrative)
        # - system_prompt includes plan_text
```

### C2 — Insight Planning Prompt

```python
# app/prompts/insight_planning.py

INSIGHT_PLANNING_PROMPT = """
You are a data analyst planning an investigation. Given a user question and available data schema,
output a structured investigation plan. Do NOT call any tools or query any data yet.

OUTPUT FORMAT (JSON):
{
  "question_type": "root_cause | trend | comparison | distribution",
  "primary_metric": "column name to analyze",
  "hypotheses": [
    "H1: [specific testable hypothesis]",
    "H2: [alternative hypothesis]"
  ],
  "query_sequence": [
    "1. list_dataset_tables — confirm exact column names",
    "2. query_table — [what dimension, what measure, what filter]",
    "3. query_table — [next dimension to break down by]",
    "4. explain_insight — [if time column found in step 1]",
    "5. query_table — [cross-check hypothesis H1 or H2]"
  ],
  "expected_answer_shape": "single number | ranked list | time series | comparison"
}

Be specific. Name actual columns if you can infer them from context.
If you don't know column names: always start with list_dataset_tables.
Max 3 hypotheses. Max 6 queries in sequence.
"""
```

### C3 — Wire vào `run_agent()` và `_run_with_provider()`

```python
# orchestrator.py — trong _run_with_provider():
async def _run_with_provider(..., agent_config=None):
    from app.agents.intent_classifier import IntentType
    
    if agent_config and agent_config.intent == IntentType.INSIGHT:
        # Use dedicated insight loop with planning
        if provider in ("openai", "openrouter"):
            client = _make_openai_client() or _make_openrouter_client()
            async for event in _insight_loop(client, model, session, ...):
                yield event
        elif provider == "anthropic":
            # Anthropic insight loop variant
            ...
    else:
        # Existing single-phase loop for LOOKUP/EXPLORE/CREATE
        if provider == "openai":
            ...
```

### C4 — Token budget cho 2-phase INSIGHT

```
Phase A (planning):
  input:  ~2,000 tokens (compact system + context + history=10)
  output: ~150 tokens (JSON plan)
  
Phase B (execution):
  input:  ~4,000 tokens (full system + plan + context + history=50)
  output: ~2,500 tokens (narrative answer)
  
Total per INSIGHT turn: ~8,650 tokens
vs hiện tại: ~6,734 tokens (nhưng output chỉ 534 tokens = answer ngắn)

Chi phí tăng ~28% nhưng quality tăng rất nhiều
```

### Checklist Sprint C

- [ ] **C1** Tạo `app/prompts/insight_planning.py` với `INSIGHT_PLANNING_PROMPT`
- [ ] **C2** Tạo `_insight_loop()` với 2-phase: planning call + execution call
- [ ] **C3** Tạo `_insight_planning_call()` helper (no tools, temp=0.5, max=600)
- [ ] **C4** Wire INSIGHT intent vào `_insight_loop()` trong `_run_with_provider()`
- [ ] **C5** Planning output injected vào execution system prompt và stored in `session.context`
- [ ] **C6** ThinkingEvent emit khi planning ("Đang lên kế hoạch phân tích...")
- [ ] **C-test** Test "Tại sao doanh thu giảm?" → verify planning JSON có hypotheses và query_sequence
- [ ] **C-test** Verify Phase B có ít nhất 3 query_table calls
- [ ] **C-test** Compare: cùng câu hỏi trước vs sau Sprint C — insight depth rõ ràng hơn

---

## Sprint D — Context & Quality Fixes (2–3 ngày)

### D1 — Fix chart search khi có dataset_id

**File:** `ai-chat/app/agents/context_builder.py` (lines 156–178)

```python
# Hiện tại: dùng fuzzy match khi có dataset_id → "doanh thu" không match "revenue"
if dataset_id and scoped_table_ids:
    charts = await bi_client.list_charts(limit=200, token=token)
    scored = [(fuzzy_score(user_message, chart.name), chart) ...]

# Sau: ưu tiên vector search, fallback về fuzzy nếu no results
try:
    chart_hits = await bi_client.search_similar_charts(
        user_message,
        limit=max_charts,
        token=token,
        dataset_id=dataset_id,   # Add dataset filter if API supports
    )
    if chart_hits:
        pkg.charts = [c for c in chart_hits if c.get("similarity", 1.0) >= _MIN_SIMILARITY]
except Exception:
    pass

# Fallback to fuzzy only if vector returned nothing
if not pkg.charts and scoped_table_ids:
    # existing fuzzy logic as fallback
```

### D2 — Wire feedback enrichment mặc định

**Vấn đề:** `get_enriched_insight_prompt()` tồn tại trong `feedback_analyzer.py` nhưng không được gọi automatically trong `run_agent()`.

**File:** `ai-chat/app/agents/orchestrator.py` — trong `run_agent()` sau Phase 4 block

```python
# Hiện tại: wrapped trong try/except nhưng logic check có vấn đề
if agent_config.intent == _IntentType.INSIGHT:
    try:
        from app.agents.feedback_analyzer import get_enriched_insight_prompt
        agent_config.system_prompt = await get_enriched_insight_prompt(...)
    except Exception:
        pass

# Sau Sprint C: enrichment sẽ inject vào planning prompt, không execution prompt
# Vì: examples tốt cần hướng dẫn HOW TO PLAN, không phải HOW TO WRITE
```

### D3 — Lazy search_charts (tùy chọn)

**Vấn đề:** `search_charts` luôn fetch `top_chart_data.rows` dù model không dùng → ~500-2,000 extra tokens

**File:** `ai-chat/app/agents/tools.py` — thêm option vào search_charts

```python
# Thêm parameter:
"fetch_data": {
    "type": "boolean",
    "default": False,
    "description": "Set true to also fetch actual data rows for the top chart"
}

# Behavior:
# fetch_data=False → return chart metadata only (name, type, id)
# fetch_data=True  → return chart metadata + top_chart_data.rows
```

### D4 — Fix _generate_suggestions dùng model nhỏ

**File:** `ai-chat/app/agents/orchestrator.py` — `_generate_suggestions()`

```python
# Hiện tại: dùng cùng model với main chat (GPT-4o nếu đó là main model)
resp = await client.chat.completions.create(
    model=model,  # ← same as main
    ...
)

# Sau: luôn dùng model nhỏ nhất available
SUGGESTION_MODEL = "openai/gpt-4o-mini"  # Cheap, fast, good enough

resp = await client.chat.completions.create(
    model=SUGGESTION_MODEL,
    ...
)
```

### Checklist Sprint D

- [ ] **D1** Fix chart search dùng vector search khi có dataset_id
- [ ] **D2** Wire feedback enrichment vào planning phase của INSIGHT
- [ ] **D3** Thêm `fetch_data` param cho `search_charts` (opt-in data fetching)
- [ ] **D4** `_generate_suggestions()` luôn dùng `gpt-4o-mini` không phụ thuộc main model

---

## Bảng so sánh Before vs After

### Token Budget

| Scenario | Trước v2 | Sau Sprint B | Sau Sprint B+C |
|----------|---------|-------------|---------------|
| LOOKUP đơn giản | ~4,000 tokens | ~2,500 tokens | ~2,500 tokens |
| EXPLORE overview | ~6,734 tokens | ~4,000 tokens | ~4,000 tokens |
| INSIGHT deep | ~8,000 tokens | ~5,500 tokens | ~8,650 tokens (2-phase) |
| INSIGHT quality | Shallow | Shallow | **Deep** |

### Quality Impact

| Capability | Trước v2 | Sau v2 |
|-----------|---------|--------|
| Câu lookup đơn giản | ✅ Tốt | ✅ Tốt (nhanh hơn) |
| Câu explore overview | ❌ Nói "50 rows" sai | ✅ Đã fix, total_rows đúng |
| Câu insight "tại sao" | 🟡 Query 1-2 lần, nông | ✅ 2-phase, query 5-8 lần |
| Temperature INSIGHT | 0.2 (khô) | 0.5 (narrative) |
| History INSIGHT | 20 msgs (cắt) | 50 msgs (đủ) |
| Rate limit | Fake (default 100/hr) | Thật (per-intent) |
| Anthropic streaming | Blank screen | Word-by-word |

---

## Thứ tự thực hiện — Recommended

```
Tuần 1: Sprint A (critical bugs) + Sprint B (prompt optimization)
  → Hệ thống ổn định hơn, rẻ hơn, không còn silent bugs
  → Đo lại token counts sau Sprint B

Tuần 2-3: Sprint C (insight planning loop)
  → Core quality improvement
  → Test kỹ với 20+ insight questions thực từ team DA

Tuần 3-4: Sprint D (remaining fixes)
  → Polish, không critical

KHÔNG nên làm tất cả cùng lúc vì:
  - Sprint C là thay đổi lớn nhất, cần test riêng
  - Sprint B có thể regress quality nếu cắt quá nhiều → cần baseline test trước
```

---

## File Structure sau v2

```
ai-chat/
├── app/
│   ├── agents/
│   │   ├── orchestrator.py        # UPDATED: _insight_loop() mới, dynamic temperature, history
│   │   ├── intent_classifier.py   # UPDATED: temperature + max_history trong AgentConfig
│   │   ├── governance.py          # UPDATED: rate limit check với actual intent
│   │   ├── tools.py               # UPDATED: compact descriptions, lazy search_charts
│   │   ├── context_builder.py     # UPDATED: vector search for charts with dataset_id
│   │   ├── feedback_analyzer.py   # UPDATED: wire enrichment vào planning phase
│   │   └── ...
│   └── prompts/
│       ├── core.py                # NEW: ~800 chars CORE_SYSTEM_PROMPT
│       ├── quality_rules.py       # NEW: ~600 chars DATA_QUALITY_RULES
│       ├── insight_planning.py    # NEW: planning phase prompt
│       ├── lookup.py              # UPDATED: delta only (~400 chars)
│       ├── explore.py             # UPDATED: delta only (~600 chars)
│       ├── insight.py             # UPDATED: execution phase prompt
│       └── viz.py                 # UPDATED: delta only (~400 chars)
```

---

## Definition of Done — v2

```
Sprint A done khi:
  □ 0 references đến SYSTEM_PROMPT undefined
  □ INSIGHT response có văn phong khác LOOKUP (kiểm tra 5 câu)
  □ Rate limit INSIGHT thực sự 10/hr per user
  □ Anthropic provider không còn blank screen

Sprint B done khi:
  □ Input tokens < 4,000 cho EXPLORE câu đơn giản
  □ Input tokens < 5,500 cho INSIGHT không kèm history
  □ 10 test questions: quality >= trước Sprint B

Sprint C done khi:
  □ INSIGHT turn luôn có ThinkingEvent "Đang lên kế hoạch..."
  □ Planning call trả về JSON với hypotheses + query_sequence
  □ Execution phase có >= 3 tool calls trước khi trả lời
  □ Answer INSIGHT dài >= 300 từ với numbers từ data
  □ "Tại sao X giảm?" nhận được answer đa chiều (2+ dimensions)

Sprint D done khi:
  □ Chart search tiếng Việt match chart có tiếng Anh trong name
  □ Cost per INSIGHT turn giảm 10-15% nhờ lazy search_charts + suggestion model
```

---

*Tài liệu này replace UPGRADE_PLAN.md. Khi implement, cập nhật checklist trực tiếp trong file này.*
