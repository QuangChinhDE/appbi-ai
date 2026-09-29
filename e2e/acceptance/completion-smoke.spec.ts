import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Report Studio V3 completion — integrated smoke (Scenarios A–D of the brief).
 *
 * Small on purpose: one Manual report, one AI-designed report, one public /
 * lifecycle / security case, responsive + PDF. The full historical V3 and
 * Unified Grid suites stay the regression; this proves the new capabilities
 * work end to end on a production build. The API is used only for fixtures
 * (a copy of the baseline, a page filter, a link); authoring is done in the UI.
 *
 * Evidence: docs/features/report-studio-v3/completion/evidence. A scenario
 * stays NOT VERIFIED until an assertion ran; a skip is never a pass.
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const DASH = `${API}/api/v1/dashboards`;
const EVIDENCE = path.resolve(__dirname, '..', '..', 'docs', 'features', 'report-studio-v3', 'completion', 'evidence');
const OLIST = process.env.ACCEPT_OLIST_DASHBOARD || 'Olist commercial review';
const STATE_SP = { field: 'customer_state', semanticField: 'dataset_table_3.customer_state', fieldKey: 'dataset_table_3.customer_state',
  datasetId: 1, type: 'dropdown', operator: 'in', value: ['SP'], label: 'Customer state' };

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
function need<T>(r: ScenarioResult, value: T | undefined | null, what: string): T {
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
  fs.writeFileSync(RESULTS, JSON.stringify({ sha: process.env.ACCEPT_SHA ?? prior.sha ?? '', ranAt: new Date().toISOString(),
    results: { ...(prior.results ?? {}), ...results } }, null, 2));
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

// ── fixtures (API) ──────────────────────────────────────────────────────────
async function idOf(request: APIRequestContext, name: string) {
  const res = await request.get(`${DASH}/?limit=300`);
  const list = await res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  return list.find((d: any) => d.name === name)?.id as number | undefined;
}
async function copyOf(request: APIRequestContext, sourceId: number) {
  const dup = await request.post(`${DASH}/${sourceId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  made.push(d.id);
  return d.id as number;
}
const get = (request: APIRequestContext, id: number) => request.get(`${DASH}/${id}`).then((r) => r.json());
async function linkFor(request: APIRequestContext, id: number, filters?: any[]) {
  const link = await request.post(`${DASH}/${id}/public-links`, { data: { name: 'completion', ...(filters ? { filters_config: filters } : {}) } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  return (await link.json()).token as string;
}

// ── page helpers ────────────────────────────────────────────────────────────
async function settle(page: Page) {
  await page.waitForSelector('[data-grid-item-id], [data-tile-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) { for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } el.scrollTo(0, 0); }
  });
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function shot(page: Page, r: ScenarioResult, name: string) {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    const inner = Array.from(document.querySelectorAll('main, div')).filter((e) => !e.closest('[data-grid-item-id]')).reduce((acc, e) => Math.max(acc, (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) ? (e as HTMLElement).scrollHeight + e.getBoundingClientRect().top : 0), 0);
    return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0, inner);
  });
  await page.setViewportSize({ width: vp.width, height: Math.ceil(Math.min(Math.max(h, vp.height), 8000)) });
  await page.waitForTimeout(1400);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: true, type: 'jpeg', quality: 62 });
  await page.setViewportSize(vp);
  r.evidence.push(file);
}
async function audit(page: Page) {
  return page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<null | { findings: Array<{ code: string; tileId: number }> }>;
}
const HARD = ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'];
const rects = (page: Page) => page.evaluate(() => {
  const g = document.querySelector('main .react-grid-layout')?.getBoundingClientRect();
  return Object.fromEntries(Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    return [e.getAttribute('data-grid-item-id'), [Math.round(b.left - (g?.left ?? 0)), Math.round(b.top - (g?.top ?? 0)), Math.round(b.width), Math.round(b.height)]];
  })) as Record<string, [number, number, number, number]>;
});
const tileByTitle = (page: Page, title: string) => page.locator('main [data-grid-item-id]').filter({ hasText: title }).first();
const control = (page: Page, label: RegExp) => page.locator('main [data-widget-type="slicer"]').filter({ hasText: label }).first();
async function select(page: Page, tile: Locator) {
  await tile.scrollIntoViewIfNeeded();
  await tile.locator('[data-tile-kind]').first().click({ position: { x: 120, y: 60 } });
  await page.waitForTimeout(400);
}
/** Make sure this tile is (still) the selection — a click on a selected tile unselects it. */
async function ensureSelected(page: Page, tile: Locator) {
  if (await page.getByTestId('arrange-frame-subtle').isVisible().catch(() => false)) return;
  await select(page, tile);
}
async function frameOf(page: Page, id: string) {
  return page.locator(`[data-grid-item-id="${id}"] [data-tile-frame]`).first().getAttribute('data-tile-frame');
}
const undo = (page: Page) => page.getByRole('button', { name: /^Undo \(Ctrl\+Z\)/ }).click();
async function publishUi(page: Page) {
  await page.getByTestId('dashboard-publish').click();
  await page.waitForTimeout(3500);
}
async function openBaseline(page: Page, request: APIRequestContext, r: ScenarioResult, height = 2600) {
  const src = await idOf(request, OLIST);
  const id = await copyOf(request, need(r, src, `baseline "${OLIST}"`));
  await page.setViewportSize({ width: 1440, height });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  return id;
}
async function publicAt(ctx: BrowserContext, token: string, width: number, height: number) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.goto(`/d/${token}`);
  await settle(p);
  return p;
}

// ── A · Manual builder ──────────────────────────────────────────────────────
test('A manual builder: frame, a control next to a chart in a full row, drag auto-scroll, scope cue, publish', async ({ page, request, context }) => {
  const r = scenario('A manual builder');
  const id = await openBaseline(page, request, r, 900);

  // Frame: a chart becomes a subtle panel; one undo gives the card back.
  const cat = tileByTitle(page, 'Revenue by category');
  const catId = need(r, await cat.getAttribute('data-grid-item-id'), 'the "Revenue by category" chart');
  await select(page, cat);
  const frameBtn = page.getByTestId('arrange-frame-subtle');
  check(r, 'with one chart selected the bar offers a frame', await frameBtn.isVisible().catch(() => false));
  await frameBtn.click();
  await page.waitForTimeout(600);
  check(r, 'the chart is drawn as a subtle panel', (await frameOf(page, catId)) === 'subtle', String(await frameOf(page, catId)));
  await undo(page);
  await page.waitForTimeout(600);
  check(r, 'one undo gives the card back', (await frameOf(page, catId)) === 'card', String(await frameOf(page, catId)));
  await ensureSelected(page, cat);
  await page.getByTestId('arrange-frame-subtle').click();
  await page.waitForTimeout(600);

  // "Next to" in a FULL row: the control goes directly above the chart; no drag,
  // no shrinking an unrelated chart, nothing overlaps.
  const state = tileByTitle(page, 'Revenue by state');
  const stateId = need(r, await state.getAttribute('data-grid-item-id'), 'the "Revenue by state" chart');
  const before = await rects(page);
  await select(page, state);
  await page.getByTestId('add-slicer-open').click();
  await page.getByTestId('add-slicer-modal').waitFor();
  await page.getByTestId('add-slicer-where-beside').click();
  await page.getByTestId('add-slicer-search').fill('category');
  await page.getByTestId('add-slicer-modal').locator('[data-testid^="add-slicer-field-"]').filter({ hasText: /category/i }).first().click();
  await expect.poll(() => page.locator('main [data-widget-type="slicer"]').filter({ hasText: /categor/i }).count(), { timeout: 30_000 }).toBe(1);
  await page.waitForTimeout(1500);
  const after = await rects(page);
  const ctlId = await control(page, /categor/i).locator('xpath=ancestor::*[@data-grid-item-id][1]').getAttribute('data-grid-item-id');
  const c = after[stateId]; const k = after[String(ctlId)];
  check(r, 'the control sits directly above the chart, in its column', !!k && !!c && k[1] + k[3] <= c[1] + 8 && Math.abs(k[0] - c[0]) <= 8, `${k} vs ${c}`);
  check(r, 'the neighbouring chart kept its width (nothing was shrunk)', after[catId]?.[2] === before[catId]?.[2], `${before[catId]} → ${after[catId]}`);
  const a = await audit(page);
  check(r, 'nothing overlaps after the placement', !(a?.findings ?? []).some((f) => f.code === 'tile.overlap'), JSON.stringify(a?.findings ?? []));
  const scope = await control(page, /categor/i).locator('[data-slicer-scope]').first().getAttribute('title');
  check(r, 'the control says it filters the whole page', /every chart on this page|mọi biểu đồ trên trang này/i.test(scope ?? ''), String(scope));

  // Auto-scroll: drag the page's first control to the bottom edge of a 900px
  // window and hold — the report scrolls under the pointer.
  const first = page.locator('main [data-widget-type="slicer"]').first();
  const scroller = await page.evaluate(() => {
    let n: HTMLElement | null = document.querySelector('main .react-grid-layout') as HTMLElement | null;
    while (n && !(/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight)) n = n.parentElement;
    if (n) n.scrollTop = 0;
    return n ? 'found' : 'none';
  });
  need(r, scroller === 'found' ? true : undefined, 'a scrollable report container');
  const box = need(r, await first.boundingBox(), 'a control to drag');
  await page.mouse.move(box.x + 14, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 14, 880, { steps: 12 });
  await page.waitForTimeout(1600);
  const scrolled = await page.evaluate(() => {
    let n: HTMLElement | null = document.querySelector('main .react-grid-layout') as HTMLElement | null;
    while (n && !(/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight)) n = n.parentElement;
    return n?.scrollTop ?? 0;
  });
  await page.mouse.up();
  r.metrics.autoscroll_px = scrolled;
  check(r, 'holding a drag at the bottom edge scrolls the report', scrolled > 150, `${scrolled}px`);
  await undo(page);
  await page.waitForTimeout(800);

  await page.setViewportSize({ width: 1440, height: 2600 });
  await publishUi(page);
  await shot(page, r, 'A-manual-builder-1440');
  const token = await linkFor(request, id);
  const pub = await publicAt(context, token, 1440, 2600);
  const pubFrame = await pub.locator(`[data-grid-item-id="${catId}"] [data-tile-frame]`).first().getAttribute('data-tile-frame').catch(() => null);
  check(r, 'the published report draws the chart as the author framed it', pubFrame === 'subtle', String(pubFrame));
  await shot(pub, r, 'A-manual-public-1440');
  for (const [w, h, name] of [[820, 1180, 'A-manual-public-820'], [390, 844, 'A-manual-public-390']] as const) {
    await pub.setViewportSize({ width: w, height: h });
    await settle(pub);
    const overflowX = await pub.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(r, `/d at ${w}px has no sideways scroll`, !overflowX);
    const hard = ((await audit(pub))?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `/d at ${w}px has no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    await shot(pub, r, name);
  }

  // D · the PDF of the same report.
  await pub.setViewportSize({ width: 1440, height: 900 });
  await settle(pub);
  const download = pub.waitForEvent('download', { timeout: 240_000 });
  await pub.getByRole('button', { name: /^Export PDF$/ }).first().click();
  await pub.getByRole('button', { name: /^Export PDF$/ }).last().click();
  const file = await download;
  const bytes = fs.readFileSync((await file.path())!);
  check(r, 'the export is a PDF', bytes.subarray(0, 4).toString() === '%PDF');
  const outcome = await pub.evaluate(() => (window as any).__APPBI_LAST_EXPORT__ ?? null);
  check(r, 'the export has nothing missing', !!outcome && (outcome.warnings ?? []).filter((w: any) => w.kind === 'incomplete').length === 0, JSON.stringify(outcome?.warnings ?? []));
  fs.writeFileSync(path.join(EVIDENCE, 'D-report.pdf'), bytes);
  r.evidence.push('D-report.pdf');
  await pub.close();
});

// ── B · AI Design → manual refinement ───────────────────────────────────────
test('B AI design: the real model redesigns, the author refines by hand, publish keeps both', async ({ page, request, context }) => {
  const r = scenario('B AI design then manual');
  const id = await openBaseline(page, request, r);
  const beforeKpis = await page.evaluate(() => Array.from(document.querySelectorAll('main .dashboard-kpi-value')).map((e) => (e.textContent ?? '').trim()));
  if (!(await page.getByTestId('ai-design-input').isVisible().catch(() => false))) await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').waitFor();
  await page.getByTestId('ai-design-direction-executive').click();
  const ready = await page.getByTestId('ai-design-apply').waitFor({ timeout: 120_000 }).then(() => true).catch(() => false);
  need(r, ready || undefined, 'an Executive preview from the planner');
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('design-mode-manual').click().catch(() => {});
  await settle(page);
  const afterKpis = await page.evaluate(() => Array.from(document.querySelectorAll('main .dashboard-kpi-value')).map((e) => (e.textContent ?? '').trim()));
  check(r, 'the redesign changed no number', JSON.stringify([...afterKpis].sort()) === JSON.stringify([...beforeKpis].sort()), `${beforeKpis} → ${afterKpis}`);
  check(r, 'the redesign opens with a headline block', await page.locator('main [data-narrative-variant="headline"]').count() >= 1);

  // A table is sized to its rows, not a fixed tall tile.
  const fit = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('main [data-grid-item-id]')).find((e) => e.querySelector('table tbody tr'));
    if (!t) return null;
    const rows = t.querySelectorAll('table tbody tr').length;
    const table = t.querySelector('table')!.getBoundingClientRect();
    const tile = t.getBoundingClientRect();
    return { rows, empty: Math.round(tile.bottom - table.bottom), tile: Math.round(tile.height) };
  });
  if (fit) {
    r.metrics.table_fit = fit;
    check(r, 'the table tile ends near its last row', fit.rows > 12 || fit.empty < 160, JSON.stringify(fit));
  } else r.notes.push('no table on the redesigned page — table fit NOT VERIFIED here');

  // Manual refinement after Apply: the author reframes the lead chart.
  const lead = tileByTitle(page, 'Revenue by month');
  const leadId = need(r, await lead.getAttribute('data-grid-item-id'), 'the lead chart');
  await select(page, lead);
  await page.getByTestId('arrange-frame-flush').click();
  await page.waitForTimeout(600);
  check(r, 'the AI-designed chart is still editable by hand', (await frameOf(page, leadId)) === 'flush', String(await frameOf(page, leadId)));
  await publishUi(page);
  const token = await linkFor(request, id);
  const pub = await publicAt(context, token, 1440, 2600);
  check(r, 'the public report has the headline', await pub.locator('[data-narrative-variant="headline"]').count() >= 1);
  check(r, 'the public report has the author\'s refinement', (await pub.locator(`[data-grid-item-id="${leadId}"] [data-tile-frame]`).first().getAttribute('data-tile-frame')) === 'flush');
  const pending = await pub.locator('.dashboard-narrative__item.is-pending').count();
  check(r, 'every published sentence is computed', pending === 0, `${pending} pending`);
  await shot(pub, r, 'B-ai-public-1440');
  await pub.close();
});

// ── C · Public trust and lifecycle ──────────────────────────────────────────
test('C public and lifecycle: the page scope is the server\'s, a hidden filter is never served, report-only chart edit, a stale shared edit is refused', async ({ page, request, context }) => {
  const r = scenario('C public and lifecycle');
  const id = await openBaseline(page, request, r);
  const d = await get(request, id);
  const pages = Array.isArray(d.pages_config) && d.pages_config.length ? d.pages_config : [{ id: 'page-1', name: 'Overview' }];
  const pageId = String(pages[0].id);
  const kpi = need(r, (d.dashboard_charts ?? []).find((c: any) => String(c.chart?.chart_type).toUpperCase() === 'KPI'), 'a KPI chart');

  // Fixture: the page is scoped to SP (a visible page filter) and carries a
  // hidden page filter too; published. Then a link.
  // A hidden page filter on a field the charts can filter (a wider list that
  // still includes SP, so the page reads as SP): applied, never served.
  const hidden = { ...STATE_SP, id: 'pf-hidden', value: ['SP', 'RJ', 'MG'], publicMode: 'hidden', label: 'Hidden scope marker' };
  const scoped = pages.map((p: any, i: number) => (i === 0 ? { ...p, filters: [{ ...STATE_SP, id: 'pf-sp' }, hidden] } : p));
  const stage = await request.put(`${DASH}/${id}/draft-filters`, { data: { pages_config: scoped } });
  check(r, 'the page filters are staged', stage.status() < 400, await stage.text().then((t) => t.slice(0, 160)));
  const pubRes = await request.post(`${DASH}/${id}/publish`, { data: { force: true } });
  check(r, 'the page filters are published', pubRes.status() < 400, String(pubRes.status()));
  const token = await linkFor(request, id);

  const batch = async (filters: any[], withPage = true) => {
    const res = await context.request.post(`/api/v1/public/dashboards/${token}/charts/data`, {
      data: { items: [{ chart_id: kpi.chart_id, filters }], ...(withPage ? { page_id: pageId } : {}) },
    });
    const body = await res.json();
    return JSON.stringify(body.results?.[0]?.data?.data ?? body.results?.[0]?.error ?? null);
  };
  const honest = await batch([{ ...STATE_SP }]);
  const crafted = await batch([]);
  const escape = await batch([{ ...STATE_SP, value: ['RJ'] }]);
  const noPage = await batch([], false);
  r.metrics.values = { honest, crafted, escape, noPage };
  check(r, 'the page-scoped chart returns data', !/could not be/i.test(honest) && honest !== 'null' && honest !== '[]', honest);
  check(r, 'a request that leaves the page filter out still gets the page scope', crafted === honest, `${crafted} vs ${honest}`);
  check(r, 'a pick outside the page scope falls back to the scope, never escapes it', escape === honest, `${escape} vs ${honest}`);
  check(r, 'without a page named, the chart\'s page scope still applies', noPage === honest, `${noPage} vs ${honest}`);

  const structure = await (await context.request.get(`/api/v1/public/dashboards/${token}`)).text();
  check(r, 'the hidden page filter is not in the public structure', !/Hidden scope marker|pf-hidden/.test(structure));
  const refused = await request.post(`${DASH}/${id}/public-links`, { data: { name: 'bad', filters_config: [{ field: 'amount', operator: 'between', value: 5 }] } });
  check(r, 'a link whose lock the engine cannot apply is refused at save', refused.status() === 422, String(refused.status()));

  // Edit chart → "only this report": a copy in this tile, as a draft; the link
  // keeps the original until Publish; Discard undoes it.
  const target = need(r, (d.dashboard_charts ?? []).find((c: any) => /Revenue by category/.test(String(c.layout?.custom_title || c.chart?.name || ''))), 'the "Revenue by category" tile');
  await page.goto(`/explore/${target.chart_id}?fromReport=${id}&tile=${target.id}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: /^(Update|Cập nhật)$/ }).first().click();
  const dialog = page.getByTestId('save-scope-dialog');
  check(r, 'saving from a report asks what is being changed', await dialog.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  await page.getByTestId('save-scope-report').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain(`/explore/${target.chart_id}?`);
  const afterSave = await get(request, id);
  const copyTile = (afterSave.dashboard_charts ?? []).find((c: any) => c.chart_id !== target.chart_id && c.layout?.draftOnly && c.layout?.x === target.layout?.x && c.layout?.y === target.layout?.y);
  check(r, 'the copy takes the tile\'s place as a draft', !!copyTile, JSON.stringify((afterSave.dashboard_charts ?? []).map((c: any) => [c.id, c.chart_id, !!c.layout?.draftOnly])));
  const pubIds = JSON.parse(await (await context.request.get(`/api/v1/public/dashboards/${token}`)).text()).dashboard_charts.map((c: any) => c.chart_id);
  check(r, 'the public link still shows the original chart', pubIds.includes(target.chart_id), JSON.stringify(pubIds));
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await shot(page, r, 'C-report-only-edit-builder-1440');
  await page.getByTestId('dashboard-discard').click();
  await page.getByRole('button', { name: /^Discard changes$/ }).click();
  await page.waitForTimeout(2500);
  const afterDiscard = await get(request, id);
  check(r, 'Discard puts the original chart back', (afterDiscard.dashboard_charts ?? []).some((c: any) => c.chart_id === target.chart_id)
    && !(afterDiscard.dashboard_charts ?? []).some((c: any) => c.layout?.draftOnly), JSON.stringify((afterDiscard.dashboard_charts ?? []).map((c: any) => [c.chart_id, !!c.layout?.draftOnly])));

  // A stale copy of the shared draft cannot overwrite a colleague's edit. Tab B
  // opens the builder; then the shared draft changes (another author's save —
  // here through the API as the same user, a different editor state); then tab
  // B applies a filter from the UI, on its old copy.
  const tabB = await context.newPage();
  await tabB.setViewportSize({ width: 1440, height: 1600 });
  await tabB.goto(`/dashboards/${id}`);
  await settle(tabB);
  const staged = await request.put(`${DASH}/${id}/draft-filters`, { data: { theme_config: { accent: '#0f766e' }, base_rev: (await get(request, id)).shared_draft?.rev } });
  check(r, 'the other author\'s shared edit is saved', staged.status() < 400, String(staged.status()));
  const stateCtl = control(tabB, /Customer state/);
  need(r, (await stateCtl.count()) ? true : undefined, 'the Customer-state control');
  await stateCtl.scrollIntoViewIfNeeded();
  await stateCtl.locator('.dashboard-slicer button[aria-expanded][aria-label]').first().click();
  const menu = tabB.locator('[data-slicer-menu]');
  await menu.waitFor({ timeout: 15_000 });
  await menu.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: /^\s*RJ\s*$/ }).first().click();
  await tabB.keyboard.press('Escape');
  await tabB.mouse.click(8, 300);
  await tabB.getByTestId('filter-apply-bar-apply').click();
  const stale = tabB.getByTestId('shared-draft-stale');
  check(r, 'the stale edit is refused and the author is told, with Reload offered',
    await stale.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  await shot(tabB, r, 'C-stale-shared-edit-1440');
  const final = await get(request, id);
  check(r, 'the colleague\'s shared edit survived', final.theme_config?.accent === '#0f766e' || JSON.stringify(final).includes('#0f766e'), String(final.theme_config?.accent));
  await tabB.close();
});
