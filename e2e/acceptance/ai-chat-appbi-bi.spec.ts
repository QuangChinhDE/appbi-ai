import { expect, test } from '@playwright/test';

import { api, ask, BASE, chooseSource, DA3, login, openChat, ORACLE, shot, watch } from './ai-chat-appbi.helpers';

/**
 * Existing BI on the SAME real stack after the unified AI Chat release (appbi-ai, localhost:3000):
 * Dataset pages, a chart saved from Chat in a dashboard, its public link opened logged out (no
 * signed-in call, SQL-equal numbers), the link revoked, and a BigQuery chart executed through the
 * BI chart path (runtime evidence). Run after ai-chat-appbi-acceptance (it reuses its saved chart).
 */
test.describe.configure({ mode: 'serial' });

test('B1 · Datasets list and a BigQuery dataset page open without errors', async ({ page }, info) => {
  const errors = watch(page);
  await login(page, 'qa-chat-owner');
  await page.goto('/datasets');
  await expect(page.getByText(DA3).first()).toBeVisible();
  await page.getByText(DA3).first().click();
  await expect(page).toHaveURL(/\/datasets\/\d+/);
  await expect(page.locator('body')).not.toContainText(/Something went wrong|Đã xảy ra lỗi|Internal Server Error/);
  await shot(page, info, 'B1-dataset');
  expect(errors).toEqual([]);
});

test('B2 · a chart saved from Chat on a dashboard; its public link shows SQL-equal numbers logged out; revoke kills it', async ({ page, browser }, info) => {
  const errors = watch(page);
  const owner = await api();
  const charts = await (await owner.ctx.get('/api/v1/charts/', { headers: owner.headers })).json();
  const chart = (charts as { id: number; name: string }[]).filter((c) => c.name.startsWith('QA chat chart')).pop();
  expect(chart, 'the chart R5 saved from Chat').toBeTruthy();
  const d = await owner.ctx.post('/api/v1/dashboards/', { headers: owner.headers, data: { name: `QA unified chat BI ${Date.now()}` } });
  expect(d.status(), await d.text()).toBeLessThan(400);
  const dash = await d.json();
  const add = await owner.ctx.post(`/api/v1/dashboards/${dash.id}/charts`, { headers: owner.headers,
    data: { chart_id: chart!.id, layout: { x: 0, y: 0, w: 12, h: 8 } } });
  expect(add.status(), await add.text()).toBeLessThan(400);
  await login(page, 'qa-chat-owner');
  await page.goto(`/dashboards/${dash.id}`);
  for (const p of ['Tablet', 'Laptop', 'Smartwatch']) await expect(page.getByText(p).first()).toBeVisible();
  await page.waitForTimeout(2000);
  await shot(page, info, 'B2a-dashboard');

  const ln = await owner.ctx.post(`/api/v1/dashboards/${dash.id}/public-links`, { headers: owner.headers, data: { name: 'qa' } });
  expect(ln.status(), await ln.text()).toBeLessThan(400);
  const link = await ln.json();
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  const authed: string[] = [];
  const numbers: number[] = [];
  pub.on('request', (r) => { if (r.headers()['authorization']) authed.push(r.url()); });
  pub.on('response', async (r) => {
    if (!r.url().includes('/public/') || !(r.headers()['content-type'] || '').includes('json')) return;
    try {
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') Object.values(x).forEach(walk);
        else if (typeof x === 'number') numbers.push(x);
      };
      walk(await r.json());
    } catch { /* not JSON */ }
  });
  await pub.goto(`${BASE}/d/${link.token}`);
  await expect(pub.getByText('Tablet').first()).toBeVisible();
  await pub.waitForTimeout(1500);
  await pub.screenshot({ path: info.outputPath('B2b-public.png'), fullPage: true });
  expect(authed, 'the public page made a signed-in call').toEqual([]);
  for (const v of Object.values(ORACLE.rev_q1_2024)) expect(numbers.some((n) => Math.abs(n - v) < 0.51), `public value ${v} (SQL)`).toBe(true);
  const del = await owner.ctx.delete(`/api/v1/dashboards/${dash.id}/public-links/${link.id}`, { headers: owner.headers });
  expect(del.status(), await del.text()).toBeLessThan(400);
  await pub.goto(`${BASE}/d/${link.token}`);
  await expect(pub.getByText('Tablet')).toHaveCount(0);
  await pub.screenshot({ path: info.outputPath('B2c-revoked.png'), fullPage: true });
  const p2 = await anon.newPage();
  await p2.goto(`${BASE}/dashboards/${dash.id}`);
  await p2.waitForURL(/\/login/, { timeout: 30_000 });
  await anon.close();
  await owner.ctx.delete(`/api/v1/dashboards/${dash.id}`, { headers: owner.headers });
  await owner.ctx.dispose();
  expect(errors).toEqual([]);
});

test('B3 · BigQuery: an answer saved as a chart runs through the BI chart path on BigQuery', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  const ex = await ask(page, 'Doanh thu theo sản phẩm trong quý 1 năm 2024');
  await expect(ex.getByTestId('chat-evidence')).toContainText(/bigquery/i);
  const saved = page.waitForResponse((r) => /\/api\/v1\/charts\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await ex.getByTestId('chat-save-chart').click();
  expect((await saved).status()).toBe(201);
  await ex.getByTestId('chat-open-chart').click();
  await expect(page).toHaveURL(/\/explore\/\d+$/);
  const run = page.waitForResponse((r) => /\/charts\/\d+\/data|\/explore\/run|\/charts\/preview/.test(r.url()) && r.status() === 200);
  await page.getByTestId('explore-run').click();
  await run;
  await expect(page.getByText(/^\d+ rows?$/).first()).toBeVisible({ timeout: 90_000 });
  const chip = await page.getByText(/^\d+ rows?$/).first().innerText();
  info.annotations.push({ type: 'bigquery-chart-rows', description: chip });
  expect(Number(chip.replace(/\D/g, ''))).toBeGreaterThan(0);
  await shot(page, info, 'B3-bigquery-chart');
});
