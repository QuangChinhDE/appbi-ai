# Semantic Kernel Contract v1

The observable contract of the semantic kernel — relationship authoring
(Pair #1), resolver + query engine (Pair #2), engine + ChartService (Pair #3) —
frozen by the Semantic Foundation Freeze Review. Everything built on top
(dashboards, public links, embed, export, AI — Pair #4+) consumes it; nothing
built on top may re-decide it.

**One rule: a request either returns the number the model means, or it is
refused with a category that says why, or (only where declared below) a filter
is left out and the response says so. Success + wrong + silent is never
allowed.**

Detail lives in the area specs; this page is the index of invariants and the
gate that enforces each one. If this page and a gate disagree, the gate is
right and this page is a bug.

| Area spec | Pair |
|---|---|
| `docs/features/relationship-authoring-pair/spec.md` (+ `closure.md`) | #1 |
| `docs/features/semantic-core-remediation/spec.md` | #1–#2 |
| `docs/features/semantic-pair2-resolver-engine/closure.md` | #2 |
| `docs/features/semantic-pair3-engine-chartservice/closure.md` | #3 |

## Relationship Truth

- One persisted relationship has one reading (`read_join_contract`) on every
  path: resolver graph, grain graph, health, pickers, live adapter, writes.
- Cardinality, activation and cross filter are declared, never guessed: an
  unknown or malformed value makes the relationship INVALID; a query that would
  use it is refused (`INVALID_RELATIONSHIP`); a dormant invalid row does not
  distort the topology.
- Aliases are distinct roles; a composite key is joined on all its pairs.
- Every one side a query trusts is verified (key probes) on the same datasource
  and credential right before the query; a duplicate is refused
  (`FANOUT_RISK`), an unverifiable key is refused (`UNVERIFIABLE_KEY`); live
  verdicts are never cached; a candidate snapshot is validated before it
  becomes visible.
- Relationship writes are serialised (model write lock) and a whole-list write
  needs the version it read; a stale writer cannot erase a committed edit.

Gates: `relationship_contract`, `relationship_contract_pg`, `pair1_baseline_parity`.

## Route Meaning

- Every forward relationship chain is a meaning; the closest-anchored meaning
  wins; an equally close second meaning is refused (`AMBIGUOUS_ROUTE`). The
  first, the shortest or the alphabetically first route never decides.
- Equivalent-key chains are one meaning only when STRICTLY shortest; equal
  chains through different intermediates are refused (orphan rows would decide).
- Route sets are complete within 8 hops / 64 routes or refused (`ROUTE_LIMIT`);
  incompleteness is never "no route".
- Changing the chart's base gives the same value or the same refusal.
- Storage order, field order, hash order and cache state never change a meaning.

Gates: `pair2_golden_topology`, `galaxy_golden`, `golden_sql`.

## Measure Meaning

- A declared measure aggregates by its declared type (`agg: auto` = the stored
  type; an explicit agg is the author's override). No chart config, what-if
  swap or preview default turns it into SUM.
- Each measure is evaluated at its own fact grain (isolation / re-anchor /
  stitch); a dimension with no many-to-one path from a measure's fact is
  refused (`UNRELATED_GRAIN`); an answer that would multiply rows is refused
  (`FANOUT_RISK`).
- A formula measure (`expression` + `depends_on`) is evaluated at its own
  view's grain, from any base. Its dependencies must be measures of that same
  view: a measure of ANOTHER view inside a formula is refused
  (`UNSUPPORTED_CONTEXT`) — inlined, it would aggregate over the formula view's
  joined rows (a dimension's rows repeated per fact row, another fact's rows
  multiplied), never the number the same measure has on its own. Asked as
  separate measures, each keeps its own grain. A formula is never
  re-aggregated: an explicit agg other than its type, or a pivot cell, is
  refused (`UNSUPPORTED_CONTEXT`).
- A dataset-scope measure (`source_columns`) aggregates at its grain — the
  single foreign view it reads, or its declared view. A column of another view
  is allowed only when that view is many-to-one reachable from the grain (one
  row per grain row: `amount * products.price`); a one-to-many child joined in
  would multiply every measure of the statement and is refused
  (`FANOUT_RISK`). A cross-table measure IS its fact's measure: the same value,
  or the same refusal (`UNRELATED_GRAIN` by an unrelated dimension), as the
  plain measure on that fact.
- Context modifiers are refused (`UNSUPPORTED_CONTEXT`).

Gates: `pair3_chartservice`, `measure_render`, `semantic_foundation`.

## Numeric / Formula Meaning

- `/` in any semantic expression — a measure's `sql` / `expression`, a formula
  over measures (nested formulas included), a dimension's SQL, a measure's
  `where_sql`, a chart calculated field — is **true division**, and a **zero
  denominator is NULL**, on PostgreSQL, MySQL, BigQuery and DuckDB alike
  (`app/services/semantic_arithmetic.py`). `5 / 2` is 2.5 everywhere; `x / 0`
  is never an error, an infinity or a number.
- `% of total` divides the same way (NULL when the total is 0).
- AVG has one precision on every engine (MySQL averages a DOUBLE).
- Physically: Postgres promotes (`* 1.0`) and guards (`NULLIF(…, 0)`); MySQL
  promotes to DOUBLE (`* 1e0`) and needs no guard (`x / 0` is NULL in a
  SELECT; MySQL 8 evaluates a window inside `NULLIF` twice in an ungrouped
  query); BigQuery and DuckDB only guard. Author-written DuckDB `//` (explicit
  integer division) is kept.
- Values agree to at least 6 decimal places across engines; display rounding is
  presentation, never semantics.
- SQL the author writes inside custom-SQL charts and dataset transformations is
  the author's physical SQL in the source dialect — not a semantic expression.

Gate: `semantic_foundation` (Postgres + DuckDB executed; MySQL and BigQuery by
the manual matrices recorded in the closure).

## Filter Meaning

- A chart's saved filters are a hard constraint AND-ed with the runtime
  overlay; only byte-identical predicates dedupe; a bare column name never
  merges two views.
- A filter on a related view filters through the routes the relationship
  allows (`cross_filter`); every route is applied (AND), never a subset.
- Every complete filter is in exactly one state, the same on every entry point:

| State | When | Observable |
|---|---|---|
| applied | a route renders it | the number |
| soft-dropped | `unreachable_view` (a plain view of the model the base cannot reach; a view an isolated measure's fact cannot reach — that measure only), `no_join_path`, the single-direction gate | `dropped_filters` on `/charts/*` (`_debug`, cache hits included), `/datasets/…/execute` and `/semantic/query` |
| refused | unknown field, dataset mismatch, unsupported operator (a text operator on a date / number column included), `binding_unsupported`, an aliased / calendar view no rule places | HTTP 400 + category |
| fail-closed | an authoritative constraint in any non-applied state | `AUTHORITATIVE_NOT_APPLIED` — never widens data |

Gates: `pair3_chartservice`, `public_authoritative_bounds`, `semantic_foundation`.

## NULL Meaning

SQL three-valued logic on every path and every engine: a NULL passes no
comparison, negations included; a fact row with no related member passes no
predicate on that view — `is_null` included; an empty filter value is "no
filter yet". Deliberately not PowerBI's "(Blank) passes a negation".

Gates: `galaxy_golden` (`test_star_null_contract_negations_exclude_missing_members`),
`pair1_baseline_parity`, `semantic_foundation` (every entry point).

## Ambiguity and Route Completeness

The same request gives the same meaning or the same refusal category through
every entry point — chart (saved / preview / batch), `/semantic/query`,
dataset execute, measure preview / dry-run. An entry point never answers a
request another refuses.

Several predicates on one field are AND-ed on every entry point
(`/semantic/query` accepts one plain predicate per field by its request
contract — a 422 otherwise, never a silent subset).

Gate: `semantic_foundation`.

## Execution Mode

- The planner alone decides live / snapshot / published / blocked. A published
  generation N is read as N or refused — never live, never another generation.
  A legacy dataset whose snapshot vanished falls back live, recompiled for and
  executed on the SOURCE engine. A mixed-engine dataset never runs live.
- **One live statement reads one connection.** Every table a live statement
  reads must be readable through the executing connection as the same physical
  table: a table of another datasource on a different engine, or on the same
  engine but another database / schema / user (or an in-memory Sheets / manual
  engine), is refused (`UNSUPPORTED_CONTEXT`) on every executor — chart, live
  fallback, live filter adapter, dataset execute, `/semantic/query`, measure
  preview / dry-run — before any key probe runs, never read as the executing
  connection's same-named object. The same physical scope spelled differently
  (default port / schema, `localhost`) is one connection. BigQuery names a
  PHYSICAL table absolutely; another BigQuery connection's physical table (or
  any table of the same project) may be read, its custom-SQL / calculated
  tables (named relative to the job's project) may not.
- Design-time APIs (`/semantic/query`, dataset execute, measure preview and
  dry-run) evaluate the CURRENT model against LIVE source data by contract;
  dashboards read the planned (snapshot / published) state.

Gates: `pair3_chartservice`, `semantic_foundation`.

## Binding Truth

The binding is derived from the current model on every read (saved, preview,
legacy `config.source`, empty / minimal / stale stored bindings, what-if
swaps); a stored fragment never overrides the model because it is older. An
explicit `model_id` / explore pins the request to that model, re-resolved from
current state.

Gate: `pair3_chartservice`.

## Cache Identity

A cached result is keyed by every input that can change the answer: join and
definition signatures (views, measures, formulas, tables, transformations,
types, dataset settings incl. calendar timezone), fields, aggregations,
filters, sorts, limits, grains, snapshot generation / as-of, execution host,
security scope — and `SEMANTIC_RESULT_CACHE_VERSION`, bumped whenever the same
request starts to mean something else (current: `foundation-freeze-2026-10`),
so no pre-deploy result is served from the shared store; a fanned Date filter
and look-alike role filters never share a slot. A cached result carries the
engine's own dropped filters, so a hit reports them as the first computation
did. Fallback results are never cached. Cache state is an optimisation, never
semantic state.

Gate: `pair3_chartservice` (cache mutation tests).

## Refusal Semantics

Every planner refusal is a `SemanticRefusal` with a category — `AMBIGUOUS_ROUTE`,
`ROUTE_LIMIT`, `UNRELATED_GRAIN`, `FANOUT_RISK`, `UNSUPPORTED_CONTEXT`,
`UNREACHABLE_VIEW`, `INVALID_RELATIONSHIP`, `UNVERIFIABLE_KEY` — plus
`AUTHORITATIVE_NOT_APPLIED`. The localized message is for people; the category
is the identity, carried as `X-AppBI-Refusal` on `/charts/{id}/data`,
`/charts/preview-data`, `/semantic/query` and `/datasets/…/execute`, as
`category` on each batch item and on measure preview / dry-run. A refusal is
never retried through a weaker path, and never surfaces as a warehouse error or
a 500.

Gates: `pair3_chartservice`, `semantic_foundation`.

## Authoritative Constraints

A server-side constraint (public link lock, hidden filter, row scope) is either
applied by every route, or the request is refused (`AUTHORITATIVE_NOT_APPLIED`).
It is never soft-dropped, never relaxed for convenience, never widens data.

Gates: `public_authoritative_bounds`, `relationship_contract_pg`.
