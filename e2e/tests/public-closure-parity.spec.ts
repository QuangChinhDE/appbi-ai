import { expect, test, type Page } from '@playwright/test';
import {
  addChartTile, addSwitcher, bindWhatIf, chooseParam, collectTiles, dropReport, expectSameTiles, freeze,
  freshReport, openSurface, PUBLIC_SURFACES, settle, surfaceUrl, V1, waitForTiles, type Fixture, type TileRows,
} from './_public-closure';

/**
 * Dashboard Public closure — DATA parity, tile by tile, on all four surfaces:
 * the Builder, /d/<token>, /embed/<token> and an integration /embed/emb_<grant>
 * minted with a real PAT. Same published report, same parameter state → same
 * rows for every TILE (a chart placed twice keeps two answers).
 *
 * The report carries every parameter kind the Builder can publish:
 *   region  — field-bound switcher (default South)
 *   dim     — what-if DIMENSION switcher bound to the BAR tile (default channel)
 *   met     — what-if MEASURE switcher bound to the PIE tile (default revenue)
 * plus a TWIN: the BAR chart placed a second time, unbound — so the same chart
 * shows two different results on one page.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
let sw = { region: 0, dim: 0, met: 0 };
let twin = 0;
let bar = 0;
let pie = 0;

async function switchAll(page: Page, values: { region: string; dim: string; met: string }) {
  await chooseParam(page, sw.region, values.region);
  await chooseParam(page, sw.dim, values.dim);
  await chooseParam(page, sw.met, values.met);
}

/** Re-read every tile after an interaction (lazy tiles fetch once back in view). */
async function reread(page: Page, scope: string, tiles: number[], label: string, act: () => Promise<void>): Promise<TileRows> {
  // The collector starts BEFORE the interaction, so every request it causes is
  // recorded in the order it was sent (the latest one wins, like the page).
  const rows = collectTiles(page);
  await act();
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, scope);
  await waitForTiles(rows, tiles, label);
  return freeze(rows);
}

test.beforeAll(async ({ request }) => {
  f = await freshReport(request, async (id, charts) => {
    bar = charts.find((c) => c.type === 'BAR')!.tile;
    pie = charts.find((c) => c.type === 'PIE')!.tile;
    sw.region = await addSwitcher(request, id, { paramName: 'region', label: 'Region', field: 'region', default: 'South',
      options: ['North', 'South', 'Central'].map((v) => ({ label: v, value: v })) }, 60);
    sw.dim = await addSwitcher(request, id, { paramName: 'dim', label: 'Group by', default: 'channel',
      options: [{ label: 'Region', value: 'region' }, { label: 'Channel', value: 'channel' }] }, 63);
    sw.met = await addSwitcher(request, id, { paramName: 'met', label: 'Measure', default: 'revenue',
      options: [{ label: 'Revenue', value: 'revenue' }, { label: 'Orders', value: 'orders' }] }, 66);
    await bindWhatIf(request, id, bar, [{ param: 'dim', role: 'dimension' }]);
    await bindWhatIf(request, id, pie, [{ param: 'met', role: 'metric' }]);
    twin = await addChartTile(request, id, charts.find((c) => c.type === 'BAR')!.chart, { x: 18, y: 69, w: 18, h: 12 });
  });
});

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
});

test('default state: every tile — twin included — has the Builder\'s numbers on /d, /embed and emb_', async ({ page }) => {
  const tiles = f!.charts.map((c) => c.tile);
  expect(tiles, 'fixture: the twin tile is missing').toContain(twin);
  const builder = await openSurface(page, f!, 'builder', tiles);

  // The fixture is only a gate if its states really differ.
  expect(builder.get(bar)!.rows, 'twin: the bound BAR and its unbound twin must differ (channel vs region)').not.toBe(builder.get(twin)!.rows);
  expect(JSON.parse(builder.get(bar)!.rows).length, 'what-if default (channel) regroups the BAR').toBe(2);
  expect(JSON.parse(builder.get(twin)!.rows).length, 'field default (South) filters the unbound twin to one region').toBe(1);

  for (const s of PUBLIC_SURFACES) {
    const rows = await openSurface(page, f!, s, tiles);
    expectSameTiles(builder, rows, tiles, s, 'region=South dim=channel met=revenue (defaults)');
  }
});

test('switched through the Builder UI, then the same switches through each public UI: same numbers per tile', async ({ page }) => {
  const tiles = f!.charts.map((c) => c.tile);
  const before = await openSurface(page, f!, 'builder', tiles);
  const builder = await reread(page, '[data-dashboard-canvas-root]', tiles, 'builder switched',
    () => switchAll(page, { region: 'North', dim: 'region', met: 'orders' }));

  // Each switch really changed what the tiles answer.
  const kpi = f!.charts.find((c) => c.type === 'KPI')!.tile;
  expect(builder.get(kpi)!.rows, 'field switch (South→North) must change the KPI').not.toBe(before.get(kpi)!.rows);
  expect(builder.get(bar)!.rows, 'what-if dimension (channel→region) must change the BAR').not.toBe(before.get(bar)!.rows);
  expect(builder.get(pie)!.rows, 'what-if measure (revenue→orders) must change the PIE').not.toBe(before.get(pie)!.rows);
  expect(JSON.parse(builder.get(bar)!.rows).length, 'North filter + group by region = one bar').toBe(1);

  for (const s of PUBLIC_SURFACES) {
    await openSurface(page, f!, s, tiles);
    const rows = await reread(page, 'body', tiles, `${s} switched`,
      () => switchAll(page, { region: 'North', dim: 'region', met: 'orders' }));
    expectSameTiles(builder, rows, tiles, s, 'region=North dim=region met=orders (switched in the UI)');
  }
});

test('combined state reached in a different order still agrees (field + both what-ifs)', async ({ page }) => {
  const tiles = f!.charts.map((c) => c.tile);
  await openSurface(page, f!, 'builder', tiles);
  const builder = await reread(page, '[data-dashboard-canvas-root]', tiles, 'builder combined', async () => {
    await chooseParam(page, sw.met, 'orders');
    await chooseParam(page, sw.region, 'Central');
  });
  for (const s of PUBLIC_SURFACES) {
    await openSurface(page, f!, s, tiles);
    const rows = await reread(page, 'body', tiles, `${s} combined`, async () => {
      await chooseParam(page, sw.region, 'Central');
      await chooseParam(page, sw.met, 'orders');
    });
    expectSameTiles(builder, rows, tiles, s, 'region=Central dim=channel met=orders');
  }
});

test('the twin keeps its own answer on every surface (no chart-level dedupe)', async ({ page, request }) => {
  // Directly at the boundary that once deduped by chart id: both tiles of one
  // chart in ONE batch must come back as two different answers.
  const res = await request.post(`${V1}/public/dashboards/${f!.token}/charts/data`, {
    data: { items: [
      { chart_id: f!.charts.find((c) => c.tile === bar)!.chart, tile_id: bar, overrides: { dimension: 'channel' } },
      { chart_id: f!.charts.find((c) => c.tile === twin)!.chart, tile_id: twin },
    ] },
  });
  const results = (await res.json()).results as any[];
  expect(results.map((r) => r.tile_id).sort()).toEqual([bar, twin].sort());
  const a = results.find((r) => r.tile_id === bar).data.data;
  const b = results.find((r) => r.tile_id === twin).data.data;
  expect(JSON.stringify(a), 'the two tiles of one chart collapsed into one answer').not.toBe(JSON.stringify(b));
  // And in the browser, on the integration embed too.
  const rows = await openSurface(page, f!, 'emb', [bar, twin]);
  expect(rows.get(bar)!.rows).not.toBe(rows.get(twin)!.rows);
  expect(page.url()).toContain(surfaceUrl(f!, 'emb'));
});

test('a forged switcher value is refused by the server for that tile, not silently widened', async ({ request }) => {
  const res = await request.post(`${V1}/public/dashboards/${f!.token}/charts/data`, {
    data: { items: [{ chart_id: f!.charts.find((c) => c.tile === twin)!.chart, tile_id: twin,
      filters: [{ id: 'param-region', field: 'region', operator: 'in', value: ['Atlantis'] }] }] },
  });
  const result = (await res.json()).results[0];
  expect(result.status, JSON.stringify(result)).toBe(400);
  expect(result.data, 'a value no switcher offers must not return data').toBeFalsy();
});
