import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  VIS, asIs, createChart, f, measureMarks, openInBuilder, settle, shotPath, sum, valuesBy, watchConsole,
  type MarkReport,
} from './_chart_visual';

/**
 * CHART VISUAL CERTIFICATION — every chart type the Builder offers
 * (ExploreChartConfig CHART_TYPE_GRID, 33 types) is built on the deterministic
 * fixture (backend/scripts/ci/seed_e2e_chart_visual.py), run by the Builder
 * against the real API + database, and must show its DATA MARKS — not only
 * axes, a legend or a container. Project `chart-visual`, retries 0.
 *
 * Each case asserts: the response carries the oracle (DATA), the series /
 * categories / labels reached the renderer (MODEL), and the marks are drawn
 * with real geometry and no NaN coordinates (VISIBLE). One screenshot per type
 * (+ the BAR_LINE branches) is kept in .artifacts/chart-visual/ (CI uploads it).
 *
 * The user report this gate exists for: BAR_LINE, X = date, bar = a measure,
 * line = a measure — "10 rows", axes + legend, an EMPTY plot. Root cause: the
 * value axis got `width={undefined}` → Recharts offset NaN → every mark at NaN.
 */
type Case = {
  type: string;
  role: Record<string, unknown>;
  style?: Record<string, unknown>;
  /** oracle: dimension column → expected aggregated values */
  oracle?: { dim: string; values: Record<string, number> };
  /** what must be visibly drawn */
  expect: (m: MarkReport, chart: Locator) => Promise<void> | void;
};

const E = VIS.expected;
const MONTHS = Object.keys(E.leads_won_by_month);
const dump = (m: MarkReport) => JSON.stringify({ ...m, text: m.text.slice(0, 200) }).slice(0, 700);
const atLeast = (key: keyof MarkReport, n: number) => (m: MarkReport) => expect(m[key] as number, `${String(key)} in ${dump(m)}`).toBeGreaterThanOrEqual(n);
const all = (...fns: Array<(m: MarkReport, c: Locator) => unknown>) => async (m: MarkReport, c: Locator) => { for (const fn of fns) await fn(m, c); };
const showsText = (...texts: string[]) => (m: MarkReport) => texts.forEach((t) => expect(m.text, `text "${t}" in ${dump(m)}`).toContain(t));
/** a bar chart of non-negative values is read from a ZERO baseline */
const zeroBaseline = (m: MarkReport) => {
  // the VALUE axis: Y for vertical bars, X for horizontal ones
  const valueTicks = /^-?[\d.,]+[KMB]?$/.test(m.yTicks[0] ?? '') ? m.yTicks : m.xTicks;
  expect(valueTicks[0], `value axis must start at 0: ${dump(m)}`).toBe('0');
};
/** a line / area spans its whole axis (not a half-drawn path): n points on a
 *  category axis sit at band centres, so the span is (n-1)/n of the plot. */
const spans = (points: number) => (m: MarkReport) =>
  expect(m.lineSpan, `line spans ${points} points: ${dump(m)}`).toBeGreaterThan((points - 1) / points - 0.05);
const fullSpan = spans(12);
const datesReadable = (m: MarkReport) => {
  const ticks = [...m.xTicks, m.text];
  for (const t of ticks) expect(t, 'no raw ISO timestamp in labels').not.toMatch(/\d{4}-\d{2}-\d{2}T|T0{2}:/);
};
/** every bubble sits INSIDE the plot frame (not cut by the clip) */
const bubblesInsideFrame = async (_m: MarkReport, chart: Locator) => {
  const out = await chart.evaluate((root) => {
    const frame = [...root.querySelectorAll('svg rect[rx="10"]')].find((r) => !r.closest('clipPath, defs'))?.getBoundingClientRect();
    if (!frame) return -1;
    return [...root.querySelectorAll('svg circle')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && (r.left < frame.left - 2 || r.right > frame.right + 2 || r.top < frame.top - 2 || r.bottom > frame.bottom + 2);
    }).length;
  });
  expect(out, 'bubbles cut by the plot edge').toBe(0);
};

export const CASES: Case[] = [
  // ── essentials ──
  { type: 'TABLE', role: { selectedColumns: [f('region'), f('revenue')], metrics: [sum('revenue')] },
    oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('htmlCells', 8), showsText('North', '8,400', 'South', '6,600')) },
  { type: 'MATRIX', role: { tableMode: 'pivot', tableRowDimension: f('region'), tableColumnDimension: f('channel'), tablePivotMetric: sum('revenue'), metrics: [] },
    expect: all(atLeast('htmlCells', 12), showsText('North', 'Online', 'Partner', '3,600')) },
  { type: 'KPI', role: { metrics: [sum('revenue')] }, expect: showsText('30.0K') },
  { type: 'GAUGE', role: { metrics: [sum('revenue')] }, expect: all(atLeast('marks', 2), showsText('30.0K')) },
  { type: 'BULLET', role: { metrics: [sum('revenue')] }, expect: all(atLeast('marks', 2), showsText('30.0K')) },
  // PODIUM is HTML: the three ranked blocks with the oracle values.
  { type: 'PODIUM', role: { dimension: f('region'), metrics: [sum('revenue')] }, oracle: { dim: 'region', values: E.revenue_by_region },
    expect: showsText('WINNER', 'North', '8.4K', 'West', '7.8K', 'East', '7.2K') },
  // ── comparison ──
  { type: 'BAR', role: { dimension: f('region'), metrics: [sum('revenue')] },
    oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('bars', 4), zeroBaseline) },
  { type: 'HORIZONTAL_BAR', role: { dimension: f('region'), metrics: [sum('revenue')] },
    oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('bars', 4), zeroBaseline) },
  { type: 'GROUPED_BAR', role: { dimension: f('region'), breakdown: f('channel'), metrics: [sum('revenue')] }, expect: all(atLeast('bars', 12), zeroBaseline) },
  { type: 'STACKED_BAR', role: { dimension: f('region'), breakdown: f('channel'), metrics: [sum('revenue')] }, expect: all(atLeast('bars', 12), zeroBaseline) },
  { type: 'BAR_LINE', role: { dimension: f('region'), metrics: [sum('revenue')], lineMetric: sum('won') },
    oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('bars', 4), atLeast('linePaths', 1), spans(4), zeroBaseline) },
  { type: 'WATERFALL', role: { dimension: f('product'), metrics: [sum('profit')] },
    oracle: { dim: 'product', values: E.profit_by_product }, expect: atLeast('marks', 3) },
  // ── trend ──
  { type: 'LINE', role: { dimension: f('order_date'), metrics: [sum('revenue')], timeGrains: { [f('order_date')]: 'month' } },
    expect: all(atLeast('linePaths', 1), fullSpan, datesReadable, showsText('Jan 24')) },
  { type: 'AREA', role: { dimension: f('order_date'), metrics: [sum('revenue')], timeGrains: { [f('order_date')]: 'month' } },
    expect: all(atLeast('linePaths', 1), fullSpan, datesReadable) },
  { type: 'TIME_SERIES', role: { timeField: f('order_date'), metrics: [sum('revenue')], timeGrains: { [f('order_date')]: 'month' } },
    expect: all(atLeast('linePaths', 1), fullSpan, datesReadable) },
  { type: 'RIBBON', role: { timeField: f('order_date'), breakdown: f('region'), metrics: [sum('revenue')], timeGrains: { [f('order_date')]: 'month' } },
    expect: all(atLeast('marks', 4), datesReadable, showsText('Jan 24', 'North', 'South', 'East', 'West')) },
  { type: 'TIMELINE', role: { timeField: f('order_date'), dimension: f('product'), metrics: [sum('revenue')] },
    expect: all(atLeast('marks', 12), datesReadable, showsText('P1', 'P2', 'P3', '2024-01-15')) },
  // ── composition ──
  { type: 'PIE', role: { dimension: f('region'), metrics: [sum('revenue')] }, oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('marks', 4), atLeast('sectors', 4)) },
  { type: 'DONUT', role: { dimension: f('region'), metrics: [sum('revenue')] }, oracle: { dim: 'region', values: E.revenue_by_region }, expect: all(atLeast('marks', 4), showsText('North', 'South')) },
  { type: 'POLAR_AREA', role: { dimension: f('region'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 4), showsText('North')) },
  { type: 'TREEMAP', role: { dimension: f('region'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 4), showsText('North', 'West', 'East', 'South')) },
  { type: 'FUNNEL', role: { dimension: f('stage'), metrics: [sum('leads')] }, oracle: { dim: 'stage', values: E.leads_by_stage }, expect: all(atLeast('marks', 4), showsText('Lead', 'Won', 'Proposal', 'Qualified')) },
  { type: 'WORD_CLOUD', role: { dimension: f('region'), metrics: [sum('revenue')] }, expect: showsText('North', 'South', 'East', 'West') },
  // ── relationship ──
  { type: 'SCATTER', role: { scatterX: f('revenue'), scatterY: f('cost'), metrics: [] }, expect: atLeast('marks', 24) },
  { type: 'BUBBLE', role: { scatterX: f('revenue'), scatterY: f('cost'), dimension: f('product'), metrics: [sum('leads')] }, expect: all(atLeast('marks', 3), bubblesInsideFrame) },
  { type: 'NINE_BOX', role: { scatterX: f('revenue'), scatterY: f('profit'), dimension: f('region'), metrics: [] }, expect: atLeast('marks', 4) },
  { type: 'HEATMAP', role: { dimension: f('region'), breakdown: f('channel'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 12), showsText('North', 'Online')) },
  { type: 'BOXPLOT', role: { dimension: f('region'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 4), showsText('North')) },
  { type: 'RADAR', role: { dimension: f('region'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 1), showsText('North', 'South', 'East', 'West')) },
  { type: 'SANKEY', role: { dimension: f('channel'), breakdown: f('region'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 12), showsText('Online', 'North')) },
  { type: 'SUNBURST', role: { dimension: f('region'), breakdown: f('channel'), metrics: [sum('revenue')] }, expect: all(atLeast('marks', 16), showsText('North · 28%')) },
  // ── geo ──
  { type: 'MAP_POINT', role: { scatterX: f('lon'), scatterY: f('lat'), dimension: f('state_code'), metrics: [sum('revenue')] }, expect: atLeast('marks', 4) },
  // MAP_REGION is HTML (region cards with an intensity bar; no geo topology is bundled).
  { type: 'MAP_REGION', role: { dimension: f('state_code'), metrics: [sum('revenue')] }, oracle: { dim: 'state_code', values: E.revenue_by_state },
    expect: all(atLeast('htmlMarks', 4), showsText('CA', 'FL', 'NY', 'TX')) },
];

test('the matrix covers every chart type the Builder offers', async () => {
  // The registry is ExploreChartConfig's CHART_TYPE_GRID; read it from source so a
  // new selectable type without a visual case FAILS here.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'explore', 'ExploreChartConfig.tsx'), 'utf8');
  const start = src.search(/const CHART_TYPE_GRID\b/);
  expect(start, 'CHART_TYPE_GRID declaration').toBeGreaterThan(0);
  const grid = src.slice(start, src.indexOf('];', start));
  const offered = [...grid.matchAll(/value:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  if (grid.includes('DEFAULT_CHART_TYPE_META')) {
    const meta = src.slice(src.search(/const DEFAULT_CHART_TYPE_META\b/));
    offered.push(meta.match(/value:\s*'([A-Z_]+)'/)![1]);
  }
  offered.sort();
  expect(offered.length).toBeGreaterThan(30);
  expect(CASES.map((c) => c.type).sort()).toEqual(offered);
});

for (const c of CASES) {
  test(`${c.type}: builds, runs and visibly draws its data`, async ({ page }) => {
    const errors = watchConsole(page);
    const id = await createChart(page.request, c.type, c.role, c.style);
    const { resp, body, chart } = await openInBuilder(page, id);
    // DATA
    expect(resp.status(), JSON.stringify(body).slice(0, 400)).toBe(200);
    expect((body.data ?? []).length, 'rows').toBeGreaterThan(0);
    if (c.oracle) expect(valuesBy(body, c.oracle.dim)).toEqual(c.oracle.values);
    // MODEL + VISIBLE
    await expect(chart.getByTestId('chart-failure')).toHaveCount(0);
    const m = await measureMarks(chart);
    await chart.screenshot({ path: shotPath(c.type) });
    expect(m.nan, `NaN coordinates in ${c.type}`).toBe(0);
    await c.expect(m, chart);
    expect(errors, `console errors in ${c.type}`).toEqual([]);
  });
}

// ── BAR_LINE: the user-reported chart, every branch ──────────────────────────

const LEADS = Object.values(E.leads_won_by_month).map((v) => v.leads);
const WON = Object.values(E.leads_won_by_month).map((v) => v.won);
const BL_DATE = {
  dimension: f('order_date'), metrics: [asIs('total_leads')], lineMetric: asIs('won_deals'),
  timeGrains: { [f('order_date')]: 'month' },
};

async function assertComboVisible(m: MarkReport, bars: number, label: string, points = bars) {
  expect(m.nan, `${label}: NaN coordinates (the blank-plot bug)`).toBe(0);
  expect(m.bars, `${label}: bars ${dump(m)}`).toBeGreaterThanOrEqual(bars);
  expect(m.linePaths, `${label}: line ${dump(m)}`).toBeGreaterThanOrEqual(1);
  expect(m.lineSpan, `${label}: line spans the ${points} categories ${dump(m)}`).toBeGreaterThan((points - 1) / points - 0.05);
}

function seriesValues(body: { data?: Array<Record<string, unknown>> }, col: string): number[] {
  return (body.data ?? []).map((r) => Number(r[f(col)]));
}

test('BL2 (user report): built in the Builder — date X, AS-IS bar + line — draws bars AND line; save, reopen, dashboard', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/explore/new');
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: VIS.dataset_name }) });
  await select.selectOption({ label: VIS.dataset_name });
  await page.getByRole('button', { name: 'Change' }).first().click();
  await page.locator('button[title="Compare categories and rankings"]').click();
  await page.locator('div.grid button[title="Bar + Line"]').first().click();
  const slot = (label: RegExp) => page.locator('div').filter({ has: page.locator('label', { hasText: label }) }).last();
  await slot(/^X Axis/).locator('button').first().click();
  await page.locator('button[title="vis.order_date"]').first().click();
  // Picking X derives the base and seeds the value roles: the bar takes a
  // declared measure and the line the OTHER declared measure — never a
  // coordinate (a fresh Bar + Line used to seed "SUM of lat").
  await expect(slot(/^Bar Values/)).toContainText('Tổng lead nhận');
  await expect(slot(/^Line Value/)).toContainText('Won');
  await expect(slot(/^Line Value/)).not.toContainText('lat');

  const [run] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data')),
    page.getByRole('button', { name: 'Run' }).click(),
  ]);
  // DATA — 12 monthly rows, leads + won per month as the oracle says
  const body = await run.json();
  expect(run.status()).toBe(200);
  const sent = run.request().postDataJSON();
  expect(sent.chart_type).toBe('BAR_LINE');
  expect(sent.config.generatedRoleConfig.lineMetric.field).toBe(f('won_deals'));
  expect(body.data.length).toBe(12);
  expect(seriesValues(body, 'total_leads')).toEqual(LEADS);
  expect(seriesValues(body, 'won_deals')).toEqual(WON);
  // MODEL + VISIBLE
  const chart = page.getByTestId('explore-chart');
  await settle(chart);
  const m = await measureMarks(chart);
  await chart.screenshot({ path: shotPath('BAR_LINE-date-asis-builder') });
  await assertComboVisible(m, 12, 'Builder');
  expect(m.text, 'legend names both series').toContain('Tổng lead nhận');
  expect(m.text).toContain('Won');
  expect(m.xTicks.join(' ')).toContain('Jan 24');
  datesReadable(m);

  // SAVE → REOPEN: the same series, visible again
  const nameBox = page.getByPlaceholder('Chart name...');
  if (!(await nameBox.isVisible())) await page.getByText('New Chart', { exact: true }).click();
  await nameBox.fill(`E2E VIS BL2 ${Date.now()}`);
  await nameBox.press('Enter');
  const [created] = await Promise.all([
    page.waitForResponse((r) => /\/api\/v1\/charts\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(created.status(), await created.text()).toBeLessThan(300);
  const chartId = (await created.json()).id;
  const reopened = await openInBuilder(page, chartId);
  expect(seriesValues(reopened.body, 'total_leads')).toEqual(LEADS);
  const m2 = await measureMarks(reopened.chart);
  await reopened.chart.screenshot({ path: shotPath('BAR_LINE-date-asis-reopened') });
  await assertComboVisible(m2, 12, 'reopened');

  // DASHBOARD TILE (editor viewport, then a smaller tile)
  const dash = await page.request.post('/api/v1/dashboards/', { data: { name: `E2E VIS BL2 board ${Date.now()}` } });
  expect(dash.status(), await dash.text()).toBeLessThan(300);
  const dashId = (await dash.json()).id;
  const add = await page.request.post(`/api/v1/dashboards/${dashId}/charts`, {
    data: { chart_id: chartId, layout: { x: 0, y: 0, w: 12, h: 8 } },
  });
  expect(add.status(), await add.text()).toBeLessThan(300);
  for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(vp);
    const [tileData] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/charts/${chartId}/data`)),
      page.goto(`/dashboards/${dashId}`),
    ]);
    expect(seriesValues(await tileData.json(), 'total_leads')).toEqual(LEADS);
    const tile = page.getByTestId('tile-chart').first();
    await expect(tile).toBeVisible();
    await settle(tile);
    const mt = await measureMarks(tile);
    await tile.screenshot({ path: shotPath(`BAR_LINE-date-asis-tile-${vp.width}`) });
    await assertComboVisible(mt, 12, `tile ${vp.width}px`);
  }
  expect(errors, 'console errors').toEqual([]);
});

const BL_BRANCHES: Array<[string, Record<string, unknown>, Record<string, unknown>, number, number?]> = [
  ['BL1 categorical X', { dimension: f('region'), metrics: [sum('revenue')], lineMetric: sum('won') }, {}, 4],
  ['BL3 dual Y axis ON', { dimension: f('region'), metrics: [sum('revenue')], lineMetric: sum('cost') }, { dualYAxis: true }, 4],
  ['BL4 dual Y axis OFF (shared scale)', { dimension: f('region'), metrics: [sum('revenue')], lineMetric: sum('cost') }, { dualYAxis: false }, 4],
  ['BL5 two bar measures + line', { dimension: f('region'), metrics: [sum('revenue'), sum('cost')], lineMetric: sum('won') }, {}, 8, 4],
  ['BL6 declared measures AS-IS, date X', BL_DATE, {}, 12],
  ['BL2b raw date X (no grain)', { dimension: f('order_date'), metrics: [sum('leads')], lineMetric: sum('won') }, {}, 12],
];
for (const [name, role, style, bars, points] of BL_BRANCHES) {
  test(`${name}: bars and line are both drawn`, async ({ page }) => {
    const errors = watchConsole(page);
    const id = await createChart(page.request, 'BAR_LINE', role, style);
    const { resp, chart } = await openInBuilder(page, id);
    expect(resp.status()).toBe(200);
    const m = await measureMarks(chart);
    await chart.screenshot({ path: shotPath(`BAR_LINE-${name.split(' ')[0]}`) });
    await assertComboVisible(m, bars, name, points ?? bars);
    if (style.dualYAxis === true) {
      const rightAxis = await chart.locator('.recharts-yAxis.yAxis').count();
      expect(rightAxis, 'a left and a right value axis').toBeGreaterThanOrEqual(2);
    }
    expect(errors).toEqual([]);
  });
}

// ── zero / null / empty are different things ─────────────────────────────────

test('ZERO values draw the chart frame with its categories; NULL values say there is nothing numeric', async ({ page }) => {
  const errors = watchConsole(page);
  for (const type of ['BAR', 'LINE', 'BAR_LINE']) {
    const role = type === 'BAR_LINE'
      ? { dimension: f('region'), metrics: [sum('zero_metric')], lineMetric: sum('zero_metric') }
      : { dimension: f('region'), metrics: [sum('zero_metric')] };
    const id = await createChart(page.request, type, role);
    const { body, chart } = await openInBuilder(page, id);
    expect((body.data ?? []).length).toBe(4);
    const m = await measureMarks(chart);
    await chart.screenshot({ path: shotPath(`ZERO-${type}`) });
    expect(m.nan, `${type} zero: NaN`).toBe(0);
    expect(m.xTicks.sort(), `${type} zero: every category on the axis`).toEqual(['East', 'North', 'South', 'West']);
    expect(m.yTicks, `${type} zero: a 0 value axis`).toContain('0');
  }
  for (const type of ['BAR', 'BAR_LINE']) {
    const role = type === 'BAR_LINE'
      ? { dimension: f('region'), metrics: [sum('null_metric')], lineMetric: sum('null_metric') }
      : { dimension: f('region'), metrics: [sum('null_metric')] };
    const id = await createChart(page.request, type, role);
    const { chart } = await openInBuilder(page, id);
    const m = await measureMarks(chart);
    await chart.screenshot({ path: shotPath(`NULL-${type}`) });
    expect(m.nan, `${type} null: NaN`).toBe(0);
    await expect(chart.getByTestId('chart-no-numeric-data'), `${type}: all-NULL values are stated, not an empty plot`).toBeVisible();
  }
  expect(errors).toEqual([]);
});

// ── chart-type transitions leave no stale marks ──────────────────────────────

async function chooseType(page: Page, group: string, type: string) {
  await page.getByRole('button', { name: 'Change' }).first().click();
  await page.locator(`button[title="${group}"]`).click();
  await page.locator(`div.grid button[title="${type}"]`).first().click();
}
async function runAndMeasure(page: Page, label: string) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data')),
    page.getByRole('button', { name: 'Run' }).click(),
  ]);
  expect(resp.status(), label).toBe(200);
  const chart = page.getByTestId('explore-chart');
  await settle(chart);
  const m = await measureMarks(chart);
  await chart.screenshot({ path: shotPath(`TRANSITION-${label}`) });
  await page.screenshot({ path: shotPath(`TRANSITION-${label}-page`) });
  expect(m.nan, `${label}: NaN`).toBe(0);
  return { m, chartType: await chart.getAttribute('data-chart-type'), body: await resp.json() };
}

test('transitions BAR → LINE → BAR_LINE → BAR → PIE → BAR keep no stale marks', async ({ page }) => {
  const errors = watchConsole(page);
  const id = await createChart(page.request, 'BAR', { dimension: f('region'), metrics: [sum('revenue')] });
  await openInBuilder(page, id);
  await chooseType(page, 'Follow change over time or order', 'Line');
  let r = await runAndMeasure(page, 'BAR-to-LINE');
  expect(r.chartType).toBe('LINE'); expect(r.m.bars).toBe(0); expect(r.m.linePaths).toBeGreaterThanOrEqual(1);
  await chooseType(page, 'Compare categories and rankings', 'Bar + Line');
  const lineSlot = page.locator('div').filter({ has: page.locator('label', { hasText: /^Line Value/ }) }).last();
  await expect(lineSlot).toContainText('Tổng lead nhận'); // seeded: a declared measure, not lat/lon
  r = await runAndMeasure(page, 'LINE-to-BAR_LINE');
  expect(r.chartType).toBe('BAR_LINE'); await assertComboVisible(r.m, 4, 'LINE→BAR_LINE');
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  r = await runAndMeasure(page, 'BAR_LINE-to-BAR');
  // Combo → Bar keeps the line's measure as a second bar series (Power BI's
  // combo → clustered column behaviour): 2 × 4 bars, and NO line left behind.
  expect(r.chartType).toBe('BAR'); expect(r.m.bars).toBe(8); expect(r.m.linePaths).toBe(0);
  await chooseType(page, 'Show part-to-whole structure', 'Pie');
  r = await runAndMeasure(page, 'BAR-to-PIE');
  expect(r.chartType).toBe('PIE'); expect(r.m.bars).toBe(0); expect(r.m.sectors).toBeGreaterThanOrEqual(4);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  r = await runAndMeasure(page, 'PIE-to-BAR');
  expect(r.m.bars).toBe(4); expect(r.m.sectors).toBe(0);
  expect(valuesBy(r.body, 'region')).toEqual(E.revenue_by_region);
  expect(errors).toEqual([]);
});

test('transitions TABLE → KPI → BAR draw the new type only', async ({ page }) => {
  const errors = watchConsole(page);
  const id = await createChart(page.request, 'TABLE', { selectedColumns: [f('region'), f('revenue')], metrics: [sum('revenue')] });
  await openInBuilder(page, id);
  await chooseType(page, 'Tables, cards, and goal visuals', 'KPI');
  let r = await runAndMeasure(page, 'TABLE-to-KPI');
  expect(r.chartType).toBe('KPI'); expect(r.m.htmlCells).toBe(0); expect(r.m.text).toContain('30.0K');
  expect((r.body.data ?? []).length, 'KPI has no hidden GROUP BY').toBe(1);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  const slot = page.locator('div').filter({ has: page.locator('label', { hasText: /^X Axis/ }) }).last();
  await slot.locator('button').first().click();
  await page.locator('button[title="vis.region"]').first().click();
  r = await runAndMeasure(page, 'KPI-to-BAR');
  expect(r.chartType).toBe('BAR'); expect(r.m.bars).toBe(4); expect(r.m.text).not.toContain('30.0K');
  expect(errors).toEqual([]);
});

// ── dashboard parity for representative families ────────────────────────────

test('dashboard tiles draw the same marks as Explore (BAR, LINE, BAR_LINE, KPI, TABLE, PIE, SANKEY)', async ({ page }) => {
  const errors = watchConsole(page);
  const specs: Array<[string, Record<string, unknown>]> = [
    ['BAR', { dimension: f('region'), metrics: [sum('revenue')] }],
    ['LINE', { dimension: f('order_date'), metrics: [sum('revenue')], timeGrains: { [f('order_date')]: 'month' } }],
    ['BAR_LINE', BL_DATE],
    ['KPI', { metrics: [sum('revenue')] }],
    ['TABLE', { selectedColumns: [f('region'), f('revenue')], metrics: [sum('revenue')] }],
    ['PIE', { dimension: f('region'), metrics: [sum('revenue')] }],
    ['SANKEY', { dimension: f('channel'), breakdown: f('region'), metrics: [sum('revenue')] }],
  ];
  const dash = await page.request.post('/api/v1/dashboards/', { data: { name: `E2E VIS parity ${Date.now()}` } });
  const dashId = (await dash.json()).id;
  const ids: Record<string, number> = {};
  for (const [i, [type, role]] of specs.entries()) {
    ids[type] = await createChart(page.request, type, role);
    const add = await page.request.post(`/api/v1/dashboards/${dashId}/charts`, {
      data: { chart_id: ids[type], layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 8, w: 6, h: 8 } },
    });
    expect(add.status(), await add.text()).toBeLessThan(300);
  }
  await page.goto(`/dashboards/${dashId}`);
  for (const [type] of specs) {
    // tiles render lazily as they enter the viewport: scroll until this one is there
    const tile = page.locator(`[data-testid="tile-chart"][data-chart-type="${type}"]`).first();
    await page.mouse.move(720, 500); // over the canvas, not the sidebar
    for (let i = 0; i < 30 && !(await tile.count()); i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(250);
    }
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toBeVisible({ timeout: 30_000 });
    await settle(tile);
    const m = await measureMarks(tile);
    await tile.screenshot({ path: shotPath(`TILE-${type}`) });
    expect(m.nan, `${type} tile NaN`).toBe(0);
    if (type === 'BAR') expect(m.bars).toBe(4);
    if (type === 'LINE') { expect(m.linePaths).toBeGreaterThanOrEqual(1); expect(m.lineSpan).toBeGreaterThan(0.85); }
    if (type === 'BAR_LINE') await assertComboVisible(m, 12, 'tile');
    if (type === 'KPI') expect(m.text).toContain('30.0K');
    if (type === 'TABLE') { expect(m.htmlCells).toBeGreaterThanOrEqual(8); expect(m.text).toContain('8,400'); }
    if (type === 'PIE') expect(m.sectors).toBeGreaterThanOrEqual(4);
    if (type === 'SANKEY') expect(m.marks).toBeGreaterThanOrEqual(12);
  }
  expect(errors).toEqual([]);
});
