# Pair #2 — SemanticJoinResolver ↔ SemanticQueryEngine: the enforced contract

Branch `fix/semantic-pair2-resolver-query-engine` (demo `05235a80`) and the final
closure `fix/semantic-pair2-final-closure`. The rules themselves live in
`docs/features/semantic-core-remediation/spec.md`; this file records what Pair #2
made true, where each rule is enforced and what locks it.

**One semantic request has one business interpretation.** The same relationship
graph + field roles + filters + grain + explicit role (alias) determines the fact
grain, every route, the calendar role, the strategy and the failure — before SQL
details can influence the answer — whatever the order of relationships,
explores, measures, dimensions or filters, the chart's base, the resolver's
traversal order, a route-enumeration bound, or the process / cache state. When
the planner cannot see the complete relevant set within its bounds, it refuses.

Locked by `backend/tests/test_pair2_golden_topology_pg.py` (topologies, oracles
and permutations in `backend/tests/pair2_topology.py`) and, for the live filter
adapter, the `g16_*` tests of `backend/tests/test_semantic_state_contracts.py`.

## Route API contract (observable)

| Concept | Returns | May decide a number | Ambiguity | Past the bound |
|---|---|---|---|---|
| forward routes (`forward_routes`) | EVERY chain of to-one hops from a root to a view, any length ≤ 8 | yes — each chain is a candidate meaning ("the sale's region" vs "the customer's region") | `_pick_route`: chains are one meaning when they compose to the same key equalities (`route_meaning_segments`: `sales → dim_product → products` on `product_id` throughout IS `sales → products`); otherwise the meaning anchored closest to the query's views wins and an equally close one, or a second meaning from the same anchor, refuses | `None` → refused (ROUTE_LIMIT) |
| descend-then-ascend routes (`descend_ascend_routes`) | EVERY route that walks toward many sides (a fact under a dimension base, in reverse) then only toward one sides | yes — the meanings of a SELECT view that is not a dimension of the base ("the region's sales" through two chains) | as above | `None` → refused |
| fact-rooted forward chains (FROM builder, filter EXISTS) | the measure fact's own forward chains, through EVERY route of the fact from the base, when the base is a dimension of that fact | yes — ONE candidate set with the base's own chains (a customers-based chart's "region": the customer's, and the summed sale's own) | as above | refused |
| any route (`any_routes`) | every simple route, any hops — only when neither kind above exists | yes, through `_pick_route` | as above | refused |
| filter propagation (`distinct_routes` from the fact grain + `edge_propagates`; else `shortest_propagation_routes`) | the most DIRECT routes a filter on another table travels to the fact: every shortest route, correlated at the deepest view the query has; when every shortest route crosses a hop a filter may not travel, the shortest routes it MAY travel | yes — ALL of them are AND-ed (one EXISTS each) | none — every such route restricts | refused (`distinct_routes` / `shortest_propagation_routes` past the cap) — never AND of a partial set |
| shortest structural path (`resolve_path`, `resolve_paths`) | the shortest route(s) | NO: reachability (strict drop gate), anchor offsets, option lists of the distinct cascade, flag-off V2 propagation | — | option lists only (`resolve_paths`) |

* **Why propagation is "most direct", not "every walk"** (measured on the local
  models): a longer valid route relates the two tables through further
  relationships — another role of a dimension (Olist: "orders → customer → geo ←
  seller ← items" next to "orders ← items"), or a relay through another fact's
  rows (SDR: "owners with a meeting on a date with a matching activity" next to
  "owners ← activities"). AND-ing them changed 371 local (base, view) pairs to a
  narrower, wrong-by-intent filter; a shape rule excluded legitimate unique flows.
  The direct routes are the filter's meaning; past the cap the query is refused.
* "No route" means the model relates no route of that kind within the bound and
  the bound was not hit: the target is unreachable that way (refused for a
  SELECT view; an ordinary filter is left out with a `dropped_filters` diagnostic
  — PowerBI parity — an authoritative one refused).
* "Cannot prove completeness" — more than `ROUTE_CAP` (64) routes, or a route the
  rule allows that is longer than `ROUTE_MAX_DEPTH` (8) hops; for filter
  propagation more than 32 shortest routes — is `RouteEnumerationIncomplete`
  (`SemanticRefusal`, category `ROUTE_LIMIT`). It is never converted into "no
  route", the first route or the shortest route. Filter propagation has no depth
  cut (its routes are found breadth-first).
* Reverse traversal is semantic: a fact under a dimension base has one meaning
  per route, like a dimension under a fact base. Changing the chart's base never
  turns an ambiguity into a number (G12 / G13).
* The closest-anchor rule (frozen since Pair #2: grouped by customer, "region"
  is the customer's — `G3.by_customer_filter_region`) holds identically from the
  fact base and from a dimension base: base invariance, not "shortest wins".

## Resolver consumers (production, default flags)

| Consumer | Decision | Route API / rule | Ambiguity | Past the bound | Regression |
|---|---|---|---|---|---|
| FROM builder `_build_from_clause` (SELECT / GROUP BY) | which relationships join each SELECT view | forward ∪ fact-rooted forward; else descend-ascend; else any — `_pick_route` against every node of the determined routes, re-checked on the final FROM chain; one relationship per joined node | refused (AMBIGUOUS_ROUTE) | refused (ROUTE_LIMIT) | G2d, G3, G3c, G12, G13, G14.lattice*, G15.*select |
| filter EXISTS `_build_filter_exists_clause` (WHERE) | how a related filter restricts the fact | forward (base ∪ fact grain; a measure-level filter: the measure's view only) + `_pick_route`; else the most direct valid propagation routes AND-ed | forward: refused; propagation: all apply | refused | G2d, G5, G6, G9, G12, G13, G14.prop*, G15.deep_prop* |
| strict drop gate in `_build_where_clause` | whether a filter-only view is related at all | `resolve_paths` emptiness (exact reachability) | — | — | G4/G5 single, G9 single |
| isolated measure subquery `_build_isolated_measure_subquery` | the measure's own filters | `reachable_nodes` (membership), EXISTS as above rooted at the measure | as EXISTS | as EXISTS | G6, G7 isolated |
| measure-level filter `_render_one_measure_filter` | a CALCULATE-style filter | EXISTS rooted at the measure's view only (never the chart's base) | refused | refused | G1.measure_filter_*, G16m |
| calendar candidates `_best_calendar_dim_candidates` (re-anchor, isolate, stitch, fanned-date collapse) | which date role is "the" Date | the measure's own many-to-one reach; main before role-played; the measure's own date relationship before a dimension's; two dimension dates tie whatever their depth | refused | refused (`forward_routes` per candidate) | G7, G7c |
| multi-fact stitch, per fact | the fact's own calendar | `_fact_own_calendar_view` | refused | refused | G6, G7 stitch |
| bare field qualification `_load_views` / `_parse_field_ref` | which view a bare name means | `reachable_nodes` | AmbiguousFieldError | — | (pre-Pair-2) |
| grain guards `_validate_group_grain`, `_validate_dims_only_grain`, stitch relatedness | may this measure be grouped by this view | `_m1_reachable_views` (cardinality only) | — | — | GRAIN_MATRIX |
| key probe `_record_key_probe` | is a trusted one-side key unique | `canonical_cardinality` | — | — | Pair #1 |
| live filter adapter `_adapt_live_sql_for_semantic_filters` | how a related filter restricts a live chart | forward + `_pick_route`; else the engine's propagation rule | refused | refused | `g16_*`, live_world tests |
| distinct cascade (slicer options) `dataset_model_service` | the options a dropdown offers | `resolve_paths`, OR-ed | documented exception: a member with data through ANY route | option list only | distinct gates |
| binding hydration `reachable_fields_for_model` | field pickers | reachability | — | metadata only | — |
| propagation engine V2 (`filter_propagation`), chart_service `_prop_resolver` | — | `resolve_paths` | flag `FEATURE_PROPAGATION_ENGINE_V2` (OFF) | not on the default path | — |

## Live filter adapter: applied, recorded, or refused

A filter on a RELATED view on the live path (Sheets / manual tables, derived and
runtime tables) is applied exactly; or it is left out AND recorded in the
caller's `_debug.dropped_filters` — `unreachable_view` when the model relates no
filter path to the chart's table (PowerBI parity, as the engine's drop gate),
`no_join_path` when a route exists but its base relation, a joined relation or a
join condition cannot be rendered (the engine's rule for the same case: the skip
badge); or — a field the related view does not have or cannot render — the
request is refused. It is never left out silently, and an authoritative one is
never left out. The physical-table live path (a chart with no semantic model)
refuses a related dashboard filter before the adapter (`binding_unsupported` is
a hard drop); a chart with a model always runs on the engine.

## Observable plan

`SemanticQueryEngine.query_plan` (per top-level query): `strategy`
(single / reanchor / isolate / stitch), `fact_grains`, `filter_root`,
`select_routes` (per FROM chain), `filter_routes` (per filtered view, the
AND-ed set), `calendar`. Every refusal is a `SemanticRefusal` with a `category`.

## Bugs fixed (all SUCCESS + WRONG + SILENT on demo, unless noted)

See the "(pair2)" / "(pair2-final)" rows of the regression catalog. Pair #2 (@
`68a1f2a6`): name-order route choice in a diamond; propagation dropped when
grouped by a shared dimension; filters carried by single-direction relationships
(engine and live path), incl. filters leaking between facts of a multi-fact KPI
and an authoritative filter "applied" through them; tied calendar roles chosen
by set order; own-role date filters moved to the main calendar; Top-N / sort
ties and NULL order; MySQL stitch failure; measure-filter inline fallback;
nested-CTE filter ignored; a skipped live related filter rendered against the
base (empty result on DuckDB). Final closure (@ `05235a80`): a dimension base
took the shortest reverse route (a regions- / customers-based chart answered what
the sales base refuses); a customers-based chart ignored the summed sale's own
dimension chains; 65 propagation routes silently cut to 32; a second meaning past
the depth bound was "no route"; a calendar role decided by the shorter chain; a
shorter single-direction route hid a valid filter route (the filter was dropped —
diagnosed, but a wrong unfiltered number); the live adapter silently skipped a
related filter it could not render; equivalent key chains (a pass-through
dimension over the same key) were refused as two meanings (over-refusal).

## Execution evidence

Postgres and DuckDB in CI; MySQL 8.4 and BigQuery (datasource 52, inline data,
read-only) executed manually: every golden oracle passes on all four.
