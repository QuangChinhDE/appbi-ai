# Agent Flow V3 — Target architecture

Tài liệu này mô tả **kiến trúc đích của AppBI**. Không có câu nào dạng "làm giống
Dify". Phần đối chiếu Dify nằm ở [gap analysis](agent-flow-v3-dify-gap-analysis.md).

> **Rev 2** — amend sau review. 11 điểm sửa được đánh dấu **[A1]**…**[A11]** tại chỗ.
> Backbone không đổi; ranh giới thì có.

---

## 0. Hiện trạng — đã xây (2026-09, nhánh `feat/agent-flow-v3-capabilities`)

> **User giữ cấu trúc. AI giữ suy luận cục bộ. Runtime giữ luật.**
> Flow là nguồn sự thật về quyền điều phối; Runtime là nguồn sự thật về quyền,
> phạm vi, ngân sách và bất biến thực thi.

### Bản đồ khái niệm — đúng tên trong code

| Khái niệm | Là gì | Ai quyết định bên trong | Ở đâu |
|---|---|---|---|
| **Flow** | kiến trúc ra quyết định do author vẽ: một cây node | author — thứ tự, nhánh, vùng tự chủ, grant, roster | `contract.py` `Flow` |
| **Node** | primitive điều phối | tuỳ loại, dưới đây | `contract.py` union `Node` |
| ToolNode | "chạy đúng capability này" | author; không model | `handlers/data.py:run_tool` |
| If / Switch / Loop / Filter | định tuyến tất định | author; không model | `runtime/executor.py` |
| **Skill node** | "chạy capability tái sử dụng có quản trị này" | author chọn *có chạy*; flow của Skill quyết *chạy thế nào* | `handlers/skill.py` |
| **Agent** | vùng tự chủ: mục tiêu + capability được cấp | model, cục bộ, trong grant | `handlers/agent.py` |
| **Coordinator** | chọn specialist có giới hạn | model chọn tập con roster, ≤ `max_specialists`; không lồng coordinator | `executor.py:_run_coordinate` |
| **Tool** | capability nguyên tử | — | `tools/registry.py` |
| **Skill** | flow đã publish có contract (input/output/khi nào dùng), chạy như child run | — | `services/agent_flows/skills.py` |
| **Capability** | thứ Agent được cấp: Tool hoặc Skill | — | `runtime/capabilities.py` |
| **Strategy** | cách Agent suy luận (hội thoại, khi nào gọi, khi nào dừng) | strategy — không I/O | `runtime/strategies/` |
| **Runtime** | thực thi + cưỡng chế: provider, capability, budget, retry, trace, gate | runtime — không bao giờ là prompt | `runtime/agent_runtime.py`, `registry.execute` |

Bất biến **A** (quyền điều phối): model không thể thêm, bỏ, đổi thứ tự hay thay node.
Đầu ra mang tính cấu trúc của nó chỉ có hai: giá trị `choice` (kiểm tra trong code) và
tập specialist (quét theo roster). V3 không thêm cái thứ ba.

Bất biến **R** (luật): capability chỉ chạy nếu `registry.execute()` (tool) hoặc
`skills.invoke_skill` (Skill) chấp nhận theo grant, scope, cờ năng lực, risk và budget.

### Đã xây theo phase

| Phase | Trạng thái | Gì thay đổi | Khoá bằng |
|---|---|---|---|
| 1 Governance | xong | `risk≠read_only` bị chặn (`risk_unknown`/`needs_approval`) — một luật trong `_capability_refusal`; nhu cầu web suy ra từ `reaches_outside`; tool không tồn tại chặn publish; coordinator lồng bị cấm ở validator; chi phí preflight đi theo `child_node_lists` | `test_governance_promises_are_kept.py` |
| 2 Strategy/Runtime | xong | `AgentRuntime` + `ToolCallingStrategy`; `AgentNode.strategy` (một giá trị) | 16 replay fixture không đổi; `test_strategy_is_pure.py` |
| 3 Compute | xong | biến = `{ref, path}` vào `RunState.evidence_store`; runtime tự đọc giá trị; literal mọi độ lớn; số tự gõ tính được nhưng **không bao giờ được xác thực** | `test_compute_owns_the_number.py`, `test_compute_lineage_in_a_run.py` |
| 4 Capability discovery | xong | grant → eligible (luật admission của registry) → visible (≤ `AGENT_FLOW_VISIBLE_CAPABILITIES`, mặc định 12) + `find_capability`; gọi thứ chưa hiện → `capability_not_visible` | `test_capability_discovery.py` |
| 5 Skill | xong | một primitive `invoke_skill`; child run có `parent_run_key`/`parent_step_key`/`invoked_as`; quyền = caller ∩ contract Skill; budget của cha; ghim version lúc publish; chặn vòng lặp theo (key, version), sâu ≤ 3 | `test_skills_run_as_governed_children.py` + script đột biến 8/8 |
| 6 UX | xong | Skill trong picker; nhóm Dữ liệu/Phân tích/Tri thức/Bên ngoài (chỉ là trình bày); editor bước Skill; contract editor; Runs hiện child run và capability view | tsc, `npm run qa`, E2E |
| 3.3 Runtime Layer Stack | **chưa** | không mục tiêu nào ở trên cần nó | — |
| 3.5 / 3.6 Checkpoint, HITL | **chưa** | `needs_approval` là cửa chờ cho 3.6 | — |
| 3.8 MCP/HTTP | **chưa** | `ExtraCapability` là chỗ để cắm vào catalogue | — |

### Khác với kế hoạch ban đầu, và vì sao

- **Provenance của compute bằng tham chiếu, không bằng khớp giá trị.** Khớp giá trị
  không phân biệt được `Doanh thu 2025 = 100` với `Mục tiêu = 100`.
- **Giới hạn hiển thị mặc định 12, không 8.** Starter V1 cấp 10 tool; giới hạn 8 sẽ đổi
  một hành trình đã chứng nhận khi chưa có eval nói shortlist tốt hơn.
- **Model chỉ gọi được thứ đang hiện hoặc đã tìm thấy.** Không có đường "nhớ tên thì gọi".
- **Skill không chạy bằng quyền của owner.** Owner chỉ có ý nghĩa lúc author/publish.
- **Child run nối bằng `parent_run_key`, không bằng FK id.** Child ghi xong giữa lượt,
  trước khi hàng của cha tồn tại; và vẫn nối được khi người xem bỏ lượt giữa chừng.
- **Child run không mang session/link của người đọc**, để rating công khai chỉ khớp run
  người đọc thực sự nói chuyện.
- **`compute` chưa khai báo `output_schema`** — contract yêu cầu kiểm với kết quả thật
  của một báo cáo trước.
- **Lỗi phát hiện dọc đường**: registry nạp pack không an toàn khi đa luồng (hai request
  đầu tiên cùng đăng ký `discover` → 500). Sửa bằng khoá + cờ `_LOADED`.

### Giới hạn còn lại

- Skill không có khai báo chart riêng: child dùng đúng chart của caller.
- `question` của child chỉ có khi Skill khai báo input tên `question`; không có thì
  dimension gate trong child im lặng (theo thiết kế: không có câu hỏi để so).
- Chi phí preflight của một Skill là hằng số bảo thủ; trần cứng là budget lúc chạy.
- Lời nhắc ngôn ngữ sau vòng lặp vẫn "chết" như trước (giữ nguyên khi tách Strategy;
  sửa là thay đổi hành vi riêng).

---

## 1. Nguyên tắc

```
Node       mô tả orchestration primitive — "bước này là loại gì"
Tool       mô tả capability             — "làm được việc gì"
Strategy   mô tả cách Agent quyết định  — "quyết định theo lối nào"
Skill      mô tả năng lực tái sử dụng   — "một Flow đã publish, có input/output"
Runtime    thực thi, và bảo vệ hard invariant
```

Ba câu chốt của V3:

> **Runtime abstraction sinh ra để giảm số nơi phải nhớ rule — nhưng hard
> security/data-correctness rule vẫn enforce ở boundary THẤP NHẤT nơi hành động thực
> sự xảy ra.**
>
> **Strategy quyết định; Runtime thực thi. Capability có contract chung; executor có
> thể khác nhau.**
>
> **Golden Replay bảo vệ migration; Agent Eval bảo vệ chất lượng Agent. Hai thứ không
> thay nhau.**

Ba cấp rule giữ nguyên:

| Cấp | Hành vi |
|---|---|
| 🔴 **Hard Constraint** — permission, scope, capability, budget trần, raw-row exposure | runtime **chặn**, không override |
| 🟠 **Guardrail** — >6 tool/node, answer node còn tool, read quá rộng | cho chạy, cảnh báo rõ, author override được |
| 🟢 **Agent Freedom** — gọi tool nào trước, specialist nào chạy, mấy vòng reasoning | AI tự quyết trong budget |

---

## 2. Sơ đồ

```
Bot / Chat / API / (Trigger sau)
              │
              ▼
        ┌───────────┐
        │  FlowRun  │  logical execution, có lifecycle
        │           │
        │  Attempt  │  một lần worker chạy; defer/kết thúc   [A9]
        └─────┬─────┘
              │
      Runtime Layer Stack          ← around/middleware      [A2]
      (early policy, orchestration)
              │
   ┌──────────┼───────────┐
   ▼          ▼           ▼
ToolNode  AgentNode  Control nodes
             │        (if/switch/loop/coordinate)
             ▼
       AgentRuntime                ← sở hữu execution       [A3]
             │
        AgentStrategy              ← chỉ quyết định
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
   Tools  Skills  Knowledge
     │       │
 Unified Capability Registry (catalogue)                    [A4]
     │
 ┌───┴────────┬──────────┬───────────┐
 ▼            ▼          ▼           ▼
ToolInvoker SkillInvoker MCPInvoker HTTPInvoker
     │            │          │           │
     └────────────┴────┬─────┴───────────┘
                       ▼
        ╔══════════════════════════════╗
        ║  HARD GATE — enforcement     ║   [A1]
        ║  capability · resource scope ║
        ║  payload ceiling · risk      ║
        ╚══════════════════════════════╝
                       ▼
                  thực thi thật
```

---

## 3. Contract

### 3.1 `ToolSpec` — mở rộng, không thay

```
ToolSpec
  name, fn, definition              (input_schema model nhìn thấy)
  label_vi / label_en / description_vi
  cost_class, payload
  result_kind, returns              GIỮ: prose cho người đọc
  output_schema                     MỚI: JSON Schema của result.data      [A5]
  deterministic, cacheable, self_sufficient
  reaches_outside
  data_exposure                     metadata | derived | raw_rows
  resource_refs                     {argument: chart|document|dataset|metric}
  risk                              unknown | read_only | side_effect | destructive  [A7]
```

#### **[A5]** `output_schema` mô tả `result.data`, KHÔNG phải cả envelope

Envelope hôm nay (`result.ok()`) là:

```python
{"ok": True, "kind": kind, "data": payload}    # + "coverage" khi có
```

`ok` / `kind` / `coverage` / `error_code` là **platform contract chung** — mọi tool
đều có, không tool nào cần khai lại. `output_schema` chỉ mô tả `data`:

```
rank_values.output_schema = {items: [...], total: number, group_count: integer}
```

Nhờ vậy ToolNode expose `{{ranking.items}}`, không phải `{{ranking.data.items}}`, và FE
không cần biết envelope nội bộ.

**`returns` không bị thay bằng `output_schema`.** Hai thứ, hai người đọc: `returns` là
câu văn cho author chọn tool và cho người debug; `output_schema` là JSON Schema cho
máy nối biến. Ép một cái làm cả hai chính là lý do `returns` hôm nay có key kiểu
`'actual / target'` — prose bị đọc như schema.

#### **[A7]** `risk` không được fail-open

Bản Rev 1 đề xuất `none | side_effect | irreversible`, default `"none"`. Sai về
security cho tool **tương lai**: ngày mai ai đó thêm `delete_record` / `send_email` /
`update_workboard` và quên khai, tool nguy hiểm nhất tự động được coi là an toàn.

```
unknown       chưa phân loại — KHÔNG được chạy nếu là action
read_only     chỉ đọc
side_effect   có tác động, hoàn tác được
destructive   không hoàn tác được
```

Default là **`unknown`**. Migration an toàn tuyệt đối vì kiểm rồi: trong 36 tool hiện
tại **không tool nào ghi** (không có `INSERT`/`UPDATE`/`DELETE`/`db.add`/`db.commit`
trong bất kỳ pack nào), 5 tool `reaches_outside` đều là đọc web. Nên cả 36 migrate
sang `read_only` một lần, không cái nào đổi hành vi.

CI test: tool mới không khai `risk` → `unknown` → test yêu cầu khai explicit, giống
`data_exposure` hôm nay.

### 3.2 `ToolNode`

```
ToolNode
  tool:       "rank_values"
  inputs:                          ← typed, không phải template string   [A6]
    chart_id: {source: variable, ref: "sales_chart"}
    top_n:    {source: literal,  value: 5}
  output_var: "top_categories"
  on_error:   continue | stop | retry
```

#### **[A6]** input persisted phải typed

FE vẫn hiển thị `{{sales_chart}}` cho dễ nhìn, nhưng **contract lưu xuống là structured**.
Template string tự do thì `integer → string`, `object → "[object Object]"`,
`array → text`, `null → ""` — và mất luôn khả năng validate lúc publish:

```
output_schema của node A  ──khớp?──>  input_schema của tool B
```

Kiểm tra đó là **lợi ích lớn nhất** của `output_schema`. Đừng phá nó bằng string
templating.

Không gọi LLM. Gọi qua **đúng** `registry.execute()` hiện tại → capability gate,
resource scope, payload ceiling, cache, error taxonomy áp dụng nguyên vẹn.

**Bất biến:** ToolNode không bypass gate nào.

### 3.3 `AgentStrategy` — quyết định, không thực thi **[A3]**

Rev 1 cho `step()` tự gọi model. Sai: ba strategy sẽ tự implement ba kiểu retry, ba
kiểu budget, ba kiểu telemetry — đúng vấn đề V3 sinh ra để giải.

```
AgentStrategy                       ← thuần quyết định, không I/O
  build_model_request(context)      → messages + tool schema
  interpret_model_response(resp)    → tool_calls | answer | stop
  on_tool_result(call, result)      → cập nhật context
  should_continue(context)          → bool
  build_final_answer(context)       → Answer
```

```
AgentRuntime                        ← sở hữu TUYỆT ĐỐI
  provider invocation
  tool execution (qua Capability Registry)
  budget, tool-call ceiling, timeout, retry
  trace, telemetry
  capability enforcement
```

Strategy không import provider adapter, không gọi `registry.execute()`. Nếu một
strategy cần cái gì đó Runtime chưa cho, sửa Runtime — không để strategy tự lấy.

Strategy đầu tiên: `tool_calling` = **behaviour hiện tại, zero behavior change**. Đó
là tiêu chí nghiệm thu, không phải mong muốn.

### 3.4 Capability Registry — **catalogue chung, executor riêng** **[A4]**

Rev 1 viết "Skill gọi qua cùng Tool Registry" — dễ bị hiểu thành
`ToolSpec(name="analyze_sales", fn=run_another_flow)`, biến registry thành god object.

Skill khác native tool ở mức căn bản:

| Tool | Skill |
|---|---|
| một invocation | một **FlowRun** |
| không có child | nhiều NodeRun, child trace |
| budget của caller | budget **inheritance** |
| scope của caller | **permission intersection** |
| không checkpoint | checkpoint được |
| không gọi cái khác | gọi Skill khác được |

```
Capability                      ← Agent nhìn thấy CÙNG một thứ
  name, description
  input_schema, output_schema
  scope, risk, cost

Dispatch:
  NativeToolCapability → ToolInvoker
  SkillCapability      → SkillInvoker
  MCPToolCapability    → MCPInvoker
  HTTPToolCapability   → HTTPInvoker
```

> **Unified catalogue, specialized execution.**

Mọi invoker đều đi qua **cùng hard gate** ở §3.8.

Skill hard constraint — có test **trước** khi feature chạy:

```
max_depth (mặc định 3)
cycle detection      — chặn lúc ĐĂNG KÝ, không phải lúc chạy
budget inheritance   — child tiêu vào budget parent
permission intersection — GIAO, không bao giờ rộng hơn caller
trace parent/child
```

**Permission intersection là chỗ dễ sai nhất của cả V3.**

### 3.5 `FlowRun` / `Attempt` / `RunCheckpoint` **[A9] [A10]**

Rev 1 mâu thuẫn: "run kết thúc thành công" nhưng lifecycle lại có `WAITING_HUMAN`, mà
resume lại là "run mới". Tách hai khái niệm thì hết mâu thuẫn:

```
FlowRun    logical execution — thứ người dùng thấy là "một lần chạy"
Attempt    một lần worker thực thi — kết thúc hoặc defer
```

```
FlowRun #100  status = WAITING_HUMAN
  └ Attempt #1  status = DEFERRED   checkpoint = xyz
        … người duyệt (2 tiếng sau) …
  └ Attempt #2  resume checkpoint xyz  status = SUCCEEDED
FlowRun #100  status = SUCCEEDED
```

UI thấy **một** run, không phải ba run rời rạc. Worker không giữ request mở.

#### **[A10]** Checkpoint phải là continuation, không phải `node_position`

**Phát hiện khi đọc executor, và nó đắt hơn dự tính:** `_run_body()` chạy body lồng
nhau bằng **đệ quy async generator** (`async for ev in _run_body(chosen.body, …)` ở
nhánh if, switch, loop, coordinate, fallback). Nghĩa là continuation hiện nay **chính
là Python call stack** — không serialize được. Checkpoint không phải bài toán schema
DB, nó là bài toán **control flow của executor**.

Checkpoint phải mang đủ:

```
flow_version           pin — không resume checkpoint v3 trên flow v4
continuation cursor    body path hiện tại + node kế tiếp
                       loop frames (index, collection)
                       branch frames (branch_stack)
variables              state.vars + outputs
evidence
budget ledger          đã tiêu / còn lại
agent_state
pending_action
permission_reference   KHÔNG snapshot giá trị quyền
```

**Đề xuất cơ chế, dùng thứ đã có:** AppBI đã có `run_policy` + `_reuse()` memo hoá
output của node qua lượt. Resume có thể là **chạy lại từ đầu, mỗi node đã hoàn thành
tái dùng output đã ghi, cho tới khi gặp node đang chờ**. Re-entrant mà không cần
serialize call stack, và dùng machinery đã có test. Cần đo chi phí trước khi chốt —
nhưng đây là đường rẻ hơn nhiều so với viết lại executor thành state machine.

**`permission_reference`, không phải snapshot.** Snapshot quyền rồi resume sau ba ngày
là dùng quyền đã bị thu hồi. Resume **re-check** qua binding; quyền hẹp đi thì run fail
có lý do, không im lặng chạy tiếp.

### 3.6 Human-in-the-loop

| | Khi nào | Cơ chế |
|---|---|---|
| **Human Input** | thiếu dữ liệu để tiếp tục | tool `ask_human` → attempt kết thúc với `deferred_call` |
| **Human Approval** | tool có `risk` ∈ {side_effect, destructive} | runtime chặn **trước** khi tool chạy → `deferred_approval` |

Cả hai: attempt **kết thúc**, FlowRun ở `WAITING_HUMAN`, không treo request. Resume tạo
**attempt mới** dưới cùng FlowRun.

**Bắt buộc:** nội dung trong `deferred_call` do model sinh. Sanitize trước khi render ở
builder và chat — AppBI render markdown, đây là đường XSS thẳng.

### 3.7 Runtime Layer Stack — around/middleware **[A2]**

`before_node` / `after_node` không biểu diễn được `reuse` (bỏ qua handler hoàn toàn)
hay `retry` (chạy lại cả node) — hai thứ `_run_node()` đang làm. Ép vào before/after
thì layer sẽ mutate state, trả sentinel, ném exception đặc biệt, và abstraction bẩn.

```
RuntimeLayer.invoke(node, context, call_next) -> result
```

```
AuthorizationLayer
  └ call_next()
      BudgetLayer
        └ call_next()
            ReuseLayer        ← có thể KHÔNG gọi call_next
              └ call_next()
                  RetryLayer  ← có thể gọi call_next NHIỀU LẦN
                    └ call_next()
                        NodeHandler
```

Một layer có thể: block · skip · retry · measure · wrap exception · transform result —
mà executor không cần biết từng loại.

### 3.8 **[A1]** Layer KHÔNG thay thế hard gate — defense in depth

Đây là amend quan trọng nhất.

```
Runtime Layer        = orchestration policy, từ chối SỚM
Registry / Data layer = enforcement boundary CUỐI CÙNG
```

P0 vừa rồi đặt `_capability_refusal()` ngay trước `spec.fn()`. **Không được chuyển nó
lên layer rồi xoá khỏi registry.** Nếu xoá, mọi đường execution mới sẽ bypass:

```
Skill · MCP · direct tool call · background job · internal caller
```

và bug cũ quay lại — lần này khó thấy hơn, vì kiến trúc trông đẹp hơn.

**Quy tắc:** một hard invariant được phép xuất hiện ở **nhiều** tầng. Nó **không** được
phép rời khỏi tầng thấp nhất có thể enforce. Layer thêm vào để fail sớm và để có một
nơi đọc policy, không phải để tầng dưới bớt việc.

---

## 4. Bất biến của V3

Mỗi câu là một test. Kiểm ở cuối **mỗi** phase.

1. Tool chạm resource ngoài grant → `chart_out_of_scope` / `not_granted`.
2. `read_rows=False` → tool `raw_rows` bị chặn, tool `derived` **vẫn chạy**.
3. `web_search=False` → mọi tool `reaches_outside` bị chặn tại call-time.
4. Không result nào vượt `max_result_tokens` mà vào prompt.
5. Skill không bao giờ nới quyền của caller.
6. Resume re-check quyền hiện tại, không dùng quyền đã snapshot.
7. Tool `risk` ∈ {side_effect, destructive} không chạy khi chưa duyệt; `unknown` không chạy.
8. Mọi con số trong câu trả lời trace được về evidence.
9. Fallback listing không bao giờ được caller tất định coi là match.
10. Flow đã lưu trước V3 chạy ra **cùng kết quả** sau V3.
11. **[A1]** Mọi hard gate vẫn enforce tại registry/data layer, kể cả khi đã có layer tương ứng. Xoá gate ở tầng dưới = vi phạm, dù layer đang xanh.

---

## 5. Bảy câu hỏi trước mỗi capability mới

1. Đây là Node, Tool, Strategy, Skill, Trigger hay Datasource?
2. Tại sao primitive hiện tại không biểu diễn được?
3. Permission boundary ở đâu?
4. Capability/risk boundary ở đâu?
5. Input/output contract là gì?
6. Runtime trace/evidence thể hiện thế nào?
7. Eval nào chứng minh behavior đúng?

Câu 2 trả lời *"dễ code hơn nếu thêm node mới"* → **reject**.
Một rule phải check ở 4 handler → **Runtime Layer invariant** (nhưng vẫn giữ gate dưới).
Model phải nhớ security rule bằng prompt → **security architecture sai**.

---

## 6. Không làm

Graph/DAG · clone `web/` · Plugin Daemon · Marketplace · 20 node mới · nhiều AgentNode
type · thay BI tool bằng code execution · bỏ permission/binding hiện tại ·
Planner/Multi-Agent trước khi `AgentStrategy` ổn định · tách microservice.

---

## 7. North-star

> Không phải "Dify phiên bản Base.vn".
>
> Một Agent Platform cho **enterprise data**: có runtime discipline và extensibility
> của một platform trưởng thành, nhưng giữ **BI correctness**, **permission model** và
> **evidence verification** mà một LLM platform đa mục đích không có.
