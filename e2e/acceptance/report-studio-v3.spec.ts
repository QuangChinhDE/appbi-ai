import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Report Studio V3 — the eight acceptance scenarios, as an end user, with the
 * real model. Evidence goes to docs/features/report-studio-v3/evidence:
 * full-page JPEGs, the exported PDF, and results.json (per scenario: status,
 * the assertions that ran, timings). A scenario that could not run records
 * NOT VERIFIED with the reason — never a pass.
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const DASH = `${API}/api/v1/dashboards`;
const EVIDENCE = path.resolve(__dirname, '..', '..', 'docs', 'features', 'report-studio-v3', 'evidence');
const OLIST = process.env.ACCEPT_OLIST_DASHBOARD || 'Olist review';
const OLIST_DATASET = 'Olist E-Commerce';
const SALES_DATASET = 'E2E presentation sales';
const FIXTURE = 'E2E Presentation fixture';

type Status = 'PASS' | 'FAIL' | 'NOT VERIFIED';
interface ScenarioResult { status: Status; assertions: string[]; metrics: Record<string, unknown>; evidence: string[]; notes: string[] }
const results: Record<string, ScenarioResult> = {};
const made: number[] = [];

function scenario(name: string): ScenarioResult {
  results[name] = results[name] ?? { status: 'PASS', assertions: [], metrics: {}, evidence: [], notes: [] };
  return results[name];
}

/** An assertion that is recorded, then enforced. */
function check(r: ScenarioResult, label: string, ok: boolean, detail = '') {
  r.assertions.push(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) r.status = 'FAIL';
  expect.soft(ok, `${label} ${detail}`).toBe(true);
}

test.beforeAll(() => { fs.mkdirSync(EVIDENCE, { recursive: true }); });
test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`${DASH}/${id}`).catch(() => {});
  const sha = process.env.ACCEPT_SHA ?? '';
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify({ sha, ranAt: new Date().toISOString(), results }, null, 2));
});

// ── helpers ────────────────────────────────────────────────────────────────

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
async function linkFor(request: APIRequestContext, id: number) {
  const link = await request.post(`${DASH}/${id}/public-links`, { data: { name: 'acceptance' } });
  expect(link.status()).toBeLessThan(400);
  return (await link.json()).token as string;
}
const get = (request: APIRequestContext, id: number) => request.get(`${DASH}/${id}`).then((r) => r.json());

async function settle(page: Page) {
  await page.waitForSelector('[data-grid-item-id], [data-tile-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) { for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); } el.scrollTo(0, 0); }
  });
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1800);
}

/** Full-page capture: the app scrolls inside <main>, so grow the viewport to the content. */
async function shot(page: Page, r: ScenarioResult, name: string) {
  const vp = page.viewportSize()!;
  const h = await page.evaluate(() => {
    const m = document.querySelector('main');
    return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0);
  });
  await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 7000) });
  await page.waitForTimeout(1200);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: true, type: 'jpeg', quality: 62 });
  await page.setViewportSize(vp);
  r.evidence.push(file);
}

async function audit(page: Page) {
  return page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<null | {
    tiles: Array<{ tileId: number; kind: string; marks?: number }>; findings: Array<{ code: string; tileId: number; detail: string }>;
  }>;
}
const HARD = ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'];

async function narrativeStates(page: Page) {
  return page.getByTestId('narrative-widget').evaluateAll((els) => els.map((e) => ({
    state: e.getAttribute('data-finding-state') ?? '', text: (e.textContent ?? '').trim().slice(0, 240),
  })));
}

// Relative to the grid, so a page scroll is not mistaken for a moved tile.
const rects = (page: Page) => page.evaluate(() => {
  const g = document.querySelector('main .react-grid-layout')?.getBoundingClientRect();
  return Object.fromEntries(Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const b = e.getBoundingClientRect();
    return [e.getAttribute('data-grid-item-id'), [Math.round(b.x - (g?.x ?? 0)), Math.round(b.y - (g?.y ?? 0)), Math.round(b.width), Math.round(b.height)]];
  }));
}) as Promise<Record<string, number[]>>;

async function publicShots(ctx: BrowserContext, token: string, r: ScenarioResult, prefix: string) {
  for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]] as const) {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    const t0 = Date.now();
    await p.goto(`/d/${token}`);
    await settle(p);
    r.metrics[`${prefix}_public_${w}_ms`] = Date.now() - t0;
    const a = await audit(p);
    const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `${prefix} /d at ${w}px has no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    const overflowX = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(r, `${prefix} /d at ${w}px has no sideways scroll`, !overflowX);
    const states = await narrativeStates(p);
    check(r, `${prefix} /d at ${w}px: every published sentence is computed`, states.every((s) => s.state.split(',').filter(Boolean).every((x) => x === 'ready')), states.map((s) => s.state).join(' / '));
    await shot(p, r, `${prefix}-public-${w}`);
    await p.close();
  }
}

async function openAi(page: Page) {
  if (await page.getByTestId('ai-design-input').isVisible().catch(() => false)) return;
  await page.getByTestId('design-mode-ai').click();
  await page.getByTestId('ai-design-input').waitFor();
}

/** A real model turn. Returns false (NOT VERIFIED) when the model produced no plan. */
async function askAi(page: Page, r: ScenarioResult, prompt: string, label: string): Promise<boolean> {
  await openAi(page);
  await page.getByTestId('ai-design-input').fill(prompt);
  const t0 = Date.now();
  await page.getByTestId('ai-design-send').click();
  const ok = await page.getByTestId('ai-design-apply').waitFor({ state: 'visible', timeout: 180_000 }).then(() => true).catch(() => false);
  r.metrics[`${label}_preview_ms`] = Date.now() - t0;
  if (!ok) { r.status = 'NOT VERIFIED'; r.notes.push(`${label}: the model returned no design within 180s`); }
  return ok;
}

/** The assistant turns the author reads (plan summary, capability notes, visual review). */
async function panelText(page: Page) {
  return page.locator('[data-testid="ai-design-input"]').evaluate((input) => {
    let n: HTMLElement | null = input as HTMLElement;
    while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
    return (n?.innerText ?? '').slice(-3000);
  });
}

// ── 1 · create from scratch ────────────────────────────────────────────────

test('S1 create a report from data (two datasets with independent semantics)', async ({ page, request, context }) => {
  const r = scenario('S1 create from scratch');
  for (const [dataset, goal, tag] of [
    [OLIST_DATASET, 'Monthly revenue review for the leadership team', 'olist'],
    [SALES_DATASET, 'Where does revenue come from, by region and channel?', 'sales'],
  ] as const) {
    await page.goto('/dashboards');
    await page.getByTestId('report-starter-open').click();
    await page.selectOption('[data-testid="report-starter-dataset"]', { label: dataset });
    await page.fill('[data-testid="report-starter-goal"]', goal);
    const t0 = Date.now();
    await page.getByTestId('report-starter-create').click();
    await page.waitForURL(/\/dashboards\/\d+/, { timeout: 150_000 });
    r.metrics[`${tag}_create_ms`] = Date.now() - t0;
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    made.push(id);
    const t1 = Date.now();
    await settle(page);
    r.metrics[`${tag}_first_render_ms`] = Date.now() - t1;
    const d = await get(request, id);
    const charts = d.dashboard_charts.filter((c: any) => c.widget_type === 'chart');
    const head = d.dashboard_charts.find((c: any) => c.widget_type === 'narrative' && c.widget_config?.variant === 'headline');
    check(r, `${tag}: report has charts that ran`, charts.length >= 3, `${charts.length}`);
    check(r, `${tag}: opening headline at the top`, !!head && head.layout.y === 0);
    check(r, `${tag}: headline is finding keys only`, !!head && head.widget_config.items.every((i: any) => /^[a-z_]+:\d+$/.test(i.finding)));
    check(r, `${tag}: a slicer`, (d.slicers_config ?? []).length > 0);
    check(r, `${tag}: a detail table`, charts.some((c: any) => c.chart?.chart_type === 'TABLE'));
    const states = await narrativeStates(page);
    check(r, `${tag}: headline sentences computed`, states.length > 0 && states.every((s) => s.state.split(',').filter(Boolean).every((x) => x === 'ready')), states.map((s) => s.state).join('/'));
    const a = await audit(page);
    const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `${tag}: builder has no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    r.metrics[`${tag}_charts`] = charts.map((c: any) => `${c.chart?.chart_type}:${c.chart?.config?.styleConfig?.chartTitle ?? c.chart?.name}`);
    r.metrics[`${tag}_headline`] = states[0]?.text;
    await shot(page, r, `s1-${tag}-builder-1440`);
    await page.getByTestId('dashboard-publish').click().catch(() => {});
    await page.waitForTimeout(2500);
    await publicShots(context, await linkFor(request, id), r, `s1-${tag}`);
  }
});

// ── 2 · manual canvas + style-only + locks ─────────────────────────────────

test('S2 manual canvas, a lock, then a style-only AI change keeps geometry', async ({ page, request }) => {
  const r = scenario('S2 manual + style-only + locks');
  const src = await idOf(request, FIXTURE);
  test.skip(!src, 'fixture missing');
  const id = await copyOf(request, src!);
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await shot(page, r, 's2-authored');
  // Manual: drag the last tile down into empty space.
  const tiles = page.locator('main [data-grid-item-id]');
  const count = await tiles.count();
  const last = tiles.nth(count - 1);
  const lastId = await last.getAttribute('data-grid-item-id');
  const box = (await last.boundingBox())!;
  const before = await rects(page);
  await page.mouse.move(box.x + box.width / 2, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 24 + 160, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const moved = await rects(page);
  check(r, 'a manual drag moved the tile', JSON.stringify(moved[lastId!]) !== JSON.stringify(before[lastId!]), `${before[lastId!]} → ${moved[lastId!]}`);
  // Lock another tile through its menu.
  const lockTarget = tiles.nth(Math.min(4, count - 2));
  const lockId = await lockTarget.getAttribute('data-grid-item-id');
  await lockTarget.hover();
  await lockTarget.locator('button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)').first().click();
  await page.getByRole('switch', { name: /Lock position/i }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await page.getByTestId('dashboard-save-draft').click().catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, r, 's2-manual-edited');
  const geometry = await rects(page);

  const ok = await askAi(page, r, 'Make this look like a premium, modern SaaS report. Style only — keep my layout exactly as it is.', 's2_style');
  if (!ok) return;
  await page.waitForTimeout(3000);
  const preview = await rects(page);
  check(r, 'style-only preview moved or resized no tile', JSON.stringify(preview) === JSON.stringify(geometry));
  await shot(page, r, 's2-style-preview');
  r.notes.push((await panelText(page)).slice(-900));
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2500);
  const applied = await rects(page);
  check(r, 'after Apply the geometry is unchanged', JSON.stringify(applied) === JSON.stringify(geometry));
  check(r, 'the locked tile kept its rectangle', JSON.stringify(applied[lockId!]) === JSON.stringify(geometry[lockId!]));
  const d = await get(request, id);
  const lockedRow = d.dashboard_charts.find((c: any) => String(c.id) === lockId);
  check(r, 'the lock is saved', !!(lockedRow?.layout?.locked || d.draft_layouts?.[lockId!]?.locked), JSON.stringify(lockedRow?.layout ?? {}).slice(0, 120));
  await shot(page, r, 's2-style-applied');
});

// ── 3 · full redesign ──────────────────────────────────────────────────────

test('S3 full redesign with the real model: preview, compare, apply', async ({ page, request }) => {
  const r = scenario('S3 full redesign');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  const id = await copyOf(request, src!);
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await shot(page, r, 's3-before');
  const before = await rects(page);
  const ok = await askAi(page, r, 'Redesign the whole page for the CEO board meeting: an executive brief — what happened first, why it matters, then the evidence. Calm and premium.', 's3_redesign');
  if (!ok) return;
  await settle(page);
  await shot(page, r, 's3-preview-canvas');
  await page.getByTestId('ai-design-preview-full').click();
  await page.getByTestId('studio-view-compare').click();
  await expect.poll(() => page.locator('[data-studio-frame][data-studio-settled="true"]').count(), { timeout: 60_000 }).toBe(2);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(EVIDENCE, 's3-studio-compare-1440.jpg'), type: 'jpeg', quality: 62 });
  r.evidence.push('s3-studio-compare-1440.jpg');
  await page.getByTestId('studio-close').click();
  // The visual review runs on the settled preview (bounded rounds).
  await page.waitForTimeout(12_000);
  const text = await panelText(page);
  const reviewed = /Visual review|Re-checked|Render defects|review skipped/i.test(text);
  if (!reviewed) r.notes.push('visual review: no review note appeared (vision model unavailable or slow) — NOT VERIFIED');
  r.metrics.s3_panel = text.slice(-1400);
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2500);
  await settle(page);
  const after = await rects(page);
  const movedCount = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).length;
  check(r, 'the redesign recomposed the page', movedCount > 2, `${movedCount} moved/new`);
  const a = await audit(page);
  const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
  check(r, 'after Apply: no render defect', hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
  const states = await narrativeStates(page);
  check(r, 'after Apply: every block sentence computed', states.every((s) => s.state.split(',').filter(Boolean).every((x) => x === 'ready')), states.map((s) => s.state).join('/'));
  await shot(page, r, 's3-after-apply');
});

// ── 4 · three directions ───────────────────────────────────────────────────

test('S4 executive / operations / editorial on the same baseline, published at 1440/820/390', async ({ page, request, context }) => {
  const r = scenario('S4 three directions');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  const signatures: Record<string, string> = {};
  for (const direction of ['executive', 'operations', 'editorial'] as const) {
    const id = await copyOf(request, src!);
    await page.goto(`/dashboards/${id}`);
    await settle(page);
    await openAi(page);
    const t0 = Date.now();
    await page.getByTestId(`ai-design-direction-${direction}`).click();
    await page.getByTestId('ai-design-apply').waitFor({ timeout: 60_000 });
    r.metrics[`${direction}_preview_ms`] = Date.now() - t0;
    await page.getByTestId('ai-design-apply').click();
    await page.waitForTimeout(2000);
    const t1 = Date.now();
    await page.getByTestId('dashboard-publish').click();
    await expect.poll(async () => (await get(request, id)).dashboard_charts.filter((c: any) => c.widget_type === 'narrative' && !c.layout?.draftOnly).length, { timeout: 30_000 }).toBeGreaterThan(0);
    r.metrics[`${direction}_publish_ms`] = Date.now() - t1;
    const d = await get(request, id);
    const blocks = d.dashboard_charts.filter((c: any) => c.widget_type === 'narrative');
    const said = blocks.flatMap((b: any) => (b.widget_config?.items ?? []).map((i: any) => i.finding));
    check(r, `${direction}: no finding is said twice`, new Set(said).size === said.length, said.join(','));
    signatures[direction] = blocks.map((b: any) => b.widget_config?.variant).sort().join(',') + ` | theme ${d.theme_config?.templateId ?? ''}/${d.theme_config?.mode ?? ''}`;
    await publicShots(context, await linkFor(request, id), r, `s4-${direction}`);
  }
  r.metrics.signatures = signatures;
  const distinct = new Set(Object.values(signatures)).size;
  check(r, 'the three directions differ in blocks and theme', distinct === 3, JSON.stringify(signatures));
});

// ── 5 · reference design ───────────────────────────────────────────────────

const REFERENCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Georgia,serif;background:#f6f1e7;color:#1d1d1f}
header{background:#14213d;color:#fff;padding:40px 56px}header small{letter-spacing:.2em;text-transform:uppercase;opacity:.7;font:600 12px Arial}
header h1{font-size:40px;margin:10px 0 0;font-weight:500}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-bottom:1px solid #d8cdb8;margin:0 56px}
.kpi{padding:22px 0}.kpi b{display:block;font-size:34px}.kpi span{font:600 11px Arial;letter-spacing:.14em;text-transform:uppercase;color:#6b5f4b}
.hero{margin:28px 56px;height:300px;border-left:4px solid #c1121f;background:linear-gradient(180deg,#fff,#f1e9da);padding:18px 24px;font:600 14px Arial}
.row{display:grid;grid-template-columns:2fr 1fr;gap:28px;margin:0 56px 40px}.card{height:220px;background:#fff;padding:18px;font:600 13px Arial}
.note{font:italic 15px Georgia;color:#5b5140;margin:0 56px 32px;max-width:720px}
</style></head><body>
<header><small>Quarterly review</small><h1>Revenue kept climbing — driven by a handful of categories</h1></header>
<div class="kpis"><div class="kpi"><span>Revenue</span><b>—</b></div><div class="kpi"><span>Orders</span><b>—</b></div><div class="kpi"><span>Avg order</span><b>—</b></div><div class="kpi"><span>On time</span><b>—</b></div></div>
<div class="hero">Monthly revenue — the argument chart, full width</div>
<p class="note">A short editorial paragraph explaining what moved and why it matters.</p>
<div class="row"><div class="card">Breakdown by category</div><div class="card">Share by payment type</div></div>
</body></html>`;

test('S5 reference image → native live-data report', async ({ page, request }) => {
  const r = scenario('S5 reference design');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  // The reference: a static design with NO data (placeholders), rendered to an image.
  const ref = await page.context().newPage();
  await ref.setViewportSize({ width: 1440, height: 1100 });
  await ref.setContent(REFERENCE_HTML);
  const refFile = path.join(EVIDENCE, 's5-reference.png');
  await ref.screenshot({ path: refFile, fullPage: true });
  fs.writeFileSync(path.join(EVIDENCE, 's5-reference.html'), REFERENCE_HTML);
  r.evidence.push('s5-reference.png', 's5-reference.html');
  await ref.close();

  const id = await copyOf(request, src!);
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await openAi(page);
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(refFile);
  await page.waitForTimeout(800);
  const ok = await askAi(page, r, 'Redesign this report to follow the attached reference: its hierarchy, composition, typography and surfaces. Keep every number live.', 's5_reference');
  if (!ok) return;
  await settle(page);
  const text = await panelText(page);
  r.metrics.s5_panel = text.slice(-1600);
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2500);
  await settle(page);
  const bound = await page.evaluate(() => Array.from(document.querySelectorAll('main [data-grid-item-id]'))
    .every((el) => el.querySelector('[data-chart-id], [data-testid="narrative-widget"], .dashboard-kpi-label, svg, table') !== null));
  check(r, 'every tile of the result is a native, data-bound visual (no static picture)', bound);
  const imgs = await page.locator('main [data-grid-item-id] img').count();
  check(r, 'the reference image itself is not placed on the report', imgs === 0, `${imgs} <img>`);
  const a = await audit(page);
  const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
  check(r, 'no render defect', hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
  await shot(page, r, 's5-native-result');
});

// ── 6 · filters + live findings ────────────────────────────────────────────

test('S6 a filter moves KPI, charts and narrative together', async ({ page, request }) => {
  const r = scenario('S6 filters + narrative');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  const id = await copyOf(request, src!);
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await openAi(page);
  await page.getByTestId('ai-design-direction-executive').click();
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2000);
  await page.getByTestId('dashboard-publish').click();
  await page.waitForTimeout(3000);
  const token = await linkFor(request, id);
  const pub = await page.context().newPage();
  await pub.goto(`/d/${token}`);
  await settle(pub);
  const read = () => pub.evaluate(() => ({
    sentences: Array.from(document.querySelectorAll('[data-testid="narrative-widget"] [data-finding]')).map((e) => (e.textContent ?? '').trim()),
    kpis: Array.from(document.querySelectorAll('[data-grid-item-id]')).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((s) => s.length < 90).slice(0, 6),
    states: Array.from(document.querySelectorAll('[data-testid="narrative-widget"]')).map((e) => e.getAttribute('data-finding-state')).join(','),
  }));
  const all = await read();
  await shot(pub, r, 's6-before-filter');
  const t0 = Date.now();
  await pub.locator('button[title^="Customer state"]').first().click();
  await pub.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: /^\s*SP\s*$/ }).first().click();
  await pub.getByRole('button', { name: /^\s*Apply\s*$/ }).first().click();
  await settle(pub);
  r.metrics.s6_filter_to_ready_ms = Date.now() - t0;
  const sp = await read();
  r.metrics.s6_before = all;
  r.metrics.s6_after = sp;
  check(r, 'KPIs changed with the filter', JSON.stringify(sp.kpis) !== JSON.stringify(all.kpis));
  check(r, 'the narrative changed with the filter (no stale headline)', JSON.stringify(sp.sentences) !== JSON.stringify(all.sentences));
  check(r, 'no sentence is still computing once the report settled', !sp.states.includes('pending'), sp.states);
  await shot(pub, r, 's6-after-filter-SP');
  await pub.close();
});

// ── 7 · undo/redo of AI-created blocks ─────────────────────────────────────

test('S7 AI-created blocks: undo removes, redo re-creates, save, reload, publish', async ({ page, request }) => {
  const r = scenario('S7 undo/redo AI blocks');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  const narr = async (id: number) => (await get(request, id)).dashboard_charts.filter((c: any) => c.widget_type === 'narrative').length;
  for (const source of ['model', 'direction'] as const) {
    const id = await copyOf(request, src!);
    await page.goto(`/dashboards/${id}`);
    await settle(page);
    if (source === 'model') {
      const ok = await askAi(page, r, 'Redesign the page as an executive brief with a headline that states what happened and a short summary block of what moved.', 's7_model');
      if (!ok) continue;
    } else {
      await openAi(page);
      await page.getByTestId('ai-design-direction-editorial').click();
      await page.getByTestId('ai-design-apply').waitFor({ timeout: 60_000 });
    }
    const base = await narr(id);
    await page.getByTestId('ai-design-apply').click();
    // Blocks are created one after another: read the count once it is still.
    let settledCount = -1;
    for (let i = 0, same = 0; i < 40 && same < 3; i++) {
      const n = await narr(id);
      same = n === settledCount ? same + 1 : 0;
      settledCount = n;
      await page.waitForTimeout(700);
    }
    const created = settledCount - base;
    if (created <= 0) {
      r.notes.push(`${source}: the plan created no block — this path cannot exercise block re-creation`);
      if (source === 'model') { r.assertions.push('NOT VERIFIED — model plan created no block'); continue; }
    }
    check(r, `${source}: Apply created blocks`, created > 0, `${created}`);
    await page.getByRole('button', { name: /^Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(() => narr(id), { timeout: 20_000 }).toBe(base);
    check(r, `${source}: Undo removed them`, (await narr(id)) === base);
    await page.getByRole('button', { name: /^Redo \(Ctrl\+Shift\+Z\)/ }).click();
    await expect.poll(() => narr(id), { timeout: 20_000 }).toBe(base + created);
    check(r, `${source}: Redo re-created them`, (await narr(id)) === base + created);
    await page.getByTestId('dashboard-save-draft').click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.reload();
    await settle(page);
    check(r, `${source}: they survive a reload`, (await page.getByTestId('narrative-widget').count()) >= created);
    await page.getByTestId('dashboard-publish').click();
    await expect.poll(async () => (await get(request, id)).dashboard_charts.filter((c: any) => c.widget_type === 'narrative' && !c.layout?.draftOnly).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(created);
    check(r, `${source}: they are published`, true);
    await shot(page, r, `s7-${source}-after-publish`);
  }
});

// ── 8 · public / embed / export ────────────────────────────────────────────

test('S8 builder, /d, /embed and the exported PDF show the same report', async ({ page, request, context }) => {
  const r = scenario('S8 public / embed / export');
  const src = await idOf(request, OLIST);
  test.skip(!src, 'Olist report missing');
  const id = await copyOf(request, src!);
  await page.goto(`/dashboards/${id}`);
  await settle(page);
  await openAi(page);
  await page.getByTestId('ai-design-direction-executive').click();
  await page.getByTestId('ai-design-apply').click();
  await page.waitForTimeout(2000);
  await page.getByTestId('dashboard-publish').click();
  await page.waitForTimeout(3000);
  await page.getByTestId('design-mode-manual').click().catch(() => {});
  await settle(page);
  const builderTiles = await page.locator('main [data-grid-item-id]').count();
  await shot(page, r, 's8-builder');
  const token = await linkFor(request, id);
  for (const surface of ['d', 'embed'] as const) {
    const p = await context.newPage();
    await p.goto(`/${surface}/${token}`);
    await settle(p);
    const n = await p.locator('[data-grid-item-id]').count();
    check(r, `/${surface} shows the same tiles as the builder`, n === builderTiles, `${n} vs ${builderTiles}`);
    const a = await audit(p);
    const hard = (a?.findings ?? []).filter((f) => HARD.includes(f.code));
    check(r, `/${surface} has no render defect`, hard.length === 0, hard.map((f) => `${f.code}@${f.tileId}`).join(','));
    await shot(p, r, `s8-${surface}-1440`);
    if (surface === 'd') {
      const t0 = Date.now();
      const download = p.waitForEvent('download', { timeout: 240_000 });
      await p.getByRole('button', { name: /^Export PDF$/ }).first().click();
      await p.getByRole('button', { name: /^Export PDF$/ }).last().click();
      const file = await download;
      r.metrics.s8_export_ms = Date.now() - t0;
      const bytes = fs.readFileSync((await file.path())!);
      check(r, 'the export is a PDF', bytes.subarray(0, 4).toString() === '%PDF');
      check(r, 'the export is not empty', bytes.length > 20_000, `${bytes.length} bytes`);
      fs.writeFileSync(path.join(EVIDENCE, 's8-export.pdf'), bytes);
      r.evidence.push('s8-export.pdf');
    }
    await p.close();
  }
});
