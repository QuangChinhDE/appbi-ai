import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Manual Report Builder — the benchmarks, driven through the UI on a
 * production build, asserting what a reader gets.
 *
 *   M1  blank → finished report: New report, guided start, report header, charts
 *       added under the selection, KPI strip, a section that adopts what is under
 *       it, an insight stated from the data, emphasis, fit to content, a section
 *       moved as a whole, undo, publish; the public report at 1440/820/390; PDF.
 *   M2  selected charts → a professional report: an existing report's charts
 *       arranged with patterns, a split header whose headline is a finding,
 *       sections, publish, parity.
 *   M3  improve a migrated report (574 or its copy): the outline names what is
 *       there, a section is moved, a header is added, filters keep working.
 *   M4  two independent datasets in one report: each section reads its own data,
 *       the header states each dataset's own period.
 *   M5  an Inspector edit and the lifecycle: Publish right after typing ships it,
 *       Discard right after typing never has it written back.
 *
 * Every mutation goes through the builder UI (palette, Inspector, grid drags,
 * toolbar). The API is used only to read state back, create a share link and
 * clean up. Timings are recorded per interaction (drag, resize, select, commit,
 * save, publish, public render, PDF) in results.json.
 *
 *   E2E_BASE_URL=… E2E_API_URL=… npx playwright test -c acceptance.config.ts manual-studio
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const DASH = `${API}/api/v1/dashboards`;
const EVIDENCE = process.env.ACCEPT_EVIDENCE_DIR
  || path.resolve(__dirname, '..', '..', 'docs', 'features', 'report-studio-v3', 'manual-studio', 'evidence');
const OLIST = process.env.ACCEPT_OLIST_DASHBOARD || 'Olist commercial review';
const LEGACY_ID = Number(process.env.ACCEPT_LEGACY_DASHBOARD_ID || 574);

type Status = 'PASS' | 'FAIL' | 'NOT VERIFIED';
interface Result { status: Status; assertions: string[]; metrics: Record<string, unknown>; evidence: string[]; notes: string[] }
const results: Record<string, Result> = {};
const made: number[] = [];
let active: string[] = [];

function scenario(name: string): Result {
  results[name] = results[name] ?? { status: 'NOT VERIFIED', assertions: [], metrics: {}, evidence: [], notes: [] };
  if (!active.includes(name)) active.push(name);
  return results[name];
}
function need<T>(r: Result, value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    r.status = 'NOT VERIFIED';
    r.notes.push(`${what} is missing on this environment`);
    throw new Error(`${what} is missing — NOT VERIFIED`);
  }
  return value;
}
function check(r: Result, label: string, ok: boolean, detail = '') {
  r.assertions.push(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) r.status = 'FAIL';
  else if (r.status === 'NOT VERIFIED' && !r.notes.some((n) => /missing on this environment/.test(n))) r.status = 'PASS';
  expect.soft(ok, `${label} ${detail}`).toBe(true);
}
const RESULTS = () => path.join(EVIDENCE, 'results.json');
function persist() {
  let prior: any = {};
  try { prior = JSON.parse(fs.readFileSync(RESULTS(), 'utf8')); } catch { prior = {}; }
  fs.writeFileSync(RESULTS(), JSON.stringify({ sha: process.env.ACCEPT_SHA ?? prior.sha ?? '', ranAt: new Date().toISOString(), results: { ...(prior.results ?? {}), ...results } }, null, 2));
}
test.beforeAll(() => { fs.mkdirSync(EVIDENCE, { recursive: true }); });
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
    for (const name of active) {
      const r = results[name];
      if (r && !r.notes.some((n) => /missing on this environment/.test(n))) {
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

// ── API reads ────────────────────────────────────────────────────────────────

const get = (request: APIRequestContext, id: number) => request.get(`${DASH}/${id}`).then((r) => r.json());
async function idOf(request: APIRequestContext, name: string) {
  const d = await request.get(`${DASH}/?limit=300`).then((r) => r.json());
  return ((Array.isArray(d) ? d : d.items ?? []) as any[]).find((x) => x.name === name)?.id as number | undefined;
}
async function copyOf(request: APIRequestContext, sourceId: number) {
  const dup = await request.post(`${DASH}/${sourceId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  made.push(d.id);
  return d.id as number;
}
async function linkFor(request: APIRequestContext, id: number, name = 'manual-studio') {
  const link = await request.post(`${DASH}/${id}/public-links`, { data: { name } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  return (await link.json()).token as string;
}

// ── page helpers ─────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function settle(page: Page) {
  await page.waitForSelector('[data-grid-item-id], [data-tile-id], [data-testid="report-empty-state"]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && !e.closest('[data-grid-item-id]'));
    for (const el of els) { for (let y = 0; y <= el.scrollHeight; y += 400) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } el.scrollTo(0, 0); }
  });
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
async function shot(page: Page, r: Result, name: string) {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    const inner = Array.from(document.querySelectorAll('main, div')).filter((e) => !e.closest('[data-grid-item-id]'))
      .reduce((acc, e) => Math.max(acc, (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) ? (e as HTMLElement).scrollHeight + e.getBoundingClientRect().top : 0), 0);
    return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0, inner);
  });
  await page.setViewportSize({ width: vp.width, height: Math.ceil(Math.min(Math.max(h, vp.height), 9000)) });
  await page.waitForTimeout(1200);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: true, type: 'jpeg', quality: 64 });
  await page.setViewportSize(vp);
  r.evidence.push(file);
}
const audit = (page: Page) => page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<null | { findings: Array<{ code: string; tileId: number; detail: string }> }>;
const HARD = ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'];

/** Grid cells of every tile on the builder page, from the rendered DOM. */
const cells = (page: Page) => page.evaluate(() => {
  const grid = document.querySelector('main .react-grid-layout') as HTMLElement | null;
  const g = grid?.getBoundingClientRect();
  return Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    const kind = e.querySelector('[data-widget-type]')?.getAttribute('data-widget-type') ?? e.querySelector('[data-tile-kind]')?.getAttribute('data-tile-kind') ?? 'chart';
    return { id: Number(e.getAttribute('data-grid-item-id')), kind, x: Math.round(b.x - (g?.x ?? 0)), y: Math.round(b.y - (g?.y ?? 0)), w: Math.round(b.width), h: Math.round(b.height) };
  });
});
function overlaps(list: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
  const out: string[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i]; const b = list[j];
    if (a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2) out.push(`${a.id}×${b.id}`);
  }
  return out;
}
const tileOf = (page: Page, id: number) => page.locator(`main [data-grid-item-id="${id}"]`);
const kpiTile = (page: Page, title: RegExp) => page.locator('main [data-grid-item-id]').filter({ has: page.locator('[data-tile-kind="kpi"]') }).filter({ hasText: title }).first();

async function openAdd(page: Page) {
  await page.getByTestId('add-element-open').click();
  await page.getByTestId('add-element-menu').waitFor();
}
async function addElement(page: Page, kind: string) {
  await openAdd(page);
  await page.getByTestId(`add-element-${kind}`).click();
  await page.waitForTimeout(1500);
}
/** Add saved charts through the palette's chart picker (search + pick + Add). */
async function addCharts(page: Page, names: string[]) {
  await openAdd(page);
  await page.getByTestId('add-element-chart').click();
  // The picker is a modal; it is found by its search field.
  const search = page.getByPlaceholder(/Search saved charts|Tìm biểu đồ đã lưu/);
  await search.waitFor();
  for (const name of names) {
    await search.fill(name);
    await page.waitForTimeout(500);
    await page.locator('button').filter({ has: page.locator('p', { hasText: new RegExp(`^${esc(name)}$`) }) }).first().click();
  }
  await search.fill('');
  const t0 = Date.now();
  await page.getByRole('button', { name: /^(Add \d+ charts|Thêm \d+ biểu đồ|Add Chart|Thêm biểu đồ)$/ }).click();
  await search.waitFor({ state: 'hidden', timeout: 60_000 });
  await page.waitForTimeout(2500);
  return Date.now() - t0;
}
/** Click a tile body to select it (Shift adds). Returns the time to the ring. */
async function select(page: Page, item: Locator, additive = false) {
  await item.scrollIntoViewIfNeeded();
  const t0 = Date.now();
  await item.click({ position: { x: 60, y: 60 }, modifiers: additive ? ['Shift'] : [] });
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-grid-item-id="${id}"]`);
    return !!el && !!el.querySelector('.ring-2, [class*="ring-2"]');
  }, await item.getAttribute('data-grid-item-id'), { timeout: 5000 }).catch(() => {});
  return Date.now() - t0;
}
async function inspectorHeading(page: Page) {
  return (await page.getByTestId('inspector-heading').innerText().catch(() => '')).trim();
}
async function drag(page: Page, el: Locator, dx: number, dy: number, grip = { x: 30, y: 12 }) {
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  const t0 = Date.now();
  await page.mouse.move(b.x + grip.x, b.y + grip.y);
  await page.mouse.down();
  await page.mouse.move(b.x + grip.x + dx / 2, b.y + grip.y + dy / 2, { steps: 8 });
  await page.mouse.move(b.x + grip.x + dx, b.y + grip.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  return Date.now() - t0;
}
async function resize(page: Page, item: Locator, dx: number, dy: number) {
  await item.scrollIntoViewIfNeeded();
  await item.hover();
  const h = item.locator('.react-resizable-handle-se').first();
  const b = (await h.boundingBox())!;
  const t0 = Date.now();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  return Date.now() - t0;
}
async function saveAndPublish(page: Page, request: APIRequestContext, id: number, r: Result) {
  const save = page.getByTestId('dashboard-save-draft');
  if (await save.isEnabled().catch(() => false)) {
    const t0 = Date.now();
    await save.click();
    await page.waitForTimeout(1500);
    r.metrics.save_draft_ms = Date.now() - t0;
  }
  const t1 = Date.now();
  await page.getByTestId('dashboard-publish').click();
  await expect.poll(async () => ((await get(request, id)).dashboard_charts ?? []).every((c: any) => !c.layout?.draftOnly), { timeout: 60_000 }).toBe(true);
  r.metrics.publish_ms = Date.now() - t1;
  await page.waitForTimeout(1500);
}
async function outline(page: Page) {
  if (!(await page.getByTestId('inspector-outline').isVisible().catch(() => false))) {
    // Escape clears the selection only outside a text field (typing Escape in
    // the Inspector's title must not deselect): leave the field first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    if (!(await page.getByTestId('report-inspector').isVisible().catch(() => false))) await page.getByTestId('inspector-toggle').click();
  }
  await page.getByTestId('inspector-outline').waitFor({ timeout: 10_000 });
  return page.evaluate(() => ({
    sections: Array.from(document.querySelectorAll('[data-outline-section]')).map((s) => ({
      header: Number(s.getAttribute('data-outline-section')),
      members: Array.from(s.querySelectorAll('[data-outline-id]')).map((e) => Number(e.getAttribute('data-outline-id'))).slice(1),
    })),
    issues: Array.from(document.querySelectorAll('[data-issue-kind]')).map((e) => e.getAttribute('data-issue-kind')),
  }));
}

/** The published report at the three reader widths: what it says and how it sits. */
async function publicAt(ctx: BrowserContext, url: string, r: Result, prefix: string) {
  const out: Record<number, any> = {};
  for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]] as const) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    const t0 = Date.now();
    await p.goto(url);
    await settle(p);
    r.metrics[`${prefix}_public_render_${w}_ms`] = Date.now() - t0;
    const info = await p.evaluate(() => {
      const header = document.querySelector('[data-report-header]');
      const order = Array.from(document.querySelectorAll('[data-grid-item-id]')).map((e) => {
        const b = e.getBoundingClientRect();
        return { id: Number(e.getAttribute('data-grid-item-id')), top: Math.round(b.top + window.scrollY), left: Math.round(b.left), kind: e.querySelector('[data-widget-type]')?.getAttribute('data-widget-type') ?? 'chart' };
      }).sort((a, b) => a.top - b.top || a.left - b.left);
      return {
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        headerTitle: header?.querySelector('.dashboard-report-header__title')?.textContent?.trim() ?? null,
        headerDescription: header?.querySelector('.dashboard-report-header__description')?.textContent?.trim() ?? null,
        headerPeriod: header?.querySelector('[data-header-period]')?.textContent?.trim() ?? null,
        headerContext: header?.querySelector('[data-header-context]')?.textContent?.trim() ?? null,
        narrative: Array.from(document.querySelectorAll('.dashboard-narrative [data-finding]')).map((e) => e.textContent?.trim() ?? ''),
        bands: document.querySelectorAll('[data-section-band]').length,
        bandRects: Array.from(document.querySelectorAll('[data-section-band]')).map((e) => {
          const b = e.getBoundingClientRect();
          return { key: Number(e.getAttribute('data-section-band')), top: Math.round(b.top + window.scrollY), bottom: Math.round(b.bottom + window.scrollY), left: Math.round(b.left), right: Math.round(b.right) };
        }),
        tileRects: Array.from(document.querySelectorAll('[data-grid-item-id]')).map((e) => {
          const b = e.getBoundingClientRect();
          return { id: Number(e.getAttribute('data-grid-item-id')), top: Math.round(b.top + window.scrollY), bottom: Math.round(b.bottom + window.scrollY), left: Math.round(b.left), right: Math.round(b.right) };
        }),
        order: order.map((o) => o.id),
        kinds: order.map((o) => o.kind),
        kpis: Array.from(document.querySelectorAll('.dashboard-kpi-value')).map((e) => ({ text: (e.textContent ?? '').trim(), size: parseFloat(getComputedStyle(e).fontSize) })),
        // The last x tick of every chart must sit inside its chart (it was cut to "Oct 1").
        clippedTicks: Array.from(document.querySelectorAll('svg.recharts-surface')).flatMap((svg) => {
          const box = svg.getBoundingClientRect();
          return Array.from(svg.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick text')).filter((tx) => {
            const b = (tx as SVGGraphicsElement).getBoundingClientRect();
            return b.width > 0 && (b.right > box.right + 1 || b.left < box.left - 1);
          }).map((tx) => (tx.textContent ?? '').trim());
        }),
        // A short legend shows every label (a scroll strip hid the second one on a phone).
        clippedLegends: Array.from(document.querySelectorAll('.recharts-legend-wrapper ul')).filter((ul) => {
          const el = ul as HTMLElement;
          return el.children.length <= 6 && el.scrollWidth > el.clientWidth + 1;
        }).map((ul) => (ul.textContent ?? '').trim().slice(0, 60)),
        // Header, text and KPI cards show all they say (the phone split header was cut off).
        clippedContent: Array.from(document.querySelectorAll('[data-grid-item-id]')).flatMap((item) => {
          const tile = item.querySelector('[data-widget-type="hero_strip"], [data-widget-type="text"], [data-widget-type="narrative"], [data-tile-kind="kpi"]') as HTMLElement | null;
          if (!tile) return [];
          const inner = tile.querySelector('.dashboard-report-header, .dashboard-narrative') as HTMLElement | null ?? tile;
          const kind = tile.getAttribute('data-widget-type') ?? tile.getAttribute('data-tile-kind');
          return inner.scrollHeight > inner.clientHeight + 3 ? [`${item.getAttribute('data-grid-item-id')}:${kind}:${inner.scrollHeight}/${inner.clientHeight}`] : [];
        }),
      };
    });
    const a = await audit(p);
    const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `${prefix} public ${w}px: no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    check(r, `${prefix} public ${w}px: no sideways scroll`, !info.overflowX);
    check(r, `${prefix} public ${w}px: no chart cuts its last axis label`, info.clippedTicks.length === 0, info.clippedTicks.join(','));
    check(r, `${prefix} public ${w}px: headers, text and KPI cards show all they say`, info.clippedContent.length === 0, info.clippedContent.join(','));
    check(r, `${prefix} public ${w}px: every short legend shows all its labels`, info.clippedLegends.length === 0, info.clippedLegends.join(' | '));
    out[w] = info;
    await shot(p, r, `${prefix}-public-${w}`);
    await p.close();
  }
  return out;
}
/** Tiles a section's band covers that are not in the section (it groups what it does not hold). */
function bandIntruders(info: any, header: number, members: number[]) {
  const band = (info.bandRects ?? []).find((b: any) => b.key === header);
  if (!band) return ['no band'];
  const own = new Set([header, ...members]);
  return (info.tileRects ?? []).filter((t: any) => !own.has(t.id)
    && t.top >= band.top - 2 && t.bottom <= band.bottom + 2 && t.left >= band.left - 2 && t.right <= band.right + 2).map((t: any) => String(t.id));
}
/** On one column, a heading is followed by its members, never by another section's. */
function headingKeepsMembers(order: number[], sections: Array<{ header: number; members: number[] }>) {
  for (const s of sections) {
    const at = order.indexOf(s.header);
    if (at < 0) continue;
    const next = order.slice(at + 1, at + 1 + s.members.length);
    if (s.members.length && !s.members.every((m) => next.includes(m))) return `${s.header}: ${next.join(',')} ≠ ${s.members.join(',')}`;
  }
  return null;
}
async function exportPdf(ctx: BrowserContext, url: string, r: Result, name: string) {
  const pub = await ctx.newPage();
  await pub.setViewportSize({ width: 1440, height: 900 });
  await pub.goto(url);
  await settle(pub);
  const t0 = Date.now();
  const download = pub.waitForEvent('download', { timeout: 300_000 });
  await pub.getByRole('button', { name: /^(Export PDF|Xuất PDF)$/ }).first().click();
  await pub.getByRole('button', { name: /^(Export PDF|Xuất PDF)$/ }).last().click();
  const file = await download;
  r.metrics[`${name}_pdf_ms`] = Date.now() - t0;
  const bytes = fs.readFileSync((await file.path())!);
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
  r.metrics[`${name}_pdf_pages`] = pages;
  check(r, `${name}: the PDF has pages`, pages >= 1, String(pages));
  const outcome = await pub.evaluate(() => (window as any).__APPBI_LAST_EXPORT__ ?? null);
  check(r, `${name}: the PDF reports nothing missing`, !!outcome && (outcome.warnings ?? []).filter((w: any) => (w.kind ?? 'incomplete') === 'incomplete').length === 0, JSON.stringify(outcome?.warnings ?? []).slice(0, 300));
  fs.writeFileSync(path.join(EVIDENCE, `${name}.pdf`), bytes);
  r.evidence.push(`${name}.pdf`);
  await pub.close();
}

// ── M1 · blank → finished report ────────────────────────────────────────────

test('M1 blank to finished report, through the builder UI', async ({ page, request, context }) => {
  test.setTimeout(900_000);
  const r = scenario('M1 blank to finished');
  const name = `Commercial review ${Date.now().toString(36)}`;
  const description = 'Revenue, orders and delivery on the Olist marketplace, month by month.';
  await page.setViewportSize({ width: 1440, height: 1600 });

  // New report from the list.
  await page.goto('/dashboards');
  await page.getByRole('button', { name: /^(New Dashboard|Tạo dashboard)$/ }).click();
  await page.getByTestId('dashboard-create-name').fill(name);
  await page.getByTestId('dashboard-create-description').fill(description);
  await page.getByTestId('dashboard-create-submit').click();
  await page.waitForURL(/\/dashboards\/\d+$/, { timeout: 30_000 });
  const id = Number(page.url().match(/dashboards\/(\d+)$/)![1]);
  made.push(id);
  await settle(page);
  check(r, 'a new report opens in the builder on its guided start', await page.getByTestId('report-start').isVisible());
  await shot(page, r, 'M1-01-guided-start');

  // Step 1 — the report header.
  await page.getByTestId('report-start-header').click();
  await page.locator('[data-report-header]').waitFor({ timeout: 20_000 });
  const hdr = page.locator('[data-report-header]');
  check(r, 'the header states the report name without it being typed', (await hdr.locator('.dashboard-report-header__title').innerText()).trim() === name);
  check(r, 'the header states the report description', (await hdr.locator('.dashboard-report-header__description').innerText()).includes('Olist marketplace'));
  check(r, 'the new header is open in the Inspector', /mở đầu|header/i.test(await inspectorHeading(page)), await inspectorHeading(page));

  // Charts go under the selected header.
  const addMs = await addCharts(page, ['Olist · Revenue', 'Olist · Orders', 'Olist · Average order value', 'Olist · Revenue by month', 'Olist · Revenue by category']);
  r.metrics.add_5_charts_ms = addMs;
  await settle(page);
  let c = await cells(page);
  const header = c.find((x) => x.kind === 'hero_strip')!;
  const charts = c.filter((x) => x.kind !== 'hero_strip');
  check(r, 'five charts were added', charts.length === 5, String(charts.length));
  check(r, 'the charts were placed under the selected header', charts.every((x) => x.y >= header.y + header.h - 2), JSON.stringify(c.map((x) => [x.id, x.y])));
  check(r, 'nothing overlaps after adding', overlaps(c).length === 0, overlaps(c).join(','));

  // KPI strip from the three KPIs.
  const kpis = page.locator('main [data-grid-item-id]').filter({ has: page.locator('[data-tile-kind="kpi"]') });
  check(r, 'three KPIs are on the page', (await kpis.count()) === 3, String(await kpis.count()));
  r.metrics.select_ms = await select(page, kpis.nth(0));
  await select(page, kpis.nth(1), true);
  await select(page, kpis.nth(2), true);
  if (!(await page.getByTestId('report-inspector').isVisible().catch(() => false))) await page.getByTestId('inspector-toggle').click();
  check(r, 'the Inspector shows the multi-selection', /3/.test(await inspectorHeading(page)), await inspectorHeading(page));
  let t0 = Date.now();
  await page.getByTestId('inspector-pattern-kpiStrip').click();
  await page.waitForTimeout(900);
  r.metrics.pattern_commit_ms = Date.now() - t0;
  c = await cells(page);
  const strip = c.filter((x) => x.kind === 'kpi');
  check(r, 'the KPI strip is one row', new Set(strip.map((x) => x.y)).size === 1, JSON.stringify(strip.map((x) => x.y)));
  check(r, 'the KPI strip has equal widths', Math.max(...strip.map((x) => x.w)) - Math.min(...strip.map((x) => x.w)) <= 3, JSON.stringify(strip.map((x) => x.w)));
  check(r, 'nothing overlaps after the pattern', overlaps(c).length === 0, overlaps(c).join(','));

  // A section heading under the KPIs adopts the charts below it.
  const lastKpi = strip.sort((a, b) => b.x - a.x)[0];
  await select(page, tileOf(page, lastKpi.id));
  await addElement(page, 'section_header');
  await page.getByTestId('section-title').fill('Revenue drivers');
  await page.waitForTimeout(1500);
  c = await cells(page);
  const section = c.find((x) => x.kind === 'section_header')!;
  const ol = await outline(page);
  const sec = ol.sections.find((s) => s.header === section.id);
  const below = c.filter((x) => x.kind !== 'kpi' && x.kind !== 'hero_strip' && x.kind !== 'section_header').map((x) => x.id);
  check(r, 'the new section introduces the charts under it', !!sec && below.every((m) => sec.members.includes(m)), JSON.stringify({ sec, below }));
  check(r, 'the outline reports nothing broken', ol.issues.length === 0, ol.issues.join(','));

  // An insight stated from the data, at the start of the section.
  await select(page, tileOf(page, section.id));
  await addElement(page, 'narrative');
  const options = page.getByTestId('report-inspector').locator('[data-finding-option]');
  await expect.poll(() => options.count(), { timeout: 30_000 }).toBeGreaterThan(1);
  await options.nth(0).check();
  await options.nth(1).check();
  await expect.poll(async () => page.getByTestId('inspector-save-state').getAttribute('data-state'), { timeout: 15_000 }).toBe('saved');
  await page.waitForTimeout(2500);
  const sentences = await page.locator('main .dashboard-narrative [data-finding]').allInnerTexts();
  check(r, 'the insight states two findings, each with a figure', sentences.length >= 2 && sentences.every((s) => /\d/.test(s)), JSON.stringify(sentences));
  const narr = (await cells(page)).find((x) => x.kind === 'narrative')!;
  // Fit it to what it says.
  t0 = Date.now();
  await page.getByTestId('inspector-fit').click();
  await page.waitForTimeout(900);
  r.metrics.fit_commit_ms = Date.now() - t0;
  const fitted = await page.evaluate((nid) => {
    const el = document.querySelector(`[data-grid-item-id="${nid}"] [data-tile-id="${nid}"]`) as HTMLElement | null;
    return el ? { scroll: el.scrollHeight, client: el.clientHeight } : null;
  }, narr.id);
  check(r, 'fit to content: the insight shows all it says, without a large empty band', !!fitted && fitted.scroll <= fitted.client + 4 && fitted.client - fitted.scroll < 80, JSON.stringify(fitted));

  // Emphasis: Revenue leads.
  const revenue = kpiTile(page, /^Revenue|Olist · Revenue$/);
  await revenue.dblclick({ position: { x: 60, y: 60 } });
  await page.getByTestId('inspector-emphasis-lead').click();
  await page.waitForTimeout(1200);
  const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('main [data-emphasis] .dashboard-kpi-value')).map((e) => ({ lead: (e.closest('[data-emphasis]') as HTMLElement).dataset.emphasis, size: parseFloat(getComputedStyle(e).fontSize) })));
  const lead = sizes.find((s) => s.lead === 'lead')?.size ?? 0;
  const others = sizes.filter((s) => s.lead !== 'lead').map((s) => s.size);
  check(r, 'the lead KPI reads larger than the others', lead > 0 && others.length > 0 && others.every((s) => lead >= s * 1.2), JSON.stringify(sizes));

  // A resize and a typed width, both through the one placement rule.
  const chartItem = tileOf(page, below[0]);
  r.metrics.resize_ms = await resize(page, chartItem, -120, 40);
  c = await cells(page);
  check(r, 'nothing overlaps after a resize', overlaps(c).length === 0, overlaps(c).join(','));

  // The section moves as a whole: drag its heading above the KPIs.
  const before = await cells(page);
  const secBefore = before.find((x) => x.id === section.id)!;
  const kpiTop = Math.min(...before.filter((x) => x.kind === 'kpi').map((x) => x.y));
  r.metrics.drag_ms = await drag(page, tileOf(page, section.id), 0, kpiTop - secBefore.y - 4);
  await page.waitForTimeout(1200);
  const afterMove = await cells(page);
  const secAfter = afterMove.find((x) => x.id === section.id)!;
  const kept = (sec?.members ?? []).every((m) => {
    const b0 = before.find((x) => x.id === m); const b1 = afterMove.find((x) => x.id === m);
    return !!b0 && !!b1 && Math.abs((b1.y - secAfter.y) - (b0.y - secBefore.y)) <= 3;
  });
  check(r, 'moving the heading moved its section: every member kept its place under it', kept && secAfter.y < secBefore.y, JSON.stringify({ secBefore: secBefore.y, secAfter: secAfter.y }));
  check(r, 'the KPIs were pushed below the moved section', afterMove.filter((x) => x.kind === 'kpi').every((x) => x.y > secAfter.y), JSON.stringify(afterMove.map((x) => [x.id, x.kind, x.y])));
  check(r, 'nothing overlaps after the section move', overlaps(afterMove).length === 0, overlaps(afterMove).join(','));
  await shot(page, r, 'M1-02-section-moved');
  // Undo puts it back.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(Undo \(Ctrl\+Z\)|Hoàn tác \(Ctrl\+Z\))/ }).first().click();
  await page.waitForTimeout(1200);
  const undone = await cells(page);
  check(r, 'undo returns the section to where it was', Math.abs(undone.find((x) => x.id === section.id)!.y - secBefore.y) <= 3);
  await shot(page, r, 'M1-03-builder-final');

  // The section as it stands after every edit (the insight joined it).
  const finalOutline = await outline(page);
  const secFinal = finalOutline.sections.find((s) => s.header === section.id);
  check(r, 'the insight belongs to the section it was added under', !!secFinal && secFinal.members.includes(narr.id), JSON.stringify(secFinal));
  await saveAndPublish(page, request, id, r);
  const saved = await get(request, id);
  const stated = (saved.dashboard_charts ?? []).filter((d: any) => d.layout?.sectionId === section.id).map((d: any) => d.id);
  check(r, 'the published report stores the section membership', (secFinal?.members ?? []).every((m) => stated.includes(m)), JSON.stringify({ stated, members: secFinal?.members }));

  const audience = `${name} (for readers)`;
  const token = await linkFor(request, id, audience);
  const pub = await publicAt(context, `/d/${token}`, r, 'M1');
  // The link is named for its readers; the header states that title (the
  // link manager's contract), not the internal report name.
  check(r, 'public header states the title the link presents to its readers', pub[1440].headerTitle === audience, String(pub[1440].headerTitle));
  check(r, 'public header states the description', (pub[1440].headerDescription ?? '').includes('Olist marketplace'));
  check(r, 'public header states the period the data covers', !!pub[1440].headerPeriod && /\d{4}/.test(pub[1440].headerPeriod), String(pub[1440].headerPeriod));
  check(r, 'public insight states the same findings', pub[1440].narrative.length >= 2 && pub[1440].narrative.every((s: string) => /\d/.test(s)), JSON.stringify(pub[1440].narrative));
  check(r, 'the published section draws its band', pub[1440].bands >= 1, String(pub[1440].bands));
  const intrudersM1 = bandIntruders(pub[1440], section.id, secFinal?.members ?? []);
  check(r, 'the band holds only its section', intrudersM1.length === 0, intrudersM1.join(','));
  const miss = headingKeepsMembers(pub[390].order, [{ header: section.id, members: secFinal?.members ?? [] }]);
  check(r, 'on a phone the heading is followed by its own members', !miss, miss ?? '');
  check(r, 'on a phone the report header comes first', pub[390].kinds[0] === 'hero_strip', pub[390].kinds.slice(0, 3).join(','));
  await exportPdf(context, `/d/${token}`, r, 'M1-report');
});

// ── M2 · selected charts → a professional report ────────────────────────────

test('M2 an existing report of charts becomes a composed report', async ({ page, request, context }) => {
  test.setTimeout(900_000);
  const r = scenario('M2 charts to professional report');
  const src = need(r, await idOf(request, OLIST), `report "${OLIST}"`);
  const id = await copyOf(request, src);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await shot(page, r, 'M2-01-before');

  // KPI strip of the four KPIs.
  const kpis = page.locator('main [data-grid-item-id]').filter({ has: page.locator('[data-tile-kind="kpi"]') });
  const nK = await kpis.count();
  for (let i = 0; i < Math.min(nK, 4); i += 1) await select(page, kpis.nth(i), i > 0);
  if (!(await page.getByTestId('report-inspector').isVisible().catch(() => false))) await page.getByTestId('inspector-toggle').click();
  await page.getByTestId('inspector-pattern-kpiStrip').click();
  await page.waitForTimeout(900);

  // Lead + supporting: the trend leads, the mix supports.
  const trend = page.locator('main [data-grid-item-id]').filter({ hasText: /Revenue by month/ }).first();
  const mix = page.locator('main [data-grid-item-id]').filter({ hasText: /Payment mix/ }).first();
  const trendId = Number(await trend.getAttribute('data-grid-item-id'));
  const mixId = Number(await mix.getAttribute('data-grid-item-id'));
  await trend.dblclick({ position: { x: 80, y: 20 } });
  await page.getByTestId('inspector-emphasis-lead').click();
  // The double-click selected the trend; the mix joins it.
  await select(page, mix, true);
  await page.getByTestId('inspector-pattern-leadSupport').click();
  await page.waitForTimeout(900);
  let c = await cells(page);
  const tr = c.find((x) => x.id === trendId)!;
  const mixCell = c.find((x) => x.id === mixId)!;
  check(r, 'the lead chart takes about two thirds of the row', tr.w > mixCell.w * 1.6, `${tr.w} vs ${mixCell.w}`);
  check(r, 'nothing overlaps after the patterns', overlaps(c).length === 0, overlaps(c).join(','));

  // A split report header whose headline is a finding.
  await page.keyboard.press('Escape');
  await addElement(page, 'hero_strip');
  await page.getByTestId('header-variant-split').click();
  const picks = page.getByTestId('report-inspector').locator('[data-finding-option]');
  await expect.poll(() => picks.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await picks.first().check();
  await expect.poll(async () => page.getByTestId('inspector-save-state').getAttribute('data-state'), { timeout: 15_000 }).toBe('saved');
  await page.waitForTimeout(2500);
  const headline = page.locator('[data-header-finding]');
  check(r, 'the header headline is a finding stated from data', (await headline.getAttribute('data-finding-state')) === 'ready' && /\d/.test(await headline.innerText()), await headline.innerText().catch(() => ''));
  c = await cells(page);
  check(r, 'the header opens the report', c.filter((x) => x.kind === 'hero_strip').every((h) => c.every((o) => o.y >= h.y)), JSON.stringify(c.map((x) => [x.kind, x.y])));
  check(r, 'nothing overlaps after adding the header', overlaps(c).length === 0, overlaps(c).join(','));
  await shot(page, r, 'M2-02-composed');

  await saveAndPublish(page, request, id, r);
  const token = await linkFor(request, id, 'Olist commercial review — partners');
  const pub = await publicAt(context, `/d/${token}`, r, 'M2');
  check(r, 'public: the header headline is stated', !!pub[1440].headerTitle);
  const kSizes = pub[1440].kpis.map((k: any) => k.size);
  check(r, 'public: KPI figures are readable (≥ 20px) and not shouting (≤ 60px)', kSizes.length > 0 && kSizes.every((s: number) => s >= 20 && s <= 60), JSON.stringify(kSizes));
});

// ── M3 · improve a migrated report ──────────────────────────────────────────

test('M3 a migrated report is improved: outline, header, section move, filters intact', async ({ page, request, context }) => {
  test.setTimeout(900_000);
  const r = scenario('M3 improve migrated report');
  const src = need(r, (await get(request, LEGACY_ID))?.id as number | undefined, `migrated report ${LEGACY_ID}`);
  const id = await copyOf(request, src);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await shot(page, r, 'M3-01-before');
  const controlsBefore = ((await get(request, id)).dashboard_charts ?? []).filter((d: any) => d.widget_type === 'slicer').length;

  await page.getByTestId('inspector-toggle').click();
  const ol = await outline(page);
  check(r, 'the outline names the report\'s existing section with its members', ol.sections.length >= 1 && ol.sections.every((s) => s.members.length > 0), JSON.stringify(ol.sections));

  // Header at the top.
  await addElement(page, 'hero_strip');
  await page.getByTestId('header-title').fill('Sales performance');
  await expect.poll(async () => page.getByTestId('inspector-save-state').getAttribute('data-state'), { timeout: 15_000 }).toBe('saved');

  // Move the existing section to the top (under the header).
  const secId = ol.sections[0].header;
  const before = await cells(page);
  const s0 = before.find((x) => x.id === secId)!;
  const hero = before.find((x) => x.kind === 'hero_strip')!;
  r.metrics.drag_ms = await drag(page, tileOf(page, secId), 0, (hero.y + hero.h + 8) - s0.y);
  await page.waitForTimeout(1200);
  const after = await cells(page);
  const s1 = after.find((x) => x.id === secId)!;
  const kept = ol.sections[0].members.every((m) => {
    const a = before.find((x) => x.id === m); const b = after.find((x) => x.id === m);
    return !!a && !!b && Math.abs((b.y - s1.y) - (a.y - s0.y)) <= 3;
  });
  check(r, 'the migrated section moved as a whole', kept && s1.y < s0.y, JSON.stringify({ s0: s0.y, s1: s1.y }));
  check(r, 'nothing overlaps after the move', overlaps(after).length === 0, overlaps(after).join(','));
  const ol2 = await outline(page);
  check(r, 'the outline reports nothing broken after the edits', ol2.issues.length === 0, ol2.issues.join(','));
  await shot(page, r, 'M3-02-after');

  await saveAndPublish(page, request, id, r);
  const d = await get(request, id);
  check(r, 'the report\'s filter controls are all still there', (d.dashboard_charts ?? []).filter((x: any) => x.widget_type === 'slicer').length === controlsBefore, String(controlsBefore));
  const token = await linkFor(request, id);
  const pub = await publicAt(context, `/d/${token}`, r, 'M3');
  check(r, 'public: the header states the new title', pub[1440].headerTitle === 'Sales performance', String(pub[1440].headerTitle));
  const intrudersM3 = bandIntruders(pub[1440], secId, ol.sections[0].members);
  check(r, 'public: the band of the moved section holds only its section (KPIs and controls outside stay outside)', intrudersM3.length === 0, intrudersM3.join(','));
  const miss = headingKeepsMembers(pub[390].order, [{ header: secId, members: ol.sections[0].members }]);
  check(r, 'public phone: the moved section keeps its members together', !miss, miss ?? '');
});

// ── M5 · an Inspector edit and the publication lifecycle ───────────────────

test('M5 an Inspector edit is in what Publish ships and never lands after Discard', async ({ page, request, context }) => {
  test.setTimeout(600_000);
  const r = scenario('M5 Inspector edit lifecycle');
  const src = need(r, await idOf(request, OLIST), `report "${OLIST}"`);
  const id = await copyOf(request, src);
  const token = await linkFor(request, id);
  const publicText = async () => {
    const d = await (await context.request.get(`/api/v1/public/dashboards/${token}`)).json();
    return (d.dashboard_charts ?? []).filter((c: any) => c.widget_type === 'text').map((c: any) => String(c.widget_config?.template ?? ''));
  };
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);

  // A text element, typed into and published IMMEDIATELY (no pause for the
  // debounce): Publish must wait for the edit, never ship the empty default.
  await page.keyboard.press('Escape');
  await addElement(page, 'text');
  const field = page.getByTestId('report-inspector').locator('textarea').first();
  const a = `Lifecycle A ${Date.now().toString(36)}`;
  await field.fill(a);
  await page.getByTestId('dashboard-publish').click();
  await expect.poll(async () => (await publicText()).some((s) => s.includes(a)), { timeout: 30_000 }).toBe(true);
  check(r, 'Publish right after typing ships the edit', (await publicText()).some((s) => s.includes(a)), JSON.stringify(await publicText()));

  // Typed, then Discard IMMEDIATELY: the edit must not be written back after it.
  const textTile = page.locator('main [data-grid-item-id]').filter({ has: page.locator('[data-widget-type="text"]') }).first();
  await textTile.dblclick({ position: { x: 40, y: 20 } });
  const field2 = page.getByTestId('report-inspector').locator('textarea').first();
  await field2.waitFor();
  const b = `Lifecycle B ${Date.now().toString(36)}`;
  await field2.fill(b);
  await page.getByTestId('dashboard-discard').click();
  await page.getByRole('button', { name: /^(Discard changes|Bỏ thay đổi)$/ }).click();
  await page.waitForTimeout(3000);
  const draft = await get(request, id);
  const draftTexts = (draft.dashboard_charts ?? []).filter((c: any) => c.widget_type === 'text').map((c: any) => String(c.widget_config?.template ?? ''));
  check(r, 'after Discard the builder holds the published text, not the discarded one',
    draftTexts.some((s: string) => s.includes(a)) && !draftTexts.some((s: string) => s.includes(b)), JSON.stringify(draftTexts));
  check(r, 'the public report never saw the discarded text', !(await publicText()).some((s) => s.includes(b)));
  await page.reload();
  await settle(page);
  const shown = await page.locator('main [data-widget-type="text"]').allInnerTexts();
  check(r, 'after a reload the canvas shows the published text only', shown.some((s) => s.includes(a)) && !shown.some((s) => s.includes(b)), JSON.stringify(shown));
});

// ── A11Y · accessibility audit of the report-building surfaces ─────────────

const AXE = path.resolve(__dirname, '..', '..', 'frontend', 'node_modules', 'axe-core', 'axe.min.js');
async function axeRun(page: Page, include: string[] | null) {
  if (!(await page.evaluate(() => !!(window as any).axe))) await page.addScriptTag({ path: AXE });
  return page.evaluate(async (sel) => {
    const axe = (window as any).axe;
    const ctx = sel && sel.length ? { include: sel.map((s) => [s]) } : document;
    const res = await axe.run(ctx, { resultTypes: ['violations'] });
    return res.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') ?? '' }));
  }, include);
}
const severe = (list: Array<{ impact: string }>) => list.filter((v) => v.impact === 'critical' || v.impact === 'serious');

test('A11Y the palette, Inspector, report header, sections and insights pass axe (no serious or critical issue)', async ({ page, request, context }) => {
  test.setTimeout(600_000);
  const r = scenario('A11Y report building surfaces');
  if (!fs.existsSync(AXE)) { need(r, null, 'axe-core (frontend/node_modules/axe-core)'); }
  const src = need(r, await idOf(request, OLIST), `report "${OLIST}"`);
  const id = await copyOf(request, src);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await page.keyboard.press('Escape');
  await addElement(page, 'hero_strip');
  await addElement(page, 'section_header');
  await addElement(page, 'narrative');
  const opts = page.getByTestId('report-inspector').locator('[data-finding-option]');
  await expect.poll(() => opts.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await opts.first().check();
  await page.waitForTimeout(2500);

  // Builder: the Inspector with an element, then the palette open.
  const inspector = await axeRun(page, ['[data-testid="report-inspector"]']);
  await openAdd(page);
  const palette = await axeRun(page, ['[data-testid="add-element-menu"]']);
  await page.keyboard.press('Escape');
  // Keyboard: the palette opens from the toolbar button and closes on Escape.
  await page.getByTestId('add-element-open').focus();
  await page.keyboard.press('Enter');
  const opened = await page.getByTestId('add-element-menu').isVisible();
  await page.keyboard.press('Escape');
  const closed = !(await page.getByTestId('add-element-menu').isVisible().catch(() => false));
  check(r, 'the Add palette opens from the keyboard and closes on Escape', opened && closed);
  const builderContent = await axeRun(page, ['[data-report-header]', '[data-widget-type="section_header"]', '.dashboard-narrative']);
  const builderPage = await axeRun(page, null);
  r.metrics.builder_page_violations = builderPage.map((v) => `${v.impact}:${v.id}×${v.nodes}`);
  check(r, 'Inspector: no serious or critical accessibility issue', severe(inspector).length === 0, JSON.stringify(severe(inspector)));
  check(r, 'Add palette: no serious or critical accessibility issue', severe(palette).length === 0, JSON.stringify(severe(palette)));
  check(r, 'report header, sections, insights in the builder: no serious or critical issue', severe(builderContent).length === 0, JSON.stringify(severe(builderContent)));

  // Published report at desktop and phone.
  await saveAndPublish(page, request, id, r);
  const token = await linkFor(request, id);
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const p = await context.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.goto(`/d/${token}`);
    await settle(p);
    const content = await axeRun(p, ['[data-report-header]', '[data-widget-type="section_header"]', '.dashboard-narrative']);
    const whole = await axeRun(p, null);
    r.metrics[`public_${w}_page_violations`] = whole.map((v) => `${v.impact}:${v.id}×${v.nodes}`);
    check(r, `public ${w}px: report header, sections, insights have no serious or critical issue`, severe(content).length === 0, JSON.stringify(severe(content)));
    await p.close();
  }
  r.notes.push('Whole-page violations are recorded (metrics), not asserted: they include surfaces outside this change (charts, app chrome). The asserted scope is what this round built.');
});

// ── M4 · two independent datasets ───────────────────────────────────────────

test('M4 one report over two independent datasets', async ({ page, request, context }) => {
  test.setTimeout(900_000);
  const r = scenario('M4 two datasets');
  const name = `Two businesses ${Date.now().toString(36)}`;
  await page.setViewportSize({ width: 1440, height: 1800 });
  await page.goto('/dashboards');
  await page.getByRole('button', { name: /^(New Dashboard|Tạo dashboard)$/ }).click();
  await page.getByTestId('dashboard-create-name').fill(name);
  await page.getByTestId('dashboard-create-description').fill('The marketplace and the sales business, side by side.');
  await page.getByTestId('dashboard-create-submit').click();
  await page.waitForURL(/\/dashboards\/\d+$/, { timeout: 30_000 });
  const id = Number(page.url().match(/dashboards\/(\d+)$/)![1]);
  made.push(id);
  await settle(page);

  await page.getByTestId('report-start-header').click();
  await page.locator('[data-report-header]').waitFor();
  // Marketplace section and its charts.
  await addElement(page, 'section_header');
  await page.getByTestId('section-title').fill('Marketplace');
  await page.waitForTimeout(1200);
  const secA = (await cells(page)).find((x) => x.kind === 'section_header')!.id;
  await select(page, tileOf(page, secA));
  await addCharts(page, ['Olist · Revenue', 'Olist · Revenue by month']);
  // Sales section at the end, then its charts.
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 400);
  await addElement(page, 'section_header');
  await page.getByTestId('section-title').fill('Sales');
  await page.waitForTimeout(1200);
  const secB = (await cells(page)).filter((x) => x.kind === 'section_header').map((x) => x.id).find((x) => x !== secA)!;
  await select(page, tileOf(page, secB));
  await addCharts(page, ['E2E Revenue', 'E2E Revenue over time']);
  await settle(page);
  const ol = await outline(page);
  const a = ol.sections.find((s) => s.header === secA);
  const b = ol.sections.find((s) => s.header === secB);
  check(r, 'each section holds the two charts of its own dataset', (a?.members.length ?? 0) === 2 && (b?.members.length ?? 0) === 2, JSON.stringify(ol.sections));
  check(r, 'the outline reports nothing broken', ol.issues.length === 0, ol.issues.join(','));
  const text = await page.locator('main').innerText();
  check(r, 'both datasets render numbers (no load error)', /R\$/.test(text) && !/Failed to load|Không tải được/.test(text));

  // Each section arranged as a lead trend with its figure beside it.
  for (const s of [a, b]) {
    if (!s || s.members.length !== 2) continue;
    const kinds = await cells(page);
    const kpiId = s.members.find((m) => kinds.find((x) => x.id === m)?.kind === 'kpi');
    const trendId = s.members.find((m) => m !== kpiId);
    if (kpiId == null || trendId == null) { check(r, `section ${s.header}: a KPI and a trend`, false, JSON.stringify(kinds)); continue; }
    const trendTile = tileOf(page, trendId);
    const kpiItem = tileOf(page, kpiId);
    await trendTile.dblclick({ position: { x: 120, y: 150 } });
    await page.getByTestId('inspector-emphasis-lead').click();
    await select(page, kpiItem, true);
    await page.getByTestId('inspector-pattern-leadSupport').click();
    await page.waitForTimeout(900);
    const cs = await cells(page);
    const row = cs.filter((x) => s.members.includes(x.id));
    const width = row.reduce((sum, x) => sum + x.w, 0);
    const full = Math.max(...cs.map((x) => x.x + x.w));
    check(r, `section ${s.header}: its two elements fill the row`, width >= full * 0.95, `${width} of ${full}`);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
  }
  const arranged = await cells(page);
  check(r, 'nothing overlaps after arranging both sections', overlaps(arranged).length === 0, overlaps(arranged).join(','));
  await shot(page, r, 'M4-01-builder');

  await saveAndPublish(page, request, id, r);
  const token = await linkFor(request, id, name);
  const pub = await publicAt(context, `/d/${token}`, r, 'M4');
  // Two independent datasets: each section's own period, never their union.
  const period = String(pub[1440].headerPeriod ?? '');
  check(r, 'public: the header states each dataset’s own period, named by its section', /Marketplace: .*2016.*2018/.test(period) && /Sales: .*2024.*2025/.test(period), period);
  const miss = headingKeepsMembers(pub[390].order, [
    { header: secA, members: a?.members ?? [] },
    { header: secB, members: b?.members ?? [] },
  ]);
  check(r, 'public phone: each dataset\'s charts stay under their own heading', !miss, miss ?? '');
  await exportPdf(context, `/d/${token}`, r, 'M4-report');
});
