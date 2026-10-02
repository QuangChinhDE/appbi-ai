# Pair #5 — Source / Data Prep / Snapshot ↔ Drift / Health / Quality / Observability: the enforced contract

Pair #4 proved the Kernel's answer survives every consuming surface. Pair #5
proves the **data** that answer is computed from is the dataset's data — the
same logical relation everywhere — and that every monitor of that data tells
the truth: a change is seen, an error is an error, a check that did not run is
never a pass, and a candidate that did not validate is never published.

Durable gate: `backend/tests/test_pair5_data_state_pg.py` (CI step
"GATE — Pair 5 data state (Postgres)", guardrail test `pair5_data_state`,
required by `data_state`, `dataset_publish_gate`, `semantic_health`).

## One logical relation

`build_live_base_query_plan` / `resolve_dataset_table_relation` (source →
transformations in stored order → type overrides) is the single definition of a
dataset table's rows. Every reader uses it:

| Reader | Before Pair #5 | Now |
|---|---|---|
| Dataset preview, live charts | logical relation | logical relation (preview dialect = the source's, MySQL included) |
| Snapshot extract | logical relation, **raw `SELECT *` fallback** when planning failed | logical relation or the build fails |
| Quality rules | **raw source table** (a calculated / cast column was invisible) | logical relation; a relation that cannot be built is an `error` |
| Schema monitor | **`columns_cache`** | live columns of the logical relation (`logical_relation_columns`) |
| `schema_drift` quality rule | **`columns_cache`** | the same live reader; type families; unreadable → `error` naming the cause |
| Semantic health (dangling refs) | cache only | live at publish (`dangling_checks(live=True)`); a dangling join / PK blocks |
| Column summary cache | keyed by source only | keyed by source + transformations + type overrides |

A composed (dataset-on-dataset) table carries no shaping of its own: it may
mirror the parent table's type overrides (pinning does), anything else is
refused (`COMPOSED_TABLE_SHAPING_REFUSED`).

## Calculated-column arithmetic

`add_column` / `js_formula` expressions are compiled through the Kernel's
`normalize_division`: true division, `NULL` on a zero denominator — the same
numeric meaning as a semantic measure (Kernel Contract v1). Proven on
Postgres, DuckDB (durable) and MySQL + BigQuery (manual harness, 42/42 values
each; BigQuery `NUMERIC` keeps its fixed 9-digit scale: `4/30000 = 0.000133333`,
an engine type, not wrong arithmetic). The browser preview evaluator propagates
`NULL` through arithmetic and never shows `Infinity`.

A transformation order that provably cannot hold — a reference to a column an
earlier step renamed or removed, a duplicate output name, a rename onto an
existing column — is refused by name (`TransformationError`) before any SQL
runs. A name no step and no source column ever had is left to the engine's
loud "does not exist" (the source list may be a stale cache).

## Monitor truth

| Check | Contract |
|---|---|
| Quality rule | `passed` / failed / `error` (query or relation error) / not evaluated (`skipped` + `no_data`: a custom query with no result row). Only `passed` is a pass. |
| Volume | fewer than 5 history points → `unknown` (learning); a constant baseline breaches on any change |
| Schema (monitor and rule) | live columns vs the **accepted** baseline (the last `ok` check, or the rule's stored baseline); a breach stays breached until a person resolves the incident, which accepts the new schema; an error never re-baselines |
| Freshness | timezone-aware timestamps are converted to UTC before the lag |
| Incident fold | a not-evaluated result neither opens nor resolves an incident; an errored rule opens a critical one |
| Health | `breached > error > unknown > not_monitored > healthy`; healthy only when every check ran and passed. Judged on the checks that RUN (active monitors, enabled rules) and on the rules' **latest run** (`_quality_run_state`): a failed rule is breached at once (not only after a scan folds it), a rule never run is unknown — the dataset list and the overview's quality pillar alike |
| Legacy baselines | a schema baseline from before live reading (columns_cache types, value-sampled) is compared by name only and replaced by a typed one (`SCHEMA_BASELINE_V`) — no false "retype" after deploy |
| Instants | every observability timestamp is emitted as UTC (`…Z`) |

## Publish lifecycle

* The authored design is locked before the build and compared after
  validation: an edit during the sync refuses the publish.
* The published fingerprint is the design **as built** (the build reconciles
  physical types), so a fresh publish is not "changes pending".
* A failed candidate is never pinned; the prior generation keeps serving.
* The reaper only reaps a sync whose progress is stale (20 min); a sync alive on
  another worker is left alone.
* Sync & Publish (`datasetpublish::`) and the background rebuild
  (`snaprebuild::`) exclude each other.
* The scheduler reads the live publish state: an unpublished design edit is
  never deployed by a scheduled refresh.
* A composed child pins the parent generations it **validated**, not whatever
  the parent published meanwhile — and its published fingerprint is taken
  against those pinned generations (after pinning re-mirrors its columns), so a
  parent that moved on reads `changes_pending`, never "published" over an older
  parent. A composed table's stored overrides are the pinned mirror: a parent
  override edit never breaks the child's reads; only an update setting
  different overrides is refused.
* A cross-table quality rule whose referenced table cannot be built is one
  rule's error, never the whole run's.
* The background rebuild claims its lease, then checks the publish lease (as
  the publish does the reverse): no interleaving lets both build.
* No BigQuery snapshot host → the failure says so (it used to read "build có
  bảng lỗi", a table error that did not exist).
* A shaping edit (transformations / type overrides) drops the old relation's
  samples and stats; a failed stats run never clears `schema_change_pending`.

## Browser certification (UI5)

Real Next.js (dev, :3123) + real FastAPI (:8123) + Postgres; screenshots in
`.artifacts/ui/`.

| # | Journey | Result |
|---|---|---|
| UI5-01 | Calculated column `[a]/[b]` (13/7 = 1.857…, 5/0 → NULL shown "—"), model, chart | PASS — preview, model and bar chart match the hand values. The dataset grid's **Add column** entry point is paused by product flag (`ADD_COLUMN_ENABLED = false`, 352d898f); the column was created with the modal's own request from the logged-in browser, then edited in the modal |
| UI5-02 | Edit to `([a]+1)/[b]`, modal preview, save, reload | PASS — 2 / NULL / −2 / NULL / 0.667 / 2.5 |
| UI5-03 | Source column dropped upstream | PASS — every rule `Error` with `column "b" does not exist`; the schema_drift rule names it; dataset page "Could not load data" |
| UI5-04 | Sync & Publish + Refresh History | History PASS (every run recorded, local time). **Successful publish NOT VERIFIED in a browser**: the snapshot host must be a writable BigQuery datasource; the only one reachable (52) is read-only by instruction. Lifecycle covered by the durable tests (D9–D13) |
| UI5-05 | Failed publish → recovery | Failure PASS (sync_failed, banner + toast, nothing pinned, cause named after the fix). Recovery to *published* NOT VERIFIED (same host constraint); recovery of the live reads PASS |
| UI5-06 | Quality pass / fail / error | PASS — distinct states; the fail is the calculated column's row 3 |
| UI5-07 | Observability health / freshness / schema / quality breach | PASS — error before scan, breached after, incidents (warning + critical), times correct after the UTC fix |
| UI5-08 | Chart after drift | PASS — a visible refusal with the cause, no stale numbers |

Cross-layer journey (Pairs 1–5): a never-published dataset over the same
source, calculated column → model → chart → dashboard → public link
(`/d/<token>`). Before: South 2, North 0.6667 (hand). Source change (a 13→20,
b 0→3): after the live cache TTL, South 4, North 1.6667 (hand: 2 + 6/3;
21/7 − 2 + 2/3).

## Old-correct → new-correct

The durable file run on the base commit (`e0bce3f9`): 55 of 62 fail, 7 pass
(the 7 — stored step order, disabled step, a never-seen name failing loudly,
a refused relation never served stale, a query error as error, a failed
candidate never pinned — were already correct and are now locked).
Every failure is a defect this Pair fixes — division by zero / `inf` / `nan`,
quality on the raw table, a no-row rule passing, a constant-baseline drop "ok",
schema drift missed, a not-evaluated rule resolving its incident, a stale
scheduler state, a failed stats run clearing the pending flag, the old
`build có bảng lỗi`, naive timestamps — or a new contract the old code had no
notion of (`health` state; `TransformationError`, whose cases compiled silently
on the base: probed with the exception class stubbed, none raised). Unexplained
CORRECT → DIFFERENT: 0. Pair #1–#4 gates rerun unchanged on the final tree.

## Proof

* Mutation: 34 / 34 killed — each fix put back (division, invalid order, raw
  snapshot fallback, raw quality relation, no-row pass, learning / constant
  volume, schema monitor + rule on the cache, breach re-baseline, fold of a
  not-evaluated result, unknown-as-healthy, live dangling + blocking, reaper,
  mid-sync edit, both leases, scheduler state, parent pin, shaping caches,
  pending flag, freshness tz, UTC instants, no-host message, and the nine
  final-sweep fixes), its test fails; restored, it passes.
* One final independent sweep (read-only reviewer): 2 BLOCKER / 4 MAJOR /
  1 MINOR confirmed, all fixed with tests; of 3 unconfirmed, the DuckDB
  `NULLIF` on text operands was refuted (old and new both refuse to bind `/`
  on VARCHAR — a cast override is needed either way), the duplicate-name
  refusal is this contract (two outputs named `b` were ambiguous), the
  re-mirror flip is fixed.

## Remaining debt (owner)

| Debt | Owner |
|---|---|
| A live (unpublished) read is served from the result cache for up to `LIVE_QUERY_CACHE_TTL` (5 min) after a source change, with no as-of shown on the tile (verified bounded in the browser) | platform / dashboard UX |
| A Postgres / MySQL source has no source-change watermark: a snapshot cannot tell an unchanged source from a changed one | snapshot platform |
| Monitors read the live source, not the published generation (what a published report shows) | observability |
| A calculated / composed table (no datasource of its own) is described by its AppBI definition, not read live | observability |
| `_plan_published` resolves against the current table list (fails closed: an added table refuses an old generation) | semantic platform |
| The dataset grid's Add column entry point is paused by product flag | datasets UX |
| The quality summary counts an errored rule under "failed" (the per-rule state is `Error`) | quality UX |
| The publish failure for a skipped table does not name the table's own error | publish UX |
| Explore table headers show the internal field id (`DATASET_TABLE_105.REGION`) | explore UX |
| `is_claimed_global` probes a lease by briefly claiming it: a real claim racing a probe can be refused once ("already syncing"); transient, the next attempt succeeds | platform |
