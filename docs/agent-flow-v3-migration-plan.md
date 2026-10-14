# Agent Flow V3 — Migration plan

Điều kiện của tài liệu này: **chứng minh không phá gì đang chạy.** Mỗi phase phải
deploy và test độc lập được.

**Baseline:** `demo @ 2e541b7` · P0 runtime `14c4c38`

> **Rev 2** — amend sau review. Ba thay đổi lớn: golden replay chuyển từ byte-for-byte
> sang **canonical semantic**, fixture phải **tracked trong repo**, và roadmap là
> **DAG** chứ không phải một hàng.

---

## 0. Đang có gì để không phá (đếm thật trên DB local)

| | số lượng |
|---|---:|
| `agent_brain_versions` (định nghĩa flow) | **25** |
| `agent_flow_bindings` | 2 |
| `agent_flow_chat_threads` | 10 |
| `agent_flow_runs` / `_content` | 291 |
| `agent_flow_run_steps` | 765 |
| Node type đang dùng được | 13 |
| Tool đang đăng ký | 36 |
| Suite CI đang chạy | 21 |

---

## 1. Bốn bất biến của toàn bộ migration

Kiểm ở **cuối mỗi phase**:

| # | Bất biến | Cách chứng minh |
|---|---|---|
| **I1** | P0 vẫn chạy | 5 suite P0 xanh |
| **I2** | Flow đã lưu không đổi hành vi | **Canonical replay** (§2) |
| **I3** | `ToolSpec` cũ vẫn tương thích | 36 tool construct được; field mới có default |
| **I4** | Bot/Chat không đổi behavior ngoài migration có chủ đích | `test_chat_chart_scope`, `test_agent_flow_golden`, + chạy thật 1 bot + 1 chat |
| **I5** | **Hard gate không rời tầng dưới** | Xoá `_capability_refusal()` hoặc resource check ở registry ⇒ test đỏ, kể cả khi layer tương ứng đang xanh |

---

## 2. Golden Replay — canonical, không byte-for-byte

### 2.1 Vì sao đổi

Rev 1 nói "so byte-for-byte, khác một dòng là chưa xong". Hai vấn đề:

**(a) CI sẽ giòn vô lý.** Một run chứa timestamp, duration, run id, DB id, token
estimate, provider metadata, thứ tự không mang nghĩa. So nguyên văn thì đỏ vì đồng hồ.

**(b) Nguy hiểm hơn: snapshot toàn bộ hành vi hiện tại = đóng băng luôn bug hiện tại.**
Một behaviour sai hôm nay sẽ trở thành điều kiện nghiệm thu của mọi phase sau.

### 2.2 So cái gì — và không so cái gì

Canonicalize **trước** khi compare.

| SO (có nghĩa) | KHÔNG so (volatile) |
|---|---|
| `execution_path` — thứ tự node | timestamps |
| node status (ok/skipped/reused/error) | duration / latency |
| tool name + **thứ tự** gọi | run id, DB id |
| tool arguments **đã normalize** | token estimate |
| output variables | provider metadata |
| notice **codes** (không phải text) | generated identifiers |
| answer **structure** (có answer/citations/figures) | thứ tự không mang nghĩa (sort trước) |
| **permission decisions** | cache hit/miss |
| **evidence references** | |

Sau normalize thì so chặt. Khác ⇒ phase chưa xong, và phải **giải thích được khác ở
đâu vì sao** trước khi sửa (§6).

### 2.3 Fixture phải nằm trong repo

**Lỗ trong Rev 1:** 25 brain version nằm ở **DB local của một máy**. CI ở máy khác
không có chúng — nên kế hoạch "verify trên 25 flow" không chạy được ở CI.

Tách làm hai:

| | Nguồn | Chạy ở đâu |
|---|---|---|
| **Canonical fixture** | JSON commit trong `backend/tests/fixtures/flows/` | **CI, mọi PR** |
| **Local smoke** | 25 brain trong DB dev | máy dev, trước khi push |

Canonical fixture phải phủ đủ hình dạng, không phải đủ số lượng:

```
agent · tool · branch(if) · switch · loop · coordinate
knowledge · report_read · bot surface · chat surface
error path · reuse path · budget exhausted
```

Provider là stub tất định — đúng seam `test_agent_flow_golden` đang dùng: không tốn
tiền, không phụ thuộc mạng.

### 2.4 Replay ≠ Eval

```
Golden Replay   refactor có đổi runtime behaviour không?   stub model, mọi PR
Agent Eval      Agent còn làm đúng việc không?             model thật, nightly
```

Hai thứ **không thay nhau**. Replay xanh không có nghĩa agent trả lời đúng; eval xanh
không có nghĩa refactor không đổi hành vi.

---

## 3. Roadmap là DAG, không phải một hàng

```
                    V3.0 replay harness
                            │
                    V3.1 output_schema + risk
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
        V3.2 ToolNode  V3.8 MCP/HTTP   (Eval chạy song song)
              │
              ▼
        V3.7 Skill  ──────── cần V3.1 + V3.2, KHÔNG cần HITL

        V3.3 Runtime layers  ← nhánh độc lập
              │
              ▼
        V3.4 AgentRuntime/Strategy

        V3.5 Checkpoint      ← nhánh độc lập
              │
              ▼
        V3.6 HITL
```

**Rev 1 xếp Skill sau HITL. Sai** — Skill chỉ phụ thuộc `output_schema` + ToolNode.
Thứ tự thực thi quyết định bởi **dependency kỹ thuật + giá trị sản phẩm**, hai chuyện
khác nhau. Nếu Skill có giá trị cao hơn HITL thì làm Skill trước.

Ba nhánh (`ToolNode/Skill`, `Runtime/Agent`, `Checkpoint/HITL`) độc lập nhau — làm song
song được nếu có người, miễn mỗi nhánh tự verify I1–I5.

---

## 4. Phase

### V3.0 — Replay harness + canonical fixtures

| | |
|---|---|
| Đổi gì | Script + fixture JSON tracked. **Không đụng runtime** |
| Rủi ro | Không |
| Nghiệm thu | `--verify` xanh trên fixture ngay sau snapshot; chạy được trên CI runner sạch |
| Rollback | Xoá script |

### V3.1 — `output_schema` + `risk` (contract only)

| | |
|---|---|
| Đổi gì | `output_schema` (default `None`), `risk` (default **`unknown`**), migrate 36 tool sang `risk="read_only"` |
| **Không** đổi | `returns` giữ nguyên. Chưa handler nào đọc `output_schema` |
| Vì sao migrate an toàn | Kiểm rồi: không tool nào ghi DB; 5 tool external đều là đọc web |
| Nghiệm thu | I1–I5 + `output_schema` khớp `result.data` thật + tool mới không khai `risk` ⇒ CI đỏ |
| Rollback | Xoá field |

### V3.2 — Generic `ToolNode`

| | |
|---|---|
| Đổi gì | Node type thứ 14, inputs **typed** (`{source, ref/value}`) |
| Rủi ro | Thấp về regression, **trung bình về security** |
| Nghiệm thu | I1–I5 + **bộ test bypass**: tool ngoài scope → refuse; `read_rows=False` + `raw_rows` → refuse; vượt ceiling → trim/refuse; `risk=unknown` → refuse |
| Rollback | Gỡ khỏi `NodeSpec` registry |

### V3.3 — Runtime Layer Stack (trích, không thêm)

| | |
|---|---|
| Đổi gì | `_run_node()` → `RuntimeLayer.invoke(node, ctx, call_next)`. Layer đầu **đóng gói đúng code đang chạy** |
| **Không** đổi | Không thêm concern. **Không xoá check nào ở `data.py`/`agent.py`/registry** — I5 |
| Rủi ro | **Cao nhất** — đụng đường chạy mọi node |
| Nghiệm thu | I1–I5; I2 canonical replay là điều kiện duy nhất. Lệch ⇒ **revert**, không "sửa cho khớp" |
| Rollback | Revert commit, không có migration DB |

Sau khi ổn định mới di chuyển từng check vào layer — **mỗi PR một check, gate dưới giữ
nguyên**, mỗi lần verify lại replay.

### V3.4 — `AgentRuntime` + `AgentStrategy`

**Trạng thái: xong** (phase 2 của `docs/features/agent-flow-v3-capabilities`). Replay không đổi.

| | |
|---|---|
| Đổi gì | Tách vòng reasoning. Runtime sở hữu provider/tool/budget/retry/trace; Strategy chỉ quyết định |
| Strategy đầu | `tool_calling` = code hiện tại **chuyển chỗ, không sửa logic** |
| Nghiệm thu | I2 canonical replay là điều kiện **duy nhất**. Zero behavior change |
| Rollback | Revert |

Strategy thứ hai là phase riêng.

### V3.5 — `FlowRun` / `Attempt` / `RunCheckpoint`

| | |
|---|---|
| **Cảnh báo chi phí** | `_run_body()` chạy body lồng bằng **đệ quy async generator** — continuation hiện là Python call stack, không serialize được. Đây là bài toán **control flow**, không phải schema DB |
| Đường rẻ cần thẩm định trước | Resume = chạy lại từ đầu, node đã xong tái dùng output đã ghi (dùng `run_policy`/`_reuse()` đã có test), tới khi gặp node đang chờ |
| Đổi gì | Migration: `Attempt` + `RunCheckpoint`; `FlowRun.status` thêm giá trị, **không đổi nghĩa giá trị cũ** |
| Nghiệm thu | I1–I5 + Runs tab render đúng 291 run cũ + `downgrade()` chạy được + checkpoint round-trip qua loop lồng if |
| Rollback | `alembic downgrade` — test **trước** khi merge |

**Phase này bắt đầu bằng một spike đo chi phí, không bằng migration.**

### V3.6 — Human Input / Approval

| | |
|---|---|
| Phụ thuộc | V3.5 |
| Đổi gì | Tool `ask_human`; runtime chặn tool `risk` ∈ {side_effect, destructive}; endpoint resume tạo Attempt mới |
| Nghiệm thu | I1–I5 + **sanitize test** (nội dung model sinh render trong markdown) + **permission re-check lúc resume** (quyền thu hồi giữa chừng ⇒ fail có lý do) + UI hiện **một** FlowRun không phải nhiều run |

### V3.7 — `Skill` / Subflow

**Trạng thái: xong** (phase 5). `invoke_skill`, không phải `ToolSpec.fn`; quyền = caller ∩ contract.

| | |
|---|---|
| Phụ thuộc | V3.1 + V3.2 (**không** cần HITL) |
| Rủi ro | **Cao nhất về security** |
| Nghiệm thu **trước** feature | `max_depth`, cycle detection (chặn lúc đăng ký), budget inheritance, **permission intersection**, trace parent/child — mỗi cái một test |
| Kiến trúc | `SkillCapability` + `SkillInvoker`, **không** nhét vào `ToolSpec.fn` |

### V3.8 — MCP / HTTP vào cùng catalogue

| | |
|---|---|
| Phụ thuộc | V3.1 |
| Nguyên tắc | Một **catalogue**, executor riêng. Không hệ song song |
| Nghiệm thu | Tool ngoài đi qua **đúng** hard gate như tool native |

### Song song — Eval harness

Từ V3.1, không chặn phase nào. 15–20 câu, chấm bằng tiêu chí **tất định trước**: scope
có bị vi phạm không · số có trace được không · có từ chối khi nên từ chối không.

**Từ V3: bug production thành eval case, không chỉ thành pytest.**

---

## 5. Tương thích ngược — cam kết cụ thể

| Thứ | Cam kết |
|---|---|
| 25 brain version | Cùng canonical execution: path, tool order, output vars, notice codes, permission decisions |
| 2 binding | Không đổi schema, không đổi nghĩa |
| 291 run cũ | Runs tab render nguyên vẹn sau V3.5 |
| 10 chat thread | Không đổi |
| 36 `ToolSpec` | Construct được không sửa; field mới có default |
| 13 node type | Không type nào đổi hành vi |
| 21 CI suite | Xanh ở mọi phase |
| **Hard gate ở registry** | **Còn nguyên sau mọi phase** |

**Phase nào buộc phải phá một dòng ⇒ phase đó thiết kế sai.**

---

## 6. Dừng lại và báo cáo khi

- Canonical replay lệch mà **không giải thích được** lệch ở đâu và vì sao
- Một phase cần đổi `Flow` contract kiểu flow cũ không validate
- Một phase cần bỏ một dòng trong §16 của [gap analysis](agent-flow-v3-dify-gap-analysis.md)
- Một phase đề nghị **xoá hard gate ở tầng dưới** vì "layer đã lo rồi"
- Permission intersection của Skill chưa có test mà feature đã chạy được
- Spike checkpoint cho thấy resume cần viết lại executor thành state machine

---

## 7. Chưa làm trong vòng này

Graph/DAG · clone `web/` · Plugin Daemon · Marketplace · Trigger registry ·
Agent inner layers · OTEL · tách microservice · Planner/Multi-Agent.

---

*Số liệu §0 đếm trực tiếp qua `information_schema`. Không dùng làm source-of-truth cho
test — test derive từ registry và từ canonical fixture tracked trong repo.*
