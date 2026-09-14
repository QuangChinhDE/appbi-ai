# Agent Flow V3 — Gap analysis đối chiếu Dify

**Snapshot Dify:** `langgenius/dify` @ `6afe07f9447528f8ca2d1339b2eb148e39c4038d` (main, 2026-09-14)
**Snapshot AppBI:** `QuangChinhDE/appbi-ai` @ `82a51b5` (demo) · P0 runtime tại `14c4c38`

Mọi claim về Dify trong tài liệu này **đọc từ source tại đúng commit trên**, không từ trí nhớ.
Mọi claim về AppBI **đọc từ code tại đúng commit trên**. Chỗ nào chưa đọc được thì ghi rõ.

---

## 0. Ba điều chỉnh so với brief

Đọc code rồi thì ba chỗ trong brief cần sửa. Nói trước vì chúng đổi thứ tự việc.

### 0.1 AppBI **đã có** node factory

Brief map `Dify node_factory → (mới)`. Thực tế AppBI đã có
[`runtime/nodes.py`](../backend/app/services/agent_flows/runtime/nodes.py): `NodeSpec`
registry, `register()` từ chối node không handler, executor dispatch bằng
`node_registry.handler_for(node.type)` chứ không phải if-chain. Palette của builder
**generate từ registry**, không có danh sách thứ hai ở FE.

So với Dify `NODE_TYPE_CLASSES_MAPPING` + `DifyNodeFactory.create_node()`: cùng một
abstraction. Dify hơn ở **versioning node class** (`resolve_workflow_node_class()` xử
lý version, đặc biệt cho Agent node). Đó là gap thật, nhưng nhỏ và chưa cấp thiết.

**Kết luận: không xây node factory. Đã có.**

### 0.2 Layer của Dify **không chứa authorization**

Brief đề xuất stack `Authorization → Capability → Budget → Execution → Evidence → …`
và ngụ ý học từ Dify. Đọc `workflow_entry.py`: Dify chỉ add ba layer mặc định —

```
DebugLoggingLayer      (khi debug)
ExecutionLimitsLayer   (luôn: max_steps, max_time)
ObservabilityLayer     (khi bật OTEL)
```

hook là `on_node_run_start` / `on_node_run_end` / `on_graph_end`.

**Dify không có authorization layer.** Nó là platform đa mục đích, entitlement nằm ở
tầng app/tenant phía trên. AppBI nếu đưa authorization vào layer là **mở rộng pattern
xa hơn Dify**, không phải copy. Điều đó vẫn đúng nên làm — nhưng phải biết mình đang
tự thiết kế, không có reference để bắt chước, nên rủi ro cao hơn và cần test riêng.

### 0.3 `dify-agent` bản thân **cũng là một stack layer** — đây mới là bài học lớn

Brief đọc `dify-agent` như "Agent Run tách khỏi Workflow Run + Agent Strategy".
Đúng nhưng chưa hết. Cấu trúc `docs/dify-agent/user-manual/` là:

```
ask-human-layer          execution-context-layer   history-layer
plugin-llm-layer         plugin-tool-layer         prompt-layer
shell-layer              structured-output-layer
```

Tức Dify áp dụng ý tưởng layer ở **hai tầng**: quanh graph engine, và **bên trong
agent**. Cách agent suy nghĩ không phải một enum strategy — nó là **composition của
layer**. "Agent Strategy" là cách mô tả cho người dùng; cơ chế là composition.

Hệ quả cho AppBI ở mục 4.

---

## 1. Workflow runtime

| | |
|---|---|
| **Dify** | `WorkflowEntry.__init__` dựng `GraphEngine(workflow_id, graph, graph_runtime_state, command_channel, config)`. `command_channel` mặc định `InMemoryChannel()`. `graph_runtime_state` mang variable pool + execution context. `_run_node_with_layers()` bọc mỗi node. |
| **AppBI** | `executor.run_flow()` → `_run_body()` → `_run_node()`. Không có graph engine tách rời; executor **là** runtime. Không có command channel. |
| **Gap** | Không có kênh điều khiển ngoài (stop/pause từ ngoài vào giữa run). |
| **Cần không?** | **Chưa.** Chỉ cần khi có HITL (mục 10) hoặc run dài chạy nền. Kéo vào bây giờ là thêm concurrency mà không có use case. |
| **Áp dụng** | Hoãn tới V3.4. Khi làm thì làm cùng checkpoint, không tách. |

## 2. Runtime layers

| | |
|---|---|
| **Dify** | `GraphEngineLayer` interface, hook `on_node_run_start/end`, `on_graph_end`. Ba layer mặc định (§0.2). |
| **AppBI** | **Đã có proto-layer nhưng chưa đặt tên.** `_run_node()` hiện bọc mỗi node bằng: `state.budget.check()`, `_reuse()` (run_policy), `TraceStep` recording, token accounting trước/sau, `tool_log` windowing, xử lý `BranchStopped` / `BudgetExhausted` / retry / `on_error`. Đó chính xác là cross-cutting concerns — chỉ là viết thẳng vào một hàm. |
| **Gap** | Không extensible. Thêm concern mới = sửa `_run_node`. Và policy **thật sự** đang rải rác: `data.py` check scope 2 chỗ + capability 3 chỗ, `agent.py` check capability 2 chỗ + budget 10 chỗ. |
| **Cần không?** | **Có** — nhưng vì lý do của AppBI, không vì Dify có. Lý do: P0 vừa rồi phải sửa capability ở 2 nơi (`dispatch` ×2) và gate ở registry; lần sau thêm capability sẽ lại phải nhớ cả ba. |
| **Áp dụng** | Trích `_run_node`'s wrapper thành interface layer với đúng hai hook `before_node` / `after_node`. **Layer đầu tiên là behaviour hiện tại, zero behavior change.** Không thêm layer mới trong cùng PR. |
| **Không áp dụng** | Không copy tên layer của Dify. Không thêm `ObservabilityLayer` OTEL ở vòng này. |

## 3. Graph vs Tree

| | |
|---|---|
| **Dify** | Arbitrary node-edge graph, GraphEngine duyệt. |
| **AppBI** | Tree lồng nhau. Contract ghi rõ lý do: nested branch làm merge implicit, loại bỏ dangling edge / orphan node / accidental cycle. |
| **Gap** | Không biểu diễn được: parallel arbitrary DAG, multi-join, cross-branch sync. |
| **Cần không?** | **Không, ở vòng này.** Chưa có requirement nào trong số đó. |
| **Kết luận** | **GIỮ TREE.** Đây là mục đầu tiên trong danh sách "không làm". Chuyển sang DAG là rewrite executor, contract, builder, và mọi flow đang chạy — để đổi lấy khả năng chưa ai cần. |

## 4. Agent runtime & Agent Strategy

| | |
|---|---|
| **Dify** | `dify-agent` là package riêng, chạy sau FastAPI API, "hosts Agenton-composed Pydantic AI runs". Agent run có `session_snapshot` riêng, resume được. Bên trong là 8 layer (§0.3). |
| **AppBI** | `handlers/agent.py` — một vòng reasoning viết cứng. `AgentNode` có `prompt / provider / model / tools / knowledge / max_tool_calls / output_format / choices`. **Không có** khái niệm strategy, không có agent-run state tách khỏi node run. |
| **Gap** | (a) Không thay được cách agent suy nghĩ mà không sửa handler. (b) Agent run không có state riêng → không resume được. |
| **Cần không?** | **(a) Có. (b) Chưa — phụ thuộc checkpoint (mục 11).** |
| **Áp dụng** | Trích vòng reasoning thành `AgentRuntime` + `AgentStrategy` với interface `prepare / step / consume_tool_result / should_continue / finish`. **Strategy đầu tiên = behaviour hiện tại, zero behavior change** — đây là tiêu chí nghiệm thu, không phải mong muốn. |
| **Điều chỉnh so với brief** | Brief đề xuất strategy như enum (`tool_calling / react / planner_executor / supervisor / data_analyst`). Dify cho thấy nên tách **strategy** (thứ tự suy nghĩ) khỏi **layer** (concern cắt ngang: history, prompt, structured-output, ask-human). AppBI nên làm strategy trước, layer trong agent **sau** — và chỉ khi có concern thứ hai thật sự cần cắt ngang. |
| **Không áp dụng** | Không tách microservice. Không thêm `PlannerNode`/`ReActNode`/`AnalystNode`. Không làm Multi-Agent trước khi interface ổn định. |

## 5. Tool registry / plugin contract

| | |
|---|---|
| **Dify** | API resolve provider + credentials + parameters **trước** khi run; agent nhận tool đã chuẩn bị sẵn, không tự đi khám phá toàn hệ thống. Có hidden/runtime parameters tách khỏi model-visible schema. |
| **AppBI** | `ToolSpec` đã có `definition / result_kind / returns / deterministic / cacheable / self_sufficient / data_exposure / resource_refs`, `execute()` gate `allowed` + capability tại call-time. Tool được cấp per-node bởi author. |
| **Gap** | (a) `returns` là **prose, không phải schema** — 16/122 key không phải identifier hợp lệ (`'actual / target'`, `'columns / rows'`). (b) Không có khái niệm hidden/runtime parameter tách khỏi model-visible schema. (c) Không có credential binding cho tool ngoài. |
| **Cần không?** | **(a) Bắt buộc** — là tiền đề của Tool Node. **(b) Có** khi làm MCP/HTTP tool. **(c)** cùng (b). |
| **Áp dụng** | `output_schema` formal (mục 6). Tách `model_visible` / `runtime_injected` khi làm external tool. |
| **GIỮ, không học ngược** | `data_exposure`, `resource_refs`, capability gate call-time. Dify **không có** tương đương. Đây là lợi thế domain của AppBI. |

## 6. Tool node (generic)

| | |
|---|---|
| **Dify** | Có tool node gọi tool trực tiếp, không qua LLM. |
| **AppBI** | **Không có.** Code tự ghi nhận: `self_sufficient` là "LATENT — real, checkable, and not yet spendable — until a node exists that can call any tool directly". Hôm nay chỉ `inspect_filters` được node gọi trực tiếp. |
| **Gap** | Câu tất định ("Top 5 danh mục") vẫn tốn `LLM → chọn tool → execute → LLM`. |
| **Cần không?** | **Có — ưu tiên cao nhất sau output_schema.** Đây là cách scale từ 36 lên hàng trăm tool mà prompt không phình. |
| **Áp dụng** | `ToolNode` với `tool`, `inputs` (map `{{var}}` → argument), `output_var`, `on_error`. Không gọi LLM. Đi qua **đúng** `registry.execute()` hiện tại nên capability/scope gate áp dụng nguyên vẹn, miễn phí. |
| **Chặn trước một sai lầm** | ToolNode **không được** bypass `allowed`. Node type là grant (giống `report_read` hôm nay), nhưng capability gate và resource scope vẫn phải chạy. |

## 7. Skill / Workflow-as-Tool

| | |
|---|---|
| **Dify** | Sub-workflow chạy và trả output cho parent; runtime enforce call depth. |
| **AppBI** | **Không có.** Flow không gọi được Flow. |
| **Gap** | Không tái sử dụng được năng lực phức hợp; mỗi flow phải dựng lại từ node. |
| **Cần không?** | **Có, nhưng sau ToolNode.** Skill = published Flow có typed input/output, và "typed" chỉ có nghĩa khi `output_schema` đã tồn tại. Làm trước là xây trên cát. |
| **Áp dụng** | Skill invoke qua **cùng** Tool Registry (agent không cần biết đây là native tool hay skill). Bắt buộc: `max_depth`, cycle detection, budget inheritance, **permission intersection** (skill không bao giờ nới quyền của parent), trace parent/child. |
| **Rủi ro phải nói ra** | Permission intersection là chỗ dễ sai nhất. Một skill publish bởi người có quyền rộng, gọi từ flow của người quyền hẹp — phải lấy **giao**, không phải quyền của skill. Đây là hard constraint, cần test trước khi có feature. |

## 8. Plugin architecture

| | |
|---|---|
| **Dify** | Plugin daemon riêng, model/tool/agent-strategy ra repo plugin, có local/debug/serverless runtime. |
| **AppBI** | Tool native + MCP (đã có ở nơi khác trong sản phẩm). |
| **Cần không?** | **Không ở vòng này.** Plugin daemon là hạ tầng cho marketplace nhiều bên thứ ba — AppBI chưa có bài toán đó. |
| **Áp dụng** | Chỉ lấy nguyên tắc: **một Capability Registry duy nhất**, không tạo hệ MCP song song. Sau normalize, agent chỉ thấy `name / description / input_schema / output_schema / scope / risk / cost`. |
| **Không áp dụng** | Không plugin daemon, không marketplace, không sandbox runtime riêng. |

## 9. Knowledge / Datasource

| | |
|---|---|
| **Dify** | Datasource plugin. |
| **AppBI** | Knowledge Hub + `knowledge_scope` + attachment per node; đã có two-gate AST pipeline. |
| **Gap** | Không có adapter interface cho nguồn tri thức ngoài. |
| **Cần không?** | **Chưa.** AppBI có domain primitive riêng (Dataset/Semantic Model/Metric/Glossary/Chart) mà Dify không có. |
| **Kết luận** | **GIỮ.** Chỉ chuẩn hoá thành "Knowledge Source Adapter" khi có nguồn thứ hai thật. |

## 10. Human-in-the-loop

| | |
|---|---|
| **Dify** | **`ask_human` là một TOOL, không phải node.** Khi model gọi nó, "the current run succeeds with a `deferred_tool_call` instead of normal `output`". Client nhận title/question/body/fields/buttons. Resume = **run mới** với ba thứ: `session_snapshot` trước đó, composition còn nguyên history + ask-human layer, và `deferred_tool_results.calls[tool_call_id]`. Cảnh báo trong chính doc: *"the `args` object is model-generated content. Validate and sanitize it before rendering it to end users."* |
| **AppBI** | **Không có.** |
| **Gap** | Không có cách dừng chờ người. |
| **Cần không?** | **Có** — nhưng đây là chỗ brief cần chỉnh: đừng làm HumanInput/HumanApproval **node** làm cơ chế chính. |
| **Áp dụng** | Học đúng cơ chế Dify: (1) run **kết thúc thành công** với một deferred call, không giữ HTTP request; (2) resume là run mới + snapshot. Và AppBI phải tách hai loại như brief nói: **Human Input** (thiếu dữ liệu) vs **Human Approval** (action có side effect). Approval là **runtime primitive gắn vào tool có `risk`**, không phải prompt "hãy hỏi người dùng trước khi…". |
| **Bắt buộc kèm** | Sanitize nội dung do model sinh trước khi render — AppBI render Vietnamese markdown trong builder và chat, đây là đường XSS thẳng. |
| **Phụ thuộc** | **Không làm trước checkpoint (mục 11).** |

## 11. Checkpoint / durable state

| | |
|---|---|
| **Dify** | Persist graph/runtime state để resume đúng chỗ; agent run có `session_snapshot`. |
| **AppBI** | `agent_flow_runs` + `_content` + `_steps` — **chỉ ghi kết quả đã xong**. `status` là `ok`/`error`, không phải lifecycle. Không có gì resume được. |
| **Gap** | **Đây là gap lớn nhất và là chặn cho mục 10.** |
| **Cần không?** | **Có**, ngay khi muốn HITL. |
| **Áp dụng** | `RunCheckpoint` mang `flow_version, node_position, variables, evidence, budgets, agent state, pending actions, permissions reference`. Lifecycle `RUNNING → PAUSED → WAITING_HUMAN → RESUMED → SUCCEEDED/FAILED`. |
| **Rủi ro phải nói ra** | `permissions snapshot` là con dao hai lưỡi: snapshot quyền rồi resume sau 3 ngày = dùng quyền đã bị thu hồi. **Phải lưu reference + re-check lúc resume**, không phải snapshot giá trị. Brief ghi "snapshot/reference" — AppBI chọn **reference**. |

## 12. Observability

| | |
|---|---|
| **Dify** | `ObservabilityLayer` khi bật OTEL; workflow logs. |
| **AppBI** | `TraceStep` per node: status, ms, tokens, tool_calls, input/output preview, error. Runs tab + Test chat render notices. Đã khá đầy đủ ở tầng người dùng. |
| **Gap** | Không có OTEL/distributed trace. |
| **Cần không?** | **Không ở vòng này.** AppBI chạy một process; trace hiện tại phục vụ đúng người đọc nó (author). |
| **Áp dụng** | Khi có runtime layer (mục 2) thì observability trở thành **một layer**, không phải code rải trong executor. Làm lúc đó, không sớm hơn. |

## 13. Evaluation

| | |
|---|---|
| **Dify** | (chưa đọc trong vòng này — không claim) |
| **AppBI** | Có pytest. **Không có eval dataset.** |
| **Gap** | Bug production thành pytest, không thành eval case. Chất lượng chọn tool không đo được. |
| **Cần không?** | **Có** — và đây là thứ trực tiếp vá chỗ "test quá non" đã được chỉ ra hai vòng trước. |
| **Áp dụng** | L4 theo brief, nhưng **bắt đầu 15–20 câu** và chấm bằng tiêu chí tất định trước (scope có bị vi phạm không / số có trace được không / có từ chối khi nên từ chối không). "Chất lượng trả lời" cần người hoặc model chấm → chi phí định kỳ, không phải một lần. |

## 14. Trigger

| | |
|---|---|
| **Dify** | Có trigger. |
| **AppBI** | Flow chạy từ bot/chat/preview. |
| **Cần không?** | **Không ở vòng này.** Brief cũng xếp "để sau". |

---

## 15. Bảng tổng hợp quyết định

| Concept | Làm ở V3? | Thứ tự | Ghi chú |
|---|---|---|---|
| Node factory | **Không** | — | Đã có `NodeSpec` registry |
| Graph/DAG | **Không** | — | Giữ tree, có chủ đích |
| `output_schema` | **Có** | 1 | Tiền đề của mọi thứ dưới |
| Generic ToolNode | **Có** | 2 | Spend `self_sufficient` |
| Runtime layer | **Có** | 3 | Trích từ `_run_node`, zero behavior change |
| AgentStrategy | **Có** | 4 | Strategy đầu = behaviour hiện tại |
| RunCheckpoint | **Có** | 5 | Chặn của HITL |
| HITL (deferred call) | **Có** | 6 | Tool + resume, không phải node |
| Skill / Subflow | **Có** | 7 | Sau `output_schema`; permission intersection là hard constraint |
| Eval harness | **Có** | song song | 15–20 câu, tiêu chí tất định trước |
| MCP/HTTP unified | **Có** | 8 | Một registry, không hệ song song |
| Agent inner layers | **Hoãn** | — | Chỉ khi có concern thứ hai thật |
| Command channel | **Hoãn** | — | Đi cùng checkpoint |
| OTEL observability | **Hoãn** | — | Thành một layer khi có layer |
| Plugin daemon | **Không** | — | Chưa có bài toán marketplace |
| Trigger registry | **Không** | — | Để sau |
| Marketplace | **Không** | — | — |

---

## 16. Những thứ AppBI GIỮ, Dify không có tương đương

Kiểm lại từng cái trong code, không phải khẳng định suông:

| Lợi thế | Ở đâu trong code | Dify có? |
|---|---|---|
| Authoring / assigning / runtime permission tách bạch, binding chỉ **narrow** | `binding.py`, `permissions.py` | Không |
| `data_exposure` (metadata/derived/raw_rows) | `registry.py` | Không |
| `resource_refs` typed | `registry.py`, 25 tool khai | Không |
| Capability gate tại tool call-time | `_capability_refusal()` | Không (Dify gate ở app layer) |
| Semantic BI primitive (Dataset/Model/Metric/Glossary/Chart) | toàn backend | Không |
| Computing tool chính xác (`rank_values`, `total_measure`, `share_of`) | `packs/derived.py` | Không — Dify dùng code execution |
| Evidence/figure verification | `_verify_figures`, `_verify_answer_citations` | Không |
| Bot vs Chat binding khác entitlement | `direct_chat.py`, `binding.py` | Không |

**Không đánh đổi bất kỳ dòng nào trong bảng này để lấy một abstraction của Dify.**
Nếu một thay đổi V3 buộc phải bỏ một trong số đó, thay đổi đó sai, không phải bảng này sai.

---

## 17. Licence

Dify dùng **Apache 2.0 đã sửa đổi**. Hai điều kiện bổ sung đọc trực tiếp từ `LICENSE`
tại commit trên:

1. *"you may not use the Dify source code to operate a multi-tenant environment"* —
   trừ khi được cho phép bằng văn bản. "Tenant" định nghĩa là một workspace.
2. *"you may not remove or modify the LOGO or copyright information in the Dify
   console or applications"* — áp dụng cho frontend, tức **toàn bộ `web/`**.

Mandate: **study behavior and architecture, reimplement cleanly.** Không vendor, không
copy folder, không rename class, **đặc biệt không đụng `web/`**. Tài liệu này chỉ chứa
mô tả kiến trúc và vài câu trích ngắn từ tài liệu công khai để dẫn nguồn.

---

## 18. Amend sau review — những gì tài liệu này nói chưa đủ

Gap analysis được giữ nguyên làm **biên bản nghiên cứu**; hai tài liệu kia đã sửa. Ba
chỗ tài liệu này nói đúng nhưng chưa đủ, ghi lại để không ai đọc nhầm:

**§2 (runtime layers).** Câu *"policy thật sự đang rải rác: `data.py` check scope 2 chỗ
+ capability 3 chỗ"* dễ đọc thành "gom hết lên layer là xong". Không phải.
Gom là để có **một nơi đọc policy và fail sớm**; gate ở registry/data layer là
**enforcement boundary cuối cùng và không được rời đi**. Một hard invariant xuất hiện
ở nhiều tầng là đúng; rời khỏi tầng thấp nhất là sai. Xem §3.8 của
[target architecture](agent-flow-v3-target-architecture.md).

**§7 (Skill).** Câu *"Skill invoke qua cùng Tool Registry"* đúng về **trải nghiệm của
Agent**, sai nếu hiểu thành `ToolSpec(fn=run_another_flow)`. Skill là một FlowRun có
child trace, budget inheritance, permission intersection và checkpoint — không phải một
lời gọi hàm. Đúng là: **unified catalogue, specialized execution**.

**§11 (checkpoint).** Tài liệu này nói checkpoint là gap về **state**. Đọc kỹ executor
thì nó là gap về **control flow**: `_run_body()` chạy body lồng bằng đệ quy async
generator, nên continuation hiện nay là Python call stack. Chi phí V3.5 cao hơn mô tả ở
đây; xem cảnh báo và đường đi rẻ hơn ở migration plan.

---

*Đọc Dify: `api/core/workflow/workflow_entry.py`, `api/core/workflow/node_factory.py`,
`dify-agent/` (cấu trúc + `docs/dify-agent/index.md` + `user-manual/ask-human-layer/index.md`),
`LICENSE` — tất cả tại `6afe07f9`. Đọc AppBI: `runtime/executor.py`, `runtime/nodes.py`,
`runtime/state.py`, `runtime/handlers/*`, `tools/registry.py`, `contract.py`,
`dispatch.py`, `models/agent_flow_run.py` tại `82a51b5`.*
