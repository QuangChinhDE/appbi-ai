import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import {
  addChartTile, collectTiles, DASH, deleteTestPats, dropReport, freeze, freshReport, settle, V1, waitForTiles,
  type Fixture,
} from './_public-closure';

/**
 * Device-specific layouts (docs/responsive-dashboard-layouts.md), proven in a
 * real browser on a production build against a real API and Postgres — no
 * route mocking, no skips. Desktop is the authored layout; Tablet/Phone are
 * AUTO (derived) or a page's CUSTOM layout; ONE resolver draws every surface:
 * the Builder canvas and its device modes, the Studio preview, /d, stable
 * /embed and the integration emb_.
 *
 * Every surface publishes what it drew on its report container
 * (`data-report-layout` = the cells, `data-report-width` = the ONE measured
 * width, `data-report-breakpoint`, `data-report-layout-source`). Layouts are
 * compared by TILE id cell by cell — never by chart id, never by screenshot.
 */

test.describe.configure({ mode: 'serial', timeout: 900_000 });

type Cell = { i: string; x: number; y: number; w: number; h: number };
type Drawn = { width: number; breakpoint: string; cols: number; source: string; layout: Cell[] };

const TABLET = 820;
const PHONE = 390;
const byId = (cells: Cell[]) => [...cells].sort((a, b) => Number(a.i) - Number(b.i));
/** Cells in the 36-column authoring grid (the AUTO phone stack is 2-column). */
const in36 = (d: Drawn) => byId(d.layout.map((c) => ({ ...c, x: (c.x * 36) / d.cols, w: (c.w * 36) / d.cols })));
const order = (cells: Cell[]) => [...cells].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.i);

async function readDrawn(page: Page, scope: string): Promise<Drawn | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(`${sel} [data-report-layout]`) as HTMLElement | null;
    if (!el) return null;
    return {
      width: Number(el.dataset.reportWidth),
      breakpoint: String(el.dataset.reportBreakpoint),
      cols: Number(el.dataset.reportCols),
      source: String(el.dataset.reportLayoutSource),
      layout: JSON.parse(el.dataset.reportLayout || '[]'),
    };
  }, scope);
}

/** What a surface drew once it has settled: the same value read twice, 1.2 s
 *  apart (AUTO content fit measures at 120 / 1200 / 3500 ms). */
async function stableDrawn(page: Page, scope = 'body'): Promise<Drawn> {
  let last = '';
  let value: Drawn | null = null;
  await expect.poll(async () => {
    value = await readDrawn(page, scope);
    const key = JSON.stringify(value);
    const same = key === last && value !== null && value.width > 0;
    last = key;
    return same;
  }, { message: `the report on ${page.url()} never settled`, timeout: 45_000, intervals: [1200] }).toBe(true);
  return value!;
}

function checkGeometry(d: Drawn, label: string, tiles: string[]) {
  expect(new Set(d.layout.map((c) => c.i)), `${label}: a published tile is missing or extra`).toEqual(new Set(tiles));
  for (const c of d.layout) {
    expect(c.x >= 0 && c.y >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= d.cols, `${label}: tile ${c.i} off the ${d.cols}-column grid ${JSON.stringify(c)}`).toBe(true);
  }
  const s = [...d.layout].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let a = 0; a < s.length; a += 1) for (let b = a + 1; b < s.length; b += 1) {
    const p = s[a]; const q = s[b];
    const hit = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    expect(hit, `${label}: tiles ${p.i} and ${q.i} overlap`).toBe(false);
  }
}

/** Open a public surface so its report container measures exactly `width`. */
async function publicAt(page: Page, url: string, width: number): Promise<Drawn> {
  let viewport = width + 40;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    await page.goto(url);
    await settle(page);
    const d = await stableDrawn(page);
    if (d.width === width) {
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(scroll, `${url} @${width}: horizontal page scroll`).toBeLessThanOrEqual(1);
      return d;
    }
    viewport += width - d.width;
  }
  throw new Error(`${url}: could not make the report container ${width}px wide`);
}

/** The Builder in a device mode (its canvas is that device's width). */
async function builderDevice(page: Page, id: number, mode: 'desktop' | 'tablet' | 'phone', opts: { reload?: boolean } = {}): Promise<Drawn> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  if (opts.reload !== false || !page.url().includes(`/dashboards/${id}`)) {
    await page.goto(`/dashboards/${id}`);
    await settle(page, '[data-dashboard-canvas-root]');
  }
  await page.getByTestId(`device-mode-${mode}`).click();
  const want = mode === 'desktop' ? 'lg' : mode === 'tablet' ? 'md' : 'xs';
  await expect.poll(async () => (await readDrawn(page, '[data-dashboard-canvas-root]'))?.breakpoint, { message: `builder never reached ${mode}` }).toBe(want);
  await settle(page, '[data-dashboard-canvas-root]');
  return stableDrawn(page, '[data-dashboard-canvas-root]');
}

async function saveDraft(page: Page) {
  await page.getByTestId('dashboard-save-draft').click();
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
}

async function publish(page: Page) {
  await page.getByTestId('dashboard-publish').click();
  await expect(page.getByTestId('dashboard-publish')).toHaveCount(0, { timeout: 30_000 });
}

/** Drag a tile's RGL resize handle (south-east) by a pixel delta. */
async function resizeBy(page: Page, tile: string, dx: number, dy: number) {
  // react-grid-layout clones the tile element itself into the grid item.
  const handle = page.locator(`[data-dashboard-canvas-root] [data-grid-item-id="${tile}"] > .react-resizable-handle-se`).first();
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 8; k += 1) await page.mouse.move(box.x + box.width / 2 + (dx * k) / 8, box.y + box.height / 2 + (dy * k) / 8);
  await page.mouse.up();
}

/** Drag a tile by its drag handle by a pixel delta. */
async function dragBy(page: Page, tile: string, dx: number, dy: number) {
  const handle = page.locator(`[data-dashboard-canvas-root] [data-grid-item-id="${tile}"] .drag-handle, [data-dashboard-canvas-root] [data-grid-item-id="${tile}"].drag-handle`).first();
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const sx = box.x + Math.min(40, box.width / 2);
  const sy = box.y + Math.min(12, box.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 12; k += 1) await page.mouse.move(sx + (dx * k) / 12, sy + (dy * k) / 12);
  await page.mouse.up();
}

const surfaces = (f: Fixture) => [['/d', `/d/${f.token}`], ['/embed', `/embed/${f.token}`], ['emb_', f.emb]] as const;

async function editorDoc(request: APIRequestContext, id: number) {
  return (await request.get(`${DASH}/${id}`)).json();
}

let f: Fixture | null = null;
let tiles: string[] = [];
const auto: Record<string, Drawn> = {};
let desktopBefore: Drawn | null = null;
let tabletCustom: Cell[] = [];
let phoneCustom: Cell[] = [];

test.beforeAll(async ({ request }) => {
  f = await freshReport(request);
  const dash = await editorDoc(request, f.id);
  tiles = (dash.dashboard_charts as any[]).map((dc) => String(dc.id));
});

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('A/B/C — a report without device layouts: Builder, Studio, /d, /embed and emb_ draw the same AUTO layout at 1440, 820 and 390', async ({ page }) => {
  for (const [name, width, bp] of [['desktop', 1440, 'lg'], ['tablet', TABLET, 'md'], ['phone', PHONE, 'xs']] as const) {
    const pub: Record<string, Drawn> = {};
    for (const [label, url] of surfaces(f!)) {
      pub[label] = await publicAt(page, url, width);
      checkGeometry(pub[label], `${label}@${width}`, tiles);
      expect(pub[label].breakpoint, `${label}@${width}`).toBe(bp);
      expect(pub[label].source, `${label}@${width}`).toBe(bp === 'lg' ? 'desktop' : 'auto');
    }
    expect(byId(pub['/embed'].layout), `/embed@${width} differs from /d`).toEqual(byId(pub['/d'].layout));
    expect(byId(pub.emb_.layout), `emb_@${width} differs from /d`).toEqual(byId(pub['/d'].layout));
    if (name !== 'desktop') {
      // The Builder's device mode: its canvas IS that width.
      const b = await builderDevice(page, f!.id, name);
      expect(b.width, `builder ${name} canvas width`).toBe(width);
      expect(b.source).toBe('auto');
      await expect(page.getByTestId('device-status-auto')).toBeVisible();
      expect(byId(b.layout), `builder ${name} differs from /d at the same width`).toEqual(byId(pub['/d'].layout));
      expect(order(b.layout)).toEqual(order(pub['/d'].layout));
    } else {
      const b = await builderDevice(page, f!.id, 'desktop');
      expect(byId(b.layout), 'builder desktop differs from /d').toEqual(byId(pub['/d'].layout));
      desktopBefore = pub['/d'];
    }
    // Studio preview frame (read-only, same route): compared with /d at ITS container width.
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/dashboards/${f!.id}?studio=preview&frame=a`);
    await settle(page, '[data-dashboard-canvas-root]');
    const studio = await stableDrawn(page, '[data-dashboard-canvas-root]');
    const same = await publicAt(page, `/d/${f!.token}`, studio.width);
    expect(studio.breakpoint).toBe(same.breakpoint);
    expect(byId(studio.layout), `Studio @${studio.width}px differs from /d at the same width`).toEqual(byId(same.layout));
    auto[name] = pub['/d'];
  }
});

test('N — switching Desktop → Tablet → Phone never re-requests chart data; rows are identical', async ({ page }) => {
  // Public: a loaded report resized across both breakpoints.
  await publicAt(page, `/d/${f!.token}`, 1440);
  const rows1440 = collectTiles(page);
  await page.reload();
  await settle(page);
  await waitForTiles(rows1440, f!.charts.map((c) => c.tile), '/d 1440');
  const baseline = freeze(rows1440);
  const sent: string[] = [];
  const onReq = (r: Request) => { if (/\/charts\/(\d+\/)?data/.test(r.url())) sent.push(r.url()); };
  page.on('request', onReq);
  for (const w of [TABLET + 40, PHONE + 40, 1480]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await stableDrawn(page);
  }
  page.off('request', onReq);
  expect(sent, 'resizing across devices re-requested chart data').toEqual([]);
  expect(baseline.size).toBeGreaterThan(0);
  // Builder device switch on a loaded canvas.
  await builderDevice(page, f!.id, 'desktop');
  const builderSent: string[] = [];
  const onB = (r: Request) => { if (/\/charts\/(\d+\/)?data/.test(r.url())) builderSent.push(r.url()); };
  await settle(page, '[data-dashboard-canvas-root]');
  page.on('request', onB);
  for (const m of ['tablet', 'phone', 'desktop'] as const) await builderDevice(page, f!.id, m, { reload: false });
  page.off('request', onB);
  expect(builderSent, 'switching the Builder device re-requested chart data').toEqual([]);
});

test('D/P — Customize Tablet: no jump, edit, Save draft, reload keeps it, public stays published until Publish, then every surface draws it', async ({ page }) => {
  const before = await builderDevice(page, f!.id, 'tablet');
  await page.getByTestId('device-customize').click();
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  const frozen = await stableDrawn(page, '[data-dashboard-canvas-root]');
  expect(frozen.source).toBe('custom');
  expect(byId(frozen.layout), 'Customize moved tiles').toEqual(byId(before.layout));

  // Edit: narrow the first KPI, push the last tile down, make it taller.
  const firstKpi = String(f!.tile('KPI'));
  const bottom = order(frozen.layout).at(-1)!;
  const colPx = TABLET / 36;
  await resizeBy(page, firstKpi, -3 * colPx, 0);
  await dragBy(page, bottom, 0, 4 * 32);
  await resizeBy(page, bottom, 0, 3 * 32);
  const edited = await stableDrawn(page, '[data-dashboard-canvas-root]');
  const cell = (d: Cell[], id: string) => d.find((c) => c.i === id)!;
  expect(cell(edited.layout, firstKpi).w, 'resize did not narrow the KPI').toBeLessThan(cell(frozen.layout, firstKpi).w);
  expect(cell(edited.layout, bottom).y, 'drag did not move the tile down').toBeGreaterThan(cell(frozen.layout, bottom).y);
  expect(cell(edited.layout, bottom).h, 'resize did not grow the tile').toBeGreaterThan(cell(frozen.layout, bottom).h);
  checkGeometry({ ...edited, cols: 36 }, 'builder tablet custom', tiles);

  await saveDraft(page);
  // Before Publish: every viewer surface still draws the published (AUTO) tablet.
  for (const [label, url] of surfaces(f!)) {
    const d = await publicAt(page, url, TABLET);
    expect(d.source, `${label} shows an unpublished device layout`).toBe('auto');
    expect(byId(d.layout), `${label} changed before Publish`).toEqual(byId(auto.tablet.layout));
  }
  // Reload: the saved draft is still the author's.
  const reloaded = await builderDevice(page, f!.id, 'tablet');
  expect(reloaded.source).toBe('custom');
  expect(byId(reloaded.layout), 'the saved device draft did not survive a reload').toEqual(byId(edited.layout));

  await publish(page);
  for (const [label, url] of surfaces(f!)) {
    const d = await publicAt(page, url, TABLET);
    expect(d.source, `${label} after Publish`).toBe('custom');
    expect(byId(d.layout), `${label} does not draw the published tablet layout`).toEqual(byId(edited.layout));
    checkGeometry(d, `${label} tablet custom`, tiles);
  }
  // Another tablet width in the band draws the SAME stored cells.
  const d900 = await publicAt(page, `/d/${f!.token}`, 900);
  expect(byId(d900.layout), 'a custom layout changed with the width inside its band').toEqual(byId(edited.layout));
  tabletCustom = edited.layout;
});

test('E — the tablet edit moved nothing on desktop or the phone, and no data changed', async ({ page }) => {
  const desk = await publicAt(page, `/d/${f!.token}`, 1440);
  expect(byId(desk.layout), 'a tablet edit moved desktop').toEqual(byId(desktopBefore!.layout));
  const phone = await publicAt(page, `/d/${f!.token}`, PHONE);
  expect(phone.source).toBe('auto');
  expect(byId(phone.layout), 'a tablet edit moved the phone').toEqual(byId(auto.phone.layout));
  // Same business rows at both widths (tile-keyed).
  const at = async (w: number) => {
    await page.setViewportSize({ width: w, height: 1000 });
    const rows = collectTiles(page);
    await page.goto(`/d/${f!.token}`);
    await settle(page);
    const chartTiles = f!.charts.map((c) => c.tile);
    await waitForTiles(rows, chartTiles, `/d@${w}`);
    return freeze(rows);
  };
  const wide = await at(1480);
  const narrow = await at(TABLET + 40);
  for (const c of f!.charts) expect(narrow.get(c.tile)?.rows, `tile ${c.tile} rows differ on tablet`).toBe(wide.get(c.tile)?.rows);
});

test('F — Customize Phone independently: tablet and desktop stay as they are', async ({ page }) => {
  const before = await builderDevice(page, f!.id, 'phone');
  await page.getByTestId('device-customize').click();
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  const frozen = await stableDrawn(page, '[data-dashboard-canvas-root]');
  expect(frozen.cols).toBe(36);
  // The same cells in the 36-column grid: what is drawn did not move.
  expect(in36(frozen), 'Customize moved phone tiles').toEqual(in36(before));
  const last = order(frozen.layout).at(-1)!;
  await resizeBy(page, last, 0, 3 * 32);
  const edited = await stableDrawn(page, '[data-dashboard-canvas-root]');
  expect(edited.layout.find((c) => c.i === last)!.h).toBeGreaterThan(frozen.layout.find((c) => c.i === last)!.h);
  await saveDraft(page);
  await publish(page);
  for (const [label, url] of surfaces(f!)) {
    const d = await publicAt(page, url, PHONE);
    expect(d.source, label).toBe('custom');
    expect(byId(d.layout), `${label} phone`).toEqual(byId(edited.layout));
  }
  expect(byId((await publicAt(page, `/d/${f!.token}`, TABLET)).layout), 'the phone edit moved the tablet').toEqual(byId(tabletCustom));
  expect(byId((await publicAt(page, `/d/${f!.token}`, 1440)).layout), 'the phone edit moved desktop').toEqual(byId(desktopBefore!.layout));
  phoneCustom = edited.layout;
});

test('M — at the real breakpoint edges the published profile of that band is drawn: 639 phone, 640 and 1023 tablet, 1024 desktop', async ({ page }) => {
  const at = async (w: number) => publicAt(page, `/d/${f!.token}`, w);
  const p639 = await at(639);
  expect([p639.breakpoint, p639.source]).toEqual(['xs', 'custom']);
  expect(byId(p639.layout)).toEqual(byId(phoneCustom));
  for (const w of [640, 1023]) {
    const d = await at(w);
    expect([d.breakpoint, d.source], `@${w}`).toEqual(['md', 'custom']);
    expect(byId(d.layout), `@${w}`).toEqual(byId(tabletCustom));
  }
  const d1024 = await at(1024);
  expect([d1024.breakpoint, d1024.source]).toEqual(['lg', 'desktop']);
});

test('Q — the Studio preview cannot change anything: drag, resize and Ctrl+S send no write', async ({ page }) => {
  await page.setViewportSize({ width: TABLET, height: 1000 });
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && /\/dashboards\b/.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
  await page.goto(`/dashboards/${f!.id}?studio=preview&frame=q`);
  await settle(page, '[data-dashboard-canvas-root]');
  const before = await stableDrawn(page, '[data-dashboard-canvas-root]');
  const target = order(before.layout)[0];
  const item = page.locator(`[data-dashboard-canvas-root] [data-grid-item-id="${target}"]`).first();
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 200, { steps: 10 });
  await page.mouse.up();
  // react-grid-layout keeps hidden handle nodes on a non-resizable item: none may be usable.
  await expect(page.locator('[data-dashboard-canvas-root] .react-resizable-handle:visible')).toHaveCount(0);
  await expect(page.locator('[data-dashboard-canvas-root] .react-grid-item.react-draggable')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  const after = await stableDrawn(page, '[data-dashboard-canvas-root]');
  expect(byId(after.layout), 'the Studio preview moved a tile').toEqual(byId(before.layout));
  expect(writes, 'the Studio preview sent a write').toEqual([]);
});

test('I/J — a new tile is placed below a custom layout (no move, no overlap, needs review → Add below); a deleted tile leaves no ghost', async ({ page, request }) => {
  // Added on desktop the way the Builder adds it (a draft tile), then published.
  const kpiChart = f!.charts.find((c) => c.type === 'KPI')!.chart;
  const added = String(await addChartTile(request, f!.id, kpiChart, { x: 0, y: 200, w: 12, h: 6, draftOnly: true } as any));
  expect((await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } })).status()).toBe(200);
  const withNew = [...tiles, added];
  const d = await publicAt(page, `/d/${f!.token}`, TABLET);
  checkGeometry(d, '/d tablet with a new tile', withNew);
  const customBottom = Math.max(...tabletCustom.map((c) => c.y + c.h));
  expect(d.layout.find((c) => c.i === added)!.y, 'the new tile is not below the custom layout').toBeGreaterThanOrEqual(customBottom);
  for (const c of tabletCustom) expect(d.layout.find((x) => x.i === c.i), `tile ${c.i} moved when a tile was added`).toEqual(c);

  const b = await builderDevice(page, f!.id, 'tablet');
  expect(byId(b.layout)).toEqual(byId(d.layout));
  await expect(page.getByTestId('device-status-needs-review')).toContainText('1');
  await page.getByTestId('device-add-below').click();
  await expect(page.getByTestId('device-status-needs-review')).toHaveCount(0);
  await saveDraft(page);
  await publish(page);
  const doc = await editorDoc(request, f!.id);
  expect(doc.responsive_layouts.pages['page-1'].md.items[added], 'Add below did not place the tile in the layout').toBeTruthy();

  // Delete a published tile (removed in the draft, then published): no ghost,
  // nothing else moves.
  const gone = order(tabletCustom)[1];
  const del = await request.delete(`${DASH}/${f!.id}/charts/${gone}?draft=true`);
  expect(del.status(), await del.text()).toBeLessThan(300);
  expect((await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } })).status()).toBe(200);
  const after = await publicAt(page, `/d/${f!.token}`, TABLET);
  expect(after.layout.some((c) => c.i === gone), 'a deleted tile is still drawn').toBe(false);
  for (const c of after.layout.filter((x) => x.i !== added)) {
    expect(c, `tile ${c.i} reflowed after a deletion`).toEqual(tabletCustom.find((x) => x.i === c.i));
  }
  tiles = withNew.filter((t) => t !== gone);
  tabletCustom = after.layout;
});

test('H — a desktop change leaves the custom tablet as it is and marks it stale; Regenerate freezes the new desktop', async ({ page, request }) => {
  // Desktop edit: a KPI still on the report becomes full width (draft → publish).
  const kpi = f!.charts.filter((c) => c.type === 'KPI').map((c) => String(c.tile)).find((t) => tiles.includes(t))!;
  const live = (await editorDoc(request, f!.id)).dashboard_charts.find((dc: any) => String(dc.id) === kpi);
  const r = await request.put(`${DASH}/${f!.id}/draft-layout`, { data: { chart_layouts: [{ id: Number(kpi), layout: { ...live.layout, x: 0, w: 36 } }] } });
  expect(r.status(), await r.text()).toBe(200);
  const p = await request.post(`${DASH}/${f!.id}/publish`, { data: { force: true } });
  expect(p.status(), await p.text()).toBe(200);
  const d = await publicAt(page, `/d/${f!.token}`, TABLET);
  expect(byId(d.layout), 'a desktop change leaked into the custom tablet').toEqual(byId(tabletCustom));
  const b = await builderDevice(page, f!.id, 'tablet');
  await expect(page.getByTestId('device-status-stale')).toBeVisible();
  expect(byId(b.layout)).toEqual(byId(tabletCustom));
  await page.getByTestId('device-regenerate').click();
  await expect(page.getByTestId('device-status-stale')).toHaveCount(0);
  const regen = await stableDrawn(page, '[data-dashboard-canvas-root]');
  expect(regen.layout.find((c) => c.i === kpi)!.w, 'Regenerate did not follow the new desktop').toBe(36);
  checkGeometry({ ...regen, cols: 36 }, 'regenerated tablet', tiles);
  await saveDraft(page);
  await publish(page);
  tabletCustom = (await publicAt(page, `/d/${f!.token}`, TABLET)).layout;
});

test('G — Reset Tablet to Auto: a draft until Publish, then every viewer is back on the derived layout', async ({ page }) => {
  await builderDevice(page, f!.id, 'tablet');
  await page.getByTestId('device-reset').click();
  await expect(page.getByTestId('device-status-auto')).toBeVisible();
  const autoNow = await stableDrawn(page, '[data-dashboard-canvas-root]');
  await saveDraft(page);
  expect((await publicAt(page, `/d/${f!.token}`, TABLET)).source, 'reset reached public before Publish').toBe('custom');
  // Back in the Builder (the saved reset is still the author's draft).
  await builderDevice(page, f!.id, 'tablet');
  await expect(page.getByTestId('device-status-auto')).toBeVisible();
  await publish(page);
  for (const [label, url] of surfaces(f!)) {
    const d = await publicAt(page, url, TABLET);
    expect(d.source, label).toBe('auto');
    expect(byId(d.layout), `${label} is not the derived layout`).toEqual(byId(autoNow.layout));
  }
  // The phone custom layout is untouched by the tablet reset.
  expect((await publicAt(page, `/d/${f!.token}`, PHONE)).source).toBe('custom');
});

test('K — device layouts are per page: Page A / Tablet never changes Page B / Tablet, Page A / Phone or desktop', async ({ page, request }) => {
  const g = await freshReport(request);
  try {
    // Page B with one tile (author setup through the draft, published).
    const dash = await editorDoc(request, g.id);
    const rs = await request.put(`${DASH}/${g.id}/draft-filters`, { data: {
      pages_config: [{ id: 'page-1', name: 'A' }, { id: 'page-b', name: 'B' }], base_rev: dash.shared_draft?.rev } });
    expect(rs.status(), await rs.text()).toBe(200);
    const moved = (dash.dashboard_charts as any[]).find((dc) => dc.chart?.chart_type === 'TABLE');
    await request.put(`${DASH}/${g.id}/draft-layout`, { data: { chart_layouts: [{ id: moved.id, layout: { ...moved.layout, pageId: 'page-b', x: 0, y: 0 } }] } });
    expect((await request.post(`${DASH}/${g.id}/publish`, { data: { force: true } })).status()).toBe(200);
    const pageBBefore = await (async () => {
      await publicAt(page, `/d/${g.token}`, TABLET);
      await page.getByTestId('public-page-tab-page-b').first().click();
      return stableDrawn(page);
    })();
    const desk = await publicAt(page, `/d/${g.token}`, 1440);

    await builderDevice(page, g.id, 'tablet');
    await page.getByTestId('device-customize').click();
    const frozen = await stableDrawn(page, '[data-dashboard-canvas-root]');
    const last = order(frozen.layout).at(-1)!;
    await resizeBy(page, last, 0, 3 * 32);
    await saveDraft(page);
    await publish(page);
    const doc = await editorDoc(request, g.id);
    expect(Object.keys(doc.responsive_layouts.pages)).toEqual(['page-1']);
    expect(Object.keys(doc.responsive_layouts.pages['page-1'])).toEqual(['md']);
    await publicAt(page, `/d/${g.token}`, TABLET);
    await page.getByTestId('public-page-tab-page-b').first().click();
    const pageB = await stableDrawn(page);
    expect(pageB.source).toBe('auto');
    expect(byId(pageB.layout), 'Page B tablet changed').toEqual(byId(pageBBefore.layout));
    expect((await publicAt(page, `/d/${g.token}`, PHONE)).source, 'Page A phone changed').toBe('auto');
    expect(byId((await publicAt(page, `/d/${g.token}`, 1440)).layout), 'desktop changed').toEqual(byId(desk.layout));
  } finally {
    await dropReport(request, g);
  }
});

test('L — AI design changes desktop: an AUTO tablet follows it, a CUSTOM tablet is never rewritten (stale); Discard restores', async ({ page, request }) => {
  const g = await freshReport(request);
  try {
    const bar = g.tile('BAR');
    const plan = { layer: 'structure', direction: {}, structure: { operations: [{ op: 'move_to_top', visuals: [bar] }] } };
    const askAi = async () => {
      await page.getByTestId('device-mode-desktop').click();
      await page.getByTestId('design-mode-ai').click();
      await expect(page.getByTestId('ai-design-input')).toBeVisible();
      // Only the planner — the call that would spend a model — answers a fixed plan.
      await page.unroute('**/presentation-plan').catch(() => {});
      await page.route('**/presentation-plan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan }) }));
      await page.getByTestId('ai-design-input').fill('move the region chart to the top');
      await page.getByTestId('ai-design-send').click();
      await expect(page.getByTestId('ai-design-apply')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ai-design-apply').click();
    };
    // AUTO tablet follows the redesigned desktop.
    const autoBefore = await publicAt(page, `/d/${g.token}`, TABLET);
    await builderDevice(page, g.id, 'desktop');
    await askAi();
    await saveDraft(page);
    await publish(page);
    const autoAfter = await publicAt(page, `/d/${g.token}`, TABLET);
    expect(autoAfter.source).toBe('auto');
    expect(byId(autoAfter.layout), 'the AUTO tablet did not follow the AI desktop redesign').not.toEqual(byId(autoBefore.layout));
    const barCell = autoAfter.layout.find((c) => c.i === String(bar))!;
    expect(barCell.y, 'the moved chart is not at the top of the AUTO tablet').toBe(Math.min(...autoAfter.layout.map((c) => c.y)));

    // CUSTOM tablet: AI never rewrites it.
    await builderDevice(page, g.id, 'tablet');
    await page.getByTestId('device-customize').click();
    await saveDraft(page);
    await publish(page);
    const custom = await publicAt(page, `/d/${g.token}`, TABLET);
    await builderDevice(page, g.id, 'desktop');
    // A second redesign: move the PIE to the top.
    plan.structure.operations[0].visuals = [g.tile('PIE')];
    await askAi();
    await page.getByTestId('device-mode-tablet').click();
    await expect(page.getByTestId('device-status-stale')).toBeVisible();
    const builderTablet = await stableDrawn(page, '[data-dashboard-canvas-root]');
    expect(byId(builderTablet.layout), 'AI rewrote the custom tablet layout').toEqual(byId(custom.layout));
    // Discard: the draft redesign goes, the layout is current again.
    await page.getByTestId('dashboard-discard').click();
    await page.getByRole('button', { name: /^(Discard changes|Bỏ thay đổi)$/ }).click();
    await expect(page.getByTestId('device-status-stale')).toHaveCount(0, { timeout: 30_000 });
    expect(byId((await publicAt(page, `/d/${g.token}`, TABLET)).layout)).toEqual(byId(custom.layout));
  } finally {
    await dropReport(request, g);
  }
});

test('O — published custom layouts: /d, stable /embed and emb_ draw the same cells at tablet and phone widths', async ({ page }) => {
  for (const width of [TABLET, 700, PHONE, 500]) {
    const drawn = [] as Drawn[];
    for (const [label, url] of surfaces(f!)) {
      const d = await publicAt(page, url, width);
      checkGeometry(d, `${label}@${width}`, tiles);
      drawn.push(d);
    }
    expect(byId(drawn[1].layout), `/embed@${width}`).toEqual(byId(drawn[0].layout));
    expect(byId(drawn[2].layout), `emb_@${width}`).toEqual(byId(drawn[0].layout));
  }
});

test('API — the device draft endpoint refuses what the server must refuse (no route mocking)', async ({ request }) => {
  const doc = await editorDoc(request, f!.id);
  const [a, b] = (doc.dashboard_charts as any[]).map((dc) => String(dc.id));
  const bad = await request.put(`${V1}/dashboards/${f!.id}/draft-responsive`, { data: {
    page_id: 'page-1', breakpoint: 'md', base_rev: 0,
    profile: { mode: 'custom', cols: 36, generatorVersion: 1, baseFingerprint: 'x', source: 'auto-freeze',
      items: { [a]: { x: 0, y: 0, w: 20, h: 5 }, [b]: { x: 10, y: 2, w: 20, h: 5 } } } } });
  expect(bad.status()).toBe(400);
  expect(await bad.text()).toContain('overlap');
});
