import { expect, test, type APIRequestContext, type Browser, type Frame, type Page } from '@playwright/test';
import {
  collectTiles, DASH, deleteTestPats, dropReport, freshReport, waitForTiles, type Fixture,
} from './_public-closure';
import {
  byId, CANVAS, cellOf, closeHosts, domGeometry, expectNoHorizontalOverflow, expectSameBoxes, expectSameNormalized, expectSaneCells,
  framedAt, guardErrors, iframeHost, openBuilder, PHONE, publishUi, readDrawn, resizeTile, saveDraft, stableDrawn, switchDevice,
  TABLET, visitAll,
  type Drawn, type Geo,
} from './_responsive-uiux';

/**
 * Device-specific layouts — UI/UX ACCEPTANCE of what VIEWERS get: /d, the
 * stable /embed and an integration emb_, each framed by a real host page on
 * another origin with a DESKTOP outer browser (same Chromium, same user agent):
 * only the report's container width chooses the device. Readability and
 * reachability are asserted on what is rendered — titles, KPI values, plot
 * areas, the slicer menu, lazily mounted tiles — not on implementation state.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

const base = () => process.env.E2E_BASE_URL || 'http://localhost:3000';
const SHOTS = '../.artifacts/responsive-uiux';
let f: Fixture | null = null;
let host: Awaited<ReturnType<typeof iframeHost>> | null = null;
let tiles: string[] = [];

async function editorDoc(request: APIRequestContext, id: number) {
  return (await request.get(`${DASH}/${id}`)).json();
}

/** A viewer's fresh browser: nothing cached from the author's session. */
async function viewer(browser: Browser, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, storageState: { cookies: [], origins: [] } });
  return { ctx, page: await ctx.newPage() };
}

/** /d with its report container exactly `width` px. */
const dAt = (page: Page, width: number) => dAtToken(page, f!.token, width);

async function dAtToken(page: Page, token: string, width: number): Promise<Drawn> {
  let viewport = width + 40;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    await page.goto(`/d/${token}`);
    await page.waitForSelector('[data-report-layout] [data-tile-id]', { timeout: 60_000 });
    const drawn = await stableDrawn(page);
    if (drawn.width === width) return drawn;
    viewport += width - drawn.width;
  }
  throw new Error(`/d: could not make the report container ${width}px wide`);
}

/**
 * Objective readability of every rendered tile: a size, a visible title that
 * got real width (not squeezed to a few letters by a badge), a KPI value that
 * is not clipped, a chart plot area, a table, and nothing spilling out of its
 * own frame sideways.
 */
async function readability(t: Page | Frame, label: string) {
  const report = await t.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    for (const item of document.querySelectorAll('.react-grid-layout > [data-grid-item-id]')) {
      const el = item as HTMLElement;
      const r = el.getBoundingClientRect();
      const body = el.querySelector('[data-tile-id]') as HTMLElement | null;
      const title = el.querySelector('[data-pdf-tile-title]') as HTMLElement | null;
      const inner = body ? body.getBoundingClientRect().width : r.width;
      const value = el.querySelector('[data-kpi-value], .dashboard-kpi-value') as HTMLElement | null;
      const svg = el.querySelector('svg.recharts-surface') as SVGElement | null;
      const sb = svg?.getBoundingClientRect();
      out.push({
        id: el.dataset.gridItemId,
        w: Math.round(r.width), h: Math.round(r.height),
        mounted: Boolean(body),
        title: title ? {
          text: (title.textContent || '').trim(),
          width: Math.round(title.getBoundingClientRect().width),
          overflowX: title.scrollWidth - title.clientWidth,
          inner: Math.round(inner),
        } : null,
        value: value ? { text: (value.textContent || '').trim(), overflowX: value.scrollWidth - value.clientWidth } : null,
        plot: sb ? { w: Math.round(sb.width), h: Math.round(sb.height) } : null,
        spill: body ? body.scrollWidth - body.clientWidth : 0,
      });
    }
    return out;
  });
  for (const tile of report as any[]) {
    expect(tile.w > 0 && tile.h > 0, `${label}: tile ${tile.id} has no size`).toBe(true);
    if (!tile.mounted) continue;
    if (tile.title && tile.title.text) {
      // A title gets at least ~7 characters of width (or the whole tile when the
      // tile itself is narrower): a badge may wrap below it, never eat it.
      const needed = Math.min(96, tile.title.inner * 0.6);
      expect(tile.title.width, `${label}: tile ${tile.id} title "${tile.title.text}" is squeezed to ${tile.title.width}px (needs ≥ ${Math.round(needed)})`).toBeGreaterThanOrEqual(needed);
      expect(tile.title.overflowX, `${label}: tile ${tile.id} title "${tile.title.text}" is cut off sideways`).toBeLessThanOrEqual(1);
    }
    if (tile.value) {
      expect(tile.value.text, `${label}: KPI tile ${tile.id} shows no value`).not.toBe('');
      expect(tile.value.overflowX, `${label}: KPI tile ${tile.id} value "${tile.value.text}" is clipped`).toBeLessThanOrEqual(1);
    }
    if (tile.plot) expect(tile.plot.w > 40 && tile.plot.h > 40, `${label}: tile ${tile.id} plot area ${JSON.stringify(tile.plot)}`).toBe(true);
    expect(tile.spill, `${label}: tile ${tile.id} content spills sideways out of its frame`).toBeLessThanOrEqual(1);
  }
  return report;
}

test.beforeAll(async ({ request }) => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(SHOTS, { recursive: true });
  host = await iframeHost();
  f = await freshReport(request);
  tiles = ((await editorDoc(request, f.id)).dashboard_charts as any[]).map((dc) => String(dc.id));
});

test.afterAll(async ({ request }) => {
  closeHosts();
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('26 · readable on Tablet and Phone: titles get real width, KPI values unclipped, plot areas, the table after a scroll', async ({ page }) => {
  test.setTimeout(600_000);
  const guard = guardErrors(page);
  // The everyday viewer state: answers re-served from the result cache carry an
  // "As of HH:MM" badge in the tile header once they are a minute old. Warm the
  // cache, then reload until the badge is really there — the header is checked
  // in the state that squeezes it, not only on a cold first load.
  await dAt(page, PHONE);
  await visitAll(page);
  await expect.poll(async () => {
    await page.reload();
    await page.waitForSelector('[data-report-layout] [data-tile-id]');
    return page.locator('[data-testid="tile-cached-as-of"]').count();
  }, { message: 'no tile ever showed the cached "As of" badge', timeout: 180_000, intervals: [15_000] }).toBeGreaterThan(0);
  for (const width of [TABLET, PHONE]) {
    await dAt(page, width);
    await visitAll(page);
    await readability(page, `/d@${width}`);
    // The table is reachable by scrolling and shows rows.
    const table = page.locator(`[data-grid-item-id="${f!.tile('TABLE')}"]`);
    await table.scrollIntoViewIfNeeded();
    await expect(table.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { (el as HTMLElement).scrollTop = 0; }));
    await page.screenshot({ path: `${SHOTS}/26-d-${width}-top.png` });
  }
  guard.check();
});

// Every value any report container on the page ever announced as its breakpoint —
// when it appeared and each time it changed — in order (an observer only).
const RECORD_BREAKPOINTS = () => {
  (window as any).__bp = [];
  const note = (el: Element) => { const v = (el as HTMLElement).dataset?.reportBreakpoint; if (v) (window as any).__bp.push(v); };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') note(r.target as Element);
      for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches('[data-report-breakpoint]')) note(n); n.querySelectorAll('[data-report-breakpoint]').forEach(note); }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-report-breakpoint'] });
};

test('21+22+24 · stable /embed and emb_ framed by another site: 820 draws Tablet, 390 draws Phone, in a desktop browser with a desktop user agent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua, 'the browser pretends to be a phone').not.toMatch(/Mobile|Android|iPhone/);
  for (const [label, src] of [['/embed', `${base()}/embed/${f!.token}`], ['emb_', `${base()}${f!.emb}`]] as const) {
    const seen: Record<number, Drawn> = {};
    for (const [frameWidth, bp] of [[TABLET, 'md'], [PHONE, 'xs'], [1300, 'lg']] as const) {
      await page.goto(host!.url(src, frameWidth));
      const frame = await (await page.waitForSelector('#report')).contentFrame();
      await frame!.waitForSelector('[data-report-layout] [data-tile-id]', { timeout: 60_000 });
      const d = await stableDrawn(frame!);
      expect(d.breakpoint, `${label} in a ${frameWidth}px frame`).toBe(bp);
      expect(page.viewportSize()!.width, 'the outer browser changed size').toBe(1440);
      expect(await frame!.evaluate(() => navigator.userAgent)).toBe(ua);
      await expectNoHorizontalOverflow(frame!, `${label}@${frameWidth}`);
      expectSaneCells(d, `${label}@${frameWidth}`, tiles);
      seen[frameWidth] = d;
      if (frameWidth !== 1300) await page.screenshot({ path: `${SHOTS}/16-${label.replace(/[^a-z_]/gi, '')}-iframe-${frameWidth}.png` });
    }
    // The same report, three container widths: three different layouts.
    expect(JSON.stringify(byId(seen[TABLET].layout))).not.toBe(JSON.stringify(byId(seen[PHONE].layout)));
  }
  // Data in the framed emb_ stays the grant's report: every chart tile answers.
  const rows = collectTiles(page);
  await page.goto(host!.url(`${base()}${f!.emb}`, PHONE));
  const frame = await (await page.waitForSelector('#report')).contentFrame();
  await frame!.waitForSelector('[data-report-layout] [data-tile-id]');
  await visitAll(page, frame!);
  await waitForTiles(rows, f!.charts.map((c) => c.tile), 'emb_ framed at 390');
});

test('23 · breakpoint edges in a real frame: 639 Phone, 640 and 1023 Tablet, 1024 Desktop — one layout, no transient second one', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await ctx.addInitScript(RECORD_BREAKPOINTS);
  const page = await ctx.newPage();
  try {
    for (const [width, bp] of [[639, 'xs'], [640, 'md'], [1023, 'md'], [1024, 'lg']] as const) {
      const { frame, drawn } = await framedAt(page, host!, `${base()}/embed/${f!.token}`, width);
      expect([drawn.width, drawn.breakpoint], `report width ${width}`).toEqual([width, bp]);
      const history: string[] = await frame.evaluate(() => (window as any).__bp ?? []);
      expect(new Set(history), `@${width}: the report drew more than one breakpoint while loading (${history.join(' → ')})`).toEqual(new Set([bp]));
      expect(drawn.source).toBe(bp === 'lg' ? 'desktop' : 'auto');
    }
  } finally {
    await ctx.close();
  }
});

test('25 · no unintended horizontal overflow: /d at 820, 390, 639, 640, 1023, 1024; the Builder device frames and a 1024px Builder', async ({ page }) => {
  for (const width of [TABLET, PHONE, 639, 640, 1023, 1024]) {
    await dAt(page, width);
    await visitAll(page);
    await expectNoHorizontalOverflow(page, `/d@${width}`);
  }
  await openBuilder(page, f!.id);
  for (const m of ['tablet', 'phone', 'desktop'] as const) {
    await switchDevice(page, m);
    await expectNoHorizontalOverflow(page, `Builder ${m}`, CANVAS);
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await stableDrawn(page, CANVAS);
  await expectNoHorizontalOverflow(page, 'Builder in a 1024px window', CANVAS);
  // The device bar's controls stay on screen in a 1024px window.
  for (const m of ['desktop', 'tablet', 'phone'] as const) await expect(page.getByTestId(`device-mode-${m}`)).toBeInViewport();
});

test('17+18 · pages: Page A / Tablet customised alone; a tile moved A → B through the tile menu stays a draft until Publish, then lives once, on B', async ({ page, request, browser }) => {
  const g = await freshReport(request, async (id) => {
    const dash = (await (await request.get(`${DASH}/${id}`)).json());
    const res = await request.put(`${DASH}/${id}/draft-filters`, { data: {
      pages_config: [{ id: 'page-1', name: 'Overview' }, { id: 'page-b', name: 'Detail' }], base_rev: dash.shared_draft?.rev } });
    expect(res.status(), await res.text()).toBe(200);
    // Page B starts with the bar chart (author setup, published with the fixture).
    const bar = (dash.dashboard_charts as any[]).find((dc) => dc.chart?.chart_type === 'BAR');
    const r2 = await request.put(`${DASH}/${id}/draft-layout`, { data: { chart_layouts: [{ id: bar.id, layout: { ...bar.layout, pageId: 'page-b', x: 0, y: 0 } }] } });
    expect(r2.status(), await r2.text()).toBe(200);
  });
  const v = await viewer(browser);
  const pageDrawn = async (pg: Page, pageId: string, width: number) => {
    await dAtToken(pg, g.token, width);
    if (pageId !== 'page-1') {
      await pg.getByTestId(`public-page-tab-${pageId}`).first().click();
      await expect.poll(async () => (await readDrawn(pg))?.layout.map((c) => c.i).join(',')).not.toBe('');
    }
    await visitAll(pg);
    return stableDrawn(pg);
  };
  try {
    const snap = async () => ({
      aDesk: await pageDrawn(v.page, 'page-1', 1440), aTab: await pageDrawn(v.page, 'page-1', TABLET), aPhone: await pageDrawn(v.page, 'page-1', PHONE),
      bDesk: await pageDrawn(v.page, 'page-b', 1440), bTab: await pageDrawn(v.page, 'page-b', TABLET), bPhone: await pageDrawn(v.page, 'page-b', PHONE),
    });
    const before = await snap();
    // 18 · customise Page A / Tablet only (and Page B / Tablet, for the move below).
    await openBuilder(page, g.id);
    await switchDevice(page, 'tablet');
    await page.getByTestId('device-customize').click();
    const pie = String(g.tile('PIE'));
    await resizeTile(page, pie, 0, 2 * 32);
    const aCustom = await stableDrawn(page, CANVAS);
    await saveDraft(page);
    await publishUi(page);
    const after = await snap();
    expect(byId(after.aTab.layout), 'Page A / Tablet did not change').toEqual(byId(aCustom.layout));
    for (const k of ['aDesk', 'aPhone', 'bDesk', 'bTab', 'bPhone'] as const) {
      expect(byId(after[k].layout), `${k} changed when only Page A / Tablet was customised`).toEqual(byId(before[k].layout));
    }
    // Page B / Tablet custom too, from its own page in the Builder.
    await page.getByTestId('builder-pages-menu').click();
    await page.getByTestId('builder-page-page-b').click();
    await switchDevice(page, 'tablet');
    await page.getByTestId('device-customize').click();
    const bCustom = await stableDrawn(page, CANVAS);
    await saveDraft(page);
    await publishUi(page);

    // 17 · move the table from Page A to Page B through its tile menu.
    await page.getByTestId('builder-pages-menu').click();
    await page.getByTestId('builder-page-page-1').click();
    await switchDevice(page, 'desktop');
    const table = String(g.tile('TABLE'));
    const tile = page.locator(`${CANVAS} .react-grid-layout > [data-grid-item-id="${table}"]`);
    await tile.scrollIntoViewIfNeeded();
    await tile.hover();
    await tile.getByTitle(/more options|tùy chọn khác|thêm tùy chọn/i).click();
    await page.getByRole('button', { name: /move to page|chuyển sang trang/i }).click();
    await page.getByRole('button', { name: /^detail$/i }).click();
    await expect(page.locator(`${CANVAS} [data-grid-item-id="${table}"]`)).toHaveCount(0);
    await saveDraft(page);
    // Before Publish: viewers still have the table on Page A, not on Page B.
    const pending = await pageDrawn(v.page, 'page-1', TABLET);
    expect(pending.layout.some((c) => c.i === table), 'the move reached viewers before Publish').toBe(true);
    expect((await pageDrawn(v.page, 'page-b', TABLET)).layout.some((c) => c.i === table)).toBe(false);
    await publishUi(page);
    const aT = await pageDrawn(v.page, 'page-1', TABLET);
    const bT = await pageDrawn(v.page, 'page-b', TABLET);
    expect(aT.layout.some((c) => c.i === table), 'the moved tile is still on Page A').toBe(false);
    expect(bT.layout.filter((c) => c.i === table), 'the moved tile is not on Page B exactly once').toHaveLength(1);
    for (const c of aCustom.layout.filter((x) => x.i !== table)) expect(cellOf(aT, c.i), `Page A tile ${c.i} moved`).toEqual(c);
    for (const c of bCustom.layout) expect(cellOf(bT, c.i), `Page B tile ${c.i} moved`).toEqual(c);
    expect(cellOf(bT, table).y, 'the arriving tile is not below Page B\'s custom layout').toBeGreaterThanOrEqual(Math.max(...bCustom.layout.map((c) => c.y + c.h)));
    expectSaneCells(bT, 'Page B tablet after the move', [...bCustom.layout.map((c) => c.i), table]);
    const desk = await pageDrawn(v.page, 'page-1', 1440);
    expect(desk.layout.some((c) => c.i === table)).toBe(false);
  } finally {
    await v.ctx.close();
    await dropReport(request, g);
  }
});

test('44 · parity matrix on a published report with custom Tablet and Phone: Builder = Studio = /d = /embed = emb_ on every device', async ({ page }) => {
  // Fixture state for the matrix: Tablet and Phone customised (frozen) in the
  // Builder and published — the editing journeys are in dashboard-responsive-uiux.spec.ts.
  await openBuilder(page, f!.id);
  for (const mode of ['tablet', 'phone'] as const) {
    await switchDevice(page, mode);
    await page.getByTestId('device-customize').click();
    await expect(page.getByTestId('device-status-custom')).toBeVisible();
  }
  await saveDraft(page);
  await publishUi(page);
  const matrix: Record<string, Record<string, Geo>> = {};
  for (const [mode, width] of [['desktop', 1440], ['tablet', TABLET], ['phone', PHONE]] as const) {
    const row: Record<string, Geo> = {};
    // Builder (a desktop canvas is the window's width: compare cells, not pixels).
    const b = await switchDevice(page, mode);
    if (mode !== 'desktop') row.Builder = await domGeometry(page, CANVAS);
    // Studio frame at the device width.
    await page.getByTestId('studio-preview-open').click();
    await page.getByTestId(`studio-device-${mode}`).click();
    const handle = await page.waitForSelector('[data-testid="studio-preview"] iframe');
    const sf = (await handle.contentFrame())!;
    await sf.waitForSelector(`${CANVAS} [data-tile-id]`, { timeout: 60_000 });
    const sd = await stableDrawn(sf, CANVAS);
    expect(byId(sd.layout), `Studio ${mode} differs from the Builder`).toEqual(byId(b.layout));
    row.Studio = await domGeometry(sf, CANVAS);
    if (mode !== 'desktop') await page.screenshot({ path: `${SHOTS}/17-studio-${mode}.png` });
    await page.getByTestId('studio-close').click();
    // Public surfaces at the same report width.
    const d = await dAt(page, width);
    expect(byId(d.layout), `/d ${mode} differs from the Builder`).toEqual(byId(b.layout));
    await visitAll(page);
    row['/d'] = await domGeometry(page);
    if (mode !== 'desktop') await page.screenshot({ path: `${SHOTS}/18-d-${mode}.png` });
    for (const [label, src] of [['/embed', `${base()}/embed/${f!.token}`], ['emb_', `${base()}${f!.emb}`]] as const) {
      const { frame, drawn } = await framedAt(page, host!, src, width);
      expect(byId(drawn.layout), `${label} ${mode} differs from the Builder`).toEqual(byId(b.layout));
      await visitAll(page, frame);
      row[label] = await domGeometry(frame);
      if (mode !== 'desktop') await page.screenshot({ path: `${SHOTS}/19-${label.replace(/[^a-z_]/gi, '')}-${mode}.png` });
    }
    // Pixel parity (±2 px) between surfaces drawn at the same report width; the
    // Studio's device frame (report = frame minus gutter) agrees normalised.
    const ref = row['/d'];
    for (const [label, geo] of Object.entries(row)) {
      if (label === '/d') continue;
      if (label === 'Studio') expectSameNormalized(geo, ref, `Studio vs /d (${mode})`);
      else expectSameBoxes(geo, ref, `${label} vs /d (${mode})`);
    }
    matrix[mode] = row;
    await openBuilder(page, f!.id);
  }
  console.log(`[evidence] parity matrix: ${Object.entries(matrix).map(([m, r]) => `${m}: ${Object.keys(r).join('=')}`).join(' | ')}`);
});
