import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Report Studio V3 — final production-readiness acceptance.
 *
 * The mandatory journeys the completion smoke (A manual, B AI, C public) does not
 * already cover, on a production build, asserting OUTCOMES:
 *
 *   R3  public filter + API tampering (crafted page, field, operator; a link lock
 *       ANDs with the page scope; embed claims isolate two scopes)
 *   R4  hidden/locked disclosure across every public response
 *   R5  TWO real author accounts editing at once (different tile, same tile,
 *       shared draft stale / missing revision / Publish-Discard choice, concurrent
 *       writes)
 *   R6  report-only chart edit: failure leaves nothing, success is a labelled
 *       draft copy, Discard deletes it
 *   R7  long report: drag to the bottom edge, auto-scroll, DROP, save, RELOAD —
 *       the position persists; a locked tile does not move; no overlap
 *   R8  responsive 1440/820/390: bar labels never over another bar, every pie
 *       slice named in the legend, tables fit both ways, no sideways scroll
 *   R9  builder / public / embed parity
 *   R10 PDF of a long report (pages rendered for review by acceptance/tools/pdf_review.py)
 *   R11 AI on an INDEPENDENT dataset: directions differ, numbers unchanged, the
 *       result is edited by hand and published
 *
 * The second author is created per run with a random password (never stored)
 * and deleted afterwards. Evidence: docs/features/report-studio-v3/readiness/evidence.
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const V1 = `${API}/api/v1`;
const DASH = `${V1}/dashboards`;
const EVIDENCE = path.resolve(__dirname, '..', '..', 'docs', 'features', 'report-studio-v3', 'readiness', 'evidence');
const OLIST = process.env.ACCEPT_OLIST_DASHBOARD || 'Olist commercial review';
const INDEPENDENT = process.env.ACCEPT_INDEPENDENT_DASHBOARD || 'E2E Presentation fixture';
const STATE = { field: 'customer_state', semanticField: 'dataset_table_3.customer_state', fieldKey: 'dataset_table_3.customer_state',
  datasetId: 1, type: 'dropdown', operator: 'in', label: 'Customer state' };

type Status = 'PASS' | 'FAIL' | 'NOT VERIFIED';
interface Result { status: Status; assertions: string[]; metrics: Record<string, unknown>; evidence: string[]; notes: string[] }
const results: Record<string, Result> = {};
const made: number[] = [];
const madeUsers: string[] = [];
let active: string[] = [];

function scenario(name: string): Result {
  results[name] = results[name] ?? { status: 'NOT VERIFIED', assertions: [], metrics: {}, evidence: [], notes: [] };
  if (!active.includes(name)) active.push(name);
  return results[name];
}
function need<T>(r: Result, value: T | undefined | null | false, what: string): T {
  if (value === undefined || value === null || value === false) {
    r.status = 'NOT VERIFIED';
    r.notes.push(`${what} is missing on this environment`);
    throw new Error(`${what} is missing — NOT VERIFIED`);
  }
  return value as T;
}
function check(r: Result, label: string, ok: boolean, detail = '') {
  r.assertions.push(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) r.status = 'FAIL';
  else if (r.status === 'NOT VERIFIED' && !r.notes.some((n) => /missing on this environment/.test(n))) r.status = 'PASS';
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
test.afterEach(({}, info) => {
  if (info.status !== 'passed' && info.status !== 'skipped') {
    for (const name of active) {
      const r = results[name];
      if (r && !r.notes.some((n) => /missing on this environment/.test(n))) {
        r.status = 'FAIL';
        r.assertions.push(`FAIL — the scenario stopped: ${String(info.error?.message ?? info.status).split(/\r?\n/)[0].slice(0, 240)}`);
      }
    }
  }
  active = [];
  persist();
});
test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`${DASH}/${id}`).catch(() => {});
  for (const uid of madeUsers) await request.delete(`${V1}/users/${uid}/permanent`).catch(() => {});
  persist();
});

// ── fixtures ────────────────────────────────────────────────────────────────
async function idOf(request: APIRequestContext, name: string) {
  const list = await (await request.get(`${DASH}/?limit=300`)).json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  return list.find((d: any) => d.name === name)?.id as number | undefined;
}
async function copyOf(request: APIRequestContext, r: Result, name = OLIST) {
  const src = need(r, await idOf(request, name), `baseline "${name}"`);
  const dup = await request.post(`${DASH}/${src}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  made.push(d.id);
  return d.id as number;
}
const get = (req: APIRequestContext, id: number) => req.get(`${DASH}/${id}`).then((x) => x.json());
async function linkFor(request: APIRequestContext, id: number, filters?: any[]) {
  const res = await request.post(`${DASH}/${id}/public-links`, { data: { name: `readiness-${Date.now()}`, ...(filters ? { filters_config: filters } : {}) } });
  expect(res.status(), await res.text()).toBeLessThan(400);
  return (await res.json()).token as string;
}
async function stageShared(request: APIRequestContext, id: number, body: Record<string, unknown>) {
  const rev = (await get(request, id)).shared_draft?.rev;
  return request.put(`${DASH}/${id}/draft-filters`, { data: { ...body, base_rev: rev } });
}
async function publishApi(request: APIRequestContext, id: number) {
  const res = await request.post(`${DASH}/${id}/publish`, { data: { force: true } });
  expect(res.status(), await res.text()).toBeLessThan(400);
}
/** A second REAL author: a new account (random password, never stored), the
 *  editor preset, edit access to the report, and its own browser context. */
async function secondAuthor(browser: Browser, request: APIRequestContext, dashboardId: number, r: Result) {
  const email = `coauthor-${Date.now()}@appbi.io`;
  const password = `${crypto.randomBytes(18).toString('base64url')}!aA1`;
  const created = await request.post(`${V1}/users/`, { data: { email, full_name: 'Co-author Readiness', password, auth_provider: 'password' } });
  need(r, created.status() < 400 || undefined, `creating a second account (${created.status()} ${await created.text().then((t) => t.slice(0, 120))})`);
  const user = await created.json();
  madeUsers.push(user.id);
  const preset = await request.put(`${V1}/permissions/${user.id}/preset`, { data: { preset: 'editor' } });
  check(r, 'the second author gets the editor preset', preset.status() < 400, String(preset.status()));
  const share = await request.post(`${V1}/shares/dashboard/${dashboardId}`, { data: { email, permission: 'edit' } });
  check(r, 'the report is shared with the second author for editing', share.status() < 400, await share.text().then((t) => t.slice(0, 160)));
  const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1440, height: 1400 }, extraHTTPHeaders: { 'x-e2e': '1' } });
  const login = await ctx.request.post(`${V1}/auth/login`, { data: { email, password } });
  need(r, login.status() < 400 || undefined, `logging in as the second author (${login.status()})`);
  const me = await (await ctx.request.get(`${V1}/auth/me`)).json();
  check(r, 'the second author is a different account', me.email === email && String(me.id) === String(user.id), `${me.email}`);
  return { ctx, email, id: String(user.id), name: 'Co-author Readiness' };
}

// ── page helpers ────────────────────────────────────────────────────────────
async function settle(page: Page) {
  await page.waitForSelector('[data-grid-item-id], [data-tile-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) { for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((res) => setTimeout(res, 80)); } el.scrollTo(0, 0); }
  });
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function shot(page: Page, r: Result, name: string) {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    const inner = Array.from(document.querySelectorAll('main, div')).filter((e) => !e.closest('[data-grid-item-id]')).reduce((acc, e) => Math.max(acc, (e as HTMLElement).scrollHeight > (e as HTMLElement).clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) ? (e as HTMLElement).scrollHeight + e.getBoundingClientRect().top : 0), 0);
    return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0, inner);
  });
  await page.setViewportSize({ width: vp.width, height: Math.ceil(Math.min(Math.max(h, vp.height), 9000)) });
  await page.waitForTimeout(1400);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: true, type: 'jpeg', quality: 62 });
  await page.setViewportSize(vp);
  r.evidence.push(file);
}
const audit = (page: Page) => page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<null | { findings: Array<{ code: string; tileId: number }> }>;
const HARD = ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'];
const rects = (page: Page) => page.evaluate(() => {
  const g = document.querySelector('main .react-grid-layout')?.getBoundingClientRect();
  return Object.fromEntries(Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    return [e.getAttribute('data-grid-item-id'), [Math.round(b.left - (g?.left ?? 0)), Math.round(b.top - (g?.top ?? 0)), Math.round(b.width), Math.round(b.height)]];
  })) as Record<string, [number, number, number, number]>;
});
const tileByTitle = (page: Page, title: string | RegExp) => page.locator('main [data-grid-item-id]').filter({ hasText: title }).first();
const control = (page: Page, label: RegExp) => page.locator('main [data-widget-type="slicer"]').filter({ hasText: label }).first();
async function select(page: Page, tile: Locator) {
  await tile.scrollIntoViewIfNeeded();
  await tile.locator('[data-tile-kind]').first().click({ position: { x: 120, y: 60 } });
  await page.waitForTimeout(400);
  if (!(await page.getByTestId('arrange-frame-subtle').isVisible().catch(() => false))) {
    await tile.locator('[data-tile-kind]').first().click({ position: { x: 120, y: 60 } });
    await page.waitForTimeout(400);
  }
}
async function frame(page: Page, tile: Locator, f: 'card' | 'subtle' | 'flush') {
  await select(page, tile);
  await page.getByTestId(`arrange-frame-${f}`).click();
  await page.waitForTimeout(500);
}
async function saveDraft(page: Page) {
  await page.getByTestId('dashboard-save-draft').click();
  await page.waitForTimeout(2000);
}
async function publishUi(page: Page) {
  await page.getByTestId('dashboard-publish').click();
  await page.waitForTimeout(3500);
}
async function pick(page: Page, ctl: Locator, value: string) {
  await ctl.scrollIntoViewIfNeeded();
  await ctl.locator('.dashboard-slicer button[aria-expanded][aria-label]').first().click();
  const menu = page.locator('[data-slicer-menu]');
  await menu.waitFor({ timeout: 15_000 });
  await menu.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) }).first().click();
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 300);
  await page.getByTestId('filter-apply-bar-apply').click();
  await page.waitForTimeout(1500);
}
async function publicStructure(ctx: APIRequestContext, token: string) {
  return (await ctx.get(`${V1}/public/dashboards/${token}`)).json();
}
const frameIn = (d: any, dcId: number) => (d.dashboard_charts ?? []).find((c: any) => c.id === dcId)?.layout?.styleConfigOverride?.tileFrame ?? 'card';
const kpiNow = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('main .dashboard-kpi-value, [data-grid-item-id] .dashboard-kpi-value'))
  .map((e) => (e.textContent ?? '').trim()).filter(Boolean).sort());
/** The KPI figures once every KPI tile has drawn its value: read until two
 *  readings a second apart agree and every KPI tile has one (a tile still
 *  loading is not a changed number). */
async function kpiTexts(page: Page): Promise<string[]> {
  let last: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const tiles = await page.locator('[data-grid-item-id]').filter({ has: page.locator('.dashboard-kpi-value, [data-tile-kind="kpi"]') }).count();
    const now = await kpiNow(page);
    if (now.length > 0 && now.length >= tiles && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    await page.waitForTimeout(1000);
  }
  return last;
}
async function publicAt(ctx: BrowserContext, url: string, width: number, height: number) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.goto(url);
  await settle(p);
  return p;
}

// ── R3 · public filter + API tampering ──────────────────────────────────────
test('R3 public tampering: the server decides the scope, a link lock ANDs with the page, embed claims isolate', async ({ request, context }) => {
  const r = scenario('R3 public tampering');
  const id = await copyOf(request, r);
  const d = await get(request, id);
  const pages = Array.isArray(d.pages_config) && d.pages_config.length ? d.pages_config : [{ id: 'page-1', name: 'Overview' }];
  const pageId = String(pages[0].id);
  const kpi = need(r, (d.dashboard_charts ?? []).find((c: any) => String(c.chart?.chart_type).toUpperCase() === 'KPI'), 'a KPI chart');
  const scoped = pages.map((p: any, i: number) => (i === 0 ? { ...p, filters: [{ ...STATE, id: 'pf-sp', value: ['SP', 'RJ'] }] } : p));
  check(r, 'the page scope SP+RJ is staged', (await stageShared(request, id, { pages_config: scoped })).status() < 400);
  await publishApi(request, id);

  const value = async (token: string, filters: any[] = [], extra: Record<string, unknown> = { page_id: pageId }) => {
    const res = await context.request.post(`${V1}/public/dashboards/${token}/charts/data`, { data: { items: [{ chart_id: kpi.chart_id, filters }], ...extra } });
    const body = await res.json().catch(() => ({}));
    const rows = body.results?.[0]?.data?.data;
    const nums = Array.isArray(rows) ? rows.flatMap((row: any) => Object.values(row ?? {})).filter((x) => typeof x === 'number') as number[] : [];
    return { status: res.status(), v: JSON.stringify(rows ?? body.results?.[0]?.error ?? body.detail ?? null), nums };
  };
  const open = await linkFor(request, id);
  const onlySp = await linkFor(request, id, [{ ...STATE, value: ['SP'] }]);
  const outside = await linkFor(request, id, [{ ...STATE, value: ['MG'] }]);
  const onlyRj = await linkFor(request, id, [{ ...STATE, value: ['RJ'] }]);
  const page = (await value(open)).v;
  const sp = (await value(onlySp)).v;
  const mgRes = await value(outside);
  const mg = mgRes.v;
  r.metrics.values = { page, sp, mg };
  check(r, 'a link locked inside the page scope narrows it', sp !== page && sp !== 'null', `${sp} vs page ${page}`);
  check(r, 'a link locked OUTSIDE the page scope returns no rows — it no longer replaces the page filter',
    mgRes.nums.every((n) => n === 0), mg);
  check(r, 'a crafted viewer filter cannot widen a lock', (await value(onlySp, [{ ...STATE, value: ['RJ', 'MG'] }])).v === sp);
  const foreign = await context.request.post(`${V1}/public/dashboards/${open}/charts/data`, { data: { items: [{ chart_id: kpi.chart_id }], page_id: 'no-such-page' } });
  const foreignBody = await foreign.text();
  check(r, 'a chart asked for on a page it is not on is refused', foreign.status() === 404 || /not on|404/i.test(foreignBody), `${foreign.status()} ${foreignBody.slice(0, 120)}`);
  const odd = await value(open, [{ ...STATE, operator: 'not_in', value: ['SP'] }]);
  const rj = (await value(onlyRj)).v;
  check(r, 'an operator trick (not_in SP) stays inside the page scope: it reads RJ, not everything but SP', odd.v === rj, `${odd.v} vs RJ ${rj}`);
  const unknown = await value(open, [{ field: 'order_status', semanticField: 'dataset_table_1.order_status', datasetId: 1, operator: 'in', value: ['canceled'] }]);
  check(r, 'a filter on a field the viewer has no control for is ignored, not applied or errored', unknown.v === page, `${unknown.v} vs ${page}`);
  const distinct = await context.request.get(`${V1}/public/dashboards/${open}/filters/distinct-values?dataset_id=1&field=${encodeURIComponent('dataset_table_3.customer_state')}&page_id=${pageId}&limit=100`);
  const dv = await distinct.json();
  r.metrics.distinct = dv.values;
  check(r, 'the page dropdown offers only the page scope', distinct.status() === 200 && dv.values.every((v: string) => ['SP', 'RJ'].includes(String(v))) && dv.values.length === 2, JSON.stringify(dv.values));
  const searched = await (await context.request.get(`${V1}/public/dashboards/${open}/filters/distinct-values?dataset_id=1&field=${encodeURIComponent('dataset_table_3.customer_state')}&page_id=${pageId}&search=G`)).json();
  check(r, 'search cannot reach values outside the scope', (searched.values ?? []).every((v: string) => ['SP', 'RJ'].includes(String(v))), JSON.stringify(searched.values));
  const hiddenField = await context.request.get(`${V1}/public/dashboards/${open}/filters/distinct-values?dataset_id=1&field=${encodeURIComponent('dataset_table_1.order_status')}`);
  check(r, 'a field that is not a viewer control has no distinct endpoint', hiddenField.status() === 404, String(hiddenField.status()));

  // Embed: two claims = two isolated scopes, and a crafted request stays in its own.
  const resolve = async (value: string) => {
    const res = await request.post(`${V1}/integrations/embed/resolve`, { data: { dashboard_id: id, filters: [{ field: 'dataset_table_3.customer_state', operator: 'in', value: [value] }] } });
    return res.status() < 400 ? String((await res.json()).embed_path).replace(/^\/embed\//, '') : null;
  };
  const eSp = need(r, await resolve('SP'), 'an embed grant (integrations/embed/resolve)');
  const eRj = need(r, await resolve('RJ'), 'a second embed grant');
  const vSp = (await value(eSp)).v; const vRj = (await value(eRj)).v;
  check(r, 'two embed claims see two different scopes', vSp !== vRj, `${vSp} / ${vRj}`);
  check(r, 'the SP embed equals the SP public link', vSp === sp, `${vSp} vs ${sp}`);
  const crafted = await value(eSp, [{ ...STATE, value: ['RJ'] }]);
  check(r, 'a crafted request under the SP claim cannot read RJ (it gets SP, or nothing)',
    crafted.v !== vRj && (crafted.v === vSp || crafted.nums.every((n) => n === 0)), `${crafted.v} (SP ${vSp}, RJ ${vRj})`);
  const bad = await request.post(`${V1}/integrations/embed/resolve`, { data: { dashboard_id: id, filters: [{ field: 'dataset_table_3.customer_state', operator: 'between', value: 5 }] } });
  check(r, 'a malformed embed claim is refused', bad.status() === 400, String(bad.status()));
  const missing = await request.post(`${V1}/integrations/embed/resolve`, { data: { dashboard_id: id, filters: [] } });
  check(r, 'an embed with no claim is refused unless the full report is asked for', missing.status() === 400, String(missing.status()));
  const foreignField = await request.post(`${V1}/integrations/embed/resolve`, { data: { dashboard_id: id, filters: [{ field: 'dataset_table_9.secret', operator: 'in', value: ['x'] }] } });
  check(r, 'a claim on a field that is not in the report is refused', foreignField.status() === 400, String(foreignField.status()));
});

// ── R4 · hidden / locked disclosure ─────────────────────────────────────────
test('R4 disclosure: a hidden constraint and a hidden field never reach any public response', async ({ request, context }) => {
  const r = scenario('R4 disclosure');
  const id = await copyOf(request, r);
  const d = await get(request, id);
  const pages = Array.isArray(d.pages_config) && d.pages_config.length ? d.pages_config : [{ id: 'page-1', name: 'Overview' }];
  const MARK = 'ZzHiddenScope';
  const hiddenDash = { ...STATE, id: 'df-hidden', value: ['SP', 'RJ', 'MG', 'PR'], publicMode: 'hidden', label: `${MARK} report` };
  const lockedDash = { ...STATE, id: 'df-locked', value: ['SP', 'RJ', 'MG', 'PR', 'SC'], publicMode: 'locked', label: 'Locked states' };
  const scoped = pages.map((p: any, i: number) => (i === 0 ? { ...p, filters: [{ ...STATE, id: 'pf-hidden', value: ['SP', 'RJ', 'MG', 'PR', 'SC', 'BA'], publicMode: 'hidden', label: `${MARK} page` }] } : p));
  check(r, 'hidden + locked filters are staged', (await stageShared(request, id, { filters_config: [hiddenDash, lockedDash], pages_config: scoped })).status() < 400);
  await publishApi(request, id);
  const token = await linkFor(request, id, [{ field: 'order_status', semanticField: 'dataset_table_1.order_status', datasetId: 1, operator: 'in', value: ['delivered'], hidden: true, label: `${MARK} link` }]);

  const bodies: Record<string, string> = {};
  bodies.structure = await (await context.request.get(`${V1}/public/dashboards/${token}`)).text();
  const s = JSON.parse(bodies.structure);
  const kpi = (s.dashboard_charts ?? []).find((c: any) => String(c.chart?.chart_type).toUpperCase() === 'KPI');
  bodies.data = await (await context.request.post(`${V1}/public/dashboards/${token}/charts/data`, { data: { items: [{ chart_id: kpi?.chart_id }], page_id: String(pages[0].id) } })).text();
  bodies.single = await (await context.request.get(`${V1}/public/dashboards/${token}/charts/${kpi?.chart_id}/data?page_id=${pages[0].id}`)).text();
  bodies.distinct = await (await context.request.get(`${V1}/public/dashboards/${token}/filters/distinct-values?dataset_id=1&field=${encodeURIComponent('dataset_table_3.customer_state')}&page_id=${pages[0].id}`)).text();
  bodies.error = await (await context.request.post(`${V1}/public/dashboards/${token}/charts/data`, { data: { items: [{ chart_id: kpi?.chart_id, filters: [{ field: 'nope', operator: 'weird', value: [1] }] }] } })).text();
  bodies.recon = await (await context.request.get(`${V1}/public/dashboards/${token}/ai/recon`)).text().catch(() => '');
  const all = Object.values(bodies).join('\n');
  check(r, 'no public response names the hidden filters', !all.includes(MARK), Object.entries(bodies).filter(([, b]) => b.includes(MARK)).map(([k]) => k).join(','));
  check(r, 'the hidden link value never leaves the server', !/"delivered"/.test(all), Object.entries(bodies).filter(([, b]) => /"delivered"/.test(b)).map(([k]) => k).join(','));
  check(r, 'the locked filter is announced (read-only)', /Locked states/.test(bodies.structure));
  check(r, 'no emitted SQL in any public response', !/sql_emitted|SELECT\s+.+\s+FROM/i.test(all));
  // The model names only fields the report uses; the hidden-only field (order_status) is not listed.
  const models = JSON.stringify(s.public_dataset_models ?? {});
  check(r, 'the public model does not list a field only a hidden constraint uses', !/order_status/.test(models), models.slice(0, 200));
  // The rendered page, and its state, carry none of it either.
  const pub = await publicAt(context, `/d/${token}`, 1440, 1600);
  const dom = await pub.evaluate(() => document.documentElement.outerHTML);
  check(r, 'the rendered /d page carries no hidden label', !dom.includes(MARK));
  await shot(pub, r, 'R4-public-1440');
  await pub.close();
  r.metrics.bodies = Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, v.length]));
});

// ── R5 · two real authors at once ───────────────────────────────────────────
test('R5 co-authoring: two accounts, different and same tile, shared draft revisions, Publish/Discard choices, concurrent writes', async ({ page, request, browser }) => {
  test.setTimeout(600_000);
  const r = scenario('R5 two authors');
  const id = await copyOf(request, r);
  const b = await secondAuthor(browser, request, id, r);
  const pageB = await b.ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 1400 });
  await Promise.all([page.goto(`/dashboards/${id}`), pageB.goto(`/dashboards/${id}`)]);
  await Promise.all([settle(page), settle(pageB)]);
  // The builder's co-edit rule: the owner holds a page they are on; another
  // author asks ("Request edit") and the owner allows it. Done through the UI.
  const coEdit = async () => {
    const ask = pageB.getByRole('button', { name: /^(Request edit|Yêu cầu quyền sửa)$/ });
    if (!(await ask.waitFor({ timeout: 12_000 }).then(() => true).catch(() => false))) return;
    await ask.click();
    const allow = page.getByRole('button', { name: /^(Allow|Cho phép)$/ }).first();
    await allow.waitFor({ timeout: 30_000 });
    await allow.click();
    await expect.poll(() => pageB.getByRole('button', { name: /^(Request edit|Yêu cầu quyền sửa)$/ }).isVisible().catch(() => false),
      { timeout: 30_000 }).toBe(false);
    await pageB.waitForTimeout(1500);
  };
  await coEdit();
  check(r, 'after asking, the second author is not held to view-only',
    !(await pageB.getByRole('button', { name: /^(Request edit|Yêu cầu quyền sửa)$/ }).isVisible().catch(() => false)));
  const bNet: string[] = [];
  pageB.on('response', (res) => {
    if (/\/(publish|draft-layout|draft-filters|discard)\b/.test(res.url())) bNet.push(`${res.request().method()} ${res.url().replace(/^.*\/dashboards\//, '')} ${res.status()}`);
  });
  const token = await linkFor(request, id);
  const idOfTile = async (p: Page, t: string) => Number(await tileByTitle(p, t).getAttribute('data-grid-item-id'));
  const cat = await idOfTile(page, 'Revenue by category');
  const st = await idOfTile(page, 'Revenue by state');
  const month = await idOfTile(page, 'Revenue by month');

  // Different tiles, at the same time: both land.
  await Promise.all([frame(page, tileByTitle(page, 'Revenue by category'), 'subtle'), frame(pageB, tileByTitle(pageB, 'Revenue by state'), 'flush')]);
  await Promise.all([saveDraft(page), saveDraft(pageB)]);
  const liveBefore = await publicStructure(request, token);
  check(r, 'neither author\'s draft is public before Publish', frameIn(liveBefore, cat) === 'card' && frameIn(liveBefore, st) === 'card');
  await publishUi(page);
  await publishUi(pageB);
  const both = await publicStructure(request, token);
  check(r, 'A\'s edit and B\'s edit of different tiles are both published', frameIn(both, cat) === 'subtle' && frameIn(both, st) === 'flush', `${frameIn(both, cat)} / ${frameIn(both, st)}`);

  // Same tile: the second publish is stopped and told who published it.
  await Promise.all([page.reload(), pageB.reload()]);
  await Promise.all([settle(page), settle(pageB)]);
  await coEdit();
  await frame(page, tileByTitle(page, 'Revenue by month'), 'subtle');
  await frame(pageB, tileByTitle(pageB, 'Revenue by month'), 'flush');
  await publishUi(page);
  bNet.length = 0;
  await pageB.getByTestId('dashboard-publish').click();
  const conflict = await pageB.getByTestId('publish-conflict').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  r.metrics.sameTileNet = [...bNet];
  check(r, 'B publishing the tile A just published is stopped with a conflict dialog', conflict);
  const same = await publicStructure(request, token);
  check(r, 'the live report keeps A\'s version of the tile until B chooses', frameIn(same, month) === 'subtle', frameIn(same, month));
  await shot(pageB, r, 'R5-same-tile-conflict-B');
  await pageB.keyboard.press('Escape').catch(() => {});

  // Shared draft: A applies a filter; B's open copy is stale and cannot overwrite it.
  await Promise.all([page.reload(), pageB.reload()]);
  await Promise.all([settle(page), settle(pageB)]);
  await coEdit();
  const ctlA = control(page, /Customer state/);
  need(r, (await ctlA.count()) > 0 || undefined, 'the Customer-state control');
  await pick(page, ctlA, 'RJ');
  const aDraft = await get(request, id);
  check(r, 'A\'s filter pick is a shared draft edit', !!aDraft.shared_draft?.has_changes, JSON.stringify(aDraft.shared_draft));
  await pick(pageB, control(pageB, /Customer state/), 'SP');
  const stale = await pageB.getByTestId('shared-draft-stale').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  check(r, 'B\'s edit on the copy it opened before A\'s is refused, with Reload offered', stale);
  await shot(pageB, r, 'R5-stale-shared-B');
  const missing = await b.ctx.request.put(`${DASH}/${id}/draft-filters`, { data: { theme_config: { accent: '#ff0000' } } });
  check(r, 'a shared write that names no revision is refused', missing.status() === 409, String(missing.status()));
  const afterStale = await get(request, id);
  check(r, 'A\'s pending pick survived both attempts', JSON.stringify(afterStale.slicers_config ?? afterStale.filters_config ?? []).includes('RJ'));

  // B publishes: told A has unpublished shared edits; "only mine" leaves them pending.
  await pageB.reload();
  await settle(pageB);
  await coEdit();
  await frame(pageB, tileByTitle(pageB, 'Revenue by category'), 'card');
  await pageB.getByTestId('dashboard-publish').click();
  const choice = pageB.getByTestId('shared-draft-choice');
  check(r, 'B\'s Publish asks about A\'s unpublished shared edits', await choice.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  const choiceText = (await choice.textContent().catch(() => '')) ?? '';
  r.metrics.choice = choiceText.slice(0, 300);
  await shot(pageB, r, 'R5-publish-choice-B');
  await pageB.getByTestId('shared-draft-mine').click();
  await pageB.waitForTimeout(3000);
  const afterMine = await publicStructure(request, token);
  check(r, '"Only mine" published B\'s tile edit', frameIn(afterMine, cat) === 'card', frameIn(afterMine, cat));
  check(r, '"Only mine" did not publish A\'s filter pick', !JSON.stringify(afterMine.slicers_config ?? []).includes('"RJ"'));
  check(r, 'A\'s pick is still pending', !!(await get(request, id)).shared_draft?.has_changes);
  // B discards: the same choice, and A's pick again survives.
  await frame(pageB, tileByTitle(pageB, 'Revenue by state'), 'subtle');
  await saveDraft(pageB);
  await pageB.getByTestId('dashboard-discard').click();
  await pageB.getByRole('button', { name: /^Discard changes$/ }).click().catch(() => {});
  const dChoice = await pageB.getByTestId('shared-draft-choice').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  check(r, 'B\'s Discard asks before dropping A\'s shared edits', dChoice);
  if (dChoice) { await pageB.getByTestId('shared-draft-mine').click(); await pageB.waitForTimeout(2500); }
  check(r, 'A\'s pick survived B\'s discard', !!(await get(request, id)).shared_draft?.has_changes);

  // Concurrent writes of the per-author drafts (one JSON column): none is lost.
  const d = await get(request, id);
  const layoutOf = (dcId: number) => (d.dashboard_charts ?? []).find((c: any) => c.id === dcId)?.layout;
  // Six rounds; in each, A and B write at the same instant. Every round, BOTH
  // writes must be there afterwards (before the row lock, the later commit
  // rewrote the whole draft column from its stale read and dropped the other's).
  const titleIn = (v: any, dcId: number) => v.draft_layouts?.[dcId]?.custom_title ?? v.draft_layouts?.[String(dcId)]?.custom_title;
  const lost: string[] = [];
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const pair = await Promise.all([
      request.put(`${DASH}/${id}/draft-layout`, { data: { chart_layouts: [{ id: cat, layout: { ...layoutOf(cat), custom_title: `A ${i}` } }] } }),
      b.ctx.request.put(`${DASH}/${id}/draft-layout`, { data: { chart_layouts: [{ id: st, layout: { ...layoutOf(st), custom_title: `B ${i}` } }] } }),
    ]);
    statuses.push(...pair.map((x) => x.status()));
    const aView = await get(request, id);
    const bView = await (await b.ctx.request.get(`${DASH}/${id}`)).json();
    if (titleIn(aView, cat) !== `A ${i}`) lost.push(`round ${i}: A saw ${titleIn(aView, cat)}`);
    if (titleIn(bView, st) !== `B ${i}`) lost.push(`round ${i}: B saw ${titleIn(bView, st)}`);
  }
  check(r, 'simultaneous draft writes by two authors all succeed', statuses.every((s) => s < 400), statuses.join(','));
  check(r, 'no simultaneous write by one author ever drops the other author\'s', lost.length === 0, lost.join('; '));
  await b.ctx.close();
});

// ── R6 · report-only chart edit ─────────────────────────────────────────────
test('R6 report-only edit: a failure leaves nothing, a copy is a labelled draft, Discard deletes it', async ({ page, request }) => {
  const r = scenario('R6 report-only edit');
  const id = await copyOf(request, r);
  const d = await get(request, id);
  const target = need(r, (d.dashboard_charts ?? []).find((c: any) => /Revenue by category/.test(String(c.layout?.custom_title || c.chart?.name || ''))), 'the "Revenue by category" tile');
  const chartIds = async () => ((await (await request.get(`${V1}/charts/?limit=500`)).json()) as any[]).map((c) => c.id).sort((a, b) => a - b);
  const before = await chartIds();
  const openExplore = async () => {
    await page.goto(`/explore/${target.chart_id}?fromReport=${id}&tile=${target.id}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: /^(Update|Cập nhật)$/ }).first().click();
    await page.getByTestId('save-scope-dialog').waitFor({ timeout: 20_000 });
  };
  // Failure: the server refuses the fork — nothing is left in the library or the report.
  await page.route('**/fork-chart', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"injected failure"}' }));
  await openExplore();
  await page.getByTestId('save-scope-report').click();
  await page.waitForTimeout(3000);
  check(r, 'a failed "only this report" leaves no chart behind', JSON.stringify(await chartIds()) === JSON.stringify(before));
  const afterFail = await get(request, id);
  check(r, 'a failed "only this report" leaves the report untouched', !(afterFail.dashboard_charts ?? []).some((c: any) => c.layout?.draftOnly));
  await page.unroute('**/fork-chart');
  // Success: one copy, marked as this report's, in the tile as a draft.
  await openExplore();
  await page.getByTestId('save-scope-report').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain(`/explore/${target.chart_id}?`);
  const copies = (await chartIds()).filter((c) => !before.includes(c));
  check(r, 'exactly one chart was created', copies.length === 1, JSON.stringify(copies));
  const copy = await (await request.get(`${V1}/charts/${copies[0]}`)).json();
  check(r, 'the copy is marked as this report\'s', copy.config?.reportCopy?.dashboardId === id, JSON.stringify(copy.config?.reportCopy));
  check(r, 'the copy does not take the shared chart\'s bare name', copy.name !== target.chart?.name, copy.name);
  await page.goto('/explore');
  await page.getByText(copy.name, { exact: false }).first().waitFor({ timeout: 45_000 }).catch(() => {});
  const labelled = await page.locator('[data-testid="report-copy-badge"]').count();
  check(r, 'the library labels the copy', labelled >= 1, String(labelled));
  await shot(page, r, 'R6-library-report-copy');
  // Discard: the original is back, the copy is deleted.
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await page.getByTestId('dashboard-discard').click();
  await page.getByRole('button', { name: /^Discard changes$/ }).click();
  await page.waitForTimeout(2500);
  check(r, 'Discard deletes the report copy', (await request.get(`${V1}/charts/${copies[0]}`)).status() === 404);
  const afterDiscard = await get(request, id);
  check(r, 'Discard puts the original chart back', (afterDiscard.dashboard_charts ?? []).some((c: any) => c.chart_id === target.chart_id));
  check(r, 'the shared chart was never changed', (await (await request.get(`${V1}/charts/${target.chart_id}`)).json()).name === target.chart?.name);
});

// ── R7 · long report: drag, drop, persist ───────────────────────────────────
test('R7 long report: auto-scroll to the bottom, drop there, save, reload — it stays; a locked tile never moves', async ({ page, request }) => {
  const r = scenario('R7 long drag');
  const id = await copyOf(request, r);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  const scrollerTop = () => page.evaluate(() => {
    let n: HTMLElement | null = document.querySelector('main .react-grid-layout') as HTMLElement | null;
    while (n && !(/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight)) n = n.parentElement;
    if (!n) return null;
    return { top: n.scrollTop, height: n.scrollHeight, client: n.clientHeight };
  });
  const s0 = need(r, await scrollerTop(), 'a scrollable report');
  check(r, 'the report is longer than two screens', s0.height > s0.client * 2, `${s0.height}/${s0.client}`);
  const kpi = page.locator('main [data-grid-item-id]').filter({ has: page.locator('.dashboard-kpi-value') }).first();
  const kpiId = need(r, await kpi.getAttribute('data-grid-item-id'), 'a KPI tile at the top');
  const start = (await rects(page))[kpiId];
  const gridH = await page.evaluate(() => document.querySelector('main .react-grid-layout')!.getBoundingClientRect().height);
  const box = need(r, await kpi.boundingBox(), 'the KPI tile box');
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 880, { steps: 14 });
  // Hold at the bottom edge until the report stops scrolling (its end).
  let last = -1; let still = 0;
  for (let i = 0; i < 80 && still < 6; i += 1) {
    await page.mouse.move(box.x + box.width / 2 + (i % 2), 884);
    await page.waitForTimeout(120);
    const s = await scrollerTop();
    if (s && s.top === last) still += 1; else { still = 0; last = s?.top ?? -1; }
  }
  const held = need(r, await scrollerTop(), 'the scroller after the hold');
  r.metrics.hold = held;
  check(r, 'holding at the bottom edge scrolled the report to its end', held.top > s0.top + 300, JSON.stringify(held));
  // Drop directly under the last row (the grip is 30px below the tile's top).
  const othersBottom = await page.evaluate((id) => Math.max(...Array.from(document.querySelectorAll('main .react-grid-item'))
    .filter((e) => e.getAttribute('data-grid-item-id') !== id && !e.classList.contains('react-grid-placeholder'))
    .map((e) => e.getBoundingClientRect().bottom)), kpiId);
  await page.mouse.move(box.x + box.width / 2, othersBottom + 30 + 8, { steps: 8 });
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const after = await rects(page);
  const dropped = after[kpiId];
  const lastRowBottom = Math.max(...Object.entries(after).filter(([k]) => k !== kpiId).map(([, v]) => v[1] + v[3]));
  const gridAfter = await page.evaluate(() => document.querySelector('main .react-grid-layout')!.getBoundingClientRect().height);
  r.metrics.drop = { start, dropped, lastRowBottom, gridH, gridAfter };
  check(r, 'the tile was DROPPED directly under the last row', !!dropped && dropped[1] >= lastRowBottom - 12 && dropped[1] <= lastRowBottom + 80,
    `${start} → ${dropped}; last row ends at ${lastRowBottom}`);
  check(r, 'the report did not grow into empty space', gridAfter <= gridH + dropped[3] + 120, `${Math.round(gridH)} → ${Math.round(gridAfter)}`);
  const a1 = await audit(page);
  check(r, 'nothing overlaps after the drop', !(a1?.findings ?? []).some((f) => f.code === 'tile.overlap'));
  await saveDraft(page);
  await page.reload();
  await settle(page);
  const reloaded = (await rects(page))[kpiId];
  check(r, 'after reload the tile is where it was dropped', !!reloaded && Math.abs(reloaded[1] - dropped[1]) < 40, `${dropped} → ${reloaded}`);
  const draft = await get(request, id);
  const draftY = draft.draft_layouts?.[kpiId]?.y ?? draft.draft_layouts?.[Number(kpiId)]?.y;
  check(r, 'the draft stores the new position', typeof draftY === 'number' && draftY > 10, String(draftY));

  // A locked tile: dragging it moves nothing.
  const lockT = tileByTitle(page, 'Revenue by category');
  const lockId = need(r, await lockT.getAttribute('data-grid-item-id'), 'the category chart');
  await lockT.scrollIntoViewIfNeeded();
  await lockT.hover();
  await lockT.locator('button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)').first().click();
  await page.getByRole('switch', { name: /Lock position/i }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const lockedAt = (await rects(page))[lockId];
  const lb = need(r, await lockT.boundingBox(), 'the locked tile box');
  await page.mouse.move(lb.x + lb.width / 2, lb.y + 30);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width / 2 + 200, lb.y + 260, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  check(r, 'a locked tile does not move', JSON.stringify((await rects(page))[lockId]) === JSON.stringify(lockedAt));
  // An invalid placement (onto another tile) never overlaps.
  const other = tileByTitle(page, 'Revenue by state');
  const ob = need(r, await other.boundingBox(), 'another chart');
  const month = tileByTitle(page, 'Revenue by month');
  const mb = need(r, await month.boundingBox(), 'the month chart');
  await page.mouse.move(mb.x + mb.width / 2, mb.y + 30);
  await page.mouse.down();
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const a2 = await audit(page);
  check(r, 'dropping onto another tile never leaves an overlap', !(a2?.findings ?? []).some((f) => f.code === 'tile.overlap'), JSON.stringify(a2?.findings ?? []));
  // Narrow window: the builder still lays out without overlap or sideways scroll.
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForTimeout(1500);
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(r, 'the builder at 820px has no sideways scroll', !narrow);
  const a3 = await audit(page);
  check(r, 'the builder at 820px has no overlap', !(a3?.findings ?? []).some((f) => f.code === 'tile.overlap'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, r, 'R7-after-drop-reload');
});

// ── R8 · responsive quality ─────────────────────────────────────────────────
const readability = (page: Page) => page.evaluate(() => {
  const out: Record<string, unknown> = {};
  const overlapLabels: string[] = [];
  const legendMissing: string[] = [];
  const tableFit: Array<{ id: string | null; gap: number; clipped: boolean }> = [];
  const kpiCut: string[] = [];
  const inter = (a: DOMRect, b: DOMRect) => !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1);
  for (const tile of Array.from(document.querySelectorAll('[data-grid-item-id]'))) {
    const tid = tile.getAttribute('data-grid-item-id');
    const bars = Array.from(tile.querySelectorAll('.recharts-bar-rectangle path, .recharts-bar-rectangle rect')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    for (const t of Array.from(tile.querySelectorAll('.recharts-label-list text, .recharts-bar text'))) {
      const tb = t.getBoundingClientRect();
      if (!tb.width) continue;
      const cx = tb.left + tb.width / 2;
      const own = bars.reduce((best, b) => (Math.abs(b.left + b.width / 2 - cx) < Math.abs((best?.left ?? 1e9) + (best?.width ?? 0) / 2 - cx) ? b : best), null as DOMRect | null);
      if (bars.some((b) => b !== own && inter(tb, b))) overlapLabels.push(`${tid}:${(t.textContent ?? '').trim()}`);
    }
    const sectors = tile.querySelectorAll('.recharts-pie-sector').length;
    if (sectors > 0) {
      const tr = tile.getBoundingClientRect();
      const items = Array.from(tile.querySelectorAll('.recharts-legend-wrapper li'));
      const visible = items.filter((li) => { const b = li.getBoundingClientRect(); return b.width > 0 && b.left >= tr.left - 1 && b.right <= tr.right + 1 && b.bottom <= tr.bottom + 1; });
      if (items.length && visible.length < Math.min(items.length, sectors)) legendMissing.push(`${tid}:${visible.length}/${items.length} of ${sectors}`);
    }
    const table = tile.querySelector('table');
    if (table) {
      const scroller = table.closest('[class*="overflow"]') as HTMLElement | null;
      const scrolls = !!scroller && scroller.scrollHeight > scroller.clientHeight + 2;
      const gap = Math.round(tile.getBoundingClientRect().bottom - table.getBoundingClientRect().bottom);
      if (!scrolls) tableFit.push({ id: tid, gap, clipped: gap < -2 });
    }
    for (const v of Array.from(tile.querySelectorAll('.dashboard-kpi-value'))) {
      const el = v as HTMLElement;
      if (el.scrollWidth > el.clientWidth + 1) kpiCut.push(`${tid}:${el.textContent}`);
    }
  }
  out.overlapLabels = overlapLabels;
  out.legendMissing = legendMissing;
  out.tableFit = tableFit;
  out.kpiCut = kpiCut;
  out.sideways = document.documentElement.scrollWidth > window.innerWidth + 1;
  return out;
});

test('R8 responsive: 1440/820/390 — labels, legends, tables and KPIs read correctly', async ({ request, context }) => {
  const r = scenario('R8 responsive');
  const id = await copyOf(request, r);
  const token = await linkFor(request, id);
  const pub = await publicAt(context, `/d/${token}`, 1440, 1600);
  for (const [w, h] of [[1440, 1600], [820, 1180], [390, 844]] as const) {
    await pub.setViewportSize({ width: w, height: h });
    await settle(pub);
    const q: any = await readability(pub);
    r.metrics[`w${w}`] = q;
    check(r, `${w}px: no sideways scroll`, !q.sideways);
    check(r, `${w}px: no bar value label is drawn over another bar`, q.overlapLabels.length === 0, q.overlapLabels.slice(0, 6).join(' | '));
    check(r, `${w}px: every pie slice is named in a visible legend`, q.legendMissing.length === 0, q.legendMissing.join(' | '));
    check(r, `${w}px: tables end at their last row — not clipped, not a tall empty tile`,
      q.tableFit.every((t: any) => !t.clipped && t.gap <= 140), JSON.stringify(q.tableFit));
    check(r, `${w}px: no KPI figure is cut`, q.kpiCut.length === 0, q.kpiCut.join(' | '));
    const hard = ((await audit(pub))?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `${w}px: no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    await shot(pub, r, `R8-public-${w}`);
  }
  await pub.close();
});

// ── R9 · builder / public / embed parity ────────────────────────────────────
test('R9 parity: the builder, the public link and the embed show the same report and the same numbers', async ({ page, request, context }) => {
  const r = scenario('R9 parity');
  const id = await copyOf(request, r);
  await page.setViewportSize({ width: 1440, height: 2600 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  const builderTiles = Object.keys(await rects(page)).sort();
  const builderKpi = await kpiTexts(page);
  const token = await linkFor(request, id);
  const pub = await publicAt(context, `/d/${token}`, 1440, 2600);
  const pubTiles = Object.keys(await rects(pub)).sort();
  const pubKpi = await kpiTexts(pub);
  const emb = await request.post(`${V1}/integrations/embed/resolve`, { data: { dashboard_id: id, full_report: true } });
  const embedPath = need(r, emb.status() < 400 && (await emb.json()).embed_path, 'a full-report embed grant');
  const em = await publicAt(context, embedPath, 1440, 2600);
  const emTiles = await em.evaluate(() => Array.from(document.querySelectorAll('[data-grid-item-id]')).map((e) => e.getAttribute('data-grid-item-id')!).sort());
  const emKpi = await kpiTexts(em);
  r.metrics = { builderKpi, pubKpi, emKpi, builderTiles: builderTiles.length, pubTiles: pubTiles.length, emTiles: emTiles.length };
  check(r, 'the public link shows the builder\'s tiles', JSON.stringify(pubTiles) === JSON.stringify(builderTiles), `${builderTiles.length} vs ${pubTiles.length}`);
  check(r, 'the embed shows the builder\'s tiles', JSON.stringify(emTiles) === JSON.stringify(builderTiles), `${builderTiles.length} vs ${emTiles.length}`);
  check(r, 'the KPI figures agree on all three', builderKpi.length > 0 && JSON.stringify(pubKpi) === JSON.stringify(builderKpi) && JSON.stringify(emKpi) === JSON.stringify(builderKpi),
    `${builderKpi} | ${pubKpi} | ${emKpi}`);
  await shot(em, r, 'R9-embed-1440');
  await pub.close();
  await em.close();
});

// ── R10 · PDF of a long report ──────────────────────────────────────────────
test('R10 PDF: a long report exports complete; every page is rendered for review', async ({ request, context }) => {
  const r = scenario('R10 PDF');
  const id = await copyOf(request, r);
  const token = await linkFor(request, id);
  const pub = await publicAt(context, `/d/${token}`, 1440, 900);
  const download = pub.waitForEvent('download', { timeout: 300_000 });
  await pub.getByRole('button', { name: /^Export PDF$/ }).first().click();
  await pub.getByRole('button', { name: /^Export PDF$/ }).last().click();
  const file = await download;
  const bytes = fs.readFileSync((await file.path())!);
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
  r.metrics.pages = pages;
  check(r, 'a long report is more than one page', pages >= 2, String(pages));
  const outcome = await pub.evaluate(() => (window as any).__APPBI_LAST_EXPORT__ ?? null);
  check(r, 'the export reports nothing missing', !!outcome && (outcome.warnings ?? []).filter((w: any) => w.kind === 'incomplete').length === 0, JSON.stringify(outcome?.warnings ?? []));
  fs.writeFileSync(path.join(EVIDENCE, 'R10-report.pdf'), bytes);
  r.evidence.push('R10-report.pdf');
  r.notes.push('Page quality (blank space, cut sections, lone headings, legends, glyphs) is judged on the rendered pages: e2e/acceptance/tools/pdf_review.py renders R10-report-page<N>.png and measures how full each page is.');
  await pub.close();
});

// ── R11 · AI on an independent dataset ──────────────────────────────────────
test('R11 AI on an independent dataset: directions differ, numbers unchanged, refined by hand, published', async ({ page, request, context }) => {
  test.setTimeout(600_000);
  const r = scenario('R11 AI independent dataset');
  const id = await copyOf(request, r, INDEPENDENT);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  const before = await kpiTexts(page);
  const shape = () => page.evaluate(() => Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    return `${e.getAttribute('data-widget-type') ?? e.querySelector('[data-tile-kind]')?.getAttribute('data-tile-kind') ?? 'chart'}@${Math.round(b.top / 40)}:${Math.round(b.width / 40)}`;
  }).sort().join('|'));
  if (!(await page.getByTestId('ai-design-input').isVisible().catch(() => false))) await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').waitFor();
  const preview = async (dir: string) => {
    await page.getByTestId(`ai-design-direction-${dir}`).click();
    const ok = await page.getByTestId('ai-design-apply').waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(2500);
    return ok ? shape() : null;
  };
  const exec = need(r, await preview('executive'), 'an Executive preview from the planner');
  await shot(page, r, 'R11-preview-executive');
  // Directions are offered on a fresh panel: drop this preview, start again.
  await page.getByTestId('ai-design-discard').click().catch(() => {});
  await page.reload();
  await settle(page);
  if (!(await page.getByTestId('ai-design-input').isVisible().catch(() => false))) await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').waitFor();
  const ops = need(r, await preview('operations'), 'an Operations preview from the planner');
  await shot(page, r, 'R11-preview-operations');
  check(r, 'the two directions compose the report differently', exec !== ops, `${exec.slice(0, 120)} || ${ops.slice(0, 120)}`);
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('design-mode-manual').click().catch(() => {});
  await settle(page);
  const after = await kpiTexts(page);
  check(r, 'the redesign changed no number', JSON.stringify(after) === JSON.stringify(before), `${before} → ${after}`);
  const text = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
  check(r, 'nothing Olist-specific leaked into another dataset\'s report', !/olist|R\$/i.test(text));
  const chart = page.locator('main [data-grid-item-id]').filter({ has: page.locator('.recharts-surface') }).first();
  const chartId = need(r, await chart.getAttribute('data-grid-item-id'), 'a chart in the redesigned report');
  await frame(page, chart, 'flush');
  check(r, 'the AI-designed report is edited by hand like any report',
    (await page.locator(`[data-grid-item-id="${chartId}"] [data-tile-frame]`).first().getAttribute('data-tile-frame')) === 'flush');
  await publishUi(page);
  const token = await linkFor(request, id);
  const pub = await publicAt(context, `/d/${token}`, 1440, 2400);
  check(r, 'the public report has the hand refinement', (await pub.locator(`[data-grid-item-id="${chartId}"] [data-tile-frame]`).first().getAttribute('data-tile-frame')) === 'flush');
  check(r, 'every published sentence is computed', (await pub.locator('.dashboard-narrative__item.is-pending').count()) === 0);
  await shot(pub, r, 'R11-public-1440');
  // A finding is a computation, not text: filtered, it says something else.
  const narrative = () => pub.evaluate(() => Array.from(document.querySelectorAll('[data-narrative-variant]')).map((e) => (e.textContent ?? '').trim()).join(' | '));
  const said = await narrative();
  const region = control(pub, /Region/i);
  if (said && (await region.count()) > 0) {
    await pick(pub, region, 'North');
    await pub.waitForFunction(() => !document.querySelector('.dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
    await pub.waitForTimeout(2500);
    const filtered = await narrative();
    r.metrics.narrative = { said: said.slice(0, 300), filtered: filtered.slice(0, 300) };
    check(r, 'filtered to one region, the findings are recomputed (the sentence changes)', !!filtered && filtered !== said, filtered.slice(0, 200));
    await shot(pub, r, 'R11-public-filtered-North');
  } else {
    r.notes.push('no narrative or no Region control on the published page — recompute-on-filter NOT VERIFIED here');
  }
  await pub.close();
});
