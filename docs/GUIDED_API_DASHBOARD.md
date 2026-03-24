# GUIDED_API_DASHBOARD.md — Hướng dẫn đầy đủ Dashboard API

> Tài liệu step-by-step cho AI Agent và Developer.
> Mỗi field bắt buộc đánh dấu ★. Mỗi bước có ✅ checkpoint để kiểm tra.
> Tài liệu đồng hành với `GUIDED_API_CHART.md` — đọc Chart guide trước khi đọc tài liệu này.
> Last updated: 2026-03-24

---

## Mục lục

1. [Tổng quan Dashboard](#tổng-quan-dashboard)
2. [Bước 0 — Prerequisite](#bước-0--prerequisite)
3. [Bước 1 — Tạo Dashboard](#bước-1--tạo-dashboard)
4. [Bước 2 — Thêm Chart vào Dashboard](#bước-2--thêm-chart-vào-dashboard)
5. [Bước 3 — Cập nhật Layout](#bước-3--cập-nhật-layout)
6. [Bước 4 — Cập nhật thông tin Dashboard](#bước-4--cập-nhật-thông-tin-dashboard)
7. [Bước 5 — Xóa Chart khỏi Dashboard / Xóa Dashboard](#bước-5--xóa-chart-khỏi-dashboard--xóa-dashboard)
8. [Bước 6 — Xác nhận kết quả](#bước-6--xác-nhận-kết-quả)
9. [Tham khảo: Grid Layout System](#tham-khảo-grid-layout-system)
10. [Tham khảo: Filters Config](#tham-khảo-filters-config)
11. [Tham khảo: Tất cả Endpoints](#tham-khảo-tất-cả-endpoints)
12. [Tham khảo: Schemas đầy đủ](#tham-khảo-schemas-đầy-đủ)
13. [Bảng lỗi thường gặp & Cách khắc phục](#bảng-lỗi-thường-gặp--cách-khắc-phục)
14. [Ví dụ Python hoàn chỉnh](#ví-dụ-python-hoàn-chỉnh)
15. [Quick Reference Card](#quick-reference-card)

---

## Tổng quan Dashboard

### Data Model

```
Dashboard (grid chứa các chart)
  └── DashboardChart (join table — liên kết chart → dashboard + layout)
        └── Chart (visualization đã tạo sẵn)
```

- **Dashboard**: Container chứa nhiều charts, hiển thị dạng grid 12 cột.
- **DashboardChart**: Bảng trung gian (join table) — chứa `layout` (vị trí x, y, w, h) và `parameters`.
- **Chart**: Phải tạo chart TRƯỚC, rồi mới thêm vào dashboard.

### ⚠️ Phân biệt quan trọng: `DashboardChart.id` vs `chart_id`

| ID | Là gì | Dùng ở đâu |
|----|-------|-------------|
| `chart_id` | ID của Chart trong bảng `charts` | `POST /charts`, `POST /dashboards/{id}/charts`, `DELETE /dashboards/{id}/charts/{chart_id}` |
| `DashboardChart.id` | ID của dòng trong bảng join `dashboard_charts` | `PUT /dashboards/{id}/layout` (trong `chart_layouts[].id`) |

> ⚠️ **LỖI NGHIÊM TRỌNG NHẤT**: Dùng `chart_id` thay vì `DashboardChart.id` khi PUT layout → Layout không cập nhật hoặc cập nhật sai chart. **Luôn dùng `DashboardChart.id` từ response `dashboard_charts[].id`.**

### Hai cách tạo Dashboard + Charts

| Cách | Mô tả | Khi nào dùng |
|------|--------|---------------|
| **Inline (Khuyến nghị)** | `POST /dashboards/` với `charts[]` array | Tạo dashboard mới + gắn ngay charts |
| **Từng bước** | `POST /dashboards/` trống → `POST /dashboards/{id}/charts` từng chart | Thêm chart vào dashboard đã tồn tại |

---

## Bước 0 — Prerequisite

### 0.1 Xác thực (Token)

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email": "admin@appbi.io", "password": "your-password"}
```

Response → `access_token`. Dùng cho mọi request:
```
Authorization: Bearer <access_token>
```

### 0.2 ★ Tạo Charts trước

Dashboard không tạo chart mới — nó chỉ **gắn chart đã có** vào grid.

→ Đọc `GUIDED_API_CHART.md` để tạo charts trước.

Sau khi tạo, ghi nhận danh sách `chart_id` để dùng ở bước sau.

```http
GET /api/v1/charts
```

→ Lấy danh sách charts đã tạo. Ghi nhận `id` của mỗi chart cần đưa vào dashboard.

### 0.3 Permission cần thiết

| Hành động | Module Permission tối thiểu |
|-----------|----------------------------|
| Xem danh sách dashboards | `dashboards >= view` |
| Tạo / sửa dashboard | `dashboards >= edit` |
| Xóa dashboard | `dashboards = full` |
| Thêm / xóa chart trong dashboard | `dashboards >= edit` |
| Cập nhật layout | `dashboards >= edit` |

**✅ Checkpoint Bước 0:**
- [ ] Có `access_token`
- [ ] Đã tạo tất cả charts cần thiết → có danh sách `chart_id`
- [ ] User có permission `dashboards >= edit`

---

## Bước 1 — Tạo Dashboard

### Cách 1: Inline Charts (Khuyến nghị — 1 API call)

```http
POST /api/v1/dashboards
Content-Type: application/json
Authorization: Bearer <token>
```

```jsonc
{
  "name": "Sales Dashboard",          // ★ Bắt buộc, unique, 1-255 ký tự
  "description": "Monthly overview",  // Tùy chọn
  "filters_config": [],               // Tùy chọn — xem mục Filters Config
  "charts": [                         // ★ Mảng charts kèm layout
    {
      "chart_id": 1,                  // ★ ID chart đã tạo
      "layout": {                     // ★ Vị trí trên grid
        "x": 0,                       // ★ Cột bắt đầu (0-11)
        "y": 0,                       // ★ Hàng bắt đầu (≥ 0)
        "w": 6,                       // ★ Độ rộng (1-12 cột)
        "h": 4                        // ★ Chiều cao (≥ 1 row)
      },
      "parameters": {}                // Tùy chọn — runtime params
    },
    {
      "chart_id": 2,
      "layout": {"x": 6, "y": 0, "w": 6, "h": 4},
      "parameters": {}
    },
    {
      "chart_id": 3,
      "layout": {"x": 0, "y": 4, "w": 12, "h": 5},
      "parameters": {}
    }
  ]
}
```

**Response 201:**

```jsonc
{
  "id": 1,                            // Dashboard ID
  "name": "Sales Dashboard",
  "description": "Monthly overview",
  "owner_id": "uuid-string",
  "user_permission": "full",
  "filters_config": [],
  "dashboard_charts": [               // Mảng DashboardChart (join table)
    {
      "id": 10,                        // ← DashboardChart.id (dùng cho layout PUT)
      "chart_id": 1,                   // ← Chart.id gốc
      "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
      "parameters": {},
      "chart": {                       // Full chart object (eager loaded)
        "id": 1,
        "name": "Revenue KPI",
        "chart_type": "KPI",
        // ... đầy đủ chart fields
      }
    },
    // ...
  ],
  "created_at": "2026-03-24T00:00:00Z",
  "updated_at": "2026-03-24T00:00:00Z"
}
```

### Cách 2: Tạo Dashboard trống → thêm chart sau

```http
POST /api/v1/dashboards
Content-Type: application/json

{
  "name": "Sales Dashboard",
  "description": "Monthly overview"
}
```

→ Response 201: Dashboard trống (không có `dashboard_charts`).

Sau đó dùng **Bước 2** để thêm chart từng cái.

### Validation khi tạo

| Kiểm tra | Lỗi nếu vi phạm |
|----------|-----------------|
| `name` phải unique | 409 Conflict |
| `name` 1-255 ký tự | 422 Unprocessable |
| Tất cả `chart_id` trong `charts[]` phải tồn tại | 400 Bad Request |

**✅ Checkpoint Bước 1:**
- [ ] Nhận response 201 với `id` dashboard
- [ ] `dashboard_charts` chứa đúng số lượng charts (nếu inline)
- [ ] Ghi nhận `dashboard.id` và mỗi `dashboard_charts[].id` (DashboardChart ID)

---

## Bước 2 — Thêm Chart vào Dashboard

> Dùng khi cần thêm chart vào dashboard ĐÃ TỒN TẠI. Nếu đã dùng Cách 1 (inline), bỏ qua bước này.

### Endpoint

```http
POST /api/v1/dashboards/{dashboard_id}/charts
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "chart_id": 5,                      // ★ ID chart đã tạo
  "layout": {                         // ★ Vị trí trên grid
    "x": 0,                           // ★ Cột (0-11)
    "y": 8,                           // ★ Hàng (≥ 0) — đặt sau charts hiện tại
    "w": 6,                           // ★ Rộng (1-12)
    "h": 4                            // ★ Cao (≥ 1)
  },
  "parameters": {                     // Tùy chọn: runtime parameter values
    "min_revenue": "1000"
  }
}
```

### Response 200

→ Trả về **toàn bộ dashboard** (bao gồm tất cả `dashboard_charts`). Từ response này lấy `DashboardChart.id` mới.

### Validation

| Kiểm tra | Lỗi nếu vi phạm |
|----------|-----------------|
| `chart_id` phải tồn tại | 400 Bad Request |
| Chart chưa có trong dashboard | 400 Bad Request ("Chart already in dashboard") |

> ⚠️ Mỗi chart chỉ có thể xuất hiện **1 lần** trong 1 dashboard. Muốn thêm chart giống nhau → tạo copy bằng `POST /charts`.

**✅ Checkpoint Bước 2:**
- [ ] Response 200 chứa chart mới trong `dashboard_charts[]`
- [ ] Tổng số `dashboard_charts` tăng lên đúng

---

## Bước 3 — Cập nhật Layout

> Dùng khi cần move/resize charts trên grid (drag-and-drop). Thường dùng sau khi thêm charts xong.

### Endpoint

```http
PUT /api/v1/dashboards/{dashboard_id}/layout
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "chart_layouts": [                  // ★ Mảng layout updates
    {
      "id": 10,                        // ★ DashboardChart.id (KHÔNG phải chart_id!)
      "layout": {
        "x": 0,
        "y": 0,
        "w": 4,
        "h": 3
      }
    },
    {
      "id": 11,                        // ★ DashboardChart.id
      "layout": {
        "x": 4,
        "y": 0,
        "w": 4,
        "h": 3
      }
    },
    {
      "id": 12,
      "layout": {
        "x": 8,
        "y": 0,
        "w": 4,
        "h": 3
      }
    }
  ]
}
```

### ⚠️ Quy tắc quan trọng

1. **`id` trong `chart_layouts` = `DashboardChart.id`** (lấy từ `dashboard_charts[].id` trong response GET/POST)
2. **KHÔNG dùng `chart_id`** — sẽ cập nhật sai hoặc không tìm thấy
3. Có thể cập nhật layout cho **một phần hoặc tất cả** charts
4. Frontend sẽ tự tính toán tránh overlap, nhưng API không validate overlap

### Response 200

→ Dashboard đầy đủ với layout đã cập nhật.

**✅ Checkpoint Bước 3:**
- [ ] Response 200 chứa layout mới cho từng chart
- [ ] Kiểm tra `dashboard_charts[].layout` đúng giá trị đã gửi

---

## Bước 4 — Cập nhật thông tin Dashboard

> Sửa name / description / filters_config.

### Endpoint

```http
PUT /api/v1/dashboards/{dashboard_id}
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "name": "Updated Dashboard Name",   // Tùy chọn
  "description": "New description",   // Tùy chọn
  "filters_config": [                 // Tùy chọn — xem mục Filters Config
    {
      "id": "f1",
      "field": "region",
      "operator": "eq",
      "value": "APAC"
    }
  ]
}
```

> Chỉ gửi fields cần thay đổi. Fields không gửi → giữ nguyên.

### Validation

| Kiểm tra | Lỗi nếu vi phạm |
|----------|-----------------|
| `name` phải unique (nếu thay đổi) | 409 Conflict |
| Dashboard phải tồn tại | 404 Not Found |
| Permission `dashboards >= edit` | 403 Forbidden |

---

## Bước 5 — Xóa Chart khỏi Dashboard / Xóa Dashboard

### 5.1 Xóa Chart khỏi Dashboard

```http
DELETE /api/v1/dashboards/{dashboard_id}/charts/{chart_id}
Authorization: Bearer <token>
```

- Dùng `chart_id` (Chart.id gốc, KHÔNG phải DashboardChart.id)
- Chỉ xóa dòng trong bảng join `dashboard_charts` — **Chart gốc KHÔNG bị xóa**
- Response 200: Dashboard đầy đủ (không còn chart đã xóa)

### 5.2 Xóa Dashboard

```http
DELETE /api/v1/dashboards/{dashboard_id}
Authorization: Bearer <token>
```

- Cần permission `dashboards = full`
- Cascade xóa tất cả `dashboard_charts` (join table rows)
- **Charts gốc KHÔNG bị xóa** — chúng vẫn tồn tại độc lập
- Response 204 No Content

### ⚠️ Thứ tự xóa khi cleanup

Nếu muốn xóa cả dashboard + charts:

```
1. DELETE /dashboards/{id}          ← xóa dashboard + join rows
2. DELETE /charts/{chart_id}        ← xóa từng chart (sau khi đã xóa dashboard)
```

> Nếu xóa chart khi nó vẫn còn trong dashboard → **409 Conflict**. Phải remove chart khỏi dashboard trước hoặc xóa dashboard trước.

---

## Bước 6 — Xác nhận kết quả

### 6.1 Lấy Dashboard đầy đủ

```http
GET /api/v1/dashboards/{dashboard_id}
Authorization: Bearer <token>
```

### 6.2 Checklist xác nhận

- [ ] `dashboard.name` đúng
- [ ] `dashboard_charts` đủ số lượng charts
- [ ] Mỗi `dashboard_chart`:
  - [ ] `chart_id` đúng
  - [ ] `layout.x` + `layout.w` ≤ 12 (không tràn grid)
  - [ ] `layout.y` ≥ 0, `layout.h` ≥ 1
  - [ ] `chart` object có đầy đủ data (name, chart_type, config)

### 6.3 Kiểm tra trên Frontend

1. Truy cập `http://localhost:3000/dashboards/{dashboard_id}`
2. Kiểm tra layout hiển thị đúng
3. Mỗi chart tile hiển thị data (không bị blank/error)
4. Drag-and-drop hoạt động

---

## Tham khảo: Grid Layout System

### Cấu trúc Grid

```
    Col 0   Col 1   Col 2   Col 3   Col 4   Col 5   Col 6   Col 7   Col 8   Col 9   Col 10  Col 11
   ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
R0 │                   Chart A (w=6)                │                   Chart B (w=6)                │
   │                   x=0, y=0                     │                   x=6, y=0                     │
   │                   h=4 (320px)                  │                   h=4 (320px)                  │
R3 │                                                │                                                │
   ├────────────────────────────────────────────────────────────────────────────────────────────────────┤
R4 │                                        Chart C (w=12, full width)                                │
   │                                        x=0, y=4, h=5 (400px)                                    │
R8 │                                                                                                  │
   ├───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┤
R9 │           Chart D (w=4)        │           Chart E (w=4)        │           Chart F (w=4)        │
   │           x=0, y=9             │           x=4, y=9             │           x=8, y=9             │
   │           h=3 (240px)          │           h=3 (240px)          │           h=3 (240px)          │
   └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
```

### Layout fields

| Field | Kiểu | Bắt buộc | Phạm vi | Mô tả |
|-------|------|----------|---------|-------|
| `x` | int | ★ | 0-11 | Cột bắt đầu |
| `y` | int | ★ | ≥ 0 | Hàng bắt đầu (đơn vị row, mỗi row ≈ 80px) |
| `w` | int | ★ | 1-12 | Độ rộng (số cột) |
| `h` | int | ★ | ≥ 1 | Chiều cao (số row) |
| `i` | str | | | Identifier cho react-grid-layout (tự tạo nếu ko gửi) |
| `minW` | int | | 1-12 | Chiều rộng tối thiểu |
| `maxW` | int | | 1-12 | Chiều rộng tối đa |
| `minH` | int | | ≥ 1 | Chiều cao tối thiểu |
| `maxH` | int | | ≥ 1 | Chiều cao tối đa |
| `static` | bool | | | `true` = không cho drag/resize |

### Layout Templates phổ biến

**2 cột đều:**
```python
[
  {"x": 0, "y": row, "w": 6, "h": 4},  # Trái
  {"x": 6, "y": row, "w": 6, "h": 4},  # Phải
]
```

**3 cột đều:**
```python
[
  {"x": 0, "y": row, "w": 4, "h": 3},  # Trái
  {"x": 4, "y": row, "w": 4, "h": 3},  # Giữa
  {"x": 8, "y": row, "w": 4, "h": 3},  # Phải
]
```

**4 KPI cards hàng ngang:**
```python
[
  {"x": 0, "y": row, "w": 3, "h": 2},
  {"x": 3, "y": row, "w": 3, "h": 2},
  {"x": 6, "y": row, "w": 3, "h": 2},
  {"x": 9, "y": row, "w": 3, "h": 2},
]
```

**Full width:**
```python
{"x": 0, "y": row, "w": 12, "h": 5}
```

**1/3 + 2/3:**
```python
[
  {"x": 0, "y": row, "w": 4, "h": 4},  # 1/3
  {"x": 4, "y": row, "w": 8, "h": 4},  # 2/3
]
```

### Quy tắc bố trí

1. **`x + w ≤ 12`**: Không tràn ngoài grid
2. **Tránh overlap**: Nếu 2 charts cùng vị trí, frontend sẽ tự đẩy xuống
3. **`y` tự động**: Frontend có thể auto-compact, đẩy charts lên nếu có khoảng trống
4. **Chiều cao đề xuất theo chart type:**

| Chart Type | `h` đề xuất | Lý do |
|------------|-------------|-------|
| KPI | 2-3 | Chỉ hiển thị 1 số lớn |
| BAR, LINE, AREA | 4-5 | Cần không gian cho axis + labels |
| PIE | 3-4 | Hình tròn, không cần quá cao |
| TABLE | 5-8 | Nhiều rows, cần chiều cao |
| GROUPED_BAR, STACKED_BAR | 4-5 | Tương tự BAR |
| SCATTER | 4-5 | X-Y plot |
| TIME_SERIES | 4-6 | Timeline dài |
| COMBO | 5-6 | Nhiều series chồng nhau |

---

## Tham khảo: Filters Config

Dashboard hỗ trợ `filters_config` — bộ lọc client-side áp dụng cho tất cả charts trong dashboard.

### Cấu trúc

```jsonc
{
  "filters_config": [
    {
      "id": "f1",                      // ID unique trong dashboard
      "field": "region",               // Tên cột để lọc
      "operator": "eq",                // Toán tử (eq, neq, in, ...)
      "value": "APAC"                  // Giá trị lọc
    },
    {
      "id": "f2",
      "field": "year",
      "operator": "gte",
      "value": "2024"
    }
  ]
}
```

### Operators

| Operator | Mô tả |
|----------|--------|
| `eq` | Bằng |
| `neq` | Khác |
| `gt` | Lớn hơn |
| `gte` | Lớn hơn hoặc bằng |
| `lt` | Nhỏ hơn |
| `lte` | Nhỏ hơn hoặc bằng |
| `in` | Trong danh sách |
| `contains` | Chứa chuỗi |

> Lưu ý: `filters_config` hiện tại được đặt khi `POST` hoặc `PUT /dashboards/{id}`. Frontend AppBI áp dụng filter ở client-side khi render charts.

---

## Tham khảo: Tất cả Endpoints

| Method | Path | Permission | Mô tả | Response |
|--------|------|-----------|--------|----------|
| `GET` | `/api/v1/dashboards/` | `view` | Danh sách (owned + shared) | `DashboardResponse[]` |
| `POST` | `/api/v1/dashboards/` | `edit` | Tạo mới (có thể kèm charts) | `DashboardResponse` (201) |
| `GET` | `/api/v1/dashboards/{id}` | `view` | Chi tiết + all charts | `DashboardResponse` |
| `PUT` | `/api/v1/dashboards/{id}` | `edit` | Sửa name/desc/filters | `DashboardResponse` |
| `DELETE` | `/api/v1/dashboards/{id}` | `full` | Xóa dashboard + join rows | 204 No Content |
| `POST` | `/api/v1/dashboards/{id}/charts` | `edit` | Thêm chart vào dashboard | `DashboardResponse` |
| `DELETE` | `/api/v1/dashboards/{id}/charts/{chart_id}` | `edit` | Xóa chart khỏi dashboard | `DashboardResponse` |
| `PUT` | `/api/v1/dashboards/{id}/layout` | `edit` | Bulk update layout | `DashboardResponse` |

---

## Tham khảo: Schemas đầy đủ

### DashboardCreate (Request Body — POST)

```python
class DashboardCreate(BaseModel):
    name: str                          # ★ 1-255 chars, unique
    description: Optional[str] = None
    filters_config: Optional[list] = None
    charts: Optional[List[DashboardChartItem]] = None  # Inline charts
```

### DashboardChartItem (trong DashboardCreate.charts[])

```python
class DashboardChartItem(BaseModel):
    chart_id: int                      # ★ Chart.id phải tồn tại
    layout: DashboardChartLayout       # ★ Vị trí trên grid
    parameters: Optional[dict] = None  # Runtime params
```

### DashboardChartLayout

```python
class DashboardChartLayout(BaseModel):
    x: int = Field(..., ge=0, le=11)   # ★ Cột (0-11)
    y: int = Field(..., ge=0)          # ★ Hàng (≥ 0)
    w: int = Field(..., ge=1, le=12)   # ★ Rộng (1-12)
    h: int = Field(..., ge=1)          # ★ Cao (≥ 1)
    i: Optional[str] = None            # react-grid-layout id
    minW: Optional[int] = None
    maxW: Optional[int] = None
    minH: Optional[int] = None
    maxH: Optional[int] = None
    static: Optional[bool] = None
```

### DashboardUpdate (Request Body — PUT)

```python
class DashboardUpdate(BaseModel):
    name: Optional[str] = None         # Nếu thay đổi, phải unique
    description: Optional[str] = None
    filters_config: Optional[list] = None
```

### DashboardAddChartRequest (Request Body — POST add chart)

```python
class DashboardAddChartRequest(BaseModel):
    chart_id: int                      # ★ Chart.id
    layout: DashboardChartLayout       # ★ Vị trí
    parameters: Optional[dict] = None
```

### DashboardUpdateLayoutRequest (Request Body — PUT layout)

```python
class DashboardUpdateLayoutRequest(BaseModel):
    chart_layouts: List[DashboardLayoutUpdate]  # ★ Mảng layout updates
```

### DashboardLayoutUpdate (trong chart_layouts[])

```python
class DashboardLayoutUpdate(BaseModel):
    id: int                            # ★ DashboardChart.id (NOT chart_id!)
    layout: DashboardChartLayout       # ★ Layout mới
```

### DashboardResponse (Response)

```python
class DashboardResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    owner_id: Optional[str]
    user_permission: Optional[str]     # "none" | "view" | "edit" | "full"
    filters_config: Optional[list]
    dashboard_charts: List[DashboardChartResponse]  # Eager-loaded
    created_at: datetime
    updated_at: datetime
```

### DashboardChartResponse (trong dashboard_charts[])

```python
class DashboardChartResponse(BaseModel):
    id: int                            # DashboardChart.id (join table)
    chart_id: int                      # Chart.id gốc
    layout: dict                       # {x, y, w, h, ...}
    parameters: Optional[dict]
    chart: ChartResponse               # Full chart object
```

---

## Bảng lỗi thường gặp & Cách khắc phục

| # | Lỗi | Status | Nguyên nhân | Cách khắc phục |
|---|------|--------|-------------|----------------|
| 1 | Dashboard name conflict | 409 | `name` đã tồn tại | Dùng tên khác hoặc xóa dashboard cũ trước |
| 2 | Chart not found | 400 | `chart_id` không tồn tại | Kiểm tra chart đã tạo: `GET /charts/{id}` |
| 3 | Chart already in dashboard | 400 | Chart đã có trong dashboard | Không thêm trùng. Nếu muốn 2 bản → tạo copy chart |
| 4 | Layout sai vị trí | 422 | `x < 0` hoặc `w > 12` hoặc `h < 1` | Kiểm tra: `x ∈ [0,11]`, `w ∈ [1,12]`, `y ≥ 0`, `h ≥ 1` |
| 5 | Layout PUT không tác dụng | 200 nhưng layout cũ | Dùng `chart_id` thay vì `DashboardChart.id` | Dùng `dashboard_charts[].id` từ GET response |
| 6 | Permission denied | 403 | User không có quyền `dashboards >= edit` | Kiểm tra module permission: `GET /permissions/{user_id}` |
| 7 | Delete dashboard 403 | 403 | Cần permission `full`, user chỉ có `edit` | Chỉ owner hoặc user có `full` mới xóa được |
| 8 | Delete chart 409 | 409 | Chart đang được dùng trong dashboard | Xóa dashboard hoặc remove chart khỏi dashboard trước |
| 9 | Missing `chart_layouts` wrapper | 422 | Gửi array trực tiếp thay vì `{"chart_layouts": [...]}` | Phải wrap trong object: `{"chart_layouts": [...]}` |
| 10 | Charts hiển thị blank trên dashboard | — | Chart không có data (filter sai, table thiếu) | Kiểm tra: `GET /charts/{id}/data` → phải có `rows > 0` |
| 11 | Dashboard không hiện trên frontend | — | User không có permission `view` | Kiểm tra permission. Dashboard chỉ list owned + shared |
| 12 | Layout bị dồn lên trên | — | Frontend auto-compact đẩy charts lên | Bình thường: react-grid-layout tự compact, `y` thực tế có thể khác `y` đã set |

---

## Ví dụ Python hoàn chỉnh

```python
"""
Ví dụ hoàn chỉnh: Tạo Dashboard với 6 charts đã có sẵn.
Giả sử bạn đã tạo charts theo GUIDED_API_CHART.md và có chart IDs.
"""
import requests

BASE = "http://localhost:8000/api/v1"

# ── Bước 0: Auth ──
token = requests.post(f"{BASE}/auth/login", json={
    "email": "admin@appbi.io",
    "password": "123456"
}).json()["access_token"]

headers = {"Authorization": f"Bearer {token}"}

# ── Bước 0.5: Lấy chart IDs ──
charts = requests.get(f"{BASE}/charts", headers=headers).json()
chart_ids = [c["id"] for c in charts]
print(f"Available charts: {chart_ids}")

# ── Bước 1: Tạo Dashboard với inline charts ──
# Giả sử 6 charts: ids = [1, 2, 3, 4, 5, 6]
dashboard_data = {
    "name": "Data Quality Dashboard",
    "description": "Overview of data platform health",
    "filters_config": [],
    "charts": [
        # Row 0: 2 KPI cards
        {"chart_id": chart_ids[0], "layout": {"x": 0, "y": 0, "w": 6, "h": 3}},
        {"chart_id": chart_ids[1], "layout": {"x": 6, "y": 0, "w": 6, "h": 3}},
        # Row 3: 1 bar chart full width
        {"chart_id": chart_ids[2], "layout": {"x": 0, "y": 3, "w": 12, "h": 5}},
        # Row 8: 3 equal columns
        {"chart_id": chart_ids[3], "layout": {"x": 0, "y": 8, "w": 4, "h": 4}},
        {"chart_id": chart_ids[4], "layout": {"x": 4, "y": 8, "w": 4, "h": 4}},
        {"chart_id": chart_ids[5], "layout": {"x": 8, "y": 8, "w": 4, "h": 4}},
    ]
}

resp = requests.post(f"{BASE}/dashboards", json=dashboard_data, headers=headers)
resp.raise_for_status()
dashboard = resp.json()
dashboard_id = dashboard["id"]
print(f"✅ Dashboard created: ID={dashboard_id}, name={dashboard['name']}")
print(f"   Charts: {len(dashboard['dashboard_charts'])} tiles")

# ── Bước 1.5: Ghi nhận DashboardChart IDs ──
dc_map = {}
for dc in dashboard["dashboard_charts"]:
    dc_map[dc["chart_id"]] = dc["id"]
    print(f"   chart_id={dc['chart_id']} → DashboardChart.id={dc['id']} "
          f"layout=({dc['layout']['x']},{dc['layout']['y']},{dc['layout']['w']},{dc['layout']['h']})")

# ── Bước 2: (Optional) Thêm chart thứ 7 ──
if len(chart_ids) > 6:
    add_resp = requests.post(
        f"{BASE}/dashboards/{dashboard_id}/charts",
        json={
            "chart_id": chart_ids[6],
            "layout": {"x": 0, "y": 12, "w": 12, "h": 5}
        },
        headers=headers
    )
    add_resp.raise_for_status()
    new_dc = [dc for dc in add_resp.json()["dashboard_charts"]
              if dc["chart_id"] == chart_ids[6]][0]
    dc_map[chart_ids[6]] = new_dc["id"]
    print(f"✅ Added chart {chart_ids[6]} → DashboardChart.id={new_dc['id']}")

# ── Bước 3: Update Layout (di chuyển chart) ──
# Ví dụ: đổi chart đầu tiên sang full width
layout_update = {
    "chart_layouts": [
        {
            "id": dc_map[chart_ids[0]],  # ★ Dùng DashboardChart.id, KHÔNG phải chart_id
            "layout": {"x": 0, "y": 0, "w": 12, "h": 3}
        }
    ]
}
layout_resp = requests.put(
    f"{BASE}/dashboards/{dashboard_id}/layout",
    json=layout_update,
    headers=headers
)
layout_resp.raise_for_status()
print(f"✅ Layout updated for DashboardChart.id={dc_map[chart_ids[0]]}")

# ── Bước 6: Verify ──
verify = requests.get(f"{BASE}/dashboards/{dashboard_id}", headers=headers).json()
print(f"\n📊 Dashboard: {verify['name']} (ID={verify['id']})")
print(f"   Total charts: {len(verify['dashboard_charts'])}")
for dc in verify["dashboard_charts"]:
    ly = dc["layout"]
    chart_name = dc["chart"]["name"] if dc.get("chart") else "?"
    print(f"   [{dc['id']}] chart_id={dc['chart_id']} "
          f"→ ({ly.get('x',0)},{ly.get('y',0)},{ly.get('w',6)},{ly.get('h',4)}) "
          f"'{chart_name}'")
```

---

## Quick Reference Card

```
╔══════════════════════════════════════════════════════════════════╗
║                  DASHBOARD API — QUICK REFERENCE                ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  TẠO DASHBOARD (with charts):                                   ║
║  POST /dashboards                                                ║
║  {"name": "...", "charts": [{"chart_id": N, "layout": {...}}]}  ║
║                                                                  ║
║  THÊM CHART:                                                    ║
║  POST /dashboards/{id}/charts                                    ║
║  {"chart_id": N, "layout": {"x":0,"y":0,"w":6,"h":4}}          ║
║                                                                  ║
║  XÓA CHART KHỎI DASHBOARD:                                     ║
║  DELETE /dashboards/{id}/charts/{chart_id}                       ║
║                                                                  ║
║  CẬP NHẬT LAYOUT:                                               ║
║  PUT /dashboards/{id}/layout                                     ║
║  {"chart_layouts": [{"id": DC_ID, "layout": {...}}]}            ║
║  ⚠️ id = DashboardChart.id (KHÔNG phải chart_id!)               ║
║                                                                  ║
║  SỬA DASHBOARD:                                                 ║
║  PUT /dashboards/{id}                                            ║
║  {"name": "...", "description": "..."}                          ║
║                                                                  ║
║  XÓA DASHBOARD:                                                 ║
║  DELETE /dashboards/{id}  (permission = full)                    ║
║  → Charts gốc KHÔNG bị xóa                                     ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  GRID: 12 columns × N rows (row ≈ 80px)                        ║
║  x: 0-11  │  y: ≥0  │  w: 1-12  │  h: ≥1                      ║
║  x + w ≤ 12 (không tràn)                                        ║
║                                                                  ║
║  ID MAPPING:                                                     ║
║  chart_id = Chart.id (bảng charts)                              ║
║  DashboardChart.id = dashboard_charts[].id (bảng join)          ║
║  Layout PUT → dùng DashboardChart.id                            ║
║  Remove chart → dùng chart_id                                   ║
║                                                                  ║
║  PERMISSION:                                                     ║
║  view: GET list + detail                                         ║
║  edit: POST, PUT, add/remove chart, update layout               ║
║  full: DELETE dashboard                                          ║
║                                                                  ║
║  THỨ TỰ XÓA: Dashboard trước → Charts sau                      ║
║  (Chart bị 409 nếu còn trong dashboard)                         ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

> **Xem thêm:** `GUIDED_API_CHART.md` (tạo charts) · `API.md` (reference đầy đủ) · `ARCHITECTURE.md` (kiến trúc hệ thống)
