import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Report Studio V3 — Unified Grid & Slicer Freedom, scenarios S1–S14, driven as
 * an author and a viewer on a production build, with the real planner model.
 * (S15 is the V3 acceptance suite itself: acceptance/report-studio-v3.spec.ts.)
 *
 * The API is used only for FIXTURES a person would not build by hand in a test
 * (a copy of the baseline, a public link, a second page). Every authoring action
 * under test — placing, moving, resizing, restyling a slicer, arranging, undo,
 * publish, AI Design — is done through the UI.
 *
 * Evidence: docs/features/report-studio-v3/unified-grid/evidence. A scenario
 * stays NOT VERIFIED until an assertion ran; a skip is never a pass.
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const DASH = `${API}/api/v1/dashboards`;
const EVIDENCE = path.resolve(__dirname, '..', '..', 'docs', 'features', 'report-studio-v3', 'unified-grid', 'evidence');
const OLIST = process.env.ACCEPT_OLIST_DASHBOARD || 'Olist commercial review';
const SALES_DATASET = 'E2E presentation sales';

type Status = 'PASS' | 'FAIL' | 'NOT VERIFIED';
interface ScenarioResult { status: Status; assertions: string[]; metrics: Record<string, unknown>; evidence: string[]; notes: string[] }
const results: Record<string, ScenarioResult> = {};
const made: number[] = [];

let active: string[] = [];
function scenario(name: string): ScenarioResult {
  results[name] = results[name] ?? { status: 'NOT VERIFIED', assertions: [], metrics: {}, evidence: [], notes: [] };
  if (!active.includes(name)) active.push(name);
  return results[name];
}
function need<T>(r: ScenarioResult, value: T | undefined, what: string): T {
  if (value === undefined || value === null) {
    r.status = 'NOT VERIFIED';
    r.notes.push(`${what} is missing on this environment`);
    throw new Error(`${what} is missing — scenario NOT VERIFIED`);
  }
  return value;
}
function check(r: ScenarioResult, label: string, ok: boolean, detail = '') {
  r.assertions.push(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) r.status = 'FAIL';
  else if (r.status === 'NOT VERIFIED' && !r.notes.some((n) => /NOT VERIFIED|missing/.test(n))) r.status = 'PASS';
  expect.soft(ok, `${label} ${detail}`).toBe(true);
}

const RESULTS = path.join(EVIDENCE, 'results.json');
function persist() {
  let prior: any = {};
  try { prior = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { prior = {}; }
  const sha = process.env.ACCEPT_SHA ?? prior.sha ?? '';
  fs.writeFileSync(RESULTS, JSON.stringify({ sha, ranAt: new Date().toISOString(), results: { ...(prior.results ?? {}), ...results } }, null, 2));
}
test.beforeAll(() => { fs.mkdirSync(EVIDENCE, { recursive: true }); });
// A test that threw did not pass, whatever its assertions said before the
// throw. Only a missing fixture (need()) leaves a scenario NOT VERIFIED.
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
    for (const name of active) {
      const r = results[name];
      if (!r) continue;
      const missing = r.notes.some((n) => /missing on this environment/.test(n));
      if (!missing) {
        r.status = 'FAIL';
        r.assertions.push(`FAIL — the scenario stopped: ${String(testInfo.error?.message ?? testInfo.status).split(/\r?\n/)[0].slice(0, 240)}`);
      }
    }
  }
  active = [];
  persist();
});
test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`${DASH}/${id}`).catch(() => {});
  persist();
});

// ── fixtures (API) ─────────────────────────────────────────────────────────

async function dashboards(request: APIRequestContext): Promise<any[]> {
  const res = await request.get(`${DASH}/?limit=300`);
  return res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
}
async function idOf(request: APIRequestContext, name: string) {
  return (await dashboards(request)).find((d) => d.name === name)?.id as number | undefined;
}
async function copyOf(request: APIRequestContext, sourceId: number) {
  const dup = await request.post(`${DASH}/${sourceId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  made.push(d.id);
  return d.id as number;
}
async function linkFor(request: APIRequestContext, id: number, filters?: any[]) {
  const link = await request.post(`${DASH}/${id}/public-links`, { data: { name: 'unified-grid', ...(filters ? { filters_config: filters } : {}) } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  return (await link.json()).token as string;
}
const get = (request: APIRequestContext, id: number) => request.get(`${DASH}/${id}`).then((r) => r.json());
const controlsOf = (d: any) => (d.dashboard_charts ?? []).filter((c: any) => c.widget_type === 'slicer');

// ── page helpers ───────────────────────────────────────────────────────────

async function scrollAll(page: Page) {
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) { for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } el.scrollTo(0, 0); }
  });
}
async function settle(page: Page) {
  await page.waitForSelector('[data-grid-item-id], [data-tile-id]', { timeout: 60_000 });
  await scrollAll(page);
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function shot(page: Page, r: ScenarioResult, name: string) {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    const inner = Array.from(document.querySelectorAll('main, div')).reduce((acc, e) => Math.max(acc, (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) ? (e as HTMLElement).scrollHeight + e.getBoundingClientRect().top : 0), 0);
    return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0, inner);
  });
  await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 8000) });
  await page.waitForTimeout(1400);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: true, type: 'jpeg', quality: 62 });
  await page.setViewportSize(vp);
  r.evidence.push(file);
}
async function audit(page: Page) {
  return page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<null | { findings: Array<{ code: string; tileId: number; detail: string }> }>;
}
const HARD = ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'];

const rects = (page: Page) => page.evaluate(() => {
  const g = document.querySelector('main .react-grid-layout')?.getBoundingClientRect();
  return Object.fromEntries(Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    return [e.getAttribute('data-grid-item-id'), [Math.round(b.x - (g?.x ?? 0)), Math.round(b.y - (g?.y ?? 0)), Math.round(b.width), Math.round(b.height)]];
  }));
}) as Promise<Record<string, number[]>>;

/** The numbers a reader sees: every KPI value (after scrolling them into view). */
async function kpis(page: Page) {
  // A tile fetches when it is on screen: bring every one into view, then read.
  await page.waitForTimeout(800);
  await scrollAll(page);
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin'), undefined, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-grid-item-id] .dashboard-kpi-value')).map((e) => (e.textContent ?? '').trim()));
}
/** The table the report ends with, as text (a second, independent figure). */
async function tableText(page: Page) {
  return page.evaluate(() => {
    const t = document.querySelector('[data-grid-item-id] table');
    return (t?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  });
}

/** Chart data requests while `fn` runs, with the filter context each carried. */
async function chartRequestsDuring(page: Page, fn: () => Promise<void>) {
  const seen: string[] = [];
  const onReq = (req: any) => {
    const u = req.url();
    if (/\/charts\/\d+\/data/.test(u)) seen.push(decodeURIComponent(new URL(u).searchParams.get('filters') ?? '[]'));
  };
  page.on('request', onReq);
  try { await fn(); await page.waitForTimeout(1500); } finally { page.off('request', onReq); }
  return seen;
}

const control = (page: Page, label: string | RegExp) =>
  page.locator('main [data-widget-type="slicer"]').filter({ hasText: label }).first();
const controlCount = (page: Page) => page.locator('main [data-widget-type="slicer"]').count();

/** Add element → Slicer, the way an author does it. */
async function addSlicer(page: Page, opts: { existing?: RegExp; field?: RegExp; search?: string; where?: 'top' | 'end' }) {
  const before = await controlCount(page);
  await page.getByTestId('add-slicer-open').click();
  const modal = page.getByTestId('add-slicer-modal');
  await modal.waitFor();
  await page.getByTestId(`add-slicer-where-${opts.where ?? 'end'}`).click();
  if (opts.search) await page.getByTestId('add-slicer-search').fill(opts.search);
  if (opts.existing) await modal.locator('[data-testid^="add-slicer-existing-"]').filter({ hasText: opts.existing }).first().click();
  else await modal.locator('[data-testid^="add-slicer-field-"]').filter({ hasText: opts.field ?? /./ }).first().click();
  await expect.poll(() => controlCount(page), { timeout: 30_000 }).toBe(before + 1);
  await page.waitForTimeout(1200);
}

/** Drag a grid element by a point on its body, by (dx, dy) pixels. */
async function drag(page: Page, el: Locator, dx: number, dy: number, grip: { x: number; y: number } = { x: 14, y: 10 }) {
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  const t0 = Date.now();
  await page.mouse.move(b.x + grip.x, b.y + grip.y);
  await page.mouse.down();
  await page.mouse.move(b.x + grip.x + dx / 2, b.y + grip.y + dy / 2, { steps: 6 });
  await page.mouse.move(b.x + grip.x + dx, b.y + grip.y + dy, { steps: 6 });
  await page.mouse.up();
  return Date.now() - t0;
}
/** Resize a grid element with one of its react-resizable handles. */
async function resize(page: Page, item: Locator, handle: 'e' | 's' | 'se', dx: number, dy: number) {
  await item.scrollIntoViewIfNeeded();
  await item.hover();
  const h = item.locator(`.react-resizable-handle-${handle}`).first();
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}
const gridItemOf = (el: Locator) => el.locator('xpath=ancestor::*[@data-grid-item-id][1]');
const idOfItem = async (el: Locator) => Number(await gridItemOf(el).getAttribute('data-grid-item-id'));

/** Pick values in a slicer control's menu (collapsed treatments), then close it. */
async function pickInControl(page: Page, el: Locator, values: string[]) {
  await el.scrollIntoViewIfNeeded();
  const toggle = el.locator('.dashboard-slicer button[aria-expanded][aria-label]').first();
  await toggle.click();
  const menu = page.locator('[data-slicer-menu]');
  await menu.waitFor({ timeout: 15_000 });
  for (const v of values) {
    await menu.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: new RegExp(`^\\s*${v}\\s*$`) }).first().click();
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 300);
}
async function applyFilters(page: Page) {
  const bar = page.getByTestId('filter-apply-bar-apply');
  await bar.waitFor({ timeout: 10_000 });
  await bar.click();
  await page.waitForTimeout(1500);
}

async function openAi(page: Page) {
  if (await page.getByTestId('ai-design-input').isVisible().catch(() => false)) return;
  await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').waitFor();
}
async function panelText(page: Page) {
  return page.locator('[data-testid="ai-design-input"]').evaluate((input) => {
    let n: HTMLElement | null = input as HTMLElement;
    while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
    return (n?.innerText ?? '').slice(-3000);
  });
}
async function askAi(page: Page, r: ScenarioResult, prompt: string, label: string): Promise<boolean> {
  await openAi(page);
  await page.getByTestId('ai-design-input').fill(prompt);
  const t0 = Date.now();
  await page.getByTestId('ai-design-send').click();
  const ok = await page.getByTestId('ai-design-apply').waitFor({ state: 'visible', timeout: 180_000 }).then(() => true).catch(() => false);
  r.metrics[`${label}_preview_ms`] = Date.now() - t0;
  if (!ok) {
    r.status = 'NOT VERIFIED';
    r.notes.push(`${label}: the model returned no design within 180s — NOT VERIFIED. Panel: ${(await panelText(page).catch(() => '')).slice(-400)}`);
  }
  return ok;
}
async function publish(page: Page, request: APIRequestContext, id: number, r?: ScenarioResult, label = 'publish') {
  const t0 = Date.now();
  await page.getByTestId('dashboard-publish').click();
  await expect.poll(async () => controlsOf(await get(request, id)).every((c: any) => !c.layout?.draftOnly), { timeout: 30_000 }).toBe(true);
  if (r) r.metrics[`${label}_ms`] = Date.now() - t0;
  await page.waitForTimeout(1500);
}
async function saveDraft(page: Page) {
  const b = page.getByTestId('dashboard-save-draft');
  if (await b.isEnabled().catch(() => false)) { await b.click(); await page.waitForTimeout(1800); }
}
const undo = (page: Page) => page.getByRole('button', { name: /^Undo \(Ctrl\+Z\)/ }).click();
const redo = (page: Page) => page.getByRole('button', { name: /^Redo \(Ctrl\+Shift\+Z\)/ }).click();

async function openBaseline(page: Page, request: APIRequestContext, r: ScenarioResult) {
  const src = await idOf(request, OLIST);
  const id = await copyOf(request, need(r, src, `baseline "${OLIST}"`));
  // Tall enough to hold the whole report: a drag starts and ends on screen, as
  // it would for a person who scrolls to where they are going first.
  await page.setViewportSize({ width: 1440, height: 2600 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  return id;
}

async function publicShots(ctx: BrowserContext, url: string, r: ScenarioResult, prefix: string) {
  const out: Record<number, any> = {};
  for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]] as const) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.goto(url);
    await settle(p);
    const info = await p.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      controls: Array.from(document.querySelectorAll('[data-widget-type="slicer"]')).map((e) => {
        const b = e.getBoundingClientRect();
        const label = e.querySelector('.dashboard-slicer span.truncate') as HTMLElement | null;
        return { w: Math.round(b.width), h: Math.round(b.height), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(), clipped: !!label && label.scrollWidth > label.clientWidth + 1 };
      }),
      vh: window.innerHeight,
    }));
    const a = await audit(p);
    const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `${prefix} at ${w}px: no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    check(r, `${prefix} at ${w}px: no sideways scroll`, !info.overflowX);
    check(r, `${prefix} at ${w}px: no control takes more than half the screen`, info.controls.every((c) => c.h <= info.vh / 2), JSON.stringify(info.controls.map((c) => c.h)));
    check(r, `${prefix} at ${w}px: every control is at least a usable size`, info.controls.every((c) => c.h >= 48 && c.w >= 120), JSON.stringify(info.controls.map((c) => [c.w, c.h])));
    out[w] = info;
    await shot(p, r, `${prefix}-${w}`);
    await p.close();
  }
  return out;
}

// ── S1 · the grid is the only authoring surface ────────────────────────────

test('S1 grid-only creation: no Canvas, whitespace kept across save and reload', async ({ page, request }) => {
  const r = scenario('S1 grid-only creation');
  await page.goto('/dashboards');
  await page.getByTestId('report-starter-open').click();
  await page.selectOption('[data-testid="report-starter-dataset"]', { label: SALES_DATASET });
  await page.fill('[data-testid="report-starter-goal"]', 'Where does revenue come from, by region and channel?');
  const t0 = Date.now();
  await page.getByTestId('report-starter-create').click();
  await page.waitForURL(/\/dashboards\/\d+/, { timeout: 150_000 });
  r.metrics.create_ms = Date.now() - t0;
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  made.push(id);
  await settle(page);
  const d = await get(request, id);
  check(r, 'the new report is a grid report', d.layout_mode === 'grid', String(d.layout_mode));
  // No second engine to switch to, anywhere in the builder's menus.
  await page.getByTestId('dashboard-more').click();
  await page.waitForTimeout(400);
  const menuText = await page.locator('body').innerText();
  check(r, 'no Canvas mode is offered', !/switch to canvas|canvas mode|chuyển sang canvas/i.test(menuText));
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 400);
  // The backend refuses a second engine too: any write of layout_mode stores grid.
  const patch = await request.put(`${DASH}/${id}`, { data: { layout_mode: 'canvas' } });
  const after = await get(request, id);
  check(r, 'a write asking for Canvas is stored as grid', after.layout_mode === 'grid', `status ${patch.status()}, stored ${after.layout_mode}`);
  // Whitespace: move the last tile down into empty space, save, reload — it stays.
  await page.reload();
  await settle(page);
  // The bottom-most tile ON SCREEN (DOM order is not reading order).
  const before = await rects(page);
  const lastId = Object.entries(before).sort((a, b) => (b[1][1] + b[1][3]) - (a[1][1] + a[1][3]))[0][0];
  const last = page.locator(`main [data-grid-item-id="${lastId}"]`);
  // A chart moves by its header strip; a widget by its body.
  const handle = last.locator('.drag-handle').first();
  await drag(page, handle, 0, 200, { x: 40, y: 8 });
  await page.waitForTimeout(1200);
  const moved = await rects(page);
  check(r, 'the tile moved down, leaving a gap above it', moved[lastId!][1] > before[lastId!][1] + 100, `${before[lastId!]} → ${moved[lastId!]}`);
  await saveDraft(page);
  await page.reload();
  await settle(page);
  const reloaded = await rects(page);
  check(r, 'after save and reload the gap is still there (no auto-pack, no jump)', JSON.stringify(reloaded[lastId!]) === JSON.stringify(moved[lastId!]), `${moved[lastId!]} vs ${reloaded[lastId!]}`);
  const others = Object.keys(before).filter((k) => k !== lastId);
  check(r, 'no other tile moved', others.every((k) => JSON.stringify(before[k]) === JSON.stringify(reloaded[k])));
  await shot(page, r, 's1-grid-only-builder-1440');
});

// ── S2 · manual authoring with many element types ──────────────────────────

test('S2 manual authoring: headings, callout, text, slicer; select, align, nudge, lock, undo', async ({ page, request }) => {
  const r = scenario('S2 manual authoring');
  const id = await openBaseline(page, request, r);
  for (const label of [/^Section header$/, /^Callout \/ note$/, /^Text \/ Markdown$/]) {
    await page.getByTestId('dashboard-more').click();
    await page.getByRole('button', { name: /^Add widget$/ }).click();
    await page.getByRole('button', { name: label }).click();
    await page.waitForTimeout(1500);
    // The widget's editor opens on create; close it.
    await page.getByRole('button', { name: /^(Cancel|Close|Huỷ|Hủy|Đóng)$/ }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  const d = await get(request, id);
  const kinds = new Set(d.dashboard_charts.map((c: any) => c.widget_type === 'chart' ? c.chart?.chart_type : c.widget_type));
  for (const k of ['KPI', 'TIME_SERIES', 'BAR', 'PIE', 'TABLE', 'section_header', 'callout', 'text', 'slicer']) {
    check(r, `the page holds a ${k}`, kinds.has(k));
  }
  await settle(page);
  await shot(page, r, 's2-elements-1440');

  // Select two widgets (Shift+click) and align them.
  const widgets = page.locator('main [data-grid-item-id]').filter({ has: page.locator('[data-tile-kind="widget"]:not([data-widget-type="slicer"])') });
  const a = widgets.nth(0); const b = widgets.nth(1);
  const aId = await a.getAttribute('data-grid-item-id'); const bId = await b.getAttribute('data-grid-item-id');
  // Make them start at different x so "align left" has work to do.
  await drag(page, b.locator('[data-tile-kind="widget"]'), 180, 0, { x: 60, y: 20 });
  await page.waitForTimeout(800);
  await a.locator('[data-tile-kind="widget"]').click({ position: { x: 30, y: 12 } });
  await b.locator('[data-tile-kind="widget"]').click({ position: { x: 30, y: 12 }, modifiers: ['Shift'] });
  await page.getByTestId('arrange-bar').waitFor({ timeout: 8000 });
  check(r, 'selecting two elements shows the Arrange tools', true);
  const pre = await rects(page);
  await page.getByTestId('arrange-alignLeft').click();
  await page.waitForTimeout(900);
  const aligned = await rects(page);
  const res = aligned[aId!][0] === aligned[bId!][0];
  const refused = await page.getByText(/Not arranged: it would overlap/).isVisible().catch(() => false);
  check(r, 'align left lines them up — or refuses and names the tile in the way', res || refused, `${pre[aId!]} / ${pre[bId!]} → ${aligned[aId!]} / ${aligned[bId!]}${refused ? ' (refused)' : ''}`);
  // Keyboard nudge on the narrow element (it has room to its right); Undo and
  // Redo restore exactly.
  await page.keyboard.press('Escape');
  await b.locator('[data-tile-kind="widget"]').click({ position: { x: 30, y: 12 } });
  const n0 = (await rects(page))[bId!];
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const n1 = (await rects(page))[bId!];
  check(r, 'Arrow key nudges the selected element', n1[0] > n0[0], `${n0} → ${n1}`);
  await undo(page);
  await page.waitForTimeout(700);
  check(r, 'Undo returns it exactly', JSON.stringify((await rects(page))[bId!]) === JSON.stringify(n0));
  await redo(page);
  await page.waitForTimeout(700);
  check(r, 'Redo repeats it exactly', JSON.stringify((await rects(page))[bId!]) === JSON.stringify(n1));
  // Nudging into a neighbour is refused, and says which one.
  const wide = widgets.filter({ has: page.locator('.dashboard-section') }).first();
  if (await wide.count()) {
    await wide.locator('[data-tile-kind="widget"]').click({ position: { x: 30, y: 12 } });
    const w0 = await rects(page);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(700);
    const w1 = await rects(page);
    const refusedNudge = await page.getByText(/Not arranged: it would overlap/).first().isVisible().catch(() => false);
    const movedNudge = JSON.stringify(w0) !== JSON.stringify(w1);
    check(r, 'a nudge either moves into free space or is refused with the tile named — never overlaps', movedNudge || refusedNudge);
  }
  // Lock: a locked element does not move by drag or keyboard.
  await a.hover();
  await a.getByTestId('widget-lock-toggle').click();
  await page.waitForTimeout(600);
  const l0 = (await rects(page))[aId!];
  await drag(page, a.locator('[data-tile-kind="widget"]'), 0, 120, { x: 60, y: 20 });
  await a.locator('[data-tile-kind="widget"]').click({ position: { x: 30, y: 12 } }).catch(() => {});
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  check(r, 'a locked element stays put', JSON.stringify((await rects(page))[aId!]) === JSON.stringify(l0));
  // Never shows the author coordinates or JSON.
  const text = await page.locator('main').innerText();
  check(r, 'no coordinates or JSON are shown to the author', !/"x"\s*:|"slicerId"|\{"w"/.test(text));
  await saveDraft(page);
  await shot(page, r, 's2-arranged-1440');
});

// ── S3 · slicer: add, move, resize, treatment ──────────────────────────────

test('S3 slicer controls: add at the top and beside a chart, move, resize, restyle, survive reload', async ({ page, request }) => {
  const r = scenario('S3 slicer add/move/resize/treatment');
  const id = await openBaseline(page, request, r);
  const beforeTop = await rects(page);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  await settle(page);
  const state = control(page, /Customer state/);
  const stateId = await idOfItem(state);
  const afterTop = await rects(page);
  const firstY = Math.min(...Object.values(beforeTop).map((v) => v[1]));
  const kpiIds = Object.keys(beforeTop).filter((k) => beforeTop[k][1] === firstY);
  const topY = Math.min(...Object.values(afterTop).map((v) => v[1]));
  check(r, 'the control sits at the top of the page', afterTop[String(stateId)][1] === topY, `${afterTop[String(stateId)]} (top ${topY})`);
  const shift = afterTop[kpiIds[0]][1] - beforeTop[kpiIds[0]][1];
  check(r, 'the page moved down by one band to make room, keeping every gap', shift > 0 && Object.keys(beforeTop).every((k) => afterTop[k][1] - beforeTop[k][1] === shift), `shift ${shift}px`);
  check(r, 'the filter bar no longer repeats the placed slicer', (await page.locator('main .dashboard-slicer').count()) === 1);
  // A second, NEW filter on a field, placed below the content.
  await addSlicer(page, { search: 'category', field: /category/i, where: 'end' });
  const cat = page.locator('main [data-widget-type="slicer"]').filter({ hasNotText: /Customer state/ }).first();
  const catLabel = ((await cat.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  r.metrics.new_filter_label = catLabel;
  const d1 = await get(request, id);
  const created = [...(d1.slicers_config ?? []), ...((d1.pages_config ?? [])[0]?.slicers ?? []), ...(d1.draft_snapshot?.pages_config?.[0]?.slicers ?? [])];
  check(r, 'the new filter exists as a slicer entry (semantics), the control only names it',
    controlsOf(d1).every((c: any) => Object.keys(c.widget_config).every((k) => ['slicerId', 'treatment', 'origin'].includes(k))), JSON.stringify(controlsOf(d1).map((c: any) => c.widget_config)));
  r.metrics.slicer_entries = created.map((s: any) => s.label);

  // Make room beside "Revenue by category" by narrowing it, then put the control there.
  const chart = page.locator('main [data-grid-item-id]').filter({ hasText: 'Revenue by category' }).first();
  // Narrow it by about nine columns: a gap the 8-column control fits in.
  await resize(page, chart, 'e', -330, 0);
  const g1 = await rects(page);
  const chartId = await chart.getAttribute('data-grid-item-id');
  const catId = String(await idOfItem(cat));
  const catRect = g1[catId]; const chartRect = g1[chartId!];
  const dragMs = await drag(page, cat.locator('.dashboard-slicer'), (chartRect[0] + chartRect[2] + 20) - catRect[0], chartRect[1] - catRect[1], { x: 20, y: 8 });
  r.metrics.drag_gesture_ms = dragMs;
  await page.waitForTimeout(900);
  const g2 = await rects(page);
  check(r, 'the control now sits beside the chart it is read with', Math.abs(g2[catId][1] - chartRect[1]) < 20 && g2[catId][0] >= chartRect[0] + chartRect[2] - 4, `${catRect} → ${g2[catId]} (chart ${chartRect})`);
  // Taller → it shows its values as a list (auto treatment).
  const catItem = page.locator(`main [data-grid-item-id="${catId}"]`);
  await resize(page, catItem, 's', 0, 220);
  await expect.poll(() => catItem.locator('[data-slicer-control]').getAttribute('data-slicer-treatment'), { timeout: 8000 }).toBe('list');
  check(r, 'a tall control shows its values as a list', true);
  // Restyle through its display menu.
  await catItem.hover();
  await catItem.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-treatment-dropdown').click();
  await expect.poll(() => catItem.locator('[data-slicer-control]').getAttribute('data-slicer-treatment')).toBe('dropdown');
  check(r, 'the author can choose the control\'s display', true);
  const geometry = await rects(page);
  await saveDraft(page);
  await page.reload();
  await settle(page);
  const reloaded = await rects(page);
  check(r, 'every position survives save and reload', JSON.stringify(reloaded) === JSON.stringify(geometry));
  check(r, 'the display choice survives reload', (await page.locator(`main [data-grid-item-id="${catId}"] [data-slicer-control]`).getAttribute('data-slicer-treatment')) === 'dropdown');
  await shot(page, r, 's3-slicers-builder-1440');
  await publish(page, request, id, r);
  const token = await linkFor(request, id);
  await publicShots(page.context(), `/d/${token}`, r, 's3-public');
});

// ── S4 · moving a control never changes the data ───────────────────────────

test('S4 filter parity: numbers and filter context identical before and after moving, resizing, restyling', async ({ page, request }) => {
  const r = scenario('S4 filter parity');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  const state = control(page, /Customer state/);
  const unfiltered = await kpis(page);
  await pickInControl(page, state, ['SP']);
  const t0 = Date.now();
  await applyFilters(page);
  const filtered = await kpis(page);
  r.metrics.filter_apply_to_numbers_ms = Date.now() - t0;
  check(r, 'the control filters the report (KPIs change)', JSON.stringify(filtered) !== JSON.stringify(unfiltered), `${unfiltered} → ${filtered}`);
  await scrollAll(page);
  const table0 = await tableText(page);
  const stateItem = gridItemOf(state);
  const stateId = await stateItem.getAttribute('data-grid-item-id');

  const phases: Array<[string, () => Promise<void>]> = [
    ['move to the right', async () => { await drag(page, state.locator('.dashboard-slicer'), 400, 0, { x: 20, y: 8 }); }],
    ['resize wider', async () => { await resize(page, page.locator(`main [data-grid-item-id="${stateId}"]`), 'e', 160, 0); }],
    ['restyle as buttons', async () => {
      const item = page.locator(`main [data-grid-item-id="${stateId}"]`);
      await item.hover();
      await item.getByTestId('slicer-control-menu').click();
      await page.getByTestId('slicer-treatment-compact').click();
    }],
  ];
  for (const [name, act] of phases) {
    const reqs = await chartRequestsDuring(page, act);
    check(r, `${name}: no chart data was re-queried`, reqs.length === 0, `${reqs.length} request(s)`);
    const now = await kpis(page);
    check(r, `${name}: every KPI is identical`, JSON.stringify(now) === JSON.stringify(filtered), `${filtered} vs ${now}`);
  }
  await scrollAll(page);
  check(r, 'the table is identical after all three', (await tableText(page)) === table0);
  // The effective filter context a chart is queried with: reload and capture.
  const ctxAfter = await chartRequestsDuring(page, async () => { await saveDraft(page); await page.reload(); await settle(page); });
  const distinct = [...new Set(ctxAfter)];
  r.metrics.filter_context_after = distinct;
  check(r, 'every chart is queried with the same state filter (SP), nothing else', distinct.length > 0 && distinct.every((f) => /customer_state/.test(f) && /"SP"/.test(f)), distinct.join(' | ').slice(0, 300));
  check(r, 'after reload the numbers are the same', JSON.stringify(await kpis(page)) === JSON.stringify(filtered));
  await publish(page, request, id, r);
  const token = await linkFor(request, id);
  const pub = await page.context().newPage();
  for (const w of [1440, 390]) {
    await pub.setViewportSize({ width: w, height: 900 });
    await pub.goto(`/d/${token}`);
    await settle(pub);
    const nums = await kpis(pub);
    check(r, `the published report at ${w}px shows the same numbers`, JSON.stringify(nums) === JSON.stringify(filtered), `${nums}`);
  }
  await pub.close();
  r.metrics.kpis = { unfiltered, filtered };
});

// ── S5 · scope and visibility ──────────────────────────────────────────────

test('S5 scope: a control placed where its scope hides it filters silently; page 2 shows it', async ({ page, request }) => {
  const r = scenario('S5 scope + visibility');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  const state = control(page, /Customer state/);
  await pickInControl(page, state, ['SP']);
  await applyFilters(page);
  const filtered = await kpis(page);
  // Fixture: a second page, and the slicer's scope set to "filter page 1 but do
  // not show a control there; show it on page 2" (the ⚙ scope matrix's result).
  const d = await get(request, id);
  const pages = [...(d.draft_snapshot?.pages_config ?? d.pages_config ?? [{ id: 'page-1', name: 'Overview' }]), { id: 'page-2', name: 'Detail' }];
  const slicers = (d.draft_snapshot?.slicers_config ?? d.slicers_config).map((s: any) => (s.id === 'slicer-state'
    ? { ...s, scope: 'custom', pageScope: { 'page-1': { filter: true, visible: false }, 'page-2': { filter: true, visible: true } } } : s));
  await request.put(`${DASH}/${id}/draft-filters`, { data: { slicers_config: slicers, pages_config: pages } });
  await page.reload();
  await settle(page);
  const s = page.locator('main [data-widget-type="slicer"] [data-slicer-control]').first();
  check(r, 'builder: the control is shown to the author as hidden here', (await s.getAttribute('data-slicer-control')) === 'hidden');
  check(r, 'builder: it says it still filters this page', /still filters/i.test((await s.textContent()) ?? ''));
  check(r, 'builder: the numbers are still filtered (scope, not placement, decides)', JSON.stringify(await kpis(page)) === JSON.stringify(filtered));
  // The picker never offers a second slicer on a field already filtered.
  await page.getByTestId('add-slicer-open').click();
  const offered = await page.getByTestId('add-slicer-modal').locator('[data-testid^="add-slicer-field-"]').filter({ hasText: /^Customer State/i }).count();
  check(r, 'the same field cannot get a second slicer by accident', offered === 0, `${offered}`);
  await page.keyboard.press('Escape');
  await publish(page, request, id, r);
  const token = await linkFor(request, id);
  const pub = await page.context().newPage();
  await pub.goto(`/d/${token}`);
  await settle(pub);
  check(r, 'public page 1: no control for the hidden slicer', (await pub.locator('[data-widget-type="slicer"] [data-slicer-control="ok"]').count()) === 0);
  check(r, 'public page 1: its value still applies silently', JSON.stringify(await kpis(pub)) === JSON.stringify(filtered));
  await shot(pub, r, 's5-public-page1-1440');
  await pub.close();
});

// ── S6 · public locked filters ─────────────────────────────────────────────

test('S6 a link that locks the field: the control disappears and the viewer cannot escape the lock', async ({ page, request }) => {
  const r = scenario('S6 public locked filters');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  await publish(page, request, id, r);
  const locked = [{ field: 'customer_state', semanticField: 'dataset_table_3.customer_state', fieldKey: 'dataset_table_3.customer_state', datasetId: 1,
    type: 'dropdown', operator: 'in', value: ['RJ'], publicMode: 'locked', label: 'Customer state' }];
  const token = await linkFor(request, id, locked);
  const open = await linkFor(request, id);
  const pub = await page.context().newPage();
  await pub.goto(`/d/${open}`);
  await settle(pub);
  const all = await kpis(pub);
  check(r, 'the open link shows the control', (await pub.locator('[data-widget-type="slicer"] [data-slicer-control="ok"]').count()) === 1);
  await pub.goto(`/d/${token}`);
  await settle(pub);
  const rj = await kpis(pub);
  check(r, 'the locked link shows no control for the locked field', (await pub.locator('[data-widget-type="slicer"] [data-slicer-control="ok"]').count()) === 0);
  check(r, 'the locked link\'s numbers are the locked value (RJ), not all', JSON.stringify(rj) !== JSON.stringify(all), `${all} vs ${rj}`);
  // Escape attempt: the viewer sends a filter for the locked field directly.
  const probe = await pub.evaluate(async (tok) => {
    const sess = Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).find((v) => v && v.length > 40) ?? '';
    return { sess: sess.length };
  }, token);
  r.metrics.probe = probe;
  check(r, 'no editable control for the locked field anywhere on the page', (await pub.locator('.dashboard-slicer').filter({ hasText: /Customer state/ }).count()) === 0);
  await shot(pub, r, 's6-locked-1440');
  await pub.close();
});

// ── S7 · AI places filters with the same grid elements ─────────────────────

test('S7 AI Design (real model) composes the page with slicer controls; no invented numbers', async ({ page, request }) => {
  const r = scenario('S7 AI redesign with slicers');
  const id = await openBaseline(page, request, r);
  const before = await kpis(page);
  const ok = await askAi(page, r, 'Redesign the whole page for a regional sales review: put the report\'s filters on the page as a filter band at the top, then the headline numbers, then the charts. Keep every number live.', 's7');
  if (!ok) return;
  const text = await panelText(page);
  r.metrics.panel = text.slice(-1200);
  await page.getByTestId('ai-design-apply').click();
  await expect.poll(async () => controlsOf(await get(request, id)).length, { timeout: 40_000 }).toBeGreaterThan(0).catch(() => {});
  await settle(page);
  const d = await get(request, id);
  const controls = controlsOf(d);
  check(r, 'the design placed the filter on the page as a control', controls.length > 0, `${controls.length}`);
  check(r, 'every AI control is draft-only until Publish', controls.every((c: any) => c.layout?.draftOnly === true));
  check(r, 'an AI control names a slicer the report has, nothing else', controls.every((c: any) => (d.slicers_config ?? []).some((s: any) => s.id === c.widget_config.slicerId) && Object.keys(c.widget_config).every((k) => ['slicerId', 'treatment', 'origin'].includes(k))), JSON.stringify(controls.map((c: any) => c.widget_config)));
  const after = await kpis(page);
  check(r, 'the numbers are unchanged by the redesign', JSON.stringify([...after].sort()) === JSON.stringify([...before].sort()), `${before} vs ${after}`);
  const narr = d.dashboard_charts.filter((c: any) => c.widget_type === 'narrative');
  const typed = narr.map((n: any) => `${n.widget_config?.title ?? ''} ${n.widget_config?.eyebrow ?? ''}`.trim()).filter((s: string) => /\d/.test(s));
  check(r, 'any text the AI added is bound to findings, never typed numbers', typed.length === 0, JSON.stringify(typed).slice(0, 300));
  const a = await audit(page);
  const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
  check(r, 'no render defect after Apply', hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
  await shot(page, r, 's7-ai-builder-1440');
  // S9 · still a normal report a person can edit.
  const r9 = scenario('S9 AI report stays manually editable');
  const ctl = page.locator('main [data-widget-type="slicer"]').first();
  const ctlId = String(await idOfItem(ctl));
  const g0 = await rects(page);
  await drag(page, ctl.locator('.dashboard-slicer'), 420, 0, { x: 20, y: 8 });
  await page.waitForTimeout(900);
  const g1 = await rects(page);
  check(r9, 'the AI-created control moves like any element', JSON.stringify(g1[ctlId]) !== JSON.stringify(g0[ctlId]), `${g0[ctlId]} → ${g1[ctlId]}`);
  const item = page.locator(`main [data-grid-item-id="${ctlId}"]`);
  await item.hover();
  await item.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-treatment-list').click();
  check(r9, 'the author can restyle an AI control', true);
  await item.hover();
  await item.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-remove-control').click();
  await page.getByRole('button', { name: /^(Remove|Xoá|Xóa|Delete|Gỡ|Confirm)/ }).last().click().catch(() => {});
  await expect.poll(async () => controlsOf(await get(request, id)).length, { timeout: 20_000 }).toBe(controls.length - 1);
  const dd = await get(request, id);
  check(r9, 'removing a control keeps the filter (it returns to the filter bar)', (dd.slicers_config ?? []).length === (d.slicers_config ?? []).length);
  await settle(page);
  check(r9, 'the filter bar draws the slicer again', (await page.locator('main .dashboard-slicer').count()) >= 1);
  await shot(page, r9, 's9-ai-then-manual-1440');
  persist();
});

// ── S8 · style-only keeps geometry, slicer controls included ───────────────

test('S8 a style-only AI change keeps every rectangle, slicer controls included', async ({ page, request }) => {
  const r = scenario('S8 style-only keeps geometry');
  await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  await saveDraft(page);
  await settle(page);
  const geometry = await rects(page);
  await openAi(page);
  await page.getByTestId('ai-design-target').getByRole('button', { name: /^(Whole page|Cả trang)$/ }).first().click({ timeout: 3000 }).catch(() => {});
  const ok = await askAi(page, r, 'Make this look premium and calm, dark navy accents. Style only — keep my layout exactly as it is.', 's8');
  if (!ok) return;
  await page.waitForTimeout(2500);
  check(r, 'the preview moves or resizes nothing', JSON.stringify(await rects(page)) === JSON.stringify(geometry));
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2500);
  const applied = await rects(page);
  check(r, 'after Apply every rectangle is unchanged, the control\'s too', JSON.stringify(applied) === JSON.stringify(geometry));
  await shot(page, r, 's8-style-applied-1440');
});

// ── S10 · save / reload / undo / redo / publish ────────────────────────────

test('S10 a control\'s changes are undoable, saved, and published — not before', async ({ page, request }) => {
  const r = scenario('S10 save/reload/undo/redo/publish');
  const id = await openBaseline(page, request, r);
  const token = await linkFor(request, id);
  await addSlicer(page, { existing: /Customer state/, where: 'end' });
  const pub = await page.context().newPage();
  await pub.goto(`/d/${token}`);
  await settle(pub);
  check(r, 'before Publish the public report has no control yet (draft only)', (await pub.locator('[data-widget-type="slicer"]').count()) === 0);
  check(r, 'before Publish the public filter bar still has the slicer', (await pub.locator('.dashboard-slicer').count()) >= 1);
  const ctl = control(page, /Customer state/);
  const ctlId = String(await idOfItem(ctl));
  const item = page.locator(`main [data-grid-item-id="${ctlId}"]`);
  const treat = () => item.locator('[data-slicer-control]').getAttribute('data-slicer-treatment');
  const t0 = await treat();
  await item.hover();
  await item.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-treatment-compact').click();
  check(r, 'restyle applies', (await treat()) === 'compact');
  await undo(page);
  await page.waitForTimeout(500);
  check(r, 'Undo restores the display', (await treat()) === t0, `${await treat()}`);
  await redo(page);
  await page.waitForTimeout(500);
  check(r, 'Redo restores the change', (await treat()) === 'compact');
  // Undo while a filter is active changes presentation only.
  await pickInControl(page, ctl, ['SP']);
  await applyFilters(page);
  const f = await kpis(page);
  const g = await rects(page);
  await drag(page, ctl.locator('.dashboard-slicer'), 300, 0, { x: 16, y: 6 });
  await undo(page);
  await page.waitForTimeout(700);
  check(r, 'Undo of a move while a filter is active restores the place, not the filter', JSON.stringify((await rects(page))[ctlId]) === JSON.stringify(g[ctlId]) && JSON.stringify(await kpis(page)) === JSON.stringify(f));
  await saveDraft(page);
  await page.reload();
  await settle(page);
  check(r, 'after reload the display is kept', (await page.locator(`main [data-grid-item-id="${ctlId}"] [data-slicer-control]`).getAttribute('data-slicer-treatment')) === 'compact');
  await publish(page, request, id, r);
  await pub.goto(`/d/${token}`);
  await settle(pub);
  check(r, 'after Publish the public report draws the control where the author put it', (await pub.locator('[data-widget-type="slicer"] [data-slicer-control="ok"]').count()) === 1);
  check(r, 'and the public report draws it with the author\'s display', (await pub.locator('[data-widget-type="slicer"] [data-slicer-control]').getAttribute('data-slicer-treatment')) === 'compact');
  await pub.close();
});

// ── S11 · builder / public / embed / PDF ───────────────────────────────────

test('S11 builder, /d, /embed and the PDF show the same controls and numbers', async ({ page, request, context }) => {
  const r = scenario('S11 builder/public/embed/PDF parity');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  await pickInControl(page, control(page, /Customer state/), ['SP']);
  await applyFilters(page);
  await publish(page, request, id, r);
  await settle(page);
  const builderTiles = await page.locator('main [data-grid-item-id]').count();
  const builderNums = await kpis(page);
  const token = await linkFor(request, id);
  for (const surface of ['d', 'embed'] as const) {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1440, height: 2600 });
    await p.goto(`/${surface}/${token}`);
    await settle(p);
    check(r, `/${surface}: same element count as the builder`, (await p.locator('[data-grid-item-id]').count()) === builderTiles);
    check(r, `/${surface}: the control is drawn`, (await p.locator('[data-widget-type="slicer"] [data-slicer-control="ok"]').count()) === 1);
    const nums = await kpis(p);
    check(r, `/${surface}: same numbers as the builder`, JSON.stringify(nums) === JSON.stringify(builderNums), `${builderNums} vs ${nums}`);
    await p.setViewportSize({ width: 1440, height: 900 });
    await shot(p, r, `s11-${surface}-1440`);
    if (surface === 'd') {
      const t0 = Date.now();
      const download = p.waitForEvent('download', { timeout: 240_000 });
      await p.getByRole('button', { name: /^Export PDF$/ }).first().click();
      await p.getByRole('button', { name: /^Export PDF$/ }).last().click();
      const file = await download;
      r.metrics.export_ms = Date.now() - t0;
      const bytes = fs.readFileSync((await file.path())!);
      check(r, 'the export is a PDF', bytes.subarray(0, 4).toString() === '%PDF');
      const outcome = await p.evaluate(() => (window as any).__APPBI_LAST_EXPORT__ ?? null);
      r.metrics.export = outcome;
      check(r, 'the export has nothing missing', !!outcome && outcome.warnings.filter((w: any) => w.kind === 'incomplete').length === 0, JSON.stringify(outcome?.warnings ?? []));
      fs.writeFileSync(path.join(EVIDENCE, 's11-export.pdf'), bytes);
      r.evidence.push('s11-export.pdf');
    }
    await p.close();
  }
});

// ── S12 · legacy and migration ─────────────────────────────────────────────

test('S12 legacy: an untouched report keeps its filter bar; a migrated Canvas report opens on the grid', async ({ page, request }) => {
  const r = scenario('S12 legacy + migration');
  const id = await openBaseline(page, request, r);
  check(r, 'an untouched report keeps its filter bar', (await page.locator('main .dashboard-slicer').count()) === 1);
  check(r, 'and has no grid control', (await controlCount(page)) === 0);
  const token = await linkFor(request, id);
  const pub = await page.context().newPage();
  await pub.goto(`/d/${token}`);
  await settle(pub);
  check(r, 'its public link still draws the slicer in the bar', (await pub.locator('.dashboard-slicer').count()) === 1);
  await pub.close();
  const migrated = (await dashboards(request)).find((d) => d.canvas_config?.migratedFromCanvas);
  if (!migrated) {
    r.notes.push('no Canvas dashboard existed on this environment to migrate — the migration is covered by backend/tests/test_unified_grid_contract.py (upgrade/downgrade on a real SQLite DB)');
    return;
  }
  await page.goto(`/dashboards/${migrated.id}`);
  await page.waitForSelector('[data-grid-item-id]', { timeout: 60_000 });
  await page.waitForTimeout(2000);
  const d = await get(request, migrated.id);
  check(r, 'the migrated report is a grid report', d.layout_mode === 'grid');
  const a = await audit(page);
  check(r, 'the migrated report\'s tiles do not overlap', !(a?.findings ?? []).some((f) => f.code === 'tile.overlap'));
  check(r, 'every tile has a grid cell', d.dashboard_charts.every((c: any) => ['x', 'y', 'w', 'h'].every((k) => typeof c.layout?.[k] === 'number')));
  await shot(page, r, 's12-migrated-builder-1440');
});

// ── S13 · responsive ───────────────────────────────────────────────────────

test('S13 responsive: controls stay usable at 1440 / 820 / 390 and keep the selection', async ({ page, request, context }) => {
  const r = scenario('S13 responsive');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  await addSlicer(page, { search: 'category', field: /category/i, where: 'top' });
  await publish(page, request, id, r);
  const token = await linkFor(request, id);
  await publicShots(context, `/d/${token}`, r, 's13-public');
  const p = await context.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`/d/${token}`);
  await settle(p);
  const ctl = p.locator('[data-widget-type="slicer"]').filter({ hasText: /Customer state/ }).first();
  await pickInControl(p, ctl, ['SP']);
  await p.getByTestId('filter-apply-bar-apply').click();
  await p.waitForTimeout(2500);
  const wide = await kpis(p);
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(2500);
  check(r, 'narrowing to a phone keeps the viewer\'s selection', /SP/.test((await ctl.textContent()) ?? ''));
  check(r, 'and the same numbers', JSON.stringify(await kpis(p)) === JSON.stringify(wide));
  // The value menu on a phone stays inside the screen.
  await ctl.scrollIntoViewIfNeeded();
  await ctl.locator('.dashboard-slicer button[aria-expanded][aria-label]').first().click();
  const menu = p.locator('[data-slicer-menu]');
  await menu.waitFor();
  const mb = (await menu.boundingBox())!;
  check(r, 'the value menu fits a 390px screen', mb.x >= 0 && mb.x + mb.width <= 390 && mb.y >= 0 && mb.y + mb.height <= 844, JSON.stringify(mb));
  await p.screenshot({ path: path.join(EVIDENCE, 's13-menu-390.jpg'), type: 'jpeg', quality: 62 });
  r.evidence.push('s13-menu-390.jpg');
  await p.close();
});

// ── S14 · performance ──────────────────────────────────────────────────────

test('S14 performance: presentation edits never query data; timings recorded', async ({ page, request }) => {
  const r = scenario('S14 performance');
  const id = await openBaseline(page, request, r);
  await addSlicer(page, { existing: /Customer state/, where: 'end' });
  const ctl = control(page, /Customer state/);
  const ctlId = String(await idOfItem(ctl));
  const moves: number[] = [];
  let queries = 0;
  for (let i = 0; i < 4; i += 1) {
    const g0 = await rects(page);
    const reqs = await chartRequestsDuring(page, async () => {
      const t0 = Date.now();
      await drag(page, ctl.locator('.dashboard-slicer'), i % 2 === 0 ? 300 : -300, 0, { x: 16, y: 6 });
      await expect.poll(async () => JSON.stringify((await rects(page))[ctlId]) !== JSON.stringify(g0[ctlId]), { timeout: 5000, intervals: [16, 32, 50] }).toBe(true);
      moves.push(Date.now() - t0);
    });
    queries += reqs.length;
  }
  r.metrics.drag_to_settled_ms = moves;
  check(r, 'moving a control 4 times queried no chart data', queries === 0, `${queries}`);
  // Frames while dragging: long tasks during a drag.
  const long = await page.evaluate(async () => {
    const tasks: number[] = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(Math.round(e.duration))));
    try { po.observe({ type: 'longtask', buffered: false } as any); } catch { return null; }
    await new Promise((r) => setTimeout(r, 50));
    return { po: !!po, tasks };
  });
  r.metrics.longtask_probe = long;
  const g = await rects(page);
  const t1 = Date.now();
  await pickInControl(page, ctl, ['SP']);
  await applyFilters(page);
  await kpis(page);
  r.metrics.filter_apply_ms = Date.now() - t1;
  await publish(page, request, id, r, 'publish');
  check(r, 'publish finished within the V3 range (≤ 5 s)', Number(r.metrics.publish_ms) <= 5000, `${r.metrics.publish_ms} ms`);
  const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];
  check(r, 'a move settles quickly (median ≤ 1500 ms including the gesture)', median <= 1500, `${moves}`);
  r.metrics.layout_after = g[ctlId];
});

// ── L · slicer benchmark (visual) ──────────────────────────────────────────

test('L slicer benchmark: global date at the top, category and region beside their charts, narrative, three widths', async ({ page, request, context }) => {
  const r = scenario('L slicer benchmark');
  const id = await openBaseline(page, request, r);
  // A narrative that states the page's findings (the Executive direction), applied first.
  await openAi(page);
  await page.getByTestId('ai-design-direction-executive').click();
  await page.getByTestId('ai-design-apply').waitFor({ timeout: 60_000 });
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('design-mode-manual').click();
  await settle(page);
  // Global date range and the category list, both as a band at the top.
  const numbersBefore = await kpis(page);
  await addSlicer(page, { search: 'purchase', field: /purchase/i, where: 'top' });
  const numbersAfter = await kpis(page);
  check(r, 'placing a NEW date control leaves the numbers as they were (it starts at all dates)', JSON.stringify(numbersAfter) === JSON.stringify(numbersBefore), `${numbersBefore} vs ${numbersAfter}`);
  check(r, 'every KPI still has data', numbersAfter.length > 0 && numbersAfter.every((v) => !/^R?\$?0(\.0%)?$/.test(v)), `${numbersAfter}`);
  await addSlicer(page, { existing: /Customer state/, where: 'end' });
  await addSlicer(page, { search: 'category', field: /category/i, where: 'end' });
  await settle(page);
  // Region control beside "Revenue by state": narrow the chart, drop the control in the gap.
  const placeBeside = async (chartTitle: string, ctlLabel: RegExp) => {
    const chart = page.locator('main [data-grid-item-id]').filter({ hasText: chartTitle }).first();
    await resize(page, chart, 'e', -330, 0);
    const g = await rects(page);
    const chartId = await chart.getAttribute('data-grid-item-id');
    const ctl = control(page, ctlLabel);
    const ctlId = String(await idOfItem(ctl));
    const cr = g[chartId!]; const kr = g[ctlId];
    await drag(page, ctl.locator('.dashboard-slicer'), (cr[0] + cr[2] + 24) - kr[0], cr[1] - kr[1], { x: 20, y: 8 });
    await page.waitForTimeout(800);
    await resize(page, page.locator(`main [data-grid-item-id="${ctlId}"]`), 's', 0, 240);
    const g2 = await rects(page);
    check(r, `the ${ctlLabel} control sits beside "${chartTitle}"`, Math.abs(g2[ctlId][1] - cr[1]) < 24, `${g2[ctlId]} vs ${cr}`);
    return ctlId;
  };
  const regionId = await placeBeside('Revenue by state', /Customer state/);
  const categoryId = await placeBeside('Revenue by category', /categor/i);
  await saveDraft(page);
  await settle(page);
  const treat = async (tileId: string) => page.locator(`main [data-grid-item-id="${tileId}"] [data-slicer-control]`).getAttribute('data-slicer-treatment');
  check(r, 'a contextual control beside its chart lists its values', (await treat(regionId)) === 'list' && (await treat(categoryId)) === 'list', `${await treat(regionId)} / ${await treat(categoryId)}`);
  const a = await audit(page);
  const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
  check(r, 'the benchmark has no render defect in the builder', hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
  for (const w of [1440, 820, 390] as const) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 1000 });
    await settle(page);
    await shot(page, r, `L-benchmark-builder-${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await publish(page, request, id, r);
  const token = await linkFor(request, id);
  await publicShots(context, `/d/${token}`, r, 'L-benchmark-public');
  await publicShots(context, `/embed/${token}`, r, 'L-benchmark-embed');
});

// ── F · clear value / remove control / delete filter are different acts ─────

test('F clear a value, remove a control, delete a filter — each does only what it says', async ({ page, request }) => {
  const r = scenario('F clear / remove control / delete filter');
  const id = await openBaseline(page, request, r);
  const unfiltered = await kpis(page);
  await addSlicer(page, { existing: /Customer state/, where: 'top' });
  const ctl = () => control(page, /Customer state/);
  await pickInControl(page, ctl(), ['SP']);
  await applyFilters(page);
  const sp = await kpis(page);
  check(r, 'SP is applied', JSON.stringify(sp) !== JSON.stringify(unfiltered));
  // Clear the VALUE: the filter and its control stay, the report is unfiltered.
  await pickInControl(page, ctl(), ['SP']);
  await applyFilters(page);
  check(r, 'clearing the value unfilters the report', JSON.stringify(await kpis(page)) === JSON.stringify(unfiltered));
  check(r, 'and keeps the control', (await controlCount(page)) === 1);
  const d0 = await get(request, id);
  const before = [...(d0.draft_snapshot?.slicers_config ?? d0.slicers_config ?? [])].map((s: any) => s.id);
  // Remove the CONTROL: the filter stays and returns to the bar.
  const item = gridItemOf(ctl());
  await item.hover();
  await item.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-remove-control').click();
  await page.getByRole('button', { name: /^Remove$/ }).last().click();
  await expect.poll(() => controlCount(page), { timeout: 20_000 }).toBe(0);
  const d1 = await get(request, id);
  check(r, 'removing the control keeps the filter entry', JSON.stringify([...(d1.draft_snapshot?.slicers_config ?? d1.slicers_config ?? [])].map((s: any) => s.id)) === JSON.stringify(before));
  check(r, 'the filter bar draws it again', (await page.locator('main .dashboard-slicer').count()) === 1);
  // Place it again, then DELETE the filter: entry and every control go.
  await addSlicer(page, { existing: /Customer state/, where: 'end' });
  page.once('dialog', (dlg) => dlg.accept());
  const item2 = gridItemOf(ctl());
  await item2.hover();
  await item2.getByTestId('slicer-control-menu').click();
  await page.getByTestId('slicer-delete-filter').click();
  await expect.poll(async () => controlsOf(await get(request, id)).length, { timeout: 20_000 }).toBe(0);
  const d2 = await get(request, id);
  const left = [...(d2.draft_snapshot?.slicers_config ?? d2.slicers_config ?? [])].map((s: any) => s.id);
  check(r, 'deleting the filter removes its entry', !left.includes('slicer-state'), JSON.stringify(left));
  check(r, 'and every control for it', controlsOf(d2).length === 0);
  await page.reload();
  await settle(page);
  check(r, 'after reload nothing points at the deleted filter', (await controlCount(page)) === 0 && (await page.locator('main .dashboard-slicer').filter({ hasText: /Customer state/ }).count()) === 0);
  check(r, 'and the report is unfiltered', JSON.stringify(await kpis(page)) === JSON.stringify(unfiltered));
});
