import { expect, test, type Page } from '@playwright/test';

/**
 * Engineering dogfood, Deterministic Replay Mode: the real UI, backend, GQS and
 * ledger of the isolated dogfood stack, with the planner answering from recorded
 * outputs (no paid model calls). Not CI: it needs the seeded dogfood stack.
 *
 *   E2E_BASE_URL=http://localhost:3341 DOGFOOD_PASSWORD=… \
 *     npx playwright test -c analyst-dogfood.config.ts
 *
 * A missing stack FAILS; it never passes by skipping.
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const DOMAIN = 'rig.appbi.io';
const SHOTS = '../.artifacts/analyst-dogfood';

test.beforeAll(() => {
  if (!PASSWORD) throw new Error('DOGFOOD_PASSWORD is not set: the dogfood stack is required, a skip is not a pass');
});

const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page['context']>['storageState']>>>();

async function login(page: Page, who: string) {
  const saved = sessions.get(who);
  if (saved) { await page.context().addCookies(saved.cookies); return; }
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/login');
    await page.locator('input[type="email"], input[name="email"]').first().fill(`${who}@${DOMAIN}`);
    const pw = page.locator('input[type="password"]').first();
    await pw.fill(PASSWORD);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
    await pw.press('Enter');
    const status = (await answer).status();
    if (status === 429 && attempt < 3) { await page.waitForTimeout(65_000); continue; }  // rate limit: wait, never bypass
    break;
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  sessions.set(who, await page.context().storageState());
}

async function ask(page: Page, q: string) {
  const before = await page.getByTestId('analyst-exchange').count();
  await page.getByTestId('analyst-question').fill(q);
  await page.getByTestId('analyst-ask').click();
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(before + 1, { timeout: 120_000 });
  return page.getByTestId('analyst-exchange').last();
}

test('dogfood: label, one source per dataset, ranking order, readable evidence, new question, value pick', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-preview-label')).toContainText(/not certified|chưa chứng nhận/i);

  await page.getByTestId('analyst-sources').getByRole('button').first().click();
  const sources = page.getByTestId('analyst-source');
  const names = await sources.allInnerTexts();
  const datasets = names.map((n) => n.split('·')[0].trim());
  expect(new Set(datasets).size).toBe(datasets.length);                       // one entry per Dataset
  expect(datasets.join(' ')).toContain('Dogfood Commerce');
  expect(datasets.join(' ')).not.toContain('Dogfood Support');

  const first = await ask(page, 'Doanh số theo vùng');
  await expect(first.getByTestId('analyst-headline')).toContainText('Miền Nam');
  const cells = await first.getByTestId('analyst-table').locator('tbody tr td:first-child').allInnerTexts();
  expect(cells.map((c) => c.trim())).toEqual(['Miền Nam', 'Miền Trung', 'Miền Bắc']);  // same order as the ranking

  const follow = await ask(page, 'chỉ kênh Online');
  await expect(follow.getByTestId('analyst-evidence')).toContainText('Kênh bán là Online');
  await expect(follow.getByTestId('analyst-evidence')).not.toContainText('dataset_table_');
  await page.screenshot({ path: `${SHOTS}/r3-evidence.png`, fullPage: true });

  await page.getByTestId('analyst-new-topic').click();
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);           // a clean thread
  await expect(page.getByTestId('analyst-earlier-toggle')).toBeVisible();
  await page.getByTestId('analyst-earlier-toggle').click();
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(2);
  await page.getByTestId('analyst-earlier-toggle').click();
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);

  const year = await ask(page, 'Số đơn hàng theo tháng năm 2025');            // a new question, not a follow-up
  await expect(year.getByTestId('analyst-headline')).toContainText('2025-01 → 2025-12');

  await page.getByTestId('analyst-new-topic').click();                       // each next check is a new question
  const atl = await ask(page, 'Doanh số vùng Atlantis');
  await expect(atl.getByTestId('analyst-clarify')).toBeVisible();
  await atl.getByRole('button', { name: 'Miền Nam' }).click();
  await expect(page.getByTestId('analyst-exchange').last().getByTestId('analyst-headline')).toContainText('23.46 tỷ',
    { timeout: 120_000 });

  for (const q of ['Lợi nhuận theo vùng', 'Dự báo doanh số tháng sau']) {
    if (await page.getByTestId('analyst-new-topic').count()) await page.getByTestId('analyst-new-topic').click();
    const r = await ask(page, q);
    await expect(r.getByTestId('analyst-unsupported')).toBeVisible();
    await expect(r.getByTestId('analyst-headline')).toHaveCount(0);
  }
});

test('dogfood: save chart -> reopen in Explore -> persisted', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto('/analyst');
  const ex = await ask(page, 'Doanh số theo vùng');
  const saved = page.waitForResponse((r) => r.url().includes('/charts') && r.request().method() === 'POST'
    && !r.url().includes('dry-run'));
  await ex.getByTestId('analyst-save-chart').click();
  expect((await saved).status()).toBe(201);
  const href = await ex.getByTestId('analyst-open-chart').getAttribute('href');
  expect(href).toMatch(/^\/explore\/\d+$/);
  const chartId = Number(String(href).split('/').pop());
  const loaded = page.waitForResponse((r) => r.url().includes(`/charts/${chartId}`) && r.request().method() === 'GET');
  await page.goto(String(href));
  expect((await loaded).status()).toBe(200);
  const res = await page.request.get(`/api/v1/charts/${chartId}`);
  expect(res.status()).toBe(200);
  const chart = await res.json();
  expect(JSON.stringify(chart)).toContain('region');
  await page.screenshot({ path: `${SHOTS}/r3-explore.png`, fullPage: true });
  // Edit: the call Explore's Update makes (chart type), then reopen - it persisted.
  const edited = await page.request.put(`/api/v1/charts/${chartId}`, { data: { chart_type: 'HORIZONTAL_BAR' } });
  expect(edited.status()).toBe(200);
  await page.reload();
  const again = await (await page.request.get(`/api/v1/charts/${chartId}`)).json();
  expect(again.chart_type).toBe('HORIZONTAL_BAR');
});

test('dogfood: explore-only person sees the answer but cannot save', async ({ page }) => {
  await login(page, 'qa-revoked');
  await page.goto('/analyst');
  const ex = await ask(page, 'Doanh số theo vùng');
  await expect(ex.getByTestId('analyst-headline')).toContainText('Miền Nam');
  await expect(ex.getByTestId('analyst-save-not-allowed')).toBeVisible();
  await expect(ex.getByTestId('analyst-save-chart')).toHaveCount(0);
});

test('dogfood: mobile - no sideways scroll, every region label on the chart @responsive', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'qa-analyst');
  await page.goto('/analyst');
  const ex = await ask(page, 'Doanh số theo vùng');
  await expect(ex.getByTestId('analyst-headline')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const ticks = await ex.getByTestId('analyst-chart').locator('.recharts-xAxis .recharts-cartesian-axis-tick')
    .evaluateAll((els) => els.map((e) => e.textContent || ''));                // SVG text has no innerText
  for (const r of ['Miền Nam', 'Miền Trung', 'Miền Bắc']) expect(ticks.join(' ')).toContain(r);
  await page.screenshot({ path: `${SHOTS}/r3-mobile.png`, fullPage: true });
});
