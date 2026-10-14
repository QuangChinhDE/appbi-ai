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
| UI5-04 | Sync & Publish + Refresh History | History PASS (every run recorded, local time). Successful publish: verified in the final closure on a writable sandbox host (F3) |
| UI5-05 | Failed publish → recovery | Failure PASS (sync_failed, banner + toast, nothing pinned, cause named after the fix). Recovery to *published*: verified in the final closure (F3, N → fail → N+1) |
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

## Final closure (F1–F5)

### F1 — a cached live result says when the source was read

| Field | Where | Meaning |
|---|---|---|
| `debug.result_as_of` | ChartService (miss: now; hit: the stored miss's value), `_build_debug_response`, the public chart payload | UTC (`…Z`) instant the source was read |
| `debug.result_cached` | same | `true` only when this response came from the result cache |
| `debug.snapshot_as_of` | same | a snapshot read is labelled by its generation, never by the cache |
| `data_as_of` / `data_cached` | Agent Flow `_fetch_chart_data`, dashboard AI `tool_get_chart_data` | what the AI may say about freshness |

The tile (authed and public) shows "As of HH:MM" (`tile-cached-as-of`) when a
cached live read is ≥ 60 s old (`CACHED_LIVE_NOTICE_MIN_AGE_MS`); younger is
indistinguishable from a fresh read. Where AppBI knows the data changed it
invalidates instead: a semantic-health transition drops the dataset's
datasource result caches. A source change AppBI cannot see (no watermark) is
disclosed, bounded by `LIVE_QUERY_CACHE_TTL`. Every instant leaving the API
goes through `time_contract.utc_iso`.

### F2 — a known semantic failure is never healthy

`health = semantic_invalid > breached > error > unknown > not_monitored > healthy`.

| Case | Health |
|---|---|
| all checks ran and passed, model valid | healthy |
| a quality rule failed | breached |
| a monitor errored | error |
| no check ran yet | unknown |
| nothing monitors it | not_monitored |
| model invalid + quality passing | **semantic_invalid** (not healthy) |
| model invalid + no monitor | **semantic_invalid** (not healthy) |
| model repaired + scan | healthy |

`semantic_state(live=False)` reads the stored model (invalid relationships,
dangling references); the scan's `semantic_state(live=True)` reads the live
relation — a relation that cannot be read is a semantic failure naming the
cause, never a pass. `fold_semantic` keeps one incident per dataset
(`semantic:dataset_<id>`, pillar `semantic`) and invalidates the result
caches on every transition, so a chart over a model just found invalid
refuses at once. Layer identity holds: the row keeps its quality / monitor
states; the semantic state is its own column ("Model invalid (N)").

### F3 — Sync & Publish proven in the real UI

Writable sandbox BigQuery snapshot host (`MATERIALIZATION_HOST_DATASOURCE_ID`;
not datasource 52, which stays read-only), source Postgres:

| Step | Generation | South | North | Public | AI |
|---|---|---|---|---|---|
| success N | 1790947821684 | 2.25 (= 9/4) | −0.3095238 (= 13/7 − 5/2 + 1/3) | "Data as of 08:30 PM" | 2.25 / −0.3095 |
| source drops `b` → failure | N kept | 2.25 | −0.3095238 | still N | still N |
| repair (b restored, row 6 b = 5) → success N+1 | 1790948650683 | 1.8 (= 9/5) | −0.3095238 | "Data as of 08:44 PM" | 1.8 / −0.3095 |

The failure banner: `orders: column "b" does not exist … dashboards keep
serving the last published data (08:30 PM)`. Refresh History lists every
run in local time. The first real build exposed a loader defect — a decimal
wider than `NUMERIC`'s 29/9 digits ("Invalid NUMERIC value
1.8571428571428571") — fixed: `verified_bq_type` loads it as `BIGNUMERIC`
(`STRING` beyond 38/38).

### F4 — five-Pair golden journey

Source (Postgres) → calculated column `[a]/[b]` → model → chart → dashboard →
public link → AI (Agent Flow + dashboard bot) → source change → drift
(semantic invalid, chart / public / AI refuse with no number) → repair →
publish → health. Hand numbers as F3; the refusal path is the drift step. Two
defects found and fixed on the way: the AI tool dropped `data_as_of`, and the
claim verifier withheld a correct second-region figure (`target_of` kept one
member).

### Closure review (semantic-guard, read-only)

No BLOCKER / MAJOR. Fixed from its MINORs, each with a test and a killed
mutation: the claim verifier's member match (a name inside a longer one —
"North" in "Northeast" — is not asked for; a longer name consumes its text
first); the legacy live engine's own result cache (custom-SQL / non-semantic
charts) now stamps `result_as_of` / `result_cached` the same way; a cache hit
is flagged cached before the dropped-filter overlay (which may fail); a name an
earlier step created (add-then-rename, chained renames) is never restored as a
source column.

### Proof (closure)

* Old-correct: the closure tests on base `c4dadf8a` — exactly the 11 new /
  extended tests fail (cached read time ×2, semantic health ×3, BIGNUMERIC,
  UTC helpers, the failure cause, the legacy cache, the named members ×2);
  61 Pair #5 + 89 claim tests pass on both. Unexplained: 0.
* Mutation: 48 / 48 killed (24 Pair #5 + 10 closure + 9 sweep + 5 review).
  The overlay-ordering move has no killing test (the overlay cannot be made to
  fail without patching builtins) — declared.

### F5 — durable browser regressions

`e2e/tests/data-state.spec.ts` over `backend/scripts/ci/seed_e2e_data_state.py`
(CI step "Seed the data-state fixture"): cached as-of badge after 65 s;
`semantic_invalid` health with its reason; failed publish keeps last good and
names the cause; a broken relation refuses with the cause. Publish SUCCESS is
not in CI (no BigQuery host there) — certified manually above.

## Remaining debt (owner)

| Debt | Owner |
|---|---|
| A live (unpublished) read can be re-served from the result cache for up to `LIVE_QUERY_CACHE_TTL` after a source change AppBI cannot see — disclosed (tile "As of", `data_as_of`), not invalidated | platform |
| The AI's freshness sentence: the claim verifier withholds the date digits ("as of …") — wording only, numbers are unaffected | AI trust |
| With a snapshot host, an unpublished dataset serves TTL snapshots labelled by snapshot as-of; the public header label is the snapshot's | platform |
| A successful Sync & Publish has no CI browser test (CI has no BigQuery host) | CI |
| A Postgres / MySQL source has no source-change watermark: a snapshot cannot tell an unchanged source from a changed one | snapshot platform |
| Monitors read the live source, not the published generation (what a published report shows) | observability |
| A calculated / composed table (no datasource of its own) is described by its AppBI definition, not read live | observability |
| `_plan_published` resolves against the current table list (fails closed: an added table refuses an old generation) | semantic platform |
| The dataset grid's Add column entry point is paused by product flag | datasets UX |
| The quality summary counts an errored rule under "failed" (the per-rule state is `Error`) | quality UX |
| Explore table headers show the internal field id (`DATASET_TABLE_105.REGION`) | explore UX |
| `is_claimed_global` probes a lease by briefly claiming it: a real claim racing a probe can be refused once ("already syncing"); transient, the next attempt succeeds | platform |
