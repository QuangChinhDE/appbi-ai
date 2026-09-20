# Kế hoạch test tầng tool của Agent Flow — v2

> **v1** viết sau khi một lỗi lọt qua: bước đọc nhận *"thời tiết sao Hỏa hôm nay"* là
> câu hỏi khớp báo cáo. **v2** viết sau khi một chuyên gia đọc code và phản biện v1.
> Tôi đã kiểm chứng từng claim kiểm được bằng source thay vì gật đầu; kết quả ở mục 1.

---

## 1. Kiểm chứng phản biện — đối chiếu với code trên `demo`

| Claim của chuyên gia | Kết luận | Bằng chứng |
|---|---|---|
| #3 *"mọi tool 0 param phải lỗi"* sẽ làm hệ thống cứng quá | ✅ **Đúng** | 4/32 schema khai `required = []`: `inspect_filters`, `list_charts`, `describe_time_coverage`, `resolve_chart_candidates` |
| #2 `returns` là documentation contract, chưa assert trực tiếp được | ✅ **Đúng** | 16/122 key khai báo không phải identifier hợp lệ: `'actual / target'`, `'columns / rows'`, `'delta / pct_change'`… |
| #4 đã có `_guard_payload()` trim-trước-refuse-sau | ✅ **Đúng** | `registry.py:523`, docstring ghi đúng *"TRIM FIRST, refuse second"*. **Và chưa có test nào** chạm `_guard_payload` hay `max_result_tokens` |
| Cần thêm **cache isolation test** | ❌ **Đã có rồi** | `_authorization_identity()` gói `allowed_chart_ids` + `excluded_columns` + `knowledge_scope` + actor; test ở `test_agent_flow_golden.py:841–863` cho cả 3 trục |
| Cần thêm **capability gate test** (web) | ❌ **Đã có rồi** | Enforce ở 3 chỗ (`agent.py:63`, `agent.py:176`, `data.py:716`); test ở golden:426 dựng binding `web_search: False` |
| Cần thêm **forged tool-call test** | ❌ **Đã có rồi** | `test_the_allowlist_is_enforced_at_call_time_not_only_in_the_schemas` |
| **`read_rows=False` không được enforce** | ✅ **Đúng — và nặng hơn mô tả** | xem mục 2 |
| Con số tool hard-code sẽ drift | ✅ **Đúng, đã tự chứng minh** | v1 ghi "21 tool cần `chart_id`", tài liệu 36-tools ghi "20/36". Đo lại: **32 schema, 20 BẮT BUỘC, 21 chấp nhận.** Cả hai đều đúng về hai thứ khác nhau và không cái nào nói rõ |

**Tỉ lệ: 5 đúng / 3 đã có sẵn.** Ba cái "đã có sẵn" đáng nói ra, vì nếu làm theo sẽ
tốn công viết lại thứ đang chạy và đang xanh.

---

## 2. Phát hiện nghiêm trọng nhất: `read_rows`

Chuyên gia nói capability này "hầu như không có tác dụng". Chính xác hơn thế:

```
grep read_rows toàn bộ app/services/
  envelope.py:172     read_rows: bool = True        ← khai báo
  binding.py:198      read_rows=True                ← link đặt
  direct_chat.py:220  read_rows=False               ← chat đặt
  data.py:207         if node.include_data and ...  ← NƠI DUY NHẤT kiểm
```

**Không tool nào thấy `read_rows`. `dispatch` cũng không mang nó xuống `ctx`.**

Điều này càng rõ khi so với hai capability anh em, ngay trong cùng một khối
`dispatch.py:437–439`:

```python
ctx.max_rows_per_call  = binding_info.capabilities.max_rows_per_call
ctx.max_result_tokens  = binding_info.capabilities.max_result_tokens
# read_rows — không có dòng nào
```

Khối đó có comment giải thích đúng lý do phải làm vậy: *"a tool body cannot see the
binding and should not learn to"*. `read_rows` bị bỏ sót khỏi chính khối đã biết cách
xử lý nó.

### Vì sao trước đây vô hại, và vì sao bây giờ thì không

Chat từng có `charts=ChartsScope(mode="allowlist", ids=[])` → 0 biểu đồ → mọi tool
chart đều từ chối bằng `chart_out_of_scope`. `read_rows=False` khi đó là thừa.

Phiên này tôi thêm union scope từ knowledge (`dispatch.py:461`), nên **chat flow giờ
có biểu đồ thật**. Một chat flow được cấp `get_chart_data` sẽ đọc dòng dữ liệu, dù
contract nói không. Lỗ này do thay đổi của tôi mở ra.

### Hai lựa chọn hợp lệ — cần anh chốt

| | |
|---|---|
| **A. Enforce thật** | Mang `read_rows` xuống `ctx` như hai capability kia; tool đọc dòng từ chối bằng `not_granted` khi false. Chat mất khả năng đọc dòng — đúng như contract đang hứa |
| **B. Bỏ khỏi contract** | Nếu chat *nên* đọc được dòng, thì `read_rows=False` là lời hứa sai; xoá nó và để `max_rows_per_call` làm việc giới hạn |

Không được có lựa chọn C: contract nói `false`, runtime vẫn đọc.

---

## 3. Nguyên tắc thay thế — ALLOW / REFUSE / DEGRADE

v1 của tôi nói *"mỗi tính năng phải có ít nhất một đầu vào nó phải TỪ CHỐI"*. Đúng
nhưng nhị phân. Bản của chuyên gia tốt hơn và tôi lấy nguyên:

> **Mỗi capability phải được test cả 3 trạng thái: ALLOW — REFUSE — DEGRADE.**

| Tình huống | Trạng thái đúng |
|---|---|
| chart ngoài scope | REFUSE |
| web bị tắt | REFUSE / SKIP |
| đọc được 50/72 dòng | **DEGRADE** + `coverage` |
| query hơi mơ hồ | **DEGRADE** / tìm thêm |
| câu hỏi hoàn toàn lạc đề | REFUSE match |
| đủ evidence | ALLOW |

Không phải cái gì chưa hoàn hảo cũng `REFUSE` — đó là cách làm hệ thống cứng đến mức
vô dụng.

### Và ba cấp rule cho kiến trúc

| Cấp | Ví dụ | Hành vi |
|---|---|---|
| 🔴 **Hard Constraint** | permission, scope, capability, budget trần, rò rỉ raw data | runtime **bắt buộc chặn**, không override |
| 🟠 **Guardrail** | >6 tool/node, forecast chưa kiểm seasonality, answer node còn tool, read quá rộng | cho chạy, **cảnh báo rõ**, author override được |
| 🟢 **Agent Freedom** | gọi tool nào trước, specialist nào chạy, mấy vòng reasoning | AI tự quyết trong budget |

Điều này trực tiếp trả lời câu hỏi tôi để ngỏ ở lần trước ("1 node nhiều tool có khó
thiết kế không"): **2–6 tool/node là Guardrail, không phải Hard Constraint.** Không
block tool thứ 7; cảnh báo ở 7–10, cảnh báo mạnh ở >10.

---

## 4. Khoảng trống lớn nhất v1 bỏ sót: chọn tool đúng hay sai

Đây là chỗ phản biện đúng nhất và v1 của tôi hoàn toàn không có.

v1 test 36 tool như 36 hàm độc lập. Nhưng hệ thống có thể đạt **36/36 tool pass** và
vẫn trả lời sai, nếu Agent hỏi *"Danh mục nào doanh thu cao nhất?"* mà chọn
`get_chart_data` (50 dòng đầu, cắt ngang) thay vì `rank_values` (tính trên toàn bộ).
Đó chính là sự cố sai 17× đã có trong repo.

> **Tool đúng + orchestration sai = Agent vẫn sai.**

Cách test: **không assert đường đi cụ thể** (`A → B → C`), vì thế là giết flexibility.
Assert **bất biến của đường đi**:

| Intent | Agent được tự do | Bất biến bắt buộc |
|---|---|---|
| Ranking | tìm chart bằng cách nào cũng được | không kết luận xếp hạng từ raw rows đã bị cắt |
| Total | discover kiểu gì cũng được | tổng phải tính trên full data |
| Forecast | chọn time chart tùy | phải có trục thời gian; kết quả đánh dấu là projection |
| Compare | chọn tool compare nào cũng được | không tự tính từ raw data thiếu |
| Knowledge | search hay đọc thẳng doc đều được | source phải trong granted scope |
| Web | research/search/fetch tùy | phải có capability `web_search` |
| Off-topic | được tìm thêm | không được giả vờ báo cáo có match |
| Thiếu dữ liệu | được thử nguồn khác | cuối cùng phải nói không đủ evidence |
| Lookup đơn giản | 1–2 lượt đều được | không chạy Coordinate 15 lượt vô ích |
| Synthesis | chữ nghĩa tự do | mọi con số phải trace được về evidence |

---

## 5. Bốn tầng test

| Tầng | Mục tiêu | Model thật? | Chạy khi nào |
|---|---|:---:|---|
| **L1 Contract** | schema, permission, capability, error taxonomy, envelope | ❌ | mọi PR |
| **L2 Tool Behavior** | 36 tool chạy trên canonical fixture | ❌ | mọi PR |
| **L3 Flow Policy** | bất biến chọn tool, chống chọn sai tool | fake/scripted model | mọi PR |
| **L4 Agent Eval** | câu hỏi tự nhiên → path + chất lượng trả lời | ✅ | nightly / trước release |

**Lưu ý về L4:** chuyên gia đề xuất 50–100 golden question. Tôi đồng ý về hướng nhưng
đề nghị bắt đầu **15–20 câu**, và chấm bằng tiêu chí **tất định trước** — scope có bị
vi phạm không, mọi số có trace được không, có từ chối khi nên từ chối không. "Chất
lượng trả lời" cần người chấm hoặc model chấm, và đó là chi phí định kỳ, không phải
chi phí một lần. Mở rộng lên 100 câu sau khi ba tiêu chí tất định đã ổn định.

---

## 6. Bảng ưu tiên v2

### P0

| # | Việc | Ghi chú so với v1 |
|---|---|---|
| **1** | **Chốt `read_rows`: A hay B** rồi test theo lựa chọn | mới — phát hiện của chuyên gia |
| **2** | Resource scope invariant: mọi tool chạm chart/doc/dataset/metric phải từ chối ngoài grant. **Derive từ schema**, không hard-code danh sách | mở rộng v1#1 |
| **3** | Deterministic caller contract: chuẩn hoá `match_status` (`exact/strong/weak/none`) + `fallback_used` + `coverage.matched/candidates` | **nâng v1#5 lên P0** |
| **4** | Schema-negative testing: sinh case từ `required` của từng tool (thiếu / sai kiểu / ngoài enum / biên). Tool `required=[]` phải chạy an toàn và **bounded**, không phải fail | **thay hẳn v1#3** |
| **5** | Hard invariant: không result nào vượt `max_result_tokens` mà vẫn vào prompt | thay phần cứng của v1#4; cơ chế đã có, **test chưa có** |

### P1

| # | Việc | Ghi chú |
|---|---|---|
| **6** | Envelope contract: `ok`, `kind` == `result_kind` đã khai, shape data/error, `coverage` khi truncated, không raw exception | v1#2 hạ xuống mức assert được ngay |
| **7** | Formal `output_schema` cho tool có node tiêu thụ tất định, rồi mới property-test theo nó | điều kiện tiên quyết thật của v1#2 |
| **8** | Valid smoke **toàn registry** (`for tool in all_tools()`), tool thứ 37 chưa có fixture → CI đỏ | thay danh sách 13 cứng của v1#11 |
| **9** | Selector: off-topic case thành property chung cho mọi selector | v1#6 |
| **10** | Truncation semantics + **không được suy total/ranking từ slice** | v1#7 mở rộng |
| **11** | `no data ≠ zero`, và câu hỏi ngoài khoảng dữ liệu | v1#8 mở rộng |
| **12** | **L3 Flow Policy**: ranking / forecast / discover / knowledge / off-topic | **mới, quan trọng nhất** |
| **13** | Error taxonomy: `invalid_arg` ≠ `not_applicable` ≠ `no_data` ≠ `out_of_scope` | mới |
| **14** | Cross-layer: giá trị control trên UI = giá trị hiệu lực runtime | v1#10 nâng cấp |

### P2

| # | Việc |
|---|---|
| **15** | Payload regression trên canonical fixture (cảnh báo khi phình >X%), **không hard-fail theo dataset** |
| **16** | Declaration health: `small/medium/large` vượt budget → test riêng, không chặn CI |
| **17** | L4 eval với model thật, 15–20 câu, nightly |

### Không làm

`cache isolation`, `capability gate (web)`, `forged tool-call` — đã có cơ chế và đã có
test. Viết lại chỉ tốn công.

---

## 7. Chốt lại

Phản biện đúng ở chỗ căn bản: v1 nhìn Agent Flow như **36 hàm độc lập**, trong khi sản
phẩm là **một decision system**. Nếu chỉ làm 11 case của v1, ta đạt *"36 tool đều an
toàn"* mà chưa đảm bảo *"AI biết khi nào dùng tool nào"*.

Nhưng phản biện cũng đề xuất ba việc đã xong và đang xanh. Nhận cả gói mà không kiểm
sẽ tốn công viết lại thứ đang chạy — đó là lý do mục 1 tồn tại.

> Tool tự do trong contract → Agent tự do trong guardrail → Runtime **không** tự do ở
> security và data correctness.

---

*Kiểm chứng trên `demo` @ `039cfdd`. Mọi con số trong tài liệu này là snapshot và
**không được dùng làm source-of-truth cho test** — test phải derive từ registry.*
