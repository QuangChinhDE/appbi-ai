# Chart final closure: one canonical Chart contract

```
Web / Explore ──▶ Canonical Chart API ──▶ Chart application ──▶ Semantic execution
(future integration adapter, outside this layer) ──▶ Canonical Chart API
```

The canonical Chart API has these routes:

- `POST /charts/preview-data` runs a chart.
- `POST /charts/dry-run-create` is the pre-save check: normalize, then `ChartCreate`, then a runtime preview. It writes nothing.
- `POST /charts/` and `PUT /charts/{id}` are both validated by `ChartCreate` on the final state.
- `GET /charts/{id}/data` returns a chart's data.

## MCP / agent inventory (Chart scope)

| Occurrence | Kind | Action |
|---|---|---|
| `POST /charts/normalize-config` (+ request/response models) | MCP/SDK-specific; no caller in this repo | **removed** |
| `POST /charts/ai-preview` (+ `AIChartPreviewRequest`) | parallel creation path for an external agent (`{dimensions, metrics:[{column, aggregation}]}` mapping, own save) | **removed** |
| `dry-run-create` docs "MCP / SDK call" | product-generic (Explore Save uses it) | docs re-owned to the canonical Chart API |
| `fe_unrecognised_keys` comments "to MCP / AI agents" | product-generic (the Builder shows the warning) | reworded |
| `chart_service` / `schemas` / `chart_config` comments ("MCP-created", "MCP CHART_ROLE_REQUIREMENTS") | historical wording | reworded ("API-authored", canonical registry) |
| route contract entries for both removed routes | contract | removed |
| `test_pair4_surfaces_pg` ai-preview test | tested the removed path | removed. The ambiguity refusal and saved-equals-preview contract are covered on the canonical routes by `test_chart_final_hardening_pg` and Pair #3 |
| `test_permission_caps` PAT-save test | security intent: a view-scoped PAT cannot save | **retargeted** to `POST /charts/` |

After this change, the Chart runtime has no MCP reference, no MCP-specific branch, and no second validation or creation contract.

## Error boundary

Every Chart-facing `ValueError` passes through `chart_error_contract.user_safe_message`:

- Semantic refusal prose (built by the engine) is passed through, together with its structured `refusal`.
- Any other text is passed through only if it carries no internal marks: no DSN, credential, host/IP, path, traceback, upper-case SQL, driver or client library name, or project id.
- Anything else is logged and answered with a reference id.

## Aggregations

- `percent_of_total` is valid and saveable but is not offered in the dropdown. A share-of-total is authored as a declared measure and picked with AS-IS.
- The Builder shows a saved explicit `percent_of_total` as "% OF TOTAL" and keeps it on Update. Before this change the dropdown displayed another aggregation.
