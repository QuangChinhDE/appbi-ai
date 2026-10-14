import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  collectTiles, DASH, dataQuiet, dropReport, expectSameTiles, freeze, freshReport, openSurface, PUBLIC_SURFACES,
  settle, waitForTiles, deleteTestPats, type Fixture, type Surface, type TileRows,
} from './_public-closure';

/**
 * Dashboard Public closure — INTERACTION parity on the Builder, /d, /embed and
 * an integration emb_ grant. Contract (spec §5): a click on a data point makes
 * the SOURCE tile dim its other marks (its own query unchanged) and every OTHER
 * tile FILTER to that value; clicking the same mark again clears; a tile with
 * `layout.highlightEnabled === false` neither emits nor receives. Date drill
 * re-buckets the time axis server-side; `layout.lockDateGrain` removes the
 * control. The data each tile is answered with is compared, not CSS.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
let bar = 0;
let pie = 0;
let ts = 0;

async function patchLayout(request: APIRequestContext, id: number, tile: number, extra: Record<string, unknown>) {
  const dash = await (await request.get(`${DASH}/${id}`)).json();
  const dc = (dash.dashboard_charts as any[]).find((d) => d.id === tile);
  const res = await request.put(`${DASH}/${id}/layout`, { data: { chart_layouts: [{ id: tile, layout: { ...dc.layout, ...extra } }] } });
  expect(res.status(), await res.text()).toBeLessThan(400);
}

const scopeOf = (s: Surface) => (s === 'builder' ? '[data-dashboard-canvas-root]' : 'body');

/** Click the first bar of a tile's bar chart (same category on every surface: same data, same order). */
async function clickFirstBar(page: Page, scope: string, tile: number) {
  const host = page.locator(`${scope} [data-grid-item-id="${tile}"]`).first();
  await host.scrollIntoViewIfNeeded();
  const firstBar = host.locator('.recharts-bar-rectangle path, .recharts-bar-rectangle').first();
  await expect(firstBar, `tile ${tile}: no bar to click`).toBeVisible({ timeout: 30_000 });
  await firstBar.click({ force: true });
}

/** Clicking the selected bar again clears the selection (same rule on every surface). */
async function clearByToggle(page: Page, scope: string, tile: number) {
  await page.waitForTimeout(400); // past the 300ms double-click guard of the selection handler
  await clickFirstBar(page, scope, tile);
}

async function rereadAfter(page: Page, s: Surface, tiles: number[], label: string, act: () => Promise<void>): Promise<TileRows> {
  const rows = collectTiles(page);
  await act();
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, scopeOf(s));
  await waitForTiles(rows, tiles, label);
  return freeze(rows);
}

test.beforeAll(async ({ request }) => {
  f = await freshReport(request, async (id, charts) => {
    bar = charts.find((c) => c.type === 'BAR')!.tile;
    pie = charts.find((c) => c.type === 'PIE')!.tile;
    ts = charts.find((c) => c.type === 'TIME_SERIES')!.tile;
  });
});

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('cross-filter: a bar click filters every other tile to the same numbers on all surfaces; clearing restores them', async ({ page }) => {
  const tiles = f!.charts.map((c) => c.tile);
  const targets = tiles.filter((t) => t !== bar);
  const baseline = await openSurface(page, f!, 'builder', tiles);
  // The KPI tiles' headline numbers, as the author reads them.
  const kpis = f!.charts.filter((c) => c.type === 'KPI').map((c) => c.tile);
  const headline = async (tile: number) => {
    const text = await page.locator(`${scopeOf('builder')} [data-grid-item-id="${tile}"]`).first().innerText();
    return (text.match(/\$?\d[\d.,]*\s?[KMB]?/) || [''])[0];
  };
  const baselineHeadline = new Map<number, string>();
  for (const k of kpis) baselineHeadline.set(k, await headline(k));
  const selected = await rereadAfter(page, 'builder', targets, 'builder select', () => clickFirstBar(page, scopeOf('builder'), bar));
  for (const t of targets) {
    expect(selected.get(t)!.rows, `builder: target tile ${t} did not react to the selection`).not.toBe(baseline.get(t)!.rows);
  }
  // Clearing in the Builder serves each tile's baseline from its own query
  // cache (the same query key as before the click) — no new request — so the
  // check is on what the tiles SHOW: every KPI headline is back to its baseline.
  await clearByToggle(page, scopeOf('builder'), bar);
  for (const k of kpis) {
    await expect.poll(() => headline(k), { message: `builder: KPI tile ${k} did not return to its baseline after clearing`, timeout: 30_000 })
      .toBe(baselineHeadline.get(k));
  }

  for (const s of PUBLIC_SURFACES) {
    await openSurface(page, f!, s, tiles);
    const rows = await rereadAfter(page, s, targets, `${s} select`, () => clickFirstBar(page, scopeOf(s), bar));
    expectSameTiles(selected, rows, targets, s, 'first bar of the region chart selected');
    const back = await rereadAfter(page, s, targets, `${s} clear`, () => clearByToggle(page, scopeOf(s), bar));
    expectSameTiles(baseline, back, targets, s, 'selection cleared');
  }
});

test('highlight opt-out: a tile with highlightEnabled=false neither filters nor is filtered, on every surface', async ({ page, request }) => {
  await patchLayout(request, f!.id, pie, { highlightEnabled: false });
  await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
  const tiles = f!.charts.map((c) => c.tile);
  for (const s of ['builder', ...PUBLIC_SURFACES] as Surface[]) {
    const baseline = await openSurface(page, f!, s, tiles);
    const reacting = tiles.filter((t) => t !== bar && t !== pie);
    const rows = await rereadAfter(page, s, reacting, `${s} opt-out`, () => clickFirstBar(page, scopeOf(s), bar));
    // The opted-out PIE either was not re-asked at all (its query did not
    // change) or was answered with exactly its baseline — never filtered.
    if (rows.has(pie)) {
      expect(rows.get(pie)!.rows, `${s}: the opted-out PIE was filtered by the selection`).toBe(baseline.get(pie)!.rows);
    }
    const kpi = f!.charts.find((c) => c.type === 'KPI')!.tile;
    expect(rows.get(kpi)!.rows, `${s}: the other tiles stopped reacting`).not.toBe(baseline.get(kpi)!.rows);
  }
  await patchLayout(request, f!.id, pie, { highlightEnabled: true });
  await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
});

test('highlight opt-out: a tile with highlightEnabled=false cannot be a SOURCE — clicking it leaves every other tile at its baseline, on every surface', async ({ page, request }) => {
  // The same BAR that, opted in, filters every other tile (cross-filter test above).
  await patchLayout(request, f!.id, bar, { highlightEnabled: false });
  const pub = await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
  expect(pub.status(), await pub.text()).toBeLessThan(400);
  try {
    const tiles = f!.charts.map((c) => c.tile);
    const targets = tiles.filter((t) => t !== bar);
    const kpis = f!.charts.filter((c) => c.type === 'KPI').map((c) => c.tile);
    for (const s of ['builder', ...PUBLIC_SURFACES] as Surface[]) {
      const baseline = await openSurface(page, f!, s, tiles);
      const headline = async (tile: number) => (await page.locator(`${scopeOf(s)} [data-grid-item-id="${tile}"]`).first().innerText())
        .match(/\$?\d[\d.,]*\s?[KMB]?/)?.[0] ?? '';
      const before = await Promise.all(kpis.map(headline));
      const after = collectTiles(page);
      await clickFirstBar(page, scopeOf(s), bar);
      // An emitted selection re-asks every target with a filter (the cross-filter
      // test proves this same click does so when the tile is opted in). Wait past
      // the selection handler's guard and for the network to go quiet.
      await page.waitForTimeout(400);
      await dataQuiet(page);
      const rows = freeze(after);
      for (const t of targets) {
        if (rows.has(t)) {
          expect(rows.get(t)!.rows, `${s}: clicking the opted-out BAR changed the data of tile ${t}`).toBe(baseline.get(t)!.rows);
        }
      }
      // What the reader sees is unchanged too.
      expect(await Promise.all(kpis.map(headline)), `${s}: clicking the opted-out BAR changed a KPI`).toEqual(before);
    }
  } finally {
    await patchLayout(request, f!.id, bar, { highlightEnabled: true });
    await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
  }
});

test('date drill: re-bucketing the time series gives the same rows on all surfaces', async ({ page }) => {
  const drill = async (s: Surface, level: string): Promise<TileRows> => {
    const scope = scopeOf(s);
    const host = page.locator(`${scope} [data-grid-item-id="${ts}"]`).first();
    await host.scrollIntoViewIfNeeded();
    const enable = host.getByRole('button', { name: /group by time|nhóm theo thời gian/i });
    if (await enable.count()) {
      await enable.first().click();
      // Enabling drill in the Builder edits the chart's style (autosaved): let
      // that re-render and its query settle before choosing a level.
      await dataQuiet(page);
    }
    const rows = collectTiles(page);
    const levelButton = host.locator(`button[title="${level}"]`).first();
    await expect(levelButton).toBeVisible();
    await dataQuiet(page);
    await levelButton.click({ timeout: 30_000 });
    await waitForTiles(rows, [ts], `${s} drill ${level}`);
    return freeze(rows);
  };
  // The Builder's READ canvas (?studio=preview — the Builder route with editing
  // off, what Studio frames): there drill is the viewer's, as on public. In the
  // edit canvas the same control edits the chart's saved default grain instead.
  const rows0 = collectTiles(page);
  await page.goto(`/dashboards/${f!.id}?studio=preview`);
  await settle(page, scopeOf('builder'));
  await waitForTiles(rows0, [ts], 'builder read canvas');
  freeze(rows0);
  const quarter = await drill('builder', 'quarter');
  expect(JSON.parse(quarter.get(ts)!.rows).length, 'quarter grain: 24 months = 8 quarters').toBe(8);
  const year = await drill('builder', 'year');
  expect(JSON.parse(year.get(ts)!.rows).length, 'year grain: 2 years').toBe(2);
  for (const s of PUBLIC_SURFACES) {
    await openSurface(page, f!, s, [ts]);
    expectSameTiles(quarter, await drill(s, 'quarter'), [ts], s, 'drill to quarter');
    expectSameTiles(year, await drill(s, 'year'), [ts], s, 'drill to year');
  }
});

test('lockDateGrain removes the drill control on every public surface', async ({ page, request }) => {
  await patchLayout(request, f!.id, ts, { lockDateGrain: true });
  await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
  for (const s of PUBLIC_SURFACES) {
    await openSurface(page, f!, s, [ts]);
    const host = page.locator(`[data-grid-item-id="${ts}"]`).first();
    await expect(host.locator('button[title="quarter"]'), `${s}: a locked grain still offers drill`).toHaveCount(0);
    await expect(host.getByRole('button', { name: /group by time/i }), `${s}: a locked grain still offers drill`).toHaveCount(0);
  }
});
