# Semantic Kernel v2 — cross-view derived measures: intent

## Problem

The Data Model editor offers measures of other tables in a formula's autocomplete
("Measure từ bảng: …") and routes them to `depends_on`; the save API accepts a
qualified cross-view dependency. The engine then refused every such formula
(`UNSUPPORTED_CONTEXT`, foundation freeze `455034e3`), and the editor's pre-save
dry-run reported that refusal as "lỗi cú pháp". The product advertised a capability it
could not execute.

The refusal was right to exist: the original implementation (`50d39a55`) inlined the
other view's measure into the formula view's statement, so it aggregated over that
view's joined rows. On the Pair #2 fixture `${sales.revenue} / ${customers.n}` was
**39** (198 / 5 joined sale rows, integer division) alone and **49** when its
dependencies were in the same chart — the correct answer is 198 / 4 = **49.5**.

## Outcome

A derived measure is arithmetic over semantic measures whose meanings stay stable at
their own valid grains. A cross-view formula is answered exactly when its dependencies,
asked together, are answered — with each dependency meaning what it means alone — and
refused otherwise with the same category. Editor → save → dry-run → preview → chart →
dashboard expose one contract.

## Out of scope

Row-level / dataset-scope cross-table expressions (`source_columns`) keep their own,
separate contract. Pivots, window functions and calculated fields over a cross-view
formula stay refused. No change to refresh/publish, chart UX, dashboards, sources.
