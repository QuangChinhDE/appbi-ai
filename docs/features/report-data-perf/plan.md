# Report data path performance — plan (approved 2026-11-07, implemented)

## What was measured (localhost, 2026-11-07, rc1 report, 16 bindings, cache warm)

| Measure | Result |
|---|---|
| Postgres queries per binding on a **cache hit** | **28** (cold: 39). Top: semantic_explores ×5, dataset_tables ×4, data_sources ×4, semantic_views ×3, datasets ×3, semantic_models ×2, snapshots ×3, charts, chart_parameters |
| CPU per binding in `mint_dto` (12-core dev box) | 21 ms. The pilot VM (2 vCPU) measured ~160 ms per request including HTTP and the Next proxy |
| HTTP per `/data` request, warm | 37 ms sequential / 16 bindings in 0.24 s at 8 parallel (4 workers, 12 cores) |
| Frontend DTO cache | in memory, 60 s, **lost on reload**, which is why reload #2 is not faster |
| Rows sent per binding | up to `MAX_ROWS = 2000`. The pilot table got 1,945 rows (281 KB) |
| Public rate limit | `600/minute` **per IP** on `/data`. 40 bindings = 40 requests per filter change |

The pilot's 4.6–6 s is the CPU bill: 40 × ~160 ms = 6.4 CPU-seconds spread over 2 vCPUs, plus queuing.
The report itself is not heavy. The 1.6 s freeze is the browser: 23.8k nodes, 500 rendered
rows, and 1,000+ attribute-selector CSS rules recalculated on every update.

## Work items (in order of payoff)

### P1 — Batch data endpoint (fixes the request count and the 429 risk)
- `POST /public/reports/{token}/data:batch` and `POST /report-artifacts/{id}/data:batch`.
  Body `{bindings: [≤ MAX_BINDINGS], state}`. Returns `{id: dto}`.
- Once per request: `_live` (link, password and session checks), `effective_state`, and
  `resolve_state` (its period lookups currently run once per binding). Per binding: only the chart call.
- ReportFrame sends chunks of 8 bindings (visible ones first, P3), so 4 workers still run
  in parallel on a cold cache and the first numbers appear early.
- Rate limit: count one batch as one request, keyed by link token + viewer session, with
  the IP limit kept as a ceiling. 40 bindings → 5 requests instead of 40.
- The single `/data` endpoint stays, for compatibility (embed and old frames).
- **Protected subsystem: public-link security.** The same locks, `enforced` and `disclose`
  handling per binding; the batch only reuses the resolved state. New tests:
  `report_links_pg` cases for a lock override, a hidden filter, a password link, and a
  revoked link inside a batch.

### P2 — Cache hit without re-reading configuration (removes most of the 28 queries)
- Inside one batch: a request-scoped memo for model, explore, view, dataset, table and
  datasource lookups. This is safe because there is a single transaction and nothing is
  written.
- Across requests: a DTO micro-cache keyed by `(revision_id, binding_id, resolved state,
  enforced keys, data epoch)`. The data epoch is built from version stamps already stored
  (`chart.updated_at`, the semantic model's and views' `updated_at`, the snapshot version,
  the dataset's `updated_at`). It costs 1–2 queries instead of 28.
- **Open question before coding:** prove every edit that changes a result bumps one of
  those stamps (relationship edits, measure edits, credential changes, RLS/scope).
  If not every path can be proven, fall back to a 30 s TTL on public links only and say
  so. This is in the semantic area, so semantic-guard reviews it and the pair contracts must
  stay green.

### P3 — Load what is visible; reload only what a filter touches (runtime)
- runtime.js asks first for bindings whose element is rendered (`offsetParent`, not inside
  a hidden tab or page). Hidden ones load when they become visible (IntersectionObserver
  plus a class or attribute change on the ancestor).
- On a filter change: visible bindings refetch, and hidden ones are marked stale and
  refetched on show.
- The DTO carries `appliedFilters` (declared keys the engine applied). After the first load,
  a binding whose applied set does not include the changed key keeps its DTO.

### P4 — Browser freeze
- Repeat rendering: draw the first 100 rows, then the rest in idle chunks. Honour an
  author `data-rac-limit="N"`, which the DTO also gets so the server sends only N rows.
- Context Pack and the AI rules: never use attribute-selector CSS to map codes to labels
  (the DTO already carries labels); cap lists; give the source chart a `dataLimit`.
- Readiness warning: a repeat bound to a binding with no limit and more than 500 rows.

### P5 — Deployment (no code)
- 4 vCPU as recommended. `WEB_CONCURRENCY` must match the cores: compose defaults to 4,
  and running 4 workers on 2 vCPU only adds contention.

## Expected result on the pilot VM (estimate, to be measured)

| | Now | After P1+P2+P3 |
|---|---|---|
| Open the report | ~4.6 s, 40 requests | ~1 s, 2–5 requests |
| Change a filter | ~6 s, 40 requests, then a 1.6 s freeze | < 1 s for the visible part. The freeze depends on P4 plus the report-side fixes (A) |
| 429 risk behind one company IP | ~15 filter changes per minute | gone in practice (batch counted once) |

## Verification
- Benchmark harness `.artifacts/perf/` (query count per binding and HTTP timing) run
  before and after on a 40-binding page. A test pins the cache-hit query count.
- `report_code_contract`, `report_links_pg` (new batch cases), the pair contracts, tsc.
- E2E: public link plus Studio, a filter change refetches only visible bindings, and
  the numbers are identical to the single-binding path.
- A real check on the pilot VM (2 vCPU) with Playwright timing, the same way the pilot
  team measured it.

## Not in scope
- Merging several KPIs into one query (it changes the binding model). P1–P3 remove most of the cost anyway.
- The pilot report's own fixes (A in the feedback): the pilot team does them.

## Result (localhost, backend limited to 2 CPUs, 21-binding report)

| | Before | After |
|---|---|---|
| Data requests to open the page | 21 | 3 (batches of 8) |
| Data requests per filter change | 14–18 | 3 |
| Postgres queries per page with a warm cache | 598 | 3 (data epoch) |
| Backend CPU per page with a warm cache | 0.517 s | 0.001 s |
| Open → every number on screen | ~1.1 s | ~0.7 s |

The first viewer after an edit (or after 60 s) still pays the ~28 queries per binding: the
in-batch memo of the chart engine's configuration reads was left out, because it changes
ChartService, which is part of the protected semantic area. The DTO cache applies to public
links only. Studio calls are authed per user and are always computed (batched).
