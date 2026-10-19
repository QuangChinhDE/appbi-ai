# Public Dashboard & Embed Viewer UX hardening — plan and evidence

## Files

Frontend only.

| File | Why |
|---|---|
| `lib/dashboard-pages.ts` | `REPORT_FRAME_MAX_WIDTH` |
| `components/dashboards/PublicDashboardView.tsx` | frame max width on masthead + canvas; `useParentResize` measures the report, dedupes, coalesces; transient status overlay |
| `components/visualizations/TableVisualization.tsx` | header word floor measured in the header's real font; floor also applies when the table has room |
| `e2e/tests/_responsive-uiux.ts` | `iframeHost` can act as an auto-resizing host (`autoResize`) |
| `e2e/tests/dashboard-responsive-uiux-public.spec.ts` | 47 (1920/2560/3440 frame), 48 (embed auto-resize, both `/embed` and `emb_`) |

## Evidence (real browser; dashboards 53 "multi-page, every chart type" and 55 "slicers")

| /d, dashboard 53 | Before | After |
|---|---|---|
| canvas @1920 / 2560 / 3440 | 1844 / 2484 / 3364 px | 1572 px, centred, masthead aligned |
| widest tile ratio @1920 / 2560 / 3440 | 7.4 / 10.1 / 13.8 : 1 | 6.3 : 1 at every width |
| ≤ 1440 | — | identical (1364 px canvas at 1440) |
| CLS 640 – 1440 | 0.17 – 0.19 | ≤ 0.007 |
| horizontal page overflow 390 – 3440 | none | none |

| Embed host honouring `appbi:resize`, dashboard 53 | Before | After |
|---|---|---|
| after load (390 frame) | 600 (report 5 306) | 9 168 = report |
| frame 390 → 1024 | stayed 9 178 | 5 210 = report |
| page → shorter page | no message | 1 028 |
| messages per width change | — | 1–2 (was ~20 animation steps before coalescing) |

## Gates

`tsc --noEmit`; `npm run qa` (responsive-layout 25, unified-grid 43, embed-framing,
presentation 128, report-experience 40, …) pass; ESLint on touched files equals base.
E2E tests 47 and 48 need the CI presentation fixture and run in the PR's E2E job.

## Backlog (found, not fixed here)

1. Hard-coded Vietnamese strings on the public surface ("Đang tải biểu đồ…", "Đang mở
   trang…", export progress) and hard-coded English ones ("Clear selection") — the
   public i18n catalog is empty.
2. `embed_header_mode` exists in the appearance model but nothing renders it and the
   editor has no control for it.
3. Horizontal bar data labels can run past the plot edge ("Enriched Re…") — chart engine.
4. A load-error banner appearing after the first paint still shifts the canvas once
   (lasting, honest state; kept in flow on purpose).
5. The Builder canvas itself is not capped; on ≥ 1920 screens an author sees wider tiles
   than viewers (the layout is the same; the width differs).
