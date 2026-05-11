# Follow-up plan — Sprint 2B / 3A / 3B

Sprint 1 (MCP guidance + Sprint 2A BigQuery qualifier fix) đã ship. Tài liệu này
ghi lại 3 sprint còn lại với scope cụ thể, file paths, và risk — để session sau
(hoặc backend engineer khác) pick up an toàn.

## Sprint 2B — Join-aware chart preview / runtime

### Problem
Chart preview (`POST /charts/preview-data`) và chart runtime (saved chart query)
đều đi qua `build_live_agg_query` trong
[backend/app/services/live_query_service.py:663](../../backend/app/services/live_query_service.py#L663).
Hàm này emit `SELECT ... FROM {base_table}` — single-table, không JOIN.
Hệ quả: bất kỳ field nào sống ở joined view (qua explore) đều fail tại preview
ngay cả khi semantic model resolve được nó.

### Scope
Hai cách tiếp cận, chọn 1:

**A. Hard fix — apply explore joins trong live_query_service.**
- Inputs needed: chart phải biết explore name (hiện chart chỉ bind dataset_table_id).
- Touch points:
  - Add `explore_name` field vào chart config (hoặc resolve qua bound view).
  - Rewrite `build_live_agg_query` để accept optional `joins=[]` + render JOINs.
  - Backfill cho charts hiện có: nếu chart không có explore_name, fall back single-table.
- Risk: thay đổi query SQL, có thể đụng partition pruning logic BigQuery
  ([_build_bigquery_partition_window_clause](../../backend/app/services/live_query_service.py#L179)).
  Cần thêm test cho cost guard.

**B. Soft fix — detect joined field, return structured warning.**
- Thêm tiền-validation trong `chart_service.preview_chart_data`:
  load semantic view bound to dataset_table_id, check if any
  role_config field exists on bound view's dimensions/measures. Nếu không và
  field tồn tại trên reachable joined view → return early với
  `{"status": "joined_field_unsupported", ...}` (HTTP 200 với explanation).
- Chart-saving (`create_chart`) đã có guard này ở MCP-layer (semantic preflight).
  Bổ sung backend cùng guard để Explore-via-UI cũng catch được.
- Risk: thấp, không đụng query path. Nhưng không "fix" được vấn đề — chỉ
  surface message rõ ràng hơn.

### Recommendation
Path B trước (1-2 ngày), Path A defer cho tới khi cần thực sự (3A ép buộc).

### Files
- `backend/app/services/live_query_service.py` — query builder
- `backend/app/services/chart_service.py` — preview/run dispatcher
- `backend/tests/test_live_query_service.py` (nếu có), nếu không thì add test

---

## Sprint 3A — Allow joined-view fields in saved charts

### Problem
Hôm nay chart engine `build_live_agg_query` không hỗ trợ joins. Để chart dùng
được field từ joined view (e.g. `pipeline_name` từ joined `sdr_pipeline_stage`),
phải route chart query qua `SemanticQueryEngineV2`.

### Scope
Đây là **swap engine cho chart runtime path**, không phải patch.

1. **Translation layer** roleConfig → SemanticQuery:
   - `role_config.dimension` / `breakdown` / `timeField` → `dimensions[]` qualified
   - `role_config.metrics[]` → `measures[]` qualified
   - `role_config.filters` → `filters{}` keyed by qualified field
2. **Routing** trong `chart_service._execute_chart_runtime_for_table`:
   - Branch: nếu chart có `explore_name` (hoặc `queryMode == "semantic"`),
     dispatch sang `SemanticQueryEngineV2.execute_query`. Else giữ
     `build_live_agg_query` path.
3. **Chart config schema** trong frontend Explore:
   - Cho user chọn field từ joined view (UI dropdown lấy từ explore's reachable_views).
   - Thêm field `chart.config.exploreName` khi save.
4. **MCP** — gỡ guard "joined view field blocked":
   - [appbi_chart.py:472-479, 510-515](../appbi-dashboard-mcp/appbi_chart.py)
   - [appbi_blueprint.py:1185-1190, 1077-1082](../appbi-dashboard-mcp/appbi_blueprint.py)
   - Validation chuyển sang check field tồn tại trên ANY reachable view of explore.

### Risks
- Perf: `SemanticQueryEngineV2` always issues JOINs — cost cao hơn cho chart
  base-only. Cần `auto_skip_joins=True` khi role_config không reference field từ
  joined view.
- BigQuery cost guard: hiện ở `live_query_service`, cần port sang
  `semantic_query_engine_v2.execute_query` để partition pruning vẫn work.
- Cache key: chart cache hiện key by `(datasource_id, base_table, ...)`. Cần
  thêm `explore_name` vào cache key.
- Backfill: charts cũ không có `exploreName` — phải default về single-table path.

### Effort
2-3 ngày engineer + 1 ngày frontend Explore + 1 ngày test/QA.

### Files (chính)
- `backend/app/services/chart_service.py` — `_execute_chart_runtime_for_table`
- `backend/app/services/semantic_query_engine_v2.py` — entry point
- `backend/app/schemas/chart_config.py` — thêm `exploreName`
- `frontend/src/components/explore/...` — UI dropdown
- `Skill-AppBI/appbi-dashboard-mcp/appbi_chart.py` + `appbi_blueprint.py` — gỡ guard

---

## Sprint 3B — `queryMode: "semantic_v2"` for computed measures

### Problem
Semantic measure với `expression` (e.g. `AVG CASE WHEN ...`) hoặc `filters`
(Looker-style filtered measure) không reference được trong chart metric vì
`build_live_agg_query` chỉ apply `agg(field)` form. Sprint 1A đã đánh dấu
`chart_compatible: false` cho những measure này, nhưng workaround
(materialize-as-dimension) bất tiện cho user thật.

### Scope
Dependent on 3A. Sau khi chart query routed qua `SemanticQueryEngineV2`,
computed measure được resolve tự động bởi engine ([line 318 area](../../backend/app/services/semantic_query_engine_v2.py#L318)).

1. **Frontend Explore** — show computed measures trong dropdown chọn metric.
   Hiện đang hide để tránh confused user.
2. **MCP `_measure_chart_compatibility`** — flip `compatible=True` khi
   `queryMode == "semantic_v2"`.
3. **Test** — round-trip: create chart with computed measure → render →
   value matches what `execute_semantic_query` returns.

### Risks
- Workspace có measures với `where_sql` chứa SQL fragment không-safe. Hiện
  `_validate_calculated_field_safety` ([line 660](../../backend/app/services/semantic_query_engine_v2.py#L660))
  reject DROP/DELETE/etc. Cần audit predicate-injection cho `filters[]` array.

### Effort
1 ngày sau khi 3A xong (depends-on).

---

## Test debt
- MCP layer không có pytest hiện tại. Sprint 1 thay đổi nhiều logic
  (compatibility flag, preview diagnose, summary trim). Should add:
  - `test_measure_chart_compatibility` — input variants → expected compatible flag
  - `test_classify_preview_error` — pattern coverage
  - `test_summarize_chart_item` / `test_summarize_dataset_model`
- Pre-existing broken tests (không liên quan Sprint này):
  - `tests/test_permission_caps.py` — import error `RlsRoleRule`
  - `tests/test_personal_access_tokens.py` — Router.__init__() signature drift
  - `tests/test_workboard_app_user_roles.py` — collection error
  Backend team nên triage riêng.
