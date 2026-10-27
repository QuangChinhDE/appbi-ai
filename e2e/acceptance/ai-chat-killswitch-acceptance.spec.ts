import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * AI Chat's EMERGENCY SWITCH (backend AI_CHAT_ENABLED=false), real browser, production
 * build. It is an operator's incident control, not a product mode: the one chat stays
 * where it is, its history stays readable, a new question is refused with a plain
 * "temporarily paused" - and nothing is answered by any other engine. The BI modules
 * work unchanged: datasets and an existing chart that runs and shows the SQL-oracle
 * numbers.
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').first().fill('qa-analyst@rig.appbi.io');
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test('OFF · the switch pauses new questions only: history readable, no other engine answers, BI unchanged', async ({ page }) => {
  if (!PASSWORD) throw new Error('DOGFOOD_PASSWORD not set: the QA stack is required');
  await login(page);
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/chat"]')).toHaveCount(1);
  await expect(page.locator('a[href="/analyst"]')).toHaveCount(0);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-page')).toBeVisible();
  // history is still there to read
  const listed = page.getByTestId('chat-conversation-item');
  await expect(listed.first()).toBeVisible();
  await listed.first().click();
  await expect(page.getByTestId('chat-exchange').first()).toBeVisible();
  await shot(page, 'OFF-1-history-readable');
  // a new question is refused plainly; no answer of any kind is produced
  const before = await page.getByTestId('chat-exchange').count();
  const turn = page.waitForResponse((r) => r.url().includes('/turns') && r.request().method() === 'POST');
  await page.getByTestId('chat-question').fill('Doanh số theo vùng');
  await page.getByTestId('chat-ask').click();
  expect((await turn).status(), 'the switch answers 503').toBe(503);
  const ex = page.getByTestId('chat-exchange').nth(before);
  await expect(ex.getByTestId('chat-error')).toContainText(/tạm dừng|paused/i);
  await expect(ex.getByTestId('chat-answer')).toHaveCount(0);
  await shot(page, 'OFF-2-paused');
  // the retired engines are not a fallback
  for (const path of ['/api/v1/analyst/catalog', '/api/v1/agent-flows/chat/threads']) {
    expect([404, 405], `${path} is gone`).toContain((await page.request.get(path)).status());
  }
  await page.goto('/datasets');
  await expect(page.getByText('Dogfood Commerce').first()).toBeVisible();
  await page.goto('/explore/1');                                           // a chart saved before: still opens and runs
  await page.getByTestId('explore-run').click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.getByText(/^Showing \d+ rows?$/)).toBeVisible();
  const vals = await page.locator('table').last().locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => { const td = tr.querySelectorAll('td'); return Number((td[td.length - 1].textContent || '').replace(/[^\d.-]/g, '')); }));
  const want = Object.values(ORACLE.region).sort((a, b) => a - b);
  expect(vals.sort((a, b) => a - b)).toEqual(want);
  await shot(page, 'OFF-3-explore-unchanged');
});
