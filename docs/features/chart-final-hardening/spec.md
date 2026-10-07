# Chart final hardening — spec

## Base lifecycle (frontend, `lib/chart-base-lifecycle.ts`)

| Origin | Set when | Label |
|---|---|---|
| `saved` | reopening a saved chart (`dataset_table_id`, legacy `config.source`) | Đã lưu cùng biểu đồ |
| `user` | the base picker, or a table handed in by the caller | Do bạn chọn |
| `derived` | the FIRST single qualified field the user adds | Lấy theo trường đầu tiên bạn chọn |
| none | dataset chosen, nothing picked | "Chọn bảng gốc" (dashed chip) |

- Auto-seeding (TABLE default columns, fallback dimension/metric) runs only once a base
  exists. Before a base exists, the role config is only pruned.
- A bulk change, such as an implicit TABLE "all columns" turning into an explicit list,
  is never read as a pick.
- A base change goes through `handleBaseChange`:
  - It keeps every binding the new base reaches (`getReachableViews`, the same graph
    the picker uses).
  - It drops only qualified fields and filters on unreachable views, names them in a
    toast, and offers Undo.
  - Custom-SQL role config is kept.
- A dataset change resets intent, base origin, filters and both role configs.
- The chip is neutral, or amber after a refusal. It is never green for "joined".
  - When measures come from other tables, it says "Numbers computed on: …"
    (`measureViewsOutsideBase`).
  - The picker menu notes the model recommendation when it differs from the base.
    The recommendation never changes the base.

## Refusal contract (backend, `services/chart_error_contract.py`)

`POST /charts/preview-data`, `GET /charts/{id}/data` and `POST /charts/ai-preview`
answer a `ValueError` with:

```
400  X-AppBI-Refusal: <CATEGORY>          (only for a SemanticRefusal)
{ "detail": "<humanised prose>",
  "refusal": { "category": "AMBIGUOUS_ROUTE", "target": "Date",
               "routes": ["bc_pfm → Date", "bc_pfm → bc_owner → Date"] } }
```

- `dry-run-create` returns the same object as `runtime_refusal`.
- Any other exception: the error is logged in full under a reference id. The response is
  "Không tải được dữ liệu biểu đồ … mã tham chiếu <ref>", which applies to preview,
  chart data, ai-preview, dry-run and batch tiles.
- The frontend classifies errors with `describeChartFailure`:
  ambiguous_route, semantic_refusal, invalid_config, permission, source_error, unknown.
  `ChartFailurePanel` renders the business message and actions, and puts the routes and
  prose under "Chi tiết cho người làm mô hình dữ liệu".
- When a run fails, the previous result is dropped.

## Disclosure

`GET /charts/{id}/data` returns the full `debug` only when the effective permission is
`edit` or `full`. Otherwise it returns the public-safe subset: `dropped_filters`,
freshness, `row_count` and `execution_time_ms`.

## Validation

- `PUT /charts/{id}` re-validates the merged chart (stored and update) through
  `ChartCreate` whenever `config`, `chart_type` or `dataset_table_id` changes.
- The required-role lookup uses the Enum value.
- There is one `CHART_METRIC_AGGS` (`percent_of_total` included, case-insensitive).
- The normalizer keeps an unknown aggregation so that validation refuses it by name.
- The query mode is resolved by the runtime resolver, which now lives in
  `schemas/chart_config.py` and is re-exported by `services/chart_contracts.py`.
