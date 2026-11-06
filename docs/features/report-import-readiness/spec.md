# Report import readiness — spec

## One readiness report

The new service `services/report_code/readiness.py` exposes:

`readiness(db, rev | {html, css, js, bindings, filters}, *, dtos=None) -> {blocking: [...], warnings: [...], fixed: [...]}`

Every item has the shape `{code, place, message, fix?}`. `place` is a region id plus an element hint, so the Studio can point to the exact spot.

**Blocking** (publish refused, one HTTP 409 `{code: "NOT_READY", report}`):

| Code | Source | Meaning |
|---|---|---|
| `UNBOUND` | `lifecycle.dangling_references` | An anchor or filter names nothing the revision has. |
| `SAMPLE` | `lifecycle.sample_marks` | A design sample number is still shown. `allow_samples` keeps its current meaning. |
| `UNSAFE_ORIGIN` | `lifecycle.origin_warning` | The configured origin is loopback on a server. |

**Warnings** (shown, never block):

| Code | Meaning |
|---|---|
| `ROW_ADDRESS` | A value in a hand-built row has no `data-rac-row` / `data-rac-rank`. Uses `semantics.check_rows(fix=False)`. |
| `ASSOC` | A figure sits under another metric's label. The audit rules of `runtime.js`, ported to Python and run on the server against the bindings' DTOs (same skip rules as PR #96). |
| `STALE_TEXT` | Hard-coded text containing figures plus "tĩnh / mẫu / demo / sample / mock". |
| `PROVENANCE` | A number that matches no bound value. |

**Fixed** (applied on import, listed):

- row addresses added by `check_rows(fix=True)`;
- punctuation around years normalised.

The in-browser audit stays for live edits, but it reads the same rules. The Python version is the reference, and a shared JSON fixture keeps the two in parity.

## Where it runs

- **Import (both paths)**: the import job's result carries `readiness`. The Paste wizard shows it as a per-place checklist before the author opens the Studio.
- **Studio**: `GET /report-artifacts/{id}/readiness?revision=` drives the "Problems" panel and the unbound banner (PR #95).
- **Publish**: `lifecycle.publish` calls `readiness` and raises on blocking items. This replaces the separate `DanglingReferences` / `SampleNumbersRemain` checks; the error codes stay compatible.

## AI only for uncertain places

In `importer.propose()`:

- A slot is **settled** when the rules pick shares meaning and has confidence ≥ 0.6, or when it is a filter with a rules dimension.
- The model is called only if settled < all. It receives only the unsettled slots, plus a **shortlist** of candidates per slot: the top-8 by `_score` and same kind, instead of the full 160-row listing.
- A compatible page (`@cN` / `@fN`) never calls the model. This is already true and is now locked by a test.

The result records `ai_slots: N` so the cost is visible.

## Context Pack

The two-part contract from PR #96 stays. The Paste wizard and the Studio Data tab already offer the download.

The pack gains a final **self-check JSON**: the list of the placeholders it may use. An outside AI can validate its own output against that list.
