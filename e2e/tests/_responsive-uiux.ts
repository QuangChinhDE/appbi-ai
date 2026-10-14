import { expect, type Frame, type Page, type Request } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Shared helpers for the device-layout UI/UX acceptance suite
 * (dashboard-responsive-uiux*.spec.ts). Everything here OBSERVES the product —
 * the DOM a user sees, the requests the page sends — and drives it with real
 * pointer and keyboard input. Nothing injects state, calls a React callback or
 * mocks a public data route.
 */

export const TABLET = 820;
export const PHONE = 390;
export const CANVAS = '[data-dashboard-canvas-root]';

export type Cell = { i: string; x: number; y: number; w: number; h: number };
/** What a surface says it drew (data-report-* on its report container). */
export type Drawn = { width: number; breakpoint: string; cols: number; source: string; layout: Cell[] };
/** A tile as the browser rendered it, relative to its report grid, in CSS px. */
export type Box = { id: string; x: number; y: number; w: number; h: number };
export type Geo = { gridWidth: number; boxes: Box[] };
type Target = Page | Frame;

export const byId = <T extends { i: string }>(cells: T[]) => [...cells].sort((a, b) => Number(a.i) - Number(b.i));
export const order = (cells: Cell[]) => [...cells].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.i);
/** Cells in the 36-column authoring grid (the AUTO phone stack is 2-column). */
export const in36 = (d: Drawn) => byId(d.layout.map((c) => ({ ...c, x: (c.x * 36) / d.cols, w: (c.w * 36) / d.cols })));
export const cellOf = (d: Drawn | Cell[], id: string) => (Array.isArray(d) ? d : d.layout).find((c) => c.i === id)!;

export async function readDrawn(t: Target, scope = 'body'): Promise<Drawn | null> {
  return t.evaluate((sel) => {
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

/** The drawn layout once it has settled: the same value read twice, 1.2 s apart
 *  (the AUTO content fit measures at 120 / 1200 / 3500 ms). A state wait, not a sleep. */
export async function stableDrawn(t: Target, scope = 'body'): Promise<Drawn> {
  let last = '';
  let value: Drawn | null = null;
  await expect.poll(async () => {
    value = await readDrawn(t, scope);
    const key = JSON.stringify(value);
    const same = key === last && value !== null && value.width > 0;
    last = key;
    return same;
  }, { message: 'the report never settled on one layout', timeout: 45_000, intervals: [1200] }).toBe(true);
  return value!;
}

/** Tile boxes as rendered, relative to the report grid (never page coordinates). */
export async function domGeometry(t: Target, scope = 'body'): Promise<Geo> {
  return t.evaluate((sel) => {
    const grid = document.querySelector(`${sel} .react-grid-layout`) as HTMLElement | null;
    const g = grid?.getBoundingClientRect();
    const boxes = [...document.querySelectorAll(`${sel} .react-grid-layout > [data-grid-item-id]`)].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: (el as HTMLElement).dataset.gridItemId || '',
        x: Math.round(r.left - (g?.left ?? 0)), y: Math.round(r.top - (g?.top ?? 0)),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    }).filter((b) => b.id).sort((a, b) => Number(a.id) - Number(b.id));
    return { gridWidth: Math.round(g?.width ?? 0), boxes };
  }, scope);
}

/** Two renders of the same layout agree tile by tile within `tol` CSS px
 *  (sub-pixel rounding between the layout engine and the browser). */
export function expectSameBoxes(actual: Geo, expected: Geo, label: string, tol = 2) {
  expect(actual.boxes.map((b) => b.id), `${label}: different tiles`).toEqual(expected.boxes.map((b) => b.id));
  for (const e of expected.boxes) {
    const a = actual.boxes.find((b) => b.id === e.id)!;
    const off = Math.max(Math.abs(a.x - e.x), Math.abs(a.y - e.y), Math.abs(a.w - e.w), Math.abs(a.h - e.h));
    expect(off, `${label}: tile ${e.id} drawn at ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`).toBeLessThanOrEqual(tol);
  }
}

/**
 * The same layout drawn at two report widths inside one band (e.g. the Studio's
 * 820px device frame, whose report is 820 minus the page gutter, and the Builder's
 * 820px report canvas): horizontal position and width agree as a FRACTION of the
 * grid (±0.6%), vertical position and height in CSS px (row height does not
 * depend on width).
 */
export function expectSameNormalized(actual: Geo, expected: Geo, label: string, tolPx = 2) {
  expect(actual.boxes.map((b) => b.id), `${label}: different tiles`).toEqual(expected.boxes.map((b) => b.id));
  for (const e of expected.boxes) {
    const a = actual.boxes.find((b) => b.id === e.id)!;
    // Margins are fixed CSS px (16) and do not scale: normalise what is between them.
    const M = 16;
    const fx = Math.abs((a.x - M) / (actual.gridWidth - 2 * M) - (e.x - M) / (expected.gridWidth - 2 * M));
    const fw = Math.abs((a.w + M) / (actual.gridWidth - M) - (e.w + M) / (expected.gridWidth - M));
    expect(Math.max(fx, fw), `${label}: tile ${e.id} sits at another horizontal place ${JSON.stringify({ a, aw: actual.gridWidth, e, ew: expected.gridWidth })}`).toBeLessThanOrEqual(0.006);
    expect(Math.max(Math.abs(a.y - e.y), Math.abs(a.h - e.h)), `${label}: tile ${e.id} sits at another height ${JSON.stringify({ a, e })}`).toBeLessThanOrEqual(tolPx);
  }
}

/** Every tile has a size, sits inside the grid and overlaps no other tile. */
export function expectSaneBoxes(geo: Geo, label: string, tiles?: string[]) {
  if (tiles) expect(new Set(geo.boxes.map((b) => b.id)), `${label}: a tile is missing or extra`).toEqual(new Set(tiles));
  for (const b of geo.boxes) {
    expect(b.w > 0 && b.h > 0, `${label}: tile ${b.id} has no size ${JSON.stringify(b)}`).toBe(true);
    expect(b.x >= -1 && b.x + b.w <= geo.gridWidth + 1, `${label}: tile ${b.id} is off the ${geo.gridWidth}px grid ${JSON.stringify(b)}`).toBe(true);
  }
  for (let i = 0; i < geo.boxes.length; i += 1) for (let j = i + 1; j < geo.boxes.length; j += 1) {
    const p = geo.boxes[i]; const q = geo.boxes[j];
    const hit = p.x < q.x + q.w - 1 && q.x < p.x + p.w - 1 && p.y < q.y + q.h - 1 && q.y < p.y + p.h - 1;
    expect(hit, `${label}: tiles ${p.id} and ${q.id} overlap`).toBe(false);
  }
}

/** Grid cells: on the grid, sized, not overlapping, exactly the expected tiles. */
export function expectSaneCells(d: Drawn, label: string, tiles: string[]) {
  expect(new Set(d.layout.map((c) => c.i)), `${label}: a tile is missing or extra`).toEqual(new Set(tiles));
  for (const c of d.layout) {
    expect(c.x >= 0 && c.y >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= d.cols, `${label}: tile ${c.i} off the ${d.cols}-column grid ${JSON.stringify(c)}`).toBe(true);
  }
  const s = [...d.layout];
  for (let a = 0; a < s.length; a += 1) for (let b = a + 1; b < s.length; b += 1) {
    const p = s[a]; const q = s[b];
    expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${label}: tiles ${p.i} and ${q.i} overlap`).toBe(false);
  }
}

/** The page and the report container do not scroll sideways. */
export async function expectNoHorizontalOverflow(t: Target, label: string, scope = 'body') {
  const o = await t.evaluate((sel) => {
    const report = document.querySelector(`${sel} [data-report-layout]`) as HTMLElement | null;
    const doc = document.documentElement;
    return {
      page: doc.scrollWidth - doc.clientWidth,
      report: report ? report.scrollWidth - report.clientWidth : 0,
    };
  }, scope);
  expect(o.page, `${label}: the page scrolls sideways by ${o.page}px`).toBeLessThanOrEqual(1);
  expect(o.report, `${label}: the report container overflows by ${o.report}px`).toBeLessThanOrEqual(1);
}

// In-flight chart-data requests per page, by the frame that sent them. A
// navigation ends its document's requests — some are aborted without any
// finished/failed event — so a frame's entries are dropped when it navigates.
const inflight = new WeakMap<Page, { pending: Map<Request, { frame: Frame; at: number }>; navAt: WeakMap<Frame, number>; lastChange: number }>();

function trackData(page: Page) {
  let state = inflight.get(page);
  if (state) return state;
  const s = { pending: new Map<Request, { frame: Frame; at: number }>(), navAt: new WeakMap<Frame, number>(), lastChange: Date.now() };
  inflight.set(page, s);
  page.on('request', (r) => { if (CHART_DATA.test(r.url())) { s.pending.set(r, { frame: r.frame(), at: Date.now() }); s.lastChange = Date.now(); } });
  const done = (r: Request) => { if (s.pending.delete(r)) s.lastChange = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('framenavigated', (fr) => { s.navAt.set(fr, Date.now()); });
  state = s;
  return state;
}

/** Resolve once no chart-data request has been pending for `quietMs`. */
export async function dataSettled(page: Page, quietMs = 1500, timeout = 60_000) {
  const s = trackData(page);
  // A request sent by a document its frame has since navigated away from is gone
  // with it (some are aborted without a finished/failed event).
  const live = () => [...s.pending].filter(([, p]) => (s.navAt.get(p.frame) ?? 0) <= p.at);
  await expect.poll(() => { for (const [r, p] of s.pending) if ((s.navAt.get(p.frame) ?? 0) > p.at) s.pending.delete(r); return live().length === 0 && Date.now() - s.lastChange >= quietMs; }, {
    message: `chart-data requests never went quiet (${live().map(([r]) => r.url().replace(/^https?:\/\/[^/]+/, '').replace(/dashboards\/[^/]+\//, 'dashboards/<t>/')).join(', ')})`,
    timeout, intervals: [250],
  }).toBe(true);
}

/** Scroll every scroll container to the bottom in viewport-sized steps and back,
 *  so lazily mounted tiles mount; then wait for chart data to go quiet. */
export async function visitAll(page: Page, t: Target = page) {
  // The report must be on screen first (a fresh load or reload draws it a moment later).
  await t.waitForSelector('[data-report-layout] [data-tile-id]', { timeout: 60_000 });
  await t.evaluate(async () => {
    const scrollers = [document.scrollingElement as HTMLElement,
      ...[...document.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
      }) as HTMLElement[]].filter(Boolean);
    for (const el of scrollers) {
      for (let y = 0; y <= el.scrollHeight; y += Math.max(200, el.clientHeight * 0.8)) {
        el.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      el.scrollTop = 0;
    }
  });
  await dataSettled(page);
}

// ── Builder ─────────────────────────────────────────────────────────────────

export async function openBuilder(page: Page, id: number) {
  trackData(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/dashboards/${id}`);
  await page.waitForSelector(`${CANVAS} [data-tile-id]`, { timeout: 60_000 });
  await visitAll(page);
}

const BP = { desktop: 'lg', tablet: 'md', phone: 'xs' } as const;
export type Device = keyof typeof BP;

/** Switch the Builder's device with its visible control; wait for the canvas to draw it. */
export async function switchDevice(page: Page, mode: Device): Promise<Drawn> {
  const button = page.getByTestId(`device-mode-${mode}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await readDrawn(page, CANVAS))?.breakpoint, { message: `the Builder never drew ${mode}` }).toBe(BP[mode]);
  return stableDrawn(page, CANVAS);
}

/** Save draft through its button. Some edits (adding an element) are staged into
 *  the draft as they are made: the button then already says Saved and is
 *  disabled — that state is asserted, not skipped. */
export async function saveDraft(page: Page) {
  const save = page.getByTestId('dashboard-save-draft');
  await expect(save).toBeVisible();
  if (await save.isEnabled()) await save.click();
  await expect(save).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
}

/** Publish through the visible control; done when the Builder has nothing left to publish. */
export async function publishUi(page: Page) {
  const publish = page.getByTestId('dashboard-publish');
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(publish).toHaveCount(0, { timeout: 30_000 });
}

/** Mouse-drag a tile by its drag handle through `steps` intermediate points. */
export async function dragTile(page: Page, tile: string, dx: number, dy: number, steps = 12) {
  const item = page.locator(`${CANVAS} .react-grid-layout > [data-grid-item-id="${tile}"]`);
  const handle = item.locator('.drag-handle').first();
  await handle.scrollIntoViewIfNeeded();
  await expect(handle, `tile ${tile} has no visible drag handle`).toBeVisible();
  const box = (await handle.boundingBox())!;
  const sx = box.x + Math.min(40, box.width / 2);
  const sy = box.y + Math.min(10, box.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= steps; k += 1) await page.mouse.move(sx + (dx * k) / steps, sy + (dy * k) / steps);
  await page.mouse.up();
}

/** Mouse-drag a tile's south-east resize handle. The handle must be visible and
 *  inside the viewport — an author cannot use one that is not. */
export async function resizeTile(page: Page, tile: string, dx: number, dy: number, steps = 8) {
  const handle = page.locator(`${CANVAS} .react-grid-layout > [data-grid-item-id="${tile}"] > .react-resizable-handle-se`);
  await handle.scrollIntoViewIfNeeded();
  await expect(handle, `tile ${tile} has no usable resize handle`).toBeVisible();
  const box = (await handle.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height,
    `tile ${tile}: its resize handle is outside the viewport ${JSON.stringify(box)}`).toBe(true);
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= steps; k += 1) await page.mouse.move(sx + (dx * k) / steps, sy + (dy * k) / steps);
  await page.mouse.up();
}

// ── Observation ─────────────────────────────────────────────────────────────

const CHART_DATA = /\/api\/v1\/(public\/dashboards\/[^/]+\/)?charts\/(\d+\/)?data/;
const LAYOUT_WRITE = /\/dashboards\/\d+\/(layout|draft-layout|relayout|draft-responsive)(\?|$)/;

export type Net = { chartData: string[]; responsiveWrites: string[]; layoutWrites: string[]; writes: string[]; frameWrites: Array<{ write: string; frame: string }>; stop: () => void };

/** Count what the page sends from now on. */
export function watchNet(page: Page): Net {
  const net: Net = { chartData: [], responsiveWrites: [], layoutWrites: [], writes: [], frameWrites: [], stop: () => {} };
  const on = (r: Request) => {
    const url = r.url().replace(/^https?:\/\/[^/]+/, '');
    if (CHART_DATA.test(url)) net.chartData.push(url);
    if (r.method() === 'GET') return;
    net.writes.push(`${r.method()} ${url}`);
    let frame = '';
    try { frame = r.frame().url(); } catch { /* a service-worker request has no frame */ }
    net.frameWrites.push({ write: `${r.method()} ${url}`, frame });
    if (/\/draft-responsive(\?|$)/.test(url)) net.responsiveWrites.push(`${r.method()} ${url}`);
    if (LAYOUT_WRITE.test(url)) net.layoutWrites.push(`${r.method()} ${url}`);
  };
  page.on('request', on);
  net.stop = () => page.off('request', on);
  return net;
}

// Browser noise that is not this feature: a missing favicon, the dev-only React
// warning channel, an aborted request superseded by navigation.
const NOISE = [/favicon/i, /Download the React DevTools/i, /net::ERR_ABORTED/i];

/** Collect uncaught page errors and console errors for one test. */
export function guardErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (NOISE.some((n) => n.test(text))) return;
    // The browser's "Failed to load resource" line names no URL: the server
    // error itself is recorded below, with its method and path.
    if (/^Failed to load resource: the server responded with a status of 5\d\d/.test(text)) return;
    errors.push(`console: ${text.slice(0, 300)}`);
  });
  page.on('response', (res) => {
    if (res.status() < 500) return;
    errors.push(`http ${res.status()} ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, '').replace(/\/(d|embed|public\/dashboards)\/[^/?]+/, '/$1/<t>').slice(0, 200)}`);
  });
  return {
    errors,
    /** Fail on any uncaught error; console errors are failures unless `allow` explains them. */
    check(allow: RegExp[] = []) {
      const real = errors.filter((e) => e.startsWith('pageerror') || !allow.some((a) => a.test(e)));
      expect(real, 'the browser reported errors').toEqual([]);
    },
  };
}

// ── Real iframe hosts (a different origin, like an application embedding the report) ──

const servers: http.Server[] = [];

/** A host page on 127.0.0.1:<port> framing `src` in an iframe `width` CSS px wide. */
export async function iframeHost(): Promise<{ origin: string; url: (src: string, width: number) => string }> {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url || '/', 'http://x').searchParams;
    const src = q.get('src') || 'about:blank';
    const width = Number(q.get('w') || 820);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0;background:#888">
      <iframe id="report" src="${src.replace(/"/g, '&quot;')}" style="width:${width}px;height:1000px;border:0;display:block"
        referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, url: (src, width) => `${origin}/?w=${width}&src=${encodeURIComponent(src)}` };
}

export function closeHosts() {
  for (const s of servers.splice(0)) s.close();
}

/** The report frame inside a host page. */
export async function reportFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('#report');
  const frame = await handle.contentFrame();
  expect(frame, 'the host page has no report frame').toBeTruthy();
  await frame!.waitForSelector('[data-report-layout] [data-tile-id]', { timeout: 60_000 });
  return frame!;
}

/**
 * Open `src` in a host iframe so the REPORT CONTAINER inside it is exactly
 * `width` px (the iframe is widened by the report's own gutter, measured).
 * The outer browser keeps its desktop viewport and user agent throughout.
 */
export async function framedAt(page: Page, host: { url: (src: string, w: number) => string }, src: string, width: number): Promise<{ frame: Frame; drawn: Drawn }> {
  trackData(page);
  let frameWidth = width + 40;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(host.url(src, frameWidth));
    const frame = await reportFrame(page);
    const drawn = await stableDrawn(frame);
    if (drawn.width === width) return { frame, drawn };
    frameWidth += width - drawn.width;
  }
  throw new Error(`could not make the framed report container ${width}px wide`);
}
