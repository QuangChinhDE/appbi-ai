# Agent Flow — 36 công cụ và cách dùng

> Trạng thái: `demo` @ `6b98478` · đo trên deployment local (dataset Olist 111, 184 biểu đồ)
> Mọi con số trong tài liệu này đều lấy bằng cách **gọi thật** vào hệ thống, không ước lượng.

Tài liệu này trả lời đúng ba câu: **có những tool gì**, **dùng tool nào cho câu hỏi nào**, và **vì sao flow của bạn trả lời chưa tốt**.

---

## 1. Đọc 3 phút — mô hình phải nắm

Một Agent Flow không "biết" báo cáo. Nó **chỉ biết những gì một tool vừa trả về trong lượt này**.
Vậy nên chất lượng câu trả lời = chất lượng chuỗi tool, không phải chất lượng prompt.

```
  câu hỏi
     │
     ▼
  ┌──────────────────────────────────────────────────┐
  │ 1. TÌM   biểu đồ / tài liệu nào liên quan?       │  pack discover, read
  │          → ra chart_id, doc_id                   │
  ├──────────────────────────────────────────────────┤
  │ 2. ĐO    lấy con số từ chart_id đó               │  pack measure, compare
  │          → ra số + tổng thật + thứ hạng          │  diagnose, project
  ├──────────────────────────────────────────────────┤
  │ 3. GIẢI  con số đó nghĩa là gì theo tài liệu     │  pack knowledge
  │          → ra định nghĩa, quy ước, loại trừ      │
  ├──────────────────────────────────────────────────┤
  │ 4. VIẾT  bước trả lời — KHÔNG có tool            │
  └──────────────────────────────────────────────────┘
```

**Luật vàng #1 — 20/36 tool bắt buộc phải có `chart_id` mới gọi được (22 tool nhắc tới `chart_id`, 2 trong đó là tuỳ chọn), và chỉ có 2 cách để có nó:**

| Cách | Dùng khi | Làm sao |
|---|---|---|
| **Được đưa** | flow Bot | có bước `report_read`, và prompt bước sau phải đọc `{{tên_biến}}` của nó |
| **Tự tìm** | flow Chat, hoặc Bot cần với ra ngoài báo cáo | cấp `search_business_assets` / `resolve_chart_candidates` / `list_charts` |

Thiếu **cả hai** → model phải *đoán* `chart_id`. Đo thật trên một flow 9 node: **7 lần gọi liên tiếp trả về `chart_out_of_scope`**, hết sạch ngân sách tool, và người xem được trả lời "báo cáo không có GMV" trên một báo cáo có GMV = 15.843.553,24. Thêm `{{ctx}}` vào 4 prompt đó → 0 lần lỗi, ra đúng số.
Hệ thống có cảnh báo sẵn cho lỗi này: `contract.py:1165-1207`.

**Luật vàng #2 — bước trả lời không nên có tool.**
Bước viết câu trả lời mà còn gọi được tool thì dễ đưa ra số chưa qua bước kiểm nào. Ngoại lệ duy nhất: flow chỉ có **đúng 1 bước** (không có bước nào trước để số đi qua) — lúc đó cảnh báo tự tắt (`contract.py:1149-1163`).

**Luật vàng #3 — cấp ít tool thôi.**
Mỗi tool được cấp là một schema đẩy vào prompt mỗi lượt. Cấp 20 tool cho một bước = model phải chọn giữa 20 thứ mỗi lần nghĩ. Các flow chạy tốt nhất đang đo được dùng **2–6 tool mỗi bước**.

---

## 2. Bảng 36 công cụ

Cột **Chat** = chạy được trên AI Chat (không có báo cáo) hay không.

Cách kiểm: dựng một `ToolContext` đúng hình dạng của Chat (`dashboard=None`, biểu đồ suy ra từ dataset đã gắn) rồi **gọi thật từng tool**. 26/31 tool nội bộ trả `ok`; 5 cái (`aggregate_chart_data`, `compare_segments`, `explain_change`, `smart_drilldown`, `correlate_charts`) chỉ trượt vì ca thử của tôi truyền tên cột bịa — chúng không phụ thuộc gì vào việc có báo cáo hay không. Một lỗi thật đã lộ ra và đã sửa: `recall_knowledge` trước đó hỏng cứng với `no dashboard scope for knowledge`.

### `discover` · Tìm đúng thứ cần dùng — *gọi TRƯỚC mọi tool cần `chart_id`*

| Tool | Trả lời câu kiểu | Tham số (bắt buộc **đậm**) | Giá | Chat |
|---|---|---|---|---|
| `search_business_assets` | "Báo cáo có gì về tỷ lệ giao đúng hẹn?" · "Mình có đo doanh thu theo danh mục không?" | **query**, types | rẻ | ✅ |
| `resolve_chart_candidates` | "Chỉ số này xem ở biểu đồ nào?" | metric, measure | rẻ | ⚠️ |

> ⚠️ **Bẫy đã đo được:** `resolve_chart_candidates` gọi bằng `metric` sẽ báo `metric 'GMV' is not defined` nếu chỉ số đó **chưa được khai trong Metrics Dictionary**. Deployment này chưa khai chỉ số nào → dùng `metric` là **luôn lỗi**. Gọi bằng `measure` thì chạy tốt (`{"measure":"gmv"}` → ok). Mô tả của tool lại đang hướng model về `metric` — đây là một trong các lý do flow "gọi tool mà không ra gì".

### `read` · Hiểu báo cáo

| Tool | Trả lời câu kiểu | Tham số | Giá | Chat |
|---|---|---|---|---|
| `list_charts` | "Báo cáo này có biểu đồ nào?" | query, with_row_counts, page, detail | rẻ | ✅ |
| `inspect_filters` | "Số liệu đang lọc theo gì?" | — | rẻ | ✅ (luôn rỗng) |
| `describe_time_coverage` | "Số liệu tính đến khi nào?" | chart_id | truy vấn | ✅ |
| `get_chart_glossary` | "Cột doanh thu ở đây tính thế nào?" | **chart_id** | rẻ | ✅ |
| `describe_semantic_model` | "GMV ở đây định nghĩa thế nào?" | query | rẻ | ✅ |

> `list_charts` có `query` — **luôn truyền**. Không truyền thì nó liệt kê cả báo cáo: đo trên dashboard 70 biểu đồ là ~15.600 token nhét vào prompt.

### `measure` · Lấy số — *ưu tiên nhóm tính-sẵn*

| Tool | Trả lời câu kiểu | Tham số | Giá | Chat |
|---|---|---|---|---|
| `rank_values` | "Danh mục nào cao nhất?" · "Top 5 khu vực" | **chart_id**, top_n, order, measure, dimension | truy vấn | ✅ |
| `total_measure` | "Tổng doanh thu bao nhiêu?" | **chart_id**, measure | truy vấn | ✅ |
| `share_of` | "Ngành làm đẹp chiếm bao nhiêu %?" | **chart_id**, **item**, measure, dimension | truy vấn | ✅ |
| `get_chart_summary` | "Biểu đồ này đang nói gì?" | **chart_id** | truy vấn | ✅ |
| `get_chart_data` | "Cho xem chi tiết từng dòng" | **chart_id**, top_n, sort, sort_by | truy vấn | ✅ |
| `aggregate_chart_data` | "Gộp doanh thu theo tháng" | **chart_id**, **group_by**, **aggregations**, filters… | truy vấn | ✅ |
| `compute` | "Tính tỉ lệ giữa hai số vừa đọc" | **expression**, **vars**, citations | rẻ | ✅ |

> **`rank_values` / `total_measure` / `share_of` tính trên TOÀN BỘ dòng — `get_chart_data` thì không.**
> Schema của `get_chart_data` ghi thẳng `Cap rows (max 50)` nên model luôn chỉ xin ≤50 dòng (`context.py:34` `MAX_TOP_N = 50`). Hỏi "cao nhất / top mấy" mà dùng nó là **sai kết quả một cách im lặng**: nó sắp xếp trong 50 dòng lấy được rồi trả lời như thể đó là toàn bộ. Không có lỗi, không có cảnh báo. Đây là nguyên nhân "trả lời chưa tốt" phổ biến nhất.

### `compare` · So sánh

| Tool | Trả lời câu kiểu | Tham số | Chat |
|---|---|---|---|
| `compare_to_target` | "Có đạt mục tiêu không? Còn thiếu bao nhiêu?" | **chart_id**, target, target_column, measure | ✅ |
| `compare_periods` | "Tháng này so tháng trước?" | **chart_id**, mode, period_a, period_b | ✅ |
| `compare_segments` | "Miền Bắc so miền Nam?" | **chart_id**, **dimension**, **segment_a**, **segment_b**, measure | ✅ |
| `segment_compare` | "Nhóm này có bất thường so với phần còn lại?" | **chart_id**, **value**, dimension | ✅ |

### `diagnose` · Tìm nguyên nhân — *đắt hơn nhóm lấy số*

| Tool | Trả lời câu kiểu | Tham số | Chat |
|---|---|---|---|
| `explain_change` | "Vì sao doanh thu giảm? Nhóm nào kéo xuống?" | **chart_id**, **breakdown**, **split_column**, **value_a**, **value_b** | ✅ |
| `detect_anomaly` | "Có gì bất thường không?" | **chart_id**, method, threshold | ✅ |
| `smart_drilldown` | "Xem chi tiết riêng nhóm này" | **chart_id**, **column**, **match**, op, top_n | ✅ |
| `correlate_charts` | "Hai chỉ số này có liên quan?" | **chart_a**, **chart_b**, **on** | ✅¹ |
| `describe_distribution` | "Doanh thu có tập trung vào vài khách?" | **chart_id** | ✅ |

¹ hai biểu đồ phải có **cột chung** để join, nếu không sẽ trả `query_failed`.

### `project` · Xu hướng & dự báo — *tất cả là phỏng đoán, phải nói rõ khi trả lời*

| Tool | Trả lời câu kiểu | Tham số | Chat |
|---|---|---|---|
| `project_to_period_end` | "Có kịp mục tiêu năm không? Còn phải bán bao nhiêu mỗi tháng?" | **chart_id**, **remaining_periods**, target | ✅ |
| `detect_seasonality` | "Doanh thu có theo mùa không?" | **chart_id** | ✅ |
| `analyze_trend` | "Xu hướng mấy tháng qua?" | **chart_id** | ✅ |
| `forecast_measure` | "Tháng tới dự kiến bao nhiêu?" | **chart_id**, horizon, method | ✅ |

> **Gọi `detect_seasonality` TRƯỚC khi tin `forecast_measure`.** Chiếu đường thẳng trên chuỗi có mùa vụ thì sai chắc chắn. Cả 4 tool này đều cần biểu đồ **có trục thời gian** — đưa biểu đồ KPI một số vào sẽ trả `not_applicable: chart has no time axis`.

### `knowledge` · Tri thức nội bộ

| Tool | Trả lời câu kiểu | Tham số | Chat |
|---|---|---|---|
| `explain_measurement` | "Vì sao chỉ số này không đạt? Loại trừ trường hợp nào?" | **measure**, status, actual, target, shortfall_pct | ✅ |
| `search_knowledge` | "Công ty mình định nghĩa GMV ra sao?" | **query**, limit | ✅ |
| `read_document` | "Cho tôi nội dung tài liệu quy tắc tính" | **doc_id** | ✅ |
| `recall_knowledge` | "Trước đây đã kết luận gì về nhóm khách này?" | query | ✅ (vừa sửa) |

> `explain_measurement` trả về **22.918 ký tự** trong lần đo — nặng nhất trong 36 tool. Nó đọc nguyên đoạn tài liệu. Cấp cho bước **chuyên tra định nghĩa**, đừng cấp cho bước trả lời.
> `read_document` chỉ đọc được tài liệu **đã gắn cho flow**; `doc_id` lạ sẽ trả `not_granted`.

### `external` · Ra ngoài AppBI — *chỉ chạy khi flow khai năng lực `web_search`*

| Tool | Trả lời câu kiểu | Tham số | Chat |
|---|---|---|---|
| `research_web` | "Benchmark tỉ lệ giao đúng hẹn TMĐT là bao nhiêu?" | **question**, **queries**, read_top | ⚠️ |
| `browse_ai_answer` | "Ngành SaaS B2B VN tăng bao nhiêu %/năm 2024?" | **question** | ⚠️ |
| `web_search` | "Ngành này trung bình bao nhiêu?" | **query**, max_results | ⚠️ |
| `fetch_url` | "Đọc giúp tôi trang này" | **url** | ⚠️ |
| `benchmark_compare` | "Tỉ lệ này so với thị trường thế nào?" | **chart_id**, **metric**, **query** | ⚠️ |

⚠️ = chạy được trên Chat **nếu** flow khai `web_search` trong Requirements (`direct_chat.py:219`). Không khai thì 5 tool này im lặng không dùng được.

---

## 3. Bot và Chat khác nhau ở đâu

|  | **Bot trên báo cáo** | **AI Chat** |
|---|---|---|
| Input nhận được | `dashboard_id` đang xem + filter của link + text | **chỉ text** |
| Người hỏi | ẩn danh, qua link công khai | đã đăng nhập |
| `report_read` | ✅ bắt buộc nên có | ❌ cấm (không có báo cáo để đọc) |
| Biểu đồ với tới được | biểu đồ của báo cáo đó **∩** link khai **∪** dataset flow đã gắn | **chỉ** biểu đồ từ dataset flow đã gắn |
| Cách lấy `chart_id` | được `report_read` đưa | **phải tự tìm** |
| Tool dùng được | đủ 36 | **31 tool không vướng gì với việc thiếu báo cáo** — 26 cái đã gọi thật thành công, 5 cái còn lại chưa dựng được ca thử vì cần tên cột thật. 5 tool `external` cần flow khai `web_search`. |
| Gán vào link | ✅ | ❌ bị chặn 409 |

**Một dataset gắn vào = 184 biểu đồ trải 8 báo cáo** (đo trên Olist 111). Một báo cáo chỉ có 70. Vì thế phạm vi tính theo **dataset**, không theo báo cáo — câu hỏi "doanh thu thế nào" không biết và không cần biết người ta vẽ nó ở báo cáo nào.

---

## 4. Bốn công thức dựng sẵn

### A. Bot hỏi đáp trên một báo cáo — *mặc định, dùng cho 80% trường hợp*

```
report_read (output_var: ctx)
   └─ Đọc: tóm tắt ✓  dữ liệu ✓  filter ✓
agent  "Trả lời"                          ← bước trả lời
   tools: rank_values, total_measure, share_of, compare_periods
   prompt: "...Dựa trên {{ctx}}..."       ← BẮT BUỘC có {{ctx}}
```
Thiếu `{{ctx}}` trong prompt là lỗi số 1. Builder có cảnh báo, đọc nó.

### B. Chat trả lời từ tài liệu + số — *flow Chat cơ bản*

```
agent  "Trả lời"
   gắn nguồn: 3 tài liệu + 1 dataset
   tools: search_business_assets, rank_values, search_knowledge
   prompt: "Nếu câu hỏi cần SỐ: dùng search_business_assets để tìm biểu đồ,
            lấy chart_id rồi gọi rank_values. Luôn nêu rõ số lấy từ biểu đồ nào.
            Nếu không tìm được biểu đồ nào, nói thẳng là chưa có số liệu."
```
Đây đúng là cấu hình đang chạy của `kb_chat_demo`. Đo thật: **2 lần gọi tool, 9,3 giây**, trả lời "Health & Beauty, 1.258.681,34 — lấy từ biểu đồ *Doanh thu theo danh mục · page-1*".

### C. Tách tra cứu khỏi trả lời — *khi câu trả lời hay bịa số*

```
agent  "Tra số"        tools: search_business_assets, rank_values, total_measure
                       output_var: so_lieu
agent  "Tra định nghĩa" tools: search_knowledge, explain_measurement
                       output_var: dinh_nghia
agent  "Viết trả lời"  KHÔNG tool          ← bước trả lời
                       prompt: "...{{so_lieu}}... {{dinh_nghia}}..."
```
Bước cuối không có tool nên **không thể** đưa ra số chưa đi qua hai bước trên.

### D. Điều phối khi câu hỏi đa dạng — *đắt hơn, dùng khi C không đủ*

```
report_read (ctx)
coordinate  "Điều phối"
   ├ chuyên gia "định nghĩa"  → agent: search_knowledge, explain_measurement
   ├ chuyên gia "số liệu"     → agent: rank_values, total_measure, compare_periods
   └ chuyên gia "nguyên nhân" → agent: explain_change, detect_anomaly
agent  "Gộp trả lời"  KHÔNG tool
```
Một agent đọc câu hỏi rồi chọn chuyên gia nào chạy. Đo trên `demo_olist_hoi_dap_3_tang`: **14–17 lần gọi tool, 16–24 giây** — đắt gấp 7 lần công thức B, chỉ dùng khi thật sự cần.

---

## 5. Triệu chứng → nguyên nhân → cách sửa

| Triệu chứng | Nguyên nhân thật | Sửa |
|---|---|---|
| "Tôi không lấy được thông tin X" trên báo cáo **có** X | bước được cấp tool cần `chart_id` nhưng không được đưa và không tự tìm được | thêm `{{ctx}}` vào prompt, **hoặc** cấp `search_business_assets` |
| Số "cao nhất" sai, không báo lỗi | dùng `get_chart_data` (giới hạn ~50 dòng) thay vì `rank_values` (toàn bộ dòng) | cấp `rank_values`, bỏ `get_chart_data` |
| Trả lời tự tin nhưng không có số nào | bước trả lời có tool nhưng không gọi, hoặc flow không gắn nguồn nào | xem cảnh báo trong builder; dùng **"Xem AI nhận được gì"** |
| Chậm 20–100 giây | quá nhiều tool được cấp, hoặc dùng `coordinate` cho câu hỏi đơn giản | giảm còn 2–6 tool/bước; đổi sang công thức B hoặc C |
| `metric 'X' is not defined` | gọi `resolve_chart_candidates` bằng `metric` mà chỉ số chưa khai trong Metrics Dictionary | dùng `measure` thay vì `metric` |
| `chart has no time axis` | đưa biểu đồ KPI vào tool nhóm `project` | tìm biểu đồ có trục thời gian trước |
| Flow không hiện trong AI Chat | flow đang là loại **Bot** | đổi loại ở chip cạnh tên flow trong builder |
| Không gán được flow vào link | flow đang là loại **Chat** | chọn flow loại Bot, hoặc đổi loại |

**Hai nút phải dùng trước khi kêu "trả lời chưa tốt":**
- **Test** (trên header builder) — chạy thật, hiện từng tool đã gọi, thời gian, số token. Flow Chat test được **không cần báo cáo**.
- **"Xem AI nhận được gì"** (trong bảng cấu hình bước AI) — hiện **nguyên văn** những gì bước đó đưa cho model, chưa gọi model nên không tốn gì.

---

## 6. Những chỗ còn yếu — nói thẳng

1. **Mô tả của `resolve_chart_candidates` hướng model về `metric`, mà `metric` chỉ chạy khi Metrics Dictionary có khai.** Deployment này chưa khai chỉ số nào nên tham số đó luôn lỗi. Seed của flow Chat đang cấp sẵn tool này. *Cần: sửa mô tả tool để ưu tiên `measure`.*
2. **`read_rows=False` trong hợp đồng của Chat không được thực thi ở đâu cả** (`direct_chat.py:220`). Nó chỉ gác node `report_read` (`data.py:120`) — mà Chat cấm node đó. Tức là một năng lực khai ra nhưng vô nghĩa. *Cần: hoặc thực thi ở tầng tool, hoặc bỏ khai.*
3. **`explain_measurement` trả 22.918 ký tự.** Dưới trần 25.000 token nên không bị chặn, nhưng đủ để nuốt phần lớn ngữ cảnh của một bước. *Cần: giới hạn riêng cho tool này.*
4. **Không có "công thức dựng sẵn" trong UI.** Tác giả phải tự đọc tài liệu này rồi gõ tay. *Cần: nút "dùng công thức" trong màn hình tạo flow.*
5. **Builder không dùng được ở bề ngang điện thoại.** Header đã sửa để không mất nút, nhưng canvas node-graph 400px thì vẫn không thao tác được.

---

## 7. Tra nhanh theo mã nguồn

| Muốn biết | Đọc file |
|---|---|
| Đăng ký tool, trần payload, cache | `backend/app/services/agent_flows/tools/registry.py` |
| Nhóm tool + câu hỏi mẫu (`answers_vi`) | `backend/app/services/agent_flows/tools/packs/*.py` |
| Cảnh báo khi dựng flow | `backend/app/services/agent_flows/contract.py:1103-1262` |
| Trần quyền của một lượt chạy | `backend/app/services/agent_flows/permissions.py:131` (`run_scope`), `:193` (`chart_scope`) |
| Ba đường vào: link / studio / chat | `backend/app/services/agent_flows/dispatch.py` |
| Luật riêng của AI Chat | `backend/app/services/agent_flows/direct_chat.py` |
| Prompt nền theo từng bề mặt | `backend/app/services/dashboard_ai_bot/thinking/prompts.py:25` (Bot) / `:52` (Chat) |
