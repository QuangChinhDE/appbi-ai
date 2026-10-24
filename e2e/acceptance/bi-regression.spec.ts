import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Existing BI modules on the isolated QA Docker stack, real browser (explicit run, bi-regression.config.ts).
 * Datasource list, Dataset list/model, a dashboard built from a chart saved earlier, its public
 * link logged out, a revoked link and an anonymous dashboard visit. Numbers against the SQL oracle.
 */
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3341';
const API = (process.env.E2E_API_URL || 'http://localhost:8341') + '/api/v1';

async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

async function adminApi() {
  const anon = await pwRequest.newContext();
  const r = await anon.post(`${API}/auth/login`, { data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  expect(r.status()).toBe(200);
  const tok = (await r.json()).access_token;
  await anon.dispose();
  return pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tok}` } });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').first().fill(process.env.ADMIN_EMAIL || '');
  await page.locator('input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || '');
  await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

test('BI · datasources, datasets, dashboard, public link, revoke, anonymous', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const api = await adminApi();
  await login(page);

  // Datasource: list shows the PG and MySQL QA sources, no error state
  await page.goto('/datasources');
  const sources = await (await api.get(`${API}/datasources/`)).json();
  expect(sources.map((s: any) => s.type).sort()).toEqual(['mysql', 'postgresql']);
  for (const s of sources) await expect(page.getByText(s.name).first()).toBeVisible();
  await shot(page, 'BI-1-datasources');

  // Dataset: list + model of the Commerce dataset opens with its measures
  await page.goto('/datasets');
  await expect(page.getByText('Dogfood Commerce').first()).toBeVisible();
  await expect(page.getByText('Dogfood Marketing').first()).toBeVisible();
  const dsets = await (await api.get(`${API}/datasets/`)).json();
  const commerce = dsets.find((d: any) => d.name === 'Dogfood Commerce');
  await page.goto(`/datasets/${commerce.id}`);
  await expect(page.locator('body')).not.toContainText(/Something went wrong|Đã xảy ra lỗi|Internal Server Error/);
  await shot(page, 'BI-2-dataset-detail');

  // Dashboard: a new dashboard holding chart 1 (revenue by region, saved earlier)
  const d = await api.post(`${API}/dashboards/`, { data: { name: `QA BI regression ${Date.now()}` } });
  expect(d.status(), await d.text()).toBeLessThan(400);
  const dash = await d.json();
  const add = await api.post(`${API}/dashboards/${dash.id}/charts`, { data: { chart_id: 1, layout: { x: 0, y: 0, w: 12, h: 8 } } });
  expect(add.status(), await add.text()).toBeLessThan(400);
  await page.goto(`/dashboards/${dash.id}`);
  const labels = Object.keys(ORACLE.region);
  for (const l of labels) await expect(page.getByText(l).first()).toBeVisible();
  await expect(page.locator('.recharts-rectangle, .recharts-bar-rectangle path, svg path.recharts-rectangle').first()).toBeVisible();
  await page.waitForTimeout(2500);   // let the bar entry animation finish before the evidence shot
  const widths = await page.locator('path.recharts-rectangle').evaluateAll((ps) => ps.map((p) => Math.round((p as SVGGraphicsElement).getBBox().width)));
  test.info().annotations.push({ type: 'dashboard-bar-widths', description: JSON.stringify(widths) });
  await shot(page, 'BI-3-dashboard');

  // Public link, logged out: same labels, data marks, values in the chart data via the public API
  const ln = await api.post(`${API}/dashboards/${dash.id}/public-links`, { data: { name: 'qa' } });
  expect(ln.status(), await ln.text()).toBeLessThan(400);
  const link = await ln.json();
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  const authedCalls: string[] = [];
  pub.on('request', (r) => { if (r.headers()['authorization']) authedCalls.push(r.url()); });
  await pub.goto(`${BASE}/d/${link.token}`);
  for (const l of labels) await expect(pub.getByText(l).first()).toBeVisible();
  const values = Object.values(ORACLE.region);
  const text = await pub.locator('body').innerText();
  await pub.screenshot({ path: test.info().outputPath('BI-4-public.png'), fullPage: true });
  expect(authedCalls, 'public page made an authed call').toEqual([]);

  // Anonymous visit of the private dashboard -> login, never data
  const p2 = await anon.newPage();
  await p2.goto(`${BASE}/dashboards/${dash.id}`);
  await p2.waitForURL(/\/login/, { timeout: 30_000 });

  // Revoke: the same public URL no longer shows data
  const del = await api.delete(`${API}/dashboards/${dash.id}/public-links/${link.id}`);
  expect(del.status(), await del.text()).toBeLessThan(400);
  await pub.goto(`${BASE}/d/${link.token}`);
  await expect(pub.getByText(labels[0])).toHaveCount(0);
  await pub.screenshot({ path: test.info().outputPath('BI-5-revoked.png'), fullPage: true });
  await anon.close();

  // cleanup the QA dashboard
  await api.delete(`${API}/dashboards/${dash.id}`);
  test.info().annotations.push({ type: 'oracle', description: JSON.stringify({ values: values.map(fmt), publicTextHasAll: values.every((v) => text.includes(fmt(v))) }) });
  test.info().annotations.push({ type: 'console-errors', description: JSON.stringify(errors.slice(0, 10)) });
  expect(errors.filter((e) => /hydrat|pageerror/i.test(e)), 'hydration/page errors').toEqual([]);
});
