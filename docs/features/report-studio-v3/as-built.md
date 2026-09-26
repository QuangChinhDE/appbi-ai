# Report Studio V3 — as built (increment 1)

Stacked on PR #6 (`feat/report-experience`). This increment is the part of the V3 brief that
landed; what did not is listed under **Open** and is not claimed.

## What changed

| Area | Change | Where |
|---|---|---|
| Create from data | `POST /dashboards/report-starter`: candidates are enumerated from the dataset's semantic model; the model (or, without one, the rules) chooses by id only; each choice is run through `ChartService.preview_chart_data` and kept only if it returns numbers; refused picks are backfilled with the next candidate of the same kind. Identifiers and numeric columns are never breakdowns; one view of a measure per kind. Model titles containing digits are dropped. | `backend/app/services/report_starter_service.py`, `api/dashboards.py`, `ReportStarterModal.tsx` |
| KPI context | A KPI shows the comparable-period change of the same measure and an 18-point sparkline, from a time series on the same report under the same filters. Neutral colour unless the author set `kpiGoalDirection`. Steps aside on a tile too short to hold it. | `KpiContext.tsx` |
| Chart hygiene | Dashboard tiles: no derived axis titles (raw field names), no one-entry legend, month buckets read "Sep 16", date ticks thinned to the measured width instead of rotated. | `ExploreChart.tsx` |
| KPI labels | Hover-only actions no longer take the label's width (builder and public); labels wrap at words. | `ChartTile.tsx`, `ReadonlyChartTile.tsx`, `tile-frame.ts`, `globals.css` |
| Structure | Growing a tile inside a row re-divides the row (neighbours ≥ 8/36 columns) instead of pushing a neighbour onto its own row. | `structure.ts` |
| Narrative | An AI block never restates a KPI tile (`kpi_value`); it keeps change, peak, leader, attainment. | `blocks.ts` |
| Findings | Tiles cited by a narrative load eagerly (builder + public), so a headline never waits on a lazily mounted tile. | `report-evidence.tsx`, `DashboardGrid.tsx`, `PublicDashboardView.tsx` |
| Vision review | Runs only on a settled render (lazy tiles mounted, no spinner / updating sentence, fonts and images loaded, layout still for two polls); otherwise skipped with the reason stated. | `vision-review.ts`, `useAiDesign.ts` |
| Undo/Redo | Redo re-creates AI-created blocks (undo deletes them). | `dashboards/[id]/page.tsx` |

## Evidence (production build, isolated backend + temp Postgres)

`screenshots/`: `s1-01-modal`, `s1-builder-1440` (report created from Olist), `s3-ai-preview-1440`,
`s3-after-apply-1440`, `s7-after-redo-1440`, `s8-public-1440/820/390`.

Measured on the final build: create-from-data 4.0–8.9 s (29 s once, model latency), first render
≈3.9 s, AI redesign preview 3.2–4.2 s, published report settled ≈3.4 s at each width, 0 page errors.
Undo 10→9 tiles and redo 9→10 in the one run whose plan created a block (an earlier build of this
branch); later runs' plans created none, so they show 9→9 and do not re-test block re-creation.

## Open (not done in this increment)

- The AI drawer overlays the right third of the canvas at 1440. Reserving its width was tried and
  reverted: it changes the geometry of a style-only preview, which the presentation contract forbids
  (preview = the published frame). Needs a design decision (e.g. zoom-to-fit while the drawer is open).
- Preview mode / device-width toggle / before-after compare; Operations and Editorial refinements;
  reference HTML/image scenario; benchmark datasets beyond Olist; export capture; vision re-check after repair.
- Published Olist fixture at 820: a half-width tile leaves a hole beside it; pie outside labels clip.
- Bar value labels keep a trailing `.0` (`R$1,258,681.3`).
