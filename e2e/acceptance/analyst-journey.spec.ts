import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Analyst journeys through the real UI, the real model and the real governed
 * path. Each assertion is about what a person sees and can do; numbers are
 * checked against the oracle in the backend suites and the rig report.
 */
const PASSWORD = process.env.ANALYST_RIG_PASSWORD || '';
const DOMAIN = process.env.ANALYST_RIG_DOMAIN || 'rig.appbi.io';
const SHOTS = '../.artifacts/analyst-acceptance';
const QUESTION = 'Doanh thu các nhóm sản phẩm theo tháng gần đây đang thay đổi như thế nào?';

test.beforeAll(() => {
  if (!PASSWORD) throw new Error('ANALYST_RIG_PASSWORD is not set: the Analyst rig is required, a skip is not a pass');
});

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
const sessions = new Map<string, Session>();

/** One real UI login per person (the login route is rate-limited to 5/minute),
 *  then the same session for every test that acts as them. */
async function login(page: Page, who: string) {
  const saved = sessions.get(who);
  if (saved) {
    await page.context().addCookies(saved.cookies);
    return;
  }
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/login');
    await page.locator('input[type="email"], input[name="email"]').first().fill(`${who}@${DOMAIN}`);
    const pw = page.locator('input[type="password"]').first();
    await pw.fill(PASSWORD);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
    await pw.press('Enter');
    const status = (await answer).status();
    // The login route allows 5 per minute per address: wait it out, never bypass it.
    if (status === 429 && attempt < 3) { await page.waitForTimeout(65_000); continue; }
    break;
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  sessions.set(who, await page.context().storageState());
}

async function pageAs(browser: Browser, who: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, who);
  return page;
}

async function ask(page: Page, q: string) {
  await page.getByTestId('analyst-question').fill(q);
  await page.getByTestId('analyst-ask').click();
}

test('analyst: question -> governed answer -> evidence -> save chart -> reopen -> follow-up @responsive', async ({ page }, info) => {
  await login(page, 'rig-analyst');
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-page')).toBeVisible();
  await page.getByTestId('analyst-sources').getByRole('button').click();
  await expect(page.getByTestId('analyst-sources')).toContainText('Rig Sales');

  await ask(page, QUESTION);
  await expect(page.getByTestId('analyst-running')).toBeVisible();
  const answer = page.getByTestId('analyst-answer').first();
  await expect(answer).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('analyst-headline')).toContainText('→');
  await expect(page.getByTestId('analyst-query-id')).toHaveText(/^[0-9a-f]{32}$/);
  await expect(page.getByTestId('analyst-evidence')).toContainText('Rig Sales');
  await expect(page.getByTestId('analyst-table').locator('tbody tr')).toHaveCount(96);
  await expect(page.getByTestId('analyst-chart').locator('.recharts-line')).not.toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-01-answer.png`, fullPage: true });

  await page.getByTestId('analyst-save-chart').click();
  await expect(page.getByTestId('analyst-chart-saved')).toBeVisible();
  const href = await page.getByTestId('analyst-open-chart').getAttribute('href');
  expect(href).toMatch(/^\/explore\/\d+$/);

  await ask(page, 'Còn theo quý thì sao?');
  await expect(page.getByTestId('analyst-answer')).toHaveCount(2, { timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-02-follow-up.png`, fullPage: true });

  // Reopen the saved chart in the existing chart surface.
  await page.goto(href!);
  await expect(page.locator('body')).not.toContainText(/not found|không tìm thấy/i);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-03-reopened-chart.png`, fullPage: true });
});

test('analyst: a running question can be cancelled', async ({ page }) => {
  await login(page, 'rig-analyst');
  await page.goto('/analyst');
  await ask(page, 'Tổng archived revenue trong slow archive là bao nhiêu?');
  await expect(page.getByTestId('analyst-running')).toBeVisible();
  await page.waitForTimeout(6_000); // planning + the governed query reaching the warehouse
  await page.getByTestId('analyst-cancel').click();
  const refused = page.getByTestId('analyst-refused');
  await expect(refused).toBeVisible({ timeout: 60_000 });
  await expect(refused).toHaveAttribute('data-code', 'cancelled');
  await page.screenshot({ path: `${SHOTS}/04-cancelled.png`, fullPage: true });
});

test('analyst: data the catalog does not have is not invented', async ({ page }) => {
  await login(page, 'rig-analyst');
  await page.goto('/analyst');
  await ask(page, 'Doanh thu theo kênh bán hàng (online/offline) và theo tỉnh thành?');
  const outcome = page.getByTestId('analyst-unsupported').or(page.getByTestId('analyst-clarify'));
  await expect(outcome).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('analyst-answer')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/05-missing-data.png`, fullPage: true });
});

test('viewer (view grant only): no source, no rows', async ({ page }) => {
  await login(page, 'rig-viewer');
  await page.goto('/analyst');
  await page.getByTestId('analyst-sources').getByRole('button').click();
  await expect(page.getByTestId('analyst-sources')).not.toContainText('Rig Sales');
  await ask(page, QUESTION);
  await expect(page.getByTestId('analyst-unsupported')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('analyst-answer')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/06-viewer.png`, fullPage: true });
});

test('a person without the module cannot use the Analyst', async ({ page }) => {
  await login(page, 'rig-nomodule');
  const resp = await page.request.post('/api/v1/analyst/ask', { data: { question: QUESTION } });
  expect(resp.status()).toBe(403);
  await page.goto('/analyst');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('analyst-answer')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/07-no-module.png`, fullPage: true });
});

test('revoked: answered while granted, refused on the next turn after revocation', async ({ browser }) => {
  const person = await pageAs(browser, 'rig-revoked');
  await person.goto('/analyst');
  await ask(person, QUESTION);
  await expect(person.getByTestId('analyst-answer')).toBeVisible({ timeout: 120_000 });

  const owner = await pageAs(browser, 'rig-owner');
  const me = await person.request.get('/api/v1/auth/me');
  expect(me.ok()).toBeTruthy();
  const personId = String((await me.json()).id);
  const del = await owner.request.delete(`/api/v1/datasets/1/grants?user_id=${personId}`);
  expect(del.ok()).toBeTruthy();

  await ask(person, QUESTION);
  await expect(person.getByTestId('analyst-unsupported')).toBeVisible({ timeout: 120_000 });
  await expect(person.getByTestId('analyst-answer')).toHaveCount(1);
  await person.screenshot({ path: `${SHOTS}/08-revoked.png`, fullPage: true });
});

test('a failed request is shown as an error, not an answer', async ({ page }) => {
  await login(page, 'rig-analyst');
  await page.goto('/analyst');
  await page.route('**/api/v1/analyst/ask', (route) => route.fulfill({ status: 503, body: '{"detail":"unavailable"}', contentType: 'application/json' }));
  await ask(page, QUESTION);
  await expect(page.getByTestId('analyst-error')).toBeVisible();
  await expect(page.getByTestId('analyst-answer')).toHaveCount(0);
});
