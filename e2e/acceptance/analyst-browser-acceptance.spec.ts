import { expect, request, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

/**
 * AppBI Analyst V1 - REAL BROWSER PRODUCT ACCEPTANCE (Deterministic Replay Mode).
 *
 * Production Next.js build, real backend + GQS + PostgreSQL/MySQL QA sources, real
 * permissions, real Chart Builder - and every step under test done the way a person
 * does it: typing, clicking, choosing, navigating. `page.request` is used ONLY to set
 * a precondition (revoke a grant, rename a field for the stale-choice case) and is
 * labelled as such; it never stands in for a step the journey is proving.
 *
 * Numbers are compared with an INDEPENDENT SQL oracle (hand-written SQL on the QA
 * warehouse, ORACLE_FILE), never with the Analyst's own output.
 *
 *   E2E_BASE_URL=http://localhost:3341 DOGFOOD_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   ORACLE_FILE=.../oracle.json npx playwright test -c analyst-browser.config.ts
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ADMIN = { email: process.env.ADMIN_EMAIL || '', password: process.env.ADMIN_PASSWORD || '' };
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
const DOMAIN = 'rig.appbi.io';

test.beforeAll(() => {
  if (!PASSWORD || !ADMIN.email) throw new Error('DOGFOOD_PASSWORD / ADMIN_* not set: the QA stack is required; a skip is not a pass');
});

// ── helpers ────────────────────────────────────────────────────────────────────
const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page['context']>['storageState']>>>();

async function login(page: Page, who: string) {
  const saved = sessions.get(who);
  if (saved) { await page.context().addCookies(saved.cookies); return; }
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/login');
    await page.locator('input[type="email"]').first().fill(`${who}@${DOMAIN}`);
    const pw = page.locator('input[type="password"]').first();
    await pw.fill(PASSWORD);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
    await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
    const status = (await answer).status();
    if (status === 429 && attempt < 3) { await page.waitForTimeout(65_000); continue; }  // the rate limit, waited out
    expect(status, 'UI login').toBe(200);
    break;
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  sessions.set(who, await page.context().storageState());
}

/** PRECONDITIONS ONLY. A request context of its own: `page.request` shares the browser's
 *  cookies, so logging the admin in through it silently turns the page into the admin. */
async function adminApi() {
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:3341' });
  let r = await ctx.post('/api/v1/auth/login', { data: ADMIN });
  if (r.status() === 429) { await new Promise((ok) => setTimeout(ok, 65_000)); r = await ctx.post('/api/v1/auth/login', { data: ADMIN }); }
  const headers = { Authorization: `Bearer ${(await r.json()).access_token}` };
  const ds = (await (await ctx.get('/api/v1/datasets/', { headers })).json())
    .find((d: { name: string }) => d.name === 'Dogfood Commerce').id as number;
  const users = (await (await ctx.get('/api/v1/permissions/matrix', { headers })).json()).users;
  const userId = (who: string) => users.find((u: { email: string }) => u.email === `${who}@${DOMAIN}`).user_id;
  return {
    ctx, headers, ds,
    revoke: (who: string) => ctx.delete(`/api/v1/datasets/${ds}/grants?user_id=${userId(who)}`, { headers }),
    grant: (who: string, verb: string) => ctx.post(`/api/v1/datasets/${ds}/grants`, { headers, data: { verb, user_id: userId(who) } }),
  };
}

// A failed run must not leave the next one without its fixtures: put the grants back first.
test.beforeAll(async () => {
  const a = await adminApi();
  await a.grant('qa-analyst', 'build');
  await a.grant('qa-revoked', 'explore');
  await a.ctx.dispose();
});

async function shot(page: Page, info: TestInfo, name: string, opts: { fullPage?: boolean } = {}) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: opts.fullPage ?? true });
  await info.attach(name, { path, contentType: 'image/png' });
}

const OUTCOME = '[data-testid="analyst-answer"], [data-testid="analyst-clarify"], [data-testid="analyst-unsupported"], [data-testid="analyst-refused"], [data-testid="analyst-error"]';

/** Type a question and press Ask; wait for the NEW exchange's outcome (state-based). */
async function ask(page: Page, q: string): Promise<Locator> {
  const before = await page.getByTestId('analyst-exchange').count();
  await page.getByTestId('analyst-question').fill(q);
  await page.getByTestId('analyst-ask').click();
  const ex = page.getByTestId('analyst-exchange').nth(before);
  await expect(ex).toBeVisible({ timeout: 120_000 });
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  return ex;
}

function num(text: string): number {
  return Number(text.replace(/[^\d.-]/g, ''));
}

/** The answer's data table as {label: value}; label = every dimension cell joined by " / ". */
async function tableOf(scope: Locator): Promise<Record<string, number>> {
  const rows = await scope.getByTestId('analyst-table').locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const out: Record<string, number> = {};
  for (const cells of rows) out[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
  return out;
}

function expectOracle(got: Record<string, number>, key: string) {
  const want = ORACLE[key];
  expect(Object.keys(got).sort(), `groups of ${key}`).toEqual(Object.keys(want).sort());
  for (const [k, v] of Object.entries(want)) expect(Math.abs(got[k] - v), `${key} / ${k}: ${got[k]} vs SQL ${v}`).toBeLessThan(0.51);
}

async function analyst(page: Page, who = 'qa-analyst') {
  await login(page, who);
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-page')).toBeVisible();
}

async function newTopic(page: Page) {
  const btn = page.getByTestId('analyst-new-topic');
  if (await btn.count()) await btn.click();
}

// ── Journey A: login and navigation ────────────────────────────────────────────
test('A · login, sidebar by permission, header, sources, EN/VI, refresh keeps the session', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/dashboards');
  const nav = page.locator('a[href="/analyst"]');
  await expect(nav.first()).toBeVisible();                       // entry shown to a permitted person
  await nav.first().click();
  await expect(page).toHaveURL(/\/analyst$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AppBI Analyst');
  await expect(page.getByTestId('analyst-preview-label')).toHaveText('Internal AI Preview — NOT CERTIFIED');
  await expect(page.getByTestId('analyst-warning')).toBeVisible();
  await expect(page.getByTestId('analyst-question')).toBeEnabled();          // the warning never blocks asking
  await page.getByTestId('analyst-sources').getByRole('button').first().click();
  const sources = await page.getByTestId('analyst-source').allInnerTexts();
  expect(sources.map((s) => s.split('·')[0].trim()).sort()).toEqual(['Dogfood Commerce', 'Dogfood Marketing', 'Dogfood Slow']);
  await shot(page, info, 'A1-overview-sources');
  // language: the user menu, as a person switches it
  await page.getByRole('button', { name: /^Q$/ }).click();
  await page.getByRole('button', { name: /Tiếng Việt|Vietnamese/ }).click();
  await expect(page.getByTestId('analyst-preview-label')).toHaveText('Bản xem trước AI nội bộ — CHƯA CHỨNG NHẬN');
  await expect(page.getByTestId('analyst-warning')).toHaveText('Kết quả AI đang trong giai đoạn thử nghiệm. Hãy kiểm tra số liệu và nguồn trước khi sử dụng cho quyết định nghiệp vụ.');
  await shot(page, info, 'A2-vietnamese');
  await page.reload();                                           // refresh keeps auth AND language
  await expect(page.getByTestId('analyst-page')).toBeVisible();
  await expect(page.getByTestId('analyst-preview-label')).toHaveText('Bản xem trước AI nội bộ — CHƯA CHỨNG NHẬN');
  await page.getByRole('button', { name: /^Q$/ }).click();
  await page.getByRole('button', { name: /English|Tiếng Anh/ }).click();
  await expect(page.getByTestId('analyst-preview-label')).toHaveText('Internal AI Preview — NOT CERTIFIED');
});

test('A · first visit: how-to steps and example questions built from the person\'s own sources', async ({ page }, info) => {
  await analyst(page);
  const howto = page.getByTestId('analyst-howto');
  await expect(howto.locator('ol > li')).toHaveCount(6);
  const examples = await howto.getByTestId('analyst-example').allInnerTexts();
  expect(examples.length, 'example questions').toBeGreaterThan(0);
  await shot(page, info, 'A4-howto');
  // a click fills the box and asks NOTHING: the person decides
  await howto.getByTestId('analyst-example').first().click();
  await expect(page.getByTestId('analyst-question')).toHaveValue(examples[0]);
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);
  // (that an example is ANSWERABLE needs the real model: analyst-live-smoke.spec.ts asks one)
});

test('A · a person without the Analyst module sees no entry and is blocked on the page', async ({ page }, info) => {
  await login(page, 'qa-nomodule');
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/analyst"]')).toHaveCount(0);
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-question')).toHaveCount(0);
  await expect(page.getByText(/no permission|không có quyền|do not have access/i).first()).toBeVisible();
  await shot(page, info, 'A3-no-module-blocked');
});

// ── Journey B: new question -> verified answer ─────────────────────────────────
test('B · ask -> answer with source, metric, table, chart marks and evidence equal to SQL', async ({ page }, info) => {
  await analyst(page);
  await shot(page, info, 'B0-empty');
  const ex = await ask(page, 'Doanh số theo vùng');
  const answer = ex.getByTestId('analyst-answer');
  await expect(answer).toBeVisible();
  await expect(ex.getByTestId('analyst-headline')).toContainText('Miền Nam');
  const ev = ex.getByTestId('analyst-evidence');
  await expect(ev).toContainText('Dogfood Commerce');
  await expect(ev).toContainText('Doanh số');
  await expect(ev).toContainText(/None|Không có/);                // no filter on this answer
  await expect(ex.getByTestId('analyst-query-id')).toHaveText(/[0-9a-f]{16,}/);
  expectOracle(await tableOf(ex), 'region');
  // the chart really draws: one bar per region, every axis label, the metric in the legend
  const chart = ex.getByTestId('analyst-chart');
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(3);
  const ticks = await chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick').evaluateAll((e) => e.map((x) => x.textContent || ''));
  expect(ticks.join('|')).toMatch(/Miền Nam.*Miền Trung.*Miền Bắc/);
  await expect(chart.locator('.recharts-legend-wrapper')).toContainText('Doanh số');
  await shot(page, info, 'B1-verified-answer');
});

// ── Journey C: real clarification ──────────────────────────────────────────────
test('C · metric/source clarification -> a click completes the answer', async ({ page }, info) => {
  await analyst(page);
  const ex = await ask(page, 'Kênh bán nào tốt nhất');
  const card = ex.getByTestId('analyst-clarify');
  await expect(card.getByRole('button')).toHaveCount(2);
  await shot(page, info, 'C1-clarification');
  await card.getByRole('button', { name: 'Doanh số (Dogfood Commerce)' }).click();
  const done = page.getByTestId('analyst-exchange').last();
  await expect(done.getByTestId('analyst-answer')).toBeVisible({ timeout: 120_000 });
  await expect(done.getByTestId('analyst-evidence')).toContainText('Dogfood Commerce');
  // "kênh NÀO tốt nhất" by the chosen metric = the top channel(s); every channel ties on this data
  const got = await tableOf(done);
  const top = Math.max(...Object.values(ORACLE.channel_sales));
  for (const [k, v] of Object.entries(got)) expect(Math.abs(v - ORACLE.channel_sales[k])).toBeLessThan(0.51);
  expect(Object.values(got).every((v) => Math.abs(v - top) < 0.51)).toBeTruthy();
  await shot(page, info, 'C2-clarified-answer');
});

test('C · an unknown filter value -> a real value is offered -> the pick is answered', async ({ page }, info) => {
  await analyst(page);
  const ex = await ask(page, 'Doanh số vùng Atlantis');
  const card = ex.getByTestId('analyst-clarify');
  await expect(card).toContainText(/không có trong dữ liệu/);
  await card.getByRole('button', { name: 'Miền Nam' }).click();
  const done = page.getByTestId('analyst-exchange').last();
  await expect(done.getByTestId('analyst-answer')).toBeVisible({ timeout: 120_000 });
  expectOracle(await tableOf(done), 'south_total');
  await expect(done.getByTestId('analyst-evidence')).toContainText('Miền Nam');
  await shot(page, info, 'C3-value-pick');
});

test('C · a stale or revoked choice ends in a reason, never in data', async ({ page }) => {
  await analyst(page);
  const a = await adminApi();
  const model = await (await a.ctx.get(`/api/v1/datasets/${a.ds}/model`, { headers: a.headers })).json();
  const lines = model.views.find((v: { name: string }) => v.name === 'dataset_table_3');
  const relabel = (label: string) => a.ctx.put(`/api/v1/datasets/${a.ds}/model/views/${lines.id}`, {
    headers: a.headers,
    data: { dimensions: lines.dimensions,
            measures: lines.measures.map((m: { name: string }) => (m.name === 'net_sales' ? { ...m, label } : m)) } });
  try {
    // stale: the catalog changes between the question and the click (PRECONDITION via API)
    let ex = await ask(page, 'Kênh bán nào tốt nhất');
    expect((await relabel('Doanh số (đổi tên)')).status()).toBe(200);
    await ex.getByTestId('analyst-clarify').getByRole('button', { name: 'Doanh số (Dogfood Commerce)' }).click();
    let done = page.getByTestId('analyst-exchange').last();
    await expect(done.locator('[data-testid="analyst-unsupported"]')).toContainText(/thay đổi|hỏi lại/);
    await expect(done.getByTestId('analyst-table')).toHaveCount(0);
    expect((await relabel('Doanh số')).status()).toBe(200);
    // revoked: the grant goes away between the question and the click (PRECONDITION via API)
    await page.reload();
    ex = await ask(page, 'Kênh bán nào tốt nhất');
    expect((await a.revoke('qa-analyst')).status()).toBe(200);
    await ex.getByTestId('analyst-clarify').getByRole('button', { name: 'Doanh số (Dogfood Commerce)' }).click();
    done = page.getByTestId('analyst-exchange').last();
    await expect(done.locator('[data-testid="analyst-unsupported"]')).toBeVisible({ timeout: 60_000 });
    await expect(done.getByTestId('analyst-table')).toHaveCount(0);
  } finally {
    await relabel('Doanh số');
    await a.grant('qa-analyst', 'build');
    await a.ctx.dispose();
  }
});

// ── Journey D: filters and follow-up ───────────────────────────────────────────
test('D · year, region, exclusion, date range, two breakdowns, follow-up keeps filters, new question resets', async ({ page }, info) => {
  await analyst(page);
  let ex = await ask(page, 'Tổng doanh số năm 2025');
  expectOracle(await tableOf(ex), 'total_2025');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('2025-01-01');
  await newTopic(page);
  ex = await ask(page, 'Doanh số Miền Bắc theo kênh bán năm 2025');
  expectOracle(await tableOf(ex), 'north_channel_2025');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('Vùng là Miền Bắc');
  // follow-up changes the breakdown only: region AND year must stay (the recording omits them)
  ex = await ask(page, 'theo ngành hàng thì sao');
  expectOracle(await tableOf(ex), 'north_category_2025');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('Vùng là Miền Bắc');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('2025-01-01');
  await shot(page, info, 'D1-follow-up-keeps-filters');
  await newTopic(page);
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);     // a new question starts clean
  ex = await ask(page, 'Doanh số không tính đơn bị huỷ năm 2025');
  expectOracle(await tableOf(ex), 'not_cancelled_2025');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('không phải Huỷ');
  await newTopic(page);
  ex = await ask(page, 'Doanh số theo vùng từ 01/03/2025 đến 31/05/2025');
  expectOracle(await tableOf(ex), 'region_mar_may_2025');
  await expect(ex.getByTestId('analyst-evidence')).toContainText('2025-03-01');
  await newTopic(page);
  ex = await ask(page, 'Doanh số theo vùng và kênh bán năm 2025');
  expectOracle(await tableOf(ex), 'region_channel_2025');
  await shot(page, info, 'D2-two-breakdowns-table');
});

// ── Journey E: real Chart Builder editing ──────────────────────────────────────
const CHARTS: { q: string; oracle: string; draft: RegExp; role: RegExp; filter?: RegExp; marks: string }[] = [
  { q: 'Doanh số theo vùng', oracle: 'region', draft: /BAR/, role: /Vùng/, marks: '.recharts-bar-rectangle' },
  { q: 'Tổng doanh số năm 2025', oracle: 'total_2025', draft: /KPI/, role: /Doanh số/, filter: /order_date|Ngày đặt hàng/, marks: '' },
  { q: 'Doanh số theo tháng năm 2025', oracle: 'month_2025', draft: /LINE/, role: /Ngày đặt hàng/, filter: /order_date|Ngày đặt hàng/, marks: '.recharts-line-curve' },
  { q: 'Doanh số Miền Bắc theo kênh bán năm 2025', oracle: 'north_channel_2025', draft: /BAR/, role: /Kênh bán/, filter: /region|Vùng/, marks: '.recharts-bar-rectangle' },
  { q: 'Doanh số theo vùng và kênh bán năm 2025', oracle: 'region_channel_2025', draft: /TABLE/, role: /Vùng/, filter: /order_date|Ngày đặt hàng/, marks: '' },
];

for (const c of CHARTS) {
  test(`E · "${c.q}": save -> open in Chart Builder -> edit type and title in the UI -> save -> reload -> persisted, same numbers`, async ({ page }, info) => {
    await analyst(page);
    const ex = await ask(page, c.q);
    const draftPanel = ex.getByTestId('analyst-chart-draft');
    await expect(draftPanel).toContainText(c.draft);
    const saved = page.waitForResponse((r) => /\/api\/v1\/charts\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await ex.getByTestId('analyst-save-chart').click();                // the person's click
    expect((await saved).status()).toBe(201);
    await expect(ex.getByTestId('analyst-chart-saved')).toBeVisible();
    await ex.getByTestId('analyst-open-chart').click();                // the person's navigation
    await expect(page).toHaveURL(/\/explore\/\d+$/);
    const chartId = Number(page.url().split('/').pop());
    info.annotations.push({ type: 'saved chart', description: `id ${chartId} for "${c.q}"` });
    // the Chart Builder shows the plan: role, metric, filters
    await expect(page.getByRole('heading', { name: 'Chart Type' })).toBeVisible();
    await expect(page.locator('body')).toContainText(c.role);
    if (c.filter) await expect(page.getByText('No filters')).toHaveCount(0);
    await page.getByTestId('explore-run').click();
    await expect(page.getByText(/^\d+ rows?$/).first()).toBeVisible({ timeout: 60_000 });  // the PREVIEW row-count chip
    if (c.marks) await expect(page.getByTestId('explore-chart').locator(c.marks).first()).toBeVisible();
    await shot(page, info, `E-${chartId}-builder-before`);
    // edit IN THE UI: chart type (where the picker offers another one) and the title
    const typeBtn = page.getByRole('button', { name: /Change$/ }).first();
    const before = (await typeBtn.innerText()).split('\n')[0].trim();
    await typeBtn.click();
    const target = before.startsWith('Horizontal Bar') ? /^Bar\b/ : before.startsWith('Bar') ? /^Horizontal Bar/ : before.startsWith('Line') ? /^Area/ : null;
    if (target) await page.getByRole('button', { name: target }).first().click();
    else await page.getByRole('button', { name: /Close$/ }).first().click();  // KPI/TABLE: keep the type (the card toggles)
    // rename the chart in the header (every chart type has it)
    const name = `Acceptance ${chartId} edited`;
    await page.getByRole('button', { name: 'Rename chart' }).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(name);
    const isPut = (r: import('@playwright/test').Response) => r.url().includes(`/api/v1/charts/${chartId}`) && r.request().method() === 'PUT';
    // two saves: the rename's own (name only) and Update's (the builder state). They can
    // overlap, so count both rather than waiting for them in order.
    const puts: import('@playwright/test').Response[] = [];
    const onResponse = (r: import('@playwright/test').Response) => { if (isPut(r)) puts.push(r); };
    page.on('response', onResponse);
    await page.keyboard.press('Enter');
    await expect.poll(() => puts.length, { message: 'the rename saved' }).toBeGreaterThanOrEqual(1);
    await page.getByTestId('explore-save').click();
    await expect.poll(() => puts.length, { message: 'Update saved' }).toBeGreaterThanOrEqual(2);
    page.off('response', onResponse);
    for (const r of puts) expect(r.status()).toBe(200);
    const full = puts.find((r) => (r.request().postDataJSON() as { config?: unknown })?.config !== undefined);
    expect(full, 'the Update save carries the builder state').toBeTruthy();
    info.annotations.push({ type: `chart ${chartId} saved type`, description: String((full!.request().postDataJSON() as { chart_type?: string })?.chart_type) });
    await page.reload();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    if (target) await expect(page.getByRole('button', { name: /Change$/ }).first()).not.toHaveText(new RegExp(`^${before}`));
    // the same numbers as the SQL oracle after reopening (Table tab of the builder)
    await page.getByTestId('explore-run').click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.getByText(/^Showing \d+ rows?$/)).toBeVisible();
    const timeOfDay = await page.locator('table').last().locator('tbody td').evaluateAll((tds) =>
      tds.map((td) => (td.textContent || '').trim()).filter((t) => /\d{1,2}:\d{2}:\d{2}/.test(t)));
    expect(timeOfDay, 'a DATE bucket shown with a time of day').toEqual([]);
    const cells = await page.locator('table').last().locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
    const values = cells.map((r) => Number(r[r.length - 1].replace(/[^\d.-]/g, ''))).sort((a, b) => a - b);
    const want = Object.values(ORACLE[c.oracle]).sort((a, b) => a - b);
    expect(values.length, 'rows after reopen').toBe(want.length);
    values.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(0.51));
    await shot(page, info, `E-${chartId}-builder-after-reopen`);
  });
}

test('E · an answer the chart cannot reproduce exactly is not offered for saving, with the reason', async ({ page }, info) => {
  await analyst(page);
  const ex = await ask(page, 'Top 2 kênh bán có số đơn hàng cao nhất');
  await expect(ex.getByTestId('analyst-save-chart')).toHaveCount(0);
  await expect(ex.getByTestId('analyst-chart-draft')).toContainText(/bằng nhau tại ngưỡng|không đề xuất lưu/);
  await shot(page, info, 'E-unsafe-top-n-withheld');
});

// ── Journey F: permission UX ───────────────────────────────────────────────────
test('F · viewer, explore-only, revoked mid-session, feedback', async ({ page }, info) => {
  await analyst(page, 'qa-viewer');
  let ex = await ask(page, 'Doanh số theo vùng');
  await expect(ex.locator('[data-testid="analyst-unsupported"]')).toContainText(/quyền/);
  await shot(page, info, 'F1-viewer-denied');
  await page.context().clearCookies();
  await analyst(page, 'qa-revoked');
  ex = await ask(page, 'Doanh số theo vùng');
  await expect(ex.getByTestId('analyst-answer')).toBeVisible();
  await expect(ex.getByTestId('analyst-save-chart')).toHaveCount(0);
  await expect(ex.getByTestId('analyst-save-not-allowed')).toBeVisible();
  await shot(page, info, 'F2-explore-only-no-save');
  const reasons = await ex.getByTestId('analyst-feedback-reason').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
  expect(reasons).toEqual(['wrong_metric', 'wrong_dataset', 'wrong_filter', 'incorrect_number', 'wrong_interpretation', 'unsupported_but_answerable', 'ux_issue']);
  await ex.getByTestId('analyst-feedback-reason').selectOption('wrong_filter');
  await ex.getByTestId('analyst-feedback-down').click();
  await expect(ex.getByTestId('analyst-feedback-sent')).toBeVisible();
  // the grant is revoked while the page is open (PRECONDITION via API); the next ask is refused
  const a = await adminApi();
  try {
    expect((await a.revoke('qa-revoked')).status()).toBe(200);
    ex = await ask(page, 'Doanh số theo vùng');
    await expect(ex.locator('[data-testid="analyst-unsupported"]')).toContainText(/quyền|phạm vi bạn được dùng/);
    await expect(ex.getByTestId('analyst-table')).toHaveCount(0);
    await shot(page, info, 'F3-revoked-mid-session');
  } finally {
    await a.grant('qa-revoked', 'explore');
    await a.ctx.dispose();
  }
});

// ── Journey G: failure and resilience ──────────────────────────────────────────
test('G · loading, cancel, unsupported, no data, double click, server errors, network loss, refresh, back/forward', async ({ page }, info) => {
  await analyst(page);
  // loading + cancel (a deliberately slow QA source)
  await page.getByTestId('analyst-question').fill('Doanh thu chậm');
  await page.getByTestId('analyst-ask').dblclick();                 // a person double-clicks
  await expect(page.getByTestId('analyst-running')).toBeVisible();
  await expect(page.getByTestId('analyst-ask')).toBeDisabled();
  await shot(page, info, 'G1-loading');
  await page.getByTestId('analyst-cancel').click();
  const cancelled = page.getByTestId('analyst-exchange').last();
  await expect(cancelled.locator(OUTCOME).first()).toBeVisible({ timeout: 60_000 });
  await expect(cancelled.getByTestId('analyst-table')).toHaveCount(0);
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(1);  // the double click asked ONCE
  await newTopic(page);
  let ex = await ask(page, 'Lợi nhuận theo vùng');
  await expect(ex.getByTestId('analyst-unsupported')).toBeVisible();
  await expect(ex.getByTestId('analyst-headline')).toHaveCount(0);
  await shot(page, info, 'G2-refusal');
  await newTopic(page);
  // a period with no orders: COUNT over nothing is 0, said plainly, with the 2027 filter in the evidence
  ex = await ask(page, 'Số đơn hàng năm 2027');
  await expect(ex.getByTestId('analyst-headline')).toHaveText(/: 0\.?$/);
  await expect(ex.getByTestId('analyst-evidence')).toContainText('2027-01-01');
  // server failure and network loss are shown as errors, not as answers (simulated at the network layer)
  for (const [label, handler] of [
    ['500', (r: import('@playwright/test').Route) => r.fulfill({ status: 500, body: '{"detail":"boom"}', contentType: 'application/json' })],
    ['503', (r: import('@playwright/test').Route) => r.fulfill({ status: 503, body: '{"detail":"unavailable"}', contentType: 'application/json' })],
    ['offline', (r: import('@playwright/test').Route) => r.abort('internetdisconnected')],
  ] as const) {
    await page.route('**/api/v1/analyst/ask', handler);
    await newTopic(page);
    ex = await ask(page, 'Doanh số theo vùng');
    await expect(ex.getByTestId('analyst-error')).toBeVisible();
    await shot(page, info, `G3-error-${label}`);
    await page.unroute('**/api/v1/analyst/ask');
  }
  // retry after the outage: the same question works again
  await newTopic(page);
  ex = await ask(page, 'Doanh số theo vùng');
  expectOracle(await tableOf(ex), 'region');
  // refresh during a running turn, then back/forward
  await page.getByTestId('analyst-question').fill('Doanh thu chậm');
  await page.getByTestId('analyst-ask').click();
  await expect(page.getByTestId('analyst-running')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('analyst-page')).toBeVisible();
  await expect(page.getByTestId('analyst-question')).toBeEnabled();
  await page.goto('/dashboards');
  await page.goBack();
  await expect(page.getByTestId('analyst-page')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/dashboards/);
});

test('G · the 60 s bound stops a slow source with a clear message', async ({ page }, info) => {
  test.setTimeout(240_000);
  await analyst(page);
  const ex = await ask(page, 'Doanh thu chậm');
  await expect(ex.locator(OUTCOME).first()).toContainText(/thời gian|time/i);
  await expect(ex.getByTestId('analyst-table')).toHaveCount(0);
  await shot(page, info, 'G4-timeout');
});

// ── Visual QA across viewports ─────────────────────────────────────────────────
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 }, { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 }, { name: 'mobile-390', width: 390, height: 844 },
  { name: 'narrow-360', width: 360, height: 800 },
];

async function noPageOverflow(page: Page) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(o, 'horizontal page overflow (px)').toBeLessThanOrEqual(0);
  // the shell's <main> scrolls on its own: content wider than it is clipped controls, not page overflow
  const m = await page.evaluate(() => { const el = document.querySelector('main'); return el ? el.scrollWidth - el.clientWidth : 0; });
  expect(m, 'horizontal overflow inside the app shell <main> (px)').toBeLessThanOrEqual(0);
}

for (const vp of VIEWPORTS) {
  test(`V · ${vp.name}: empty, sources, answer+chart, wide table, evidence, clarify, refusal, error, Explore`, async ({ page }, info) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await analyst(page);
    await noPageOverflow(page); await shot(page, info, `${vp.name}-1-empty`, { fullPage: false });
    await page.getByTestId('analyst-sources').getByRole('button').first().click();
    await noPageOverflow(page); await shot(page, info, `${vp.name}-2-sources`, { fullPage: false });
    let ex = await ask(page, 'Doanh số theo vùng');
    await ex.getByTestId('analyst-headline').scrollIntoViewIfNeeded();
    await noPageOverflow(page); await shot(page, info, `${vp.name}-3-answer`);
    const ticks = await ex.getByTestId('analyst-chart').locator('.recharts-xAxis .recharts-cartesian-axis-tick').evaluateAll((e) => e.map((x) => x.textContent || ''));
    for (const r of ['Miền Nam', 'Miền Trung', 'Miền Bắc']) expect(ticks.join('|')).toContain(r);
    // the sticky question bar never hides the evidence's last row
    const ev = ex.getByTestId('analyst-evidence');
    await ev.scrollIntoViewIfNeeded();
    await expect(ev).toBeInViewport();
    await newTopic(page);
    ex = await ask(page, 'Doanh số theo vùng và kênh bán năm 2025');
    const table = ex.getByTestId('analyst-table');
    await table.scrollIntoViewIfNeeded();
    await noPageOverflow(page);                                        // a wide table scrolls INSIDE its box
    const box = await table.evaluate((el) => {
      const sc = el.querySelector('div') || el;
      return { scroll: sc.scrollWidth, client: sc.clientWidth, overflowX: getComputedStyle(sc).overflowX };
    });
    info.annotations.push({ type: `${vp.name} table`, description: JSON.stringify(box) });
    await shot(page, info, `${vp.name}-4-wide-table`);
    await newTopic(page);
    ex = await ask(page, 'Kênh bán nào tốt nhất');
    await noPageOverflow(page); await shot(page, info, `${vp.name}-5-clarify`, { fullPage: false });
    await newTopic(page);
    ex = await ask(page, 'Lợi nhuận theo vùng');
    await noPageOverflow(page); await shot(page, info, `${vp.name}-6-refusal`, { fullPage: false });
    await page.route('**/api/v1/analyst/ask', (r) => r.fulfill({ status: 503, body: '{"detail":"unavailable"}', contentType: 'application/json' }));
    await newTopic(page);
    ex = await ask(page, 'Doanh số theo vùng');
    await noPageOverflow(page); await shot(page, info, `${vp.name}-7-error`, { fullPage: false });
    await page.unroute('**/api/v1/analyst/ask');
    await page.goto('/explore/1');
    await expect(page.getByRole('heading', { name: 'Chart Type' })).toBeVisible();
    await page.getByTestId('explore-run').click();
    await expect(page.getByText(/^\d+ rows?$/).first()).toBeVisible({ timeout: 60_000 });  // the PREVIEW row-count chip
    await noPageOverflow(page); await shot(page, info, `${vp.name}-8-explore`);
  });
}

// ── Accessibility basics on the Analyst ────────────────────────────────────────
test('X · keyboard, focus, names and labels on the Analyst (automated scan recorded, not a certification)', async ({ page }, info) => {
  await analyst(page);
  await page.getByTestId('analyst-question').focus();
  await page.keyboard.type('Doanh số theo vùng');
  await page.keyboard.press('Enter');                                // Ask by keyboard
  const ex = page.getByTestId('analyst-exchange').last();
  await expect(ex.getByTestId('analyst-answer')).toBeVisible({ timeout: 120_000 });
  const unnamed = await page.locator('[data-testid^="analyst"] button, [data-testid^="analyst"] a').evaluateAll((els) =>
    els.filter((e) => !(e.getAttribute('aria-label') || (e.textContent || '').trim())).length);
  expect(unnamed, 'buttons/links without an accessible name').toBe(0);
  const labelled = await page.getByTestId('analyst-question').evaluate((el) => {
    const id = el.getAttribute('id');
    return !!(id && document.querySelector(`label[for="${id}"]`)) || !!el.getAttribute('aria-label');
  });
  expect(labelled, 'question box has a label').toBeTruthy();
  // focus stays in the question box after an answer by Enter: the next question can be typed at once
  await expect(page.getByTestId('analyst-question')).toBeFocused();
  // and Tab from there reaches a visible, named control (not lost on <body>)
  await page.getByTestId('analyst-question').fill('x');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('analyst-ask')).toBeFocused();
  await page.getByTestId('analyst-question').fill('');
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const scans: Record<string, unknown[]> = {};
  for (const [where, scope] of [['answer', '[data-testid="analyst-page"]'], ['clarify', '[data-testid="analyst-page"]']] as const) {
    if (where === 'clarify') { await newTopic(page); await ask(page, 'Kênh bán nào tốt nhất'); }
    const res = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    scans[where] = res.violations;
    info.annotations.push({ type: `axe ${where}`, description: res.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length})`).join('; ') || 'none' });
  }
  fs.writeFileSync(info.outputPath('axe.json'), JSON.stringify(scans, null, 1));
  await info.attach('axe.json', { path: info.outputPath('axe.json'), contentType: 'application/json' });
  const blocking = Object.values(scans).flat().filter((v) => ['critical', 'serious'].includes(String((v as { impact?: string }).impact)));
  expect(blocking.map((v) => (v as { id: string }).id), 'critical/serious WCAG A/AA violations (automated scan, not a certification)').toEqual([]);
});
