# Report Studio V3 — as built

This branch is stacked on PR #6 (`feat/report-experience`), which is itself stacked on PR #5.
Evidence for the eight acceptance scenarios is in [`evidence/`](evidence/README.md).

## Architecture

| Capability | How it works | Where |
|---|---|---|
| Start from data | `POST /dashboards/report-starter` enumerates chart candidates from the dataset's semantic model. The model, or the rules when there is no model, chooses among them by id. Every choice is run before it is kept, and a refused pick is backfilled. The report gets an opening headline bound to live findings (the author's question is its context line), a slicer on the lead breakdown, and a detail table. No figure comes from the model. | `report_starter_service.py`, `ReportStarterModal.tsx` |
| Studio preview | The whole report before and after, at 1440/820/390, side by side or alone. Each frame is the builder route (`?studio=preview`) in an iframe whose width is the device width, so real breakpoints and real renderers apply. The frame is scaled only visually. Its state arrives by `postMessage`. It takes no edit lock and mounts every tile. It reports "settled" only when the tiles are mounted, nothing is loading and its height has held. The canvas and the report's coordinates never change. | `lib/studio/preview-mode.ts`, `StudioPreview.tsx` |
| Design directions | Reading orders, not palettes. Executive: what happened → why → evidence → detail. Operations: current state → exceptions the data flags → monitoring → drill-down. Editorial: thesis → chapters → caveats. Each finding is said once per page. A conditional finding (concentration, target, incomplete periods) is used only when the data supports it now. Headings are section headers. | `lib/dashboard-presentation/directions.ts` |
| Plan boundary | Model output is coerced before anything compiles. Figures are dropped from text. An unknown layout primitive is placed by count and disclosed. A forgotten report headline stays first. A reference design's `referenceReport` (converted / approximated / unsupported) becomes a note for the author. | `validator.ts`, `blocks.ts`, `compiler.ts` |
| Vision review | A closed loop, bounded to 2 model calls. It runs only on a settled render. It separates render defects from design issues and repairs only through the allow-list and the validator. It then re-captures and says which repaired issues are still visible. Low legibility is never accepted. | `vision-review.ts`, `useAiDesign.ts` |
| KPI context | The comparable-period change and a sparkline from a series of the same measure under the same filters. The colour is neutral unless the author sets `kpiGoalDirection`. It steps aside when the tile is too short. | `KpiContext.tsx` |
| Lifecycle | AI blocks are draft-only rows until Publish; Discard deletes them. Undo deletes them and Redo re-creates them. Save draft and Publish are disabled while an Apply is still committing. | `dashboards/[id]/page.tsx` |
| Responsive / export | Tablet rows fill the grid. The phone stack keeps a KPI 2-up and gives a headline its own height. Pie labels get room. Table columns keep their unbreakable content. The PDF snapshot is captured at page width and paginated at a readable scale. | `dashboard-pages.ts`, `ExploreChart.tsx`, `TableVisualization.tsx`, `export-pdf.ts` |

## Defects found by visual acceptance and fixed at their source

- **Export crop:** the export cropped the right half of every row. The html2canvas clone window was as wide as the
  element, not the page.
- **Export shrink:** a long report was shrunk onto one PDF sheet. It is now paginated.
- **Publish race:** Publish during an Apply published the new blocks over the old layout.
- **Plan refusal:** a whole redesign was refused over one unknown layout word ("summary").
- **Empty exceptions card:** an empty "Needs attention" card appeared when the data supported none of its findings.
- **Tablet hole:** a widened tile left a hole beside a half-width chart.
- **Pie labels:** pie labels were clipped.
- **Phone tables:** tables were unreadable on a phone. Headers broke letter by letter and numbers broke mid-value.
- **Segmented slicers:** segmented slicers were cut to "C…".
- **Stuck slicer:** a slicer with no source said "Loading values…" forever.
- **Direction colour:** a falling figure was coloured as bad news.
- **Phone headline:** the phone headline sat under a tall empty band.
- **Duplicate evidence:** a narrative repeated the KPI tiles, and the starter doubled a time series across two date
  axes.

## Release-candidate round (final head `dddb4c06`)

| DoD | Status | What closed it / evidence |
|---|---|---|
| 1 Semantic presentation | Met | A KPI states its span only when the series is proven to add up to it. The change carries its own window and value, and the span is named at the grain of its buckets. Incomplete periods are dashed. e2e: "a KPI says which span its number covers"; S1 asserts dashed partials and KPI scope. |
| 2 Fact ≠ problem | Met | "Needs attention" is gone: observations are titled "Worth knowing", and "Against target" appears only with a target. The contract rejects an observation titled as a problem. |
| 3 Legibility residuals | Met, with a limit | KPI value about 2.3× body text; pie labels only on slices ≥6%, with no stray leader lines; diagonal axis labels before vertical; values on small bar charts when nobody decided. The KPI context steps down rather than squeezing the number. The critic's model score is advice and certifies nothing. |
| 4 PDF production-ready | Met | Print scale is judged on screen size. Only a genuinely missing chart may say data is missing. The exporter records itself for the gate. e2e and S8 assert no incomplete warning and print scale ≥0.62. 6 pages rendered and reviewed. |
| 5 Studio UX | Met | The Studio preview (before/after at 1440/820/390) is unchanged. Undo/Redo, Save and Publish are all disabled while an Apply commits (two races found and fixed). |
| 6 Expressiveness / reference | Met, with a limit | Directions differ in structure (S4 signatures). A reference's structure is guaranteed at the plan boundary from live findings (S5: "opens with a headline"). The dark band and warm surface are not reproduced — see limitations. |
| 7 Visual critic | Met, with a limit | Settled render, 2 rounds, repairs through the validator, re-check names what is still visible. It reviews the builder preview at the builder's width and filters, not each device width. |
| 8 S1–S8 at final head | Met | 8/8 PASS, 99 assertions, at `dddb4c06` on the production image. |
| 9 Visual review | Done | Screenshots and every PDF page opened. Defects found this way (KPI span by day; KPI number squeezed out at 390; stuck tile; unplaced blocks) were fixed and re-verified. |
| 10 Meaningful gates | Met | Negative controls: export headline, observation title, no block when nothing is live, style-only makes no block, unplaced blocks. |
| 11 browser_verify / tsc | UNVERIFIED (see handoff) | The protocol was run against a dedicated container built from the commit. The gate itself is manual. tsc was run directly and is clean. |
| 12 Performance | Met | The first viewport is warm at 0.7–0.95 s. Cold first render after a restart was 18.2 s (one observation). |
| 13 Safety | Kept | No semantic, permission, lock or persistence path changed. Blocks come only from live finding keys. |

## Known limitations

- **Visual review residuals.** Model-scored legibility is advice. The four residuals from the earlier run were fixed in
  the renderer, and the re-check on the final run still names what it sees. Nothing is certified by a score.
- **Reference fidelity.** Hierarchy is reproduced (headline band, KPI strip, summary, hero chart). The reference's dark
  header band and warm paper surface are not: theme colourways have no band surface or warm paper tone. The lead
  finding the model picks may differ from the reference's theme (in S5 it led with delivery days).
- **Critic scope.** It reviews the builder preview at the builder's width and current filters, not each device width.
- **Cold start.** The first render of a large report right after a backend restart was 18.2 s in one run; warm it is
  under 1 s for the first viewport.
- **Reference design.** Only presentation is reproduced: layout, type, mood and accent. Photos, custom fonts, a
  reference's own header text and arbitrary CSS or JS are not. The model says which traits were not converted.
- **HTML import.** The separate "Import HTML" modal was not part of this acceptance. The reference scenario uses the
  image path.
- **Preview frame.** Studio preview renders the builder route in a same-origin iframe. Browsers that block
  same-origin iframes (for example a strict enterprise policy) cannot use it.
- **Planner variance.** Model plans vary between runs. The acceptance suite asserts properties (layout recomposed, no
  render defect, every sentence computed), not one exact composition.
