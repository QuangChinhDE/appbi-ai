# Relationship authoring ↔ join resolver — plan

## Guardrail scoping

`python scripts/ci/guardrail_check.py --diff` on the working tree:

- Verdict: **WARN** — touches protected subsystems `semantic_layer` and
  `engineering_infrastructure`; `.gitignore` has no layer (warning only).
- Required tests it named: measure_render, dialect_structural,
  semantic_state_contracts, filter_matrix, golden_sql, galaxy_golden,
  distinct_cascade_bq, surface_parity, relationship_metadata, semantic_health,
  semantic_router_access, error_contracts, relationship_contract,
  relationship_contract_pg, tsc, and the protection-system meta suites.

## Files and layers

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `services/semantic_join_resolver.py` | services (protected) | `JoinContract`, `read_join_contract`, `join_is_usable`, `raise_for_invalid_relationships`; graph built from the contract; reverse edges keep every key pair / the expression; `JoinEdge.key_pairs` |
| 2 | `services/semantic_query_engine.py` | services (protected) | refuse invalid relationships; grain graph and direct-join reads through the contract; key probes recorded per trusted FROM-chain JOIN |
| 3 | `services/relationship_key_guard.py` (new) | services (protected) | `key_probe_sql`, `verify_key_probes` (cached; duplicate or failure → ValueError) |
| 4 | `services/chart_service.py`, `api/datasets.py`, `routers/semantic.py` | services / api | run the probes before every semantic execute; live adapter refuses invalid rows and probes its JOINs |
| 5 | `services/dataset_model_service.py` | services (protected) | one transaction + lock for add/remove; `replaces`; PK rules; same-identity edit keeps condition/provenance; alias-aware delete; tombstones (incl. replaced auto rows); regeneration keeps user edits; drift keeps joins; suggestions scoped; direct-API validation through the contract with provenance carry-over; model response canonical; lock re-reads the model row |
| 6 | `services/semantic_health_service.py` | services (protected) | keys from the contract; blocking `invalid_relationship` check |
| 7 | `chart_semantic_service.py`, `filter_utils.py` | services | pickers via `join_is_usable` |
| 8 | `schemas/semantic.py`, `routers/semantic.py` | schemas / router | `JoinDefinition.calendar_role/user_edited`; explores write lock; `expected_updated_at` → 409 |
| 9 | `frontend/src/hooks/use-dataset-model.ts`, `components/datasets/DataModelCanvas.tsx` | frontend | edit sends `replaces`; delete sends `alias` |

No row crosses a layer boundary; no schema change.

## Risks

| Risk | How it shows | What catches it |
|---|---|---|
| A model whose declared N:1 key really has duplicates now REFUSES charts that used to render (with inflated numbers) | 400 naming the relationship and key | intended; semantic health lists the same keys before publish |
| A probe that cannot run (permissions, timeout) refuses a chart that would otherwise run | 400 "Không xác minh được khoá …" | intended (unknown ≠ unique); cached per TTL |
| Probe cost on BigQuery: one `GROUP BY key` scan of each trusted dim relation per TTL | warehouse bytes | probes only for FROM-chain to-one JOINs; EXISTS filters need none; cached shared |
| Golden SQL drift from the reverse-edge rewrite | golden_sql fails | equality reverse edges are byte-identical to before; baseline unchanged |
| A previously stored invalid row would now refuse its whole model | 400 on every query of that model | 0 of 336 local rows are invalid; the Data Model and health show the row |

## Tests

| Test | New / existing | Locks |
|---|---|---|
| `tests/test_relationship_contract.py` | new (unit, CI unit tier) | fixture classification, reader everywhere, reverse edges, health parity, PK atomicity, edit/delete identity, regeneration, drift, direct API, state-transition matrix (persisted JSON == reloaded graph), probe verdicts |
| `tests/test_relationship_contract_pg.py` | new (CI integration-golden) | reverse-edge values, key guard values, three races |
| `tests/fixtures/relationship_legacy_v1.json` | new | 26 legacy forms, SUPPORTED / INVALID |
| `tests/mutation/relationship_pair_mutation.py` | new (manual) | the scenarios fail on 22bac47f |
| `test_non_fanning_reachability.py` | existing, helper adjusted | keyless joins are now invalid, so the helper adds keys; invariants unchanged |
| `test_phase1_relationship_metadata.py` | existing, one test inverted | "unknown cardinality defaults" became "is invalid, not many_to_one" — the old assertion encoded the defect |
| golden matrix, golden SQL, golden replay, distinct cascade, surface parity, explore parity, router access, health, state contracts | existing | unchanged and green |

## Verification

- Unit list, Postgres gates, protection meta suites, `tsc`: see the PR / report.
- Mutation: `relationship_pair_mutation.py` 18/18 FIXED on the candidate,
  17/18 DEFECT on 22bac47f (the 18th is a control); the tracked Postgres file
  run against 22bac47f fails 8/8 (wrong composite set, empty calendar set, no
  guard, lost update, writers not serialized).
- BigQuery (dw_buoi_8, inline data, read-only): the probes the chart runtime
  issues for the fixture charts (G12–G15, including the dimension-based
  G14/G15 that had no probe before the review fix), a duplicate control, a
  composite control, a first-column-repeats control and a typed-cast control
  ('007' and '7' collide under the join's SAFE_CAST while the raw key is
  unique) — 6/6 valid BigQuery with the expected verdict.
- Independent review (semantic-guard) findings #1–#7 and the lower items were
  fixed and locked (see the test list); each new test was re-run with the
  pre-review behaviour patched back in and fails on it.
- Browser (throwaway stack, dataset 56): edit sends `replaces` and keeps one
  relationship after reload; a key-changing edit replaces rather than
  duplicates; delete sends keys + `alias` and removes only that relationship.
- Live DB read: 336 persisted joins, 0 invalid under the final contract.

## Rollback

Revert the merge commit. No data is rewritten by this change (lazy
canonicalization; tombstones and `user_edited` are additive JSON keys that the
previous code ignores).
