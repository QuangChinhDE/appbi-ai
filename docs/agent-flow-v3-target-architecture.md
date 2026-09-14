# Agent Flow V3 — Target architecture

Tài liệu này mô tả **kiến trúc đích của AppBI**. Không có câu nào dạng "làm giống
Dify". Phần đối chiếu Dify nằm ở [gap analysis](agent-flow-v3-dify-gap-analysis.md).

---

## 1. Nguyên tắc

```
Node       mô tả orchestration primitive — "bước này là loại gì"
Tool       mô tả capability             — "làm được việc gì"
Strategy   mô tả cách Agent suy nghĩ    — "quyết định theo lối nào"
Skill      mô tả năng lực tái sử dụng   — "một Flow đã publish, có input/output"
Runtime    bảo vệ permission, capability, budget, correctness
```

> **AI tự do bên trong ranh giới đó. Runtime không tự do ở security và data correctness.**

Và ba cấp rule, giữ nguyên từ vòng trước:

| Cấp | Hành vi |
|---|---|
| 🔴 **Hard Constraint** — permission, scope, capability, budget trần, raw-row exposure | runtime **chặn**, không override |
| 🟠 **Guardrail** — >6 tool/node, answer node còn tool, read quá rộng, forecast chưa kiểm seasonality | cho chạy, cảnh báo rõ, author override được |
| 🟢 **Agent Freedom** — gọi tool nào trước, specialist nào chạy, mấy vòng reasoning | AI tự quyết trong budget |

---

## 2. Sơ đồ

```
Bot / Chat / API / (Trigger sau)
              │
              ▼
        ┌───────────┐
        │  FlowRun  │  ← có lifecycle, checkpoint được
        └─────┬─────┘
              │
      Runtime Layer Stack
   (before_node / after_node)
              │
   ┌──────────┼───────────┐
   ▼          ▼           ▼
ToolNode  AgentNode  Control nodes
             │        (if/switch/loop/coordinate)
             ▼
       AgentRuntime
             │
        AgentStrategy
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
   Tools  Skills  Knowledge
     │       │
     │       └── published Flow (typed I/O)
     ▼
 Unified Capability Registry
     │
 ┌───┴───┬────────┬──────────┐
 ▼       ▼        ▼          ▼
Native  MCP     HTTP     Base Apps
```

---

## 3. Contract

### 3.1 `ToolSpec` — mở rộng, không thay

Giữ nguyên mọi field hiện có. Thêm đúng hai thứ:

```
ToolSpec
  name, fn, definition              (input_schema model nhìn thấy)
  label_vi / label_en / description_vi
  cost_class, payload
  result_kind, returns              ← GIỮ: prose cho người đọc
  output_schema                     ← MỚI: machine-readable, cho ToolNode/FE wiring
  deterministic, cacheable, self_sufficient
  reaches_outside
  data_exposure                     metadata | derived | raw_rows
  resource_refs                     {argument: chart|document|dataset|metric}
  risk                              ← MỚI: none | side_effect | irreversible
```

**`returns` không bị thay bằng `output_schema`.** Hai thứ phục vụ hai người đọc:
`returns` là câu văn cho author chọn tool và cho người debug; `output_schema` là
JSON Schema cho ToolNode wire biến. Ép một cái làm cả hai là lý do `returns` hôm nay
có key kiểu `'actual / target'` — prose bị đọc như schema.

`risk` là tiền đề của Human Approval: approval gắn vào **thuộc tính của tool**, không
gắn vào prompt.

### 3.2 `ToolNode` — node mới, một cái duy nhất

```
ToolNode
  tool:       "rank_values"
  inputs:     {chart_id: "{{sales_chart}}", top_n: 5}
  output_var: "top_categories"
  on_error:   continue | stop | retry
```

Không gọi LLM. Gọi qua **đúng** `registry.execute()` hiện tại → capability gate,
resource scope, payload ceiling, cache, error taxonomy áp dụng nguyên vẹn, không viết
lại dòng nào.

**Bất biến:** ToolNode không bypass gate nào. Node type là grant (giống `report_read`),
nhưng `data_exposure` và `resource_refs` vẫn phải qua.

### 3.3 `AgentStrategy` — interface

```
AgentStrategy
  prepare(node, state, rctx)        → messages ban đầu, tool schema
  step(context)                     → model call, trả tool_calls | answer
  consume_tool_result(call, result) → đưa kết quả vào context
  should_continue(context)          → bool, trong budget
  finish(context)                   → Answer
```

`AgentRuntime` sở hữu vòng lặp, budget, trace, retry. Strategy chỉ quyết định **thứ tự
suy nghĩ**.

Strategy đầu tiên: `tool_calling` = **behaviour hiện tại, không đổi một hành vi nào**.
Đó là tiêu chí nghiệm thu của bước migration, không phải mong muốn.

Sau đó mới cân nhắc `react`, `planner_executor`. **Data Analyst là Skill hoặc Strategy,
không phải 15 node BI mới.**

### 3.4 `Skill` — published Flow có typed I/O

```
Skill
  flow_key + version
  inputs:  {period: string, region: string}    ← từ output_schema
  outputs: {causes: array, evidence: array, confidence: number}
  permissions: giao với caller, không bao giờ rộng hơn
```

Agent gọi Skill **qua cùng Tool Registry** — nó không cần biết đây là native tool hay
sub-flow.

Hard constraint bắt buộc có trước feature:

```
max_depth              (mặc định 3)
cycle detection        (A → B → A bị chặn ở đăng ký, không phải lúc chạy)
budget inheritance     (child tiêu vào budget của parent)
permission intersection (GIAO, không phải quyền của skill)
trace parent/child
```

**Permission intersection là chỗ dễ sai nhất của cả V3.** Một skill do người quyền
rộng publish, gọi từ flow của người quyền hẹp, phải chạy với quyền hẹp.

### 3.5 `RunCheckpoint` — lifecycle

```
FlowRun.status:  RUNNING → PAUSED → WAITING_HUMAN → RESUMED → SUCCEEDED | FAILED

RunCheckpoint
  flow_version
  node_position
  variables
  evidence
  budgets (đã tiêu / còn lại)
  agent_state
  pending_actions
  permission_reference        ← KHÔNG snapshot giá trị quyền
```

**`permission_reference`, không phải snapshot.** Snapshot quyền rồi resume sau ba ngày
là dùng quyền đã bị thu hồi. Resume **re-check** qua binding, và nếu quyền đã hẹp đi
thì run fail có lý do, không im lặng chạy tiếp.

Không giữ HTTP request mở chờ người.

### 3.6 Human-in-the-loop — hai khái niệm tách bạch

| | Khi nào | Cơ chế |
|---|---|---|
| **Human Input** | thiếu dữ liệu để tiếp tục | tool `ask_human` → run kết thúc với `deferred_call` |
| **Human Approval** | action có `risk != none` | runtime chặn **trước** khi tool chạy → `deferred_approval` |

Cả hai đều: run **kết thúc thành công** với một pending action, không treo. Resume là
**run mới** mang `checkpoint_id` + kết quả người trả lời.

**Bắt buộc:** nội dung trong `deferred_call` do model sinh ra. Phải sanitize trước khi
render ở builder và chat — AppBI render markdown, đây là đường XSS thẳng.

### 3.7 Runtime Layer Stack

```
RuntimeLayer
  before_node(node, state, rctx)  → có thể raise để chặn
  after_node(node, state, rctx, result)
```

Layer dự kiến, theo thứ tự:

```
AuthorizationLayer   resource scope — hôm nay rải ở data.py
CapabilityLayer      read_rows / web_search — hôm nay ở dispatch + registry
BudgetLayer          hôm nay là state.budget.check() trong _run_node
ExecutionLayer       reuse / retry / on_error — hôm nay trong _run_node
EvidenceLayer        hôm nay ở executor cuối run
ObservabilityLayer   TraceStep — hôm nay trong _run_node
```

**Bước 1 chỉ trích những gì đã có ra thành layer. Không thêm hành vi.** Danh sách trên
là đích, không phải PR đầu tiên.

---

## 4. Bất biến của V3

Những câu này phải đúng sau mọi phase. Mỗi câu là một test.

1. Tool chạm resource ngoài grant → `chart_out_of_scope` / `not_granted`.
2. `read_rows=False` → tool `raw_rows` bị chặn, tool `derived` **vẫn chạy**.
3. `web_search=False` → mọi tool `reaches_outside` bị chặn tại call-time.
4. Không result nào vượt `max_result_tokens` mà vào prompt.
5. Skill không bao giờ nới quyền của caller.
6. Resume re-check quyền, không dùng quyền đã snapshot.
7. Tool có `risk != none` không chạy khi chưa được duyệt.
8. Mọi con số trong câu trả lời trace được về evidence.
9. Fallback listing không bao giờ được caller tất định coi là match.
10. Flow đã lưu trước V3 chạy ra **cùng kết quả** sau V3.

---

## 5. Bảy câu hỏi trước mỗi capability mới

Từ V3, PR thêm capability phải trả lời:

1. Đây là Node, Tool, Strategy, Skill, Trigger hay Datasource?
2. Tại sao primitive hiện tại không biểu diễn được?
3. Permission boundary ở đâu?
4. Capability/risk boundary ở đâu?
5. Input/output contract là gì?
6. Runtime trace/evidence thể hiện thế nào?
7. Eval nào chứng minh behavior đúng?

Nếu câu 2 trả lời là *"dễ code hơn nếu thêm node mới"* → **reject**.

Nếu một rule phải check ở 4 handler → nó là **Runtime Layer invariant**.

Nếu model phải nhớ một security rule bằng prompt → **security architecture sai**.

---

## 6. Không làm

Graph/DAG · clone `web/` · Plugin Daemon · Marketplace · 20 node mới · nhiều
AgentNode type · thay BI tool bằng code execution · bỏ permission/binding hiện tại ·
Planner/Multi-Agent trước khi `AgentStrategy` ổn định · tách microservice.

---

## 7. North-star

> Không phải "Dify phiên bản Base.vn".
>
> Một Agent Platform cho **enterprise data**: có runtime discipline và extensibility
> của một platform trưởng thành, nhưng giữ **BI correctness**, **permission model** và
> **evidence verification** mà một LLM platform đa mục đích không có.
