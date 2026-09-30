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
- **A SELECT-side dimension needs exactly one shortest route.** Identical
  routes (the forward and reverse edge of one relationship) are one route. Two
  different routes → `AmbiguousJoinPathError`, naming both; the fix is to mark
  one relationship Inactive or use an alias.
- **A filter on a related view** correlates to the deepest view already in the
  query (the measure's own fact). A tie at that depth:
  - all tied routes are forward many-to-one chains (a diamond:
    sales → customers → regions vs sales → stores → regions) → **refused**:
    "customer's region" and "store's region" are different meanings;
  - the tied routes each cross a one-to-many hop, anchored at the base (a
    filter on another fact reaching this one through shared conformed dims)
    → **one EXISTS per route, AND-ed**: the other fact's filter restricts each
    shared dimension, and this fact is filtered by all of them.
- **Grouping** by a dimension needs a non-fanning (many-to-one) path from each
  measure's fact. A chasm (a dim of another fact through a shared dim) and a
  many-to-many hop are refused (symmetric aggregates are OFF by default).
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
  calendar — or several equally close roles — it is refused; roles are never
  AND-ed.
- A filter on one role (`ship_cal.year = 2025`) filters that role only.
- Weeks are ISO weeks starting **Monday** on every dialect (BigQuery
  `WEEK(MONDAY)`), matching the calendar's `week_start_date`. The
  `week_start_day` dataset setting is not applied anywhere (see Known gaps).
- With a non-UTC calendar timezone, time grains bucket an INSTANT (TIMESTAMP)
  column on its local date — the same `local_date_sql` rule the calendar join
  uses — so grouping by month grain and by the calendar's month agree.
- Context modifiers (`all`, `all_except`, `use_relationship`) are **not
  supported**: a measure carrying them is refused at query time, and new or
  changed modifiers are refused on save.

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
  key, table SQL) and tables (source, transformations, type overrides). Any
  edit changes the key on every worker at once.
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
primary key must be unique. A violation fails, is blocking, and makes Sync &
Publish refuse (the prior generation keeps serving). A check that cannot run is
`unknown` and never blocks. Snapshot-vs-live row mismatch is reported, not
blocking.

## Known gaps (not silently wrong — listed so nobody assumes otherwise)

- `week_start_day = sunday` in dataset settings is stored but applied nowhere;
  weeks are always ISO Monday (consistently).
- A filter whose EXISTS cannot be rendered (malformed relationship, nested CTE
  source) is dropped with a visible `no_join_path` badge on the tile — soft by
  product decision, never silent.
- Engine `warnings` are shown in Explore's Query tab only; everything that
  changes a number is either a refusal (tile error) or a dropped-filter badge.
