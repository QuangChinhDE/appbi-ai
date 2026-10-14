# Dashboard PowerPoint export and filter diagnostics — contract

Scope: the editable PowerPoint export (Builder and shared link) and who sees the
"filters that do not apply to this chart" diagnostic. Query and filter
semantics are unchanged; this is capture, layout and presentation.

## 1. The failure this closes

A customer deck contained a chart block that was a valid PNG of an empty card
(frame, no chart), and the export reported success. Reproduced in a real browser
(Builder export of pages never opened, 1.5 s network latency): every chart on
those pages was captured blank and the download "succeeded".

Root cause: page readiness (`lib/render-ready.ts`) counted a tile as painted if
it held ANY text — a title or a badge — and released the page once any tile had
painted. A chart that had not received its data was captured as an empty card;
the exporter accepted any `html2canvas` result; the backend substituted
"(biểu đồ không chụp được)" for a missing picture. A chart whose tile had not
mounted yet was silently skipped.

## 2. Readiness — one contract for PDF and PowerPoint

Every chart tile states `data-export-state` on its root (ChartTile and
ReadonlyChartTile): `loading` · `error` · `empty` · `data`. A `data` tile is
ready only when its body holds real visual marks — the chart visual
certification's definition: painted SVG shapes that are not axes, grid, legend,
labels, tooltips or clip definitions; a sized canvas; table cells with text; a KPI
value; coloured HTML marks. A title, a badge or a legend alone never counts. Tiles
without a state (text, headers, images, controls) are ready at once. A page is
ready when every tile is past `loading` (bounded: 25 s for PDF, 30 s per page for
PowerPoint).

## 3. What a PowerPoint deck contains

- One slide per report page (continued on extra slides at tile boundaries).
- KPI label and value, text, and table cells as editable text / native tables
  (long tables: the rows that fit, plus "… còn N dòng không hiển thị").
- Every chart as a picture, its title as an editable text box above it.
- The DESKTOP layout, whatever device the author is viewing in the Builder.

What it never contains:

- **Report controls** — slicers and parameter switchers, identified by widget
  type (`slicer`, `parameter_switcher`), never by label. The filters still shape
  every number: a deck exported with Region = North shows North's numbers.
- **The band those controls took.** An export-only projection
  (`closeControlBands`) closes a horizontal band that only controls occupied; a
  control beside content leaves that content in place; whitespace the author left
  elsewhere stays. Nothing is saved.
- **Editor and status chrome** (`data-export-hide`): the filter diagnostic, the
  "as of" badge, hover actions, drill controls, the Explore link.
- **A blank chart.** Each chart is captured only in a final state; a chart with
  rows must show ink in its plot area. One retry (back into view, ready again,
  capture again); if it still fails the export stops and names the charts —
  "Chưa tạo được PowerPoint: N biểu đồ không dựng được" — the dialog stays open
  for Retry and the success toast never shows. The backend refuses a deck with a
  missing or undecodable chart picture (422 `pptx_chart_missing`).

The integration embed (`emb_`) does not offer report export (backend refuses it).

## 4. The filter diagnostic

| Surface | Shown |
|---|---|
| Builder (and its Studio preview) | yes — author chrome |
| `/d/<token>`, `/embed/<token>`, `/embed/emb_…` | **no** (no badge, no hidden element, no tooltip) |
| PDF / PowerPoint pictures | no (`data-export-hide`) |

Builder copy: "N bộ lọc không áp dụng" / "N filter(s) not applied". Opened, it
names each filter by its report label, a product-language reason, and the
consequence ("Số liệu ở biểu đồ này không thay đổi theo các bộ lọc đó"), plus how
to fix it. Engine wording (reason codes, field references) is behind "Chi tiết
kỹ thuật" only.

| Backend reason(s) | Author reads |
|---|---|
| `no_field`, `unknown_field`, `dataset_mismatch`, `binding_unsupported`, builder "not in model" | the chart's data has no field that matches this filter |
| `unreachable_view`, `no_join_path`, `wrong_direction`, `ambiguous_path`, `no_primary_key`, `multi_role_pick_required` | the chart's data is not linked to this filter's field |
| `unsupported_operator`, `unknown_operator` | the filter's condition does not suit the chart's field |
| `empty_value` | the filter has no value yet |
| `not_in_public_whitelist`, `link_hidden` | the filter does not apply on the shared link |
| anything else | this filter cannot be applied to this chart |

## 5. Where it is enforced

- `e2e/tests/dashboard-pptx-export.spec.ts` — real exports, the real downloaded
  `.pptx` read with python-pptx + Pillow (pictures' plot ink, amber badge pixels,
  texts, native tables): slow-network Builder export of three pages (the
  reproduction), Region = North from the Builder and from `/d`, diagnostic
  visibility on Builder / `/d` / `/embed` / `emb_`, refusal and restore.
- `frontend/scripts/check-pptx-export-contract.mjs` (in `npm run qa`).
- `backend/tests/test_report_pptx_service.py`.
