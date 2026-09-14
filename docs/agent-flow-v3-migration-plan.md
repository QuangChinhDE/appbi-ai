# Agent Flow V3 — Migration plan

Điều kiện của tài liệu này: **chứng minh không phá gì đang chạy.** Mỗi phase phải
deploy và test độc lập được.

**Baseline:** `demo @ 82a51b5` · P0 runtime `14c4c38`

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

25 bản flow đã lưu là thứ **không được đổi hành vi**. Đó là con số dùng để kiểm ở mỗi
phase, không phải con số để trích dẫn.

---

## 1. Bốn bất biến của toàn bộ migration

Kiểm ở **cuối mỗi phase**, không phải cuối dự án:

| # | Bất biến | Cách chứng minh |
|---|---|---|
| **I1** | P0 vẫn chạy | 5 suite P0 xanh: `test_tool_authorization_metadata`, `test_tool_capability_gates`, `test_tool_argument_contract`, `test_tool_result_ceiling`, `test_report_read_scope` |
| **I2** | Flow đã lưu không đổi hành vi | **Golden replay** (§2) trên 25 brain version |
| **I3** | `ToolSpec` cũ vẫn tương thích | 36 tool construct được; field mới đều có default |
| **I4** | Bot/Chat không đổi behavior ngoài migration có chủ đích | `test_chat_chart_scope`, `test_agent_flow_golden`, + chạy thật 1 bot + 1 chat |

---

## 2. Golden replay — hạ tầng phải làm TRƯỚC phase 1

Không có cái này thì "không phá gì" chỉ là lời nói.

```
scripts/agent_flow_replay.py --snapshot   # trước khi đổi
scripts/agent_flow_replay.py --verify     # sau khi đổi
```

Với mỗi trong 25 brain version, chạy flow bằng **provider giả tất định** (đúng seam
`test_agent_flow_golden` đang dùng — không tốn tiền, không phụ thuộc mạng) và ghi:

```
execution_path        thứ tự node đã chạy
node statuses         ok / skipped / reused / error
tool_log              tool nào được gọi, theo thứ tự
output variables      giá trị từng biến
notices               mã notice
answer shape          có answer / citations / figures không
```

`--verify` so byte-for-byte với snapshot. **Khác một dòng là phase đó chưa xong.**

Đây là thứ duy nhất biến "zero behavior change" từ mong muốn thành điều kiện nghiệm thu.

---

## 3. Phase

### V3.0 — Golden replay harness

| | |
|---|---|
| Đổi gì | Chỉ thêm script + snapshot, **không đụng runtime** |
| Rủi ro | Không |
| Nghiệm thu | `--verify` xanh trên 25 brain ngay sau khi snapshot |
| Deploy độc lập | Có — không có gì để deploy |

### V3.1 — `output_schema` (contract only)

| | |
|---|---|
| Đổi gì | `ToolSpec.output_schema` (default `None`), `risk` (default `"none"`), khai cho tool có node tiêu thụ tất định |
| **Không** đổi | `returns` giữ nguyên. Không handler nào đọc `output_schema` ở phase này |
| Rủi ro | Rất thấp — field mới có default, không ai đọc |
| Nghiệm thu | I1–I4 + test: mọi tool có `output_schema` thì schema hợp lệ và khớp kết quả thật |
| Deploy độc lập | Có |
| Rollback | Xoá field |

### V3.2 — Generic `ToolNode`

| | |
|---|---|
| Đổi gì | Node type thứ 14. `NodeSpec` mới + handler + inspector + i18n |
| **Không** đổi | Không node nào hiện có thay đổi. Flow cũ không có ToolNode |
| Rủi ro | Thấp về regression (thêm mới), **trung bình về security** — phải chứng minh không bypass gate |
| Nghiệm thu | I1–I4 + **bộ test bypass**: ToolNode gọi tool ngoài scope → refuse; `read_rows=False` + tool `raw_rows` → refuse; vượt `max_result_tokens` → trim/refuse |
| Deploy độc lập | Có |
| Rollback | Gỡ khỏi `NodeSpec` registry → biến mất khỏi palette; flow đã dùng sẽ fail loud (`chưa hỗ trợ loại bước`) — chấp nhận được vì chưa ai publish |

### V3.3 — Runtime Layer Stack (trích, không thêm)

| | |
|---|---|
| Đổi gì | Trích wrapper trong `_run_node()` thành `RuntimeLayer` với `before_node` / `after_node`. Layer đầu tiên **đóng gói đúng code đang chạy** |
| **Không** đổi | Không thêm concern mới. Không di chuyển check ở `data.py`/`agent.py` trong phase này |
| Rủi ro | **Cao nhất trong V3** — đụng đường chạy của mọi node |
| Nghiệm thu | I1–I4, và I2 là **bắt buộc byte-for-byte**. Nếu golden replay lệch một dòng thì revert, không "sửa cho khớp" |
| Deploy độc lập | Có |
| Rollback | Revert commit — không có migration DB |

Chỉ **sau khi** V3.3 ổn định mới di chuyển từng check rải rác vào layer, **mỗi PR một
check**, mỗi lần verify lại golden.

### V3.4 — `AgentRuntime` + `AgentStrategy`

| | |
|---|---|
| Đổi gì | Tách vòng reasoning khỏi `handlers/agent.py` |
| Strategy đầu | `tool_calling` = **code hiện tại chuyển chỗ, không sửa logic** |
| Rủi ro | Cao — agent là node dùng nhiều nhất |
| Nghiệm thu | I2 byte-for-byte là điều kiện **duy nhất** để phase này được coi là xong. Zero behavior change |
| Deploy độc lập | Có |
| Rollback | Revert |

Strategy thứ hai (`react`, …) là **phase riêng**, không đi cùng.

### V3.5 — `RunCheckpoint`

| | |
|---|---|
| Đổi gì | Migration: cột lifecycle trên `agent_flow_runs` + bảng checkpoint. `status` hiện là `ok/error` → thêm giá trị mới, **không đổi nghĩa giá trị cũ** |
| Rủi ro | Trung bình — có migration DB, 291 run cũ phải đọc được nguyên vẹn |
| Nghiệm thu | I1–I4 + Runs tab render đúng 291 run cũ + migration có `downgrade()` chạy được |
| Deploy độc lập | Có, nhưng **migration phải forward-compatible**: backend cũ đọc được row mới |
| Rollback | `alembic downgrade` — phải test trước khi merge, không phải sau |

### V3.6 — Human Input / Approval

| | |
|---|---|
| Phụ thuộc | **V3.5.** Không bắt đầu trước |
| Đổi gì | Tool `ask_human`; runtime chặn tool `risk != none`; endpoint resume |
| Rủi ro | Cao — bề mặt mới nhận input từ người |
| Nghiệm thu | I1–I4 + **sanitize test** (nội dung model sinh render trong markdown builder/chat) + **permission re-check lúc resume** (quyền thu hồi giữa chừng → run fail có lý do, không chạy tiếp) |
| Deploy độc lập | Có |

### V3.7 — `Skill` / Subflow

| | |
|---|---|
| Phụ thuộc | V3.1 (`output_schema`) + V3.2 (ToolNode) |
| Rủi ro | **Cao nhất về security** |
| Nghiệm thu trước feature | `max_depth`, cycle detection (chặn lúc đăng ký), budget inheritance, **permission intersection**, trace parent/child — mỗi cái một test, viết **trước** khi skill chạy được |
| Deploy độc lập | Có |

### V3.8 — MCP / HTTP vào cùng registry

| | |
|---|---|
| Phụ thuộc | V3.1 |
| Nguyên tắc | Một registry. Không hệ song song |
| Nghiệm thu | Tool ngoài đi qua **đúng** `_capability_refusal()` và resource scope như tool native |

### Song song — Eval harness

Không phải phase; chạy từ V3.1 và không chặn phase nào.

15–20 câu, chấm bằng tiêu chí **tất định trước**: scope có bị vi phạm không · mọi số có
trace được không · có từ chối khi nên từ chối không. Mở rộng sau khi ba tiêu chí đó ổn.

**Từ V3: bug production thành eval case, không chỉ thành pytest.**

---

## 4. Thứ tự và phụ thuộc

```
V3.0 golden replay        ← trước tất cả
   │
V3.1 output_schema + risk
   ├──────────────┬─────────────┐
V3.2 ToolNode   V3.8 MCP/HTTP  (eval chạy song song từ đây)
   │
V3.3 Runtime layers
   │
V3.4 AgentStrategy
   │
V3.5 RunCheckpoint
   │
V3.6 HITL
   │
V3.7 Skill   ← cần cả V3.1 và V3.2
```

---

## 5. Tương thích ngược — cam kết cụ thể

| Thứ | Cam kết |
|---|---|
| 25 brain version đã lưu | Chạy ra **cùng** execution_path, tool_log, output vars, notices |
| 2 binding | Không đổi schema, không đổi nghĩa |
| 291 run cũ | Runs tab render nguyên vẹn sau V3.5 |
| 10 chat thread | Không đổi |
| 36 `ToolSpec` | Construct được không sửa; field mới đều có default |
| 13 node type | Không type nào đổi hành vi |
| 21 CI suite | Xanh ở mọi phase |

**Nếu một phase buộc phải phá một dòng trong bảng này → phase đó thiết kế sai.**

---

## 6. Dừng lại khi nào

Dừng và báo cáo, không tự đi tiếp, nếu:

- Golden replay lệch mà **không giải thích được** lệch ở đâu và vì sao
- Một phase cần đổi `Flow` contract theo kiểu flow cũ không validate
- Một phase cần bỏ một dòng trong §16 của [gap analysis](agent-flow-v3-dify-gap-analysis.md)
- Permission intersection của Skill chưa có test mà feature đã chạy được

---

## 7. Chưa làm trong vòng này

Graph/DAG · clone `web/` · Plugin Daemon · Marketplace · Trigger registry ·
Agent inner layers · OTEL · tách microservice · Planner/Multi-Agent.

---

*Số liệu §0 đếm trực tiếp trên DB local qua `information_schema` tại thời điểm viết.
Không dùng làm source-of-truth cho test — test phải derive từ registry và từ DB lúc chạy.*
