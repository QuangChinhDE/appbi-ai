import { expect, test, type APIRequestContext, type Browser, type Frame, type Page } from '@playwright/test';
import {
  bindWhatIf, collectTiles, DASH, deleteTestPats, dropReport, freeze, freshReport, V1, waitForTiles,
  type Fixture,
} from './_public-closure';
import {
  byId, CANVAS, cellOf, closeHosts, domGeometry, dragTile, expectNoHorizontalOverflow, expectSameBoxes, expectSaneBoxes,
  expectSameNormalized, expectSaneCells, framedAt, guardErrors, iframeHost, in36, openBuilder, order, PHONE, publishUi, readDrawn, resizeTile,
  saveDraft, stableDrawn, switchDevice, TABLET, visitAll, watchNet, type Cell, type Drawn, type Geo,
} from './_responsive-uiux';

/**
 * Device-specific layouts — UI/UX ACCEPTANCE in a real browser, as an author.
 *
 * One report, authored the way a person does it: the device switcher, the
 * Customize / Reset / Regenerate / Add below buttons, mouse drags and resizes on
 * the canvas, Save draft, a full reload, Publish — then read back on /d, the
 * stable /embed and an integration emb_ framed by another site. API calls only
 * create the fixture (a copy of the seeded presentation report, a parameter
 * switcher, a text block, a public link, an emb_ grant). Geometry is compared by
 * TILE id from the DOM the user sees, relative to the report grid.
 *
 * docs/responsive-dashboard-layouts.md is the contract under test.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
let host: Awaited<ReturnType<typeof iframeHost>> | null = null;
let tiles: string[] = [];
const sw = { dim: 0, met: 0 };
let text = '';

// What each step leaves behind for the next (serial journey on one report).
let desktopGeo: Geo | null = null;
let desktopCells: Cell[] = [];
let tabletAuto: Drawn | null = null;
let phoneAuto: Drawn | null = null;
let tabletCustom: Drawn | null = null;
let phoneCustom: Drawn | null = null;

const SHOTS = '../.artifacts/responsive-uiux';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });

async function editorDoc(request: APIRequestContext, id: number) {
  return (await request.get(`${DASH}/${id}`)).json();
}

/** A viewer's fresh browser: a new context, nothing cached from the author's page. */
async function viewer(browser: Browser, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, storageState: { cookies: [], origins: [] } });
  return { ctx, page: await ctx.newPage() };
}

/** /d with its report container exactly `width` px (viewport adjusted to the gutter). */
async function dAt(page: Page, width: number): Promise<{ drawn: Drawn; geo: Geo }> {
  let viewport = width + 40;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    await page.goto(`/d/${f!.token}`);
    await page.waitForSelector('[data-report-layout] [data-tile-id]', { timeout: 60_000 });
    const drawn = await stableDrawn(page);
    if (drawn.width === width) {
      await visitAll(page);
      const settled = await stableDrawn(page);
      return { drawn: settled, geo: await domGeometry(page) };
    }
    viewport += width - drawn.width;
  }
  throw new Error(`/d: could not make the report container ${width}px wide`);
}

/** /d, stable /embed (framed) and emb_ (framed), each at report width `width`. */
async function everyPublicSurface(page: Page, width: number) {
  const d = await dAt(page, width);
  const out: Record<string, { drawn: Drawn; geo: Geo }> = { '/d': d };
  for (const [label, src] of [['/embed', `${base()}/embed/${f!.token}`], ['emb_', `${base()}${f!.emb}`]] as const) {
    const { frame } = await framedAt(page, host!, src, width);
    await visitAll(page, frame);
    out[label] = { drawn: await stableDrawn(frame), geo: await domGeometry(frame) };
  }
  return out;
}

const base = () => process.env.E2E_BASE_URL || 'http://localhost:3000';

test.beforeAll(async ({ request }) => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(SHOTS, { recursive: true });
  host = await iframeHost();
  f = await freshReport(request, async (id, charts) => {
    const bar = charts.find((c) => c.type === 'BAR')!.tile;
    const pie = charts.find((c) => c.type === 'PIE')!.tile;
    // Below the seeded content: a dimension and a measure switcher, and a text
    // block — the report scrolls on every device.
    // Layouts on the 36-column grid (gv: 2), as the Builder writes them — a layout
    // without the marker is read as a legacy 12-column one and scaled.
    const widget = async (widget_type: string, widget_config: Record<string, unknown>, layout: Record<string, number>, pick: (dc: any) => boolean) => {
      const res = await request.post(`${DASH}/${id}/widgets`, { data: { widget_type, widget_config, layout: { ...layout, gv: 2 } } });
      expect(res.status(), await res.text()).toBeLessThan(400);
      return ((await res.json()).dashboard_charts as any[]).find(pick).id as number;
    };
    sw.dim = await widget('parameter_switcher', { layout: 'dropdown', paramName: 'dim', label: 'Group by', default: 'region',
      options: [{ label: 'Region', value: 'region' }, { label: 'Channel', value: 'channel' }] }, { x: 0, y: 42, w: 12, h: 3 }, (dc) => dc.widget_config?.paramName === 'dim');
    sw.met = await widget('parameter_switcher', { layout: 'dropdown', paramName: 'met', label: 'Measure', default: 'revenue',
      options: [{ label: 'Revenue', value: 'revenue' }, { label: 'Orders', value: 'orders' }] }, { x: 12, y: 42, w: 12, h: 3 }, (dc) => dc.widget_config?.paramName === 'met');
    await bindWhatIf(request, id, bar, [{ param: 'dim', role: 'dimension' }]);
    await bindWhatIf(request, id, pie, [{ param: 'met', role: 'metric' }]);
    text = String(await widget('text', { template: 'Notes: revenue is shown net of returns.', align: 'left' },
      { x: 24, y: 42, w: 12, h: 6 }, (dc) => dc.widget_type === 'text'));
  });
  const doc = await editorDoc(request, f.id);
  tiles = (doc.dashboard_charts as any[]).map((dc) => String(dc.id));
  expect(doc.responsive_layouts ?? null, 'fixture: a fresh report has no device layouts').toBeNull();
});

test.afterAll(async ({ request }) => {
  closeHosts();
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('1 · device switcher: visible, stateful, reachable; Desktop editing intact; repeated switching corrupts nothing', async ({ page }) => {
  const guard = guardErrors(page);
  await openBuilder(page, f!.id);
  const bar = page.getByTestId('device-bar');
  await expect(bar).toBeVisible();
  for (const m of ['desktop', 'tablet', 'phone'] as const) await expect(page.getByTestId(`device-mode-${m}`)).toBeVisible();
  // Desktop: selected, the authored canvas, desktop-only tools present, no device actions.
  await expect(page.getByTestId('device-mode-desktop')).toHaveAttribute('aria-pressed', 'true');
  const desk = await stableDrawn(page, CANVAS);
  expect([desk.breakpoint, desk.source]).toEqual(['lg', 'desktop']);
  await expect(page.getByTestId('device-customize')).toHaveCount(0);
  await expect(page.locator(`${CANVAS} .react-resizable-handle-se:visible`).first()).toBeVisible();
  desktopGeo = await domGeometry(page, CANVAS);
  desktopCells = desk.layout;
  expectSaneBoxes(desktopGeo, 'builder desktop', tiles);
  await shot(page, '01-builder-desktop');

  for (const [mode, width] of [['tablet', TABLET], ['phone', PHONE]] as const) {
    const d = await switchDevice(page, mode);
    expect(d.width, `${mode}: the canvas is not the ${mode} frame`).toBe(width);
    expect(d.source).toBe('auto');
    const frame = await page.locator(`[data-device-frame="${mode}"]`).boundingBox();
    expect(Math.round(frame!.width), `${mode}: the device frame`).toBe(width);
    await expect(page.getByTestId('device-status-auto')).toBeVisible();
    await expect(page.getByTestId('device-customize')).toBeVisible();
    // AUTO is not editable: no drag, no resize, no desktop-only tools.
    await expect(page.locator(`${CANVAS} .react-resizable-handle:visible`)).toHaveCount(0);
    await expect(page.locator(`${CANVAS} .react-grid-item.react-draggable`)).toHaveCount(0);
    await expect(page.getByTestId('device-reset')).toHaveCount(0);
    expectSaneBoxes(await domGeometry(page, CANVAS), `builder ${mode} auto`, tiles);
    await expectNoHorizontalOverflow(page, `builder ${mode}`, CANVAS);
  }

  // Desktop → Tablet → Phone → Desktop, twice: the same layouts every time.
  const seen: Record<string, string> = {};
  for (let round = 0; round < 2; round += 1) {
    for (const m of ['desktop', 'tablet', 'phone', 'desktop'] as const) {
      const d = await switchDevice(page, m);
      expect(new Set(d.layout.map((c) => c.i)), `${m}: tiles disappeared`).toEqual(new Set(tiles));
      const key = JSON.stringify(byId(d.layout));
      if (seen[m]) expect(key, `${m}: switching changed the layout`).toBe(seen[m]);
      seen[m] = key;
    }
  }
  // Still usable: the canvas scrolls to the last tile, the device bar is reachable.
  const last = order(desk.layout).at(-1)!;
  await page.locator(`${CANVAS} [data-grid-item-id="${last}"]`).scrollIntoViewIfNeeded();
  await expect(page.locator(`${CANVAS} [data-grid-item-id="${last}"] [data-tile-id], ${CANVAS} [data-grid-item-id="${last}"]`).first()).toBeVisible();
  await page.getByTestId('device-mode-tablet').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('device-mode-tablet')).toBeInViewport();
  expectSameBoxes(await domGeometry(page, CANVAS), desktopGeo!, 'desktop after switching');
  guard.check();
});

test('2 · accessibility smoke: names, selected state, keyboard reach and activation, real disabled state', async ({ page }) => {
  await openBuilder(page, f!.id);
  const group = page.getByRole('group', { name: /device|thiết bị/i });
  await expect(group).toBeVisible();
  for (const name of [/^desktop$|^máy tính$/i, /^tablet$|^máy tính bảng$/i, /^phone$|^điện thoại$/i]) {
    await expect(group.getByRole('button', { name })).toBeVisible();
  }
  // Keyboard: Tab reaches the device buttons; Enter and Space switch.
  await page.getByTestId('device-mode-desktop').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('device-mode-tablet')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('device-mode-tablet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('device-mode-desktop')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('device-mode-phone')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(page.getByTestId('device-mode-phone')).toHaveAttribute('aria-pressed', 'true');
  // Customize is a named, focusable button; Tab moves on (no focus trap).
  const customize = page.getByRole('button', { name: /customize layout|tùy chỉnh bố cục/i });
  await expect(customize).toBeVisible();
  await customize.focus();
  await expect(customize).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(customize).not.toBeFocused();
  // Studio views that need a pending change are really disabled, not just dimmed.
  await page.getByTestId('device-mode-desktop').click();
  await page.getByTestId('studio-preview-open').click();
  await expect(page.getByTestId('studio-view-compare')).toBeDisabled();
  await expect(page.getByTestId('studio-view-before')).toBeDisabled();
  await page.getByTestId('studio-close').click();
  await expect(page.getByTestId('studio-preview')).toHaveCount(0);
  // Nothing was customised by looking.
  await page.getByTestId('device-mode-phone').click();
  await expect(page.getByTestId('device-status-auto')).toBeVisible();
});

test('3 · Tablet AUTO: every tile, no overlap or overflow, desktop reading order, scroll + lazy tiles; previewing creates nothing', async ({ page, request }) => {
  const guard = guardErrors(page);
  await openBuilder(page, f!.id);
  const d = await switchDevice(page, 'tablet');
  await visitAll(page);
  tabletAuto = await stableDrawn(page, CANVAS);
  expect(tabletAuto.source).toBe('auto');
  expectSaneCells(tabletAuto, 'builder tablet auto', tiles);
  expectSaneBoxes(await domGeometry(page, CANVAS), 'builder tablet auto (DOM)', tiles);
  // Reading order follows the authored desktop order (top-to-bottom, left-to-right
  // inside each desktop row band): no tile jumps ahead of one above it on desktop.
  const deskRow = (id: string) => cellOf(desktopCells, id).y;
  const autoOrder = order(tabletAuto.layout);
  for (let k = 1; k < autoOrder.length; k += 1) {
    expect(deskRow(autoOrder[k]), `tablet puts ${autoOrder[k]} after ${autoOrder[k - 1]} but desktop has it higher`).toBeGreaterThanOrEqual(deskRow(autoOrder[k - 1]) - 0.5);
  }
  await expectNoHorizontalOverflow(page, 'builder tablet auto', CANVAS);
  await shot(page, '02-builder-tablet-auto');
  // The table is reachable by scrolling and renders rows.
  const table = f!.tile('TABLE');
  await page.locator(`${CANVAS} [data-grid-item-id="${table}"]`).scrollIntoViewIfNeeded();
  await expect(page.locator(`${CANVAS} [data-grid-item-id="${table}"] table tbody tr`).first()).toBeVisible({ timeout: 30_000 });
  // Every chart tile rendered something (no permanent blank placeholder).
  for (const c of f!.charts) {
    const tile = page.locator(`${CANVAS} [data-grid-item-id="${c.tile}"]`);
    await tile.scrollIntoViewIfNeeded();
    await expect(tile.locator('[data-tile-id]'), `tile ${c.tile} (${c.type}) never rendered`).toHaveCount(1, { timeout: 30_000 });
  }
  // Reload: still AUTO, the same layout; nothing was stored by looking.
  await page.reload();
  await page.waitForSelector(`${CANVAS} [data-tile-id]`);
  await switchDevice(page, 'tablet');
  await visitAll(page);
  const again = await stableDrawn(page, CANVAS);
  expect(again.source).toBe('auto');
  expect(byId(again.layout), 'Tablet AUTO differs after a reload').toEqual(byId(tabletAuto.layout));
  expect(d.source).toBe('auto');
  const doc = await editorDoc(request, f!.id);
  expect(doc.responsive_layouts ?? null, 'previewing Tablet stored a layout').toBeNull();
  expect(doc.draft_responsive_layouts ?? null, 'previewing Tablet staged a draft').toBeFalsy();
  await switchDevice(page, 'phone');
  await visitAll(page);
  phoneAuto = await stableDrawn(page, CANVAS);
  await shot(page, '03-builder-phone-auto');
  guard.check();
});

test('4+5 · Customize Tablet: no jump; real drag and resize change only what was moved; a long drag sends no writes and no data requests', async ({ page }) => {
  const guard = guardErrors(page);
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  await visitAll(page);
  const beforeGeo = await domGeometry(page, CANVAS);
  const before = await stableDrawn(page, CANVAS);
  await page.getByTestId('device-customize').click();
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  await expect(page.getByTestId('device-status-auto')).toHaveCount(0);
  const frozen = await stableDrawn(page, CANVAS);
  expect([frozen.source, frozen.cols]).toEqual(['custom', 36]);
  expect(in36(frozen), 'Customize changed the cells').toEqual(in36(before));
  expectSameBoxes(await domGeometry(page, CANVAS), beforeGeo, 'Customize moved what the author sees');
  // Editing handles now exist and are usable.
  await expect(page.locator(`${CANVAS} .react-resizable-handle-se:visible`).first()).toBeVisible();
  for (const id of ['device-reset', 'device-regenerate', 'device-fit-heights']) await expect(page.getByTestId(id)).toBeVisible();
  await shot(page, '04-builder-tablet-custom-frozen');

  const kpi = String(f!.charts.filter((c) => c.type === 'KPI').map((c) => c.tile).find((t) => cellOf(frozen, String(t)).y === Math.min(...f!.charts.filter((c) => c.type === 'KPI').map((c) => cellOf(frozen, String(c.tile)).y)))!);
  const pie = String(f!.tile('PIE'));
  const ts = String(f!.tile('TIME_SERIES'));
  const tableTile = String(f!.tile('TABLE'));
  const colPx = TABLET / 36;
  const net = watchNet(page);

  // (a) a long drag: the table goes down two rows, through 60 pointer moves.
  const geo0 = await domGeometry(page, CANVAS);
  await dragTile(page, tableTile, 0, 2 * 32, 60);
  const afterDrag = await stableDrawn(page, CANVAS);
  expect(cellOf(afterDrag, tableTile).y, 'the drag did not move the table down').toBeGreaterThan(cellOf(frozen, tableTile).y);
  const geo1 = await domGeometry(page, CANVAS);
  for (const b of geo0.boxes.filter((x) => x.id !== tableTile && x.y < geo0.boxes.find((t) => t.id === tableTile)!.y)) {
    expect(geo1.boxes.find((x) => x.id === b.id), `tile ${b.id} above the dragged table moved`).toEqual(b);
  }
  // (b) resize: the time series 4 columns narrower, the pie 2 rows taller
  //     (the pie is already at a chart's minimum width on a tablet).
  await resizeTile(page, ts, -4 * colPx, 0);
  const beforeGrow = await stableDrawn(page, CANVAS);
  await resizeTile(page, pie, 0, 2 * 32);
  const afterGrow = await stableDrawn(page, CANVAS);
  // Growing the pie moves only what it now covers: a tile in other columns stays put.
  const p0 = cellOf(beforeGrow, pie);
  for (const c of beforeGrow.layout.filter((x) => x.i !== pie && (x.x + x.w <= p0.x || x.x >= p0.x + p0.w))) {
    expect(cellOf(afterGrow, c.i), `tile ${c.i} beside the resized pie moved`).toEqual(c);
  }
  // (c) move the first KPI right by 3 columns.
  await resizeTile(page, kpi, -6 * colPx, 0);
  await dragTile(page, kpi, 3 * colPx, 0);
  const edited = await stableDrawn(page, CANVAS);
  net.stop();
  expect(net.responsiveWrites, `writes during drag/resize: ${net.responsiveWrites.join(', ')}`).toEqual([]);
  expect(net.layoutWrites, `layout writes during drag/resize: ${net.layoutWrites.join(', ')}`).toEqual([]);
  expect(net.chartData, `chart data requested because tiles moved: ${net.chartData.join(', ')}`).toEqual([]);
  console.log(`[evidence] drag/resize (60+8+8+8+12 pointer moves): draft-responsive=${net.responsiveWrites.length} layout=${net.layoutWrites.length} chart-data=${net.chartData.length}`);

  expect(cellOf(edited, ts).w, 'the time series was not narrowed').toBeLessThan(cellOf(frozen, ts).w);
  expect(cellOf(edited, pie).h, 'the pie was not made taller').toBeGreaterThan(cellOf(frozen, pie).h);
  expect(cellOf(edited, kpi).w, 'the KPI was not narrowed').toBeLessThan(cellOf(frozen, kpi).w);
  expect(cellOf(edited, kpi).x, 'the KPI was not moved right').toBeGreaterThan(cellOf(frozen, kpi).x);
  expectSaneCells(edited, 'tablet custom after editing', tiles);
  // Tiles nobody touched keep their width (a move pushes rows, never resizes).
  for (const c of frozen.layout.filter((x) => ![kpi, pie, ts, tableTile].includes(x.i))) {
    expect(cellOf(edited, c.i).w, `tile ${c.i} was resized by someone else's edit`).toBe(c.w);
  }
  await expect(page.getByTestId('dashboard-save-draft')).not.toHaveAttribute('data-state', 'saved');
  tabletCustom = edited;
  await shot(page, '05-builder-tablet-custom-unsaved');
  guard.check();
});

test('6+7 · Save draft → full reload restores the tablet; desktop and phone untouched; /d, /embed and emb_ still show the OLD tablet', async ({ page, request, browser }) => {
  // The previous test left unsaved edits in ITS page; this one re-does the save
  // flow end to end: open, customise the same way, save.
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  // The unsaved edits of the last test were in a closed page — nothing was stored.
  expect((await editorDoc(request, f!.id)).draft_responsive_layouts ?? null).toBeFalsy();
  await page.getByTestId('device-customize').click();
  const frozen = await stableDrawn(page, CANVAS);
  const pie = String(f!.tile('PIE'));
  await resizeTile(page, pie, 0, 2 * 32);
  const edited = await stableDrawn(page, CANVAS);
  expect(cellOf(edited, pie).h, 'the pie was not made taller').toBeGreaterThan(cellOf(frozen, pie).h);
  const net = watchNet(page);
  await saveDraft(page);
  net.stop();
  expect(net.responsiveWrites.length, `Save draft sent ${net.responsiveWrites.length} device-layout writes`).toBe(1);
  console.log(`[evidence] Save draft: draft-responsive writes=${net.responsiveWrites.length}`);
  const editedGeo = await domGeometry(page, CANVAS);

  await page.reload();
  await page.waitForSelector(`${CANVAS} [data-tile-id]`);
  await expect(page.getByTestId('device-mode-desktop')).toHaveAttribute('aria-pressed', 'true');
  const desk = await stableDrawn(page, CANVAS);
  expect(byId(desk.layout), 'a tablet draft changed desktop').toEqual(byId(desktopCells));
  const t = await switchDevice(page, 'tablet');
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  expect(byId(t.layout), 'the saved tablet draft did not survive a reload').toEqual(byId(edited.layout));
  expectSameBoxes(await domGeometry(page, CANVAS), editedGeo, 'tablet after reload');
  await shot(page, '06-builder-tablet-custom-after-reload');
  const p = await switchDevice(page, 'phone');
  expect(p.source, 'a tablet draft made the phone custom').toBe('auto');
  expect(byId(p.layout)).toEqual(byId(phoneAuto!.layout));
  tabletCustom = edited;

  // Public, from a viewer's fresh browser: the published (AUTO) tablet, not the draft.
  const v = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v.page, TABLET);
    for (const [label, s] of Object.entries(pub)) {
      expect(s.drawn.source, `${label} shows an unpublished device layout`).toBe('auto');
      expect(byId(s.drawn.layout), `${label} changed before Publish`).toEqual(byId(tabletAuto!.layout));
    }
  } finally {
    await v.ctx.close();
  }
});

test('8 · Publish in the Builder → fresh viewers on /d, /embed and emb_ draw the custom tablet; Builder = Studio = /d = /embed = emb_', async ({ page, browser }) => {
  await openBuilder(page, f!.id);
  await expect(page.getByTestId('dashboard-publish')).toBeVisible();
  await publishUi(page);
  const b = await switchDevice(page, 'tablet');
  expect(b.source).toBe('custom');
  expect(byId(b.layout)).toEqual(byId(tabletCustom!.layout));
  const builderGeo = await domGeometry(page, CANVAS);
  // Studio, tablet.
  await page.getByTestId('studio-preview-open').click();
  await page.getByTestId('studio-device-tablet').click();
  const studioFrame = page.frameLocator('[data-testid="studio-preview"] iframe').first();
  await studioFrame.locator('[data-report-layout] [data-tile-id]').first().waitFor({ timeout: 60_000 });
  const sf = page.frames().find((fr) => fr.url().includes('studio=preview'))!;
  const studio = await stableDrawn(sf, CANVAS);
  // The Studio frames a whole 820px device: its report is 820 minus the page gutter.
  expect([studio.breakpoint, studio.source]).toEqual(['md', 'custom']);
  expect(studio.width).toBeGreaterThan(TABLET - 64);
  expect(byId(studio.layout), 'Studio tablet differs from the Builder').toEqual(byId(b.layout));
  expectSameNormalized(await domGeometry(sf, CANVAS), builderGeo, 'Studio tablet vs Builder tablet');
  await shot(page, '07-studio-tablet');
  await page.getByTestId('studio-close').click();

  const v = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v.page, TABLET);
    for (const [label, s] of Object.entries(pub)) {
      expect(s.drawn.source, label).toBe('custom');
      expect(byId(s.drawn.layout), `${label} does not draw the published tablet`).toEqual(byId(tabletCustom!.layout));
      expectSameBoxes(s.geo, builderGeo, `${label} tablet vs Builder tablet`);
    }
    await v.page.setViewportSize({ width: TABLET + 40, height: 1000 });
    await v.page.goto(`/d/${f!.token}`);
    await v.page.waitForSelector('[data-tile-id]');
    await shot(v.page, '08-d-tablet-custom');
  } finally {
    await v.ctx.close();
  }
});

test('9 · Desktop isolation: after the tablet publish the Builder desktop and /d desktop are exactly as before', async ({ page, browser }) => {
  await openBuilder(page, f!.id);
  const desk = await stableDrawn(page, CANVAS);
  expect(byId(desk.layout), 'Builder desktop cells changed').toEqual(byId(desktopCells));
  expectSameBoxes(await domGeometry(page, CANVAS), desktopGeo!, 'Builder desktop after the tablet publish');
  const v = await viewer(browser);
  try {
    const d = await dAt(v.page, 1440);
    expect([d.drawn.breakpoint, d.drawn.source]).toEqual(['lg', 'desktop']);
    expect(byId(d.drawn.layout), '/d desktop changed').toEqual(byId(desktopCells));
  } finally {
    await v.ctx.close();
  }
});

test('10 · Phone: still its own AUTO; Customize with real drag/resize → Save → reload → Publish; Desktop and Tablet unchanged', async ({ page, request, browser }) => {
  const doc = await editorDoc(request, f!.id);
  expect(Object.keys(doc.responsive_layouts?.pages?.['page-1'] ?? {}), 'the tablet publish created a phone layout').toEqual(['md']);
  await openBuilder(page, f!.id);
  await switchDevice(page, 'phone');
  await visitAll(page);
  const autoNow = await stableDrawn(page, CANVAS);
  expect(autoNow.source).toBe('auto');
  expect(byId(autoNow.layout)).toEqual(byId(phoneAuto!.layout));
  await page.getByTestId('device-customize').click();
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  const frozen = await stableDrawn(page, CANVAS);
  expect(in36(frozen), 'Customize moved phone tiles').toEqual(in36(autoNow));
  // The second KPI (it shares a row on the phone) becomes full width; the text
  // block is dropped onto the table, which makes room below it.
  const kpi = order(frozen.layout).find((id) => cellOf(frozen, id).w < 36 && f!.charts.some((c) => String(c.tile) === id && c.type === 'KPI'))!;
  const tableTile = String(f!.tile('TABLE'));
  await resizeTile(page, kpi, PHONE, 0);
  const mid = await stableDrawn(page, CANVAS);
  const rowPx = (await domGeometry(page, CANVAS)).boxes.find((b) => b.id === tableTile)!.y
    - (await domGeometry(page, CANVAS)).boxes.find((b) => b.id === text)!.y;
  await dragTile(page, text, 0, rowPx, 40);
  const edited = await stableDrawn(page, CANVAS);
  expect(cellOf(edited, kpi).w, 'the phone KPI did not widen').toBeGreaterThan(cellOf(frozen, kpi).w);
  expect(cellOf(edited, text).y, 'the text block did not move above the table').toBeLessThan(cellOf(edited, tableTile).y);
  expect(cellOf(mid, text).y).toBeGreaterThan(cellOf(mid, tableTile).y);
  expectSaneCells(edited, 'phone custom', tiles);
  await shot(page, '09-builder-phone-custom');
  await saveDraft(page);
  await page.reload();
  await page.waitForSelector(`${CANVAS} [data-tile-id]`);
  const reloaded = await switchDevice(page, 'phone');
  expect(byId(reloaded.layout), 'the phone draft did not survive a reload').toEqual(byId(edited.layout));
  await publishUi(page);
  phoneCustom = edited;
  const v = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v.page, PHONE);
    for (const [label, s] of Object.entries(pub)) {
      expect(s.drawn.source, label).toBe('custom');
      expect(byId(s.drawn.layout), `${label} phone`).toEqual(byId(edited.layout));
    }
    await v.page.setViewportSize({ width: PHONE, height: 900 });
    await v.page.goto(`/d/${f!.token}`);
    await v.page.waitForSelector('[data-tile-id]');
    await shot(v.page, '10-d-phone-custom');
    const t = await dAt(v.page, TABLET);
    expect(byId(t.drawn.layout), 'the phone publish moved the tablet').toEqual(byId(tabletCustom!.layout));
    const d = await dAt(v.page, 1440);
    expect(byId(d.drawn.layout), 'the phone publish moved desktop').toEqual(byId(desktopCells));
  } finally {
    await v.ctx.close();
  }
});

test('11+12 · device changes geometry only: identical rows per tile on Desktop/Tablet/Phone; switching sends zero chart requests', async ({ page, browser }) => {
  // Builder: everything loaded first, then Desktop → Tablet → Phone → Desktop, twice.
  await openBuilder(page, f!.id);
  const net = watchNet(page);
  for (const m of ['tablet', 'phone', 'desktop', 'tablet', 'phone', 'desktop'] as const) await switchDevice(page, m);
  net.stop();
  console.log(`[evidence] Builder device switches x6: chart-data requests=${net.chartData.length}, writes=${net.writes.length}`);
  expect(net.chartData, 'a device switch re-requested chart data').toEqual([]);
  expect(net.writes, 'a device switch wrote something').toEqual([]);
  // Viewers at three widths: the same business rows, tile by tile.
  const v = await viewer(browser);
  try {
    const chartTiles = f!.charts.map((c) => c.tile);
    const rowsAt = async (width: number) => {
      const rows = collectTiles(v.page);
      await dAt(v.page, width);
      await waitForTiles(rows, chartTiles, `/d@${width}`);
      return freeze(rows);
    };
    const desk = await rowsAt(1440);
    for (const width of [TABLET, PHONE]) {
      const other = await rowsAt(width);
      for (const t of chartTiles) expect(other.get(t)?.rows, `tile ${t}: rows differ at ${width}px`).toBe(desk.get(t)?.rows);
    }
    // A loaded /d resized across both breakpoints asks for nothing.
    const pnet = watchNet(v.page);
    for (const [w, bp] of [[TABLET + 40, 'md'], [PHONE + 40, 'xs'], [1480, 'lg']] as const) {
      await v.page.setViewportSize({ width: w, height: 1000 });
      await expect.poll(async () => (await readDrawn(v.page))?.breakpoint).toBe(bp);
      await stableDrawn(v.page);
    }
    pnet.stop();
    console.log(`[evidence] /d resized across devices: chart-data requests=${pnet.chartData.length}`);
    expect(pnet.chartData, '/d re-requested chart data when the width changed').toEqual([]);
  } finally {
    await v.ctx.close();
  }
});

test('27 · minimum size: a tile resized far past its minimum stops at it, stays on the grid, overlaps nothing, stays readable', async ({ page }) => {
  await openBuilder(page, f!.id);
  const t = await switchDevice(page, 'tablet');
  expect(t.source).toBe('custom');
  const kpi = String(f!.tile('KPI'));
  const pie = String(f!.tile('PIE'));
  for (const id of [kpi, pie]) {
    await resizeTile(page, id, -TABLET, -1200);
    const d = await stableDrawn(page, CANVAS);
    const c = cellOf(d, id);
    expect(c.w >= 1 && c.h >= 1, `${id} collapsed ${JSON.stringify(c)}`).toBe(true);
    expectSaneCells(d, `after shrinking ${id}`, tiles);
    const box = (await domGeometry(page, CANVAS)).boxes.find((b) => b.id === id)!;
    expect(box.w, `${id} is narrower than a usable tile`).toBeGreaterThanOrEqual(120);
    expect(box.h, `${id} is shorter than a usable tile`).toBeGreaterThanOrEqual(64);
  }
  await expect(page.locator(`${CANVAS} [data-grid-item-id="${kpi}"]`)).toContainText(/\d/);
  // Not saved: this page is discarded with the test.
});

async function surfaceRows(page: Page, tilesWanted: number[], label: string, act: () => Promise<void>) {
  const rows = collectTiles(page);
  await act();
  await waitForTiles(rows, tilesWanted, label);
  return freeze(rows);
}

test('28 · parameters on the published custom tablet (and a phone smoke): charts change, the layout does not; /d and emb_ agree', async ({ page }) => {
  const bar = f!.tile('BAR');
  const pie = f!.tile('PIE');
  await dAt(page, TABLET);
  const before = await surfaceRows(page, [bar, pie], 'tablet before', async () => { await page.reload(); await visitAll(page); });
  const geo0 = await domGeometry(page);
  const select = (tile: number) => page.locator(`[data-grid-item-id="${tile}"] select`).first();
  const after = await surfaceRows(page, [bar, pie], '/d tablet after the switch', async () => {
    await select(sw.dim).scrollIntoViewIfNeeded();
    await select(sw.dim).selectOption('channel');
    await select(sw.met).selectOption('orders');
    await visitAll(page);
  });
  expect(after.get(bar)!.rows, 'the dimension switch did not change the bar').not.toBe(before.get(bar)!.rows);
  expect(after.get(pie)!.rows, 'the measure switch did not change the pie').not.toBe(before.get(pie)!.rows);
  expectSameBoxes(await domGeometry(page), geo0, 'parameters moved tiles on the custom tablet');
  expect((await readDrawn(page))!.source).toBe('custom');
  // emb_, framed at the same width, with the same choices: the same rows.
  const { frame } = await framedAt(page, host!, `${base()}${f!.emb}`, TABLET);
  const fsel = (tile: number) => frame.locator(`[data-grid-item-id="${tile}"] select`).first();
  const emb = await surfaceRows(page, [bar, pie], 'emb_ tablet after the switch', async () => {
    await fsel(sw.dim).scrollIntoViewIfNeeded();
    await fsel(sw.dim).selectOption('channel');
    await fsel(sw.met).selectOption('orders');
    await visitAll(page, frame);
  });
  for (const t of [bar, pie]) expect(emb.get(t)!.rows, `emb_ tile ${t} differs from /d`).toBe(after.get(t)!.rows);
  // Phone smoke.
  await dAt(page, PHONE);
  await visitAll(page);
  const pgeo = await domGeometry(page);
  const phoneRows = await surfaceRows(page, [pie], '/d phone switch', async () => {
    await select(sw.met).scrollIntoViewIfNeeded();
    await select(sw.met).selectOption('orders');
    await visitAll(page);
  });
  expect(phoneRows.get(pie)!.rows).toBe(after.get(pie)!.rows);
  expectSameBoxes(await domGeometry(page), pgeo, 'a parameter moved tiles on the custom phone');
});

/** Click the first bar of a bar chart with the real mouse at its centre. */
async function clickFirstBar(page: Page, tile: number) {
  const tileHost = page.locator(`[data-grid-item-id="${tile}"]`).first();
  await tileHost.scrollIntoViewIfNeeded();
  const bar = tileHost.locator('.recharts-bar-rectangle path').first();
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('29 · cross-filter on the custom tablet: a real bar click filters the other tiles, the layout holds, a second click restores', async ({ page }) => {
  const bar = f!.tile('BAR');
  const kpis = f!.charts.filter((c) => c.type === 'KPI').map((c) => c.tile);
  await dAt(page, TABLET);
  const base0 = await surfaceRows(page, kpis, 'baseline', async () => { await page.reload(); await visitAll(page); });
  const geo0 = await domGeometry(page);
  const filtered = await surfaceRows(page, kpis, 'after the bar click', async () => {
    await clickFirstBar(page, bar);
    await visitAll(page);
  });
  for (const k of kpis) expect(filtered.get(k)!.rows, `KPI ${k} did not follow the bar selection`).not.toBe(base0.get(k)!.rows);
  expectSameBoxes(await domGeometry(page), geo0, 'a cross-filter moved tiles');
  const cleared = await surfaceRows(page, kpis, 'after clearing', async () => {
    await page.waitForTimeout(400); // past the selection handler's 300 ms double-click guard (supporting only)
    await clickFirstBar(page, bar);
    await visitAll(page);
  });
  for (const k of kpis) expect(cleared.get(k)!.rows, `KPI ${k} did not return to the baseline`).toBe(base0.get(k)!.rows);
  expectSameBoxes(await domGeometry(page), geo0, 'clearing moved tiles');
});

test('30 · date drill on the custom tablet and phone: the series re-buckets, geometry and the custom profile hold; emb_ agrees', async ({ page }) => {
  const ts = f!.tile('TIME_SERIES');
  const drill = async (t: Page | Frame, level: string) => {
    const tileHost = t.locator(`[data-grid-item-id="${ts}"]`).first();
    await tileHost.scrollIntoViewIfNeeded();
    const enable = tileHost.getByRole('button', { name: /group by time|nhóm theo thời gian/i }).first();
    const lv = tileHost.locator(`button[title="${level}"]`).first();
    // The tile mounts when reached: wait until it offers drill one way or the other.
    await expect(enable.or(lv).first(), 'the series offers no date drill').toBeVisible({ timeout: 30_000 });
    if (await enable.isVisible()) await enable.click();
    await expect(lv, 'the drill level is not offered').toBeVisible();
    await lv.click();
  };
  for (const width of [TABLET, PHONE]) {
    await dAt(page, width);
    await visitAll(page);
    const geo0 = await domGeometry(page);
    const q = await surfaceRows(page, [ts], `/d@${width} quarter`, () => drill(page, 'quarter'));
    expect(JSON.parse(q.get(ts)!.rows).length, '24 months = 8 quarters').toBe(8);
    expectSameBoxes(await domGeometry(page), geo0, `drill moved tiles @${width}`);
    expect((await readDrawn(page))!.source, 'drilling reset the device layout').toBe('custom');
    if (width === TABLET) {
      const { frame } = await framedAt(page, host!, `${base()}${f!.emb}`, width);
      const e = await surfaceRows(page, [ts], `emb_@${width} quarter`, () => drill(frame, 'quarter'));
      expect(e.get(ts)!.rows, 'emb_ drill differs from /d').toBe(q.get(ts)!.rows);
    }
  }
});

test('31 · slicer at 390: the control opens on tap, its menu stays in the viewport, a value applies and the charts follow', async ({ page }) => {
  const kpis = f!.charts.filter((c) => c.type === 'KPI').map((c) => c.tile);
  await dAt(page, PHONE);
  const before = await surfaceRows(page, kpis, 'phone baseline', async () => { await page.reload(); await visitAll(page); });
  const card = page.locator('[data-slicer-card]').first();
  await card.scrollIntoViewIfNeeded();
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.width, 'the slicer control is too narrow to operate on a phone').toBeGreaterThanOrEqual(120);
  expect(cardBox.height, 'the slicer control is too short to tap').toBeGreaterThanOrEqual(32);
  await card.getByRole('button').first().click();
  const menu = page.locator('[data-slicer-menu], .dashboard-slicer-menu').first();
  await expect(menu).toBeVisible();
  const mb = (await menu.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(mb.x >= -1 && mb.x + mb.width <= vp.width + 1, `the slicer menu leaves the screen sideways ${JSON.stringify(mb)}`).toBe(true);
  const option = menu.getByText('North', { exact: true }).first();
  await expect(option).toBeVisible();
  await option.scrollIntoViewIfNeeded();
  await expect(option).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/11-d-phone-slicer-open.png` });
  const after = await surfaceRows(page, kpis, 'after the slicer', async () => {
    await option.click();
    const apply = page.getByTestId('slicer-menu-apply');
    if (await apply.count()) await apply.click();
    await visitAll(page);
  });
  for (const k of kpis) expect(after.get(k)!.rows, `KPI ${k} ignored the slicer`).not.toBe(before.get(k)!.rows);
});

test('32 · scroll + lazy load on Phone and Tablet: below-fold tiles wait, mount when reached, load data; nothing above goes blank', async ({ page }) => {
  const table = f!.tile('TABLE');
  for (const width of [PHONE, TABLET]) {
    await page.setViewportSize({ width: width + 40, height: 800 });
    const rows = collectTiles(page);
    await page.goto(`/d/${f!.token}`);
    await page.waitForSelector('[data-report-layout] [data-tile-id]');
    await stableDrawn(page);
    // Not reached yet: the table has neither rows on screen nor an answer.
    await expect(page.locator(`[data-grid-item-id="${table}"] table tbody tr`)).toHaveCount(0);
    expect(rows.has(table), `@${width}: the below-fold table was fetched before it was reached`).toBe(false);
    // A person scrolls down to it.
    await page.locator(`[data-grid-item-id="${table}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[data-grid-item-id="${table}"] table tbody tr`).first(), `@${width}: the table never mounted`).toBeVisible({ timeout: 30_000 });
    await waitForTiles(rows, [table], `@${width} table`);
    freeze(rows);
    // Back to the top: the first KPI still shows its value, the table stays mounted.
    const kpi = f!.tile('KPI');
    await page.locator(`[data-grid-item-id="${kpi}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`[data-grid-item-id="${kpi}"]`)).toContainText(/\d/);
    await expect(page.locator(`[data-grid-item-id="${table}"] table tbody tr`).first()).toBeAttached();
  }
});

test('33 · a panel or overlay that hides or narrows the canvas, with device switches in between, never loses the grid or its lazy tiles', async ({ page }) => {
  const guard = guardErrors(page);
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  const tableTile = f!.tile('TABLE');
  const intact = async (label: string, width: number) => {
    await expect.poll(async () => (await readDrawn(page, CANVAS))?.width, { message: `${label}: the canvas lost its width` }).toBe(width);
    const d = await stableDrawn(page, CANVAS);
    expect(new Set(d.layout.map((c) => c.i)), `${label}: tiles disappeared`).toEqual(new Set(tiles));
    const geo = await domGeometry(page, CANVAS);
    expectSaneBoxes(geo, label, tiles);
    await page.locator(`${CANVAS} [data-grid-item-id="${tableTile}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`${CANVAS} [data-grid-item-id="${tableTile}"] table tbody tr`).first(), `${label}: the below-fold table did not load`).toBeVisible({ timeout: 30_000 });
  };
  // The Inspector narrows the canvas area; switch device while it is open.
  await page.getByTestId('inspector-toggle').click();
  await switchDevice(page, 'phone');
  await page.getByTestId('inspector-toggle').click();
  await intact('after the Inspector', PHONE);
  // The Studio covers the Builder; switch the Studio's device, close it.
  await page.getByTestId('studio-preview-open').click();
  await expect(page.getByTestId('studio-preview')).toBeVisible();
  await page.getByTestId('studio-device-desktop').click();
  await page.getByTestId('studio-device-phone').click();
  await page.getByTestId('studio-close').click();
  await intact('after the Studio overlay', PHONE);
  // The AI design panel takes the side of the screen; switch device under it.
  await page.getByTestId('device-mode-desktop').click();
  await page.getByTestId('design-mode-ai').click();
  await switchDevice(page, 'tablet');
  await page.getByTestId('design-mode-manual').click();
  await intact('after the AI panel', TABLET);
  guard.check();
});

test('13 · Reset Tablet to Auto: a draft until Publish (viewers keep the custom tablet), then every surface is back on the derived layout', async ({ page, browser }) => {
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  await expect(page.getByTestId('device-reset')).toBeVisible();
  await page.getByTestId('device-reset').click();
  await expect(page.getByTestId('device-status-auto')).toBeVisible();
  await expect(page.getByTestId('device-reset')).toHaveCount(0);
  await expect(page.getByTestId('device-customize')).toBeVisible();
  await visitAll(page);
  const autoNow = await stableDrawn(page, CANVAS);
  expect(autoNow.source).toBe('auto');
  expect(byId(autoNow.layout), 'Reset did not return to the derived layout').toEqual(byId(tabletAuto!.layout));
  await saveDraft(page);
  const v = await viewer(browser);
  try {
    expect((await dAt(v.page, TABLET)).drawn.source, 'Reset reached viewers before Publish').toBe('custom');
    await page.reload();
    await page.waitForSelector(`${CANVAS} [data-tile-id]`);
    await switchDevice(page, 'tablet');
    await expect(page.getByTestId('device-status-auto')).toBeVisible();
    await publishUi(page);
    const pub = await everyPublicSurface(v.page, TABLET);
    for (const [label, s] of Object.entries(pub)) {
      expect(s.drawn.source, `${label}: a stale custom tablet still controls the layout`).toBe('auto');
      expect(byId(s.drawn.layout), `${label} is not the derived tablet`).toEqual(byId(autoNow.layout));
    }
    const phone = (await dAt(v.page, PHONE)).drawn;
    expect(phone.source, 'resetting the tablet touched the phone').toBe('custom');
    expect(byId(phone.layout), 'resetting the tablet moved the custom phone').toEqual(byId(phoneCustom!.layout));
  } finally {
    await v.ctx.close();
  }
  tabletCustom = null;
});

test('14 · Regenerate: a desktop drag leaves the custom tablet in place and marks it stale; Regenerate is what refreshes it', async ({ page, browser }) => {
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  await page.getByTestId('device-customize').click();
  await saveDraft(page);
  await publishUi(page);
  const c1 = await stableDrawn(page, CANVAS);
  expect(c1.source).toBe('custom');
  const tableTile = String(f!.tile('TABLE'));
  const ts = String(f!.tile('TIME_SERIES'));
  expect(cellOf(c1, tableTile).y, 'fixture: the table comes after the series').toBeGreaterThan(cellOf(c1, ts).y);
  // Desktop: drag the table onto the time series — the page opens room there.
  await switchDevice(page, 'desktop');
  const g = await domGeometry(page, CANVAS);
  const from = g.boxes.find((b) => b.id === tableTile)!;
  const to = g.boxes.find((b) => b.id === ts)!;
  await dragTile(page, tableTile, to.x - from.x, to.y - from.y, 30);
  const desk = await stableDrawn(page, CANVAS);
  expect(cellOf(desk, tableTile).y, 'the desktop drag did not move the table up').toBeLessThan(cellOf(desktopCells, tableTile).y);
  await saveDraft(page);
  await publishUi(page);
  desktopCells = (await stableDrawn(page, CANVAS)).layout;
  const v = await viewer(browser);
  try {
    expect(byId((await dAt(v.page, TABLET)).drawn.layout), 'a desktop change moved the published custom tablet').toEqual(byId(c1.layout));
  } finally {
    await v.ctx.close();
  }
  const t = await switchDevice(page, 'tablet');
  await expect(page.getByTestId('device-status-stale')).toBeVisible();
  expect(byId(t.layout), 'the stale custom tablet moved by itself').toEqual(byId(c1.layout));
  await shot(page, '12-builder-tablet-stale');
  await page.getByTestId('device-regenerate').click();
  await expect(page.getByTestId('device-status-stale')).toHaveCount(0);
  await expect(page.getByTestId('device-status-custom')).toBeVisible();
  const regen = await stableDrawn(page, CANVAS);
  expect(cellOf(regen, tableTile).y, 'Regenerate did not follow the new desktop order').toBeLessThan(cellOf(regen, ts).y);
  expectSaneCells(regen, 'regenerated tablet', tiles);
  await saveDraft(page);
  await publishUi(page);
  const v2 = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v2.page, TABLET);
    for (const [label, s] of Object.entries(pub)) expect(byId(s.drawn.layout), `${label} after Regenerate`).toEqual(byId(regen.layout));
  } finally {
    await v2.ctx.close();
  }
  tabletCustom = regen;
});

test('15 · a new element added through Add → Text lands below the custom tablet: nothing jumps, Needs review, Add below; viewers agree', async ({ page, request, browser }) => {
  await openBuilder(page, f!.id);
  const known = new Set(tiles);
  await page.getByTestId('add-element-open').click();
  await expect(page.getByTestId('add-element-menu')).toBeVisible();
  await page.getByTestId('add-element-text').click();
  // The new element is staged; an editor for it may open — close it as an author would.
  await expect.poll(async () => ((await editorDoc(request, f!.id)).dashboard_charts as any[]).length, { message: 'Add → Text staged nothing' }).toBeGreaterThan(tiles.length);
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  const added = String(((await editorDoc(request, f!.id)).dashboard_charts as any[]).map((dc) => String(dc.id)).find((id) => !known.has(id)));
  await saveDraft(page);
  await publishUi(page);
  tiles = [...tiles, added];
  const t = await switchDevice(page, 'tablet');
  await expect(page.getByTestId('device-status-needs-review')).toContainText('1');
  await expect(page.getByTestId('device-add-below')).toBeVisible();
  for (const c of tabletCustom!.layout) expect(cellOf(t, c.i), `tile ${c.i} moved when an element was added`).toEqual(c);
  const bottom = Math.max(...tabletCustom!.layout.map((c) => c.y + c.h));
  expect(cellOf(t, added).y, 'the new element is not below the custom layout').toBeGreaterThanOrEqual(bottom);
  expectSaneCells(t, 'tablet with the new element', tiles);
  await shot(page, '13-builder-tablet-needs-review');
  await page.getByTestId('device-add-below').click();
  await expect(page.getByTestId('device-status-needs-review')).toHaveCount(0);
  const placed = await stableDrawn(page, CANVAS);
  await saveDraft(page);
  await publishUi(page);
  const doc = await editorDoc(request, f!.id);
  expect(doc.responsive_layouts.pages['page-1'].md.items[added], 'Add below did not store the element').toBeTruthy();
  const v = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v.page, TABLET);
    for (const [label, s] of Object.entries(pub)) expect(byId(s.drawn.layout), `${label} with the new element`).toEqual(byId(placed.layout));
  } finally {
    await v.ctx.close();
  }
  tabletCustom = placed;
});

test('16 · deleting a tile in the Builder: gone from every surface, no ghost, nothing else reflows on the custom tablet', async ({ page, browser }) => {
  await openBuilder(page, f!.id);
  const gone = String(f!.charts.filter((c) => c.type === 'KPI')[1].tile);
  const tile = page.locator(`${CANVAS} .react-grid-layout > [data-grid-item-id="${gone}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.hover();
  await tile.getByTitle(/remove chart|gỡ biểu đồ|xóa biểu đồ/i).click();
  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect(page.locator(`${CANVAS} [data-grid-item-id="${gone}"]`)).toHaveCount(0);
  await saveDraft(page);
  await publishUi(page);
  tiles = tiles.filter((id) => id !== gone);
  const t = await switchDevice(page, 'tablet');
  expect(t.layout.some((c) => c.i === gone), 'the Builder still draws the deleted tile').toBe(false);
  for (const c of t.layout) expect(c, `tile ${c.i} reflowed after a deletion`).toEqual(cellOf(tabletCustom!, c.i));
  const v = await viewer(browser);
  try {
    const pub = await everyPublicSurface(v.page, TABLET);
    for (const [label, s] of Object.entries(pub)) {
      expect(s.drawn.layout.some((c) => c.i === gone), `${label} still draws the deleted tile`).toBe(false);
      expect(s.geo.boxes.some((b) => b.id === gone), `${label} has a ghost element for the deleted tile`).toBe(false);
      expect(byId(s.drawn.layout), label).toEqual(byId(t.layout));
    }
  } finally {
    await v.ctx.close();
  }
  tabletCustom = t;
});

test('19+20+34+35 · Studio: read-only in every device, same cells as the Builder; Before/After/Compare frames; AI never rewrites a custom layout', async ({ page }) => {
  const guard = guardErrors(page);
  await openBuilder(page, f!.id);
  const builderAt: Record<string, Drawn> = {};
  // Start from a CURRENT custom tablet (the add/delete journeys changed desktop,
  // so it may already be stale): Regenerate locally, nothing is saved.
  await switchDevice(page, 'tablet');
  if (await page.getByTestId('device-status-stale').count()) {
    await page.getByTestId('device-regenerate').click();
    await expect(page.getByTestId('device-status-stale')).toHaveCount(0);
  }
  builderAt.tablet = await stableDrawn(page, CANVAS);
  builderAt.phone = await switchDevice(page, 'phone');
  // Make the phone AUTO again (locally) so the AI's effect on an AUTO device shows.
  await page.getByTestId('device-reset').click();
  await visitAll(page);
  const phoneAutoBefore = await stableDrawn(page, CANVAS);
  expect(phoneAutoBefore.source).toBe('auto');
  // A pending AI redesign (the planner's answer is fixed: no model is called).
  const pie = f!.tile('PIE');
  const plan = { layer: 'structure', direction: {}, structure: { operations: [{ op: 'move_to_top', visuals: [pie] }] } };
  await page.route('**/presentation-plan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan }) }));
  await page.getByTestId('device-mode-desktop').click();
  await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').fill('move the channel chart to the top');
  await page.getByTestId('ai-design-send').click();
  await expect(page.getByTestId('ai-design-apply')).toBeVisible({ timeout: 30_000 });
  // AUTO phone follows the redesigned desktop; the CUSTOM tablet does not move, it is stale.
  const phoneAfter = await switchDevice(page, 'phone');
  expect(order(phoneAfter.layout)[0], 'the AUTO phone did not follow the AI redesign').toBe(String(pie));
  const tabletAfter = await switchDevice(page, 'tablet');
  expect(byId(tabletAfter.layout), 'AI rewrote the custom tablet').toEqual(byId(builderAt.tablet.layout));
  await expect(page.getByTestId('device-status-stale')).toBeVisible();

  const net = watchNet(page);
  await page.getByTestId('studio-preview-open').click();
  for (const v of ['before', 'after', 'compare'] as const) await expect(page.getByTestId(`studio-view-${v}`)).toBeEnabled();
  for (const [device, width] of [['tablet', TABLET], ['phone', PHONE]] as const) {
    await page.getByTestId(`studio-device-${device}`).click();
    await page.getByTestId('studio-view-compare').click();
    const frames = page.locator('[data-testid="studio-preview"] iframe');
    await expect(frames).toHaveCount(2);
    const [a, b] = [(await frames.nth(0).boundingBox())!, (await frames.nth(1).boundingBox())!];
    expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1, `compare frames overlap ${JSON.stringify([a, b])}`).toBe(true);
    const inner: Drawn[] = [];
    for (const handle of await frames.elementHandles()) {
      const fr = (await handle.contentFrame())!;
      await fr.waitForSelector(`${CANVAS} [data-tile-id]`, { timeout: 60_000 });
      const d = await stableDrawn(fr, CANVAS);
      // Each frame is a whole device of that width: its report is the width minus the gutter.
      expect(d.breakpoint, `${device} compare frame band`).toBe(device === 'tablet' ? 'md' : 'xs');
      expect(d.width > width - 64 && d.width <= width, `${device} compare frame report width ${d.width}`).toBe(true);
      inner.push(d);
      // Read-only: nothing to grab, nothing to resize.
      await expect(fr.locator(`${CANVAS} .react-resizable-handle:visible`)).toHaveCount(0);
      await expect(fr.locator(`${CANVAS} .react-grid-item.react-draggable`)).toHaveCount(0);
    }
    await page.screenshot({ path: `${SHOTS}/14-studio-compare-${device}.png` });
    // A drag attempt inside the After frame.
    const first = (await frames.nth(1).elementHandle())!;
    const fr = (await first.contentFrame())!;
    const target = fr.locator(`${CANVAS} .react-grid-layout > [data-grid-item-id]`).first();
    const tb = (await target.boundingBox())!;
    await page.mouse.move(tb.x + 20, tb.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb.x + 20, tb.y + 160, { steps: 12 });
    await page.mouse.up();
    expect(byId((await stableDrawn(fr, CANVAS)).layout), `${device}: a drag moved a tile in the Studio`).toEqual(byId(inner[1].layout));
    if (device === 'tablet') expect(byId(inner[1].layout), 'Studio tablet (after) differs from the Builder tablet').toEqual(byId(tabletAfter.layout));
    // The phone is AUTO here: content fit runs at each frame's own report width
    // (the Studio frames a whole 390px device), so heights may differ — the
    // tiles and their reading order may not.
    if (device === 'phone') {
      expect(inner[1].source).toBe('auto');
      expect(order(inner[1].layout), 'Studio phone (after) reads in another order than the Builder phone').toEqual(order(phoneAfter.layout));
    }
    await page.getByTestId('studio-view-after').click();
    await expect(frames).toHaveCount(1);
  }
  // Ctrl+S with focus inside the Studio frame (the drag above clicked into it).
  await page.keyboard.press('Control+s');
  net.stop();
  // Attribute every write to the document that sent it: the Studio frames are
  // read-only; the Builder page underneath keeps its own lock heartbeat.
  const fromStudio = net.frameWrites.filter((w) => /studio=preview/.test(w.frame));
  const fromBuilder = net.frameWrites.filter((w) => !/studio=preview/.test(w.frame)).map((w) => w.write);
  console.log(`[evidence] Studio frames (devices, views, a drag, Ctrl+S): writes=${fromStudio.length}; Builder page meanwhile: ${fromBuilder.join(', ') || 'none'}`);
  expect(fromStudio, 'a Studio frame wrote something').toEqual([]);
  // …and nothing the author sees in the Studio saved the work under it (Ctrl+S included).
  const layoutWrite = /\/dashboards\/\d+\/(layout|draft-layout|relayout|draft-responsive|draft-filters)(\?|$)/;
  expect(fromBuilder.filter((w) => layoutWrite.test(w)), 'the Builder saved while the Studio was open').toEqual([]);
  await page.getByTestId('studio-close').click();
  // Back in the Builder: the device and the pending redesign are as they were.
  await expect(page.getByTestId('device-mode-tablet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('ai-design-apply')).toBeVisible();
  expect(byId((await stableDrawn(page, CANVAS)).layout)).toEqual(byId(tabletAfter.layout));
  await page.getByTestId('ai-design-discard').click();
  await expect(page.getByTestId('device-status-stale')).toHaveCount(0);
  // The AI critique needs a language model; this stack runs without one
  // (E2E_NO_MODEL), so that one call answers 503 by design. Nothing else may fail.
  guard.check([/^http 503 POST \/api\/v1\/dashboards\/\d+\/presentation-critique$/]);
});

test('36 · PDF/print renders the DESKTOP layout whatever device layouts exist or which device the author last viewed', async ({ page }) => {
  // The PDF worker opens /d/<token>?print=1. Open it at a tablet-sized window.
  await page.setViewportSize({ width: TABLET, height: 1100 });
  await page.goto(`/d/${f!.token}?print=1`);
  await page.waitForSelector('[data-print-band]', { timeout: 60_000 });
  const boxes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-print-band] [data-tile-id]')]
    .map((el) => [(el as HTMLElement).dataset.tileId, (({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }))(el.getBoundingClientRect())])));
  // Desktop cells decide the arrangement: tiles on one desktop row print side by
  // side, in the desktop's left-to-right order.
  const rows = new Map<number, Cell[]>();
  for (const c of desktopCells.filter((x) => tiles.includes(x.i) && boxes[x.i])) rows.set(c.y, [...(rows.get(c.y) ?? []), c]);
  let checked = 0;
  for (const cells of rows.values()) {
    if (cells.length < 2) continue;
    const sorted = [...cells].sort((a, b) => a.x - b.x);
    for (let k = 1; k < sorted.length; k += 1) {
      expect(Math.abs(boxes[sorted[k].i].y - boxes[sorted[0].i].y), `print: ${sorted[k].i} is not on ${sorted[0].i}'s desktop row`).toBeLessThanOrEqual(2);
      expect(boxes[sorted[k].i].x, `print: ${sorted[k].i} is not right of ${sorted[k - 1].i}`).toBeGreaterThan(boxes[sorted[k - 1].i].x);
      checked += 1;
    }
  }
  expect(checked, 'no desktop row with two tiles was printed').toBeGreaterThan(0);
  expect(await page.locator('[data-report-layout-source="custom"]').count(), 'print drew a device layout').toBe(0);
});

test('46 · Save failure: the author is told, the edit stays on screen, nothing claims Saved; the retry saves', async ({ page }) => {
  await openBuilder(page, f!.id);
  await switchDevice(page, 'tablet');
  const pie = String(f!.tile('PIE'));
  const before = await stableDrawn(page, CANVAS);
  await resizeTile(page, pie, 0, 2 * 32);
  const edited = await stableDrawn(page, CANVAS);
  expect(cellOf(edited, pie).h).toBeGreaterThan(cellOf(before, pie).h);
  // A controlled server failure on the device-draft write (a write endpoint, not viewer data).
  await page.route('**/draft-responsive', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Injected failure for the e2e save test' }) }));
  await page.getByTestId('dashboard-save-draft').click();
  await expect(page.getByText(/failed to save draft|không lưu được bản nháp/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dashboard-save-draft')).not.toHaveAttribute('data-state', 'saved');
  expect(byId((await stableDrawn(page, CANVAS)).layout), 'the failed save lost the edit').toEqual(byId(edited.layout));
  await page.unroute('**/draft-responsive');
  await saveDraft(page);
  await page.reload();
  await page.waitForSelector(`${CANVAS} [data-tile-id]`);
  expect(byId((await switchDevice(page, 'tablet')).layout), 'the retried save did not persist').toEqual(byId(edited.layout));
});

test('47 · two editors, one tablet layout: the second Publish meets the conflict dialog, nothing is overwritten silently, Overwrite is a choice', async ({ page, request, browser }) => {
  // A second author: a real account with the editor preset and edit access to the report.
  const email = `e2e-resp-b-${Date.now()}@appbi.io`;
  const password = `Resp-${Math.random().toString(36).slice(2, 10)}-9`;
  const u = await request.post(`${V1}/users/`, { data: { email, full_name: 'E2E Responsive B', password, auth_provider: 'password' } });
  expect(u.status(), await u.text()).toBe(201);
  const userId = (await u.json()).id as string;
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: { cookies: [], origins: [] } });
  try {
    expect((await request.put(`${V1}/permissions/${userId}/preset`, { data: { preset: 'editor' } })).status()).toBe(200);
    const share = await request.post(`${V1}/shares/dashboard/${f!.id}`, { data: { email, permission: 'edit' } });
    expect(share.status(), await share.text()).toBe(201);
    const pageB = await ctxB.newPage();
    await pageB.goto('/login');
    await pageB.locator('input[type="email"], input[name="email"]').first().fill(email);
    await pageB.locator('input[type="password"]').first().fill(password);
    await pageB.locator('input[type="password"]').first().press('Enter');
    await pageB.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    // One page is edited by one author at a time (the page lock: a second author
    // sees "view only"). The real conflict is therefore SEQUENTIAL: A saves a
    // tablet draft and leaves; B edits the same tablet and publishes; A comes
    // back to the draft A started from the older published revision.
    const kpi = String(f!.tile('KPI'));
    const table = String(f!.tile('TABLE'));
    await openBuilder(page, f!.id);
    await switchDevice(page, 'tablet');
    await resizeTile(page, table, 0, 2 * 32);
    const aLayout = await stableDrawn(page, CANVAS);
    await saveDraft(page);
    await page.goto('about:blank');

    // B: waits for the page to be free (the lock leaves with A), edits, publishes.
    await pageB.setViewportSize({ width: 1600, height: 1000 });
    await expect.poll(async () => {
      await pageB.goto(`/dashboards/${f!.id}`);
      await pageB.waitForSelector(`${CANVAS} [data-tile-id]`, { timeout: 60_000 });
      return pageB.getByText(/is editing this page|đang sửa trang này/i).count();
    }, { message: "A's page lock never released", timeout: 180_000, intervals: [10_000] }).toBe(0);
    await visitAll(pageB);
    await switchDevice(pageB, 'tablet');
    await expect(pageB.getByTestId('device-status-custom')).toBeVisible();
    await resizeTile(pageB, kpi, -6 * (TABLET / 36), 0);
    const bLayout = await stableDrawn(pageB, CANVAS);
    await saveDraft(pageB);
    await publishUi(pageB);
    await pageB.goto('about:blank');
    const v = await viewer(browser);
    try {
      expect(byId((await dAt(v.page, TABLET)).drawn.layout), "B's publish is not what viewers see").toEqual(byId(bLayout.layout));
      // A returns: A's own draft is still there, started from the older revision.
      await expect.poll(async () => {
        await page.goto(`/dashboards/${f!.id}`);
        await page.waitForSelector(`${CANVAS} [data-tile-id]`, { timeout: 60_000 });
        return page.getByText(/is editing this page|đang sửa trang này/i).count();
      }, { message: "B's page lock never released", timeout: 180_000, intervals: [10_000] }).toBe(0);
      const back = await switchDevice(page, 'tablet');
      expect(byId(back.layout), "A's saved draft was lost").toEqual(byId(aLayout.layout));
      // Publish meets the conflict dialog, never a silent overwrite.
      await page.getByTestId('dashboard-publish').click();
      const dialog = page.getByTestId('publish-conflict');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/15-builder-publish-conflict.png` });
      await dialog.getByRole('button', { name: /^later$|^để sau$/i }).click();
      await expect(dialog).toHaveCount(0);
      expect(byId((await dAt(v.page, TABLET)).drawn.layout), "A's publish silently overwrote B's").toEqual(byId(bLayout.layout));
      // A decides to overwrite, knowingly.
      await page.getByTestId('dashboard-publish').click();
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole('button', { name: /^overwrite$|^ghi đè$/i }).click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => JSON.stringify(byId((await dAt(v.page, TABLET)).drawn.layout)), { message: "A's overwrite never reached viewers", timeout: 60_000 }).toBe(JSON.stringify(byId(aLayout.layout)));
    } finally {
      await v.ctx.close();
    }
  } finally {
    await ctxB.close();
    await request.delete(`${V1}/users/${userId}`).catch(() => {});
  }
});
