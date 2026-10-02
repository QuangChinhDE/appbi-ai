# Semantic core remediation — spec (the engine contract)

What a chart's number means, and when the engine refuses to produce one. The
rule behind every line: **a query either returns the number the model means, or
it fails with a message that says why** (a `ValueError` → HTTP 400 in
Vietnamese). Returning a plausible number that means something else is the one
outcome not allowed.

Locked by: `backend/tests/test_semantic_golden_matrix.py` (values, executed on
Postgres; the same matrix was executed on BigQuery), `test_semantic_state_contracts.py`,
`test_semantic_error_contracts.py`, `test_semantic_router_object_access.py`,
`test_semantic_health.py`, `test_distinct_cascade_semijoin.py`,
`test_golden_sql_non_regression.py`, and the golden replay
(`scripts/regression_filter_matrix.py`, `scripts/golden/cases.yaml`).

## Relationships and routes

- **Cardinality is declared, never assumed.** `many_to_one`, `one_to_one`,
  `one_to_many`, `many_to_many` (and their spelled aliases). An unknown or
  missing value is refused on write — it is not read as many-to-one.
- **A SELECT-side dimension needs one determined meaning.** A dimension of
  the base (reachable through many-to-one hops) has one meaning per FORWARD
  relationship chain — of ANY length: a direct `sales → regions` and
  `sales → customers → regions` are "the sale's region" and "the customer's
  region", never "the shortest one". A route's meaning is its relationships
  from the nearest view the query joins anyway (EVERY node of the query's
  determined routes: the base plus each target with one meaning, decided once
  and re-checked against the final FROM chain). The meaning anchored closest
  to the view wins — customer + region takes the customer's region, revenue by
  the calendar goes through the fact being summed. An equally close meaning
  through other relationships, or a second chain from the same anchor, is
  refused (`AmbiguousJoinPathError`, naming them; the fix is an Inactive
  relationship or an alias). Identical routes (the forward and reverse edge of
  one relationship, however the condition is spelled) are one route, and so are
  chains that compose to the same key equalities — a pass-through dimension
  over the same key (`sales → dim_product → products` on `product_id`
  throughout IS `sales → products`): no refusal because another physical path
  exists; the STRICTLY shortest one is used. Equally short equivalent chains
  through DIFFERENT intermediate views are refused: an intermediate without a
  row for a key (an orphan) gives that fact row no target row, so which one is
  joined would decide which rows reach the target (Pair #3). Two routes entering one view
  through different relationships are refused. The order of view names,
  relationships, explores or fields never decides.
- **The base never resolves a meaning.** Under a DIMENSION base the measure's
  fact is reached in reverse, and every route to it is a meaning of the
  question ("the region's sales" through `sales → regions` and through
  `sales → customers → regions` — refused, as "sales by region" is from the
  sales base); a view that is not a dimension of the base is reached by every
  route that first descends to a fact and then ascends to the view. When the
  base is a dimension of the measure's fact, that fact's own dimension chains
  are meanings too, in ONE set with the base's: a customers-based chart's
  "region" is the customer's AND the summed sale's own region — two meanings,
  refused (the same request from the sales base is). Changing the chart's base
  gives the same value or the same refusal; a shortest route never decides.
- **Route sets are complete or refused.** Every route set that chooses a
  MEANING (SELECT, a filter on a dimension, the calendar role) is enumerated
  completely, any length, up to 8 hops and 64 routes. Past that bound — more
  routes, or a route the rule allows that is longer — the query is refused
  (`RouteEnumerationIncomplete`, category `ROUTE_LIMIT`), never answered from
  the routes that happened to be seen first; a depth cut is never read as "no
  route". Filter propagation (below) is enumerated completely too — past its
  cap, refused. Shortest-path helpers otherwise remain only where no number
  depends on them (reachability, the slicer option list).
- **The chart's base view** defines the rows only when the chart groups BY it
  (every base member is listed; a member with no facts shows blank; a fact row
  with no member is not a member). Otherwise the number is base-invariant: a
  KPI, or a chart grouped by other dims, is computed at the measure's own fact
  grain (fact rows without a base member included).
- **A filter on a related view** means what the same view would show if it
  were grouped:
  - On a DIMENSION of a row the query has (forward chains): the SELECT rule
    above, from the base first, then from the measure's fact when it is
    joined under another base — grouped by customer, "region" is the
    customer's; "customer's region" vs "store's region" with no context →
    **refused** (role ambiguity).
  - On ANOTHER table reached through a 1:N hop (revenue → date ← deals and
    revenue → owner ← deals, filtered on deals): walked from the query's FACT
    grain (an isolated measure and a measure-level filter: the measure's own
    view), so it means the same thing whichever table the chart is based on →
    **one EXISTS per route, AND-ed**, whatever the chart groups by: the
    per-owner rows add up to the KPI. The routes are the most DIRECT ones —
    every shortest route from the fact grain; when every shortest route
    crosses a hop a filter may not travel, the shortest routes it MAY travel (a
    single-direction relationship never hides a valid route). A longer route
    relates the two tables through further relationships — another role of a
    dimension (an order's items vs "the customer's geo = a seller's geo"), or a
    relay through another fact's rows — and is not part of the filter. The set
    is enumerated completely; past its cap the query is refused, never AND-ed
    partially.
  - A route may carry the filter only if every hop does: toward a one side,
    and along a many-to-many as drawn, always; toward a many side only when
    that relationship's `cross_filter` is "both" (the resolver's
    bidirectional walk is never a filter path). A filter with no valid route
    is ignored with a `dropped_filters` diagnostic (refused when
    authoritative).
- **Grouping** by a dimension needs a non-fanning (many-to-one) path from each
  measure's fact. A chasm (a dim of another fact through a shared dim) and a
  many-to-many hop are refused (symmetric aggregates are OFF by default).
- **The live filter path** (charts not on the engine) follows the same route
  rule, and turns a filter through a 1:N hop into a DISTINCT-key semi-join —
  one per route, with every filter on that related view inside it.
- **The slicer's option list** (distinct cascade) is the exception by design:
  a member is offered when it has data through ANY route. It is an option
  list, never a number.
- **Aliased (role-playing) joins** are their own nodes: `ship_cal.year`
  groups and filters through the aliased relationship.

## Calendar and time

- The calendar is recognised from metadata (a generated-calendar table, a
  role-played `…__<column>__date_dim` view), not from SQL text.
- A "Date" filter fanned over several date roles of one fact binds to the
  **main** calendar (the fact's primary date relationship). With no main
  calendar — or several equally ranked roles — it is refused; roles are never
  AND-ed. "Main" is a UNIQUE best candidate, never the first of a set: a
  generated calendar before a role-played date dim, a date related to the
  measure's view directly before a date of one of its dimensions; two dates of
  dimensions tie whatever the length of their chains (a shorter chain is not a
  reason to be "the" Date).
- A filter on one role (`ship_cal.year = 2025`) filters that role only — also
  when the measure is re-anchored, isolated or stitched: a calendar filter on
  the measure's own date column keeps its column; only a filter written onto
  ANOTHER table's date column moves to the measure's main calendar, and is
  refused when the measure's date roles tie. A measure's calendar is one of
  ITS dimensions (many-to-one reachable): a calendar reached through another
  fact never counts.
- A calendar filter rendered on a TIMESTAMP (instant) column under a non-UTC
  calendar puts the instant on its LOCAL date first (`local_date_sql`) — the
  rule of the calendar join and of time grains — so filtering and grouping
  agree near midnight.
- A multi-fact chart grouped by the calendar groups each fact by its own main
  calendar; a fact whose date roles tie is refused.
- Weeks are ISO weeks starting **Monday** on every dialect (BigQuery
  `WEEK(MONDAY)`), matching the calendar's `week_start_date`. The
  `week_start_day` dataset setting is not applied anywhere (see Known gaps).
- With a non-UTC calendar timezone, time grains bucket an INSTANT (TIMESTAMP)
  column on its local date — the same `local_date_sql` rule the calendar join
  uses — so grouping by month grain and by the calendar's month agree.
- Context modifiers (`all`, `all_except`, `use_relationship`) are **not
  supported**: a measure carrying them is refused at query time, and new or
  changed modifiers are refused on save.

## Ordering and limits

Top-N and every sort put NULLs last on every dialect and break ties by the
group values (ascending), on the single-fact path and the multi-fact stitch
alike — a LIMIT never keeps an arbitrary member of a tie. Top-N's N takes
precedence over the chart's row limit.

## Refusals

Every planner refusal is a `SemanticRefusal` (a `ValueError`, HTTP 400, the
message unchanged) with a `category`: `AMBIGUOUS_ROUTE`, `ROUTE_LIMIT`,
`UNRELATED_GRAIN`, `FANOUT_RISK`, `UNSUPPORTED_CONTEXT`, `UNREACHABLE_VIEW`,
`INVALID_RELATIONSHIP`, `UNVERIFIABLE_KEY` — on every entry point
(`docs/features/semantic-foundation-freeze/kernel-contract-v1.md`). The engine's `query_plan` names the
strategy (single / reanchor / isolate / stitch), the fact grains, the filter
root, the SELECT routes and the filter routes before any SQL runs.

## Filter operators

Every builder renders or refuses — the semantic WHERE, the measure-filter
`CASE WHEN`, HAVING and the live WHERE raise a 400 (`ValueError`) for an
operator they cannot render; none drops it. Text operators match the value
LITERALLY on every path (`%` and `_` are characters, not wildcards), from one
helper (`app/services/sql_pattern.py`). `matches_regex` is an unanchored
regular expression per dialect (`REGEXP_CONTAINS` / `~` / `regexp_matches` /
`REGEXP`), never `SIMILAR TO`. A filter on an aggregate (a model measure) is
HAVING whether or not the chart shows that measure; it accepts
`=, ≠, >, ≥, <, ≤, between, in, not_in, is_null, is_not_null` and refuses the
rest.

## Numeric and formula meaning

`/` in any semantic expression is true division and a zero denominator is
NULL, on every engine; AVG has one precision; a formula's dependencies are
measures of its own view (another view's measure inside a formula is refused,
`UNSUPPORTED_CONTEXT`). The contract and its physical rendering per engine:
`docs/features/semantic-foundation-freeze/kernel-contract-v1.md`
(Numeric / Formula Meaning, Measure Meaning).

## NULL and missing-member contract

SQL three-valued logic, on every path (semantic WHERE, EXISTS through a
relationship, measure filters, HAVING, the live WHERE, the distinct cascade):

- A row whose value is NULL passes **no** comparison — negations included.
  `region ≠ 'North'`, `region NOT IN ('North')`, `NOT contains 'Nor'` all
  EXCLUDE rows where region is NULL. Use `is_null` to select them.
- A filter on a RELATED view keeps a base row only when the row HAS a related
  member that passes it. A row with no member (NULL foreign key, or a key with
  no match) passes no predicate on that view — negations and `is_null`
  included.
- An empty filter value (`''`, `[]`, `between` with both sides empty) is "no
  filter yet" and is not applied.

This is deliberately NOT PowerBI's "(Blank) passes a negation" rule: changing
it would move every saved negated filter's number. Locked by
`test_semantic_golden_matrix.py::test_star_null_contract_negations_exclude_missing_members`.

## Multi-fact (galaxy)

- Each fact is aggregated at its own grain and stitched on the shared
  dimensions; a calendar dimension is rebound onto each fact's own calendar
  **at the requested time grain**.
- Top-N and sort apply to the **stitched** rows, with the dimensions as a
  deterministic tie-break.
- A filter on a measure removes the whole stitched row (every fact's value),
  and never becomes a row filter on another fact. Filtering on a measure that
  is not in the chart is refused for multi-fact charts.
- A refusal inside one fact's sub-query surfaces with its own reason.

## State, caching and access

- A chart's cached result is keyed by the content of every definition its SQL
  is generated from: joins, the model's views (dimensions, measures, primary
  key, table SQL), tables (source, transformations, type overrides) and the
  dataset settings (calendar timezone). Any edit changes the key on every
  worker at once.
- Drift: a definition naming a column its table no longer has (measure/
  dimension SQL, `source_columns`, measure filters, primary key, join keys) is
  detected on both `columns_cache` shapes and reported
  (`dangling_model_references`). Resync takes a per-dataset lock and re-reads
  rows `FOR UPDATE`.
- Every `/semantic/*` object is authorised through its dataset
  (`require_view/edit/full_access`); lists only show readable datasets; a
  dataset-less legacy object needs `datasets: full`.

## Semantic health (gates Sync & Publish)

`GET /datasets/{id}/model/health` reports three separate layers — source
quality (the quality rules, by reference), semantic health, snapshot health.
Semantic checks are derived from the model and run on the transformed relation:
every many-to-one / one-to-one relationship's one-side key and every declared
primary key must be unique. A duplicate one-side key fails, is blocking, and
makes Sync & Publish refuse (the prior generation keeps serving); a declared PK
no relationship relies on is reported, never blocking, and not scanned at
publish. Each check runs under the datasource's own guard (BigQuery dry-run
cost limit, statement timeout) on the live relation the generation was just
built from; one that cannot run is `unknown` and never blocks. Snapshot-vs-live
row mismatch is reported, not blocking.

## Known gaps (not silently wrong — listed so nobody assumes otherwise)

- `week_start_day = sunday` in dataset settings is stored but applied nowhere;
  weeks are always ISO Monday (consistently).
- A filter whose EXISTS cannot be rendered (malformed relationship, nested CTE
  source) is dropped with a visible `no_join_path` badge on the tile — soft by
  product decision, never silent.
- Engine `warnings` are shown in Explore's Query tab only; everything that
  changes a number is either a refusal (tile error) or a dropped-filter badge.
