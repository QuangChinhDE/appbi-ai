# AI Chat — Kế hoạch nâng cấp lên Multi-Agent Analytics

> **Phiên bản tài liệu:** 1.0  
> **Ngày tạo:** 2026-04-11  
> **Tác giả:** QA & Architecture Review  
> **Trạng thái:** Chờ phê duyệt trước khi code

---

## 1. Bối cảnh & Mục tiêu

### 1.1 Hiện trạng

Hệ thống AI Chat hiện tại là một **single-loop orchestrator**: mọi câu hỏi — từ tra cứu số liệu đơn giản đến phân tích root cause phức tạp — đều đi qua cùng 1 pipeline với cùng system prompt, cùng tool set, và cùng token budget. Đây là nguyên nhân cốt lõi khiến AI trả lời kém chất lượng với câu hỏi phân tích sâu dù model tốt.

```
Hiện tại (single-loop):
User → [1 Orchestrator] → tool_calls (max 8) → response (max 1024 tokens)

Mục tiêu (multi-agent):
User → [Intent Router] → [Specialized Agent] → tool_calls + budget phù hợp → response
```

### 1.2 Capability Target (từ AI Agents for Analytics framework)

```
Tầng 5 — Hyper Personalization         🎯 Dài hạn (Phase 4+)
Tầng 4 — Augmentation & Automation     🎯 Phase 3
Tầng 3 — Advanced Analytics            🎯 Phase 2
Tầng 2 — Pattern Recognition           🎯 Phase 1 (nâng từ 50% → 100%)
Tầng 1 — Exploration & Discovery       ✅ Đang hoạt động
```

### 1.3 Kiến trúc Multi-Agent Target (từ BI Orchestrator Agent framework)

```
Business User
      ↓
[BI Orchestrator / Intent Router]
      ↓
┌─────────────────────────────────────────────────────┐
│  Context      │  Analytical  │  Data        │  Viz  │
│  Understanding│  Thinking    │  Processing  │  Agent│
│  Agent        │  Agent       │  Agent       │       │
│  (Router)     │  (Insight)   │  (Query)     │(Chart)│
└─────────────────────────────────────────────────────┘
      ↓
[Insight & Story Agent] [Governance Agent] [Feedback & Learning Agent]
```

---

## 2. Audit Hiện trạng — Những gì cần fix

### 2.1 Bugs ảnh hưởng chất lượng ngay (phải fix trước khi production)

| # | Vấn đề | File | Dòng | Mức độ |
|---|--------|------|------|--------|
| B1 | **Dead code system prompt** — SYSTEM_PROMPT được định nghĩa 2 lần, version đầy đủ bị overwrite bởi version đơn giản hơn | `orchestrator.py` | 47 & 147 | CRITICAL |
| B2 | **Thiếu column mismatch check** trong active prompt — AI có thể dùng chart data sai column để trả lời | `orchestrator.py` | 147–228 | HIGH |
| B3 | **Boolean filter rules bị giản lược** — Active prompt không có rule cụ thể về `'TRUE'/'FALSE'` vs `'0'/'1'` | `orchestrator.py` | 219–227 | HIGH |
| B4 | **Token counting = None** — `input_tokens` và `output_tokens` không bao giờ được gán từ LLM response | `orchestrator.py` | 702–703 | HIGH |
| B5 | **Tool results không truncate** trước khi lưu vào message history — 8 tool calls × rows lớn = context bị bloat | `orchestrator.py` | 1052–1060 | MEDIUM |
| B6 | **Fallback context không có giới hạn** — khi vector search fail, load toàn bộ tất cả tables không giới hạn | `context_builder.py` | 198–216 | MEDIUM |

### 2.2 Giới hạn kiến trúc (cần giải quyết trong các phase)

| # | Vấn đề | Impact |
|---|--------|--------|
| A1 | `max_tokens = 1024` cứng cho mọi loại câu hỏi | Câu insight bị cắt giữa chừng |
| A2 | Response format cứng "1 câu + 3–7 bullets + 2 câu" | Không thể viết narrative phân tích |
| A3 | AI bắt buộc gọi tool ngay (`tool_choice="required"`) dù câu hỏi vague | Trả lời dựa trên đoán thay vì hỏi lại |
| A4 | Không có date bucketing trong `query_table` | Không GROUP BY tháng/tuần/quý được |
| A5 | Không có per-user rate limiting | Có thể bị spam, đốt tiền không kiểm soát |
| A6 | Context builder chỉ show `column_name:type`, không có sample values | AI không hiểu ngữ nghĩa cột |
| A7 | Không có multi-table analysis (join) | Câu hỏi cross-table không làm được |
| A8 | Tool call limit = 8 cho mọi loại câu hỏi | Câu insight phức tạp bị dừng quá sớm |

---

## 3. Roadmap Nâng Cấp

---

### PHASE 1 — Fix Bugs + Intent Router
**Thời gian ước tính:** 1–2 tuần  
**Mục tiêu:** Sửa toàn bộ bugs hiện tại, thêm Intent Classifier để route câu hỏi đúng mode

#### 3.1.1 Tổng quan thay đổi kiến trúc

```
Hiện tại:
User message → run_agent() → [loop với 1 system prompt + 1 max_tokens] → response

Sau Phase 1:
User message → classify_intent() → intent: LOOKUP / EXPLORE / INSIGHT / CREATE / VAGUE
                    ↓
             [Dynamic config]:
             - LOOKUP:  system_prompt_lookup,  max_tokens=512,  tool_calls=5
             - EXPLORE: system_prompt_explore, max_tokens=1024, tool_calls=5
             - INSIGHT: system_prompt_insight, max_tokens=2048, tool_calls=12
             - CREATE:  system_prompt_create,  max_tokens=1024, tool_calls=8
             - VAGUE:   → ask clarification (không gọi tool)
                    ↓
             run_agent() với config phù hợp
```

#### 3.1.2 Intent Classifier

Gọi LLM nhỏ/fast với prompt phân loại, **không cần tool**, budget thấp (~200 tokens):

```
LOOKUP   — tra cứu số liệu cụ thể, xếp hạng, top N, đếm
           Ví dụ: "top 5 dự án trễ deadline", "doanh thu tháng 3 là bao nhiêu"

EXPLORE  — khám phá dữ liệu, hỏi về schema, tổng quan
           Ví dụ: "dữ liệu này có gì?", "mô tả dataset cho tôi"

INSIGHT  — phân tích nguyên nhân, xu hướng, so sánh, giải thích
           Ví dụ: "tại sao doanh thu giảm?", "team nào hiệu quả nhất và vì sao"

CREATE   — tạo chart hoặc dashboard mới
           Ví dụ: "tạo biểu đồ doanh thu theo tháng", "build dashboard cho tôi"

VAGUE    — câu hỏi không đủ thông tin để xử lý
           Ví dụ: "phân tích đi", "xem data", "thông tin"
```

#### 3.1.3 Checklist Phase 1

**Trước khi bắt đầu code Phase 1, phải xác nhận:**

- [ ] **ENV-01** Đã có file `.env` đầy đủ tại `ai-chat/` với đủ API keys
- [ ] **ENV-02** Xác định model dùng cho Intent Classifier (khuyến nghị: model nhỏ/fast, ví dụ `gpt-4o-mini` hoặc tương đương qua OpenRouter)
- [ ] **ENV-03** Đã test hệ thống hiện tại, ghi lại baseline chất lượng (5 câu test mẫu)

**Công việc code Phase 1:**

Sửa bugs:
- [x] **P1-B1** Xóa SYSTEM_PROMPT thứ nhất (dead code), merge rules vào `app/prompts/base.py` — `BASE_SYSTEM_PROMPT`
- [x] **P1-B2** Thêm lại rule kiểm tra column mismatch vào `BASE_SYSTEM_PROMPT` (CHART DATA RELEVANCE CHECK section)
- [x] **P1-B3** Khôi phục boolean filter rules chi tiết (`'TRUE'/'FALSE'`, `'0'/'1'`) vào `BASE_SYSTEM_PROMPT`
- [x] **P1-B4** Extract `input_tokens`/`output_tokens` từ LLM: OpenAI dùng `stream_options={"include_usage":True}`, Anthropic dùng `response.usage`
- [x] **P1-B5** Thêm `_truncate_tool_result()` helper, áp dụng trong cả 3 loops (OpenAI, Anthropic, Gemini)
- [x] **P1-B6** Hard cap 50 tables trong fallback của `context_builder.py` với warning log

Thêm Intent Router:
- [x] **P1-R1** Tạo `ai-chat/app/agents/intent_classifier.py`
- [x] **P1-R2** Implement `classify_intent(user_message, provider, model) → AgentConfig` — hybrid: keyword fast path + LLM fallback
- [x] **P1-R3** Định nghĩa `AgentConfig` dataclass: `intent`, `max_tokens`, `tool_call_limit`, `system_prompt`, `force_first_tool`, `clarification_question`
- [x] **P1-R4** Tạo `ai-chat/app/prompts/` với 5 files: `base.py`, `lookup.py`, `explore.py`, `insight.py`, `viz.py`
- [x] **P1-R5** Thêm VAGUE clarification flow trong `run_agent()` — trả về câu hỏi, persist vào DB, return sớm
- [x] **P1-R6** Modify `run_agent()` để gọi `classify_intent()` và pass `agent_config` xuống
- [x] **P1-R7** Thread `agent_config` qua `_run_with_provider()` → `_openai_loop()`, `_anthropic_loop()`, `_gemini_loop()`

Kiểm thử Phase 1:
- [x] **P1-T1** Keyword classifier 14/14 test cases (>90%) — verified via unit test
- [ ] **P1-T2** Test clarification flow end-to-end với real WebSocket (cần môi trường chạy)
- [x] **P1-T3** INSIGHT config: max_tokens=3000, tool_limit=15 — verified via unit test
- [ ] **P1-T4** Test boolean filter với real query (cần dataset thực)
- [ ] **P1-T5** Verify token metrics populated sau real LLM call
- [x] **P1-T6** Truncation logic verified: 200 rows → 50 rows, auto_chart stripped

---

### PHASE 2 — Specialized Agents (InsightAgent + DataAgent)
**Thời gian ước tính:** 2–4 tuần  
**Mục tiêu:** Tách orchestrator thành specialized agents, nâng khả năng phân tích sâu ngang với direct Claude analysis

#### 3.2.1 Tổng quan thay đổi kiến trúc

```
Sau Phase 2:
Intent Router
    ├── LOOKUP  → QueryAgent    (fast, cheap, precise)
    ├── EXPLORE → ExploreAgent  (breadth-first data discovery)
    ├── INSIGHT → InsightAgent  (deep analysis, narrative output, 15 tool calls, 3000 tokens)
    ├── CREATE  → VizAgent      (chart + dashboard creation)
    └── VAGUE   → ClarifyAgent  (ask then re-route)
```

#### 3.2.2 InsightAgent — con quan trọng nhất

InsightAgent là thứ sẽ nâng sản phẩm lên tầng 3–4 của capability ladder. Thiết kế:

**System prompt:**
- Không dùng bullet format cứng
- Cho phép viết narrative: mở đầu → phân tích → kết luận
- Hướng dẫn multi-step reasoning: form hypothesis → test bằng query_table → refine
- Khuyến khích gọi nhiều query để build full picture

**Tool set:**
- `list_dataset_tables` — bắt buộc gọi đầu tiên
- `query_table` — gọi nhiều lần (slice theo dimension khác nhau)
- `explain_insight` — root cause analysis
- `explore_data` — distribution + time patterns
- `run_chart` — lấy data từ chart có sẵn

**Config:**
- `max_tokens`: 3000
- `tool_call_limit`: 15
- `temperature`: 0.3 (cho phép creative hơn trong narrative)
- `force_first_tool`: False (có thể lên kế hoạch trước khi query)

#### 3.2.3 Thêm date bucketing vào query_table

Hiện tại `query_table` chỉ hỗ trợ filter theo date, không GROUP BY tháng/tuần/quý. Cần thêm:

```python
# Thêm vào tool schema của query_table:
"date_bucket": {
    "type": "object",
    "properties": {
        "column": {"type": "string"},          # cột date để bucket
        "granularity": {
            "type": "string",
            "enum": ["day", "week", "month", "quarter", "year"]
        }
    }
}
```

#### 3.2.4 Cải thiện context builder — thêm sample values

```python
# Hiện tại context chỉ show:
"Columns: created_at:timestamp, project_name:varchar, status:varchar"

# Sau Phase 2 cần show:
"Columns: created_at:timestamp, project_name:varchar (e.g. 'Project Alpha', 'Q3 Launch'),
          status:varchar (values: '0', '1')"
```

#### 3.2.5 Checklist Phase 2

**Trước khi bắt đầu code Phase 2, phải xác nhận:**

- [ ] **PRE-01** Phase 1 đã hoàn thành và pass toàn bộ test
- [ ] **PRE-02** Có ít nhất 10 câu hỏi insight thực tế từ team DA để test InsightAgent
- [ ] **PRE-03** Xác nhận model sẽ dùng cho InsightAgent (khuyến nghị model mạnh: Claude 3.5 Sonnet hoặc GPT-4o)
- [ ] **PRE-04** Đã đo baseline: thời gian response trung bình hiện tại cho câu insight

**Công việc code Phase 2:**

Specialized Agents:
- [x] **P2-A1** `ai-chat/app/agents/query_agent.py` — LOOKUP agent với TOOLS_LOOKUP set
- [x] **P2-A2** `ai-chat/app/agents/insight_agent.py` — INSIGHT agent với investigation plan + 15 tool calls
- [x] **P2-A3** `ai-chat/app/agents/explore_agent.py` — EXPLORE agent với TOOLS_EXPLORE set
- [x] **P2-A4** `ai-chat/app/agents/viz_agent.py` — VIZ agent với TOOLS_VIZ + chart type guide
- [x] **P2-A5** `ai-chat/app/prompts/insight.py` — narrative mode, multi-step reasoning, phân tích sâu
- [x] **P2-A6** `orchestrator.py` route qua `agent_config.tool_names` → `get_tool_schemas()` — each intent gets filtered tool set

Data layer:
- [x] **P2-D1** `date_bucket` parameter thêm vào `query_table` schema (column + granularity: day/week/month/quarter/year)
- [ ] **P2-D2** Backend implementation (date_trunc SQL) — cần backend team thực hiện
- [x] **P2-D3** `context_builder.py` extract `sample_values` từ `column_stats.top_values` (top 5)
- [x] **P2-D4** `context_builder.py` extract `range` (min–max) cho numeric columns

Kiểm thử Phase 2:
- [ ] **P2-T1** So sánh InsightAgent vs direct Claude (cần môi trường + dataset thực)
- [ ] **P2-T2** Test date_bucket với real query (cần backend support P2-D2)
- [ ] **P2-T3** Test INSIGHT tool call count >= 3 per turn (cần real LLM)
- [x] **P2-T4** context_builder sample values verified: status='0'/'1', deadline='TRUE'/'FALSE'
- [ ] **P2-T5** Response time test (cần môi trường)
- [ ] **P2-T6** QueryAgent response time (cần môi trường)

---

### PHASE 3 — Governance + Cost Control
**Thời gian ước tính:** 1–2 tuần  
**Mục tiêu:** Visibility hoàn toàn về cost, rate limiting, không đốt tiền mù

#### 3.3.1 GovernanceAgent

Không phải 1 agent gọi LLM — là 1 middleware layer chặn mọi LLM call:

```python
class GovernanceMiddleware:
    async def before_call(self, agent_config, messages) -> Decision:
        # Estimate tokens
        # Check user budget
        # Check rate limit
        # Return: ALLOW / DENY / DOWNGRADE_MODEL

    async def after_call(self, response, metrics_ctx):
        # Extract actual token usage
        # Update user spend tracker
        # Alert if anomaly (query quá đắt)
        # Log to monitoring
```

#### 3.3.2 Per-User Rate Limiting

```
Cơ chế đề xuất:
- In-memory counter per user_id (hoặc Redis nếu multi-instance)
- Limits: 30 requests/hour/user cho LOOKUP, 10 requests/hour/user cho INSIGHT
- Response 429 với retry-after header khi vượt limit
```

#### 3.3.3 Checklist Phase 3

**Trước khi bắt đầu code Phase 3, phải xác nhận:**

- [ ] **PRE-01** Phase 2 đã hoàn thành và stable trong ít nhất 1 tuần production
- [ ] **PRE-02** Có data về cost từ Phase 1+2 để set budget thresholds hợp lý
- [ ] **PRE-03** Quyết định dùng in-memory counter hay Redis cho rate limiting

**Công việc code Phase 3:**

Governance:
- [x] **P3-G1** `ai-chat/app/agents/governance.py` — `RateLimiter` class + `check_token_budget()` + `aggregate_session_usage()`
- [x] **P3-G2** Token extraction: OpenAI dùng `stream_options=include_usage` (Phase 1), Anthropic dùng `response.usage` (Phase 1)
- [ ] **P3-G3** DB table `chat_token_usage` — cần backend migration (optional, hiện log to file đủ)
- [x] **P3-G4** `RateLimiter` in-memory sliding window: LOOKUP=60/h, EXPLORE=30/h, INSIGHT=10/h, CREATE=20/h
- [x] **P3-G5** Rate limit check trong WebSocket handler (`_run_and_send`)
- [x] **P3-G6** `check_token_budget()`: WARNING >15K tokens, CRITICAL >50K tokens
- [x] **P3-G7** `/chat/usage/{session_id}` endpoint + estimated cost (GPT-4o-mini proxy pricing)
- [x] **P3-G8** `/chat/rate-limits` endpoint hiển thị usage/limit per intent

Kiểm thử Phase 3:
- [ ] **P3-T1** Verify token counts với real LLM call
- [x] **P3-T2** Rate limit logic verified: INSIGHT capped at 10, unit test passed
- [ ] **P3-T3** Budget alert với large context (cần real LLM)
- [ ] **P3-T4** `/chat/usage` endpoint (cần môi trường)

---

### PHASE 4 — Feedback Loop & Learning (Dài hạn)
**Thời gian ước tính:** 4–8 tuần  
**Mục tiêu:** Hệ thống tự cải thiện theo thời gian dựa trên feedback người dùng

#### 3.4.1 Tổng quan

Tận dụng thumbs up/down feedback đã có trong schema `ChatMessage`, xây dựng:

1. **Feedback Analyzer**: Phân tích pattern — câu hỏi nào thường nhận thumbs down, intent nào bị classify sai
2. **Prompt Improver**: Gợi ý thay đổi system prompt dựa trên failure patterns
3. **Few-shot Examples**: Tự động chọn câu hỏi được đánh giá tốt làm few-shot examples cho similar intents
4. **Context Personalizer**: Nhớ preferences của từng user/team (thích format nào, thường hỏi về gì)

#### 3.4.2 Checklist Phase 4

**Trước khi bắt đầu code Phase 4, phải xác nhận:**

- [ ] **PRE-01** Phase 3 stable, có ít nhất 1 tháng data feedback từ team DA
- [ ] **PRE-02** Có đủ volume: >= 200 rated messages để phân tích pattern
- [ ] **PRE-03** Quyết định: prompt improvement thủ công (team review) hay tự động

**Công việc code Phase 4:**

- [x] **P4-F1** `ai-chat/app/agents/feedback_analyzer.py` — `FeedbackAnalyzer` class + `RatedExample` dataclass
- [x] **P4-F2** `get_satisfaction_stats()` — per-intent satisfaction rate từ rated messages
- [x] **P4-F3** `get_best_examples(intent, limit)` — top-rated Q&A pairs cho few-shot
- [x] **P4-F4** `enrich_insight_prompt()` + `get_enriched_insight_prompt()` — lazy inject vào INSIGHT prompt
- [x] **P4-F4b** Wire vào `run_agent()` — INSIGHT intent tự động nhận few-shot enrichment
- [ ] **P4-F5** User preference store (dài hạn — chờ đủ data)
- [x] **P4-F6** `/chat/admin/feedback-stats` endpoint + `/chat/admin/feedback-reload` endpoint
- [x] **P4-F7** `get_failure_patterns()` — identify common tool patterns in failed responses

---

## 4. File Structure sau khi hoàn thành

```
ai-chat/
├── app/
│   ├── agents/
│   │   ├── orchestrator.py          # Router only (sau Phase 2)
│   │   ├── intent_classifier.py     # NEW — Phase 1
│   │   ├── query_agent.py           # NEW — Phase 2
│   │   ├── insight_agent.py         # NEW — Phase 2 (quan trọng nhất)
│   │   ├── explore_agent.py         # NEW — Phase 2
│   │   ├── viz_agent.py             # NEW — Phase 2
│   │   ├── governance.py            # NEW — Phase 3
│   │   ├── feedback_analyzer.py     # NEW — Phase 4
│   │   ├── context_builder.py       # UPDATED — Phase 1 (sample values)
│   │   └── tools.py                 # UPDATED — Phase 2 (date_bucket)
│   ├── prompts/
│   │   ├── lookup.py                # NEW — Phase 1
│   │   ├── explore.py               # NEW — Phase 1
│   │   ├── insight.py               # NEW — Phase 2
│   │   └── viz.py                   # NEW — Phase 2
│   └── ...
└── UPGRADE_PLAN.md                  # File này
```

---

## 5. Rủi ro & Mitigation

| Rủi ro | Khả năng | Impact | Mitigation |
|--------|----------|--------|------------|
| Intent Classifier classify sai → user frustration | MEDIUM | HIGH | Fallback: nếu classifier fail → dùng LOOKUP mode (safe default) |
| InsightAgent chậm (> 45s) với 15 tool calls | HIGH | MEDIUM | Timeout riêng cho InsightAgent (60s), streaming giữ UX tốt |
| date_bucket thay đổi backend API | MEDIUM | MEDIUM | Implement ở AI Chat layer trước (post-process rows), sau đó optimize backend |
| Phase 2 refactor break existing sessions | MEDIUM | HIGH | Feature flag: mới/cũ song song, migration dần dần |
| Model cost tăng với InsightAgent (3000 tokens) | HIGH | MEDIUM | Rate limit INSIGHT intent thấp hơn (10/hour), track cost từ Phase 3 |

---

## 6. Definition of Done — Toàn bộ dự án

Hệ thống được coi là upgrade thành công khi:

- [ ] Câu hỏi vague → AI hỏi lại, không đoán
- [ ] Câu insight ("tại sao X?") → narrative >= 500 chữ với evidence từ data
- [ ] So sánh InsightAgent vs direct Claude với 10 câu test: gap <= 25%
- [ ] Token cost visible trong admin dashboard
- [ ] Rate limiting hoạt động, không có uncontrolled spending
- [ ] Intent classification accuracy >= 90% trên test set 50 câu
- [ ] Satisfaction rate (thumbs up) >= 80% sau 1 tháng production

---

*Tài liệu này là living document — cập nhật sau mỗi phase khi có thay đổi yêu cầu.*
