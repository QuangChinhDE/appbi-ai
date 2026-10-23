import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Configuration A - Analyst OFF (the release default), real browser, production build.
 * Nobody sees the Analyst, its API is not mounted, and the BI modules work unchanged:
 * datasets, a dashboard, and an existing chart that runs and shows the SQL-oracle numbers.
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

test('OFF · no Analyst entry, no Analyst API, BI modules and an existing chart unchanged', async ({ page }) => {
  if (!PASSWORD) throw new Error('DOGFOOD_PASSWORD not set: the QA stack is required');
  await login(page);
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/analyst"]')).toHaveCount(0);           // even for an allow-listed person
  await shot(page, 'OFF-1-dashboards-no-analyst');
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-question')).toHaveCount(0);
  await shot(page, 'OFF-2-analyst-route');
  const api = await page.request.get('/api/v1/analyst/catalog');
  expect(api.status(), 'Analyst API is not mounted').toBe(404);
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
