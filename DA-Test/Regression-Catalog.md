# AppBI Semantic/Dashboard Regression Catalog

**Purpose.** A registry of every significant bug already fixed in the semantic layer, filter system, charts, dashboards, public-link and workboards — with, for each: the **symptom**, **root cause**, **fix location**, and **the test that locks it (or a GAP marker if none)**. The goal is to stop the recurring failure mode: *fix a bug, ship it, but never add a locking test → a later refactor silently reintroduces the old bug.*

**How to use this catalog.**
1. **Before touching an area**, run that area's locking tests (see §1) and snapshot the golden SQL baseline — you now know the current correct behavior.
2. **After a fix**, the area's existing tests must still pass AND you must add a case for the *new* scenario. If the area is marked **GAP** in §3, writing the missing test is part of the fix.
3. A change is safe only if the golden/contract tests are unchanged, or the diff is reviewed as intentionally-more-correct and re-captured with rationale.
4. Source of truth for behavior = the SQL the engine emits + the executed numbers, not intuition. Reproduce on a real fixture first.

---

## 1. Test inventory — what locks what (run these)

All run inside the backend container; CI runs the unit tier on every push, golden on a seeded Postgres.

| Suite | Run | Locks |
|---|---|---|
| **Golden filter matrix** (16–17 cases, ds56/ds55) | `python scripts/regression_filter_matrix.py --verify --tag snowflake` | Fan-out→EXISTS, conformed-dim transitive filter, multi-hop, chasm grain fail-loud, cross-table measure re-anchor, declared measure |
| **Locked contract** (60) | `pytest tests/test_locked_contract.py` | agg-default=auto (not SUM), hard/soft dropped-filter policy, `AmbiguousFieldError⊂ValueError`, `_parse_field_ref`, `_measure_fact_view` grain, pivot count/avg/min/max semantics, grain validator, scatter reclassify |
| **Measure rendering** (19) | `pytest backend/tests/test_semantic_measure_render.py` | agg wrapper + count_distinct spelling, expression-over-sql, filters/where_sql CASE WHEN wrap (not WHERE) + AND-join, quote escaping, BUG-018 unquoted numeric literal, ratio depends_on enforcement, circular/unknown fail-loud. REBUILT 2026-09-15 — the original `test_semantic_query_engine_measures.py` was never committed. |
| **Dialect-structural** (14) | `pytest backend/tests/test_dialect_structural.py` | BigQuery-vs-Postgres SQL SHAPE with no warehouse: SAFE_CAST/FLOAT64 vs REGEXP-guarded cast, numeric literal never quoted on EITHER dialect, a test that the dialects provably diverge (catches a dialect-blind refactor), symmetric-aggregate allow-list excludes Postgres, superseded engine flags stay OFF. Closes the gap where PG-only CI cannot see a BigQuery 400. |
| **Filter propagation** (13) | `pytest tests/test_phase2_filter_propagation.py` | PLAIN/JOIN_CHAIN/EXISTS/DROP routing, fan-out detection, unreachable/ambiguous |
| **Relationship metadata** (25) | `pytest tests/test_phase1_relationship_metadata.py` | cardinality normalize, bidirectional edges, BFS path, ambiguity |
| **Layered merge** (21) | `pytest tests/test_filter_layered_merge.py` | filter precedence (link_locked > dashboard_locked > visible > viewer_slicer > chart_base), link_hidden field-drop, empty-lock no-op |
| **Distinct self-target** (8) | `pytest tests/test_distinct_self_target.py` | slicer dropdown excludes its own field, other filters cascade in |
| **Symmetric aggregates** (20) | `pytest tests/test_phase4_symmetric_aggregates.py` | Looker MD5 dedup per dialect + fallback conditions |
| **Measure rendering** (33) | `pytest tests/test_semantic_query_engine_measures.py` | sql/expression/filters/where_sql, quote-escaping, NULL-safe, dataset-scope source loading |
| **Error contracts** (16) | `pytest tests/test_phase15_error_contracts.py` | ValueError→400, VN messages, two-path implicit-measure hint |
| **Entry schemas** (10) | `pytest tests/test_filter_entry_schemas.py` | publicMode visible/locked/hidden parse, locked-vs-hidden split |
| **Explore==Dashboard parity** | `python scripts/test_explore_dashboard_parity.py` | preview SQL/data == dashboard tile (scatter, raw bar, cross-table bar) |
| **Golden-SQL chart baseline** (94 charts, ds56/103/111, PG+BQ) | `scratchpad/golden_sql_harness.py` (+ baselines) | non-regression of *every saved chart's* generated SQL on both dialects |
| **Galaxy golden + public no-trap** (ds113, PG galaxy: 3 facts + conformed dims + snowflake) | `python scripts/verify_galaxy_golden.py` | 14 numbers (cross-fact no-fanout, conformed-dim→all facts, snowflake 2-hop, last-month, numeric coercion) + 7 distinct-cascade (incl. screenshot level←date, OR-EXISTS across facts, numeric kpi) + 4 **public slicer no-trap** (soft date relaxes when empty, security lock honored) |
| **Distinct-cascade BigQuery gate** (multi-fact + aggregated `GROUP BY` sql_query views, no direct owner→date) | `CI_FIXTURE_SEED=1 python scripts/verify_distinct_cascade_bigquery.py` | **DIALECT-STRUCTURAL** (forces bigquery, asserts generated SQL shape — the ONLY way to catch this class, since PG runs all shapes): slicer←Date multi-path cascade emits `base INNER JOIN (perpath-key UNION DISTINCT …) ON base.k=keyset.k` — no correlated EXISTS, no OR-of-INs, no IN-over-aggregated-subquery; + PG value check (member reachable via only one fact is included, out-of-range excluded) |
| **E2E (Playwright)** | `e2e/tests/*.spec.ts` | D1 every tile renders, D2 filter narrows, chart-type gallery (32 types render). Many filter cases are **fixme** (scaffolded, report SKIPPED) |
| **AI Bot insight capture-the-flag** (InsightBench-style, needs BYOK key) | `AI_KEY=... python DA-Test/insight_ladder_harness.py --token <fixture> --flags flags.json` | exploration engine (/ai/agent/explore) still DISCOVERS the planted insights of a fixture dashboard: one-to-many LLM-judge per flag (>=5/10 = found); gates prompt/engine changes on the AI Bot |

---

## 2. Bug registry (by area)

Legend for **Test**: ✅ = locked by a named test; ⚠️ = partial; ❌ **GAP** = no automated regression test (see §3).

### A. Fan-out & grain (silently-wrong-number class — highest risk)
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| Snowflake fan-out double-count (rev←deal.org_id = 2400 not 1200) | every filter view LEFT-JOINed into FROM; 1:N hop multiplies | Phase-B' split SELECT-side vs filter-only; filter-only→EXISTS (`semantic_query_engine._build_filter_exists_clause`) | ✅ G09, G13; test_phase2 |
| Chasm group-by (rev by deal.title = 4000/3600 non-deterministic) | grouped dim on an unrelated fact, joined via shared-dim chasm → fan-out | `_validate_group_grain` fail-loud; only M:1-reachable dims allowed | ✅ G_GRAIN; test_locked_contract grain_validator |
| Cross-fact measure base-scope dependency (same measure differs by base) | cross-fact measure LEFT-JOINed off base → base key domain scopes it | measure isolation: scalar→correlated subquery; single-fact→re-anchor; multi-fact→`_build_dimensioned_multifact_sql` stitch ([[measure_isolation_engine]]) | ✅ G14/G15; test `_measure_fact_view` |
| EXISTS correlated to BASE not deepest shared-key node (SDR 7597≠3917) | `resolve_path` from base picked sibling-fact bridge | correlate to deepest joined node + `resolve_paths` AND-of-shared-dim-paths ([[filter_exists_correlation_chasm_trap]]) | ✅ G10/G11 |
| Multi-fact stitch inner-LIMIT truncation (latent) | per-fact `_mf` CTE inherited outer row-limit, un-ordered → mismatched/NULL rows | per-fact CTEs unbounded; limit only on outer stitched result (2026-06-29) | ⚠️ baseline-neutral 0/94; **add explicit small-limit cross-fact case** |
| Symmetric-aggregate fan-out dedup | SYMMETRIC-mode filter introduced 1:N at SELECT | Looker MD5 `SUM(DISTINCT hash+val)-SUM(DISTINCT hash)`, BQ-only by default ([[symmetric_postgres_pessimization]]) | ✅ test_phase4 |
| Many-to-many cartesian fan-out | M:N joins allowed without warning | advisory warning surfaced; grain validator guards | ❌ GAP (advisory only) |

### B. Type coercion & filter literals
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| **BUG-018** INT64 = STRING (BQ 400) on measure filter | FE string value quoted blindly vs numeric column | type-aware literal: coerce + unquoted + SAFE_CAST column (`_filter_type_family`,`_coerce_typed_filter_value`) | ✅ measure suite; commit 37c7b4a |
| BUG-018 redux: non-dimension numeric column still `='1'` | `_filter_type_family` only read declared dims | `_physical_source_type` fallback to columns_cache (2026-06-29) | ⚠️ verified red→green ad-hoc; **no committed unit test** |
| Distinct-dropdown cascade INT64 BETWEEN STRING (BQ 400) | `_render_filter_condition` quoted blindly, no coercion | threaded field_family+dialect, reuse engine coercion (commit e452e5c) | ⚠️ live-verified; **no committed unit test** ← see §3 |
| SUM(STRING) on Airbyte/Sheets numeric-text | SUM over physical-STRING col | `_measure_value_is_string_typed` keys on physical source_type → SAFE_CAST | ⚠️ [[sum_string_physical_type_gate]]; partial |
| LIKE/contains on DATE/number → invalid SQL | pattern op on non-text from legacy/API | `_field_rejects_pattern_operator` soft-drop | ❌ GAP (no test) |
| Postgres numeric coercion emitted DuckDB `TRY_CAST` (500) | dialect branch wrong for PG | `build_safe_cast_sql` PG `CASE WHEN ~ regex THEN CAST` | ✅ G07/G08/G15 |

### C. Measure semantics
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| agg='auto'/unknown silently → SUM (clobbers count_distinct/%-of-total) | default_agg='sum' overrode declared type | default_agg='auto'=use stored type; `_VALID_AGGS`+=percent_of_total | ✅ test_locked_contract metric_* |
| **BUG-007** cross-table measure `${B.col}` → "Unrecognized name B" | depends_on / source_columns views not added to FROM | pull measure-fact views into FROM + re-anchor (`_measure_fact_view`) | ⚠️ partial (G14); bare-ref case ❌ |
| Implicit measure "X not found" on raw numeric drag | auto_generate_measures off → numeric=dim, no measure | Phase-15.7 synthesize SUM(field) on the fly | ✅ qa_user_journey Phase-15 |
| Non-count measure missing sql/expression → wrong column | only count defaulted | Phase-15.29 fail-loud at schema validation | ✅ schema validator |
| Measure formula double-aggregation (SUM(SUM)) | expression w/ aggregate but depends_on empty | fail-loud guard | ✅ measure suite |
| COUNT forced to COUNT(*) (can't COUNT(column)) | FE hid column selector for count | FE show optional column for count (de0ae00) | ❌ GAP (FE, no test) |
| Pivot count/avg/min/max → silent SUM; %-of-total no per-cell form | `_render_pivoted_measure` else=SUM | mirror `_render_measure` type handling; %-of-total fail-loud | ✅ test_locked_contract pivoted_* |

### D. Filter routing / propagation / distinct-values
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| measure filter routed to WHERE (should HAVING) | no role split | `_split_filters_by_role`→`_build_having_clause` | ✅ contract |
| cascading filter INNER-JOIN drops base members | LEFT JOIN+WHERE acted as INNER | Phase-15.94 per-filter EXISTS preserves cardinality | ⚠️ logic; distinct cascade ❌ |
| public slicer empty: single resolve_path drops members w/ data in other fact | one path picked | OR-EXISTS across facts ([[distinct_cascade_single_path_bug]], commit 0a6a159) | ⚠️ self-target unit only; **full cascade ❌** |
| distinct self-pin (public re-injects dashboard default on slicer's own field) | layered merge re-added self-field | strip self-field in `get_distinct_field_values` | ✅ test_distinct_self_target |
| measure filter on related view → "missing FROM entry" | inline predicate on unscoped dim | rewrite as correlated EXISTS (CALCULATE parity) | ⚠️ |
| cascading filter on key-not-declared-as-dim silently skipped | existence check only declared dims | include columns_cache cols (Phase-15.97 bug D) | ❌ GAP |
| distinct-values SQL error escaped as broken slot | no try/catch | Phase-15.95 catch→empty + dropped_filters banner | ⚠️ |
| "remaining slicers don't LIMIT by applied filters" (reported 2026-06-30) | NOT an engine bug — **verified live via Playwright** the cascade DOES limit after Apply: d=67 (PG) Bang khách hàng 27→**21** states for year=2016 (`dropped_filters:[]`); d=31 (BQ) product_name applied date=2024+revenue_band, 13 products, no drop. When a user's slicer shows ALL (unlimited) the BE **DROPPED** the cascade filters (`dropped_filters` non-empty → "Try relaxing: …") = no join path from the dropdown's view to the filter views, OR a per-probe SQL error — a per-dashboard MODEL/relationship issue, not the engine. | Diagnose via the live `/filters/distinct-values` network response: read `dropped_filters[].reason` (no_join_path vs sql_error) for the field that won't limit. | ✅ cascade-limiting verified live (d=67/d=31); per-model drop = needs that dataset's relationships |
| **BUILDER calendar role-play slicer (e.g. "Năm"/year) stuck "Loading values…" / can't filter** (public link worked, builder didn't — reported 2026-06-30) | the builder built its filterable columns ONLY from chart-binding `reachableFields` + `model.views` (`dashboards/[id]/page.tsx` `semanticColumnsResult`). Synthetic CALENDAR ROLE-PLAY views (`…__<col>__date_dim`) are NOT in `model.views`, so the year slicer's column lookup in `activeSemanticDistinctTargets` returned undefined → the field was skipped → its distinct query never fired (network: only the plain dims fired) → dropdown hung forever. Public was fine because the BE guarantees slicer fields (`_augment_with_slicer_fields` + `_build_public_calendar_filter_fields`). | `activeSemanticDistinctTargets` now FALLS BACK to a column synthesized from the slicer/filter itself (`{key,name,label,type,datasetId,semanticField}`) when the chart-binding lookup misses — parity with the public augment. FE-only. | ✅ Playwright (d=67 builder): Năm loads 2016/2017/2018 + Apply filters charts (2016 → GMV 57.2K / 329 orders / monthly chart 2016-only); public re-verified non-regression |
| **Filters PANE card stuck "Loading values…" forever** (the "filter page lại lỗi" report — a "City" filter card hung; screenshot showed it alongside "Order Approved At = Tháng này") | `FilterPane.tsx` `FilterCardPBI` → `CategoricalChecklist`/`CategoricalRadio` rendered `values.length === 0 ? 'Loading values…' : 'No match'` — the card received `distinctValues` but **NOT `distinctStatus`**, so it could not tell "still fetching" from "fetched and got []". A sibling filter (date = this-month) cascades the card to a range with **no rows** → BE returns `[]` → card hangs "Loading…" forever. (The `<FilterPane>` was already PASSED `distinctStatus` by the builder; it just never threaded it to the cards.) | thread `distinctStatus` FilterPane→Section→FilterCardPBI→checklist/radio; empty+done now shows `noValuesActiveFilter`/`noValuesAvailable`/`failedToLoad`, "Loading…" only while `isLoading`. (Same class as the public-banner + slicer fixes — the pane was the 3rd surface missing status.) FE-only. | ✅ Playwright (d=67 builder): added Order Approved At=Tháng này + City → City card shows "No values match the active filter on this dashboard." (not stuck); City alone (no cascade) still lists all cities |
| **★ ROOT CAUSE of "filter không ra giá trị" on BigQuery — distinct-cascade CORRELATED subquery** (found on LIVE report-demo dashboard 64 "[SALE] BC Performance" / ds68, 2026-07-01) | `get_distinct_field_values` → `_emit_exists_for_single_path` built a CORRELATED `EXISTS (SELECT 1 FROM <fact JOIN Date> WHERE base.x = d0.y AND <date filter>)` for a cross-entity slicer cascade (owner-dim slicer ← date filter that lives on the Date view, reached via a fact). **BigQuery 400: "Correlated subqueries that reference other tables are not supported unless they can be de-correlated … into an efficient JOIN."** So EVERY slicer (BC NAME/LEVEL/TEAM/PHÒNG/ROLE/TTKD) returned 0 + `dropped:["sql_error"]` whenever the Date filter was active → empty dropdowns. **Postgres ACCEPTS correlated subqueries**, so all my local PG fixtures passed and never caught it — the miss was dialect-blindness (see [[verify_with_browser_before_ship]] → add: test the actual warehouse dialect, not just PG). Chart-data path was fine (it JOINs, not correlated-EXISTS). | de-correlate in `_emit_exists_for_single_path`: `base.x = d0.y` (single-equality first hop) → `base.x IN (SELECT d0.y FROM <body> WHERE <leaf> AND d0.y IS NOT NULL)` — non-correlated semi-join, BQ-valid, identical on every dialect; composite/non-splittable correlation falls back to correlated EXISTS. `backend/app/services/dataset_model_service.py`. | ✅ galaxy ds113: BQ-dialect SQL now `sdr_id IN (SELECT … FROM fact JOIN date WHERE … AND sdr_id IS NOT NULL) OR …` (no EXISTS, no base-correlation, backtick-quoted); PG 25/25 still pass. **UPDATE 2026-07-01 — de-correlation was only LAYER 1 of 3.** On real BigQuery it exposed two more BQ-only limits, each still invisible on Postgres: **(2) OR-of-IN subqueries** — the cascade is multi-path (owner reaches Date via ≥2 facts) so it built `(k IN (s1) OR k IN (s2))`; BQ won't decorrelate an IN nested in OR → merge same-key paths with `UNION DISTINCT` into one IN (commit 477e23f). **(3) IN over an aggregated/windowed CTE** — ds68's fact views are CTEs with `GROUP BY`/`COUNT(DISTINCT)`/`SUM() OVER`; BQ won't flatten `k IN (SELECT … <aggregated> …)` into a semi-join → emit the explicit `base INNER JOIN (keyset) ON base.k = keyset.k` the error literally asks for (commit a8fd49c). Net final SQL: one INNER JOIN whose keyset is the per-path key SELECTs `UNION DISTINCT`-ed. **CONFIRMED on real BigQuery** (report-demo ds68 / dashboard 64): 17/17 authed live cascade matrix (Date→all 6 owner slicers, strict-empty Date=2099, same-table TEAM→PHÒNG, self-exclusion, chained Date+TEAM, dashboard-filter TT) + galaxy 25/25 + **PUBLIC LINK 18/18** (live token, `/public/dashboards/{token}/filters/distinct-values`): Date-cascade all 6 slicers no-error, RC02 visible-filter honored as a HARD bound (TT dropdown=RC02 only; viewer forcing Trung_tam=RC01 → 0 rows, forcing ALL centers → still only RC02's 29 = `applyScopeBound` intersect, no escape/leak), self-exclusion, strict-empty, viewer TEAM→BC(8/29)/PHÒNG narrows. Diagnosed by adding `/api/v1/health` capability probe (to prove which commit is live) + `distinct-values?explain=1` (returns the generated SQL). **✅ Runnable gate: `scripts/verify_distinct_cascade_bigquery.py`** — BQ-dialect STRUCTURAL check (asserts INNER JOIN + UNION DISTINCT, no IN-subquery / no OR / no correlated); a PG value-test alone CANNOT catch a re-regression because PG runs all four shapes. |

### E. Calendar / time
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| role-played calendar filter "View …__date_dim not found" / wrong | engine loaded role-played view | `_rewrite_calendar_filter_to_all_roles` + `_build_calendar_expr_from_base` on source col | ⚠️ |
| multi-date fact: synthetic Date fanned across all date cols → ~0 rows | AND across won/lost/close NULL-prone cols | `_collapse_fanned_calendar_filters` to primary calendar | ⚠️ |
| MySQL DATE_TRUNC syntax error | assumed SQL-standard | dialect branch DATE_FORMAT/MAKEDATE | ❌ GAP |
| BQ PARSE_DATE on already-DATE/INT col (400) | over-eager PARSE_DATE | CAST migration ([[bq_parse_date_nocast]]) | ❌ GAP |
| **Timezone stored but NOT applied** in time SQL | never wired | — (open; deferred — would change numbers) | ❌ GAP (known-open) |
| date-slicer "last month" empty dropdown (2026-06) | **correct**: sparse fixture data ends Feb-2026 → no data in last month; cascade SQL byte-identical to HEAD | n/a — not a bug | **GAP: no test for date-slicer→dim cascade across role-played dims** ← biggest gap, matches the symptom that triggered this catalog |

### F. Dashboard filter merge / slicer scope / public link
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| empty-lock leak / scope-escape (303K→11M) | merge order put slicer above locked; empty lock dropped bounds | reorder `_LAYER_ORDER`; `link_entry_has_value` single authority ([[public_link_empty_lock_leak]]) | ✅ test_filter_layered_merge |
| page-filter clobbered by empty same-field slicer | dedup-keep-one dropped page scope | value-aware dedup / `applyScopeBound` intersect ([[page_filter_empty_slicer_clobber]]) | ⚠️ FE, no unit |
| slicer value outside page-scope → FE drops page filter→leak | scope not hard-bound | `applyScopeBound` intersect ([[filter_page_scope_hard_bound]]) | ⚠️ |
| public page-filter leaked across tabs | pageScopedKeys not reset | reset on page switch ([[public_page_filter_scope]]) | ❌ GAP |
| per-page slicer scope (global vs this-page) | slicers were dashboard-global | `scope:'all'|'page'`→pages_config ([[slicer_per_page_scope]]) | ❌ GAP |
| slicer scope-toggle reordered card/jumped popover | order moved across render boundary | pin order by id ([[slicer_scope_toggle_reorder]]) | ❌ GAP |
| public link used authed client → 401→login | not publicClient | publicClient only ([[public_link_no_authed_calls]]) | ❌ GAP |
| public distinct allow-list = link constraints (too narrow) → exposed bug | widened to viewer inventory (commit 105eb93) | (exposed the distinct type-coercion bug, since fixed) | ⚠️ |
| **Public slicer dropdown FLASHES amber "No values match — Try relaxing…" banner DURING loading** (reported 2026-06-30, screenshot: banner shows while chart "Loading…", then values appear — "vàng xong lại ra data") | `usePublicFilterDistinctValues` returned ONLY values, no per-field query status. So on the public path `distinctStatus` was **undefined** → the FilterCard guard `!distinctStatus?.isLoading` was vacuously true → the banner rendered while the distinct query was still in flight (and on every refetch). The AUTHED dashboard page already built `semanticDistinctStatus` with `isLoading: isLoading\|\|isFetching` (covers refetch), which is why Builder never flashed it. | Hook now returns `{ values, status }` where `status[getColumnKey]={isLoading:isLoading\|\|isFetching,isError,hasFilterContext}` (parity with authed); `d/[token]` + `embed/[token]` pages destructure and pass `distinctStatus`. Banner now suppressed during load AND refetch. Verified: FE rebuilt+redeployed, public dropdown renders values cleanly, 0 console errors. | ✅ Playwright (live d=67) + tsc; FE-only |
| **Public slicer dropdown EMPTY while Builder is fine** ("filter lọc không ra giá trị", reported 2026-06-30) | public `_build_public_chart_filters` injects the SOFT layers (visible page-filter `filters_config` + saved/sibling slicers) into every slicer's distinct cascade; Builder sends only the viewer's active picks. A date range / sibling-slicer pick with no overlapping data → EXISTS matches nothing → empty dropdown. (My e452e5c coercion fix un-broke cascades that previously errored→silently-dropped, esp. numeric/`year` on BigQuery, so the filter now actually APPLIES → surfaced the empty on public/BQ.) | **no-trap fallback**: `_build_public_chart_filters(..., security_only=True)` keeps ONLY authoritative/locked layers (`dashboard_filters_locked`, `link_locked`, enforced `link_hidden`), drops soft (visible page-filters + slicers); `get_public_filter_distinct_values` retries with it when the full cascade returns empty. Soft filters never trap; locks still bound (no value leak). Default path byte-identical → 0 regression ([[public_slicer_dropdown_notrap]]) | ✅ `verify_galaxy_golden.py` no-trap A/B/C/D (ds113, PG) |

| **Builder vs public number MISMATCH** (report-demo dash64: build shows 1.2B, public 16.4B — reported as "Filters on this page ko work ở Dashboard nhưng có lọc ở Public") | TWO non-engine causes: **(A) DRAFT-vs-published** — Builder sees `draft_snapshot` merged (had a TEMP exploratory slicer pick crm=Hồ Văn Hoàng); public serves the published base (slicers empty) + the link's own `public_link_hidden_filters` (RC02). Proven NOT an engine bug: same filter-state ⇒ build==public (RC02-only=16.4B on both). Publish copies `draft_snapshot.slicers_config`→base (dashboards.py ~1909) → aligns. **(B) Builder fetched each tile UNFILTERED first** (wave-1, scans ALL) then filtered — `ChartTile`'s query wasn't gated on filter-seeding (the public page gates via `filtersSeeded`), so a flash of unfiltered numbers = "filters don't work". | (B) gate `ChartTile` `enabled` on `filtersReady && serverFilterKey === debouncedFilterKey` (filtersReady threaded page→DashboardGrid/DashboardCanvas→ChartTile, default true; key-equality waits for the 300ms debounce to catch the seeded filters). commit cef8d35, FE-only → no engine/query change. | ✅ localhost dash53: chart-data calls 10→5, **0 unfiltered**, tiles render filtered, stable; BE gates re-run green (distinct 8/8, galaxy 25/25). Interactive user-change verified transitively (initial seed = same change→debounce→fetch path). ⚠️ needs FE rebuild on report-demo to take effect there |

### G. Cross-filter / cross-highlight
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| cross-filter only sent primary field, linked charts not filtered | linkedFields not expanded | `expandLinkedFilterTargets` | ❌ GAP |
| date-bucket cross-filter used equality not range | bucket = point | range filter ([[dashboard_cross_highlight]], commit da0f12e) | ❌ GAP |
| cross-highlight sibling spread (non-directional) | both directions | directional lineage (commit a49c417) | ❌ GAP |

### H. Charts / rendering / chart-types
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| **BUG-016** Bubble/NINE_BOX axes not self-aggregated | cross-fact raw axis folded wrong / not folded | fold cross-fact measure axes into measures; keep Data-Model agg (commits 7450b7a/5c34cc0/fecb651) | ✅ test_locked_contract bubble/nine_box |
| chart↔dashboard format divergence (36.2% vs 0.4) | tiles missed formatMap/labelMap | fix chart-semantic-maps.ts ([[chart_vs_dashboard_format_divergence]]) | ❌ GAP |
| GroupedBar/Ribbon/Heatmap/Sankey crash Explore | no chart error-boundary; SUM-on-STRING 400 | error boundary + gates ([[chart_type_fe_crashes]]) | ⚠️ gallery "renders" only |
| dashboard chart-order ≠ build order | no order_by | order_by=DashboardChart.id ([[dashboard_chart_order_divergence]]) | ❌ GAP |
| preview clamped chart limit to 5000 | Phase-15.83 leftover | removed clamp (commit 9584139) | ⚠️ |
| various Explore trend/composition/relationship chart bugs | per-group | [[trend_group_explore_fixes]],[[composition_group_explore_fixes]],[[relationship_group_explore_fixes]] | ⚠️ gallery only |

### I. Cache / concurrency
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| same tile cache-MISS 3× → 3 BQ queries | concurrent identical computes unsynced | single-flight per-key lock (`query_cache.single_flight`) | ⚠️ |
| cache-key collision field→list collapsed to [] → all filtered share no-filter result | list change broke projection | flatten list in cache projection ([[snowflake_transitive_filter_chain]]) | ⚠️ |
| UI-only filter fields caused cache miss | key not normalized | `_canonicalize_filter` | ⚠️ |

### J. Joins / model / identifiers
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| Generate-Model join target hard-coded "id"→breaks on <entity>_id | heuristic wrong | `_resolve_heuristic_target_column` ([[model_autojoin_pk_id_bug]]) | ❌ GAP |
| bare column ambiguous in multi-view ("Column X ambiguous") | legacy bare sql | Phase-15.61 auto-qualify `${TABLE}` | ⚠️ |
| identifier with space "Activity Group" → BQ parse error | unquoted bare | `_quote_ident` backtick/double-quote when non-alnum | ⚠️ |
| execute-table measure not reclassified dim→measure → 400 | preview path own resolver | reclassify by declared-measure registry ([[execute_table_measure_reclassify]]) | ✅ parity smoke |
| ambiguous join path picked arbitrarily | BFS first-match | `resolve_paths` ambiguity flag | ✅ test_phase1 |

### K. Workboard (mini-app)
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| import: model leaks across datasets (dataset_table_<id> tokens) | tokens not remapped | remap OLD→NEW incl from_table_id ([[workboard_import_dataset_table_token_leak]]) | ❌ GAP |
| multi-page public form silently POSTed partial | button type flipped | distinct keys + type=button ([[workboard_form_multipage_submit_flip]]) | ❌ GAP |
| pre-Phase-13 grid/list screens 500 the list | old kind under new schema | read-side shim + tolerant list ([[workboard_pre_phase13_legacy_screen_500]]) | ❌ GAP |
| Sheets: no pagination/empty-PK/page-only totals/fail-closed RLS | Sheets gaps | gate widened {sheets,pg,mysql} ([[workboard_core_gaps_audit]]) | ❌ GAP |
| `POST /datasets/{id}/tables/{tid}/profile` → 500 `'DatasetTable' object has no attribute 'name'` (ALL tables, universal) | `db_table.name` doesn't exist on the model (renamed to display_name/source_table_name) | `backend/app/api/datasets.py` profile payload → `source_table_name or display_name` (2026-06-30, found via workboard-MCP smoke) | ⚠️ smoke: scratchpad `smoke.py` profiles existing+new tables |
| workboard-MCP: manual source attached but `columns_cache` empty + workboard apply opaque-fails | (a) `create_manual_source` wrote legacy `{columns,rows}` not `{sheets}`; (b) workboards reject `manual` source (PG/MySQL/Sheets only); (c) publish blocked while owner on default PIN | MCP `appbi_wb_source` emits `{sheets}`; guide+validator warn on source-kind + owner_pin; apply rotates owner PIN before publish ([[mcp_workboard_full_journey]]) | ⚠️ 19/19 live smoke |

### L. Deploy / FE build
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| `docker cp .next/static` nests static/static → ChunkLoadError | cp into existing dir | wipe-as-root + copy contents + verify 200 ([[fe_static_deploy_nesting_trap]]) | n/a (procedure) |
| partial-commit dropped provider → prod 502 | selective stage missed file | gate on committed tree ([[partial_commit_dangling_provider]]) | n/a (gate) |

### P. Agent Flow / Direct Chat
| Bug | Root cause | Fix | Test |
|---|---|---|---|
| Studio test panel printed `—` for a valid `metric` answer while the run reported `ok` | the panel rebuilt the answer from the `markdown` field alone; `metric`/`table`/`chart_ref`/`callout` carry none, and the local type said markdown-only so the compiler allowed it | render through the shared `AnswerBlocks`, the component chat and the public bot already used; widen the envelope type to the real union (`5d376fa`) | ✅ `qa:answer-parity` + `e2e/tests/answer-parity.spec.ts` (all six variants) |
| An answer block variant the frontend does not know renders as nothing, on every surface | `AnswerBlocks` ended its switch with `default: return null` | marked fallback that salvages any text the unknown block carries (`5d376fa`) | ✅ `qa:answer-parity` asserts the default is not silent |
| A coordinator's lane was invisible to every authoring check at once — flow answered "13,591,643.70" (the report's grand total) to "which category earned the most" | container topology re-derived by hand in `all_nodes()` and 47 frontend branches; `coordinate` was added to some and not others | one declaration in `contract.CHILD_SLOTS`, served on `/nodes`; the five FE walkers read it (25 branches → 0) (`1507b96`) | ✅ `test_node_child_slots.py` (derives containers from the models) + `qa:node-topology` (FE/BE agree) |
| Guardrail returned `unknown` for the whole subsystem, and matched `auth_permissions` for "**auth**oring" | `agent_flows`/`direct_chat` unregistered; keyword matching was a plain substring test | both features registered; whole-word matching with inflections added for the short keywords (`0e0ab44`) | ✅ `guardrail_check --files` names the feature and its gates |
| 12 committed Agent Flow suites never ran in CI, and `verify.py` reported "ok" | `git add -f` without the allow-list or the workflow; the check compared allow-list against workflow, two sets that happened to be identical, and never looked at a suite in neither | allow-listed + wired; `verify.py` now also reports committed suites no runner references (`0e0ab44`) | ✅ `scripts/ci/audit_test_reachability.py` — Agent Flow ghosts 43 → 0 |
| A literal `\n` in the workflow's pytest command made pytest exit 4 — the whole 42-suite list never ran, and every local gate stayed green | a line continuation written as an escape sequence instead of a newline | real continuation; `verify.py task` now fails on a literal escape in the command and on a test path the workflow runs that is not in the repo (`b785762`) | ✅ mutation-tested: reintroducing the escape fails the check |
| Every follow-up question rendered twice — dead prose in the bubble, a chip under it | `extractFollowups` ends in a heuristic that scrapes trailing question lines out of prose, written when an answer WAS prose. Once `AnswerBlocks` rendered the envelope, the text block showed the questions verbatim and the heuristic scraped them back out for chips | guard the chip row on the absence of blocks, on both surfaces that run the heuristic; the dashboard bot had been doubling on `demo` all along (`e4154b1`) | ✅ `qa:answer-parity` rule 5 — mutation-tested, removing the guard fails by name |
| 13 E2E specs failed as "flow list did not render" / "Test button not found" — the same 9 passed locally in 11.6s | `middleware.ts` VERIFIES the session JWT (jose) and falls back to `change-this-in-production`; the backend signs with a fallback of `dev-secret-key-change-in-production`. The E2E job set neither, so the middleware rejected every token the backend issued and each authed page redirected to /login. docker-compose hides it by giving all three services one value | set `SECRET_KEY` job-wide in `e2e.yml`, reaching uvicorn, `next build` and `next start` (`73d4c7a`) | ✅ `verify.py task` fails any workflow starting both processes without it while the defaults disagree — mutation-tested |

### O. Dashboard theme (skin / preset)

| Bug | Root cause | Fix | Test |
|---|---|---|---|
| **Opening Theme settings and pressing Save — changing NOTHING — silently dropped the Modern skin** (report fell back to the flat classic look while the Modern template still showed as selected) | `DashboardThemeModal` seeds its working state from `initial` with an explicit key list that omitted `skin`; `submit()` then wrote `skin` only `if (theme.skin === 'modern')`, so the key was absent → dropped. `presetId` WAS carried, hence the "still ticked" illusion | seed `skin` from `initial`; write it explicitly in both directions on submit (`'modern' \| 'classic'`, never absent) | ✅ live dash-67: before = `has_skin:f` + DOM `data-dashboard-skin=classic`; after = `modern` on a no-op save |
| Modern was only reachable by keeping a Modern preset untouched (skin was bundled INTO the 3 Modern presets) | no separate concept of skin vs preset in the UI | "Design language" picker (Modern/Classic) above the templates; presets still set a skin, but the user can flip it independently. Switching to Modern nudges a still-classic card to soft/16px so the accent bar doesn't render on a sharp 0-radius card | ✅ live: picker renders, Modern stays selected after save |
| A preset stayed ticked after the user edited away from it | no notion of "customised" | `isCustomised` derived by COMPARING the theme against the preset (works for themes saved by older builds too) → badge "Custom — based on X" + "Reset to template"; footer "Undo my changes" restores what the dashboard had on open | ✅ live: changing an accent flips the badge on and unticks the card |
| Theme "Label size" control did nothing | `labelFontSize` was written to the theme + published on the context, but NO component read it (the CSS var `--dashboard-label-size` is also written and read by nobody) | `ExploreChart` now resolves axis/label font size as explicit style → theme `labelFontSize` → responsive default | ⚠️ code-verified; needs a visual case |

**Token-coverage audit (2026-07-30)** — what actually reaches a chart today: `dataColors`, `gridlineColor`, `axisLabelColor`, `skin`, `displayUnits` (ExploreChart) · `titleFontSize`/`titleColor` (ChartTile + ReadonlyChartTile) · `kpiFontSize`, good/neutral/bad (KpiCard). Written-but-unread: the five `--dashboard-*` CSS vars (harmless duplicates of the context) and, until this fix, `labelFontSize`. **Not themed at all yet: Table/Matrix, Slicer/Filter, filter pane, tooltip, legend chrome, text widget, empty/error states** — that is the P1 scope, and it is why a report can still look "half-designed" after a theme change.

### M2. Snapshot export (1 dashboard page = 1 sheet)

| Bug | Root cause | Fix | Test |
|---|---|---|---|
| Every layout produced a byte-identical PDF | `/exports` params built `"layout": "single" if body.layout=="single" else "tiled"` — a collapse, not a whitelist, so `snapshot` silently became `tiled` | whitelist `{snapshot,tiled,single}`, unknown → snapshot | ✅ bench: 3 layouts now give different page counts/bytes |
| Snapshot scaled the page but still printed 5 sheets (1 squeezed + 4 blank) | `_FIT_SCRIPT` applied a CSS `transform: scale()`, which is **purely visual** — the layout box stayed 2224px tall, so Chromium kept paginating | after scaling, collapse the flow: set `height`/`max-height` = `ceil(h*scale)` + `overflow:hidden` on root, its parent, body and html | ✅ 2 dashboard pages → **2 sheets** (was 10) |
| A shrink advisory marked the job `partial` | `finish_job` set `partial` whenever `warnings` was non-empty | warnings carry `severity`; only non-`info` entries degrade the status — `partial` must mean content is missing | ✅ snapshot now `succeeded` with 2 advisory notes preserved |
| Tables expanded to all rows even for a snapshot | `ExportModeContext` was one boolean driving BOTH "render lazy tiles" and "show every row" | split into `false / 'snapshot' / 'full'`; `useExportMode()` = any export, `useFullDataExportMode()` = expand rows. The worker passes `layout` in the print URL so a server render knows which it is | ✅ tsc + bench; snapshot never expands |

| Snapshot sheets came out with tiny charts inside full-width cards (DA: "chart bị thu bé tý lại còn viền chart vẫn rộng") | `page.pdf(scale=s)` RE-LAYS the page out at `width/s` before shrinking. Fluid tile cards grew to that layout; chart SVGs, whose pixel width recharts had baked in at the original viewport, did not. The earlier CSS-transform version had the identical flaw via its `width: 100/scale%` compensation | render at the print layout width: measure → compute scale → `set_viewport_size(width/s, height/s)` → let charts re-measure → `page.pdf(scale=s)`; re-check the height once and keep the smaller scale | ✅ PDF rasterised with PyMuPDF: line/donut/waterfall/treemap now fill their cards at scale 0.30 (layout 3526px) and 0.21 (5048px) |

**Watch out:** on the server engine `tiled` and `single` are currently indistinguishable — the print route renders its own layout regardless. Snapshot vs full-data now genuinely differ (fit + table expansion).

### N. Embed links (M2M `/integrations/embed/resolve`)

| Bug / gap | Root cause | Fix | Test |
|---|---|---|---|
| Embedded report titled `embed:71:a7fa6994` (2026-07-29) | the display title came from the managed link's INTERNAL name; nothing let the host app set one | `header` on resolve → stored on the GRANT (links are deduped by filter set, so a per-link title would let two host apps overwrite each other) → `_get_dashboard_by_token` returns `grant.header or link.name` | ✅ live: title shows on `/embed/<token>`, cold + cached metadata read; no header → falls back to the link name |
| `header` sanitiser DROPPED control chars → words glued (`"Doanh thu
	Q3"` → `"Doanh thuQ3"`) | filtered non-printables out instead of replacing them | replace with a space, then collapse | ✅ live: → `"Doanh thu Q3 2026"` |
| Any site could iframe an embed link (2026-07-30) | nginx sent `frame-ancestors *` on `/embed/`; the FE had an `EMBED_FRAME_ANCESTORS` floor but it was never declared in `.env.example`/compose, so it was dead config | per-PAT `embed_allowed_origins` (declare once on resolve, or by an operator via `/auth/personal-access-tokens/admin/<id>/embed-origins`) → snapshot onto the grant → `GET /public/embed/<token>/policy` → FE middleware emits `frame-ancestors` + refuses non-iframe opens; nginx's competing `frame-ancestors` removed (two CSP headers = the browser enforces the INTERSECTION, a confusing override to debug) | ✅ 10/10 matcher checks + live browser: allowed origin frames OK, foreign origin gets the refusal page INSIDE the frame, direct open = 403 page |

**Bypasses that must stay closed** (all covered by the matcher checks — a naive
`endswith`/`startswith` fails every one): `https://evil-base-datateam.com`
(dash-prefix), `https://base-datateam.com.evil.com` (suffix), `http://app.base.vn`
(scheme downgrade), `https://app.base.vn:8443` (port), `https://base-datateam.com`
(a wildcard must not match its own parent). Also locked: `"*"` is rejected and an
empty list on the resolve path is IGNORED — a config that renders to `[]` in
production must never silently disable the restriction.

**Design note worth keeping:** an allowlist check on the DATA endpoints is
impossible — requests the report makes from inside the iframe carry the report's
own origin, not the host page's. Only the browser knows who is framing us, so
`frame-ancestors` on the page is the enforcement and `Sec-Fetch-Dest`/`Referer`
are the second layer. Anti-scraping remains the ~1h rotating token + locked
filters + per-viewer mint.

### M. PDF export (public link / embed / builder)

Reported 2026-07-27 (DA: *"ấn vào toàn không ra file định dạng PDF chuẩn và trông thì cũng quá xấu"*). The exporter is
`frontend/src/lib/export-pdf.ts` driven by `ExportPdfDialog` + `ExportModeContext`; all three surfaces (build
`(main)/dashboards/[id]`, public `d/[token]`, embed `embed/[token]`) share it.

| Bug | Root cause | Fix | Test |
|---|---|---|---|
| **Multi-page export mixed page A's page-scope filters into page B (wrong numbers + scope leak)** | `getRoot` did `setCurrentPageId(B)` and fetched in the SAME tick; the fetch read `pageHiddenFiltersRef.current`, which the slicer-seed effect only updates on the NEXT render → still page A's set. Page-scope is a HARD bound ([[filter_page_scope_hard_bound]]), so this exported rows outside the page's scope. | Page filter resolution extracted to the pure `lib/public-page-filters.ts` (`resolvePublicPageFilterContext` + `mergeSeedWithViewerSelections`); the seed effect and the exporter both call it. `fetchChartsForPage` gained explicit `viewerFilters` / `hiddenFilters` overrides so export never reads live state. | ✅ Playwright live (d=67, temporary `pages_config[1].filters = order_status in [delivered]`): page-1 batch payload has NO `delivered`, page-2 batch HAS it |
| Export raced its own data (tiles captured blank) | the programmatic page switch re-fired the page-fetch effect + slicer seed → `chartRequestIdRef` bumped → the exporter's in-flight response was discarded, and `setAppliedViewerFilters` wiped `chartData` mid-capture | `exportInProgressRef` freezes the slicer-seed / page-fetch / highlight effects for the duration; export owns the fetch loop (snapshot semantics: the filters at click time apply to the whole file) | ⚠️ observed live (single batch per page, no duplicate `/charts/data`) |
| Captured on a fixed `setTimeout(700)` → spinners/half-drawn charts in the file | no readiness protocol on the public path; the build page had its own duplicate poll | shared `waitForRenderReady(root)`: fonts ready + no spinner/aria-busy + all `<img>` decoded + render signature (tile/svg/table sizes) stable across 2 polls, 25s cap; a timeout adds a warning instead of failing | ⚠️ live (5-page export, no blank tile) |
| A failed chart silently exported as an empty tile | one-shot fetch, no retry, no reporting | 3 attempts with backoff per page (`EXPORT_FETCH_ATTEMPTS`), then a **"Cảnh báo: báo cáo xuất thiếu dữ liệu"** section at the end of the PDF + a toast listing the charts | ❌ GAP (needs a fault-injected chart) |
| **43 near-empty pages, one KPI card per half-page** ("quá xấu") | every tile was drawn full-width at its own aspect ratio, capped at 42% of the page height → a tall KPI became a skinny box with 70% white space | `tiled` layout (default): tiles are grouped into the dashboard's own rows and each row is scaled to the page width, with `planPageFit` (whole dashboard page on one sheet when the shrink stays ≥55%) and squeeze-to-fill (≥65%); `single` stays available in the dialog | ✅ live: same report 43 → 13 sheets, rows match the on-screen layout |
| Table columns all equal width | `usableW / ncols` | `computeColumnWidths` measures header + up to 150 sampled rows and distributes the slack; zebra banding replaced the full cell grid | ✅ live (rendered pages) |
| Download named `Olist  Phn tch Ton din.pdf` | filename sanitiser stripped every non-ASCII char, i.e. all Vietnamese diacritics | `safePdfFilename` (lib/export-mode) removes only `\ / : * ? " < > \|` + control chars | ✅ live download name |
| Export opened a surprise tab at `blob:…uuid` (DA: "KH tự mở file tải xuống xem chứ không cần link kiểu này") | delivery showed the PDF in a pre-opened tab AND downloaded it; the blob URL looks like a broken link to a business reader | `NEXT_PUBLIC_PDF_PREVIEW_TAB` (`.env.example`, default false) gates `openPdfPreviewTab()`; `downloadPdf` no longer calls `window.open` on its own, and the pop-up-blocked toast is gated too. Mechanism kept (not deleted) — the open-inside-the-click dance is subtle to re-derive | ✅ live: Export → progress on the report → file downloads, zero new tabs, no toast |
| No provenance in the file | header only had title/page/filters | header now carries "Xuất lúc …" + "Dữ liệu tính đến …" (`dataAsOf` from the public snapshot info) | ✅ live (rendered pages) |

**Server-side engine (2026-07-27, P1).** `dashboard_export_jobs` + `app/services/pdf_export_service.py` + the `pdf-worker`
container (`backend/Dockerfile.pdf`, compose profile `pdf`) render the report with headless Chromium instead of the
viewer's browser. Things to keep locked when touching it:

| Property | Why it matters | How it is enforced |
|---|---|---|
| The worker prints the REAL report page (`/d/<token>?print=1&page=…`) | a second, server-side layout would drift from the screen and reintroduce "PDF numbers ≠ screen numbers" | `PublicDashboardView` print mode; there is no parallel print component |
| Readiness is the SAME protocol as the browser engine | two definitions of "ready" = two different classes of blank-tile bug | `frontend/src/lib/render-ready.ts`, imported by `export-pdf.ts` AND signalled via `window.__APPBI_PDF_READY__` |
| `forceVisible` tiles must report `onVisible` | the parent gates chart fetches on the reported-visible set; without it the print page renders every off-screen tile empty (found live during P1) | `ReadonlyChartTile` calls `onVisible()` in the forceVisible branch + `PublicDashboardView` treats `forceVisibleAll` as all-visible |
| No worker deployed ⇒ nothing changes for users | the engine is opt-in; the button must never dead-end | `/exports/capabilities` → `server_engine:false` → browser engine; a failed job also falls back |
| A dead worker must not strand a viewer | container restarts happen mid-render | heartbeat + `PDF_JOB_LEASE_SECONDS` re-claim, `attempts < PDF_JOB_MAX_ATTEMPTS` |
| Download needs more than a job id | job ids appear in logs/URLs | random `download_secret` per job + TTL (`PDF_FILE_TTL_HOURS`) |

Docs: `docs/pdf-export.md`. ❌ GAP: no automated test yet for the worker loop (needs the pdf profile in CI); verified live
(print route renders all 14 tiles of dash-67 page-2 with data, `__APPBI_PDF_READY__=true`).

**Known, NOT a PDF bug:** dashboard 67's slicer labels are stored double-encoded (`Năm` → `NÄƒm`) — the mojibake shows in the
web UI too and lands in the PDF's "Bộ lọc:" line from there. Data-side fix, tracked separately.


---

## 3. Coverage gaps — regression-risk map (prioritized)

These behaviors were fixed but have **no automated test** — a future change can silently reintroduce them. Ordered by risk.

**HIGH (silent wrong data / the area that triggered this catalog):**
1. **Date-slicer → dim-dropdown distinct cascade across role-played dims** — the exact area of yesterday's "empty LEVEL" report. Self-target is unit-tested; the *date/calendar slicer cascading into another dim's dropdown* is not. → add a golden/unit case: dim dropdown + active date filter (in-range → values; out-of-range → empty), on ds56.
2. **Distinct-values cascade type-coercion** (numeric/date value vs typed column) — fixed (e452e5c) but only live-verified; no committed test. → unit test on `_render_filter_condition`.
3. **BUG-018 redux non-dimension numeric column** — `_physical_source_type` fallback, no test. → engine unit test.
4. **Per-chart-type grain correctness** — gallery only asserts "renders", not "grain/number correct per type" (bubble label-grain, scatter raw, pivot agg).

**MEDIUM:**
5. count_distinct + filter measure (no golden case). 6. 3+-source cross-table measure. 7. Filter-pane visible/locked/hidden UI + viewer override + public-link locked (E2E fixme B1–B3/B5/C1/C3). 8. Calendar timezone filtering (also a known-open bug). 9. chart↔dashboard format-map parity. 10. cross-filter source/target + linkedFields expansion. 11. public page-filter scope across tabs; per-page slicer scope. 12. Pattern-op-on-date soft-drop; MySQL/BQ calendar dialect SQL.

**LOWER:** workboard import token-remap, multi-page form submit, legacy-screen heal, model auto-join PK, chart-order, cross-highlight direction — all real fixes with no regression test.

---

## 2.z — FE chart↔dropdown same-field parity (2026-07-02, commit 31b1cdb on demo)

- **Symptom:** dash64, a field with BOTH a filter-pane default and a slicer (Trung_tam=RC02 leftover + Trung_tam=PKD 4.1 slicer) → every OTHER cascading dropdown EMPTY; charts still showed data.
- **Root cause (FE dual-path):** chart-data context (`effectivePageScopeFilters`, page.tsx) resolved same-field (active slicer wins) + `applyScopeBound`; the distinct-cascade context used the RAW union `combinedFilters` → `getDistinctValueFilterContext` passed BOTH same-field filters → BE ANDs (`Trung_tam=RC02 AND Trung_tam=PKD4.1`) → impossible → empty. Charts resolved → PKD4.1 → data. Divergence.
- **Fix:** shared `resolveEffectiveFilterSet` (frontend/src/lib/filters.ts) used by BOTH the chart-data path AND the distinct-cascade context (raw `combinedFilters` kept only for column discovery). Dedupe same-field (slicer wins) → applyScopeBound (locked/page hard bounds) → authoritative last.
- **Locking test / gate:** guardrail invariant `distinct_context_same_field_resolved` (fires on removing `resolveEffectiveFilterSet` or reverting to `getDistinctValueFilterContext(combinedFilters`). Repro: `DA-Test/proof_chart_dropdown_parity.ts` (run `npx tsx` from frontend/, import `./src/lib/filters`) — 8/8 (slicer-wins, locked-bound-safe, empty-slicer-no-clobber). E2E: inject product_name filter=Charger + slicer=Laptop on ds71/dash31 → page sends product=Laptop once (not the AND-pair); employee cascade 15 not 0.
- **§3 GAP (open):** PUBLIC distinct hook `frontend/src/hooks/use-public-filter-distinct-values.ts` has the same unresolved-selections shape — same latent empty-cascade bug, but fix must match the BE `filter_layered_merge` precedence (best fixed at BE `get_distinct_field_values`). Reproduce on a public link with the conflict first.

## 4. Fix-discipline checklist (paste into every semantic/filter/chart PR)

- [ ] Reproduced on a real fixture (ds56 local PG / ds55 BQ / ds103 / ds111) BEFORE fixing — captured the wrong SQL+number.
- [ ] Ran the area's locking tests (§1) BEFORE the change → green baseline.
- [ ] Re-ran golden `--verify --tag snowflake` + `pytest tests/` + parity smoke AFTER → still green (or diff reviewed + golden re-captured with written rationale).
- [ ] Re-ran the 94-chart golden-SQL baseline (`scratchpad/golden_sql_harness.py`) → 0 diff, or explained.
- [ ] Added a NEW locking test for the exact scenario fixed (golden case or unit). If the area is a §3 GAP, the test is part of this fix.
- [ ] Checked sibling entry points (chart-data / dataset-execute / distinct-values / public-link / FE) — the same heuristic often lives in 3+ places (the recurring "fixed one, missed the others" trap).
- [ ] Verified on BOTH dialects where relevant (PG coerces leniently; BQ is strict — type bugs only bite BQ).
- [ ] Backend import smoke + container restart-health; `tsc --noEmit` for FE.

---

*Generated 2026-06-30 from: code bug-markers (BUG-005…018), ~80 git fix-commits, the golden/contract/e2e test inventory, and the project memory bank. Update this file whenever a new bug is fixed — add the row AND its locking test.*
