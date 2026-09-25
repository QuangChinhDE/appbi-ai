# Report Experience

Stacked on `feat/dashboard-design-engine-v2` (PR #5). Human-directed, AI-designed:
the author owns content, layout and meaning; AI Design composes the reading
experience from what the data actually shows.

## Architecture (as built)

```
tile renders rows (authed client on builder, publicClient on /d, /embed)
  │  numbers are numbers, time is ordered, partial periods flagged   ← backend chart_value_normalization
  ▼
ReportEvidence store  ── tiles publish {rows, measure, format, grain, partial} or "pending"
  ▼
findings (lib/report-findings)  trend · peak · latest · period_comparison · top_item
  │   · concentration · attainment · partial_periods — pure functions of those rows;
  │   partial periods shared across a time axis; shares only for additive measures
  ├─► NarrativeWidget (widget_type "narrative"): stores finding KEYS + words, never a
  │   number; "updating" during refetch, "not enough data" when the filter leaves none
  └─► planner snapshot: what the report says (sentence + key), finding kinds per visual
AI Design
  style / structure / redesign (V2 permission layers, locks, scope, validator — unchanged)
  redesign may add BLOCKS (headline, summary, chapter, takeaway): coerced at the boundary
  (finding refs must name a tile on the page; model text with digits dropped)
  directions (executive / operations / editorial): grammars over roles, meanings and
  findings → an ordinary PresentationPlan → same compiler, validator, apply path
  content proposals (sort_by_value, retitle): listed before → after, applied only on
  Accept as a draft edit, audited (dashboard_content_proposal_accepted/rejected)
  visual review: rendered preview captured → one vision call against a rubric →
  repairs only via the closed style allow-list + validator; scores shown as advice
Lifecycle
  blocks are draftOnly rows owned by their creator: hidden on /d and /embed, published
  in the same commit as the layout, deleted by Discard; undo removes them
Responsive
  phone: side-by-side KPIs stay 2-up, text blocks gain the height re-wrapped words need
Gates
  render audit chart.noMarks · report-experience contract (25) · backend lifecycle,
  normalization, critic tests · e2e report-experience.spec (marks, draft→publish,
  live sentences, all three directions)
```

## Evidence (Olist, production build, real model)

| | |
|---|---|
| Before (V2): empty main chart, directions = recolour | `screenshots/before-v2-*.jpg` |
| Data fixed: line, R$, 91.9%, partial-period note | `screenshots/p0-*.jpg` |
| Executive / Operations / Editorial, /d at 1440 · 820 · 390 | `screenshots/<direction>-public-<w>.jpg` |
| Preview == Apply | `screenshots/<direction>-preview.jpg` |
| Filter SP → headline, KPIs and summary recomputed | `screenshots/executive-filter-SP.jpg` |
| Visual review on the rendered preview | `screenshots/vision-review-panel.jpg` |
