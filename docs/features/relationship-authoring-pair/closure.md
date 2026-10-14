# Pair #1 closure — the enforced contracts

Companion to `spec.md`. What the closure round (branch
`fix/relationship-pair1-final-closure`) made true, and where each rule lives.

## Key guard cache (P1-01)

`relationship_key_guard.verify_key_probes` caches a verdict ONLY for an
immutable relation — a materialized snapshot table (one physical table per
build, `snap_t<id>_…_v<epoch-ms>`; the watermark reuse shares a table only when
the source is unchanged). The probe SQL names that physical table, so
generation B never reuses generation A's verdict. A LIVE relation is never
cached, in either direction: every query re-probes immediately before it runs.

Read consistency: the probe is its own statement, run before the query. A
writer that duplicates a one-side key BETWEEN the probe and the query is not
seen by the probe, and the JOIN would fan out. So for every live relation the
same key check is also placed IN the statement that performs the JOIN
(`relationship_key_guard.statement_key_guard`, added to that statement's WHERE
by the engine and by the live filter adapter):

    (SELECT _appbi_dup FROM (<probe>) AS _appbi_kpg0 UNION ALL SELECT 1) = 1

One statement reads one snapshot, so the check sees exactly the rows the JOIN
sees. The predicate is TRUE on a unique key and RAISES on a duplicate (a scalar
subquery returning two rows): PostgreSQL "more than one row returned by a
subquery used as an expression", MySQL "Subquery returns more than 1 row",
BigQuery "Scalar subquery produced more than one element" (verified on
BigQuery, datasource 52, public data), DuckDB 1.2 (Sheets / manual tables)
"More than one row returned by a subquery". It never filters — there is no
value for which it is FALSE. Snapshot relations (immutable) carry no
in-statement half. The pre-query probe stays: it gives the readable refusal for
a persistent duplicate; the in-statement half catches the race (the request
fails with the database's message).

## Authoritative constraints fail closed (P1-02)

Server-owned constraints — a public link's 🔒 lock and 🚫 hidden constraint, a
🔒/🚫 dashboard filter, a page scope (`pages_config[p].filters`), a link
'limit' allow-list, an embed claim (a managed link lock), a workboard role scope
(a managed link lock) — carry `chart_contracts.AUTHORITATIVE_KEY` from the
public merge (`filter_layered_merge.mark_authoritative`) into every query path.
Such a constraint is applied, or:

| Surface | Outcome when it cannot be applied |
|---|---|
| public chart / batch tile | 400 with a fixed message naming no field and no value |
| public distinct values | empty list (the own-field rule's contract, now for every authoritative constraint) |
| public AI / report tools | that chart's data is never used: the tool returns an error for it or the scan skips it |
| embed / workboard / PDF | the same public endpoints → the same outcomes |
| malformed 🔒/🚫 dashboard or page filter | 409 on every public path (as malformed link locks already were) |

"Cannot be applied" = any drop site: the central `_record_dropped_filter`
(empty value, dataset mismatch, binding unsupported, unreachable view), every
engine drop (unreachable view, no join path, propagation drop, no primary key,
unsupported operator, isolated-measure unrelated filter, value-less operator
branches), the live filter adapter (unreachable, path failed, view/field
missing, not renderable, not in the relation), the live WHERE builder, and the
distinct cascade (incl. a stored `"56"` dataset id and the bare-column
fallback, which no longer re-targets an authoritative constraint). The merge no
longer weakens them: two constraints on one field AND (last-wins dropped one),
a kill-marker never removes a lock, two link scopes AND (an empty intersection
fell back to the second), calendar rewrites accumulate (a second date filter
landing on the same calendar key overwrote the first).

Calendar fans: chart_service stamps the copies of ONE fanned "Date" filter with
one `_calendar_fan` id; only copies sharing an id collapse onto the main
calendar. An authoritative filter without a fan id is a ROLE lock (🔒 ship-date
year): it is never merged with a viewer's same-valued pick on another date and
never re-pointed at the measure's main calendar — it is rendered on its own
column with its calendar expression, or refused when its calendar field has no
expression (`week_start_date`, `month_end_date`, `date_key`). An unrenderable
authoritative field refuses with the fixed message (the old error named the
field — a 🚫 field must not be disclosed).

Distinct values: the dropdown's self-strip keeps every hard bound on its field,
including one that reaches it as a `linkedFields` member (re-aimed at the
dropdown's field). A viewer can neither claim nor shed a server marker: every
`_`-prefixed key is stripped from viewer filters. The per-measure executor
(FEATURE_PER_MEASURE_ISOLATION) re-raises a refusal instead of returning an
empty group. Engine predicates are de-duplicated per identity (operator,
value, calendar keys, fan id) and the authority marker is OR-ed onto the stored
entry (`chart_service._add_engine_predicate`), so a 🔒 copy identical to a viewer
pick stored first is never left unmarked.

An ORDINARY viewer/report filter keeps its documented Power BI behaviour: a
filter on a table with no relationship path to the chart is ignored with a
diagnostic (`unreachable_view`).

Result-cache identity carries which filters are authoritative, so a result
computed for an ordinary request (soft drop) is never served for an
authoritative one.

## One relationship write contract (P1-03)

| Writer | Lock | Reads under the lock | Contract validation | Provenance | Stale whole list |
|---|---|---|---|---|---|
| `add_join` (POST /model/joins, canvas, MCP, seeds) | yes | yes | strict + final row valid | kept on same identity | n/a (single row; `replaces` must match) |
| `remove_join` (DELETE /model/joins) | yes | yes | identity + alias | tombstones auto rows | n/a |
| `apply_join_suggestions` (POST /model/joins/batch) | yes | yes; each item re-checked under `add_join`'s lock (`create_only`) | via `add_join`; no many_to_one default | never overwrites a stored identity | n/a |
| `add/clear_rejected_suggestions` | yes | yes | n/a | n/a | n/a |
| `_sync_dataset_model_structure` (generate / drift resync) | yes | yes | keys via the contract | manual + user_edited win; tombstones | server-built |
| `replace_explore_joins` ← PUT /semantic/explores/{id} and PUT /datasets/{id}/model/explores/{id} | yes | yes | every row via the contract; no identity twice | stored provenance for unchanged identities; new rows are `manual`; omitted `is_active`/`cross_filter` keep the stored value | `expected_joins_version` REQUIRED (428 without, 409 stale) |
| POST /semantic/explores | yes | yes | via the contract | new rows `manual` | a second explore for the same base view → 409 |
| PUT /semantic/explores/{id} moving the base (`base_view_id`) | yes | yes | the stored list re-validated against the NEW base, even when no joins are sent | as above | version REQUIRED; moving onto a base another explore owns → 409 |
| PUT /semantic/explores/{id} with `"joins": null` | n/a | n/a | refused (400) — send `[]` to remove every relationship | n/a | never written past the precondition |
| `_cleanup_semantic_view_for_table` (table delete) | yes | yes | removes rows on the deleted view | n/a | n/a |
| workboard template import | new dataset | n/a | rows the contract refuses fail the faithful rebuild (recorded `model_rebuild_error`) | bundle | n/a |

`SemanticExplore.joins_version` (content hash of the stored list) is served on
GET /semantic/explores/* and on GET /datasets/{id}/model.

## Dormant invalid relationships (P1-04)

`JoinContract.dormant` = invalid AND definitively inactive (`false`, `"false"`,
`0`). Dormant rows are outside every graph and do NOT refuse the model's
queries; health reports them as `invalid_relationship_inactive` (warning,
non-blocking — they cannot change a number). An invalid row whose activation is
unknown (`is_active: "perhaps"`) is treated as possibly active: it refuses. No
writer stores or activates an invalid row; the Data Model shows it as invalid
and offers only Delete.

## Publish validates the candidate (P1-05)

`publish_blockers(db, dataset_id, generation=N)` checks every relationship
one-side key on generation N's snapshot tables, on their host, before N is
pinned; a failure keeps the previous `published_generation`. Health results say
what they checked: `evidence.checked` ∈ `live_source`, `candidate_generation`,
`published_generation`, with `evidence.generation`. GET /model/health shows the
live-source checks (semantic layer) and the published generation's key checks
(snapshot layer). A table the generation holds no snapshot of is `unknown`
(`relation: null`, non-blocking) — never the live source's verdict reported as
the generation's; a live relation is re-probed by every query at runtime.

Legacy datasets (no publish lifecycle) serve the newest complete generation
without a publish gate; their queries are still guarded at runtime (the probe
runs on the snapshot table the query reads).

## Caches (P1-09)

| Cache | Identity now includes |
|---|---|
| every result cache (`query_cache._make_key`) | `SEMANTIC_RESULT_CACHE_VERSION` — bump it with any change to what a query means; a deploy then never serves a result cached by older code (shared store included) |
| semantic chart result | relationship JSON signature (no caching when it cannot be computed), definitions incl. `columns_cache`, `calendarField`/`calendarSourceField` per filter, which filters are authoritative, snapshot generation + host |
| distinct values | hash of the executed cascade SQL (relationships, routes, rendered filters) |
| join graph (`_GRAPH_CACHE`) | relationship JSON per explore (unchanged) |
| key probes | only immutable relations; probe SQL names the physical table; a live relation is re-checked inside the query statement itself |
| engine per-query memos | calendar/snapshot memos reset per top-level query |
| AI insight pack / recon (`summary_cache`) | `semantic_epoch`: the contract version + every explore/view/model/dataset/dataset-table row's `(id, updated_at)` (a transformation edit or a new publish changes it) — any edit or delete changes it (not `max(updated_at)`: PostgreSQL `now()` is the transaction start, so a writer that waited on the model lock commits an older stamp) |

## Execution surfaces (P1-10)

Every surface that executes SQL with a trusted to-one JOIN verifies the probes
on the same datasource/config before executing: GET /charts/{id}/data (saved,
tile, preview, report starter, per-measure isolation, live and
previous-generation fallbacks), public single + batch + embed + PDF + AI (via
`ChartService.get_chart_data`), the dataset query, POST /semantic/query, the
measure preview AND the measure dry-run, the live filter adapter. No guard
needed (cannot fan out): the distinct cascade (DISTINCT over semi-joins),
snapshot builds (one table), workboard runtime (no SQL JOIN), single-table
executors. Readers of persisted joins outside the query path (workboard
lookups, workspace suggestions, lineage) read through the contract.

## Compatibility audit (P1-06)

`backend/scripts/audit_relationship_contract.py` (read-only) classifies every
persisted relationship with the runtime reader; exit code 2 = a row that would
refuse its model's queries. Run it against every environment before deploying.
