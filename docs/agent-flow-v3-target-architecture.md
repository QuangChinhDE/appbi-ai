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
| 1 Governance | xong | `risk≠read_only` bị chặn; nhu cầu web suy ra từ `reaches_outside`; tool không tồn tại chặn publish; coordinator lồng bị cấm ở publish; preflight đi theo `child_node_lists` | `test_governance_promises_are_kept.py` |
| 2 Strategy/Runtime | xong | `AgentRuntime` + `ToolCallingStrategy`; runtime không soạn hội thoại | `test_strategy_is_pure.py`, `test_instruction_lifecycle.py::test_the_runtime_composes_no_conversation` |
| 3 Compute | xong | biến = `{ref, path}` (Agent) hoặc `{step, path}` (ToolNode); runtime tự đọc giá trị; chỉ trường kết quả tự bảo chứng (`evidence_paths`) mới được tin; `output_schema` có kiểu, kiểm trong CI | `test_compute_owns_the_number.py`, `test_compute_typed_contract.py`, `test_adversarial_review_v3_closure.py` |
| 4 Capability routing | xong (thiết kế lại) | eligible = luật admission; nạp đầy đủ = core (tra chart + đọc chart + `compute`) ∪ theo câu hỏi ∪ đã nạp, trong **ngân sách schema** (10.500 ký tự; số do tác giả đặt giữ đúng core cũ); tối đa 2 khả năng gần trùng mỗi câu hỏi (so theo định danh); phần còn lại một dòng mỗi thứ **trong mô tả của `find_capability`**; nạp theo ý định hoặc theo tên; ≤3 lần/bước; gọi thứ chưa hiện → từ chối + nạp cho lượt sau | `test_capability_discovery.py`, `test_capability_routing_eval.py` (52 intent VI/EN, tới 600 khả năng nhiễu) |
| 5 Skill | xong | một primitive `invoke_skill`; child run; quyền = caller ∩ Skill; ghim version; vòng đời theo version (active/deprecated/disabled) kiểm ở MỌI lần gọi; chia sẻ kiểm lại theo chủ flow gọi; đầu ra có kiểu (`text` / `number` kèm provenance); không lồng điều phối qua Skill | `test_skills_run_as_governed_children.py`, `test_skill_lifecycle_and_revocation.py` |
| 6 Budget | xong | trước mỗi node, runtime giữ lại mức tối thiểu các node sau cần (`runtime/reserve.py`); lượt cuối một bước được phép không có tool → bước luôn kết thúc bằng câu trả lời; lane đã chọn đều được chạy; sổ ngân sách từng bước | `test_budget_always_reaches_an_answer.py` |
| 7 Trace/UX | xong | mỗi bước: cấp/đủ điều kiện/bị loại + lý do, hiện ban đầu, schema/vòng, mọi lần discovery, tự nạp, lượt chỉ trả lời, evidence tạo ra, ngân sách; coordinator ghi vì sao chọn; UI Runs/What the AI sees/vòng đời Skill | tsc, `npm run qa`, E2E |
| 3.3 Runtime Layer Stack | **chưa** | không mục tiêu nào cần nó | — |
| 3.5 / 3.6 Checkpoint, HITL | **chưa** | `needs_approval` là cửa chờ cho 3.6 | — |
| 3.8 MCP/HTTP | **chưa** | `ExtraCapability` là chỗ cắm vào catalogue | — |

### Eval — routing so với hiện đủ, chấm theo câu trả lời

Bản triển khai: `7ef703c4` · 1×3 rep · 14 case

| Chỉ số | full (hiện đủ 40) | routed (mặc định) | stress (hiện 4) |
|---|---|---|---|
| Đúng (chấm theo ground truth ToolNode) | **40/42** | **39/42** | **34/42** |
| Dùng đúng khả năng mong đợi | 40/42 | 39/42 | 38/42 |
| Ca có gọi discovery | 0/42 | 3/42 | 38/42 |
| …và chạy thứ vừa tìm | 0 | 0 | 33 |
| Tự nạp sau khi gọi thứ chưa hiện | 0 | 0 | 0 |
| Chạy ngoài quyền | 0 | 0 | 0 |
| Schema/vòng (ký tự, TB) | ~24.200¹ | 10,871 | 7,729 |
| Token/ca (TB) | 18,817 | 13,407 | 14,885 |
| Prompt token/ca (TB) | 18,571 | 13,148 | 14,640 |
| Lượt model/ca (TB) | 3.57 | 3.88 | 4.48 |
| Giây/ca (TB) | 8.4 | 8.1 | 8.0 |
| Run `failed` | 0 | 0 | 0 |
| Hàng chạy nhầm nhánh | 0 | 0 | 0 |

¹ nhánh full không routing nên trace không ghi kích thước theo vòng; số là đo tất định toàn bộ 40 schema (`test_capability_routing_eval.py`).

Ca sai theo nhánh:

- full (hiện đủ 40): `share_category`×2
- routed (mặc định): `mom`×2, `share_category`×1
- stress (hiện 4): `mom`×3, `on_time`×3, `share_category`×1, `state_revenue_share`×1

Luồng sản phẩm (Đọc báo cáo → Chuyên viên phân tích → bước Skill kiểm chứng → Trả lời, báo cáo 67, ngân sách mặc định): 7/9 đúng theo bộ chấm; 1 ca bộ chấm sai (nhãn dịch "Sức khỏe & Sắc đẹp"), 1 ca sai thật (tự tính phần trăm). Các lượt trước ở `83bf3fd2`: 9/9.


### Khác với kế hoạch ban đầu, và vì sao

- **Provenance của compute bằng tham chiếu và theo trường, không bằng khớp giá trị.**
  Một kết quả tự khai trường nào nó bảo chứng (`evidence_paths`); literal hay văn
  xuôi của Skill là số nó *nhắc tới*, không phải số nó *bảo chứng*.
- **Routing theo ngân sách ký tự, không theo số lượng cố định.** Mặc định 40 của vòng
  trước né câu hỏi chất lượng bằng cách không bao giờ rút gọn. Đo trên intent có nhãn:
  xếp hạng theo "câu hỏi + prompt" nạp đúng 27/48; theo câu hỏi (prompt chỉ nghiêng
  ≤30%, BM25, stem nhẹ) 47/48.
- **Core có trình đọc chart (`get_chart_summary`).** Đo live: câu hỏi giá trị KPI ở
  nhánh routed/stress tìm đúng chart nhưng không có tool đọc được nạp, thử `compute` rồi
  trả lời "không có dữ liệu" ở mọi lượt. Ngân sách tăng đúng bằng kích thước tool đó
  (10.000 → 10.500) nên phần dành cho khả năng xếp theo câu hỏi không đổi.
- **Không quá 2 khả năng gần trùng (Jaccard ≥ 0,4 trên mô tả) mỗi câu hỏi.** Hai tool
  thật giống nhau nhất chỉ trùng 0,16; biến thể cùng chủ đề từ 0,46. Tìm ra bằng eval
  khả năng nhiễu: một câu hỏi tra cứu nạp sáu bản sao.
- **Danh mục nằm trong mô tả của `find_capability`, không trong system prompt** — nơi
  model nhìn khi chọn công cụ. Model live không dùng discovery lần nào ở vòng trước.
- **Ngân sách giữ lại theo cấu trúc flow, không bằng prompt** — và `check()` giữa các
  node chỉ dừng khi cả hai trần đã hết.
- **Skill không chạy bằng quyền của owner**; chia sẻ kiểm lại ở mỗi lần gọi theo chủ
  của flow GỌI; version bị vô hiệu hoá không bao giờ được thay bằng version khác.
- **Child run nối bằng `parent_run_key`**; không mang session/link của người đọc.
- **Lỗi phát hiện dọc đường**: registry nạp pack không an toàn đa luồng; Tool step ghi
  evidence dưới khoá bước trước; loop gom kết quả cũ cho lượt lỗi; binding theo biến
  không được quét lúc publish; ngưỡng routing bị một tool core đặt; model truyền id
  dạng chuỗi.

### Review đối kháng — ba vòng, tìm thấy và đã sửa

| Vòng | Mức | Lỗi | Sửa ở gốc |
|---|---|---|---|
| 1 | P0 | `compute` bị cache xuyên lượt | không cacheable |
| 1 | P0 | `compute` xác thực số bịa (không biến, `x*0+N`, rửa, `chart_id`) | ≥1 tham chiếu tin cậy + phụ thuộc thật; taint lan; định danh bị từ chối |
| 1 | P0 | Skill vượt phạm vi tri thức của caller | grant tường minh bị cắt về quyền báo cáo; không tính được thì đóng |
| 1 | P0 | child run lưu nội dung dù link tắt, sharee đọc được | theo `store_content` của caller; xem child cần quyền flow cha |
| 2 | P0 | văn xuôi của Skill text được `compute` xác thực | `evidence_paths` |
| 2 | P0 | `literals[0]` của compute đã xác thực bị rửa qua compute kế tiếp | `evidence_paths` |
| 2 | P1 | hết trần tool giết bước trả lời chỉ cần model | `check()` chỉ dừng khi cả hai trần hết |
| 2 | P1 | web fetch và batch song song vượt trần/ăn phần giữ lại | dừng ở phần giữ lại; room đọc lại mỗi lời gọi; runtime không bao giờ vượt trần |
| 2 | P1 | từ chối vì ngân sách kích hoạt `on_error=stop` | không bao giờ |
| 2 | P2 | tự nạp không giới hạn; lượt chỉ-trả-lời vẫn chạy tool; bracket path; Skill disabled vẫn được giữ chỗ; rollback bị chặn vì pin deprecated; Anthropic từ chối lượt cuối có lịch sử tool | đã sửa, mỗi cái một test |
| 3 | P0 | số model gõ vào lời gọi (query `"13590000"`, `target` của caller) được tool trả lại và được xác thực | mục evidence nhớ số của chính lời gọi (`caller_numbers`); tool suy ra từ target của caller khai `evidence_paths` |
| 3 | P1 | từ vựng tự do biến measure khác thành alias (mô tả nhắc "doanh thu"; định danh chính xác bị mở rộng; binding mất bảng) | định danh khớp chính xác; chỉ tên/nhãn, đủ mọi từ, khớp sát nhất; binding giữ tên có bảng |
| 3 | P1 | tiêu đề biểu đồ cho dimension trái với nhãn semantic; "bảng" gập dấu thành "bang"; ReportRead chọn theo tiêu đề | tiêu đề chỉ dùng khi dimension không có nhãn và cụm từ không khớp trường nào; giữ dấu; ReportRead không bao giờ chọn theo tiêu đề |
| 3 | P1 | cổng dimension bị vô hiệu bởi "theo" | một định nghĩa dùng chung (`chart_dimension_words`); bỏ từ đa số tiêu đề đều có |
| 3 | P1 | hết trần tool trong bước dữ liệu vẫn giết run | `BudgetExhausted.resource`: hết tool chỉ dừng bước cần tool khi model còn gọi được |

### Giới hạn còn lại

- **CÒN MỞ — gán con số cho thành viên của một chiều run chưa đọc** ("Bang SP chiếm 100%",
  số của danh mục trình bày như của bang). Eval cuối: 1/42 ở nhánh stress; D2 live 6/6 trả
  lời trung thực. Hai thiết kế tại câu trả lời đã được xây và rút lại sau review đối kháng
  (`7181790a`, `8cbe3790`) vì vừa bỏ sót vừa viết lại câu trả lời đúng. Sửa đúng cần
  provenance từng con số theo MEASURE × chiều × thành viên tại ranh giới tool, và cách nhận
  diện chiều trong câu hỏi mạnh hơn một từ trùng.
- Model đôi khi tự chia phần trăm thay vì gọi `compute` (luồng sản phẩm: 19,78% thay vì
  5,23% — sai tháng so sánh); bộ kiểm số liệu gắn cờ số không có nguồn nhưng một lượt sửa
  có thể giữ lại phép tính.

- Chất lượng câu trả lời phụ thuộc model: eval live có dao động giữa các lượt; con số ở
  trên là từng lượt, không phải trung bình dài hạn.
- `find_capability` xếp hạng theo từ vựng (không embedding): một nhu cầu diễn đạt bằng
  từ hoàn toàn khác mô tả có thể không tìm thấy — danh mục tên trong định nghĩa là
  đường thứ hai.
- Skill không có khai báo chart riêng: child dùng đúng chart của caller.
- Một formula cộng literal lớn vào số thật (`x + 13590001`) vẫn được xác thực: literal
  là toán học theo quyết định sản phẩm; nó nằm rõ trong lineage.
- Model đôi khi gắn nhãn sai measure cho một con số đúng (tỷ trọng SỐ ĐƠN của một bang được
  gọi là tỷ trọng doanh thu). Cổng hiện chặn thay thế DIMENSION, chưa chặn thay thế MEASURE:
  một cổng measure dựa trên từ vựng hiện có sẽ từ chối nhầm câu hợp lệ ("doanh thu trung
  bình mỗi đơn" là AOV). Bộ kiểm qualifier sau câu trả lời chưa bắt dạng này.
- Skill do Agent gọi mà không đủ cho một vòng tool bị từ chối trước khi chạy
  (`reserve.working_minimum`). Skill đủ một vòng nhưng cần nhiều vòng (so sánh hai kỳ cần
  3–4) vẫn có thể trả lời thiếu trên link 6 lượt nếu bước gọi đã tiêu phần lớn ngân sách:
  số lượt của link là quyết định của tác giả, runtime chỉ bảo đảm run kết thúc và nói thật.
- Hỏi theo một GIÁ TRỊ viết kiểu nhãn ("Health & beauty" trong khi dữ liệu là
  `health_beauty`): `share_of`/`rank_values` khớp được, nhưng công cụ discovery tìm theo
  tên tài sản chứ không theo giá trị, nên đôi khi model kết luận "không có" trước khi gọi
  chúng. Sai ở cả nhánh full lẫn routed — không do routing.
- Bộ chấm eval dựa trên cụm từ: một câu từ chối đúng nhưng diễn đạt khác ("không tách
  được") bị chấm sai. Mọi ca sai trong bảng trên đã được đọc lại bằng mắt; số liệu giữ
  nguyên như bộ chấm cho ra, không sửa bộ chấm giữa chừng.
- Loop không chia ngân sách đều giữa các vòng: vòng đầu có thể dùng hết phần của vòng
  sau (bước trả lời vẫn được giữ; run ghi `steps_skipped_for_budget`).

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

Mỗi dòng là một test — **và điều đó được kiểm**: `tests/test_documented_invariants_are_enforced.py`
đọc bảng này, yêu cầu mọi test được nêu tồn tại và nằm trong CI, và một bất biến không
có test chỉ được phép ở đây nếu ghi rõ **chưa áp dụng** kèm lý do. Tài liệu nói một
bất biến mà không test nào giữ là một lỗi của tài liệu, và CI nói ra điều đó.

| # | Bất biến | Khoá bằng |
|---|---|---|
| 1 | Tool chạm resource ngoài grant → `chart_out_of_scope` / `not_granted` | `tests/test_agent_flow_replay.py::test_the_chart_scope_taxonomy_defect_is_fixed_and_stays_fixed`, `tests/test_i5_hard_gate_stays_lowest.py::test_resource_scope_is_enforced_inside_the_tool_not_only_above_it` |
| 2 | `read_rows=False` → tool `raw_rows` bị chặn, tool `derived` vẫn chạy | `tests/test_i5_hard_gate_stays_lowest.py::test_a_row_exposing_body_never_runs_when_rows_are_withheld`, `tests/test_i5_hard_gate_stays_lowest.py::test_a_computing_body_still_runs_when_rows_are_withheld` |
| 3 | `web_search=False` → mọi tool `reaches_outside` bị chặn tại call-time | `tests/test_i5_hard_gate_stays_lowest.py::test_an_external_body_never_runs_when_web_is_withheld` |
| 4 | Không result nào vượt `max_result_tokens` mà vào prompt | `tests/test_tool_result_ceiling.py::test_a_result_over_the_ceiling_does_not_reach_the_caller_intact` |
| 5 | Skill không bao giờ nới quyền của caller (chart, rows, web, tri thức; không dùng quyền của owner Skill) | `tests/test_skills_run_as_governed_children.py::test_the_child_cannot_exceed_the_callers_web_rows_or_charts`, `tests/test_skills_run_as_governed_children.py::test_an_empty_caller_scope_still_bounds_the_skills_explicit_grants` |
| 6 | Resume re-check quyền hiện tại, không dùng quyền đã snapshot | **chưa áp dụng** — checkpoint/resume chưa xây (§3.5); không có đường resume nào để kiểm |
| 7 | Tool `risk` ∉ {read_only} không chạy khi chưa duyệt; `unknown` không chạy | `tests/test_governance_promises_are_kept.py::test_a_tool_not_classified_read_only_is_refused_before_it_runs` |
| 8 | Mọi con số trong câu trả lời trace được về evidence; số AI tự gõ không bao giờ được xác thực | `tests/test_chart_discovery_and_figure_correction.py::test_a_figure_absent_from_the_evidence_is_named_not_hedged`, `tests/test_compute_owns_the_number.py::test_a_bare_number_as_a_variable_is_computed_but_marked_unreferenced` |
| 9 | Fallback listing không bao giờ được caller tất định coi là match | `tests/test_report_read_scope.py::test_the_real_tool_reports_none_when_the_question_matches_nothing` |
| 10 | Flow đã lưu trước V3 chạy ra cùng kết quả sau V3 (mọi khác biệt là có chủ đích và ghi lại) | `tests/test_agent_flow_replay.py::test_replay_matches_the_committed_snapshot` |
| 11 | **[A1]** Mọi hard gate vẫn enforce tại registry/data layer | `tests/test_i5_hard_gate_stays_lowest.py::test_the_capability_gate_is_wired_into_execute`, `tests/test_i5_hard_gate_stays_lowest.py::test_the_gate_runs_before_the_cache` |
| 12 | Routing chỉ quyết định cái gì HIỆN; không khả năng nào ngoài grant được nạp, liệt kê hay phân biệt được qua discovery | `tests/test_capability_routing_eval.py::test_no_intent_can_route_or_discover_outside_the_grant`, `tests/test_capability_discovery.py::test_an_ungranted_name_gets_the_same_answer_as_one_that_does_not_exist` |
| 13 | Khả năng chưa hiện không chạy từ trí nhớ; khả năng ngoài grant vẫn bị registry từ chối | `tests/test_capability_discovery.py::test_an_unshown_capability_is_not_run_from_memory_but_is_loaded_for_next_round`, `tests/test_capability_discovery.py::test_an_ungranted_capability_is_still_refused_by_the_registry` |
| 14 | Chất lượng routing được đo, không được giả định: khả năng câu hỏi cần được nạp ngay lượt đầu; context không tăng theo catalogue | `tests/test_capability_routing_eval.py::test_the_capability_a_question_needs_is_loaded_on_round_one`, `tests/test_capability_routing_eval.py::test_routing_holds_and_context_stays_flat_as_the_catalogue_grows` |
| 15 | Run đủ ngân sách luôn tới được bước trả lời; child, lane, discovery, lượt sửa không ăn phần được giữ | `tests/test_budget_always_reaches_an_answer.py::test_a_gathering_step_cannot_spend_the_answering_steps_call`, `tests/test_budget_always_reaches_an_answer.py::test_a_mandatory_verifier_skill_and_the_answer_run_on_the_minimum_budget`, `tests/test_budget_always_reaches_an_answer.py::test_greedy_specialists_cannot_spend_the_answering_steps_call` |
| 16 | Instruction tới đúng vòng suy luận nó cần tác động | `tests/test_instruction_lifecycle.py::test_the_round_that_reads_tool_results_reads_the_language_reminder_right_after_them`, `tests/test_instruction_lifecycle.py::test_the_budget_final_round_is_told_it_is_final_and_offered_no_tools` |
| 17 | Version Skill bị vô hiệu hoá không chạy dù đã ghim, không bị nâng âm thầm; rút chia sẻ có hiệu lực ở lần gọi kế tiếp | `tests/test_skill_lifecycle_and_revocation.py::test_a_disabled_version_is_not_offered_and_is_refused_even_when_pinned`, `tests/test_skill_lifecycle_and_revocation.py::test_an_unshare_after_publish_stops_the_next_run` |
| 18 | Không lồng điều phối trong điều phối — kể cả qua Skill, bắc cầu | `tests/test_governance_promises_are_kept.py::test_a_coordinator_inside_a_coordinator_lane_is_refused_at_publish_not_at_load`, `tests/test_skill_lifecycle_and_revocation.py::test_a_coordinator_is_found_through_a_chain_of_skills` |
| 19 | Đầu ra có kiểu được giữ ở ranh giới: sai kiểu thì dừng; taint đi qua Skill | `tests/test_compute_typed_contract.py::test_a_result_that_does_not_fit_its_schema_stops_the_step`, `tests/test_compute_typed_contract.py::test_a_figure_the_skill_built_on_a_typed_number_stays_uncertified` |
| 20 | Một Skill do Agent gọi chỉ được khởi chạy khi phần ngân sách của nó đủ cho ít nhất một vòng gọi công cụ; không đủ thì bị từ chối trước khi tốn gì, có lý do và cách khắc phục | `tests/test_budget_always_reaches_an_answer.py::test_a_skill_handed_less_than_one_tool_round_is_refused_before_it_runs`, `tests/test_budget_always_reaches_an_answer.py::test_the_refusal_says_why_and_that_retrying_cannot_help`, `tests/test_budget_always_reaches_an_answer.py::test_a_skill_that_wraps_a_tool_using_skill_needs_its_tool_round` |
| 21 | Luật gần trùng so theo định danh của khả năng (không theo ghi chú grant hay phần bọc của Skill); số hiển thị do tác giả đặt giữ đúng core cũ | `tests/test_capability_routing_eval.py::test_distinct_skills_and_a_note_on_every_grant_are_never_copies`, `tests/test_capability_routing_eval.py::test_a_question_naming_three_different_skills_loads_all_three`, `tests/test_capability_discovery.py::test_an_author_count_is_what_it_was_before_the_reader_joined_the_core` |

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
