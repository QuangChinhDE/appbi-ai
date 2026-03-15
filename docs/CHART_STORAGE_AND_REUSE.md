# Tài liệu: Lưu trữ và tái sử dụng Chart trong báo cáo (Dashboard)

> **Mục tiêu:** Giải thích chi tiết cách một chart được lưu trong database, cấu trúc dữ liệu từng bảng, và cơ chế đưa chart đó vào một dashboard (báo cáo).

---

## 1. Tổng quan kiến trúc

```
DataSource  ──►  Dataset  ──►  Chart  ──►  DashboardChart  ──►  Dashboard
(kết nối DB)   (câu SQL)    (cấu hình     (bảng trung gian,    (báo cáo)
                             biểu đồ)      có vị trí layout)
```

Một chart **không chứa dữ liệu thô** — nó chỉ chứa **cấu hình biểu đồ** (loại biểu đồ, cột nào là trục X, trục Y, màu sắc…) và **tham chiếu đến nguồn dữ liệu**.

Dữ liệu thực tế được truy vấn **động** mỗi khi chart được hiển thị.

---

## 2. Cấu trúc Database

### Bảng `charts`

Đây là bảng lưu trữ định nghĩa của một chart.

| Cột | Kiểu | Mô tả |
|-----|------|-------|
| `id` | INTEGER (PK) | Định danh duy nhất |
| `name` | VARCHAR(255) UNIQUE | Tên chart, không được trùng |
| `description` | TEXT | Mô tả tùy chọn |
| `dataset_id` | INTEGER (FK → `datasets.id`) | Nguồn dữ liệu loại Dataset (SQL query) |
| `workspace_table_id` | INTEGER (FK → `dataset_workspace_tables.id`) | Nguồn dữ liệu loại Workspace Table |
| `chart_type` | ENUM | Loại biểu đồ (xem bên dưới) |
| `config` | JSON | Cấu hình chi tiết (trục, màu, v.v.) |
| `created_at` | TIMESTAMP | Thời điểm tạo |
| `updated_at` | TIMESTAMP | Thời điểm cập nhật cuối |

> **Lưu ý quan trọng:** `dataset_id` và `workspace_table_id` là **mutually exclusive** — một chart chỉ được dùng một trong hai, không thể dùng cả hai cùng lúc. Validation này được thực hiện ở tầng Pydantic schema khi tạo chart.

---

### Các loại chart hỗ trợ (`chart_type`)

```python
class ChartType(str, enum.Enum):
    BAR          = "BAR"
    LINE         = "LINE"
    PIE          = "PIE"
    TIME_SERIES  = "TIME_SERIES"
    TABLE        = "TABLE"
    AREA         = "AREA"
    STACKED_BAR  = "STACKED_BAR"
    GROUPED_BAR  = "GROUPED_BAR"
    SCATTER      = "SCATTER"
    KPI          = "KPI"
```

---

### Cột `config` — JSON cấu hình biểu đồ

Đây là cột quan trọng nhất. Nội dung thay đổi tùy theo `chart_type`:

#### Ví dụ: Bar / Line Chart
```json
{
  "x_axis": "month",
  "y_axis": "revenue",
  "title": "Doanh thu theo tháng",
  "palette": "vibrant"
}
```

#### Ví dụ: Pie Chart
```json
{
  "label_column": "category",
  "value_column_pie": "total_sales",
  "color": "#4f46e5"
}
```

#### Ví dụ: Multi-series (Stacked Bar / Grouped Bar)
```json
{
  "x_axis": "quarter",
  "y_fields": ["north_revenue", "south_revenue", "central_revenue"],
  "series_colors": {
    "north_revenue": "#3b82f6",
    "south_revenue": "#10b981",
    "central_revenue": "#f59e0b"
  }
}
```

#### Ví dụ: KPI
```json
{
  "value_column": "total_orders",
  "title": "Tổng đơn hàng",
  "color": "#8b5cf6"
}
```

#### Ví dụ: Explore 2.0 (Advanced)
```json
{
  "dimension_configs": [
    { "field": "country", "label": "Quốc gia" }
  ],
  "measure_configs": [
    { "field": "revenue", "agg": "SUM", "label": "Doanh thu" }
  ],
  "sorts": [
    { "field": "revenue", "direction": "desc", "index": 0 }
  ],
  "conditional_formatting": [
    { "field": "revenue", "operator": "lt", "value": 1000, "backgroundColor": "#fee2e2" }
  ]
}
```

Toàn bộ các field hợp lệ trong `config`:

```
x_axis, y_axis, y_fields, time_column, value_column,
label_column, value_column_pie, title, filters, colors,
color, series_colors, palette, color_by_dimension,
dimensions, measures, dimension_configs, measure_configs,
grouping, sorts, conditional_formatting
```

---

### Bảng `dashboards`

| Cột | Kiểu | Mô tả |
|-----|------|-------|
| `id` | INTEGER (PK) | Định danh |
| `name` | VARCHAR(255) UNIQUE | Tên báo cáo |
| `description` | TEXT | Mô tả |
| `filters_config` | JSON | Bộ lọc cấp dashboard (xem bên dưới) |
| `created_at` | TIMESTAMP | Thời điểm tạo |
| `updated_at` | TIMESTAMP | Thời điểm cập nhật |

---

### Bảng `dashboard_charts` — bảng trung gian (nhiều-nhiều)

Đây là bảng **kết nối** giữa Dashboard và Chart, đồng thời lưu **vị trí + kích thước** của chart trên lưới.

| Cột | Kiểu | Mô tả |
|-----|------|-------|
| `id` | INTEGER (PK) | Định danh của liên kết |
| `dashboard_id` | INTEGER (FK → `dashboards.id`) | Thuộc dashboard nào |
| `chart_id` | INTEGER (FK → `charts.id`) | Chart nào |
| `layout` | JSON | Vị trí và kích thước trên lưới |

#### Cột `layout` — vị trí trên grid

Hệ thống dùng **react-grid-layout** với lưới 12 cột:

```json
{
  "x": 0,
  "y": 0,
  "w": 6,
  "h": 4
}
```

| Trường | Ý nghĩa |
|--------|---------|
| `x` | Vị trí cột bắt đầu (0–11) |
| `y` | Vị trí hàng bắt đầu (0 = trên cùng) |
| `w` | Chiều rộng tính theo cột (1–12) |
| `h` | Chiều cao tính theo đơn vị hàng |

---

## 3. Mối quan hệ giữa các bảng

```
data_sources (1)
    └──► datasets (N)          -- một data source có nhiều dataset
              └──► charts (N)  -- một dataset có nhiều chart

dataset_workspace_tables (1)
    └──► charts (N)            -- hoặc chart lấy từ workspace table

charts (N)
    └──► dashboard_charts (N)  -- một chart dùng được trong nhiều dashboard
              ▲
dashboards (N)──┘               -- một dashboard chứa nhiều chart
```

**Điểm quan trọng:** Một chart có thể được thêm vào **nhiều dashboard khác nhau**. Đây là thiết kế tái sử dụng — bảng `dashboard_charts` lưu **bao nhiêu lần** chart đó xuất hiện và **ở đâu** trên từng dashboard.

---

## 4. Luồng tạo và lưu Chart

### Bước 1 — Tạo chart mới (API)

```http
POST /api/charts/
Content-Type: application/json

{
  "name": "Doanh thu theo tháng",
  "description": "...",
  "dataset_id": 5,
  "chart_type": "BAR",
  "config": {
    "x_axis": "month",
    "y_axis": "revenue"
  }
}
```

### Bước 2 — Backend validation

`ChartService.create()` thực hiện:
1. Kiểm tra `dataset_id` hoặc `workspace_table_id` có tồn tại không
2. Tạo bản ghi `Chart` trong DB
3. Commit transaction
4. Trả về `ChartResponse`

```python
db_chart = Chart(
    name=chart.name,
    description=chart.description,
    dataset_id=chart.dataset_id,
    workspace_table_id=chart.workspace_table_id,
    chart_type=ChartType(chart.chart_type.value),
    config=chart.config
)
db.add(db_chart)
db.commit()
```

### Bước 3 — Lấy dữ liệu chart (`GET /charts/{id}/data`)

`ChartService.get_chart_data()` xử lý 3 trường hợp theo thứ tự ưu tiên:

```
1. workspace_table_id (FK trực tiếp)
        │
        ├── source_kind = "sql_query"  → thực thi db_table.source_query
        └── source_kind = "physical_table" → SELECT * FROM <table_name>
        
2. config.source.kind = "workspace_table" (legacy)
        └── đọc tableId từ config JSON → xử lý tương tự trên

3. dataset_id (mặc định)
        └── DatasetService.execute(db, dataset_id)
            → chạy SQL query đã lưu trong dataset
```

---

## 5. Luồng thêm Chart vào Dashboard

### Bước 1 — Mở modal "Add Chart"

Trên trang `/dashboards/[id]`, user click nút **Add Chart**.

Frontend (`AddChartModal.tsx`) gọi `useCharts()` để lấy danh sách tất cả chart hiện có, lọc ra các chart **chưa có trong dashboard**.

### Bước 2 — User chọn chart + kích thước

User chọn chart từ dropdown, nhập **Width** (số cột, 1–12) và **Height** (số hàng, 2–10).

### Bước 3 — Gọi API thêm chart

```http
POST /api/dashboards/{dashboard_id}/charts
Content-Type: application/json

{
  "chart_id": 3,
  "layout": {
    "x": 0,
    "y": 0,
    "w": 6,
    "h": 4
  }
}
```

### Bước 4 — Backend tạo `dashboard_charts`

`DashboardService.add_chart()`:
1. Kiểm tra dashboard tồn tại
2. Kiểm tra chart tồn tại
3. Kiểm tra chart **chưa có** trong dashboard (tránh duplicate)
4. Tạo bản ghi `DashboardChart` mới
5. Trả về dashboard nguyên vẹn (kèm tất cả charts)

```python
db_dashboard_chart = DashboardChart(
    dashboard_id=dashboard_id,
    chart_id=chart_id,
    layout=layout.model_dump()   # → {"x": 0, "y": 0, "w": 6, "h": 4}
)
db.add(db_dashboard_chart)
db.commit()
```

### Bước 5 — Frontend cập nhật UI

`useAddChartToDashboard` (React Query mutation) sau khi thành công sẽ **invalidate cache** của dashboard → dashboard tự fetch lại → chart mới xuất hiện trên grid.

---

## 6. Luồng hiển thị Chart trong Dashboard

Khi user mở `/dashboards/[id]`:

```
1. useDashboard(id)
    → GET /dashboards/{id}
    → Response trả về:
       {
         "id": 1,
         "name": "Dashboard Q1",
         "dashboard_charts": [
           {
             "id": 10,          -- dashboard_chart_id
             "chart_id": 3,
             "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
             "chart": {         -- Join sẵn từ backend
               "id": 3,
               "name": "Doanh thu theo tháng",
               "chart_type": "BAR",
               "config": {...}
             }
           }
         ]
       }

2. DashboardGrid.tsx
    → Chuyển layout sang format react-grid-layout
    → Render <ChartTile> cho mỗi chart

3. ChartTile
    → useChartData(chart_id) → GET /charts/{id}/data
    → Backend chạy query từ Dataset/WorkspaceTable
    → Trả về { chart: {...}, data: [{...}, ...] }
    → Render biểu đồ với thư viện frontend
```

**Backend load dashboard** (query với `joinedload`):
```python
db.query(Dashboard)
  .options(
      joinedload(Dashboard.dashboard_charts)
      .joinedload(DashboardChart.chart)
  )
  .filter(Dashboard.id == dashboard_id)
  .first()
```

---

## 7. Cập nhật layout (kéo thả / resize)

Khi user kéo thả hoặc thay đổi kích thước chart trên dashboard:

```
1. react-grid-layout gọi onLayoutChange(newLayout[])

2. Frontend debounce 1 giây (tránh spam API)

3. PUT /dashboards/{id}/layout
   {
     "chart_layouts": [
       {"id": 10, "layout": {"x": 0, "y": 0, "w": 8, "h": 5}},
       {"id": 11, "layout": {"x": 8, "y": 0, "w": 4, "h": 5}}
     ]
   }

4. Backend DashboardService.update_layout()
    → Cập nhật cột layout của từng DashboardChart record
    → Commit

5. UI tự động lưu (không cần bấm nút Save)
```

---

## 8. Xóa Chart — Ràng buộc

Chart **không thể xóa** nếu đang được dùng trong ít nhất một dashboard.

```http
DELETE /charts/3
→ HTTP 409 Conflict

{
  "message": "Chart \"Doanh thu theo tháng\" đang được sử dụng trong 2 dashboard và không thể xóa.",
  "constraints": [
    {"type": "dashboard", "id": 1, "name": "Dashboard Q1"},
    {"type": "dashboard", "id": 4, "name": "Báo cáo tháng 3"}
  ]
}
```

Trên frontend, `DeleteConstraintModal` hiển thị danh sách dashboard đang dùng chart đó, yêu cầu user xóa chart khỏi tất cả dashboard trước.

---

## 9. Dashboard-level Filters (bộ lọc cấp báo cáo)

Cột `filters_config` trong bảng `dashboards` lưu bộ lọc áp dụng cho toàn bộ dashboard:

```json
[
  {
    "id": "uuid-abc",
    "datasetId": 5,
    "field": "country",
    "type": "dropdown",
    "operator": "in",
    "value": ["Vietnam", "Singapore"]
  }
]
```

Bộ lọc này được truyền xuống từng `ChartTile` → mỗi chart lọc dữ liệu của mình theo giá trị filter đang active.

---

## 10. Sơ đồ tóm tắt toàn bộ

```
┌──────────────────────────────────────────────────────────────────────┐
│  DATABASE                                                            │
│                                                                      │
│  data_sources          datasets              charts                  │
│  ┌────────────┐        ┌────────────┐        ┌──────────────────┐   │
│  │ id         │◄──────│ data_src_id│        │ id               │   │
│  │ name       │        │ id         │◄──────│ dataset_id       │   │
│  │ type       │        │ name       │        │ workspace_tbl_id │   │
│  │ config     │        │ sql_query  │        │ name             │   │
│  └────────────┘        │ columns    │        │ chart_type       │   │
│                        │ transform. │        │ config (JSON)    │   │
│  dataset_workspace_    └────────────┘        └────────┬─────────┘   │
│  tables                                               │              │
│  ┌────────────┐                                       │              │
│  │ id         │◄──────────────────────────────────────┘              │
│  │ name       │                                                      │
│  │ source_kind│        dashboard_charts        dashboards            │
│  └────────────┘        ┌────────────────┐      ┌────────────────┐   │
│                        │ id             │      │ id             │   │
│                        │ dashboard_id ──┼─────►│ name           │   │
│                        │ chart_id    ──►│chart │ description    │   │
│                        │ layout (JSON) │      │ filters_config │   │
│                        │  {x,y,w,h}   │      └────────────────┘   │
│                        └────────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  API ENDPOINTS                             │
│                                            │
│  POST   /charts/              Tạo chart    │
│  GET    /charts/{id}/data     Lấy data     │
│  PUT    /charts/{id}          Sửa chart    │
│  DELETE /charts/{id}          Xóa chart    │
│                                            │
│  POST   /dashboards/          Tạo dashboard│
│  GET    /dashboards/{id}      Load báo cáo │
│  POST   /dashboards/{id}/charts   Thêm chart│
│  DELETE /dashboards/{id}/charts/{dc_id}    │
│  PUT    /dashboards/{id}/layout   Lưu layout│
└────────────────────────────────────────────┘
```

---

## 11. Các file liên quan trong codebase

| Tầng | File | Vai trò |
|------|------|---------|
| Model | [backend/app/models/models.py](../backend/app/models/models.py) | Định nghĩa `Chart`, `Dashboard`, `DashboardChart` |
| Schema | [backend/app/schemas/schemas.py](../backend/app/schemas/schemas.py) | Validation input/output API |
| Schema | [backend/app/schemas/chart_config.py](../backend/app/schemas/chart_config.py) | Chi tiết cấu trúc JSON `config` |
| Service | [backend/app/services/chart_service.py](../backend/app/services/chart_service.py) | Logic CRUD + lấy dữ liệu động |
| Service | [backend/app/services/dashboard_service.py](../backend/app/services/dashboard_service.py) | Logic thêm/xóa/layout chart |
| API | [backend/app/api/charts.py](../backend/app/api/charts.py) | Endpoint REST cho chart |
| API | [backend/app/api/dashboards.py](../backend/app/api/dashboards.py) | Endpoint REST cho dashboard |
| Frontend Types | [frontend/src/types/api.ts](../frontend/src/types/api.ts) | TypeScript types |
| Frontend API | [frontend/src/lib/api/charts.ts](../frontend/src/lib/api/charts.ts) | Gọi API từ FE |
| Frontend API | [frontend/src/lib/api/dashboards.ts](../frontend/src/lib/api/dashboards.ts) | Gọi API từ FE |
| UI Component | [frontend/src/components/dashboards/DashboardGrid.tsx](../frontend/src/components/dashboards/DashboardGrid.tsx) | Grid kéo thả |
| UI Component | [frontend/src/components/dashboards/AddChartModal.tsx](../frontend/src/components/dashboards/AddChartModal.tsx) | Modal thêm chart |
