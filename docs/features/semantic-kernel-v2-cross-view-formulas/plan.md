# Semantic Kernel v2 — cross-view derived measures: plan

## Files

| Layer | File | Why |
|---|---|---|
| semantic engine | `backend/app/services/semantic_query_engine.py` | plan + expand cross-view formulas, compile dependencies as one request, apply the arithmetic over the result; the v1 in-statement refusal stays as defence in depth |
| cache identity | `backend/app/services/query_cache.py` | version bump — the same request changes from refusal to a result |
| authoring | `frontend/src/components/datasets/ModelViewEditPanel.tsx`, `frontend/src/hooks/use-dataset-model.ts` | pre-save dry-run: a semantic refusal is not "lỗi cú pháp" |
| contract | `docs/features/semantic-foundation-freeze/kernel-contract-v1.md` | F7 evolves to v2; history kept |
| tests | `backend/tests/pair2_topology.py`, `foundation_corpus.py`, `test_semantic_foundation_pg.py`, `test_semantic_cross_view_formula_pg.py` | hand oracles, entry-point parity, invariants |
| browser | `e2e/tests/semantic-cross-view-formula.spec.ts` | analyst journey: author → preview → chart → published dashboard |

## Why this architecture

The engine already evaluates several measures at their own grains in one request
(isolation, re-anchor, stitch) with all the safety rules. A formula is arithmetic over
those results, so the smallest correct design is: ask the dependencies as that request,
then compute. No second engine, no new join path, and the historical
JOIN-before-aggregate inlining is never reachable for a cross-view dependency.

## Tests decided before coding

- F7 corpus (hand-computed): KPI from several bases, with its dependencies, nested,
  repeated dependency, zero / NULL denominators, cross-table dependency, measure-filter
  dependency; grouped by conformed / M:1 / snowflake / calendar; refusals (unrelated
  dimension, ambiguous / tied roles, route limit, invalid relationship, duplicate key,
  non-arithmetic formula); filters (own, related, conformed, calendar, two predicates,
  authoritative, formula filter, soft drop).
- Every case through every entry point (`ENTRY_CORPUS`).
- Invariant: formula = arithmetic over the dependencies asked together (or the same
  refusal); base invariance on Postgres and DuckDB; historical JOIN number differs;
  cycle; agg override; pivot / window; dependency computed once; bounded compile.
- Fail-first on the pre-change engine; byte-identical SQL for every pre-existing golden.
- BigQuery: live + published snapshot execution of the formula.
