# Pair #2 — SemanticJoinResolver ↔ SemanticQueryEngine: the enforced contract

Branch `fix/semantic-pair2-resolver-query-engine`, started from `demo` @ `68a1f2a6`
(Pair #1 closure). The rules themselves live in
`docs/features/semantic-core-remediation/spec.md`; this file records what Pair #2
made true, where each rule is enforced and what locks it.

**One semantic request has one business interpretation.** The same relationship
graph + field roles + filters + grain + explicit role (alias) determines the fact
grain, every route, the calendar role, the strategy and the failure — before SQL
details can influence the answer — whatever the order of relationships,
explores, measures, dimensions or filters, the chart's base, the resolver's
traversal order or the process / cache state.

Locked by `backend/tests/test_pair2_golden_topology_pg.py` (topologies, oracles
and permutations in `backend/tests/pair2_topology.py`).

## Resolver consumers (production, default flags)

| Consumer | Root | Bidirectional | Route API | Can decide a number | Rule now |
|---|---|---|---|---|---|
| FROM builder `_build_from_clause` (SELECT / GROUP BY) | chart base | yes | `forward_routes` (every forward chain), else `distinct_routes` | yes | `_pick_route`: the meaning anchored closest to the target among the query's DETERMINED nodes; a competing meaning refused; re-checked on the final FROM chain; one relationship per joined node |
| filter EXISTS `_build_filter_exists_clause` (WHERE) | forward: base, then the fact; propagation: the fact grain (`_filter_root`) | yes (walk) | `forward_routes` + `_pick_route`; else `distinct_routes` | yes | forward meaning as the SELECT; else every valid propagation route (`edge_propagates`) AND-ed |
| strict drop gate in `_build_where_clause` | the fact grain | no | `resolve_paths` (emptiness) | yes (drop) | reachability over relationships that filter |
| isolated measure subquery `_build_isolated_measure_subquery` | the measure's view | yes | `reachable_nodes` (membership), EXISTS as above | yes | as the filter EXISTS, rooted at the measure |
| measure-level filter `_render_one_measure_filter` | the measure's view | yes | EXISTS as above | yes | EXISTS or refused (UNREACHABLE_VIEW); no inline fallback |
| re-anchor (single cross-fact) calendar | the measure's view | yes | `_best_calendar_dim_candidates` (the measure's own many-to-one reach) | yes | unique main calendar; own-role filter kept; tie refused |
| multi-fact stitch, per fact | the fact | yes | `_fact_own_calendar_view`, calendar as above | yes | unique own calendar or refused |
| fanned-Date collapse `_collapse_fanned_calendar_filters` | chart base | yes | `_best_calendar_dim_candidates` | yes | unique main calendar or refused (unchanged) |
| bare field qualification `_load_views` / `_parse_field_ref` | chart base | yes | `reachable_nodes` (load set) | no | two candidates → AmbiguousFieldError |
| grain guards `_validate_group_grain`, `_validate_dims_only_grain`, stitch relatedness | — | — | `_m1_reachable_views` (contracts, cardinality only) | yes (refuse) | non-fanning graph; UNRELATED_GRAIN / FANOUT_RISK |
| key probe `_record_key_probe` | — | — | `canonical_cardinality` | yes (refuse) | Pair #1 (unchanged) |
| live filter adapter `_adapt_live_sql_for_semantic_filters` | chart base | yes (walk) | `forward_routes` + `_pick_route`, else `distinct_routes` | yes | same rule as the filter EXISTS (one forward meaning or refused; else valid propagation routes AND-ed); an unroutable related filter is never handed to the base WHERE |
| distinct cascade (slicer options) `dataset_model_service` | the slicer's view | yes | `resolve_paths`, OR-ed | no — an option list | documented exception: a member with data through ANY route |
| binding hydration `reachable_fields_for_model` | base view | yes | reachability | no — field pickers | metadata only |
| propagation engine V2 (`filter_propagation`), chart_service `_prop_resolver` | base | no | `resolve_paths` | flag `FEATURE_PROPAGATION_ENGINE_V2` (OFF) | not on the default path |

`resolve_path` (first BFS route) remains only for path DEPTH (shortest length,
order-free) in `_best_calendar_dim_candidates` and as a fallback when
`distinct_routes` is empty (then both are empty). No numeric path takes its
route.

## Observable plan

`SemanticQueryEngine.query_plan` (per top-level query): `strategy`
(single / reanchor / isolate / stitch), `fact_grains`, `filter_root`,
`select_routes` (per FROM chain), `filter_routes` (per filtered view, the
AND-ed set), `calendar`. Every refusal is a `SemanticRefusal` with a
`category`.

## Bugs fixed (all SUCCESS + WRONG + SILENT on demo @ 68a1f2a6)

See the "(pair2)" rows of the regression catalog. In short: name-order route
choice in a diamond; propagation dropped when grouped by a shared dimension;
filters carried by single-direction relationships (engine and live path), incl.
filters leaking between facts of a multi-fact KPI and an authoritative filter
"applied" through them; tied calendar roles chosen by set order; own-role date
filters moved to the main calendar; Top-N / sort ties and NULL order; MySQL
stitch failure; measure-filter inline fallback; nested-CTE filter ignored; a
skipped live related filter rendered against the base (empty result on DuckDB).

## Execution evidence

Postgres and DuckDB in CI; MySQL 8.4 and BigQuery (datasource 52, inline data,
read-only) executed manually: every golden oracle passes on all four.
