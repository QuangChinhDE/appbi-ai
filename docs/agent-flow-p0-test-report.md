# Báo cáo test — P0 tầng tool Agent Flow

**Commit code:** `14c4c38` · **Nhánh:** `demo` · **Ngày:** 2026-09-14

Theo Definition of Done của reviewer. Mọi con số dưới đây là output thật, không ước lượng.

---

## 1. Đã implement

| P0 | Việc | Kết quả |
|---|---|---|
| **P0-1** | `read_rows` → semantics **raw-row exposure** | `ToolSpec.data_exposure = metadata \| derived \| raw_rows`; registry từ chối `raw_rows` khi binding tắt; **computing tool vẫn chạy** |
| **P0-2** | Web capability enforce **tại call-time** | `_capability_refusal()` chặn `reaches_outside` khi `web_search=False`, trước khi `spec.fn` chạy |
| **P0-3** | `resource_refs` metadata + property test | 25 tool khai; CI đỏ nếu tool mới có resource arg mà không khai |
| **P0-4** | Deterministic selection contract | `selection = {status, mode, fallback_used, selected_ids, query_terms, best_hits, reason}` |
| **P0-5** | Schema-generated negative tests | Sinh từ `required` của từng tool; tool `required=[]` phải chạy an toàn, **không** phải fail |
| **P0-6** | `max_result_tokens` invariant | 6 case chạy `_guard_payload`, gồm cả context không mang trần |

**Không** dùng cách chặn `_fetch_chart_data()` chung — đúng như reviewer yêu cầu.

---

## 2. Kết quả test

### 2.1 Tầng tool Agent Flow — per suite

| suite | collected | passed | failed | skipped | duration |
|---|---:|---:|---:|---:|---:|
| test_tool_authorization_metadata | 151 | 151 | 0 | 0 | 5.65s |
| test_tool_capability_gates | 18 | 18 | 0 | 0 | 4.94s |
| test_tool_argument_contract | 137 | 137 | 0 | 0 | 9.30s |
| test_tool_result_ceiling | 6 | 6 | 0 | 0 | 5.16s |
| test_report_read_scope | 20 | 20 | 0 | 0 | 5.58s |
| test_chart_read_failure_reason | 11 | 11 | 0 | 0 | 5.07s |
| test_agent_tool_registry | 12 | 12 | 0 | 0 | 5.13s |
| test_agent_flow_golden | 132 | 132 | 0 | 0 | 5.83s |
| test_agent_flow_answer_contract | 18 | 18 | 0 | 0 | 5.60s |
| test_builder_error_messages | 13 | 13 | 0 | 0 | 5.51s |
| test_partial_context_admits_it | 14 | 14 | 0 | 0 | 5.15s |
| test_chat_chart_scope | 14 | 14 | 0 | 0 | 5.25s |
| test_discover_pack | 20 | 20 | 0 | 0 | 5.55s |
| **TỔNG** | **566** | **566** | **0** | **0** | **73.72s** |

### 2.2 Lệnh CI unit-tier — chạy đúng lệnh trong workflow

Chạy hai lần, trên hai bộ dependency:

| môi trường | pytest | kết quả |
|---|---|---|
| Host (pytest 8.3.4, FastAPI 0.141.1) | 8.3.4 | **740 passed**, 0 failed, 10.63s |
| **Container backend — đúng `requirements.txt` đã pin** (Python 3.11, pytest 7.4.4, FastAPI 0.109.0) | 7.4.4 | **738 passed, 2 skipped**, 0 failed, 10.11s |

Bản pinned là môi trường gần CI nhất có sẵn tại chỗ. **2 skip nằm ở
`test_locked_contract.py:275`** — FE structural guard bỏ qua vì container không
mount `frontend/`; trên CI runner có checkout nên chúng sẽ chạy. **13 suite Agent
Flow đóng góp 0 skip và 0 failure trên cả hai stack.**

### 2.3 Full backend collection

| | collected | passed | failed | skipped | duration |
|---|---:|---:|---:|---:|---:|
| `python -m pytest -q tests` | 3065 | **3012** | 44 | 9 | 22.04s |

**44 failed là baseline có sẵn**, không phải mới. Bằng chứng: trước thay đổi này cũng 44 failed (2669 → 2700 → 3012 passed khi test mới được thêm, số failed không đổi). Lọc theo vùng đã sửa:

```
pytest -q tests | grep "^FAILED" | grep -icE "agent_flow|tool_|report_read|chart_read|partial_context|chat_chart|discover"
→ 0
```

44 failure thuộc `test_workboard_*`, `test_dataset_*` và các suite chịu ảnh hưởng FastAPI version drift trên host (0.141.1 vs pin 0.109.0) — thuộc work-stream khác.

### 2.4 Frontend gates

| gate | kết quả |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run qa` | 90/90 presentation-contract checks passed |
| `npm run build` | thành công |

### 2.5 Integration Postgres/snowflake

Tier-2 (`integration-golden`) chạy trên CI runner với Postgres service + `seed_snowflake_ci_fixture.py`. **Chưa chạy local** — cần `CI_FIXTURE_SEED=1` và một Postgres dùng-một-lần (script `DROP` schema `bcfix`). Không chạy trên DB dev. Kết quả sẽ đến từ CI của commit `14c4c38`.

---

## 3. Verify bằng chạy thật, không chỉ unit test

Gate được kiểm trên **chat surface thật** (`ToolContext` thật, báo cáo 67, 70 biểu đồ):

```
chat contract declares read_rows=False: True

-- row-exposing tools (phải bị chặn) --
   get_chart_data       ok=False code=not_granted
   smart_drilldown      ok=False code=not_granted

-- computing tools, cùng surface (KHÔNG được chặn) --
   rank_values          code=bad_argument     ran
   total_measure        code=bad_argument     ran
   share_of             code=bad_argument     ran
   compare_periods      code=query_failed     ran
   get_chart_summary    ok=True               ran
   aggregate_chart_data code=bad_argument     ran

-- external tools, web tắt (phải bị chặn) --
   benchmark_compare / browse_ai_answer / fetch_url /
   research_web / web_search    → tất cả not_granted

-- mở lại capability --
   get_chart_data ok=True
```

Đây là điểm quan trọng nhất: **gate là gate, không phải tường.** Nửa phân tích vẫn sống.

---

## 4. Test mới — mỗi test khoá lại bug nào

### `test_tool_authorization_metadata.py` (151)

| Test | Khoá lại |
|---|---|
| `test_every_resource_argument_is_declared` | Tool #37 có resource arg mà không khai → scope test bỏ qua trong im lặng |
| `test_declared_resources_exist_in_the_schema` | Khai thừa → rule không bao giờ chạy nhưng đọc như có coverage |
| `test_a_row_shaped_tool_states_its_exposure_explicitly` | **Đã bắt lỗi thật**: `aggregate_chart_data` trả `table` mà thừa hưởng default ngầm |
| `test_the_tools_that_hand_over_rows_are_the_ones_we_expect` | Tập tool lộ dòng phình ra âm thầm |
| `test_at_least_one_tool_requires_nothing_and_that_is_legitimate` | Ghim 4 tool `required=[]` để không ai "sửa" chúng cho hợp một invariant sai |

### `test_tool_capability_gates.py` (18)

| Test | Khoá lại |
|---|---|
| `test_a_row_exposing_tool_is_refused_when_rows_are_withheld` | Chat flow được cấp `get_chart_data` đọc dòng dù contract nói không |
| `test_a_computing_tool_still_runs_when_rows_are_withheld` | **Nửa không được hỏng** — gate làm chết `rank_values`/`total_measure`/… |
| `test_an_external_tool_is_refused_when_the_binding_withholds_web` | Forged tool_call vượt `allowed` vào body khi `web_search=False` |
| `test_the_capability_gate_is_not_the_allowlist` | Hai check bị gộp làm một |
| `test_a_refusal_never_reaches_the_tool_body` | Body đã chạy (đã chạm warehouse / đã ra ngoài) rồi mới vứt kết quả |
| `test_a_context_that_never_heard_of_the_capability_is_not_punished` | Preview/ephemeral context bị từ chối tool mà run thật cho phép |

### `test_tool_argument_contract.py` (137)

| Test | Khoá lại |
|---|---|
| `test_a_missing_required_argument_is_refused` (×N sinh tự động) | Tool nhận thiếu tham số bắt buộc |
| `test_a_mistyped_RESOURCE_argument_is_refused` | `chart_id="all"` đọc thành chart 0 — chọn thứ không ai hỏi, có thể ngoài scope |
| `test_a_mistyped_ordinary_argument_still_returns_the_contract` | Cho phép khoan dung, cấm traceback |
| `test_a_tool_that_requires_nothing_does_not_fail_on_nothing` | **Case invariant "0 param phải lỗi" sẽ phá hỏng** |
| `test_the_generated_suite_actually_covers_something` | Generator sinh 0 case → suite xanh mà không test gì |

### `test_tool_result_ceiling.py` (6)

| Test | Khoá lại |
|---|---|
| `test_a_result_over_the_ceiling_does_not_reach_the_caller_intact` | Payload vượt trần vào thẳng prompt |
| `test_a_trimmed_result_says_it_was_trimmed` | Slice không tự khai → đọc thành toàn bộ (vụ sai 17×) |
| `test_a_shape_that_cannot_be_trimmed_is_refused_not_passed_through` | Trim thất bại rồi thả qua luôn |
| `test_a_context_with_no_ceiling_still_gets_one` | Vắng trần = vô hạn |

---

## 5. Test có được Git track và CI chạy không

| | Trước | Sau |
|---|---|---|
| CI unit-tier chạy | 9 suite | **21 suite** |
| Suite Agent Flow trong CI | 1 (`test_agent_flow_golden`) | **13** |
| `.gitignore` re-include | 9 file | **21 file** |

**Đây là lỗ reviewer chỉ ra và nó đúng với chính test của tôi:** các suite tôi viết ở phiên trước đã tracked (`git add -f`) nhưng CI không chạy. Tracked ≠ coverage. Đã thêm cả 12 suite vào `.github/workflows/backend-contract-tests.yml` và `.gitignore`. YAML đã validate bằng `yaml.safe_load`.

---

## 6. Còn lại — chưa làm, và vì sao

| Việc | Trạng thái |
|---|---|
| `output_schema` formal | P1 — chưa làm, cần thiết kế trước |
| Full-registry valid smoke | P1 — cần fixture báo cáo canonical |
| L3 Flow Policy | P1 — chỉ những bất biến runtime **thật sự enforce**; phần "AI chọn tool nào" thuộc L4 |
| Coverage-aware evidence verifier | P1 — điều kiện để "ranking từ partial data" thành hard invariant |
| Error taxonomy | P1 |
| L4 live-model eval | P2 |
| Integration tier local | Chạy trên CI runner |

---

## 7. Push và CI

| | |
|---|---|
| Commit code | `14c4c38` |
| Commit track suite + báo cáo | `8aabe95` |
| Remote | `53693fa..8aabe95 demo -> demo`, preflight pass |

**Ghi chú về chẩn đoán sai của tôi.** Ba lần push đầu treo và tôi báo là lỗi
network. Sai. Nguyên nhân là `git push 2>&1 | tail -N` — pipe giữ toàn bộ output
tới khi lệnh kết thúc nên trông như đứng im — cộng với việc tôi chạy `git add`
song song, tranh `.git/index.lock` với hook đang stash. Chạy không pipe và không
có git khác chạy cùng thì push qua ngay, preflight pass (alembic 166 revisions
single head, tsc sạch, import smoke sạch).

**Chưa lấy được kết quả GitHub Actions từ máy này** — không có `gh` CLI và không
có token, và tôi không đi tìm credential. Cần xem tại:
`https://github.com/QuangChinhDE/appbi-ai/actions?query=branch%3Ademo`
Workflow trigger theo path `backend/**`, cả hai commit đều chạm nên sẽ chạy.

---

*Full regression: backend 3012 passed / 44 baseline failed / 9 skipped. CI unit-tier
740 passed (host) và 738 passed + 2 skipped (pinned stack). tsc + qa + build sạch.
Gate verify bằng chạy thật trên chat surface, không phải bằng assert về code.*
