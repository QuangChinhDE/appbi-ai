import { expect, request, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';

import { api, fillSecret, login, QA_MODEL, qaKey } from './ai-chat-appbi.helpers';

/**
 * THE public Dashboard AI Bot on the REAL AppBI stack (Compose project appbi-ai,
 * http://localhost:3000), answered by the ONE Answer Core over the link's PUBLISHED
 * report - BigQuery (DA6, dw_buoi_7) through the governed public chart path.
 *
 * Fixtures (scratchpad, never in the repo): BOT_FIXTURES_FILE - the QA dashboard
 * "QA Bot · DA6 BigQuery" and its two links (full; region locked); BOT_ORACLE_FILE -
 * hand-written BigQuery SQL on the raw tables. No Agent Flow is bound for these
 * journeys: the bot must answer without one. Zero retries; real model under the
 * cumulative test cap and the link's own USD ceiling.
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const FX = JSON.parse(fs.readFileSync(process.env.BOT_FIXTURES_FILE || '', 'utf-8')) as {
  token_full: string; token_locked: string; token_tiny?: string; token_addon?: string; locked_region: string;
  charts: Record<string, number>; dashboard_id: number;
};
const OR = JSON.parse(fs.readFileSync(process.env.BOT_ORACLE_FILE || '', 'utf-8')) as Record<string, any>;

test.describe.configure({ mode: 'serial' });

/** PO 2026-10-28: a link's assistant runs on the model and API key its PUBLISHER supplies
 *  (no server default). `withoutKey` = the link's key and model are removed (P0 then
 *  configures "full" through the editor UI); otherwise QA_MODEL and the QA key are set
 *  through the link API. */
async function configureLinks(withoutKey: string[] = []) {
  const owner = await api('qa-chat-owner');
  const listed = await owner.ctx.get(`/api/v1/dashboards/${FX.dashboard_id}/public-links`, { headers: owner.headers });
  expect(listed.status()).toBe(200);
  for (const link of (await listed.json()) as { id: number; name: string; appearance_config: Record<string, unknown> }[]) {
    if (!String(link.name).startsWith('QA Bot')) continue;
    const ac: Record<string, unknown> = { ...(link.appearance_config || {}) };
    if (withoutKey.includes(link.name)) {
      ac.ai_bot_credential_id = null;
      ac.ai_bot_model = null;
    } else if (!ac.ai_bot_key_configured || ac.ai_bot_model !== QA_MODEL) {
      Object.assign(ac, { ai_bot_key: qaKey(), ai_bot_provider: 'openai', ai_bot_model: QA_MODEL });
    } else {
      continue;
    }
    const r = await owner.ctx.patch(`/api/v1/dashboards/${FX.dashboard_id}/public-links/${link.id}`,
                                    { headers: owner.headers, data: { appearance_config: ac } });
    expect(r.status(), `configure ${link.name}`).toBe(200);
  }
  await owner.ctx.dispose();
}

test.beforeAll(async () => { await configureLinks(); });

/** Every console error / page error / 5xx of the public page. */
function watch(page: Page) {
  const found: string[] = [];
  const authed: string[] = [];
  const keyHeaders: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Download the React DevTools|ResizeObserver loop/i.test(m.text())) return;
    if (m.location().url.startsWith('https://accounts.google.com/')) return;
    found.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => found.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('request', (r) => {
    const h = r.headers();
    if (h['authorization']) authed.push(r.url());
    if (Object.keys(h).some((k) => k.toLowerCase().startsWith('x-user-ai-'))) keyHeaders.push(r.url());
  });
  page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) found.push(`http ${r.status()} ${r.url()}`); });
  return { found, authed, keyHeaders };
}

async function openBot(page: Page, token = FX.token_full) {
  await page.goto(`${BASE}/d/${token}`);
  await page.getByTestId('ai-bot-open').click();
  await expect(page.getByTestId('ai-bot-panel')).toBeVisible();
  await expect(page.getByTestId('ai-bot-not-ready')).toHaveCount(0);
}

/** Ask; return the NEW exchange once it reached a terminal state. */
async function ask(page: Page, q: string): Promise<Locator> {
  const before = await page.getByTestId('ai-bot-exchange').count();
  await page.getByTestId('ai-bot-input').fill(q);
  await page.getByTestId('ai-bot-send').click();
  const ex = page.getByTestId('ai-bot-exchange').nth(before);
  await expect(ex).not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
  return ex;
}

/** The answer table as {label: value}; label = every dimension cell joined by " / ". */
async function tableOf(ex: Locator): Promise<Record<string, number>> {
  await expect(ex.getByTestId('ai-bot-table')).toBeVisible();
  // a long answer shows its first rows; the viewer opens the rest - every row is compared
  const more = ex.getByTestId('ai-bot-table-more');
  if (await more.count()) await more.click();
  const rows = await ex.getByTestId('ai-bot-table').locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const out: Record<string, number> = {};
  for (const cells of rows) out[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
  return out;
}

function expectOracle(got: Record<string, number>, want: Record<string, number>, label: string) {
  expect(Object.keys(got).sort(), `groups of ${label}`).toEqual(Object.keys(want).sort());
  for (const [k, v] of Object.entries(want)) expect(Math.abs(got[k] - v), `${label} / ${k}: ${got[k]} vs SQL ${v}`).toBeLessThan(0.51);
}

async function shot(page: Page, info: import('@playwright/test').TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('P0 · the publisher pastes the API key and picks the model in the link editor; the bot becomes ready', async ({ page }, info) => {
  await configureLinks(['QA Bot · full']);   // the publisher starts from nothing
  const key = qaKey();
  const leaked: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/')) r.text().then((b) => { if (b.includes(key)) leaked.push(r.url()); }).catch(() => {});
  });
  // a viewer first: no key and no model yet -> the bot says it is not ready
  const viewer = await page.context().browser()!.newContext();
  const vp = await viewer.newPage();
  await vp.goto(`${BASE}/d/${FX.token_full}`);
  await vp.getByTestId('ai-bot-open').click();
  await expect(vp.getByTestId('ai-bot-not-ready')).toBeVisible();

  await login(page, 'qa-chat-owner');
  await page.goto(`${BASE}/dashboards/${FX.dashboard_id}`);
  await page.waitForSelector('[data-dashboard-canvas-root] [data-tile-id]', { timeout: 60_000 });
  await page.getByTestId('dashboard-more').click();
  await page.getByTestId('dashboard-open-public-links').click();
  await page.locator('[data-testid^="public-link-row-"]', { hasText: 'QA Bot · full' }).first().click();
  await page.getByTestId('public-link-tab-aibot').click();
  await expect(page.getByTestId('ai-bot-readiness').locator('[data-ready]')).toHaveAttribute('data-ready', 'false');
  await page.getByTestId('ai-bot-model-key-provider').selectOption('openai');
  await page.getByTestId('ai-bot-model-key-model').selectOption(QA_MODEL);
  await fillSecret(page.getByTestId('ai-bot-model-key-key'), key);
  await shot(page, info, 'P0-editor-filled');
  await page.getByTestId('public-link-save').click();
  // reopen: ready, the model named, the key shown only by its last characters
  await page.locator('[data-testid^="public-link-row-"]', { hasText: 'QA Bot · full' }).first().click();
  await page.getByTestId('public-link-tab-aibot').click();
  await expect(page.getByTestId('ai-bot-readiness').locator('[data-ready]')).toHaveAttribute('data-ready', 'true',
                                                                                             { timeout: 30_000 });
  await expect(page.getByTestId('ai-bot-readiness')).toContainText(QA_MODEL);
  await expect(page.getByTestId('ai-bot-model-key-key')).toHaveAttribute('placeholder', new RegExp(`…${key.slice(-4)}`));
  await expect(page.getByTestId('ai-bot-model-key-key')).toHaveValue('');
  await shot(page, info, 'P0-editor-ready');
  // the viewer, again: the bot is ready
  await vp.reload();
  await vp.getByTestId('ai-bot-open').click();
  await expect(vp.getByTestId('ai-bot-panel')).toBeVisible();
  await expect(vp.getByTestId('ai-bot-not-ready')).toHaveCount(0);
  await viewer.close();
  expect(leaked, 'an API response carried the API key').toEqual([]);
});

test('P1 · the viewer brings no key: the bot answers the total from the published KPI (= SQL); no authed call', async ({ page }, info) => {
  const w = watch(page);
  await openBot(page);
  await expect(page.getByTestId('ai-bot-panel').getByText(/API key/i)).toHaveCount(0);
  const ex = await ask(page, 'Tổng doanh thu là bao nhiêu?');
  await expect(ex).toHaveAttribute('data-status', 'answered');
  const headline = await ex.getByTestId('ai-bot-answer').innerText();
  const total = OR.total as number;
  const shown = Object.values(await tableOf(ex));
  expect(shown.some((v) => Math.abs(v - total) < 0.51), `total ${shown} vs SQL ${total}; ${headline}`).toBe(true);
  await expect(ex.getByTestId('ai-bot-evidence')).toContainText('QA Bot');
  await shot(page, info, 'P1-total');
  expect(w.authed, 'a public page made a signed-in call').toEqual([]);
  expect(w.keyHeaders, 'a public page sent a provider key header').toEqual([]);
  expect(w.found).toEqual([]);
});

test('P2 · revenue by region (= SQL), then a follow-up that adds a period on an exposed field', async ({ page }, info) => {
  const w = watch(page);
  await openBot(page);
  const a = await ask(page, 'Doanh thu theo khu vực');
  expectOracle(await tableOf(a), OR.by_region, 'by_region');
  await expect(a.getByTestId('ai-bot-evidence')).toContainText('khu vực');
  const b = await ask(page, 'Chỉ tính quý 2 năm 2024');
  expectOracle(await tableOf(b), OR.q2_by_region, 'q2_by_region');
  const c = await ask(page, 'Còn quý 1 thì sao?');
  expectOracle(await tableOf(c), OR.q1_by_region, 'q1_by_region');
  await shot(page, info, 'P2-region-periods');
  expect(w.found).toEqual([]);
});

test('P3 · top 3 products (= SQL), revenue by month (growth), a chart explained', async ({ page }, info) => {
  await openBot(page);
  const top = await ask(page, 'Top 3 sản phẩm có doanh thu cao nhất');
  const got = await tableOf(top);
  const want = Object.fromEntries((OR.top3_products as [string, number][]));
  expectOracle(got, want, 'top3');
  const month = await ask(page, 'Doanh thu tăng trưởng theo tháng thế nào?');
  expectOracle(await tableOf(month), OR.by_month, 'by_month');
  const tier = await ask(page, 'Biểu đồ doanh thu theo nhóm sản phẩm cho biết điều gì?');
  expectOracle(await tableOf(tier), OR.by_tier, 'by_tier');
  await shot(page, info, 'P3-top-month-tier');
});

test('P4 · a filter on an exposed field the chart does not show is applied by the governed engine (= SQL)', async ({ page }, info) => {
  await openBot(page);
  const ex = await ask(page, 'Doanh thu theo sản phẩm ở khu vực Central');
  expectOracle(await tableOf(ex), OR.central_by_product, 'central_by_product');
  await shot(page, info, 'P4-central-products');
});

test('P5 · out of the published report: a draft (unpublished) chart, an unpublished field, no data - never a number', async ({ page }, info) => {
  await openBot(page);
  for (const q of ['Doanh thu theo nhóm bán hàng', 'Cho tôi danh sách email của nhân viên', 'Doanh thu năm 2030']) {
    const ex = await ask(page, q);
    const status = await ex.getAttribute('data-status');
    info.annotations.push({ type: 'out-of-scope', description: `${q} -> ${status}` });
    if (status === 'answered') {
      // only an honest "no data" answer is acceptable, never the draft tile's numbers
      await expect(ex.getByTestId('ai-bot-table')).toHaveCount(0);
    } else {
      expect(['refused', 'clarification_required', 'failed']).toContain(status);
    }
  }
  await shot(page, info, 'P5-out-of-scope');
});

test('P6 · a link that locks the region answers only inside its lock', async ({ page }, info) => {
  await openBot(page, FX.token_locked);
  const ex = await ask(page, 'Doanh thu theo khu vực');
  const got = await tableOf(ex);
  expect(Object.keys(got)).toEqual([FX.locked_region]);
  expect(Math.abs(got[FX.locked_region] - OR.by_region[FX.locked_region])).toBeLessThan(0.51);
  await shot(page, info, 'P6-locked-region');
});

test('P7 · Stop while the Core is planning ends the turn as cancelled', async ({ page }, info) => {
  await openBot(page);
  const before = await page.getByTestId('ai-bot-exchange').count();
  await page.getByTestId('ai-bot-input').fill('Doanh thu theo sản phẩm');
  await page.getByTestId('ai-bot-send').click();
  await page.getByTestId('ai-bot-stop').click();
  const ex = page.getByTestId('ai-bot-exchange').nth(before);
  await expect(ex.getByTestId('ai-bot-cancelled')).toBeVisible({ timeout: 60_000 });
  await shot(page, info, 'P7-stopped');
});

test('P8 · the retired answering routes are gone; a viewer header cannot lift the budget', async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  for (const path of ['ai/agent/chat', 'ai/agent/explore', 'ai/briefing/brief']) {
    const r = await ctx.post(`/api/v1/public/dashboards/${FX.token_full}/${path}`, { data: {} });
    expect(r.status(), path).toBe(410);
  }
  if (FX.token_tiny) {
    // a link whose ceiling is below one call's worst case: refused before any model call, header or not
    for (const headers of [{}, { 'X-User-Ai-Key': 'sk-viewer-brings-a-key', 'X-User-Ai-Provider': 'openai' }]) {
      const r = await ctx.post(`/api/v1/public/dashboards/${FX.token_tiny}/ai/answer`, {
        headers, data: { question: 'Tổng doanh thu là bao nhiêu?', conversation_key: `qa${Date.now()}x`,
                         idempotency_key: `qa${Date.now()}${Math.random().toString(36).slice(2, 10)}` } });
      const text = await r.text();
      expect(r.status() === 429 || /ai_budget_exceeded|budget/.test(text), text.slice(0, 300)).toBe(true);
      expect(text).not.toMatch(/"status":\s*"answered"/);
    }
  }
  await ctx.dispose();
});

test('P9 · a page switch: the viewer on the products page is answered from its charts', async ({ page }, info) => {
  await page.goto(`${BASE}/d/${FX.token_full}`);
  await page.getByTestId('public-page-tab-p-products').first().click();
  await page.getByTestId('ai-bot-open').click();
  const ex = await ask(page, 'Doanh thu theo nhóm sản phẩm');
  expectOracle(await tableOf(ex), OR.by_tier, 'by_tier');
  await expect(ex.getByTestId('ai-bot-evidence')).toContainText('Sản phẩm');
  await shot(page, info, 'P9-products-page');
});

test('P10 · mobile 390x844 and desktop 1440x900: the panel fits, no horizontal scroll', async ({ page }, info) => {
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await openBot(page);
    const ex = await ask(page, 'Doanh thu theo khu vực');
    await expect(ex.getByTestId('ai-bot-table')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll at ${w}`).toBeLessThanOrEqual(1);
    const box = await page.getByTestId('ai-bot-panel').boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= w + 1, `panel fits at ${w}`).toBeTruthy();
    await shot(page, info, `P10-${w}x${h}`);
  }
});

test('P11 · the slicer the viewer picked bounds the answer (= SQL for that region)', async ({ page }, info) => {
  await page.goto(`${BASE}/d/${FX.token_full}`);
  const slicer = page.locator('[data-widget-type="slicer"]').first();
  await expect(slicer).toBeVisible({ timeout: 60_000 });
  await slicer.getByText('West', { exact: true }).click();
  const apply = page.getByTestId('filter-apply-bar-apply');
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.getByTestId('ai-bot-open').click();
  const ex = await ask(page, 'Tổng doanh thu là bao nhiêu?');
  const shown = Object.values(await tableOf(ex));
  const west = OR.by_region.West as number;
  expect(shown.some((v) => Math.abs(v - west) < 0.51), `West total ${shown} vs SQL ${west}`).toBe(true);
  await expect(ex.getByTestId('ai-bot-evidence')).toContainText('West');
  await shot(page, info, 'P11-slicer-west');
});

test('P12 · a follow-up that removes a filter answers the whole report again (= SQL)', async ({ page }, info) => {
  await openBot(page);
  const a = await ask(page, 'Doanh thu theo sản phẩm ở khu vực Central');
  expectOracle(await tableOf(a), OR.central_by_product, 'central_by_product');
  const b = await ask(page, 'Bỏ lọc khu vực, tính tất cả khu vực');
  expectOracle(await tableOf(b), OR.by_product, 'by_product');
  await shot(page, info, 'P12-filter-removed');
});

test('P13 · a link over its AI budget tells the viewer plainly - no number, no key prompt', async ({ page }, info) => {
  test.skip(!FX.token_tiny, 'no tiny-budget link fixture');
  await openBot(page, FX.token_tiny);
  const ex = await ask(page, 'Tổng doanh thu là bao nhiêu?');
  expect(['failed', 'refused']).toContain(await ex.getAttribute('data-status'));
  await expect(ex.getByTestId('ai-bot-table')).toHaveCount(0);
  await expect(ex).not.toContainText(/Traceback|Exception|sk-|api key/i);
  await shot(page, info, 'P13-budget');
});

test('P14 · the optional add-on: documents the flow cited, beside the Core - never its own numbers', async ({ page }, info) => {
  test.skip(!FX.token_addon, 'no add-on link fixture');
  await openBot(page, FX.token_addon);
  const doc = await ask(page, 'Chính sách giao hàng trễ được hoàn phí thế nào?');
  await expect(doc.getByTestId('ai-bot-supporting')).toContainText('QA Chính sách giao hàng Olist 2026');
  await expect(doc.getByTestId('ai-bot-no-data-part')).toBeVisible();  // said plainly: no data answers it
  await expect(doc.getByTestId('ai-bot-table')).toHaveCount(0);
  // the Core still answers the data on the same link, from the published report
  const data = await ask(page, 'Doanh thu theo khu vực');
  expectOracle(await tableOf(data), OR.by_region, 'by_region (add-on link)');
  await shot(page, info, 'P14-addon-documents');
});

test('P15 · add-on failure isolation: injected instructions and invented figures, a missing run', async ({ page }, info) => {
  test.skip(!FX.token_addon, 'no add-on link fixture');
  await openBot(page, FX.token_addon);
  const bad = await ask(page, 'Chính sách hoàn phí giao trễ và mục tiêu doanh thu quý là gì?');
  // the flow's figure is shown only as NOT verified; its metric block never becomes a table
  await expect(bad.getByTestId('ai-bot-unverified')).toBeVisible();
  await expect(bad.getByTestId('ai-bot-table')).toHaveCount(0);
  const missing = await ask(page, 'Quy định đổi trả hàng của cửa hàng ra sao?');
  await expect(missing.getByTestId('ai-bot-notices')).toBeVisible();
  await expect(missing.getByTestId('ai-bot-notices')).not.toContainText('qa_bot_policy_addon');  // a name, not a key
  await expect(missing.getByTestId('ai-bot-refused')).not.toHaveText(/^Quy định đổi trả hàng của cửa hàng ra sao\?$/);
  await expect(missing.getByTestId('ai-bot-table')).toHaveCount(0);
  expect(['refused', 'answered']).toContain(await missing.getAttribute('data-status'));
  await shot(page, info, 'P15-addon-isolation');
});
