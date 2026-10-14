import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  addChartTile, addSwitcher, bindWhatIf, canon, chooseParam, collectTiles, DASH, deleteTestPats, dropReport,
  expectSameTiles, freeze, freshReport, integrationPat, openSurface, settle, V1, waitForTiles,
  type Fixture, type TileRows,
} from './_public-closure';

/**
 * Dashboard Public closure — the API-created INTEGRATION embed with REAL locked
 * filters (not full_report). An external backend calls
 * POST /integrations/embed/resolve with a PAT and `filters: [region in North]`;
 * the returned /embed/emb_… must be the published report under exactly that
 * scope — the same business result as the normal public runtime under the same
 * effective constraint (a /d link locked to North), and the Builder's own query
 * with region = North. Composition: parameters, what-if, cross-filter and date
 * drill work INSIDE the lock and never escape it; a viewer cannot widen it.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
let region: { field: string; semanticField: string; datasetId: number } | null = null;
let sw = { dim: 0, met: 0 };
let bar = 0;
let pie = 0;
let ts = 0;
let embPath = '';
let northD = '';

const NORTH = () => ({ field: region!.field, semanticField: region!.semanticField, datasetId: region!.datasetId, operator: 'in', value: ['North'] });

async function mintFiltered(request: APIRequestContext, dashboardId: number) {
  const pat = await integrationPat(request);
  const res = await request.post(`${V1}/integrations/embed/resolve`, {
    headers: { Authorization: `Bearer ${pat.token}` },
    data: { dashboard_id: dashboardId, filters: [NORTH()] },
  });
  expect(res.status(), `minting a North-locked embed failed: ${await res.text()}`).toBe(200);
  return String((await res.json()).embed_path);
}

async function reread(page: Page, tiles: number[], label: string, act: () => Promise<void>): Promise<TileRows> {
  const rows = collectTiles(page);
  await act();
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await waitForTiles(rows, tiles, label);
  return freeze(rows);
}

async function clickFirstBar(page: Page, tile: number) {
  const host = page.locator(`[data-grid-item-id="${tile}"]`).first();
  await host.scrollIntoViewIfNeeded();
  const firstBar = host.locator('.recharts-bar-rectangle path, .recharts-bar-rectangle').first();
  await expect(firstBar, `tile ${tile}: no bar to click`).toBeVisible({ timeout: 30_000 });
  await firstBar.click({ force: true });
}

// canon() stores each row as its own JSON string.
const rowsOf = (t: TileRows, tile: number) =>
  (JSON.parse(t.get(tile)!.rows) as string[]).map((r) => JSON.parse(r) as Record<string, unknown>);

test.beforeAll(async ({ request }) => {
  f = await freshReport(request, async (id, charts) => {
    bar = charts.find((c) => c.type === 'BAR')!.tile;
    pie = charts.find((c) => c.type === 'PIE')!.tile;
    ts = charts.find((c) => c.type === 'TIME_SERIES')!.tile;
    sw.dim = await addSwitcher(request, id, { paramName: 'dim', label: 'Group by', default: 'channel',
      options: [{ label: 'Region', value: 'region' }, { label: 'Channel', value: 'channel' }] }, 60);
    sw.met = await addSwitcher(request, id, { paramName: 'met', label: 'Measure', default: 'revenue',
      options: [{ label: 'Revenue', value: 'revenue' }, { label: 'Orders', value: 'orders' }] }, 63);
    await bindWhatIf(request, id, bar, [{ param: 'dim', role: 'dimension' }]);
    await bindWhatIf(request, id, pie, [{ param: 'met', role: 'metric' }]);
  });
  // The exact Region field of this report — the identity an external backend
  // sends (qualified semanticField + its dataset), taken from the report itself.
  const dash = await (await request.get(`${DASH}/${f.id}`)).json();
  const slicer = ((dash.slicers_config ?? []) as any[]).find((s) => /(^|\.)region$/i.test(String(s.semanticField ?? s.field ?? '')));
  expect(slicer, 'the fixture report has no Region slicer to take the field identity from').toBeTruthy();
  region = { field: 'region', semanticField: String(slicer.semanticField), datasetId: Number(slicer.datasetId) };
  // The normal public runtime under the SAME effective constraint: a link locked
  // to North through the ordinary Public Links API.
  const link = await request.post(`${DASH}/${f.id}/public-links`, { data: { name: 'north reference', filters_config: [NORTH()] } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  northD = `/d/${(await link.json()).token}`;
  embPath = await mintFiltered(request, f.id);
});

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('a North-locked API embed shows every tile with exactly the North numbers (= /d locked to North = the Builder query)', async ({ page, request }) => {
  const tiles = f!.charts.map((c) => c.tile);
  const full = await openSurface(page, f!, 'd', tiles);
  const reference = await openSurface(page, { ...f!, token: northD.replace('/d/', '') }, 'd', tiles);
  const emb = await openSurface(page, { ...f!, emb: embPath }, 'emb', tiles);

  expectSameTiles(reference, emb, tiles, 'emb_ North', 'API lock region in [North]');
  // The scope is real: the headline numbers are not the full report's.
  const kpi = f!.charts.find((c) => c.type === 'KPI')!.tile;
  expect(emb.get(kpi)!.rows, 'the North-locked embed shows the full report').not.toBe(full.get(kpi)!.rows);

  // And the Builder's own data path agrees for every tile without a parameter binding.
  for (const c of f!.charts.filter((x) => x.tile !== bar && x.tile !== pie)) {
    const res = await request.get(`${V1}/charts/${c.chart}/data`, { params: { filters: JSON.stringify([NORTH()]) } });
    expect(res.status(), await res.text()).toBe(200);
    expect(emb.get(c.tile)!.rows, `emb_ tile ${c.tile} (${c.name}) differs from the Builder query with region = North`)
      .toBe(canon((await res.json()).data));
  }
});

test('inside the lock: what-if, cross-filter and date drill work and never escape North; a viewer cannot widen it', async ({ page, request }) => {
  const tiles = f!.charts.map((c) => c.tile);
  const kpi = f!.charts.find((c) => c.type === 'KPI')!;
  const surfaces = [['d North', northD], ['emb_ North', embPath]] as const;
  const seen: Record<string, Record<string, TileRows>> = {};
  for (const [name, url] of surfaces) {
    const steps: Record<string, TileRows> = {};
    await page.goto(url);
    await settle(page);
    // What-if: group the BAR by region, measure the PIE by orders.
    steps.whatif = await reread(page, tiles, `${name} what-if`, async () => {
      await chooseParam(page, sw.dim, 'region');
      await chooseParam(page, sw.met, 'orders');
    });
    // Cross-filter from the BAR (now one bar per region — under the lock, North only).
    steps.cross = await reread(page, tiles.filter((t) => t !== bar), `${name} cross-filter`, () => clickFirstBar(page, bar));
    await page.waitForTimeout(400);
    await clickFirstBar(page, bar); // clear
    // Date drill to quarter.
    const host = page.locator(`[data-grid-item-id="${ts}"]`).first();
    await host.scrollIntoViewIfNeeded();
    const enable = host.getByRole('button', { name: /group by time|nhóm theo thời gian/i });
    if (await enable.count()) await enable.first().click();
    await expect(host.locator('button[title="quarter"]').first(), `${name}: no date drill control`).toBeVisible({ timeout: 30_000 });
    const drill = collectTiles(page);
    await host.locator('button[title="quarter"]').first().click({ timeout: 30_000 });
    await waitForTiles(drill, [ts], `${name} drill quarter`);
    steps.drill = freeze(drill);
    seen[name] = steps;
  }
  const [d, e] = [seen['d North'], seen['emb_ North']];
  expectSameTiles(d.whatif, e.whatif, tiles, 'emb_ North', 'what-if dim=region, met=orders');
  expectSameTiles(d.cross, e.cross, tiles.filter((t) => t !== bar), 'emb_ North', 'cross-filter from the region bar');
  expectSameTiles(d.drill, e.drill, [ts], 'emb_ North', 'drill to quarter');

  // Never escapes North: grouped by region, the BAR has the North row only…
  const regions = new Set(rowsOf(e.whatif, bar).map((r) => String(Object.values(r).find((v) => typeof v === 'string'))));
  expect([...regions], 'the embed grouped by region shows regions outside the lock').toEqual(['North']);
  // …and the quarters add up to the North revenue, not the report's.
  const northRevenue = Number(Object.values(rowsOf(e.whatif, kpi.tile)[0])[0]);
  const quarterSum = rowsOf(e.drill, ts).reduce((s, r) => s + Number(Object.values(r).find((v) => typeof v === 'number') ?? 0), 0);
  expect(Math.round(quarterSum), 'the drilled time series is not the North revenue').toBe(Math.round(northRevenue));

  // A viewer cannot widen the lock: ask the embed's own batch endpoint for South.
  const token = embPath.replace('/embed/', '');
  const res = await request.post(`${V1}/public/dashboards/${token}/charts/data`, {
    data: { items: [{ chart_id: kpi.chart, tile_id: kpi.tile,
      filters: [{ field: 'region', semanticField: region!.semanticField, datasetId: region!.datasetId, operator: 'in', value: ['South', 'Central'] }] }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const answered = (await res.json()).results?.[0];
  expect(canon(answered?.data?.data), 'a viewer filter on the locked field changed the North-locked embed (the lock must replace it, as on /d)').toBe(e.whatif.get(kpi.tile)!.rows);
});

test('the embed serves the PUBLISHED report: a draft tile added after publishing is not in a freshly minted emb_', async ({ page, request }) => {
  const kpiChart = f!.charts.find((c) => c.type === 'KPI')!.chart;
  // Added as the Builder's "Add" does it: a draft change (draftOnly), which the
  // report's public surfaces get on Publish. (An API add without the flag is a
  // live edit, published at once — not a draft.)
  const draftTile = await addChartTile(request, f!.id, kpiChart, { x: 0, y: 90, w: 12, h: 6, draftOnly: true } as any);
  const authed = await (await request.get(`${DASH}/${f!.id}`)).json();
  expect((authed.dashboard_charts as any[]).some((dc) => dc.id === draftTile), 'the draft tile was not added').toBe(true);
  const fresh = await mintFiltered(request, f!.id);
  const rows = collectTiles(page);
  await page.goto(fresh);
  await settle(page);
  await waitForTiles(rows, [f!.charts[0].tile], 'fresh emb_');
  const ids = await page.$$eval('[data-grid-item-id]', (els) => els.map((el) => Number(el.getAttribute('data-grid-item-id'))));
  expect(ids, 'a freshly minted emb_ shows an unpublished draft tile').not.toContain(draftTile);
  expect(freeze(rows).has(draftTile), 'a freshly minted emb_ fetched data for an unpublished draft tile').toBe(false);
  for (const c of f!.charts) expect(ids, `published tile ${c.tile} missing from the emb_`).toContain(c.tile);
});
