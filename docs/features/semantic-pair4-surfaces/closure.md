# Pair #4 — ChartService ↔ Dashboard / Public / Embed / Export / AI: the enforced contract

Branch `fix/semantic-pair4-surfaces`, started from `demo` @ `455034e3` (Semantic
Foundation Freeze, Kernel Contract v1). Pairs #1–#3 and the kernel contract
(`docs/features/semantic-foundation-freeze/kernel-contract-v1.md`) are frozen
inputs.

**The Semantic Kernel owns business truth. A surface may display, transport,
paginate and securely withhold that truth — it never recomputes a different
one.** Where a surface cannot carry the Kernel's answer exactly, it refuses with
the Kernel's category, or shows the Kernel's declared soft drop observably.

Locked by `backend/tests/test_pair4_surfaces_pg.py` (CI step "GATE — Pair 4
surfaces (Postgres)", guardrail test `pair4_surfaces`): the Kernel v1 golden
requests (`tests/pair2_topology.py`, `tests/foundation_corpus.py` — hand-computed
oracles) asked through every surface on a real Postgres datasource, a real
dashboard and real public links.

## Surface execution map

| Surface | Entry | Reaches the Kernel through | Filters owned by | Refusal reaches the caller as |
|---|---|---|---|---|
| Authenticated dashboard tile | `GET /charts/{id}/data` | `ChartService.get_chart_data` | the request (chart / dataset permission scopes it) | 400 + `X-AppBI-Refusal` |
| Public single chart (`/d`, `/embed`, the PDF worker) | `GET /public/dashboards/{t}/charts/{id}/data` | `get_chart_data` (link snapshot TTL) | `_build_public_chart_filters` (server-side) | 400 + `X-AppBI-Refusal` (Pair #4) |
| Public batch | `POST /public/dashboards/{t}/charts/data` | `get_charts_data_batch` → N × `get_chart_data` | the same merge, per tile | per-item `error` + `category` (Pair #4) |
| Public slicer options | `GET /public/dashboards/{t}/filters/distinct-values` | `get_distinct_field_values` (the distinct cascade) | the same merge + own-field hard bounds + link allow-list | `restricted` / `unavailable` / `dropped_filters` |
| PDF export | worker prints `/d/<token>?print=1&filters=<b64>` | the public single chart | the public merge | as the public page |
| AI chart read (every dashboard / public AI tool) | `agent_flows.tools.context._fetch_chart_data` | `get_chart_data` (link snapshot TTL, Pair #4) | the public merge, scoped to the chart's dataset | `ToolError` / `semantic_refusal:<CAT>` |
| AI re-aggregation | `tool_aggregate_chart_data` | the rows the Kernel returned | — | refuses a non-additive SUM / AVG across rows |
| AI chart preview | `POST /charts/ai-preview` | `ChartService.preview_chart_data` with the config it saves (Pair #4; it was a physical `{column, aggregation}` query) | — | 400 + `X-AppBI-Refusal` |
| Agent-flow studio test on a link (editor-only) | `agent_flows.api.test_flow` | the AI chart read | the link's own contract — `services.public_link_scope.link_tool_context`, the SAME builder (`api.public._public_link_tool_context`) every live public AI endpoint uses (final closure) | as the AI read |

Authenticated dashboard locks are applied by the dashboard client; an
authenticated viewer's scope is the chart / dataset permission, not the
dashboard's lock (documented, not a widening: the same viewer may open the chart
itself).

## Public / security contract

* The public merge order is fixed: layered merge → link scope bounds → page
  scope bounds → `enforce_author_bounds` → **dataset scoping** → authoritative
  marking. Every 🔒 / 🚫 / page bound is `_authoritative`: applied by the Kernel
  or refused (`AUTHORITATIVE_NOT_APPLIED`), never dropped, on every surface.
* A report over several datasets: a dashboard filter whose `datasetId` names
  ANOTHER TILE's dataset on the same report AND whose field is a view of that
  dataset (not of the chart's) does not apply to the chart — Power BI's
  per-model filter, the set the builder sends per tile. It was refused, every
  tile of the second dataset. Everything else is kept, so the Kernel refuses it
  loudly: an id that mismatches on the chart's own field (a stale id), and a
  filter of a dataset NO tile of the report reads (a lock left behind when the
  charts moved to a new dataset — lifting it would serve the unbounded data).
  The chart's dataset is read from its table (the stored binding is a copy). The
  AI reports a filter left out this way in `filters_not_applied`.
* A 🔒 on dataset B of a two-dataset report bounds B's tiles only (as in the
  builder); it does not bound A's tiles. An author who needs both bounded locks
  both datasets.
* A public soft drop is observable: `debug.dropped_filters` = `[{semantic_field,
  reason: "not_applicable", detail}]` — never SQL, warnings, a value, the
  internal reason, or a 🚫 field.
* A public refusal carries the Kernel's category (single: header; batch:
  `category`), never a parsed message.
* A link edit or delete invalidates the public meta cache at once (it waited for
  the 60 s TTL).

## Slicer contract

* An option applied gives the Kernel's value or the Kernel's refusal; a NULL is
  never an option.
* A viewer's pick cascades through the union of the routes (a member with data
  via ANY fact — the global-slicer rule, unchanged). An **authoritative**
  constraint cascades through members EVERY route admits (one DISTINCT key-set
  semi-join per route, AND-ed); a route that cannot render refuses the
  constraint. Executed on BigQuery (inline rows) and Postgres. The union is
  wider than any single route's meaning.
* An empty list says why: `restricted` (an authoritative constraint the cascade
  cannot apply — nothing outside the shared scope is offered) or `unavailable`
  (the warehouse failed — never "no values match"). The public client treats
  `unavailable` as an error state.

## AI contract

* The AI reads the same rows as the public tile (same merge, same dataset
  scoping, same snapshot TTL); its caches key on the semantic epoch (model,
  measures, snapshot generations), the AI scope and the TTL.
* `filters_applied` lists only filters the Kernel applied; a dropped filter is
  listed in `filters_not_applied`.
* A refusal is an error with its category (`semantic_refusal:<CAT>`) — never a
  number.
* Re-aggregation of returned rows refuses SUM across groups and AVG across rows
  of a non-additive measure; a Top-N source is noted (`source_top_n`).

## Final closure (P4-C1 / C2 / C3)

* **Page bounds are applied, scoped out, or refused — never skipped (P4-C1).**
  A page filter naming another `datasetId` leaves a chart only when it is
  PROVABLY another tile's dataset's filter (`foreign_field_check`: that
  dataset is read by another tile of the report AND the field is that
  dataset's view). A stale id on the chart's own field, a deleted dataset, or
  no proof keeps the bound: the Kernel refuses (`AUTHORITATIVE_NOT_APPLIED`)
  and the slicer says `restricted`. It was skipped — the anonymous viewer got
  every region (198) and a slicer offering South on a North page.
* **The Studio link test reads the link's contract (P4-C2).** One builder owns
  "the AI context of a public link" (filters, locks, page bounds, exposed
  fields, freshness): the five live public AI endpoints and `test_flow` both
  call it. `modules/` reaches it through `services/public_link_scope.py`, where
  the public router registers it at import — no `modules → api` import; an
  unregistered builder refuses (503), it never runs unbounded. test-on-report
  and test-as-chat stay the author's own read, by contract.
* **Generation contract: coherent per logical read (P4-C3, Contract A).** A
  published BI report presents one "data as of" per view, so ONE logical read
  — a public page batch, an AI turn — is served ONE snapshot generation per
  dataset (`execution_plan.ReadScope`: the first tile of a dataset fixes it,
  later tiles of that read reuse it; a pinned generation that is no longer
  servable refuses the tile, never swaps to the other). Separate reads (a page
  switch, a lazy tile) each take the current generation and SAY which
  (`debug.snapshot_generation` / `snapshot_dataset_id` on every public tile);
  the public page re-reads older tiles once (`lib/snapshot-coherence`), derives
  "data as of" from the tiles on screen, and — if two generations remain —
  says so in the header instead of one as-of. A PDF export during which a
  publish landed carries an explicit note. (A server PDF prints one page per
  load — each page one read.)

## Cache contract

The Kernel result cache keys on the canonical filter, which now keeps
`_authoritative` and `_calendar_fan`: an ordinary result never answers the same
predicate as an authoritative bound, and two links never share a slot.

## Remaining debt (owner)

| Debt | Owner |
|---|---|
| In-process caches (public meta, AI registry) are invalidated per worker; another worker serves the old entry until its TTL (≤ 60 s / 5 min) | platform |
| The public slicer reads at most 50 000 distinct values before search / pagination | dashboard UX |
| The AI ignores a viewer's granularity override (reads the chart's saved grain) | AI surfaces |
| A pivot error on a direct API call is a warning, not a refusal | semantic platform |
| An authoritative constraint on a calendar / role-played view of ANOTHER dataset is not provably foreign (no table) — kept, so refused | semantic platform |
| The public slicer shows `restricted` as "no values match" (the flag is returned; the client does not read it yet) | dashboard UX |
| A 🔒 cascade whose routes mix a composite-key EXISTS with semi-joins falls back to a WHERE form BigQuery may reject over aggregated views — it fails closed (`unavailable`) | semantic platform |
| `semantic_epoch` aggregates snapshot rows globally: any dataset's refresh retires every AI cache entry (cost only) | AI surfaces |

Recorded, not changed: a public refusal message is shown verbatim (the
documented Phase-12.7 choice — the author sharing the report needs the reason)
and may name semantic view names on the refused routes; never SQL, values or a
🚫 field (owner: public-link security).

## Pair #5 handoff

* `dataset add_column` expressions `[a]/[b]` may preserve PostgreSQL integer
  division (outside the Kernel's division rewrite) — recorded, not fixed here.
  Resolved in Pair #5 (`docs/features/semantic-pair5-data-state/closure.md`):
  calculated columns compile through the Kernel's `normalize_division`.
