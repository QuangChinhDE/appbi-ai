# Relationship authoring ↔ join resolver — spec (the relationship contract)

Locked by `backend/tests/test_relationship_contract.py` (unit),
`backend/tests/test_relationship_contract_pg.py` (Postgres: values, key guard,
races) and the fixture `backend/tests/fixtures/relationship_legacy_v1.json`.
`backend/tests/mutation/relationship_pair_mutation.py` shows the same scenarios
fail on the pre-fix tree (22bac47f).

## One reader

`semantic_join_resolver.read_join_contract(base_view, join) -> JoinContract` is
the only reading of a persisted `SemanticExplore.joins` row. The resolver graph,
the grain (non-fanning) graph, semantic health, the field pickers, the live
filter adapter, the Data Model response and the legacy re-orientation helper all
use it (`join_is_usable` = valid and active).

A contract has: `view`, `alias`, `node` (alias or view), `from_view`,
`cardinality`, `is_active`, `cross_filter`, `key_pairs` ((from, to), …),
`key_source` (`columns` | `sql_on` | `expression`), `sql_on`, `invalid`
(reasons), `legacy` (notes). Identity = (from_view, node, set of key pairs).

## Legacy compatibility matrix

| Persisted form | Current meaning | Valid? | Runtime outcome | Action |
|---|---|---|---|---|
| `relationship` only (no `cardinality`) | cardinality = canonical(relationship) | SUPPORTED | edge with that cardinality | lazy |
| short aliases `N:1`, `1:N`, `1:1`, `N:M` | the spelled cardinality | SUPPORTED | as declared | lazy |
| `is_active` missing | active | SUPPORTED | used | lazy |
| `is_active` `"true"/"false"` (any case), `1/0` | that boolean | SUPPORTED | inactive rows are not edges | lazy |
| `cross_filter` missing | `single` | SUPPORTED | forward edge only | lazy |
| `cross_filter` any-case `single`/`both` | lower-cased | SUPPORTED | `both` adds the reverse edge | lazy |
| key only in `sql_on` (`${TABLE}.a = ${v}.b`, reversed, LookML `${base.a} = ${v.b}`) | key pairs parsed from the condition | SUPPORTED | edge on those pairs | lazy |
| expression key (calendar `CAST`, `${APPBI_LOCAL_DATE(...)}`) with column lists | pairs from the lists; SQL kept verbatim | SUPPORTED | forward and reverse keep the expression | lazy |
| scalar `from_column/to_column` + composite `sql_on` whose first pair they are | the composite key from `sql_on` | SUPPORTED | all pairs joined | lazy |
| no / unknown cardinality, or cardinality ≠ relationship | — | INVALID | excluded; every query on the model refused | fix in Data Model |
| `is_active` any other value (`"no"`, `"maybe"`, …) | — | INVALID | excluded; refused | fix |
| `cross_filter` any other value | — | INVALID | excluded; refused | fix |
| column lists disagree with `sql_on`; scalar not among the `sql_on` pairs; unequal list lengths | — | INVALID | excluded; refused | fix |
| expression condition without key columns | — | INVALID | excluded; refused | fix |
| `sql_on` naming a third table or comparing one side with itself | — | INVALID | excluded; refused | fix |
| `from_view` ≠ the explore's base view | — | INVALID | excluded; refused | fix |
| no `view`; no condition at all | — | INVALID | excluded; refused | fix |
| self-join through an alias (`${TABLE}.parent_id = ${orders}.id`, view = base) | `${view}` is the joined (alias) side, as the renderer always substituted it | SUPPORTED | edge base → alias | lazy |
| expression condition whose columns are not the declared key columns | — | INVALID | excluded; refused | fix |

No row is MIGRATED. At audit time all 336 persisted rows in the local database
read as SUPPORTED (0 invalid), so no migration or backfill is required; invalid
rows that appear later are loud (refusal + Data Model `contract_invalid` +
blocking health check `invalid_relationship`) rather than guessed.

## Runtime

- **Invalid rows** are collected in `resolver.invalid_joins`; the query engine
  and the live filter adapter call `raise_for_invalid_relationships` and refuse
  (ValueError → 400, Vietnamese, naming the rows and reasons).
- **Reverse edges** (cross filter `both`, or a bidirectional resolver) are built
  from the contract: equality keys as `${TABLE}.to = ${from}.from AND …` for
  every pair; expression keys by swapping placeholders so the expression stays.
- **Key guard (H8).** For every FROM-chain JOIN the engine records a probe of
  each ONE side of the walked cardinality — the to side of a many-to-one, the
  from side of a one-to-many (a chart based on the dimension summing the
  fact), both sides of a one-to-one — over the relation that side reads,
  grouped by exactly the expressions the rendered ON condition compares (a
  typed join's casts and calendar expressions included; predicates on that
  side alone kept in its WHERE): `SELECT 1 … GROUP BY <key exprs> HAVING
  COUNT(*) > 1 LIMIT 1`. A condition that is not a conjunction of cross-side
  equalities cannot be verified and refuses. No table is exempt by name. Every executor (chart runtime incl. live fallback and
  previous-generation, dataset query, measure preview, `/semantic/query`, live
  filter adapter) runs the probes on the same datasource and credential before
  the query. Duplicate → refused; probe error → refused ("unknown" is never
  "unique"); no duplicate → runs. Verdicts are cached shared for the live-query
  TTL, keyed by datasource + dialect + probe SQL. Creation-time profiling
  ("unknown" when the warehouse is down, a cost guard trips, or `force` is
  used) therefore never decides correctness at query time.

## Write paths

- **Dataset API `add_join`** (canvas, MCP): one transaction under the model
  write lock. `replaces` = the stored identity of the relationship being
  edited; an identity change removes the old row (and tombstones it when it was
  an auto FK / constraint join; re-keying an auto calendar join is refused). A
  same-identity edit updates only cardinality/active/cross filter/type and keeps
  the stored condition and provenance; an auto row becomes `user_edited`.
  `primary_key_on_to_view`: `None` = unchanged, `[]` = clear, list = set on the
  one side; refused with a 1:N drawing (the to view is the many side).
- **Dataset API `remove_join`**: needs the key columns; alias-aware (`alias`
  query param; several aliases without one → refused); not found → refused;
  removed auto FK / constraint joins are tombstoned.
- **Direct API `/semantic/explores`** (POST/PUT, whole list): every row must read
  VALID through the contract, no identity twice; provenance (`origin`,
  `managed`, `user_edited`, calendar fields) comes from the stored row of the
  same identity, and an auto row whose semantics changed becomes `user_edited`.
  Takes the model write lock. `expected_updated_at` (optional) → 409 when the
  explore changed since the client read it.
- **Every write path reads keys through the contract** (`_join_columns_from_definition`
  with the explore's base view): normalization, merge, identity matching for
  edit/delete/tombstones, suggestions — so a composite key behind a scalar
  shorthand stays composite and a LookML / reversed spelling is the same
  relationship as its canonical twin. Suggestions never default to
  many_to_one; applying them takes the lock and rolls back a failed item.
- **Distinct values / slicer cascade** refuse a model with an invalid
  relationship, like the engine and the live path. The live filter adapter
  uses the stored condition only (the guessed `from_col = from_col` rebuild is
  gone). The workboard access audit walks only valid, active relationships;
  a template import refuses bundle rows the contract refuses (recorded in the
  import report as `model_rebuild_error`).
- **Regeneration / drift**: user-edited and manual joins win the merge;
  tombstoned auto joins are not re-created; a join whose column vanished is
  kept (shown, fixable), not deleted; suggestions never overwrite a stored
  identity and are scoped to the dataset's own tables.
- **Model write lock** (`lock_dataset_model_for_write`): transaction-scoped
  advisory lock per dataset + `FOR UPDATE` re-read of the model, its views and
  explores (Postgres; SQLite has one writer).

## Non-goals

- Public-link policy (pre-existing, unchanged): a filter — a lock included —
  on a table with no relationship path to a chart is ignored with a skip
  badge (Power BI parity), so that chart is not scoped by the lock. Whether a
  public link should refuse such a tile instead is a product decision outside
  this pair. This change can newly put a lock in that state only through a
  legacy `is_active: "false"/0` row (read active before); 0 such rows locally.

- A stale whole-list PUT without `expected_updated_at` replaces the list as sent.
- Probes do not run for EXISTS semi-joins (filter-only joins cannot fan out).
