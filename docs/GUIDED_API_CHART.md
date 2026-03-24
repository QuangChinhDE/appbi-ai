# GUIDED_API_CHART.md — Hướng dẫn tạo Chart & Dashboard qua API

> Tài liệu step-by-step cho AI Agent và Developer.
> Mỗi field bắt buộc đánh dấu ★. Mỗi bước có ✅ checkpoint để kiểm tra.
> Last updated: 2026-03-24

---

## Mục lục

1. [Bước 0 — Prerequisite: Xác thực & Thu thập dữ liệu cần thiết](#bước-0--prerequisite)
2. [Bước 1 — Tạo Chart](#bước-1--tạo-chart)
3. [Bước 2 — Kiểm tra Chart có Data](#bước-2--kiểm-tra-chart-có-data)
4. [Bước 3 — Tạo Dashboard + gắn Charts](#bước-3--tạo-dashboard--gắn-charts)
5. [Bước 4 — Cập nhật Layout Dashboard](#bước-4--cập-nhật-layout-dashboard)
6. [Tham khảo đầy đủ: Config theo từng Chart Type](#tham-khảo-config-theo-từng-chart-type)
7. [Tham khảo đầy đủ: Filter Operators](#tham-khảo-filter-operators)
8. [Tham khảo: Column Alias trong Response](#tham-khảo-column-alias-trong-response)
9. [Checklist trước khi tạo Chart](#checklist-trước-khi-tạo-chart)
10. [Bảng lỗi thường gặp & Cách khắc phục](#bảng-lỗi-thường-gặp--cách-khắc-phục)

---

## Bước 0 — Prerequisite

### 0.1 Lấy Token

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email": "admin@appbi.io", "password": "your-password"}
```

Response → lấy `access_token`, dùng cho mọi request sau:
```
Authorization: Bearer <access_token>
```

### 0.2 ★ Xác định `workspace_id` và `workspace_table_id`

**Đây là bước quan trọng nhất — phải biết chính xác table nào có column gì.**

```http
GET /api/v1/dataset-workspaces
```

→ Lấy danh sách workspaces. Ghi nhận `workspace.id` (dùng cho `config.workspace_id`).

```http
GET /api/v1/dataset-workspaces/{workspace_id}
```

→ Response chứa `tables[]` — mỗi table có:
- `id` → đây là `workspace_table_id` ★
- `display_name` → tên hiển thị
- `columns_cache.columns[]` → danh sách cột `{name, type}`
- `datasource_id` → datasource gốc
- `source_kind` → `"physical_table"` hoặc `"sql_query"`

### 0.3 ★ Xác định giá trị thực trong data

Trước khi dùng filter, **BẮT BUỘC** kiểm tra giá trị thực trong data (tránh sai giá trị filter).

```http
POST /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}/preview
Content-Type: application/json

{"limit": 50}
```

→ Trả về rows mẫu. Kiểm tra giá trị thực tế:
- `is_active` có thể là `"active"` / `"deactive"` (KHÔNG phải `"true"` / `"false"`)
- `is_sensitive` có thể là `""` / `"confidential"` / `"critical"` (KHÔNG phải boolean)

> ⚠️ **LỖI CỰC KỲ PHỔBIẾN**: Giả sử boolean column có giá trị `"true"/"false"` → results trả về 0 rows. **Luôn preview data trước.**

**✅ Checkpoint Bước 0:**
- [ ] Có `access_token`
- [ ] Biết `workspace_id` (số nguyên)
- [ ] Biết `workspace_table_id` cho mỗi table cần dùng
- [ ] Biết danh sách cột + kiểu dữ liệu của mỗi table
- [ ] Đã preview data để biết giá trị thực (đặc biệt cho filter)

---

## Bước 1 — Tạo Chart

### Endpoint

```http
POST /api/v1/charts
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body — Cấu trúc đầy đủ

```jsonc
{
  // ──── 4 trường ngoài (top-level) ────────────────────────
  "name":               "★ Tên chart (1-255 ký tự, unique)",
  "chart_type":         "★ BAR|LINE|PIE|KPI|STACKED_BAR|GROUPED_BAR|AREA|TABLE|SCATTER|TIME_SERIES|COMBO",
  "workspace_table_id": "★ ID của workspace table (số nguyên)",
  "description":        "Mô tả (optional)",

  // ──── config object ★ ───────────────────────────────────
  "config": {
    "workspace_id": "★ ID workspace cha (Explore UI cần để restore)",
    "chartType":    "★ PHẢI KHỚP VỚI chart_type ở trên (uppercase)",
    "roleConfig": {
      "dimension":       "Cột GROUP BY (x-axis) cho BAR/PIE/LINE/...",
      "timeField":       "Cột thời gian cho TIME_SERIES",
      "metrics":         [{"field": "col", "agg": "count"}],
      "breakdown":       "Cột breakdown cho STACKED_BAR/GROUPED_BAR/LINE/AREA",
      "scatterX":        "Cột X cho SCATTER",
      "scatterY":        "Cột Y cho SCATTER",
      "selectedColumns": ["col1","col2"]
    },
    "filters": []
  }
}
```

### ★ Trường bắt buộc tuyệt đối (thiếu = lỗi hoặc UI hỏng)

| # | Trường | Vị trí | Hậu quả nếu thiếu |
|---|--------|--------|--------------------|
| 1 | `name` ★ | top-level | 422 Validation Error |
| 2 | `chart_type` ★ | top-level | 422 Validation Error |
| 3 | `workspace_table_id` ★ | top-level | 422 "workspace_table_id must be provided" |
| 4 | `config` ★ | top-level | 422 Validation Error |
| 5 | `config.workspace_id` ★ | trong config | **Data vẫn chạy**, nhưng Explore UI không load được workspace → selector trống, không edit được chart |
| 6 | `config.chartType` ★ | trong config | **Data vẫn chạy**, nhưng Explore UI reset chart type về TABLE, mất visualization |
| 7 | `config.roleConfig` ★ | trong config | Data trả về `SELECT * LIMIT 1000` (raw, không aggregate) |
| 8 | `config.roleConfig.metrics` ★ | trong roleConfig | Nếu rỗng→ `pre_aggregated: false`, data raw không nhóm |

> **Quy tắc vàng**: Luôn truyền đủ 6 field: `name`, `chart_type`, `workspace_table_id`, `config.workspace_id`, `config.chartType`, `config.roleConfig`.

### ★ chart_type — Giá trị hợp lệ (UPPERCASE bắt buộc)

```
BAR          — Biểu đồ cột đứng
LINE         — Biểu đồ đường
AREA         — Biểu đồ vùng
PIE          — Biểu đồ tròn
KPI          — Thẻ số liệu (1 metric duy nhất)
GROUPED_BAR  — Cột nhóm (dimension + breakdown)
STACKED_BAR  — Cột xếp chồng (dimension + breakdown)
TABLE        — Bảng dữ liệu
SCATTER      — Biểu đồ phân tán (scatterX + scatterY)
TIME_SERIES  — Chuỗi thời gian (timeField + metrics)
COMBO        — Kết hợp (bar + line)
```

> ⚠️ **Lowercase sẽ bị 422**: `"bar"` ❌ → `"BAR"` ✅

### ★ Metric Config — Cấu trúc 1 metric

```json
{"field": "column_name", "agg": "count", "label": "Display Label"}
```

| Trường | Bắt buộc | Mô tả |
|--------|----------|-------|
| `field` ★ | Có | Tên cột trong table |
| `agg` ★ | Có | `count` · `sum` · `avg` · `min` · `max` · `count_distinct` |
| `label` | Không | Nhãn hiển thị UI (optional nhưng nên có) |

> ⚠️ `agg` là **lowercase** trong config: `"count"` ✅ (backend tự uppercase khi build SQL).

### Response 201

```json
{
  "id": 18,
  "name": "📊 Tổng Tables",
  "chart_type": "KPI",
  "workspace_table_id": 2,
  "config": { ... },
  "owner_id": "uuid",
  "user_permission": "full",
  "metadata": null,
  "parameters": [],
  "created_at": "...",
  "updated_at": "..."
}
```

→ Ghi nhận `id` ★ — cần cho gắn vào dashboard.

**✅ Checkpoint Bước 1:**
- [ ] Endpoint trả 201
- [ ] Response có `id` (chart_id)
- [ ] `config` chứa cả `workspace_id`, `chartType`, `roleConfig`, `filters`
- [ ] `chart_type` = uppercase

---

## Bước 2 — Kiểm tra Chart có Data

### Endpoint

```http
GET /api/v1/charts/{chart_id}/data
Authorization: Bearer <token>
```

### Response 200

```json
{
  "chart": { "id": 18, "name": "...", "chart_type": "BAR", "config": {...} },
  "data": [
    {"project_id": "base-datateam", "count__table_id": 439}
  ],
  "pre_aggregated": true
}
```

### ★ Điều kiện "đạt"

| Tiêu chí | Đạt | Không đạt |
|----------|-----|-----------|
| `data` | Array có ≥ 1 phần tử | `[]` rỗng |
| `pre_aggregated` | `true` (backend đã aggregate) | `false` (fallback raw, UI phải tự xử lý) |
| Column names | Dạng `{agg}__{field}` (vd: `count__table_id`) | Raw column names |

### Xử lý khi `data: []`

1. **Kiểm tra filter** — giá trị filter có khớp data thực? (Bước 0.3)
2. **Table chưa sync** — gọi `POST /datasources/{id}/sync` rồi đợi
3. **roleConfig thiếu metrics** — thêm ít nhất 1 metric
4. **workspace_table_id sai** — kiểm tra lại

**✅ Checkpoint Bước 2:**
- [ ] `data` có rows
- [ ] `pre_aggregated: true`
- [ ] Data hợp lý (giá trị không bất thường)

---

## Bước 3 — Tạo Dashboard + gắn Charts

### Cách 1: Tạo Dashboard trống → Add từng chart (2+ API calls)

#### 3a. Tạo Dashboard

```http
POST /api/v1/dashboards
Content-Type: application/json

{
  "name": "★ Tên dashboard",
  "description": "Mô tả (optional)",
  "filters_config": []
}
```

#### 3b. Add từng Chart

```http
POST /api/v1/dashboards/{dashboard_id}/charts
Content-Type: application/json

{
  "chart_id":    "★ chart ID từ bước 1",
  "layout": {
    "x": "★ vị trí cột (0-11)",
    "y": "★ vị trí hàng (≥0)",
    "w": "★ chiều rộng (1-12)",
    "h": "★ chiều cao (≥1)"
  }
}
```

### Cách 2: Tạo Dashboard + Charts inline (1 API call — KHUYẾN NGHỊ) ★

```http
POST /api/v1/dashboards
Content-Type: application/json

{
  "name":          "★ Tên dashboard",
  "description":   "Mô tả",
  "filters_config": [],
  "charts": [
    {
      "chart_id": 18,
      "layout": {"x": 0, "y": 0, "w": 4, "h": 3}
    },
    {
      "chart_id": 19,
      "layout": {"x": 4, "y": 0, "w": 4, "h": 3}
    }
  ]
}
```

> ★ Cách 2 tạo dashboard + gắn charts + layout trong **1 API call** — đảm bảo không sót chart.

### ★ Layout Grid System

```
┌─────────────────────────────────────────────────────┐
│  12 cột (0-11), mỗi hàng cao 80px                   │
│                                                      │
│  ┌─w=4──┐ ┌──w=4──┐ ┌──w=4──┐                      │
│  │ x=0  │ │ x=4   │ │ x=8   │  y=0, h=3 (240px)   │
│  │      │ │       │ │       │                        │
│  └──────┘ └───────┘ └───────┘                        │
│  ┌──────w=6────────┐ ┌──w=6──┐                      │
│  │ x=0             │ │ x=6   │  y=3, h=5 (400px)   │
│  │                 │ │       │                        │
│  └─────────────────┘ └───────┘                        │
│  ┌────────────w=12────────────┐                      │
│  │ x=0  (full width)         │  y=8, h=5            │
│  └───────────────────────────┘                        │
└─────────────────────────────────────────────────────┘
```

| Field | Range | Mô tả |
|-------|-------|-------|
| `x` ★ | 0–11 | Cột bắt đầu |
| `y` ★ | ≥ 0 | Hàng bắt đầu |
| `w` ★ | 1–12 | Chiều rộng (1 ô = 1/12 trang) |
| `h` ★ | ≥ 1 | Chiều cao (1 ô = 80px) |

**Layout gợi ý theo chart type:**

| Chart Type | Width `w` | Height `h` | Ghi chú |
|------------|-----------|------------|---------|
| KPI | 3–4 | 2–3 | Nhỏ gọn, xếp 3–4 KPI cùng hàng |
| PIE | 4–6 | 4–5 | Vuông, không quá rộng |
| BAR / LINE | 6–12 | 4–6 | Rộng hơn để thấy labels |
| GROUPED_BAR / STACKED_BAR | 6–12 | 5–6 | Cần không gian cho legend |
| TABLE | 8–12 | 5–8 | Rộng & cao để hiển thị nhiều hàng |
| SCATTER | 6–8 | 5–6 | Vuông |

**✅ Checkpoint Bước 3:**
- [ ] Dashboard status 201
- [ ] Response có `dashboard_charts` với đủ số chart
- [ ] Mỗi chart tile có `chart_id` và `layout` đúng

---

## Bước 4 — Cập nhật Layout Dashboard

> Chỉ cần khi drag-drop thay đổi vị trí sau khi đã tạo.

```http
PUT /api/v1/dashboards/{dashboard_id}/layout
Content-Type: application/json

{
  "chart_layouts": [
    {
      "id": "★ DashboardChart.id (NOT chart_id)",
      "layout": {"x": 0, "y": 0, "w": 6, "h": 4}
    }
  ]
}
```

> ⚠️ **LỖI PHỔBIẾN**: `id` ở đây là `DashboardChart.id` (join table row ID) — **KHÔNG PHẢI** `chart_id`.
> Lấy giá trị này từ `GET /dashboards/{id}` → `dashboard_charts[].id`.

---

## Tham khảo Config theo từng Chart Type

### KPI

```json
{
  "workspace_id": 1,
  "chartType": "KPI",
  "roleConfig": {
    "metrics": [{"field": "table_id", "agg": "count", "label": "Tổng Tables"}]
  },
  "filters": []
}
```

- **metrics** ★ — chính xác 1 metric
- **dimension** — KHÔNG dùng (KPI hiển thị 1 số duy nhất)
- Dùng `filters` để lọc subset (vd: chỉ đếm active)

### BAR

```json
{
  "workspace_id": 1,
  "chartType": "BAR",
  "roleConfig": {
    "dimension": "department",
    "metrics": [{"field": "table_id", "agg": "count", "label": "Số bảng"}]
  },
  "filters": []
}
```

- **dimension** ★ — cột làm trục X (GROUP BY)
- **metrics** ★ — giá trị trục Y

### LINE

```json
{
  "workspace_id": 1,
  "chartType": "LINE",
  "roleConfig": {
    "dimension": "month",
    "metrics": [{"field": "revenue", "agg": "sum", "label": "Doanh thu"}],
    "breakdown": "region"
  },
  "filters": []
}
```

- **dimension** ★ — trục X
- **metrics** ★ — trục Y
- **breakdown** — tạo nhiều đường (mỗi giá trị = 1 series)

### AREA

```json
{
  "workspace_id": 1,
  "chartType": "AREA",
  "roleConfig": {
    "dimension": "quarter",
    "metrics": [{"field": "sales", "agg": "sum"}],
    "breakdown": "category"
  },
  "filters": []
}
```

- Tương tự LINE nhưng tô vùng dưới đường.

### PIE

```json
{
  "workspace_id": 1,
  "chartType": "PIE",
  "roleConfig": {
    "dimension": "is_active",
    "metrics": [{"field": "table_id", "agg": "count", "label": "Số bảng"}]
  },
  "filters": []
}
```

- **dimension** ★ — cột phân loại (mỗi giá trị = 1 slice)
- **metrics** ★ — giá trị kích thước slice

### GROUPED_BAR

```json
{
  "workspace_id": 1,
  "chartType": "GROUPED_BAR",
  "roleConfig": {
    "dimension": "department",
    "metrics": [{"field": "table_id", "agg": "count", "label": "Số bảng"}],
    "breakdown": "is_active"
  },
  "filters": []
}
```

- **dimension** ★ — trục X
- **metrics** ★ — trục Y
- **breakdown** ★ — cột nhóm lại (mỗi giá trị = 1 cột con trong nhóm)

### STACKED_BAR

```json
{
  "workspace_id": 1,
  "chartType": "STACKED_BAR",
  "roleConfig": {
    "dimension": "dataset_id",
    "metrics": [{"field": "table_id", "agg": "count", "label": "Số bảng"}],
    "breakdown": "source_table"
  },
  "filters": []
}
```

- Tương tự GROUPED_BAR nhưng xếp chồng thay vì xếp cạnh.

### TABLE

```json
{
  "workspace_id": 1,
  "chartType": "TABLE",
  "roleConfig": {
    "selectedColumns": ["name", "department", "is_active", "last_update"]
  },
  "filters": []
}
```

- **selectedColumns** — cột hiển thị (bỏ qua = hiển thị tất cả)
- KHÔNG cần metrics/dimension (TABLE hiển thị raw rows, max 500 rows)

### SCATTER

```json
{
  "workspace_id": 1,
  "chartType": "SCATTER",
  "roleConfig": {
    "scatterX": "revenue",
    "scatterY": "cost"
  },
  "filters": []
}
```

- **scatterX** ★ — cột trục X
- **scatterY** ★ — cột trục Y
- Raw points, max 5000 rows

### TIME_SERIES

```json
{
  "workspace_id": 1,
  "chartType": "TIME_SERIES",
  "roleConfig": {
    "timeField": "created_at",
    "metrics": [{"field": "revenue", "agg": "sum", "label": "Doanh thu"}],
    "breakdown": "region"
  },
  "filters": []
}
```

- **timeField** ★ — cột date/time (dùng thay `dimension`)
- **metrics** ★ — giá trị trục Y

---

## Tham khảo Filter Operators

### Cấu trúc 1 filter

```json
{"field": "column_name", "operator": "eq", "value": "some_value"}
```

### Bảng operators

| Operator | SQL tương đương | Kiểu `value` | Ví dụ |
|----------|-----------------|--------------|-------|
| `eq` | `= value` | string/number | `{"field":"status","operator":"eq","value":"active"}` |
| `neq` | `!= value` | string/number | `{"field":"type","operator":"neq","value":""}` |
| `gt` | `> value` | number | `{"field":"amount","operator":"gt","value":1000}` |
| `gte` | `>= value` | number | `{"field":"qty","operator":"gte","value":10}` |
| `lt` | `< value` | number | `{"field":"age","operator":"lt","value":30}` |
| `lte` | `<= value` | number | `{"field":"score","operator":"lte","value":100}` |
| `in` | `IN (v1, v2)` | **array** | `{"field":"dept","operator":"in","value":["Sales","IT"]}` |
| `not_in` | `NOT IN (v1, v2)` | **array** | `{"field":"status","operator":"not_in","value":["deleted"]}` |
| `contains` | `LIKE '%v%'` | string | `{"field":"name","operator":"contains","value":"test"}` |
| `is_null` | `IS NULL` | không cần value | `{"field":"email","operator":"is_null"}` |
| `is_not_null` | `IS NOT NULL` | không cần value | `{"field":"phone","operator":"is_not_null"}` |

> ⚠️ **"eq" ≠ "="**. Chart filters dùng `eq/neq/gt/...` (dạng từ). Execute endpoint (`/tables/{id}/execute`) dùng `=/!=/>/...` (dạng SQL). **Không lẫn lộn.**

---

## Tham khảo: Column Alias trong Response

Khi `pre_aggregated: true`, tên cột trong `data` được tự động đặt tên:

```
{agg}__{field}
```

| Metric Config | Tên cột Response |
|---------------|-----------------|
| `{"field": "revenue", "agg": "sum"}` | `sum__revenue` |
| `{"field": "table_id", "agg": "count"}` | `count__table_id` |
| `{"field": "price", "agg": "avg"}` | `avg__price` |
| `{"field": "qty", "agg": "min"}` | `min__qty` |
| `{"field": "qty", "agg": "max"}` | `max__qty` |
| `{"field": "user_id", "agg": "count_distinct"}` | `count_distinct__user_id` |

Cột `dimension` và `breakdown` giữ nguyên tên gốc.

---

## Row Limits theo Chart Type

| Chart Type | Max Rows | Lý do |
|------------|----------|-------|
| TABLE | 500 | Tránh payload HTTP quá lớn |
| SCATTER | 5,000 | Raw points |
| KPI, BAR, LINE, PIE, ... | Không giới hạn | GROUP BY → kết quả nhỏ |
| Live fallback (chưa sync) | 1,000 | Giới hạn an toàn |

---

## Checklist trước khi tạo Chart

Dùng checklist này cho **MỖI chart** trước khi gọi POST:

```
□ 1. workspace_table_id đúng? (GET /dataset-workspaces/{ws_id})
□ 2. Column names đúng chính tả? (kiểm tra columns_cache)
□ 3. chart_type UPPERCASE? (BAR, không phải bar)
□ 4. config có workspace_id? (phải là số nguyên, ID workspace cha)
□ 5. config có chartType? (phải khớp chart_type ngoài, uppercase)
□ 6. config có roleConfig? (bắt buộc cho mọi chart)
□ 7. roleConfig.metrics có ít nhất 1 metric? (trừ TABLE/SCATTER)
□ 8. Mỗi metric có field + agg?
□ 9. Filter values khớp data thực? (đã preview ở Bước 0.3)
□ 10. Chart name unique? (không trùng chart khác)
```

---

## Bảng lỗi thường gặp & Cách khắc phục

| # | Lỗi | Status | Nguyên nhân | Fix |
|---|------|--------|-------------|-----|
| 1 | `422 Unprocessable Entity` | 422 | `chart_type` lowercase hoặc sai giá trị | Dùng UPPERCASE: `"BAR"`, `"KPI"`, ... |
| 2 | `422 workspace_table_id must be provided` | 422 | Thiếu `workspace_table_id` | Thêm trường `workspace_table_id` với ID table hợp lệ |
| 3 | `400 Workspace table not found` | 400 | `workspace_table_id` sai | Kiểm tra `GET /dataset-workspaces/{ws_id}` lấy ID đúng |
| 4 | `400 Chart name already exists` | 400 | Tên chart trùng | Đổi tên hoặc xoá chart cũ trước |
| 5 | Data trả về `[]` rỗng | 200 | Filter value sai | Preview data thực (Bước 0.3), sửa filter |
| 6 | Data trả về `[]` rỗng | 200 | Table chưa sync DuckDB | Gọi `POST /datasources/{id}/sync` rồi đợi |
| 7 | `pre_aggregated: false` | 200 | `roleConfig.metrics` rỗng | Thêm ít nhất 1 metric vào `metrics[]` |
| 8 | Explore UI trống, không edit được | — | Thiếu `config.workspace_id` | Thêm `"workspace_id": <ws_id>` trong config |
| 9 | Explore UI reset chart type về TABLE | — | Thiếu `config.chartType` | Thêm `"chartType": "BAR"` (khớp chart_type) |
| 10 | Dashboard layout PUT 422 | 422 | Dùng `chart_id` thay vì `DashboardChart.id` | Lấy `dashboard_charts[].id` từ GET dashboard |
| 11 | `403 Forbidden` | 403 | User thiếu quyền `explore_charts >= edit` | Cấp quyền qua `PUT /permissions/{user_id}` |
| 12 | `409 chart is used in dashboards` | 409 | Xoá chart đang gắn dashboard | Xoá chart khỏi dashboard trước (`DELETE /dashboards/{id}/charts/{chart_id}`) |

---

## Ví dụ hoàn chỉnh: Tạo 3 Charts + 1 Dashboard

```python
import requests

BASE = "http://localhost:8000/api/v1"
r = requests.post(f"{BASE}/auth/login",
    json={"email": "admin@appbi.io", "password": "123456"})
TOKEN = r.json()["access_token"]
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

WORKSPACE_ID = 1    # ★ workspace "DE"
TABLE_ID     = 2    # ★ workspace_table "Data Warehouse"

# ── Step 0.3: Preview data để biết giá trị thực ──────────
preview = requests.post(f"{BASE}/dataset-workspaces/{WORKSPACE_ID}/tables/{TABLE_ID}/preview",
    headers=H, json={"limit": 10}).json()
# Xác nhận: is_active = "active"|"deactive", is_sensitive = ""|"confidential"|"critical"

# ── Step 1: Tạo Charts ───────────────────────────────────
charts = []

def make_chart(name, chart_type, table_id, role_config, filters=None):
    config = {
        "workspace_id": WORKSPACE_ID,     # ★ Bắt buộc cho Explore UI
        "chartType":    chart_type,        # ★ Bắt buộc, KHỚP chart_type
        "roleConfig":   role_config,       # ★ Bắt buộc
        "filters":      filters or [],
    }
    r = requests.post(f"{BASE}/charts", headers=H, json={
        "name":               name,              # ★
        "chart_type":         chart_type,         # ★ UPPERCASE
        "workspace_table_id": table_id,           # ★
        "config":             config,             # ★
    })
    assert r.status_code == 201, f"FAIL {name}: {r.status_code} {r.text}"
    cid = r.json()["id"]

    # ── Step 2: Verify data ──
    data_r = requests.get(f"{BASE}/charts/{cid}/data", headers=H).json()
    assert len(data_r["data"]) > 0, f"Chart {cid} has no data!"
    assert data_r["pre_aggregated"] == True, f"Chart {cid} not pre-aggregated"

    return cid

c1 = make_chart("📊 Tổng Tables", "KPI", TABLE_ID,
    role_config={"metrics": [{"field": "table_id", "agg": "count", "label": "Total"}]})
charts.append((c1, {"x":0,"y":0,"w":4,"h":3}))

c2 = make_chart("✅ Active Tables", "KPI", TABLE_ID,
    role_config={"metrics": [{"field": "table_id", "agg": "count", "label": "Active"}]},
    filters=[{"field": "is_active", "operator": "eq", "value": "active"}])  # ★ giá trị thực!
charts.append((c2, {"x":4,"y":0,"w":4,"h":3}))

c3 = make_chart("📅 Tables by Dept", "BAR", TABLE_ID,
    role_config={
        "dimension": "department",
        "metrics": [{"field": "table_id", "agg": "count", "label": "Count"}]
    })
charts.append((c3, {"x":0,"y":3,"w":12,"h":5}))

# ── Step 3: Tạo Dashboard + gắn charts (1 call) ─────────
r = requests.post(f"{BASE}/dashboards", headers=H, json={
    "name":          "My Dashboard",            # ★
    "description":   "Overview dashboard",
    "filters_config": [],
    "charts": [                                  # ★ inline charts
        {"chart_id": cid, "layout": layout}
        for cid, layout in charts
    ],
})
assert r.status_code == 201
dash = r.json()
print(f"✅ Dashboard [{dash['id']}] with {len(dash['dashboard_charts'])} charts")
print(f"Open → http://localhost:3000/dashboards/{dash['id']}")
```

---

## Quick Reference Card

```
POST /charts
├── name ★                       "Tên chart" (unique, 1-255 chars)
├── chart_type ★                  "BAR" (UPPERCASE)
├── workspace_table_id ★          2 (int, phải tồn tại)
├── description                   "Mô tả" (optional)
└── config ★
    ├── workspace_id ★            1 (int, ID workspace cha)
    ├── chartType ★               "BAR" (KHỚP chart_type, UPPERCASE)
    ├── roleConfig ★
    │   ├── dimension             "department" (GROUP BY column)
    │   ├── timeField             "created_at" (TIME_SERIES only)
    │   ├── metrics ★             [{field, agg, label}]
    │   ├── breakdown             "is_active" (GROUPED/STACKED/LINE/AREA)
    │   ├── scatterX              "revenue" (SCATTER only)
    │   ├── scatterY              "cost" (SCATTER only)
    │   └── selectedColumns       ["col1","col2"] (TABLE only)
    └── filters                   [{field, operator, value}]
```
