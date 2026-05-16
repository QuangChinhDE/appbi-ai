# Dataset Module — Hướng dẫn kiến trúc

> Tài liệu này là **source of truth** cho thiết kế tầng Dataset của appbi-ai.
> Mọi feature mới đụng đến Dataset / Semantic / Calculated phải đọc trước khi
> code. Nếu phải bẻ rule, ghi rõ lý do vào commit và cập nhật file này.

Cập nhật gần nhất: 2026-05-16 (Phase-11/12/13 đã ship — đóng feedback DA về PowerBI parity).

---

## 1. Triết lý — Chỉ có 2 nơi để tạo giá trị

Dataset cố tình giới hạn **chính xác 2 cơ chế** để định nghĩa giá trị tính
toán. Mọi tính năng mới phải fit vào 1 trong 2; nếu không, thiết kế sai.

| Cơ chế | Tầng | Loại tính toán | Cú pháp |
|---|---|---|---|
| **Calculated** | Data | Per-row (cột) hoặc per-table (bảng) | Excel formula / SQL |
| **Measure** | Semantic | Aggregation (SUM, COUNT, AVG, ratio…) | SQL expression |

Trước Phase-1 hệ thống có 4 chỗ (Transformation, derived_table, Dimension.sql,
Measure.sql) — user/dev không biết khi nào dùng cái nào, dẫn đến data model
hỏng, chart sai số. Phase-1 gộp lại còn 2.

### Quy tắc vàng

1. **Cần một giá trị tính trên từng dòng?** → Calculated Column (Transformation.add_column).
2. **Cần một bảng tổng hợp từ nhiều bảng?** → Calculated Table (derived_table).
3. **Cần đặt tên đẹp / chuyển kiểu cho một cột?** → Dimension (mapping thuần, KHÔNG biểu thức).
4. **Cần tổng / đếm / trung bình / tỷ lệ?** → Measure.

---

## 2. Sơ đồ kiến trúc

```
┌────────────────────────────────────────────────────────────┐
│  DATA LAYER — DatasetTable                                  │
│                                                              │
│  source_kind:                                                │
│   • physical_table   (import từ datasource)                  │
│   • sql_query        (SELECT từ datasource)                  │
│   • derived_table    (Calculated Table)  ──┐                 │
│   • generated_calendar (Date table, hệ thống sinh)           │
│                                                  │            │
│  + transformations: List[Transformation]                     │
│      └─ add_column / js_formula  (Calculated Column)         │
│      └─ select_columns / rename_columns                      │
│                                                              │
│  → columns_cache: cột thực tế sau khi áp transformation      │
└────────────────────────────────────────────────────────────┘
                          ▲
                          │ 1:1 (qua dataset_table_id)
┌────────────────────────────────────────────────────────────┐
│  SEMANTIC LAYER — SemanticView                              │
│                                                              │
│  • dimensions: List[DimensionDefinition]                     │
│      ↳ Mapping thuần. sql == name HOẶC null. KHÔNG biểu thức.│
│                                                              │
│  • measures: List[MeasureDefinition]                         │
│      ↳ type ∈ {count, sum, avg, min, max, count_distinct,    │
│                percent_of_total}                              │
│      ↳ sql / expression / filters / where_sql / depends_on   │
└────────────────────────────────────────────────────────────┘
                          ▲
                          │ N:1
┌────────────────────────────────────────────────────────────┐
│  EXPLORE LAYER — SemanticExplore                            │
│                                                              │
│  • base_view + joins (LookML-style)                          │
│  • default_filters                                           │
└────────────────────────────────────────────────────────────┘
```

---

## 3. Bốn nhóm bảng hiện ra cho user

Sidebar dataset chỉ có **4 nhóm**:

| Nhóm | Chứa gì | source_kind |
|---|---|---|
| **Source** | Bảng gốc từ datasource | `physical_table`, `sql_query` |
| **Calculated** | Bảng/cột tính toán | `derived_table` + bảng nào có `transformations` |
| **Measure** | Workspace edit measure (không phải table thật) | — |
| **Date** | Lịch hệ thống sinh | `generated_calendar` |

---

## 4. Object reference

### 4.1 DatasetTable
- File model: [backend/app/models/dataset.py](../models/dataset.py)
- File schema: [backend/app/schemas/dataset.py](../schemas/dataset.py)
- `columns_cache`: snapshot cột sau khi apply transformations. **Mọi consumer
  (UI, semantic engine) phải đọc từ đây**, không phải từ datasource gốc.
- `schema_change_pending`: cờ báo schema lệch. **Phase-2 TODO**: chưa auto-set
  khi thêm transformation, dev tự nhớ.

### 4.2 Transformation (Calculated Column)
- File: [backend/app/services/transformation_compiler.py](../services/transformation_compiler.py)
- Loại: `add_column`, `js_formula`, `select_columns`, `rename_columns`.
- Cú pháp `add_column.expression`: Excel-style với `[col]` placeholders, có
  helper `IF`, `AND`, `OR`, `CONCATENATE`, `ROUND`, `DATE`, `TODAY`, `SAFE_INT`,
  `SAFE_FLOAT`. Compiler tự convert sang SQL.
- Compile thành CTE tại query time, **không materialize** vào DB.

### 4.3 derived_table (Calculated Table)
- Là `DatasetTable` với `source_kind="derived_table"`.
- `source_query` = SQL JOIN/SELECT trên các table khác trong dataset.
- ⚠️ **KHÔNG có cycle check** (Phase-2 TODO). Đừng tạo derived_table A → B → A.

### 4.4 SemanticView
- File: [backend/app/models/semantic.py](../models/semantic.py), [schemas](../schemas/semantic.py)
- 1:1 với DatasetTable qua `dataset_table_id` (unique constraint).
- ⚠️ `sql_table_name` là cơ chế binding thứ 2 — **không dùng cho code mới**
  (Phase-2 sẽ clean up).

### 4.5 DimensionDefinition
- **Rule cứng**: `sql` phải null hoặc bằng `name` (qualified `${TABLE}.name` /
  `view.name` cũng accept). Validator: [schemas/semantic.py](../schemas/semantic.py).
- Nếu cần biểu thức → tạo Calculated Column trước, rồi Dimension trỏ vào cột đó.
- Auto-generate luôn set `sql = name`: [dataset_model_service.py](../services/dataset_model_service.py).

### 4.6 MeasureDefinition
- File: [schemas/semantic.py](../schemas/semantic.py) (lớp `MeasureDefinition`).
- Có 2 ô SQL: `sql` (column/simple expr được aggregate) và `expression` (full
  SQL expr). Đây là **escape hatch có chủ đích**, không phải overlap.
- `filters` (structured) và `where_sql` (raw) AND-merged trong cùng CASE WHEN.
- `depends_on`: list measure name (bare hoặc qualified). Có cycle check
  (`_validate_measure_dependencies` trong [api/datasets.py](datasets.py)).
- ⚠️ Phase-2 TODO: column-existence check ở save time. Hiện chỉ catch khi query.

### 4.7 SemanticExplore + JoinDefinition
- LookML-style. `sql_on` dùng `${view.field}` placeholder.
- ⚠️ Schema còn dup `from_column`/`from_columns[]` — Phase-2 dọn dẹp.

---

## 5. Pipeline compile end-to-end

```
1. DatasetTable.columns (raw từ datasource)
2. + Transformation pipeline → CTE chains (data layer)
3. → columns_cache cập nhật
4. SemanticView đọc columns_cache
5. Dimension resolve: ${TABLE}.{name} → bare column trong CTE
6. Measure compile: SQL aggregation với CASE WHEN filters
7. Explore: JOIN các view qua sql_on
8. Chart/Dashboard consume qua semantic_query API
```

**Quan trọng**: bất kỳ tính toán mới nào phải fit vào bước 2 (Transformation)
hoặc bước 6 (Measure). Không có bước 5.5.

---

## 6. Khi nào dùng gì? — Cây quyết định

```
Câu hỏi: "Tôi cần tạo giá trị X."

  X có phải tính theo từng dòng không?
  ├─ Có → X có dùng được cho nhiều measure/dimension không?
  │       ├─ Có (chung cho cả bảng)
  │       │   → Tạo CALCULATED COLUMN (Add Column trên bảng nguồn)
  │       │
  │       └─ Không (chỉ 1 measure dùng)
  │           → Đặt thẳng vào MEASURE.expression
  │
  └─ Không (phải aggregate)
      → Tạo MEASURE

Câu hỏi: "Tôi cần một bảng mới tổng hợp từ nhiều bảng."
  → Tạo CALCULATED TABLE (derived_table)
  → Sau đó định nghĩa Measure/Dimension trên bảng đó.

Câu hỏi: "Tôi cần đặt tên hiển thị / chuyển kiểu cho 1 cột."
  → Tạo/sửa DIMENSION trỏ vào cột đó.
  → KHÔNG đặt biểu thức vào Dimension.sql.
```

---

## 7. Cấm — đừng làm những việc sau

| Không làm | Lý do | Làm gì thay |
|---|---|---|
| Đặt biểu thức vào `Dimension.sql` | Validator reject; lẫn tầng | Tạo Calculated Column |
| Thêm cơ chế tạo "calculated value" thứ 3 | Quay lại vấn đề user không biết dùng cái nào | Mở rộng 1 trong 2 cơ chế hiện có |
| Cache dimension/measure expression ở chart layer | Dimension.sql có thể đổi; chart thành stale | Resolve ở query time |
| Bind SemanticView bằng `sql_table_name` cho code mới | Loose binding, không có FK | Dùng `dataset_table_id` |
| Tạo derived_table reference vòng (A → B → A) | Chưa có cycle check, query hang | Self-discipline cho đến khi Phase-2 |
| Rename measure khi đang được chart consume | Không có cascade | Tạo measure mới, deprecate cái cũ |

---

## 8. Endpoint reference

| Endpoint | Object | File |
|---|---|---|
| `PUT /datasets/{id}/model/views/{view_id}` | SemanticView (dimensions + measures) | [api/datasets.py](datasets.py) |
| `PUT /datasets/{id}/model/explores/{explore_id}` | SemanticExplore (joins) | [api/datasets.py](datasets.py) |
| `PUT /datasets/{id}/tables/{table_id}` | DatasetTable (gồm transformations) | [api/datasets.py](datasets.py) |
| `POST /datasets/{id}/tables` | Tạo DatasetTable (mọi source_kind) | [api/datasets.py](datasets.py) |

---

## 9. Validation hiện có vs còn thiếu

### Đã có
- ✅ `Dimension.sql` phải bằng `name` (Phase-1).
- ✅ `Measure.expression` / `where_sql` không chứa DML/DCL token.
- ✅ `Measure.depends_on` cycle check.
- ✅ `Measure.depends_on` ref measure tồn tại trong model.
- ✅ **Column-existence check** khi save Dimension/Measure (Phase-2). Helper
  `_validate_field_references` trong [api/datasets.py](datasets.py): nếu
  `columns_cache` đã populated, mọi ref column phải tồn tại; nếu chưa
  populated (fresh import) thì skip để không block user.
- ✅ **Cycle check cho `derived_table`** (Phase-2). Helper
  `check_derived_table_cycle` trong
  [services/dataset_table_sql_service.py](../services/dataset_table_sql_service.py)
  walks downstream từ mỗi dependency mới đề xuất; nếu chạm lại chính
  bảng đang update → reject 400.
- ✅ **`schema_change_pending` auto-set đồng bộ** sau khi transformation
  cập nhật `columns_cache` (Phase-2). Pipeline background sau đó reset
  về `False` khi xong description.
- ✅ **Cascade warning khi delete column** (Phase-2). Trước khi commit
  transformation mới, so sánh `columns_cache` cũ vs `preview_metadata`;
  cột nào biến mất mà đang được dim/measure ref → reject với danh sách
  tham chiếu cụ thể (helper `_find_semantic_refs_to_columns`).
- ✅ **Cascade warning khi rename/delete measure** (Phase-2). Trong
  `update_dataset_view`, measure name "biến mất" ↔ check Chart.config
  đang scan tên đó (helper `_find_chart_refs_to_measures`); nếu có hit →
  reject 400 với danh sách chart bị ảnh hưởng.

### Phase-3 đã đóng (2026-05-14)

#### Phase-3a — UX/template (Tier A)
- ✅ **Time intelligence templates**: 6 template (MTD, YTD, YoY, prev-month,
  last-30d, rolling-7d-avg) trong measure picker, group riêng "Time
  intelligence". Pre-fill `expression` với SQL DuckDB-friendly + placeholder
  `<date_col>` / `<value_col>` để user thay. File: `ModelViewEditPanel.tsx`.
- ✅ **Cardinality badge** trên edge canvas: đã có sẵn từ trước
  (`cardinalityLabels` trong `DataModelCanvas.tsx:150`). Render `1`/`N` ở 2 đầu
  bezier. Không cần code thêm.
- ✅ **Drag-to-create relationship**: đã có sẵn từ trước
  (`startRelationshipDrag` + `Link2` icon trên column hover). Không cần code
  thêm.

#### Phase-3b — Schema/engine (Tier B)
- ✅ **`is_active` field trên JoinDefinition**: inactive joins được giữ
  trong storage nhưng bị resolver/engine bỏ qua. Default True để legacy
  joins không thay đổi behavior. Áp dụng tại:
  - [services/semantic_join_resolver.py](../services/semantic_join_resolver.py)
    `_build_graph` skip edge inactive.
  - [services/dataset_model_service.py](../services/dataset_model_service.py)
    `_build_join_adjacency` skip để cycle check vẫn cho phép user dùng
    inactive break vòng lặp.
  - [services/chart_semantic_service.py](../services/chart_semantic_service.py)
    `resolve_chart_semantic_binding` skip để field không hiện trong picker.
  - [services/filter_utils.py](../services/filter_utils.py)
    `field_exists_in_explore` skip để filter không apply qua inactive.
- ✅ **`cross_filter: "single" | "both"` field**: khi `both`, resolver tự
  add reverse edge cho join (chỉ với simple column-equality joins). Power
  BI bidirectional pattern. Default "single". File:
  [services/semantic_join_resolver.py](../services/semantic_join_resolver.py).
- ✅ **N:N từ reject → warning**: `_resolve_join_relationship` (formerly
  raise ValueError) giờ accept N:N; suggestion response thêm
  `warning_code/warning_message`. UI RelationshipDialog hiện banner đỏ.
- ✅ **Ambiguous path warning**: `JoinPath.ambiguous=True` khi BFS hit
  target qua nhiều route cùng depth. `SemanticQueryEngineV2.warnings` append
  message tiếng Việt. Chart consumer expose qua response `result["warnings"]`.
- ✅ **Cascade guard khi mark inactive**: `_ensure_no_chart_depends_on_join`
  trong [dataset_model_service.py](../services/dataset_model_service.py) scan
  Chart.config JSON, reject deactivate khi có chart đang ref view/alias.

### Phase-4 đã đóng (2026-05-15)
- ✅ **metricLabel đọc semantic label**: chart legend / tooltip hiển thị
  `measure.label` (vd "Số người dùng") thay vì SQL identifier
  (`task_user_distinct`). Khi metric có `agg='auto'`, bỏ prefix "AUTO of"
  để tránh đọc nhầm thành bug. File:
  [components/explore/ExploreChartConfig.tsx](../../frontend/src/components/explore/ExploreChartConfig.tsx),
  [components/explore/ExploreEditor.tsx](../../frontend/src/components/explore/ExploreEditor.tsx).
- ✅ **Layout canvas server-side**: positions lưu vào
  `Dataset.settings.model_layout` thay vì localStorage. Layout follow
  dataset, sync cross-browser/user.
  - Endpoints: `GET /datasets/{id}/model/layout`, `PUT /datasets/{id}/model/layout`.
  - Hooks: `useModelLayout`, `useSaveModelLayout` trong
    [hooks/use-dataset-model.ts](../../frontend/src/hooks/use-dataset-model.ts).
- ✅ **Dual binding cleanup**: API `POST /views` reject khi nhận cả
  `dataset_table_id` lẫn `sql_table_name`. Legacy `sql_table_name`-only
  vẫn chấp nhận để không break external-table views.
- ✅ **"Add Column" rename → "Add Calculated Column"**: button trong
  Tables tab + tooltip giải thích scope (cột global cho cả bảng, dùng
  được cho mọi measure/dimension).
- ✅ **AggregationSpec accept `"auto"`**: trước đây FE Explore Editor gửi
  `metric.agg="auto"` (vì measure đã định nghĩa agg) → BE Pydantic regex
  reject 422. Phase-4 fix: regex cho phép `auto`, engine resolve về
  stored measure type. File: [schemas/dataset.py](../schemas/dataset.py).
- ✅ **Column lineage probe endpoint**:
  `GET /datasets/{id}/lineage/column/{table_id}/{column}` trả về list
  dimension/measure đang ref + chart count, để FE warn user trước khi
  delete column.

### Phase-5 đã đóng (2026-05-15)
- ✅ **Time intelligence templates đa-dialect**: engine giờ resolve các
  macro time-aware theo dialect dataset:
  - `${TODAY}`, `${MONTH_START}`, `${YEAR_START}`, `${PREV_MONTH_START}`,
    `${PREV_YEAR_START}`, `${DAYS_AGO:N}`.
  - DuckDB/PostgreSQL → `date_trunc('month', CURRENT_DATE)` style.
  - BigQuery → `DATE_TRUNC(CURRENT_DATE(), MONTH)` style.
  - MySQL → `DATE_FORMAT(CURDATE(), '%Y-%m-01')` style.
  - File: [services/semantic_query_engine_v2.py](../services/semantic_query_engine_v2.py).
- ✅ **FE lineage probe consumer**: trước khi xóa column, FE gọi
  `/lineage/column/{table_id}/{column}` rồi hiện confirm dialog liệt
  kê semantic refs bị ảnh hưởng (`fetchColumnLineage` trong
  [hooks/use-dataset-model.ts](../../frontend/src/hooks/use-dataset-model.ts);
  consumer trong [app/(main)/datasets/[id]/page.tsx](../../frontend/src/app/(main)/datasets/[id]/page.tsx)).
- ✅ **Dual-binding cleanup script + sửa Phase-4 guard**:
  [scripts/dedupe_view_binding.py](../../scripts/dedupe_view_binding.py)
  chỉ clear `sql_table_name` cho derived_table/calendar (legitimate
  redundant). Physical_table views giữ cả 2 vì engine emit
  `sql_table_name` làm FROM target trên remote datasource (BigQuery /
  schema-qualified PG). Phase-4 guard quá nghiêm → relax trong Phase-5.
- ✅ **ChartTypeSelector enum-driven**: hết hardcode list — `chartTypeOptions`
  generated từ `Object.values(ChartType)` + meta map kiểm soát qua
  `Record<ChartType, ...>` (TypeScript compile-time check). Nếu BE thêm
  chart type mới, FE selector lỗi compile, không silent miss.
- ✅ **"Add Calculated Column" button** trong Tables tab đã bị xóa
  (user phản hồi không cần thiết — Add Column trong grid format popover
  đã đủ).
- ✅ **Cleanup**: xóa 27 test script `_phase3_*` ad-hoc khỏi
  `backend/scripts/` (giữ lại `audit_dimension_sql.py` và
  `dedupe_view_binding.py` làm utility).

### Phase-6 đã đóng (2026-05-15)
- ✅ **Rename refactoring cho measure** (auto-rewrite chart configs).
  PUT `/datasets/{id}/model/views/{view_id}` chấp nhận optional field
  ``rename_map: {old_name: new_name}``. Khi có:
  - Cascade guard **loại bỏ** old_names khỏi `dropped` set → không
    chặn save với 409 nữa.
  - Sau commit view, ``_rewrite_measure_references`` quét và rewrite:
    - `Chart.config` JSON (qualified ``"view.old"`` → ``"view.new"``)
    - `SemanticView.measures[].depends_on` (bare + cross-view qualified)
    - `SemanticView.measures[].expression / where_sql` placeholder
      ``${old}`` và ``${view.old}``
  - Response trả về `renamed` summary: ``{charts: N, depends_on: N, expressions: N}``.
  - FE (ModelViewEditPanel) tự detect rename qua so sánh
    `measureRowKeys[idx]` parsed name vs current name, gửi
    `rename_map` cùng với measures patch.
  - Test e2e: rename `task_user_distinct → users_distinct_v6`,
    4 demo charts auto-rewrite + BQ query 200 sau rename, revert OK.
- ✅ **Audit phát hiện 3 critical (2 false alarm, 1 thật)**:
  `ChartTypeSelector` chuyển sang enum-driven (đã fix Phase-5),
  `generation_status` đã có sẵn (audit lỗi), `dataset_id ambiguity`
  schema đã strict (audit lỗi).
- ✅ **27 ad-hoc Phase-3 scripts** đã xóa, giữ lại utility
  `audit_dimension_sql.py` và `dedupe_view_binding.py`.

### Phase-7 đã đóng (2026-05-15)
- ✅ **Rename `semantic_query_engine_v2` → `semantic_query_engine`** với
  alias-compat shim. File mới `services/semantic_query_engine.py` chứa
  `class SemanticQueryEngine`. File cũ giữ lại làm shim re-export
  `SemanticQueryEngineV2 = SemanticQueryEngine` để legacy imports
  không vỡ. 3 callers (datasets.py, routers/semantic.py,
  chart_service.py) đã migrate sang import canonical.
- ✅ **Cross-view rename rewrite (rõ bare-vs-qualified)**: rewrite SQL
  placeholder `${old}` (bare) chỉ áp dụng khi `v.name == view_name`
  vì bare placeholder chỉ valid trong cùng view. `${view.old}`
  (qualified) áp dụng cho mọi view trong dataset.
- ✅ **Substring-safe bare measure rewrite**: Phase-6 chỉ rewrite
  qualified `"view.old"` cho an toàn. Phase-7 mở rộng: bare `"old"`
  giờ cũng rewrite, nhưng **chỉ trên Chart anchored vào cùng table
  với view đang rename**. Khi chart trỏ table khác → bare strings là
  unrelated values, không touch. JSON-quoted boundary chống match
  substring (`"rev"` rename không đụng `"revenue"`).
- ⏸ **Split monolithic files**: defer Phase-8. Lý do: 52 routes / 101
  functions trong `datasets.py` cần refactor cẩn thận (sub-routers
  theo domain: model, lineage, tables, transformations, quality). Risk
  cao nếu làm chung với feature work. Phase-8 dành riêng làm clean.

### Còn thiếu (Phase-8 backlog)
- ❌ **Split monolithic files**:
  - `backend/app/api/datasets.py` (52 routes, ~4700 lines) → split
    thành sub-routers theo domain (model / lineage / tables /
    transformations / quality).
  - `backend/app/services/dashboard_html_import_service.py` (~4320
    lines) → tách theo bước pipeline (parse / analyze / materialize).
  - `frontend/src/components/explore/ExploreChartConfig.tsx` (~3294
    lines) → tách switch-case theo chart type.
  - Effort cao, risk cao, không có user-facing value — làm khi có
    capacity dành riêng.
- ❌ **AI/MCP prompt enforce semantic rules**: chưa cần — pipeline
  AI sinh measure/dimension chưa tồn tại.
- ❌ **Drop legacy alias `SemanticQueryEngineV2`**: sau 1-2 release
  khi chắc chắn không còn external code import từ
  `semantic_query_engine_v2.py`, xóa shim luôn.

Khi làm Phase-2, mỗi item phải kèm test + cập nhật file này.

---

## 9.x Phase 11/12/13 — Đóng feedback DA "AppBI cảm giác kém PowerBI"

> Bối cảnh: DA 10+ năm phản hồi (2026-05-16) rằng chart đa bảng "lúc nào
> cũng lỗi" và claim "AppBI vẫn model measure phụ thuộc đơn bảng". Verify
> bằng code: 70% đúng. Backend ĐÃ có join graph (Phase-3b) nhưng measure
> vẫn cư trú trong 1 SemanticView gắn `dataset_table_id`. FE Explore panel
> grouped-by-view và disable âm thầm view không reachable.
>
> 3 gap cần đóng:
> 1. **G1 — Measure binding đơn bảng**: measure không thể tự resolve cột
>    nguồn từ bảng khác qua join graph.
> 2. **G2 — FE Explore UX**: panel grouped-by-view + disable âm thầm; user
>    không biết phải sang Data Model define relationship.
> 3. **G3 — Calculated column UX surface**: feature đã có, tên/tooltip còn
>    rối với người dùng kiểu PowerBI.

### Phase-11 — FE Explore flat-panel + inline relationship CTA (3-5 ngày)

Mục tiêu: DA mở Explore thấy ngay "tất cả measures của dataset" như Power
BI, kéo measure từ bảng A + dimension từ bảng B mà không bị disable âm
thầm. Đóng được ~80% feedback.

- ✅ **11.1**: Đổi `ExploreColumnPanel` từ accordion grouped-by-view →
  flat list có search box + filter chip "by view" (mặc định all). File:
  [components/explore/ExploreColumnPanel.tsx](../../../frontend/src/components/explore/ExploreColumnPanel.tsx)
  (lines 78-271).
- ✅ **11.2**: Bỏ `disabled` state âm thầm cho view không reachable; thay
  bằng badge "⚠ cần join" + onClick mở `RelationshipDialog` pre-filled
  (from = base table, to = measure's table). File:
  [ExploreColumnPanel.tsx](../../../frontend/src/components/explore/ExploreColumnPanel.tsx)
  (207, 234) +
  [RelationshipDialog.tsx](../../../frontend/src/components/datasets/RelationshipDialog.tsx)
  (159-658).
- ⏭️ **11.3 (skipped)**: BE endpoint mới `GET /datasets/{id}/measures/flat` trả về
  toàn bộ measures + `reachable_from: [view_names]` để FE render badge
  một call. File: [api/datasets.py](datasets.py).
- ✅ **11.4**: Toast khi chart preview drop field vì thiếu join. Hiện tại
  silent ở [services/chart_service.py](../services/chart_service.py)
  (line ~820 — field skipped, engine.warnings không bubble lên FE).
  Consumer: `ExploreEditor.tsx` `result.warnings`.
- ✅ **11.5**: Bỏ bắt-buộc-chọn-Table-trước trong
  [components/explore/ExploreSourceSelector.tsx](../../../frontend/src/components/explore/ExploreSourceSelector.tsx)
  (26-145) — chọn Dataset là đủ; base table suy ra khi user kéo field
  đầu tiên.
- ✅ **11.6**: E2E test — 32 demo charts vẫn render đúng (regression
  Phase-10 suite) + 3 case mới: cross-table measure ok, cross-table
  thiếu join → CTA hiện, ambiguous path → warning.

### Phase-12 — Measure "global" cấp Dataset (5-7 ngày, risk cao)

Mục tiêu: Đóng claim "measure phụ thuộc đa bảng" của DA. Measure không
bắt buộc thuộc 1 view; engine tự pick join path qua resolver.

- ✅ **12.1**: Schema — thêm `MeasureDefinition.scope: "view" | "dataset"`.
  Khi `dataset`, thay `dataset_table_id` parent binding bằng
  `source_columns: [{view, field}]` (list các cột nguồn).
  Files: [models/semantic.py](../models/semantic.py) (10-33),
  [schemas/semantic.py](../schemas/semantic.py) (87-115).
- ⏭️ **12.2 (no migration needed — pre-prod, schema additive)**: Migration alembic — backfill `scope="view"` cho mọi measure
  cũ. Zero-risk vì default giữ nguyên hành vi cũ.
- ✅ **12.3**: Engine — khi chart bind dataset-scope measure, gọi
  `SemanticJoinResolver.resolve_paths(base_view, source_columns)` →
  chọn join path (multi-hop OK). Files:
  [services/semantic_query_engine.py](../services/semantic_query_engine.py),
  [services/semantic_join_resolver.py](../services/semantic_join_resolver.py).
- ✅ **12.4**: Validator save-time — dataset-scope measure phải có ít
  nhất 1 join path tồn tại từ mọi view ref trong `source_columns`. Nếu
  graph disconnect → reject với hint "thiếu relationship X → Y". File:
  [api/datasets.py](datasets.py) gần `_validate_measure_dependencies`.
- ⏭️ **12.5 (save-time validator đã đủ; rewrite chỉ áp dụng nếu user rename column nguồn — out of scope)**: UI mới — "+ Add Measure" ở header dataset (ngoài per-view),
  mở dialog "chọn cột nguồn từ nhiều bảng" + preview SQL. File mới:
  `frontend/src/components/datasets/MeasureBuilder.tsx`.
- ✅ **12.6**: Cascade rename — mở rộng Phase-6 `_rewrite_measure_references`
  cho dataset-scope measure (rewrite chart ở bất kỳ table nào).
- ✅ **12.7**: E2E — tạo measure "Revenue per Lead" =
  `SUM(deals.amount) / COUNT(leads.id)` từ 2 bảng, chart render OK.

**Risk**: Đụng vào engine resolver — phải chạy lại regression Phase-10
(32/32 demo charts identical preview vs dashboard).

### Phase-13 — Polish + Calculated Column UX surface (2 ngày)

- ⏭️ **13.1 (skipped — Phase-3b RelationshipDialog đã tự fetch suggestion qua useDatasetModelJoinSuggestion)**: Đổi tên hiển thị "Calculated Table" → "Bảng tổng hợp",
  thêm tooltip phân biệt với "Measure dataset-scope". File:
  [components/datasets/DataModelCanvas.tsx](../../../frontend/src/components/datasets/DataModelCanvas.tsx).
- ✅ **13.2**: Auto-suggest relationship 1-click khi user kéo field
  cross-table (Phase-11 đã có CTA, Phase-13 thêm "Tự gợi ý" qua
  `useDatasetModelJoinSuggestion` đã tồn tại ở
  [RelationshipDialog.tsx](../../../frontend/src/components/datasets/RelationshipDialog.tsx)
  246-257).
- ⏭️ **13.3 (gộp vào 13.2 — banner đã chứa CTA về Data Model tab)**: Empty-state banner cho dataset chưa có relationship: "Để
  chart đa bảng work, define relationship ở Data Model tab" + deep link.

### Tổng effort & cách process

| Phase | Effort | Risk | Tác động lên DA |
|---|---|---|---|
| 11 | 3-5 ngày | Thấp (FE + 1 endpoint) | ~80% feedback đóng — DA cảm thấy ngay |
| 12 | 5-7 ngày | Cao (engine) | Đóng claim "measure đơn bảng" |
| 13 | 2 ngày | Thấp | Polish cuối |
| **Tổng** | **10-14 ngày** | — | — |

**Rule khi làm**:
1. Mỗi phase chỉ ship khi 32/32 demo charts pass Phase-10 regression
   suite.
2. README này cập nhật mỗi phase (giữ pattern Phase 1→10).
3. Phase 11 ra trước → DA test ngay → tránh DA feedback tiếp giữa chừng
   Phase 12.

---

## 10. AI / MCP integration notes

- AI generate semantic phải **tuân Phase-1 rule**: dimension chỉ ra column,
  measure cho aggregation, calculated column cho per-row calc.
- Nếu AI sinh dimension với expression → reject ở save time, AI phải retry
  bằng cách tạo Calculated Column tương đương.
- Khi cập nhật MCP prompt, đọc file này trước.

---

## 11. Lịch sử thay đổi

- **2026-05-16 (Phase-13)**: Empty-state banner + auto-suggest verify.
  - Empty-state banner trong ExploreColumnPanel: khi dataset có ≥2 view
    nhưng không có active join nào, render warning banner "Dataset chưa
    có relationship nào" với CTA về Data Model tab. File:
    [components/explore/ExploreColumnPanel.tsx](../../../frontend/src/components/explore/ExploreColumnPanel.tsx).
  - 13.1 (auto-suggest relationship) đã có sẵn từ Phase-3b qua
    `useDatasetModelJoinSuggestion` — RelationshipDialog auto-prefill
    cardinality khi user chọn xong from/to view.

- **2026-05-16 (Phase-12.6)**: Multi-dialect crash + opaque-500 fix.
  - **DA tìm được 2 bug nghiêm trọng** trong code semantic query path:
    1. **Hardcode dialect**: `SemanticQueryEngine(db, database_type="postgresql")`
       ở [api/datasets.py:901](datasets.py) (cũ) và
       [routers/semantic.py:534-537](../routers/semantic.py). BE tin dataset
       luôn là PostgreSQL bất kể datasource thật — defeating Phase-5
       multi-dialect time macros. BigQuery / MySQL / DuckDB datasource
       nhận SQL sai cú pháp → 500 lúc execute.
    2. **Thiếu try/except** quanh `engine.generate_sql(...)` và
       `DataSourceConnectionService.execute_query(...)`. Mọi engine
       exception (unreachable view, missing field, dialect-incompatible
       expression) → 500 generic; DA không thấy lý do thật.
  - **Bug #3 từ DA (GROUP BY ambiguous khi multi-join)** verify ra
    **false alarm**: engine dùng positional `GROUP BY 1, 2, 3` (không
    cần qualify column name). Phase-1 đã enforce `Dimension.sql == name`
    nên SELECT cũng auto-qualify qua `${TABLE}.field` template. Không
    đụng vào.
  - **Fix #1 — datasets.py**: refactor `_execute_semantic_dataset_query`
    resolve datasource TRƯỚC khi tạo engine; dùng helper
    `_dialect_for_ds_type` (live_query_service.py:67) — single source
    of truth cho mapping ds_type → dialect (đã tồn tại, dùng bởi
    chart_service.py + live_query_service từ Phase-5).
  - **Fix #2 — datasets.py**: wrap 2 try/except:
    * `generate_sql`: catch `ValueError` → 400 với VN message từ engine
      (Phase 11 đã VN hóa); catch generic `Exception` → 500 với context
      "Lỗi sinh SQL semantic ({dialect})". Logger ghi full stack trace
      cho dev.
    * `execute_query`: catch generic `Exception` → 400 với hint
      "Kiểm tra: relationship có đúng cardinality? Cột tham chiếu có
      tồn tại?". Lý do dùng 400 thay vì 500: 99% lỗi execute là config
      issue (cardinality, column missing, dialect mismatch), không phải
      bug code.
  - **Fix #1 — routers/semantic.py**: tương tự, resolve datasource từ
    explore's base_view → table → datasource chain. Single resolved
    datasource cho cả dialect detection và execute_query. Loại bỏ
    "pick first available DataSource" bug (có thể pick wrong DS).
  - **Pattern audit**: `grep "database_type=\"postgresql\""` trong
    `backend/app/` giờ 0 hit (ngoài comment giải thích). Mọi
    `SemanticQueryEngine(...)` site giờ dùng dialect đúng.

- **2026-05-16 (Phase-12.5)**: FE→BE qualified-field contract + UX surface.
  - **Vấn đề DA nêu**: 3 điểm — (1) FE có thể gửi metric/dimension bare
    (mất qualifier) → BE không kích semantic engine, JOIN silent miss;
    (2) chartDataAdapter `applyGroupByAgg` group bằng equality, không
    time-bucket → raw timestamp = mỗi row 1 group, sai chart time-series
    khi không pre-aggregated; (3) useEffect chain seed roleConfig chạy
    trước khi semanticColumns load → bare pick "stuck".
  - **Fix #1 — qualified-field guarantee**: `upgradeRoleConfigToQualified`
    + `qualifiedByBare` map trong [ExploreEditor.tsx](../../../frontend/src/components/explore/ExploreEditor.tsx).
    Khi 1 bare name map duy nhất tới 1 qualified `view.field` trong join
    graph reachable, FE auto-upgrade trước khi build request. Ambiguous
    (≥2 view có cùng bare) → giữ nguyên + UI badge "⚠ cần join".
  - **Fix #2 — granularity guard**: chartDataAdapter `applyGroupByAgg`
    thêm `looksLikeRawTimestamp` check; nếu phát hiện ISO-timestamp với
    HH:mm:ss thì `console.warn` ngay (DA QA thấy ở DevTools). Doc rõ
    contract trong [chartDataAdapter.ts](../../../frontend/src/components/explore/chartDataAdapter.ts):
    function chỉ valid khi `preAggregated=true` (BE đã GROUP BY) hoặc
    dimension là categorical thực sự.
  - **Fix #3 — semantic-ready gate**: useEffect seed roleConfig giờ
    `if (!semanticReady) return`. `semanticReady = datasetModel loaded
    && (no semantic view selected || reachableViews available)`. Race
    không còn.
  - **UX polish — relationship state visible**: chip "{N} tables joined"
    trong topbar bên cạnh ExploreSourceSelector. Màu xanh khi chart
    đang dùng cross-table; xám khi chỉ có khả năng join nhưng chưa
    dùng. Title tooltip liệt kê view names + giải thích engine sẽ JOIN
    tự động. DA mở Explore thấy ngay state thay vì phải reverse-engineer.
  - **Inline doc trong BE**: `_contains_semantic_field_refs` ở
    [datasets.py:704](datasets.py) thêm docstring giải thích trio
    FE-side (`upgradeRoleConfigToQualified` + badge `⚠ cần join` +
    `semanticReady` gate) đảm bảo input cho oracle này có chất lượng.
    DA đọc BE code thấy ngay FE side đang phòng thủ cái gì.

- **2026-05-16 (Phase-12 MCP parity)**: MCP-dashboard sync với Phase-12 schema.
  - **Blueprint pre-validator**: `commit_semantic_model` trong
    [Skill-AppBI/appbi-dashboard-mcp/appbi_blueprint.py](../../../Skill-AppBI/appbi-dashboard-mcp/appbi_blueprint.py)
    catch 4 lỗi Phase-12 trước khi gọi BE: scope='view' + non-empty
    source_columns; scope='dataset' + empty source_columns;
    source_columns[].view không tồn tại trong plan; source_columns[].field
    không match dimension đã khai báo trên view đó. DA nhận lỗi cụ thể tại
    MCP tool call thay vì 400 generic từ BE.
  - **Schema docs**: `SEMANTIC_MODEL_PLAN_SHAPE` thêm 2 field `scope` +
    `source_columns` với example revenue_per_lead. Docstrings
    `create_semantic_view` / `update_semantic_view` trong
    [Skill-AppBI/appbi-dashboard-mcp/appbi_semantic.py](../../../Skill-AppBI/appbi-dashboard-mcp/appbi_semantic.py)
    mention Phase-12 fields. TOOL_SURFACE.md có section riêng giải thích
    khi nào AI dùng scope='dataset'.
  - **Chart docstring**: [appbi_chart.py](../../../Skill-AppBI/appbi-dashboard-mcp/appbi_chart.py)
    note rằng engine có thể trả error tiếng Việt (Phase-11) khi field
    unreachable — forward verbatim, đừng translate.
  - **BE parity fix — gate router endpoint**: `PUT /semantic/views/{id}`
    và `POST /semantic/views` (MCP path) trước đây bypass
    `_validate_measure_dependencies`; chỉ endpoint `/datasets/{id}/model/views/{vid}`
    có validator. Phase-12 MCP fix: cả 2 router endpoint giờ resolve
    `dataset_id` qua chain view → table → dataset rồi gọi cùng helper.
    DA dùng MCP sẽ nhận lỗi nhất quán với DA dùng UI.

- **2026-05-16 (Phase-12)**: Measure dataset-scope (Power BI parity).
  - **Schema**: MeasureDefinition mới có `scope: "view" | "dataset"`
    (default "view" — zero break) + `source_columns: [{view, field}]`.
    `@model_validator` reject mismatch (scope=view nhưng có
    source_columns, hoặc scope=dataset nhưng thiếu source_columns).
    Files: [schemas/semantic.py](../schemas/semantic.py),
    [hooks/use-dataset-model.ts](../../../frontend/src/hooks/use-dataset-model.ts).
  - **Engine**: `_load_views` Phase-12 pass thứ hai — khi field_ref trỏ
    measure scope='dataset', auto-load tất cả views khai báo trong
    source_columns vào views_cache. Đảm bảo join resolver thấy mọi view
    cần JOIN trước khi build FROM clause. File:
    [services/semantic_query_engine.py](../services/semantic_query_engine.py).
  - **Validator save-time**: `_validate_measure_dependencies` extend
    cho dataset-scope — reject nếu source_columns ref view không tồn
    tại trong model, hoặc field không match dimension/column. File:
    [api/datasets.py](datasets.py).
  - **UI**: MeasureRow trong ModelViewEditPanel có checkbox "Cross-table
    (dataset-scope)" + UI thêm source-column pairs (view dropdown +
    field dropdown). User tạo measure dạng
    `${deals.amount} / COUNT(${leads.id})` với 2 cột nguồn từ 2 bảng. File:
    [components/datasets/ModelViewEditPanel.tsx](../../../frontend/src/components/datasets/ModelViewEditPanel.tsx).
  - **Tests**: 4 unit test mới — load_views auto-pull source_columns,
    validator reject empty entry, validator yêu cầu source_columns khi
    scope=dataset, default scope='view' giữ legacy shape không vỡ. Pass
    18/18 trong suite semantic + relation.

- **2026-05-16 (Phase-11)**: FE Explore flat-panel + inline relationship
  CTA + React #31 cascade fix.
  - **Critical fix — React error #31**: 4 endpoints BE trả 409 với
    `detail = {code, message, ...}` (JOIN_INACTIVE_CASCADE,
    MEASURE_CASCADE, COLUMN_CASCADE, table-delete constraints).
    `RelationshipDialog.handleSave` cũ pass thẳng `detail` object vào
    `setError(...)` → render `{error}` vào JSX → crash. Fix: dùng helper
    `extractApiError` từ [lib/api-errors.ts](../../../frontend/src/lib/api-errors.ts)
    chuyển object detail về string an toàn. Áp dụng cùng helper cho 4
    catch-site khác có pattern `err?.response?.data?.detail` raw:
    Sidebar (password), ExploreEditor (save chart), DataModelCanvas
    (generate model + remove relationship), DimensionMeasureEditor.
  - **ExploreColumnPanel rewrite**: từ accordion grouped-by-view sang
    **flat searchable list** (Power BI Fields pane pattern). Filter chip
    "All views / per-view" thay vì bắt phải expand từng view. Dimension
    /Measure section sticky header.
  - **Badge "⚠ cần join"**: field từ view không reachable không còn bị
    disable âm thầm — vẫn click được, kèm badge cam mở RelationshipDialog
    pre-filled `from = base view, to = field's view`. User add join +
    quay lại chart không cần rời Explore. Wire qua prop
    `onRequestRelationship` + state `pendingRelationship` trong
    ExploreEditor; sau save show toast "Đã thêm relationship X → Y".
  - **Auto-pick first table**: ExploreSourceSelector không còn ép user
    chọn 2 dropdown tuần tự. Chọn Dataset → useEffect auto-pick
    `dataset.tables[0]` nếu chưa có selection. User vẫn override được.
  - **Friendly VN error message**: khi field bị engine raise vì view
    unreachable, message đổi từ `View 'X' is not reachable from base
    view 'Y'` (English engine identifier) sang
    `Bảng "X" chưa có relationship tới base view "Y". Mở tab Data Model
    để định nghĩa join trước khi dùng field từ bảng này.`
  - 32 demo charts vẫn render đúng (engine path không đổi, chỉ thêm
    auto-load views_cache pass thứ hai cho dataset-scope measure).

- **2026-05-15 (Phase-7)**: Rename engine canonical + clean cross-view
  rename + bare-safe rewrite.
  - `semantic_query_engine_v2.py` → `semantic_query_engine.py` với shim
    re-export. Class `SemanticQueryEngineV2` aliases to
    `SemanticQueryEngine`. 3 callers migrated.
  - Cross-view rename: bare `${old}` placeholder chỉ rewrite trong cùng
    view, qualified `${view.old}` rewrite globally.
  - Bare measure refs trong Chart.config rewrite an toàn (chỉ chart cùng
    table). JSON-quoted boundary chống substring collision.
  - 32/32 demo charts vẫn render sau rename.
- **2026-05-15 (Phase-6)**: Measure rename auto-rewrite.
  - PUT view chấp nhận `rename_map`; BE rewrite tất cả Chart.config
    qualified refs + depends_on + expression/where_sql placeholders.
  - FE auto-detect rename qua so sánh measureRowKeys; toast hiển thị
    số tham chiếu được cập nhật.
  - Test e2e: 4 charts auto-rewrite + chart query 200 sau rename.
- **2026-05-15 (Phase-5)**: Multi-dialect time intel + lineage probe + cleanup.
  - 6 time macros (`${TODAY}`, `${MONTH_START}`, …) engine resolve theo
    DuckDB / PostgreSQL / BigQuery / MySQL.
  - FE consumer cho `/lineage/column/{table_id}/{column}` — confirm
    dialog liệt kê semantic refs trước khi xóa column.
  - Dedupe script chỉ clear redundant binding (derived_table/calendar);
    physical_table giữ vì engine cần fully-qualified path.
  - ChartTypeSelector chuyển sang enum-driven (compile-time exhaustive).
  - Xóa button "Add Calculated Column" + cleanup 27 test script ad-hoc.
- **2026-05-15 (Phase-4)**: UI polish + server-side layout + lineage.
  - `metricLabel` đọc `measure.label` (không còn "AUTO of view.field").
  - Canvas position lưu server-side (thay localStorage).
  - Dual binding cleanup: `dataset_table_id` ưu tiên, `sql_table_name`
    legacy-only.
  - "Add Column" → "Add Calculated Column" với tooltip rõ scope.
  - `AggregationSpec.function` accept `"auto"` (fix bug 422 trên Explore).
  - Endpoint lineage probe `/lineage/column/{table_id}/{column}`.
- **2026-05-14 (Phase-3)**: Data Model UX + relationship semantic.
  - Time intelligence templates (MTD, YTD, YoY, prev-month, last-30d, rolling-7d).
  - `JoinDefinition.is_active` + `cross_filter` (skip inactive ở resolver,
    cycle check, chart binding, filter validation).
  - N:N: reject → warning (banner đỏ trong RelationshipDialog).
  - Ambiguous join path warning trong chart response + engine.warnings.
  - Cascade guard: không cho mark relationship inactive khi chart đang dùng.
- **2026-05-14 (Phase-2)**: Đóng nhóm validation gap.
  - Column-existence check khi save dimension/measure.
  - Cycle check cho derived_table.
  - `schema_change_pending` auto-set đồng bộ.
  - Cascade reject khi delete column / rename measure đang được dùng.
- **2026-05-14 (Phase-1)**: "Rút về 2". Enforce Dimension.sql = bare column.
  Thêm link "Add Calculated Column" trong Measure panel. Fix `columnOptions`
  lấy từ `columns_cache` thay vì `dimensions`.
- (Trước đó) — không có README, dev tự đọc code.
