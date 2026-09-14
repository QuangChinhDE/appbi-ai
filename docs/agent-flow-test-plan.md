# Kế hoạch test tầng tool của Agent Flow

> Viết sau khi một lỗi thật lọt qua: bước đọc mới nhận *"thời tiết sao Hỏa hôm nay"*
> là câu hỏi khớp báo cáo và chọn 4 biểu đồ. Tôi tìm ra nó vì tình cờ thử một câu
> lạc đề, **không phải vì có kỷ luật test**. Tài liệu này trả lời: kỷ luật đó phải
> là gì.

---

## 1. Độ phủ hiện tại — đo, không ước lượng

Repo có **1.454 test**. Tầng tool có 11 file test. Nhưng hỏi đúng câu — *"nếu tool
này trả về rác vào ngày mai, có gì đỏ lên không?"* — thì:

| | số lượng |
|---|---|
| Tool đã khai báo | **36** |
| Có test **thật sự gọi** | **7** |
| Chỉ được **nhắc tên** trong test (stub, chuỗi trong assert) | 16 |
| **Không test nào chạm tới** | **13** |

13 tool không ai chạm: `compare_segments`, `segment_compare`, `correlate_charts`,
`benchmark_compare`, `browse_ai_answer`, `research_web`, `aggregate_chart_data`,
`analyze_trend`, `detect_seasonality`, `forecast_measure`, `project_to_period_end`,
`describe_time_coverage`, `get_chart_glossary`.

### Vì sao con số lớn lại che được sự thật này

Hai file test lớn nhất **không test hành vi tool**:

- `test_agent_flow_golden.py` (128 test) — test **runtime**: branch, loop, budget,
  retry, memory. Cố ý stub tool registry. *"No database, no network, no vendor."*
- `test_agent_tool_registry.py` (12 test) — test **bất biến của registry**: mỗi tool
  có body + schema, tên không trùng, allowlist chặn được. Không gọi tool nào.

Cả hai đều tốt và đúng phạm vi của chúng. Nhưng cộng lại chúng tạo cảm giác tầng
tool được bảo vệ, trong khi **thân tool gần như trần**.

---

## 2. Lỗi vừa rồi thuộc lớp nào

`list_charts` xếp hạng biểu đồ theo số token chung với câu hỏi. **Một token chung là
đủ để được coi là khớp.** Với một *model* đọc listing thì đúng — nó thấy tên biểu đồ
và tự phán đoán. Bước `report_read` không có model nào phán đoán.

> **Lớp lỗi: hợp đồng tool viết cho model, bị code tiêu thụ.**
> Mọi "fallback hữu ích" dành cho model đều trở thành lời nói dối với caller tất định.

Lớp này còn ít nhất một chỗ nữa chưa ai đụng: khi `query` không khớp gì,
`list_charts` trả về **toàn bộ** listing kèm ghi chú giải thích. Model đọc ghi chú đó
và hiểu. Code thì nhận một danh sách đầy đủ trông y hệt một kết quả khớp hoàn hảo.

Không test nào hiện có có thể bắt được lỗi này, vì **chưa từng có test nào đưa đầu
vào mà tính năng phải TỪ CHỐI.**

---

## 3. Bảng khuyến nghị

Thứ tự theo *thiệt hại khi sai* × *chi phí viết*. Mỗi dòng gắn với một sự cố có thật
trong repo này — không có dòng nào là giả định.

### P0 — Test thuộc tính, một test phủ cả 36 tool

| # | Test case | Bắt được gì | Sự cố có thật làm căn cứ | Chi phí |
|---|---|---|---|---|
| **1** | Mọi tool nhận `chart_id` (21 tool) phải từ chối id ngoài `allowed_chart_ids` bằng `chart_out_of_scope` | **Rò rỉ dữ liệu** | `owner_email` không có `owner_id` → fail-open; scope chat từng từ chối *mọi* id | 1 test parametrize |
| **2** | Mọi tool trả về đúng `returns` đã khai báo khi thành công | Node dùng kết quả **không cần model** đọc hộ — sai key là hỏng câm | `result_kind`/`returns` là bắt buộc trong `spec()` nhưng **chưa test nào đối chiếu với giá trị trả về thật** | 1 test + fixture data |
| **3** | Mọi tool gọi với **0 tham số** phải trả lỗi — không traceback, không đọc vô hạn | Đọc không giới hạn | `get_chart_data` thiếu `top_n` từng trả **~1.444.000 token** một lần gọi | 1 test parametrize |
| **4** | Payload đo thật phải nằm trong dải `payload` đã khai báo | Tràn ngữ cảnh + chi phí | `list_charts` khai `cheap`, đo 15.600 token / 37.720 ms. `get_chart_summary` khai `medium`, đo tới 2.778 token | 1 test (đánh dấu integration) |

### P1 — Lớp lỗi vừa lọt

| # | Test case | Bắt được gì | Sự cố có thật làm căn cứ | Chi phí |
|---|---|---|---|---|
| **5** | Mỗi caller **tất định** của một tool phải có test với đầu vào tool sẽ "giúp đỡ" thay vì từ chối | Lớp lỗi mục 2 | `list_charts` trả full listing khi trượt; weak-match vừa rồi | 1 test / seam |
| **6** | Mỗi bộ chọn (selector) phải có ≥1 đầu vào **lạc đề** mà nó phải từ chối | Chọn nhầm đầy tự tin | *"thời tiết sao Hỏa"* → 4 biểu đồ, báo `matched` | rẻ |
| **7** | Mọi tool có thể cắt kết quả phải set `coverage.truncated` + tổng thật | **Sai số 17×** | Đọc 50/72 danh mục, model đọc thành bảng xếp hạng đầy đủ, trả lời sai 17 lần | 1 test parametrize |

### P2 — Đúng nghiệp vụ

| # | Test case | Bắt được gì | Sự cố có thật làm căn cứ | Chi phí |
|---|---|---|---|---|
| **8** | Câu hỏi về khoảng thời gian **không có dòng nào** phải được nói rõ, không trả 0 | Trả lời sai một cách tự tin | Dữ liệu demo hết ở 2018-10-17, lịch là 2026 — mọi câu "tháng này" tính trên khoảng rỗng | vừa |
| **9** | Mọi lỗi tool phải tới được **người sửa được**, không chỉ log server | Người dùng phải workaround mù | 8 biểu đồ lỗi, người dựng flow chỉ thấy con số đếm | đã làm 1 phần |
| **10** | Giá trị hiệu lực của mọi control phải bằng giá trị hiển thị | Control giả | `max_rows` cho tới 5000, nhưng `MAX_TOP_N=50` khi ctx thiếu thuộc tính | rẻ |

### P3 — Smoke cho 13 tool chưa ai chạm

| # | Test case | Chi phí |
|---|---|---|
| **11** | Mỗi tool trong 13 cái: gọi với tham số hợp lệ trên báo cáo demo → `ok=true`, đúng shape, không exception | 13 test, rẻ, nên làm cùng #2 |

---

## 4. Thay đổi về quy trình — phần quan trọng nhất

Bảng trên vá được hiện tại. Điều dưới đây mới ngăn lỗi tiếp theo:

> **Mỗi thay đổi ở tầng tool phải kèm ít nhất một đầu vào mà tính năng phải TỪ CHỐI.**

Lỗi weak-match sẽ bị bắt ngay lần viết test đầu nếu quy tắc này có sẵn. Tôi đã viết 5
test cho `match_question` — cả 5 đều là câu hỏi *nên* khớp. Test thứ 6 (câu lạc đề)
là thứ tìm ra lỗi, và tôi chỉ viết nó sau khi đã tình cờ chạy thử.

Hệ quả cụ thể: mọi test file của tầng tool cần một mục
`# ── đầu vào phải bị từ chối ──` và nó không được rỗng.

---

## 5. Đề xuất thứ tự

1. **#1 và #3** trước — rẻ nhất, chặn lớp nguy hiểm nhất (rò rỉ, đọc vô hạn).
2. **#2 + #11** cùng nhau — cùng cần một fixture báo cáo demo; xong hai cái này thì
   13 tool trần có lưới.
3. **#6 + quy tắc mục 4** — rẻ, và là thứ trực tiếp vá chỗ tôi làm non.
4. **#7, #4** — cần đo thật, nên đánh dấu `integration` chạy riêng.
5. **#8, #10** — nghiệp vụ, làm khi chạm vào vùng đó.

---

*Cơ sở dữ liệu của tài liệu: `coverage_audit` quét 36 `spec()`/`local()` trong
`backend/app/services/agent_flows/tools/packs/` đối chiếu với 1.454 test trong
`backend/tests/`. Các số đo token/ms lấy từ chú thích `MEASURED` trong chính source
và từ đo lại trên báo cáo 67 (70 biểu đồ) phiên này.*
