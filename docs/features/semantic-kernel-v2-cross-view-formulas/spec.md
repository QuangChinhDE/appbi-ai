# Semantic Kernel v2 — cross-view derived measures: spec

## Behaviour

A formula measure (`expression` + `depends_on`) is **cross-view** when its dependency
tree reaches a measure aggregated at another grain than the formula's own view (a
measure of another view, or a cross-table measure whose source is another view).

When a request names a cross-view formula (as a measure or as a measure filter):

1. The formula tree is expanded to its plain measures, in first-use order, each once
   (a dependency used twice is computed once; cycles are refused).
2. Those measures are compiled as **one ordinary request** with the same dimensions,
   filters and time grains — so isolation (KPI), re-anchor (single fact) and the
   dimensioned stitch (several facts) apply, with every route, grain, key-guard,
   authoritative-filter and soft-drop rule of the kernel.
3. The formula's arithmetic is applied over that result with the kernel's arithmetic
   (`normalize_division`: true division, NULL on a zero denominator).
4. A measure filter on the formula is a condition on the computed value; sort / Top-N /
   limit apply to the formula's result.

Consequences (all executed in `test_semantic_cross_view_formula_pg.py` and the F7
corpus):

- each dependency keeps its own meaning — the formula equals the arithmetic over the
  dependencies asked together, NULLs and soft drops included;
- the answer is identical from every chart base;
- a dimension / filter a dependency cannot take is that request's refusal, same
  category (e.g. `FANOUT_RISK` grouped by a dimension unrelated to one fact,
  `AMBIGUOUS_ROUTE` for tied calendar roles, `ROUTE_LIMIT`, `INVALID_RELATIONSHIP`,
  the key guard's `FANOUT_RISK`, an authoritative filter that cannot apply);
- same-view formulas are unchanged (byte-identical SQL for every pre-existing golden).

Refused (`UNSUPPORTED_CONTEXT`, product-facing text): a cross-view formula that reads a
column (`${TABLE}`), calls an aggregate / window itself or references a dimension; a
pivot / window function / calculated field over it; an explicit aggregation other than
its type; a dependency displayed with another aggregation in the same request.

## Data

No schema change. Stored measures keep their shape. `SEMANTIC_RESULT_CACHE_VERSION` →
`kernel-v2-cross-view-formula-2026-10` (v1 cached a refusal that v2 answers).

## API

No new endpoint. Every executor (ChartService saved / preview / batch, `/semantic/query`,
dataset execute, measure preview / dry-run, public / embed through ChartService)
compiles through `SemanticQueryEngine.run`, so all of them gain the behaviour and keep
the refusal category (`X-AppBI-Refusal` / `category`).

## UI

The editor already offered cross-view measures. The pre-save dry-run now tells a
semantic refusal ("chưa dùng được — …") apart from a syntax error.
