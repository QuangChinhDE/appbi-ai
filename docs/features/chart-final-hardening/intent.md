# Chart final hardening — intent

**Status:** in progress
**Owner:** Chart / Explore
**Date:** 2026-10-07

## Problem

A DA creates a chart, picks a Dataset, then picks fields. The base chip reads
`bc_activity +2` in green, while the preview refuses with
"Có 2 đường join khác nghĩa nhau tới 'Date': bc_pfm → Date | bc_pfm → bc_owner → Date".
The DA never chose `bc_activity`. Their report: "nó mặc định nhảy về bảng default".

Root cause (verified in code and runtime):

1. With no base yet, a new TABLE chart auto-seeds up to 10 default columns from the
   model's views in model order. The "derive base from the first picked field" effect
   could not tell those seeded columns from user picks, so it committed the FIRST view
   of the model as the base. The base is then sticky.
2. Revenue comes from `bc_pfm`. The planner computes a measure at its fact's grain, so
   the Date routes start at `bc_pfm`. The refusal is correct. The UI never said that the
   numbers come from `bc_pfm`, and it showed a green "joined" chip during a refusal.
3. Changing the base wiped every filter and both role configs without warning. The same
   wipe also fired on the first derived base after a dataset switch.
4. The refusal reached the UI only as the engine's prose (Inactive, alias, role-playing).
   The structured category was in a header that the frontend never read.

Further findings: `GET /charts/{id}/data` returned emitted SQL (with filter values
inlined), routing and dialect to view-only readers. Several 500 paths returned raw
exception text. `PUT /charts/{id}` validated only the request fragment. The per-type
required-role check never ran on Python 3.11 (`str(Enum)`). `percent_of_total` could be
previewed but not saved. `median` was rewritten to `auto` by dry-run. A leftover SQL
draft skipped validation of a generated chart.

## Goal

The chart says what it is based on and where that came from. It never commits a base
the user did not express. A refusal stays a refusal and is explained in business terms.
Changing the base keeps compatible work. Readers never receive internals.

## Out of scope

- The semantic planner, the resolver and the refusal rules are unchanged. They are
  already golden-proven (Pair #2 and #3), and no route is ever auto-picked.
- No redesign of the Chart Builder and no second planner in the frontend.
- Auto-switching the base when the user's intent later moves to another fact. The UI
  shows it (the "numbers computed on" note); it does not silently re-root.

## Constraints

- The refusal contract stays as it is: 400 + `X-AppBI-Refusal` + humanised `detail`.
  The `refusal` body object is added to it.
- The public surface uses `publicClient` only. Public batch tiles map the category to a
  message without routes.
- Schemas must not import services (guardrail layer rule).

## Acceptance criteria

1. Choosing a dataset commits no base. Only the first field the user picks derives one,
   and a saved chart reopens on its saved base.
2. The chip shows the base origin (saved / chosen / derived) and, when it applies, the
   tables the numbers are computed on. It is never green for "joined". It is amber after
   a refusal.
3. An AMBIGUOUS_ROUTE response has `refusal {category, target, routes}`. The Builder shows
   "Không xác định được quan hệ tới {target}" with actions. Routes and prose are under
   a details section.
4. A base change drops only the bindings the new base cannot reach, names them, and
   offers Undo.
5. Preview, saved data and Save's dry-run return the same refusal.
6. A view-only reader gets no `sql_emitted`, `routing` or `dialect`. 5xx responses carry
   a reference id, not driver text.
7. PUT validates the merged chart. There is one aggregation vocabulary. Query mode is
   resolved by the runtime's resolver.
