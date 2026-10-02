# Semantic Foundation Freeze Review — Pair #1 + #2 + #3

Branch `fix/semantic-foundation-freeze` from `demo` @ `6afc9523` (Pair #3
closure). The contract this review froze: `kernel-contract-v1.md`. Locked by
`backend/tests/test_semantic_foundation_pg.py` (corpus:
`backend/tests/foundation_corpus.py`, physical rows in `pair2_topology.py`).

## Semantic kernel contract map

| Boundary | Input authority | Output authority | Can it reinterpret meaning? | Failure contract |
|---|---|---|---|---|
| stored model → relationship reader | `SemanticExplore.joins` rows | `JoinContract` (`read_join_contract`) | no — one reader | invalid row → `INVALID_RELATIONSHIP` when used |
| reader → resolver graph | contracts (valid + active) | forward / reverse edges, `cross_filter` | no | route set complete or `ROUTE_LIMIT` |
| resolver → query-plan meaning | request refs + base | `_pick_route` meanings, roles, grains | no — every chain is a meaning | `AMBIGUOUS_ROUTE`, `UNRELATED_GRAIN`, `FANOUT_RISK` |
| meaning → compiled SQL | measures / dims / formulas / filters | engine SQL per dialect | **was yes** — author `/` per dialect (FZ-1/2), cross-view formula grain (FZ-3) | true division / refusal |
| SQL → execution plan | dataset state, TTL, preview | live / snapshot / published / blocked | no | blocked plan → 400 |
| plan → executor (ChartService, direct APIs) | plan + key probes + live sources | one statement on one connection | **was yes** — another connection's table read through one (FZ-4) | `UNSUPPORTED_CONTEXT`, `UNVERIFIABLE_KEY`, `FANOUT_RISK` |
| warehouse → normalized result | rows | refs by field identity | no (Pair #3) | collision refused |
| result → API response | rows, drops, refusal | body + `dropped_filters` + `X-AppBI-Refusal` | **was yes** — direct APIs lost category / soft drops (FZ-5/6) | category on every entry point |

## F1 — every entry point that returns semantic business values

| Entry point | Current model | Contract reader | Resolver + engine | ExecutionPlan | Key guard | Live-source guard | Refusal taxonomy | Classification |
|---|---|---|---|---|---|---|---|---|
| `GET /charts/{id}/data`, batch, public / embed / PDF / AI tools (`_fetch_chart_data`) | derived binding | yes | yes | yes | yes | yes (FZ-4) | header / batch `category` | SEMANTICALLY EQUIVALENT |
| `POST /charts/preview-data`, dry-run-create, report starter | derived binding | yes | yes | yes (design-time live on an unpublished dataset) | yes | yes | header | SEMANTICALLY EQUIVALENT |
| `POST /semantic/query` | explore pinned to its model | yes | yes | **no — live** | yes | yes (FZ-4) | header (FZ-5); one predicate per field, no `is_null` / `between` operators (422); DECIMAL serialized as a JSON string | DESIGN-TIME INTENTIONALLY DIFFERENT (live data, narrower request contract) — same meaning |
| `POST /datasets/{id}/tables/{tid}/execute` | current model (`classify_semantic_roles`) | yes | yes (semantic refs) / physical (raw columns only) | **no — live** | yes | yes (FZ-4) | header (FZ-5), `dropped_filters` (FZ-6) | DESIGN-TIME INTENTIONALLY DIFFERENT (live data) — same meaning |
| measure dry-run / preview ("Chạy thử") | candidate measure injected into the current model, rolled back | yes | yes | **no — live** | yes | yes (FZ-4) | `category` (FZ-5); rows keyed by warehouse column names (shown as returned) | DESIGN-TIME INTENTIONALLY DIFFERENT — same meaning |
| per-measure isolation `_dispatch_per_measure_isolation` | — | yes | yes (per group) | per group | per group | per group | swallows errors | flag OFF by default — NON-SEMANTIC on the default path |
| `/charts/ai-preview` | — | no | **no — physical `{column, aggregation}`** | no | no | no | — | NON-SEMANTIC BY CONTRACT (physical aggregates; no caller in the repo) — Pair #4 / AI surface |
| custom-SQL charts, dataset transformations | — | — | no | live | — | — | — | NON-SEMANTIC BY CONTRACT (the author's physical SQL in the source dialect) |
| distinct values / slicer cascade | current model | yes | shortest routes OR-ed (option list) | own resolver | — | — | refuses invalid models | NON-SEMANTIC BY CONTRACT (an option list, never a number) — Pair #4 |

Design-time APIs evaluate the CURRENT model against LIVE source data — by
contract, not by accident; dashboards read the planned (snapshot / published)
state. No unexplained bypass remains.

## Contradictions found and fixed

| ID | Contract A | Contract B | Actual (demo `6afc9523`) | Fix |
|---|---|---|---|---|
| FZ-1 | one measure / formula / dimension = one number on every supported engine | the engine emitted the author's `/` per dialect | Postgres 13/7 = **1**, 1/30000 = **0**, `a / 2` grouped 2.5 with 2; MySQL 1/30000 = **0.0000**; `x / 0` an error (Postgres / BigQuery) or **inf** (DuckDB) | `semantic_arithmetic`: true division, NULL on /0 — every template entry point + `% of total` |
| FZ-2 | AVG / % of total one precision | MySQL DECIMAL rules | MySQL AVG(int) 4 extra digits; NULLIF around a window evaluated twice → % of total **50** for 100 | MySQL AVG of a DOUBLE; no NULLIF on MySQL |
| FZ-3 | a measure is evaluated at its own grain (Pair #2) | formulas inline their dependencies | `revenue / customers.n` = 198 / **5** = 39.6 (the same `customers.n` is 4 asked alone) — success, wrong, silent | a cross-view dependency in a formula is refused (`UNSUPPORTED_CONTEXT`) |
| FZ-4 | execution credentials belong to the engine receiving the SQL (Pair #3) | a dataset may span several same-dialect datasources | one live statement read B's unqualified table through A's connection: A's same-named table (another schema / database) — success, wrong, silent; on every executor | `refuse_foreign_live_sources` (engine records every live table's datasource) |
| FZ-5 | refusal identity survives every boundary (Pair #3) | direct APIs | `/semantic/query`, dataset execute: plain 400; measure preview / dry-run: no category | `X-AppBI-Refusal` / `category` |
| FZ-6 | a soft drop is never silent (Pair #3) | direct APIs | dataset execute returned the rows with the filter left out, no diagnostic; `/semantic/query` only a free-text warning | `dropped_filters` field |

Found by the independent sweep and the semantic-guard review of the first
candidate, all fixed in this change:

| ID | Actual (before) | Fix |
|---|---|---|
| FZ-7 | a cache HIT rebuilt `_debug.dropped_filters` from the pre-engine drops only: the engine's soft drops (single-direction gate, `no_join_path`) vanished for every later viewer — the filtered-looking number, no badge | the engine's drops are cached with the result and merged back on a hit |
| FZ-8 | an isolated measure (its own grain, multi-fact KPI) skipped a filter its fact cannot reach with a free-text warning only | a structured `unreachable_view` drop, on every entry point |
| FZ-9 | the engine soft-dropped a text operator on a date / number column, though `unsupported_operator` is a HARD reason (and the spec says builders refuse) | refused (400) |
| FZ-10 | a dataset-scope measure mixing its view's column with a 1:N child's (`${fee} + ${items.price}`) joined the child in: EVERY measure of the statement multiplied (`customers.n` = 5 for 4) | a source column must be many-to-one reachable from the measure's grain, else `FANOUT_RISK` |
| FZ-11 | a cross-table measure grouped only by dims unrelated to its fact repeated its grand total per group; the same aggregate on its own view is refused | `UNRELATED_GRAIN` for both |
| FZ-12 | an explicit agg on a formula (or a formula in a pivot cell) aggregated the formula TEXT as a row expression | refused (`UNSUPPORTED_CONTEXT`) |
| FZ-13 | dataset execute kept only the LAST predicate of a field (`id >= 2 AND id <= 3` ran as `id <= 3`) | all predicates AND-ed |
| FZ-14 | `_calendar_fan` was not in the chart cache key: a fanned Date filter and look-alike role filters could share a slot | in the key (a deterministic id) |
| FZ-15 | the division rewrite stripped the newline ending a `--` comment (the division then sat inside the comment — the dimension became `revenue`, not `revenue / qty`); strings / `#` comments were not lexed per dialect; any `NULLIF(x, k)` counted as a zero guard | dialect lexer, no strip past a newline, only `NULLIF(…, 0)` |
| FZ-16 | the live filter adapter rendered a dividing related dimension with the engine-less division, and read another datasource's table (or the stored relation) through its own connection; `/semantic/query` probed keys before the connection check (another refusal category); a BigQuery custom-SQL table of another project read as if absolute; the same database spelled differently refused | the same rewrite and guard on the adapter; guard before probes everywhere; BigQuery cross-connection only for physical tables or the same project; identity normalised (default port / schema, localhost); refusal text names no connection |

Remaining debt (none can return success + wrong + silent):

- `_relation_sql_for_view` falls back to the stored relation when the CURRENT
  table definition cannot render — the same renderer validates the definition
  at save, so no saved definition is known to reach it; the stored relation was
  rendered from the last valid definition. Owner: semantic quality.
- `/semantic/query` pivots: the pivot-value fetch fails (a warning, unpivoted
  totals) — loud, a design-time API defect. Owner: design-time API / Pair #4.
- Same-dialect connection identity is literal beyond default port / schema /
  loopback (two users on one database are two connections) — over-refusal,
  never a wrong read. Owner: execution quality.
- A calculated table whose dependencies cannot be resolved records no live
  source; its render then falls back to the raw alias SQL, which the warehouse
  rejects (loud). Owner: dataset data-prep.

Recertified, not changed: relationship meaning → route meaning → physical row
membership for M:1 (star, snowflake), 1:M (dimension bases), **1:1**
(`F8.one_to_one`, added — no golden case had one), M:N bridge, composite,
inactive, role alias, equivalent-key direct + chain, two equivalent-looking
chains with orphan rows, single-direction and `both` cross filters — every one
with hand-computed rows, through every entry point; an invalid relationship and
a non-unique one side are refused with their category (`INVALID_RELATIONSHIP`,
`FANOUT_RISK`) by every executing entry point.

`SEMANTIC_RESULT_CACHE_VERSION` → `foundation-freeze-2026-10`: the same request
now means something else on Postgres / MySQL (division) and for cross-view
formulas, so no pre-deploy cached result is served.

## Real-model census (local, read-only)

`appbi-ai-db-1` (`default_transaction_read_only=on`): 472 semantic views (84
BigQuery, 65 Postgres, 46 Sheets, 277 without a table), 307 measures.

| Class | BigQuery | Postgres | no table | Impact of this review |
|---|---|---|---|---|
| formula measures with `/` | 3 | 3 | 2 | all 8 already `NULLIF`-guarded and `* 1.0` / `100.0 *`-promoted or on BigQuery → old correct → same |
| row-level measure / `where_sql` / dimension with `/` | 0 | 0 | 0 | none |
| AVG measures | 13 | 7 | 4 | SQL unchanged off MySQL; no MySQL datasource |
| `percent_of_total` | 6 | 1 | 0 | value unchanged unless the total is 0 (error → NULL) |
| formula with a cross-view dependency | 1 (`attainment_pct`) | 0 | 0 | already refused (`AMBIGUOUS_ROUTE`) → refused (`UNSUPPORTED_CONTEXT`): category-only change |
| datasets spanning >1 datasource | 2 (BigQuery × Postgres, BigQuery × Sheets — federated) | — | — | none same-dialect → no live statement newly refused |

Production deployment gate (not run here — production is a separate
deployment): run the same read-only census there before deploying —
`docs/features/semantic-foundation-freeze/census.sql` with
`psql … -c "set default_transaction_read_only=on" -f census.sql` — and inspect
every row of the "formula with /" class whose dependencies are integer SUM /
COUNT on Postgres or MySQL (old integer / 4-digit result → new true division),
every cross-view formula (newly refused) and every same-dialect
multi-datasource dataset (live statements across its connections newly
refused).

## Evidence

See the final report of this review (commit message + report): counts per
gate, the old-code run, the dialect matrices and the mutation proofs.
