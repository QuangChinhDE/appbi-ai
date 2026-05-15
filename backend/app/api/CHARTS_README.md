# Chart Module — Hướng dẫn kiến trúc

> Tài liệu này là **source of truth** cho thiết kế Chart module. Tương tự
> `DATASETS_README.md`, dev mới phải đọc trước khi đụng vào Chart code để
> tránh phá rule kiến trúc.

Cập nhật gần nhất: 2026-05-15 (Phase-10).

---

## 1. Khái niệm

Chart là 1 trực quan hoá dữ liệu — gắn với 1 `DatasetTable` qua FK
`Chart.dataset_table_id`, sử dụng `config` JSON để mô tả role binding
(metrics, dimensions, breakdown, …) và optional `semanticBinding` để
route query qua semantic engine.

### Object liên quan
- `Chart` — main entity, có config JSONB
- `ChartMetadata` — AI-generated description (1:1)
- `ChartParameter` — runtime input parameters (multi-row)
- `DashboardChart` — link chart vào dashboard

---

## 2. Lifecycle

### Create
```
POST /api/v1/charts/
  body: ChartCreate { name, dataset_table_id, chart_type, config }
```
- Validator: `dataset_table_id` required + `config` phải có ít nhất 1
  trong: `roleConfig`, `generatedRoleConfig`, `customRoleConfig`,
  `customSql`, `semanticBinding`. (Phase-9.)
- Sau create: enqueue background description pipeline.

### Update
```
PUT /api/v1/charts/{id}
  body: ChartUpdate (partial)
```

### Get data (render)
```
GET /api/v1/charts/{id}/data?filters=...&context=...
```
- Dispatch chia 3 path trong `chart_service.py`:
  1. Generated calendar table → cal_sql via dialect builder
  2. Derived table → `_execute_chart_runtime_for_table` direct
  3. Physical table → semantic engine v2 OR legacy live query

### Delete
```
DELETE /api/v1/charts/{id}
```
- Block với 409 nếu chart đang được Dashboard reference (cascade list).

---

## 3. Chart types (32 loại)

Single source of truth: `ChartType` enum trong `backend/app/models/models.py`.
FE selector phải sync qua `Record<ChartType, ChartTypeMeta>` (Phase-7
refactor) → thêm enum value mới = TypeScript compile error tại
[ChartTypeSelector.tsx](../../frontend/src/components/explore/ChartTypeSelector.tsx).

---

## 4. Rules — Must Follow

| Rule | Lý do |
|---|---|
| Chart phải có `dataset_table_id` (Pydantic enforced) | Không có data source → render fail silent |
| `config` phải có ít nhất 1 recognised role container | Empty config → "no data" UX confusing |
| `metric.agg = "auto"` valid (Phase-3 fix) | Measure đã định nghĩa agg trong semantic layer |
| FE dùng `ChartType` enum, không hard-code list | Phase-3 từng miss HORIZONTAL_BAR + BAR_LINE |
| Khi rename measure, FE gửi `rename_map` để BE auto-rewrite | Tránh chart vỡ silent |

---

## 5. Cross-module dependencies

| From | To | Constraint |
|---|---|---|
| Chart | DatasetTable | FK `dataset_table_id`, ON DELETE SET NULL |
| Chart | ChartMetadata | 1:1 cascade delete |
| Chart | ChartParameter | 1:N cascade delete |
| Chart | DashboardChart | 1:N, **delete chart blocked** nếu link còn |
| Chart | Public link | Indirect qua DashboardChart |

---

## 6. Endpoint reference

| Endpoint | Purpose | File |
|---|---|---|
| `POST /charts/` | Create | api/charts.py |
| `PUT /charts/{id}` | Update | api/charts.py |
| `DELETE /charts/{id}` | Delete (block khi link dashboard) | api/charts.py |
| `GET /charts/{id}/data` | Render data | api/charts.py |
| `POST /charts/preview-data` | Preview chưa save | api/charts.py |
| `GET/PUT /charts/{id}/description` | AI description | api/charts.py |
| `POST /charts/{id}/description/regenerate` | Regen | api/charts.py |
| `GET/PUT /charts/{id}/metadata` | Metadata CRUD | api/charts.py |
| `GET/PUT /charts/{id}/parameters` | Parameters | api/charts.py |

---

## 7. Validation matrix

| Field | Validation |
|---|---|
| `name` | required, 1-255 chars |
| `chart_type` | enum (32 values) |
| `dataset_table_id` | required, FK exists |
| `config` | dict, phải có ≥1 recognised role key (Phase-9) |
| `metric.agg` | sum/avg/count/min/max/count_distinct/auto (Phase-3) |

---

## 8. Phase history

- **Phase-10 (2026-05-15)**: Fix Explore vs Dashboard data divergence
  + Dashboard AI Bot empty-context bug.
  - **Issue A — Explore vs Dashboard divergence** (chart SCATTER /
    MAP_POINT khi mở trong Explore preview ra số/keys khác với
    Dashboard, dù cùng 1 chart). Root cause:
    `ChartService.preview_chart_data` không gọi
    `with_chart_semantic_binding` trước khi route. Dashboard (`/data`)
    đi qua `get_by_id` → `hydrate_runtime_config` nên binding được
    enrich với `dimensionFields` / `reachableFields` / … khi đó
    `_role_config_needs_semantic_runtime` trả `True` → semantic engine
    emit keys dạng `view.field`. Preview với binding rút gọn
    (`baseViewName`, `exploreName`, `modelId`, `exploreId`) → trả
    `False` → live_query path → keys bare. FE lookup
    `row["view.field"]` miss → axis empty / sai số.
    Fix: preview hydrate binding trước routing, cùng tham số
    `auto_generate=True` như create/update path.
    Regression: 32/32 demo charts identical giữa `GET /data` và
    `POST /preview-data`.
  - **Issue B — Dashboard BYOK AI Bot luôn trả "I don't have data"**
    (endpoints `GET /public/dashboards/{token}/ai/context` +
    `POST /public/dashboards/{token}/ai/chat`). Root cause:
    `dashboard_ai_service.build_ai_context` assume
    `ChartService.get_chart_data()["data"]` là dict
    `{columns, rows}` rồi gọi `.get("columns")`. Thực tế shape là
    `list[dict]` (mỗi row 1 dict). AttributeError bị swallow bởi
    `except Exception` → `columns=[]`, `rows=[]` cho mọi chart → system
    prompt rỗng → LLM trả "I don't have data on that".
    Fix: normalize cả 2 shape (list[dict] và legacy {columns,rows}),
    giống pattern `dashboard_ai_bot.tools._fetch_chart_data` đã làm.
    Cập nhật docstring `insight_pack.py` (đã sai từ trước).
    Verify: build_ai_context cho `[Demo] Phase-3 dashboard` trước fix
    trả 4 charts với 0 cols / 0 rows; sau fix trả full cols + rows.
  - Agent path (`POST /ai/agent/chat`), PDF endpoint
    (`/ai/dashboard.pdf`), public chart endpoint, dashboard CRUD —
    đã audit và safe (đã normalize shape qua tools.py).
  - **Issue C — AI Bot bị mù viewer-applied slicer filters**. Dashboard
    UI cho phép user thay đổi slicer (vd chọn "metatype = task"); chart
    tiles re-render đúng vì `GET /public/dashboards/{token}/charts/{id}/data`
    nhận `filters` query param và merge với `public_filters` từ link.
    Nhưng `POST /ai/agent/chat`, `POST /ai/chat`, `GET /ai/context`,
    `POST /ai/briefing/brief`, `GET /ai/briefing/guess` đều CHỈ pass
    `public_filters` từ link, không nhận viewer state → AI Bot lấy data
    KHÔNG filter → trả số tổng cả dataset trong khi user đang xem 1
    slice. Sai số nguy hiểm.
    Fix: thêm `viewer_filters: list[dict] | None` vào
    `_AiChatBody` / `_AiAgentChatBody` / `_AiBriefingBriefBody`; 2 GET
    endpoints (`/ai/context`, `/ai/briefing/guess`) nhận qua query
    `filters` JSON-encoded; mọi endpoint merge bằng
    `_dedupe_filters_by_field(public + viewer)` rồi pass vào
    `ToolContext.from_dashboard(...)` hoặc `build_ai_context(...)`.
    FE: `<DashboardAiBot>` nhận prop `viewerFilters`, page
    `app/d/[token]/page.tsx` truyền state `appliedViewerFilters`.
    `streamAiAgentChat` API client nhận thêm tham số `viewerFilters` và
    đính vào body JSON.
    Verify: build_ai_context cho `[Demo] Phase-3 dashboard` —
    không filter: 7 rows tổng, có filter `metatype=task`: 4 rows tổng,
    chart 308 drop row `subtask`. SQL được áp dụng đúng tại semantic
    engine, không phải filter client-side.

- **Phase-9 (2026-05-15)**: Chart audit, fix config validation gap.
  - Validator yêu cầu `config` có ít nhất 1 recognised role container
    (`roleConfig` / `generatedRoleConfig` / `customRoleConfig` /
    `customSql` / `semanticBinding`) — chặn empty/garbage configs vào DB.
  - 32/32 production charts pass new validator (verified trước khi
    apply để không break legacy data).
  - Audit phát hiện 5 critical, verify chỉ 1 thật. Skip Issue 1
    (FE bypass chartApi cho description — organizational, không impact
    runtime). Skip Issue 2/4/5 (false alarm).

---

## 9. Backlog (chưa làm)

- ❌ Issue 1 (medium): FE description hooks bypass `chartApi` wrapper.
  Tổ chức code, không gây bug. Làm khi có capacity refactor FE API
  layer.
- ❌ ChartParameter UI — endpoints có nhưng UI để edit parameter định
  nghĩa hiện ít exposed. ExploreEditor có gọi `replaceParameters`
  nhưng UI flow chưa rõ ràng cho user thông thường. Cần audit UX khi
  có request.
