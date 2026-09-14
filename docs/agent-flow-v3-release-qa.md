# Agent Flow V3 — Release QA

**Ngày:** 2026-09-15 · **Nhánh:** `demo`

---

## A. SHA đã test

| | |
|---|---|
| Baseline reviewer nhìn thấy | `68587a7` |
| **Remote khi bắt đầu QA** | `8f69f79` (V3.0–V3.2 đã push trước khi có chỉ thị QA) |
| **HEAD đã QA** | `a6541e7` |
| Uncommitted khi bắt đầu | không có (chỉ 5 file noise của work-stream khác) |

Toàn bộ QA chạy trên **một cây xác định**. Mọi mutation đều restore trong `finally`
và working tree được kiểm sạch sau đó.

### Commit V3 + QA

```
a6541e7  test  mutation escaped → 4 test chạy code tính status thật
e29f8ab  test  Playwright tracked suite + 4 test của tôi vốn không kiểm gì
0265017  refactor  xoá vòng lặp brain thế hệ cũ + sửa test permission kêu oan
8f69f79  feat  V3.2 ToolNode
a3c269a  feat  V3.1 output_schema + risk
efedd5d  feat  V3.0 replay harness + I5 tripwire
```

---

## B. File thay đổi

**Thêm:** `backend/tests/replay_harness.py` · `test_agent_flow_replay.py` ·
`test_i5_hard_gate_stays_lowest.py` · `test_tool_output_contract.py` ·
`test_tool_node.py` · `test_tool_authorization_metadata.py` ·
`test_tool_capability_gates.py` · `test_tool_argument_contract.py` ·
`test_tool_result_ceiling.py` · `tests/fixtures/agent_flows/**` (16 fixture + 16
snapshot) · `backend/scripts/agent_flow_replay.py` · `backend/scripts/ci/seed_e2e_user.py` ·
`e2e/**` (config + 4 spec) · `.github/workflows/e2e.yml`

**Sửa:** `tools/registry.py` · `tools/packs/*.py` (36 tool) · `contract.py` ·
`runtime/handlers/data.py` · `dispatch.py` · `dashboard_ai_bot/thinking/{agent,__init__}.py` ·
`frontend/src/{lib/agentFlows.ts, components/agent-flows/NodeInspector.tsx, i18n/catalog/agent-flows.ts}` ·
`.github/workflows/backend-contract-tests.yml` · `.gitignore`

**Xoá:** `thinking/critique.py` (77) · `thinking/chart_renderer.py` (835) ·
`run_agent_stream` + 15 helper + 21 import trong `thinking/agent.py` (1.156) →
**2.068 dòng**

---

## C. Kiến trúc — audit implementation song song

| Câu hỏi | Kết quả |
|---|---|
| Ai gọi `spec.fn` trực tiếp? | **Chỉ registry.** Hit duy nhất ngoài là `workboards/js_evaluator.py` — không liên quan |
| Ai gọi `registry.execute`? | 4 nơi, đều hợp lệ: `data.py` (5), `agent.py`, `binding.py` (`_distinct_values`) |
| FE có hard-code node/tool list? | **Không.** `BrainBuilder` fetch `nodeSpecs` + `packs` từ API |
| Còn runtime V2 reachable? | **Có — đã xoá.** Xem D |
| `returns` vs `output_schema` | Hai contract, hai người đọc; không generate từ nhau — có test ghim |
| MCP song song | Chưa có MCP trong Agent Flow; một registry duy nhất |

**Một behavior = một owner** sau cleanup: tool execution → `registry.execute()` ·
agent execution → `handlers/agent.py` · node catalogue → `runtime/nodes.py` ·
tool catalogue → `tools/registry.py` · permission → `module_floor` + `_capability_refusal`
+ `assert_chart_in_scope`.

---

## D. Code cũ đã xoá — cụ thể

| Xoá | Dòng | Vì sao |
|---|---:|---|
| `run_agent_stream` | 757 | Vòng lặp trả lời của bot thế hệ cũ. Không route nào gọi; chỉ "sống" vì `thinking/__init__.py` re-export cho không ai |
| 15 helper chỉ nó dùng | 399 | Fixpoint sau khi gỡ re-export |
| 21 import chết theo | ~30 | pyflakes |
| `thinking/critique.py` | 77 | Mất caller cuối cùng |
| `thinking/chart_renderer.py` | 835 | 0 caller từ trước |

**Trace bằng AST, không bằng grep.** Bản grep đầu đọc *dòng* khớp; import ở repo này
trải nhiều dòng nên nó thấy `from ... import (` và bỏ sót mọi tên trong ngoặc — rồi
báo `build_proactive_recon_cached` là dead **trong khi `api/public.py` đang import**.
Parse toàn bộ file không có failure mode đó.

**Giữ lại có lý do:** `explorer.py` (route exploration), `briefing.py`,
`conversation_state.py`, `prompts.py`, `insight_pack`, `govern_tools`, `providers/`,
`tool_context` — mỗi cái được import trực tiếp bởi route hoặc bởi engine V3.
`agent.py` còn 434 dòng, đúng phần recon + briefing thật sự dùng.

---

## E. Compatibility adapter giữ lại

| Adapter | Vì sao | Điều kiện xoá |
|---|---|---|
| `packs/_source.py` | 26 tool còn lấy body từ `dashboard_ai_bot`. Không phải runtime thứ hai — chỉ là vị trí file | Khi tool body được dời; một khối import đổi, không pack nào đổi |
| `tool_context.py` | Re-export của `agent_flows.tools.context` cho 20 import site cũ | Khi các import site được đổi |
| `_CODE_HINTS` suy mã lỗi từ câu tiếng Anh | Body cũ báo lỗi bằng câu văn | Khi mọi body trả `error_code` — xem O |

---

## F. Backend

### F.1 Suite Agent Flow (host)

| Suite | passed | failed |
|---|---:|---:|
| test_agent_flow_golden | 132 | 0 |
| test_tool_authorization_metadata | 151 | 0 |
| test_tool_argument_contract | 137 | 0 |
| test_tool_output_contract | 53 | 0 |
| test_agent_flow_replay | 49 | 0 |
| test_report_read_scope | 24 | 0 |
| test_discover_pack | 20 | 0 |
| test_agent_flow_answer_contract | 18 | 0 |
| test_tool_capability_gates | 18 | 0 |
| test_i5_hard_gate_stays_lowest | 17 | 0 |
| test_tool_node | 16 | 0 |
| test_partial_context_admits_it | 14 | 0 |
| test_chat_chart_scope | 14 | 0 |
| test_builder_error_messages | 13 | 0 |
| test_agent_tool_registry | 12 | 0 |
| test_chart_read_failure_reason | 11 | 0 |
| test_tool_result_ceiling | 6 | 0 |
| **Tổng** | **685** | **0** |

`test_module_floor` fail 2 trên **host** (FastAPI 0.141.1 include router lazily) và
**17/17 pass trên stack đã pin** — artifact môi trường, đã chứng minh.

### F.2 Full collection — stack đã pin (Py 3.11, pytest 7.4.4, FastAPI 0.109.0)

| Command | collected | passed | failed | skipped | duration |
|---|---:|---:|---:|---:|---:|
| `pytest -q tests` (container) | 3.204 | **3.144** | 40 | 20 | 62s |

### F.3 Canonical replay

| | |
|---|---|
| `scripts/agent_flow_replay.py --verify` | **16 fixture, no semantic drift** |

---

## G. Integration API + DB

Chạy qua Playwright `request` context tới API thật + Postgres thật (§I). Bao gồm
`PUT /brains` upsert, `GET /brains/{key}` đọc lại body, `POST /validate`,
`GET /tools`, `GET /nodes`.

**Tier-2 Postgres/snowflake golden** chạy trên CI runner (cần `CI_FIXTURE_SEED=1` và
Postgres dùng-một-lần; script `DROP` schema `bcfix`). **Chưa chạy local** — không
chạy trên DB dev.

---

## H. Frontend

| Gate | Kết quả |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run qa` | 90/90 presentation-contract + theme-menu |
| `npm run build` | thành công |

Không dùng `ts-ignore`, `eslint-disable` hay `any` để làm xanh.

---

## I. Playwright — full stack, tracked

`e2e/` theo đúng convention `.gitignore` đã có sẵn. Browser + Next.js + API +
Postgres + runtime **đều thật**, không route-mock. Chạy: `npm run test:e2e`.

| Spec | tests | nội dung |
|---|---:|---|
| `security-forged.spec.ts` | 14 | truy cập không đăng nhập (4 route), body flow giả mạo (6, có **control case**), tool catalogue là contract (3) |
| `builder.spec.ts` | 7 | list + builder mở không lỗi console, palette một nguồn, save/reload, ToolNode round-trip typed binding, catalogue đủ cho form |
| `layout.spec.ts` | 4 ×2 viewport | không scroll ngang, inspector trong biên 320–820, không control 0px, tên tiếng Việt dài |
| **Tổng** | **28** | **28 passed** |

Mọi spec critical assert **0 console error, 0 failed request**.

---

## J. Artefact

`trace: retain-on-failure`, `screenshot: only-on-failure`, video trên CI. Workflow
upload `test-results/` + `playwright-report/` khi fail, giữ 14 ngày.

---

## K. Live model eval

```
LIVE MODEL QUALITY: UNVERIFIED
```

**Lý do:** không chạy vì sẽ phải mở `.env`/token — bị cấm rõ ràng trong phiên này.
Mọi test dùng provider stub tất định. **Chất lượng suy luận của model chưa được đo.**
Đây là hạn chế phải nói ra, không phải một mục đã pass.

---

## L. Mutation audit — 12/12 CAUGHT, 0 escaped

| # | Mutation | Verdict |
|---|---|---|
| M1 | Xoá `_capability_refusal()` khỏi `execute()` | CAUGHT |
| M2 | Cho `raw_rows` chạy khi `read_rows=False` | CAUGHT |
| M3 | Cho external tool chạy khi `web_search=False` | CAUGHT |
| M4 | ToolNode gọi `spec.fn` thay vì invoker | CAUGHT |
| M5 | Tool bỏ khai `resource_refs` | CAUGHT |
| M6 | Tool bỏ khai `risk` | CAUGHT |
| M7 | `output_schema` hứa key kết quả không có | CAUGHT |
| M8 | Bypass `max_result_tokens` | CAUGHT |
| M9 | Fallback listing báo là `matched` | **ESCAPED → đã vá → CAUGHT** |
| M10 | Node `reused` chạy lại handler | CAUGHT |
| M11 | Cache key bỏ authorization identity | CAUGHT |
| M12 | Xoá module floor khỏi router | CAUGHT |

**M9 là giá trị lớn nhất của cả vòng QA.** Nó thoát vì mọi test trong
`test_report_read_scope.py` đưa cho `_charts_for_question` một **fixture đã chứa sẵn
`selection`** — kiểm luật của caller, chưa bao giờ chạy code tính `status`. Bất biến
"fallback không phải match" chỉ được canh một phía, và phía bỏ ngỏ chính là phía đã
sinh ra sự cố "thời tiết sao Hỏa". Đã thêm 4 test chạy tool thật, gồm **control case**.

---

## M. Bốn test của tôi vốn không kiểm gì

Ghi lại vì đây là loại lỗi cả vòng QA này nhắm tới.

1. **`playwright.request.newContext()` kế thừa `storageState`** → request "ẩn danh"
   mang session admin, trả 200 với toàn bộ flow. Nhìn nhanh giống lỗ auth; `curl`
   trả 401. Test bảo mật tự đăng nhập thì xanh mãi mãi.
2. **Forged payload POST vào `/brains`** rồi assert `status >= 400`. Route là PUT
   nên tất cả đọc **405 Method Not Allowed** và gọi đó là "đã từ chối". Giờ đi qua
   `POST /validate` và assert **lý do**, kèm control case.
3. **ToolNode round-trip** đọc `resolve/{id}` với id đoán, fallback về listing —
   listing **không mang body**, nên assertion typed-binding chưa từng chạy.
4. **Layout test** lấy `aside.last()` = nav rail 56px, fail vì lý do không liên quan
   panel nó được viết cho.

Và ở backend: bản đầu của `test_a_declared_schema_matches_what_the_tool_actually_returns`
**xanh mà không kiểm gì** — mọi tool fail trên context trần, vòng lặp không chạy lần
nào; chỉ guard `checked >= 1` tôi viết sẵn cho đúng tình huống đó bắt được.

---

## N. CI

| Workflow | Nội dung |
|---|---|
| `backend-contract-tests.yml` unit tier | **9 → 25 suite** (18 suite Agent Flow) |
| `backend-contract-tests.yml` integration | Postgres + snowflake golden (không đổi) |
| `e2e.yml` **(mới)** | Postgres + backend thật + Next.js build + Playwright, upload artefact khi fail |

Mọi test mới đều **tracked** (`.gitignore` re-include) và **có trong CI**. Đã sửa một
dòng `e2e/` ở cuối `.gitignore` đang re-exclude cả thư mục **sau** các negation — suite
lẽ ra không commit được.

---

## O. Vấn đề còn lại

### O.1 40 failure còn lại — đã phân loại đủ

| | |
|---|---|
| Số lượng | 40 (stack pinned) |
| **Tracked trong git** | **0** |
| **Có trong CI** | **0** |
| Liên quan V3 | **0** |

Toàn bộ nằm trong 13 file test **chỉ tồn tại trên máy này**, chưa bao giờ được commit,
nên chưa bao giờ được CI chạy — theo đúng tiêu chuẩn của reviewer thì chúng không phải
coverage. Hai file thuộc package vừa cắt (`test_dashboard_ai_bot_insight_pack`,
`test_dashboard_ai_bot_cost`) đã kiểm riêng: chỉ import `insight_pack` và `cost`,
**0 giao với những gì tôi xoá**; nội dung fail là hằng số trend % và bảng giá Gemini —
stale.

**Đề nghị:** owner của từng work-stream triage hoặc xoá. Tôi không tự quyết cho 13
work-stream khác.

### O.2 Đã sửa trong vòng này

`test_the_five_per_endpoint_routers_carry_a_module_floor` — test permission **tracked**
fail mọi full run, trước đây bị ghi là "order pollution". Đo thật: `router.dependencies`
**vắng mặt** (không phải rỗng) và app quan sát được **không có route nào** dưới prefix
workboards → module khởi tạo dở do import vòng. Không phải lỗ floor. Test giờ phân biệt
*vắng* (skip, nói rõ) với *rỗng* (fail). Mutation M12 chứng minh vẫn bắt được lỗ thật.

### O.3 Còn nợ

| Việc | Trạng thái |
|---|---|
| Live model eval | **UNVERIFIED** — cần token, bị cấm mở trong phiên |
| Error taxonomy | `assert_chart_in_scope` báo `query_failed` thay vì `chart_out_of_scope`; đã ghim trong fixture `12_chart_out_of_scope` kèm `known_defect` |
| `binding._distinct_values` | Consumer thứ hai của `get_chart_data`; lỗi bị nuốt thành `[]`. Đi qua gate đúng nhưng im lặng |
| E2E: run inspector, bot surface, chat surface | Chưa viết — cần flow published + link, ngoài phạm vi vòng này |
| Tier-2 integration local | Chỉ chạy trên CI runner |

---

## Definition of Done

| Điều kiện | |
|---|---|
| BE contract tests green | ✅ 685/685 |
| Runtime policy tests green | ✅ |
| Canonical replay green | ✅ 16 fixture, no drift |
| FE typecheck/qa/build green | ✅ |
| Critical Playwright green | ✅ 28/28 |
| Browser console/network sạch | ✅ |
| Security negative tests green | ✅ 14 |
| Mutation audit có răng | ✅ **12/12 caught** |
| Không failure nào chưa giải thích | ✅ 40/40 đã phân loại, 0 tracked, 0 V3 |
| Không runtime cũ/mới song song | ✅ 2.068 dòng đã xoá |
| Dead code đã dọn | ✅ |
| CI có suite regression | ✅ 25 suite + workflow E2E |
| **Live model quality** | ❌ **UNVERIFIED** |

**Kết luận:** deterministic engineering signoff đạt. Chất lượng suy luận của model
chưa đo được trong phiên này và không được coi là đã pass.
