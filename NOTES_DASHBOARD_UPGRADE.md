# Dashboard upgrade — test checklist after merge

This file tracks risky areas to verify after merging the dashboard upgrade
(free-canvas mode, theme, widgets, PODIUM chart).

## Migration

- [ ] `alembic upgrade head` runs cleanly on a copy of prod DB.
- [ ] Existing dashboards still load (default `layout_mode = "grid"`, `theme_config = {}`).
- [ ] `widget_type` defaults to `"chart"` on existing `dashboard_charts` rows.

## Frontend type narrowing — chart_id

The backend now allows `dashboard_charts.chart_id` to be NULL (for non-chart
widgets). The frontend `DashboardChart.chart_id` is still typed `number` so
the ~25 existing call-sites keep working. When commit 4 (widgets) lands:

- Widget rows must be filtered out before passing to chart-only code paths
  (e.g. `useChartData`, `<ChartTile chartId={...} />`, public viewer chart
  list rendering).
- Suggested guard: `if (dc.widget_type && dc.widget_type !== 'chart') ...`.
- Files most likely to need narrowing: `dashboards/[id]/page.tsx`,
  `d/[token]/page.tsx`, `embed/[token]/page.tsx`,
  `PublicLinksManager.tsx`, `AddChartModal.tsx`, `DashboardGrid.tsx`,
  `ChartTile.tsx`.

## Step 2 — Free-canvas mode (HIGHEST RISK)

Converter `gridToCanvas` / `canvasToGrid` lives in
`frontend/src/lib/dashboard-layout-convert.ts`. Watch for:

- [ ] Open an existing grid dashboard, switch to canvas, switch back. Tiles
      must end up in the same grid cells (round-trip stable).
- [ ] Tile that started at `x=0,y=0,w=12,h=4` should map to full canvas
      width and height = 4 * 80px = 320px.
- [ ] After switching to canvas, drag a tile, switch back to grid — overlap
      resolution must push tiles down (no two tiles share a cell).
- [ ] Multi-page dashboards: `pageId` preserved on every tile through
      conversion.
- [ ] Public-link viewer (`/public/dashboards/[token]`) renders both modes.
- [ ] MCP-generated dashboards (always grid) keep working unchanged.

## Step 3 — Theme system

- [ ] Default theme = current look (no visual diff for existing dashboards).
- [ ] Switching `theme.mode = "dark"` does not change KPI numeric formatting
      or chart palettes — only chrome (cards, borders, text colors).
- [ ] Theme propagates to embedded/public viewer.

NOTE: Theme is currently wired only into the editor page
(`/dashboards/[id]`). Public viewer (`/d/[token]`) and embed
(`/embed/[token]`) already have their own `publicTheme` system and were
not touched to avoid conflicts. Followup: merge `theme_config` into the
public theme resolver in those pages so end-users get the same look.

## Step 4 — Widgets

Widgets live alongside charts via `widget_type` discriminator on
`dashboard_charts`. Watch for:

- [ ] `widget_type = "chart"` rows behave exactly like before (no extra
      fetches, no broken layout).
- [ ] Text widget with expression `{{daysUntil("2026-06-30")}}` renders a
      number. Expression engine has no eval / no network access.
- [ ] Countdown widget recovers from past target dates (shows 0 / "ended").
- [ ] Shape / image widgets only render in canvas mode; in grid mode they
      either hide or render as a placeholder card (decision: hide).
- [ ] `parameter_switcher` widget writes back to `DashboardChart.parameters`
      on bound charts and triggers refetch.

## Step 5 — PODIUM chart + KPI icon

- [ ] PODIUM enum value added via `ALTER TYPE charttype ADD VALUE`. New
      charts of this type save and reload.
- [ ] Explore editor shows PODIUM in the type picker; required fields are
      `rankField`, `valueField`, `nameField`.
- [ ] Existing KPI charts render unchanged when `iconName` is unset.

## General

- [ ] `npm run typecheck` clean.
- [ ] Backend `pytest -q` clean for chart/dashboard tests.
- [ ] No console errors when loading `/dashboards/[id]` for a
      pre-upgrade dashboard.

## Explore fixes round 2 (2026-05-02)

Areas to verify after this round of fixes.

### #1 Breakdown filter semantics
- [ ] Build a chart with breakdown + a measure filter like `Rev > 0`.
      Verify the filter is applied to aggregated `(dim, breakdown)` rows
      *before* pivot — i.e. cells where the aggregated metric is `<= 0`
      should disappear from the chart, not just be hidden columns.

### #2 Bar family contract
- [ ] `BAR` no longer shows a Breakdown picker. Existing BAR charts that
      used a hidden breakdown will lose it on next save (expected).
- [ ] `GROUPED_BAR` requires a Breakdown — validation message tells the
      user. Multiple metrics get truncated to the first one when
      switching to GROUPED_BAR / STACKED_BAR.
- [ ] No leftover `lineMetric` survives when switching away from
      BAR_LINE; no leftover `breakdown` survives when switching to BAR /
      HORIZONTAL_BAR / BAR_LINE.

### #3 COUNT on non-numeric
- [ ] In any MetricSlot, "+ count any field..." dropdown lists *all*
      columns. Adding a string column with COUNT works end-to-end (chart
      renders, query SQL is valid).
- [ ] Switching agg from COUNT → SUM on a string-typed metric drops the
      metric (silent — note in NOTES). Numeric → numeric agg changes
      preserve the metric.

### #4 Percent stack labels
- [ ] In STACKED_BAR percent mode with data labels on, every segment ≥4%
      shows its own percentage label, positioned inside (white text). In
      normal mode, only the top segment shows its formatted total above
      the bar (unchanged behavior).

### #5 Series colors
- [ ] Style panel shows a "Series colors" section listing every series
      key from the current chart preview. Picker overrides palette;
      reset button restores palette default. Saved across reloads.

### #6 Naming
- [ ] Stacked Bar's split-dimension picker now reads "Breakdown" (not
      "Stack by"). Pie's "Legend" intentionally untouched (different
      concept — slice category).

### #7 + Add field
- [ ] When all numeric fields are already added, the "+ add value..."
      select is disabled (greyed out). The "+ count any field..."
      select is independently disabled when all fields are claimed.
