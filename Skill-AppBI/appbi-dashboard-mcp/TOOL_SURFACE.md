# Tool Surface — appbi-orchestrator-mcp

Liệt kê đầy đủ các tool MCP server expose. Tổ chức theo flow 5 stage. Mỗi tool ghi rõ:
- Module file
- Mục đích
- Backend endpoint (nếu có)
- Có cần `user_confirmed` không

Convention:
- 🟢 đọc thuần — không cần confirm
- 🟡 ghi (preview-then-confirm) — `user_confirmed: bool = False`
- 🔴 destructive (delete) — `user_confirmed: bool = False`, hiện rõ "không thể rollback" trong plan

---

## Stage 0 — Health & Discovery (`appbi_core.py`)

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `health_check` | 🟢 | Verify MCP có kết nối được AppBI và PAT hợp lệ | `GET /health` (hoặc `GET /me`) |
| `list_data_sources` | 🟢 | List tất cả datasource user có quyền xem | `GET /datasources` |
| `list_datasets` | 🟢 | List tất cả dataset | `GET /datasets` |
| `list_dashboards` | 🟢 | List tất cả dashboard | `GET /dashboards` |

---

## Stage 1 — Source (`appbi_source.py`)

Mục tiêu: Claude hiểu cấu trúc + nội dung của 1 datasource trước khi quyết định tạo/dùng dataset.

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `get_data_source` | 🟢 | Chi tiết 1 datasource (loại, conn string, status) | `GET /datasources/{id}` |
| `inspect_source_schema` | 🟢 | List schemas + tables của 1 datasource | `GET /datasources/{id}/schemas` hoặc `/tables` |
| `inspect_source_table` | 🟢 | Cột + kiểu dữ liệu của 1 source table (chưa import vào dataset) | `GET /datasources/{id}/tables/{schema}/{table}` |
| `sample_source_table` | 🟢 | Sample N rows từ source table (default 20, max 200) | `POST /datasources/{id}/query` (LIMIT-bounded) |
| `run_source_query` | 🟢 | Ad-hoc SELECT để Claude verify giả thiết về data | `POST /datasources/{id}/query` |
| `test_data_source_connection` | 🟢 | Test conn còn live không | `POST /datasources/{id}/test` |

**Tool Claude thường gọi đầu tiên**: `list_data_sources` → `inspect_source_schema` → `sample_source_table` cho mỗi bảng quan tâm.

---

## Stage 2 — Dataset (`appbi_dataset.py`)

Mục tiêu: import bảng từ source vào dataset, viết description đầy đủ, sẵn sàng cho semantic model.

### Đọc

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `get_dataset` | 🟢 | Chi tiết 1 dataset. `summary=True` để giảm payload (chỉ id/tables/column_count). | `GET /datasets/{id}` |
| `list_dataset_tables` | 🟢 | List tables trong dataset | `GET /datasets/{id}/tables` |
| `get_dataset_table` | 🟢 | Chi tiết 1 table (cột, type, description, sample) | `GET /datasets/{id}/tables/{tid}` |
| `get_table_profile` | 🟢 | **(BACKEND P0 mới)** Schema + sample rows + column stats trong 1 call | `POST /datasets/{id}/tables/{tid}/profile` |
| `list_dataset_columns` | 🟢 | List cột với metadata + role (dimension/measure) | `GET /datasets/{id}/tables/{tid}/columns` |
| `get_column_summary` | 🟢 | Stats chi tiết 1 cột (top values, distinct, null %) | `GET /datasets/{id}/tables/{tid}/columns/{name}/summary` |
| `get_dataset_dictionary` | 🟢 | Glossary + aliases | `GET /datasets/{id}/dictionary` |
| `search_dataset_tables` | 🟢 | Vector-similarity search bảng theo intent | `POST /datasets/search-tables` |

### Ghi

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `create_dataset` | 🟡 | Tạo dataset rỗng | `POST /datasets` |
| `update_dataset` | 🟡 | Update name/description dataset | `PUT /datasets/{id}` |
| `delete_dataset` | 🔴 | Xoá dataset (cascade) | `DELETE /datasets/{id}` |
| `add_table_to_dataset` | 🟡 | Thêm 1 source table vào dataset | `POST /datasets/{id}/tables` |
| `remove_table_from_dataset` | 🔴 | Gỡ 1 table khỏi dataset | `DELETE /datasets/{id}/tables/{tid}` |
| `update_table_description` | 🟡 | Lưu description Claude tự viết (bảng + column_descriptions + common_questions). **Ghi thuần, không gọi LLM.** | `PUT /datasets/{id}/tables/{tid}/description` |
| `update_column_metadata` | 🟡 | Override type/format/role của 1 cột | `PUT /datasets/{id}/tables/{tid}/columns/{name}` |
| `set_dataset_dictionary` | 🟡 | Cập nhật glossary cho dataset | `PUT /datasets/{id}/dictionary` |

**Bỏ so với MCP cũ:** `regenerate_table_description`, `preview_table_description` (LLM nội bộ), `auto_detect_dataset_table_types` (Claude tự suy ra từ `get_table_profile`).

---

## Stage 3 — Semantic Model (`appbi_semantic.py`)

Mục tiêu: dựng layer ngữ nghĩa (views, joins, measures, dimensions) để chart query qua semantic engine thay vì raw SQL.

### Đọc

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `list_semantic_views` | 🟢 | List views | `GET /semantic/views` |
| `get_semantic_view` | 🟢 | Chi tiết view | `GET /semantic/views/{id}` |
| `list_semantic_models` | 🟢 | List models | `GET /semantic/models` |
| `get_semantic_model` | 🟢 | Chi tiết model | `GET /semantic/models/{id}` |
| `list_semantic_explores` | 🟢 | List explores | `GET /semantic/explores` |
| `get_semantic_explore` | 🟢 | Chi tiết explore | `GET /semantic/explores/{id}` |
| `get_semantic_explore_by_name` | 🟢 | Lookup explore theo name | `GET /semantic/explores/by-name/{name}` |
| `get_dataset_model` | 🟢 | Model gắn với 1 dataset. `summary=True` để bỏ measure SQL + descriptions. | `GET /datasets/{id}/model` |
| `get_distinct_field_values` | 🟢 | Distinct values của 1 semantic field (cho dropdown filter) | `GET /datasets/{id}/semantic-model/distinct-values` |
| `preview_join` | 🟢 | **(BACKEND P1 mới)** Preview join 2 table (sample rows) trước khi tạo explore | `POST /datasets/{id}/tables/{tid}/join-preview` |

### Ghi

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `create_semantic_view` | 🟡 | Tạo view (dimensions, measures) | `POST /semantic/views` |
| `update_semantic_view` | 🟡 | Update view | `PUT /semantic/views/{id}` |
| `delete_semantic_view` | 🔴 | Xoá view | `DELETE /semantic/views/{id}` |
| `create_semantic_model` | 🟡 | Tạo model | `POST /semantic/models` |
| `update_semantic_model` | 🟡 | Update model | `PUT /semantic/models/{id}` |
| `delete_semantic_model` | 🔴 | Xoá model | `DELETE /semantic/models/{id}` |
| `create_semantic_explore` | 🟡 | Tạo explore (joins) | `POST /semantic/explores` |
| `update_semantic_explore` | 🟡 | Update explore | `PUT /semantic/explores/{id}` |
| `delete_semantic_explore` | 🔴 | Xoá explore | `DELETE /semantic/explores/{id}` |
| `update_dataset_semantic_view` | 🟡 | Update view ở scope dataset | `PUT /datasets/{id}/semantic-model/views/{vid}` |
| `update_dataset_semantic_explore` | 🟡 | Update explore ở scope dataset | `PUT /datasets/{id}/semantic-model/explores/{eid}` |
| `set_view_relationship` | 🟡 | Add/update relationship 2 view trong 1 dataset | `POST /datasets/{id}/semantic-model/relationships` |
| `remove_view_relationship` | 🔴 | Remove relationship | `DELETE /datasets/{id}/semantic-model/relationships/{rid}` |
| `execute_semantic_query` | 🟢 | Execute query qua semantic engine (Claude dùng để xem data trước khi tạo chart) | `POST /semantic/query` |

**Bỏ so với MCP cũ:** `find_semantic_models_by_name` (diagnostic helper hiếm dùng — gộp vào `list_semantic_models` với filter).

### Measure schema (Phase-1)

`measures[]` items hỗ trợ các field mở rộng (tất cả optional ngoài `name` + `type`):

| Field | Mô tả | Khi nào dùng |
|---|---|---|
| `name`, `type`, `sql`, `label`, `description`, `hidden` | Schema gốc (LookML-style) | Luôn có |
| `expression` | SQL expression aggregate by `type`, override `sql` | Khi cần arithmetic giữa nhiều cột (vd. `${TABLE}.amount - ${TABLE}.cost`) |
| `filters` | List `{field, operator, value}` → CASE WHEN wrapper (Looker filtered measure) | Khi measure chỉ tính trên 1 slice cố định (vd. `paid_revenue`). Operator: `eq, ne, gt, gte, lt, lte, in, not_in, between, contains, starts_with, ends_with, is_null, is_not_null` |
| `where_sql` | Raw SQL boolean fragment, AND với `filters` | Dự phòng cho predicate phức tạp UI builder không expr (date math, regex, multi-column) |
| `depends_on` | Tên các measure khác cùng view mà `expression` tham chiếu | Bắt buộc khai báo để cycle-check; vi phạm bị reject ở `commit_semantic_model` |
| `format` | `{kind, decimals, currency, prefix, suffix, pattern}` | Hint hiển thị cho chart/KPI; không ảnh hưởng SQL |
| `folder` | Nhãn group trong UI Explore | Cosmetics |

**Quy tắc cho AI khi tạo measure:**
1. Form mode trước (`type` + `sql`); chỉ dùng `expression` khi cần arithmetic.
2. Ưu tiên `filters` cấu trúc thay vì `where_sql` — user không SQL có thể edit lại.
3. Mỗi khi `expression` reference measure khác → bắt buộc liệt kê trong `depends_on`.
4. `format` cho mọi measure tiền/tỷ lệ để chart hiển thị đúng (currency có decimals, percent có suffix `%`).
5. Filtered measure ≠ chart pivot. Pivot dùng cho ad-hoc breakdown; filtered measure dùng cho slice cố định tái sử dụng.

`commit_semantic_model` validate đầy đủ: operator hợp lệ, value đúng kiểu (list cho `in/between`), `depends_on` không self-ref và không chu trình, `format.currency` bắt buộc khi `kind=currency`, etc.

---

## Stage 4 — Charts (`appbi_chart.py`)

Mục tiêu: tạo charts dựa trên semantic explore. Claude tự chọn type, config, title.

Current Explore chart contract:
- **Không còn** `get_supported_chart_types`, `build_chart_config`, `validate_chart_config` — các tools này đã bị xóa.
  Thay vào đó: dùng blueprint flow (`propose_dashboard_blueprint` → `commit_dashboard_blueprint`)
  hoặc `preview_chart_data` để verify trước khi `create_chart`.
- `commit_dashboard_blueprint` tự động validate role shape + measure + dimension + join reachability
  trước khi ghi bất kỳ chart nào.
- Supported types: TABLE, MATRIX, KPI, GAUGE, BULLET, PODIUM, BAR, HORIZONTAL_BAR,
  GROUPED_BAR, STACKED_BAR, BAR_LINE, WATERFALL, LINE, AREA, TIME_SERIES, RIBBON,
  TIMELINE, PIE, DONUT, POLAR_AREA, TREEMAP, FUNNEL, WORD_CLOUD, SCATTER, BUBBLE,
  HEATMAP, BOXPLOT, RADAR, SANKEY, SUNBURST, MAP_POINT, MAP_REGION.

### Đọc

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `list_charts` | 🟢 | List charts. `summary=True` để bỏ config blob (chỉ id/name/type/role_summary). | `GET /charts` |
| `get_chart` | 🟢 | Chi tiết chart | `GET /charts/{id}` |
| `preview_chart_data` | 🟢 | Run chart query → trả raw data (không lưu) | `POST /charts/preview-data` |
| `get_chart_parameters` | 🟢 | List parameters của chart | `GET /charts/{id}/parameters` |

### Ghi

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `create_chart` | 🟡 | Tạo chart (name, type, dataset_table_id, config) | `POST /charts` |
| `update_chart` | 🟡 | Update chart config | `PUT /charts/{id}` |
| `delete_chart` | 🔴 | Xoá chart | `DELETE /charts/{id}` |
| `update_chart_description` | 🟡 | Lưu description Claude tự viết | `PUT /charts/{id}/description` |
| `set_chart_parameters` | 🟡 | Set parameter values | `PUT /charts/{id}/parameters` |

**Bỏ:** `regenerate_chart_description` (LLM), `ai_chart_preview` (LLM nội bộ — Claude tự đề xuất).

---

## Stage 5 — Dashboard

Stage 5 có **2 path** để tạo dashboard. Claude nên hỏi user hoặc tự chọn dựa theo context:

### Path A — HTML Import (safe / server-validated) (`appbi_html_import.py`)

Workflow:
```
get_html_dashboard_spec → (viết HTML) → analyze_html_import → review → build_dashboard_from_html
```

Nên dùng khi:
- Dashboard mới từ đầu với nhiều chart (≥ 4)
- Cần calculated fields / derived aggregated tables khai báo trong HTML
- Source là file Excel chưa có trong AppBI
- User muốn review toàn bộ chart plan trước khi ghi bất kỳ gì

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `get_html_dashboard_spec` | 🟢 | Trả full spec v1 HTML (format, widget types, role_config, layout) | local |
| `analyze_html_import` | 🟢 | Parse + validate HTML chart plans vs dataset schema | `POST /dashboards/import-html/analyze` |
| `build_dashboard_from_html` | 🟡 | Materialise: tạo Dataset + Charts + Dashboard 1 call | `POST /dashboards/import-html/build` |

**Tham số đặc biệt của `build_dashboard_from_html`:**
- `layout_mode`: "grid" | "canvas" — override layout_mode từ HTML metadata
- `theme_config`: dict — custom theme cho dashboard
- `canvas_config`: dict — config canvas mode

### Path B — Direct API (granular / linh hoạt) (`appbi_dashboard.py`)

Nên dùng khi:
- Chart đã tồn tại, chỉ cần assembly
- Cần kiểm soát fine-grained canvas layout hoặc parameters per-placement
- Semantic model đã build sẵn và charts đã validated

#### Đọc

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `get_dashboard` | 🟢 | Chi tiết dashboard | `GET /dashboards/{id}` |
| `list_dashboard_charts` | 🟢 | List chart trong dashboard | `GET /dashboards/{id}/charts` |
| `get_dashboard_layout` | 🟢 | Layout grid hiện tại | `GET /dashboards/{id}/layout` |
| `get_dashboard_filters` | 🟢 | List filter | `GET /dashboards/{id}/filters` |
| `list_dashboard_pages` | 🟢 | List pages của dashboard | `GET /dashboards/{id}/pages` |
| `list_public_links` | 🟢 | List public link đã tạo | `GET /dashboards/{id}/public-links` |

#### Ghi

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `create_dashboard` | 🟡 | Tạo dashboard rỗng (grid hoặc canvas) | `POST /dashboards` |
| `update_dashboard` | 🟡 | Update name/description/filters_config | `PUT /dashboards/{id}` |
| `delete_dashboard` | 🔴 | Xoá dashboard | `DELETE /dashboards/{id}` |
| `add_chart_to_dashboard` | 🟡 | Add 1 chart vào dashboard | `POST /dashboards/{id}/charts` |
| `add_widget_to_dashboard` | 🟡 | Add text/image/countdown widget | `POST /dashboards/{id}/widgets` |
| `remove_chart_from_dashboard` | 🔴 | Gỡ chart khỏi dashboard | `DELETE /dashboards/{id}/charts/{cid}` |
| `update_dashboard_layout` | 🟡 | Update grid layout nhiều chart 1 call | `PUT /dashboards/{id}/layout` |
| `add_dashboard_filter` | 🟡 | Add filter (text/number/date/dropdown) | `PUT /dashboards/{id}` (filters_config) |
| `remove_dashboard_filter` | 🔴 | Gỡ filter | `PUT /dashboards/{id}` (filters_config) |
| `create_public_link` | 🟡 | Tạo public link share-able | `POST /dashboards/{id}/public-links` |
| `update_public_link` | 🟡 | Update link config | `PATCH /dashboards/{id}/public-links/{lid}` |
| `delete_public_link` | 🔴 | Xoá link | `DELETE /dashboards/{id}/public-links/{lid}` |

---

## Cross-cutting (`appbi_quality.py`, `appbi_sharing.py`)

### Quality (optional, nhỏ)

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `list_quality_rules` | 🟢 | List rules | `GET /datasets/{id}/quality/rules` |
| `create_quality_rule` | 🟡 | Tạo rule (Claude tự đề xuất, không gọi `ai_suggest`) | `POST /datasets/{id}/quality/rules` |
| `update_quality_rule` | 🟡 | Update rule | `PUT /datasets/{id}/quality/rules/{rid}` |
| `delete_quality_rule` | 🔴 | Xoá rule | `DELETE /datasets/{id}/quality/rules/{rid}` |
| `run_quality_rule` | 🟢 | Chạy rule, xem kết quả | `POST /datasets/{id}/quality/rules/{rid}/run` |
| `list_quality_runs` | 🟢 | Lịch sử run | `GET /datasets/{id}/quality/runs` |

**Bỏ:** `ai_suggest_quality_rule`.

### Sharing

| Tool | Type | Mục đích | Endpoint |
|---|---|---|---|
| `list_resource_shares` | 🟢 | List shares cho 1 resource | `GET /shares?resource_type=&resource_id=` |
| `share_resource` | 🟡 | Share datasource/dataset/chart/dashboard với user/team | `POST /shares` |
| `update_share` | 🟡 | Update permission level | `PUT /shares/{id}` |
| `revoke_share` | 🔴 | Revoke share | `DELETE /shares/{id}` |

---

## Tổng kết

| Stage | Tool count |
|---|---|
| 0 — Health & Discovery | 4 |
| 1 — Source | 6 |
| 2 — Dataset | 16 |
| 3 — Semantic Model | 24 |
| 4 — Charts | 10 |
| 5 — Dashboard | 20 |
| Quality | 6 |
| Sharing | 4 |
| **Total** | **~90** |

Hơi vượt target 60-70 nhưng phần lớn là `list_*`/`get_*` đọc thuần — không gây nhiễu chọn tool. Tool ghi (cần Claude quyết định cẩn thận) chỉ ~35.

## Agent contract — critical conventions

Đọc kỹ trước khi gọi `commit_dashboard_blueprint` hoặc `create_chart`:

1. **`queryMode` stored is always `generated`.** `propose_dashboard_blueprint` build config với `queryMode: "generated"` + cùng `roleConfig` ở cả `roleConfig` và `generatedRoleConfig`. Đừng đổi.

2. **`role_config.metrics[].field` là bare SQL column** trên bound view của chart, không phải `view.measure`. Qualifier `view.` bị strip trước khi lưu. Reference field từ joined view sẽ FAIL tại runtime (chart engine không apply explore joins).

3. **Semantic measure với `expression` / `filters` / `where_sql` không dùng được trong chart metric.** `propose_dashboard_blueprint` đánh dấu `chart_compatible: false` + cung cấp `workaround` cụ thể. Commit refuses chart spec dùng những measure này với thông điệp rõ ràng.

4. **Blueprint limit 20 charts per `commit_dashboard_blueprint` call.** Vượt sẽ bị refuse upfront với `blocked_by_chart_limit`. Split dashboard multi-page bằng nhiều commit (hoặc add_chart_to_dashboard cho phần dư).

5. **Preview errors trả về `root_cause` + `resolution_options`** thay vì raw exception. Pattern-matched cho `UNRECOGNIZED_FIELD`, `BIGQUERY_UNQUALIFIED_TABLE`, `COLUMN_NOT_IN_BOUND_VIEW`, `PREVIEW_TIMEOUT`.

6. **Heavy reads support `summary=True`** trên `get_dataset`, `get_dataset_model`, `list_charts` — dùng cho discovery, dùng default form chỉ khi cần payload đầy đủ.

## Backend endpoint mới cần thêm

P0 (làm trước Stage 1):
- `POST /datasets/{id}/tables/{tid}/profile`

P1 (làm trong Stage 3 + Stage 5):
- `POST /datasets/{id}/tables/{tid}/join-preview`
- `POST /dashboards/{id}/charts/bulk`

P2 (defer, có cũng tốt):
- `POST /charts/validate-config` — fallback hiện dùng `preview-data` dry-run
- `POST /semantic/relationship-candidates` — Claude tự đoán FK qua `get_table_profile`
