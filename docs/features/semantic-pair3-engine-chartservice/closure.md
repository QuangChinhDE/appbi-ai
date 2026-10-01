# Pair #3 — SemanticQueryEngine ↔ ChartService: the enforced contract

Branch `fix/semantic-pair3-engine-chartservice`, started from `demo` @ `1dfb6403`
(Pair #2 closure). Pair #1 (relationship contract) and Pair #2 (resolver ↔ engine)
are frozen inputs.

**The engine decides business meaning. ChartService decides how that meaning is
physically executed and presented — it never weakens, replaces, silently drops,
caches across, or reinterprets it.** Where exact preservation cannot be proven,
the request is refused, or (only where the product declares it) a filter is
soft-dropped with a structured, observable diagnostic.

Locked by `backend/tests/test_pair3_chartservice_pg.py` (worlds in
`backend/tests/pair3_world.py`): every Pair #2 golden request asked THROUGH
ChartService on a real datasource, compared with the Pair #2 oracles.

## Execution map — every production path that returns chart data

| Path | Routing trigger | Semantic engine? | Filter owner | Physical mode | Cache | Business value? |
|---|---|---|---|---|---|---|
| `GET /charts/{id}/data` → `ChartService.get_chart_data` → `_execute_chart_runtime_for_table` | saved chart | yes when model-backed (always, except custom SQL / an unmodeled table) | `merge_chart_query_filters` + `_normalize_runtime_filters_for_chart` | `plan_chart_execution` (live / snapshot / published / blocked) | single-flight lock + `query_cache` | yes |
| `POST /charts/preview-data`, `/charts/dry-run-create`, report starter → `preview_chart_data` | Explore / design-time (`chart_id=-1` ⇒ `is_preview`) | same | same | same; an unpublished dataset may run live (design-time) | `query_cache` | yes |
| `get_charts_data_batch` (public page batch) | N × `get_chart_data` | same | same (+ public merge upstream, Pair #4) | same | same | yes |
| public `/d`, embed, PDF (renders `/d`), AI tools on a dashboard (`_fetch_chart_data`) | `get_chart_data` | same | public merge upstream (Pair #4) | same (TTL per link) | same | yes |
| `_execute_semantic_chart_runtime` | `needs_semantic_runtime` (qualified / declared refs, joined filters) OR the force-gate (any resolved baseViewName / declared field, not custom SQL) | yes — `engine.run(SemanticQuerySpec)` | engine filters + drop log | planner | `query_cache` (key below) | yes |
| per-measure isolation `_dispatch_per_measure_isolation` | `FEATURE_PER_MEASURE_ISOLATION` (default **off**) | per group | per group | per group | per group | not on the default path |
| calendar table, not model-backed | `is_generated_calendar_table` | no | live normalizer + hard-drop enforce | live | live cache | yes (physical calendar) |
| derived / calculated table, not model-backed | `is_derived_table` | no (live adapter per dependency) | live adapter (recorded drops) | live | live cache | yes |
| custom SQL | `queryMode == "custom"` AND non-empty `customSql` | no — the custom contract | live normalizer (joined refs = hard drop) | live on the source | live cache (`custom_sql::sha1`) | yes (author's SQL) |
| physical / sql_query table, not model-backed | none of the above | no (live adapter) | live adapter | live | live cache | yes |
| `/charts/ai-preview` | AI agent tool (no caller in this repo) | no — physical `{column, aggregation}` | none | live | none | physical only (Pair #4 / AI surface) |
| `/datasets/{id}/tables/{tid}/execute`, measure dry-run/preview, `/semantic/query` | dataset workbench / direct API | yes, direct | own | live, no planner | none | design-time / API (outside ChartService) |

## Routing contract

* Semantic runtime is MANDATORY for every generated chart on a modeled dataset
  (a resolved `baseViewName` or any declared semantic field): the force-gate,
  independent of how the refs are spelled. The binding is DERIVED from the
  current model on every read — for `dataset_table_id` charts and (Pair #3)
  for legacy charts naming their table in `config.source`; the stored binding
  is never the source of truth (stale / minimal / empty bindings give the
  current model's answer). An explore that cannot be found refuses.
* A physical / live path is legitimate only for custom SQL (an explicit,
  separate contract — never a fallback) and for tables with no semantic
  model. On the live path a filter on another view is a hard
  `binding_unsupported` refusal before the adapter runs.
* Generated vs custom: custom only when `queryMode == "custom"` and the SQL is
  non-empty; leftover SQL in a generated chart is never executed, and a
  semantic refusal never falls back to it.
* Snapshot / live: the planner alone decides. Published generation N → N or
  refused (never live, never another generation). Mixed-engine live → blocked.
  Operational → live only. A LEGACY dataset whose snapshot table vanished
  falls back to live — the SAME spec recompiled for the source's dialect and
  executed as the source's engine (Pair #3; it used to keep the host's
  BigQuery compilation and engine type), recorded as
  `execution_state=live_fallback`, never cached.
* Fallbacks: no semantic refusal is ever retried through a weaker path; the
  only fallbacks are the snapshot-missing ones above.

## Filter contract

* Merge (inside ChartService): the chart's saved filters (`baseFilters`, else
  editor `filters`) are the author's HARD constraint — AND-ed with the runtime
  overlay, never replaced; only byte-identical predicates dedupe. A bare
  column name never merges two views' filters. Runtime-vs-runtime override is
  upstream (layered merge, Pair #4).
* Every drop reason is one of three states:

| Reason | State |
|---|---|
| no field / empty value (a cleared slicer) | not a filter (incomplete input) |
| unknown field, dataset mismatch, unsupported operator, `binding_unsupported` (a view the model does not have; the live path's joined refs) | **HARD-REFUSED** (400) |
| `unreachable_view` — a PLAIN view of the chart's model the base cannot reach (Pair #3: no longer a hard `binding_unsupported` on the semantic runtime; a view reached only under role aliases, or a calendar view, stays HARD: ambiguous / an unplaced calendar ref, not unrelated), the engine's single-direction gate, the live adapter's no-filter-path | **SOFT-DROPPED + `_debug.dropped_filters`** (PowerBI parity, declared in `chart_contracts`) |
| `no_join_path` — a route exists but cannot be rendered (engine EXISTS, live adapter) | **SOFT-DROPPED + `_debug.dropped_filters`** |
| an authoritative constraint in ANY drop state | **HARD-REFUSED** (`AuthoritativeFilterNotApplied`) |

* NULL: the documented NULL contract (semantic-core-remediation spec, locked by
  `test_semantic_golden_matrix` and the Pair #1 baseline) holds through
  ChartService unchanged — a fact row with NO related row passes no predicate
  on that view, `IS NULL` and negations included (SQL three-valued logic), the
  same on the engine, EXISTS, live, measure-filter and distinct paths.
* Live adapter ↔ engine: same base rows for forward / two-hop / role-alias /
  reverse-both / single-direction (both drop + record) / shared-dimension /
  composite-key filters.

## Result contract

* Rows are keyed by the requested `view.field` refs. The warehouse's column
  names are mapped back case-insensitively (Postgres folds an unquoted alias:
  a field with a capital letter lost its values); two refs that reduce to one
  result column (`C name` / `C_name`, or names differing only in case) are
  refused (UNSUPPORTED_CONTEXT) — never one field's values under both names.
* ChartService adds no sort, limit or truncation on the semantic path: Top-N /
  sort / LIMIT are the engine's (Pair #2), returned in that order.
* Aggregation: a metric's `agg: "auto"` renders the declared measure by its
  type; a what-if measure swap gives a declared measure `"auto"` (Pair #3: it
  carried the previous metric's `"sum"` — a distinct count became a SUM of
  ids). An explicit `agg` on a metric is the author's override.
* Refusals keep their identity: `SemanticRefusal.category` (or
  `AUTHORITATIVE_NOT_APPLIED`) in the `X-AppBI-Refusal` header of
  `/charts/{id}/data` and `/charts/preview-data`, and in each batch item's
  `category`; the message stays the localized text.

## Cache identity

`query_cache` key (semantic path): model join signature, model definition
signature (views' dims/measures/PK, tables' source/transformations/types,
dataset settings incl. calendar timezone), dims, measures, agg overrides,
limit, time grains, sorts, window functions, filters (field, operator, value,
calendar keys), authoritative set, snapshot generation (or as-of), execution
host, security scope; per datasource id; `SEMANTIC_RESULT_CACHE_VERSION`
(bumped to `pair3-closure-2026-10`: the same query means something else after
this change, so no pre-deploy result — in the restart-surviving shared store —
is ever served). Fallback results are not written.
Proven by mutation: a relationship edit, a measure edit, a filter change, a
new generation, another security scope or host is recomputed, never served
the earlier result.

## Live ↔ snapshot

The whole golden matrix through ChartService on BigQuery, plan=live and
plan=snapshot (the snapshot statement as built, its table refs substituted by
the same inline rows — the warehouse is read-only): identical oracle values.

## Bugs fixed (see the "(pair3)" rows of the regression catalog)

Legacy-source charts ran on their stored binding; equal-length equivalent-key
routes through different intermediates picked by label (orphan rows changed
the answer); the snapshot→live fallback ran BigQuery SQL on the source
credential; a what-if swap re-aggregated declared measures as SUM; Postgres
alias folding dropped every capitalised field; colliding result columns
merged; an
unrelated table's filter refused the whole tile against the declared soft-drop
policy; refusal categories did not reach the HTTP response; the MySQL
generated calendar failed every query (reserved alias, recursion depth).
