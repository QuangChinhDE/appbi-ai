# Semantic core remediation — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --plan "semantic core remediation: refuse or correct every succeed-and-wrong path (routes, calendar, stitch, filters, cache, drift, access, health gate)" --files <the files below>
```

- Verdict: `warn` with the domain wording above; `unknown` with a bare
  "semantic core remediation" (no feature keyword) — recorded, not ignored.
- Protected subsystems involved: `semantic_layer` (engine, resolver, model,
  calendar, chart_service, the new `semantic_health_service`) and
  `engineering_infrastructure` (guardrail rules, workflow, .gitignore).
- Required tests it named: `dialect_structural`, `measure_render`,
  `semantic_state_contracts`, `filter_matrix`, `golden_sql`, `galaxy_golden`,
  `distinct_cascade_bq`, `relationship_metadata`, `error_contracts`,
  `semantic_router_access`, `semantic_health`, the SDLC meta-gates.

## Files and layers, in order

1. `services/semantic_join_resolver.py` — strict `canonical_cardinality`,
   route signatures, `distinct_routes`, `resolve_unique_path`,
   `AmbiguousJoinPathError`.
2. `services/semantic_query_engine.py` — route refusal (role ambiguity) vs
   propagation AND; context-modifier refusal; metadata calendar recognition and
   fan refusal; stitch time grain / Top-N / sort / measure filters / warnings /
   decline reason; measure-filter literal patterns; model-based HAVING
   classification; per-dialect regex; ISO week; timezone-consistent grains;
   explore/view name scoping.
3. `services/sql_pattern.py`, `services/live_query_service.py` — one regex
   helper; the live WHERE renders or refuses every operator.
4. `services/chart_service.py` — unique live route + DISTINCT-key semi-join
   for 1:N; content signature of definitions in the cache key; binding
   re-hydration for modeled tables.
5. `services/dataset_model_service.py`, `api/datasets.py`,
   `routers/semantic.py`, `schemas/semantic.py` — strict join writes, PK
   persisted, shared join validator, per-dataset object access, context
   modifiers not addable on save, drift over every column reference, resync
   lock.
6. `services/dataset_calendar_service.py` — one `local_date_sql`,
   `is_instant_column`, `effective_calendar_timezone`.
7. `services/semantic_health_service.py`, `services/dataset_publish_service.py`
   — model-derived health, three layers, publish gate on key uniqueness.
8. `frontend/.../ModelViewEditPanel.tsx` — filter-context presets removed; a
   measure that still has modifiers says why and can drop them.

## Tests decided before coding

| Test | Tier | Proves |
|---|---|---|
| `test_semantic_golden_matrix.py` | Postgres (integration) | values for star, 3-role date, diamond, galaxy (different grains), chasm, M:N bridge, composite key, timezone |
| `test_semantic_state_contracts.py` | unit | drift, cache identity, live operators, live semi-join (executed), HAVING, scoping, one local-date rule |
| `test_semantic_router_object_access.py` | unit | SEM-P1-004 allowed/denied, join validation, no cross-dataset moves, context modifiers on save |
| `test_semantic_error_contracts.py` | unit | refusals → 400 in Vietnamese, 500 path logged |
| `test_semantic_health.py` | unit | uniqueness fail → blocking → publish refused; unknown ≠ pass; layers; snapshot parity |
| `test_distinct_cascade_semijoin.py` | Postgres fixture | cascade values vs raw-table truth; BigQuery SQL shape |
| `test_golden_sql_non_regression.py` | Postgres fixture | every fixture chart's SQL on PG + BigQuery vs baseline |
| `test_dialect_structural.py` (changed) | unit | measure filter now uses the literal shape (was locking the wildcard gap) |

Real BigQuery execution (not a CI gate — needs a warehouse): the golden matrix,
the distinct cascades and the 17 golden-replay charts, executed on a BigQuery
datasource with inline data, compared value-for-value with Postgres.

## Rollback

Revert the branch merge. No schema change. The behaviour changes that move
numbers on purpose (measure filters with `%`/`_` in the value; charts that now
refuse) disappear with the revert.
