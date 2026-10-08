import { expect, request as pwRequest, test, type Page, type Response } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Chart final hardening — the Chart Builder's semantic base lifecycle and its
 * refusal UX, in a real browser against the real API and database.
 *
 * Fixture (backend/scripts/ci/seed_e2e_chart_hardening.py), the user report's shape:
 *   bc_activity (added FIRST) ─owner_id→ bc_owner ─hire_date→ Date
 *   bc_pfm ─pfm_date→ Date   and   bc_pfm ─owner_id→ bc_owner
 * Revenue (bc_pfm) by Date month has TWO meanings → AMBIGUOUS_ROUTE, always.
 * Revenue by owner: Ann 100, Bob 57.
 *
 * Every journey asserts BOTH the visible UI and the network. Project
 * `chart-hardening` runs with retries 0: a semantic journey that passes on the
 * second try is a race, not a pass.
 */
type Fixture = {
  dataset_id: number; dataset_name: string; tables: Record<string, number>; views: Record<string, string>;
  saved_chart_id: number; share_chart_id: number; dashboard_id: number; link_token: string; reader_email: string;
};
const FIX: Fixture = (() => {
  const file = path.join(__dirname, '..', '.auth', 'chart_hardening.json');
  if (!fs.existsSync(file)) throw new Error(`${file} missing — run backend/scripts/ci/seed_e2e_chart_hardening.py`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();
const READER_PASSWORD = process.env.E2E_PASSWORD || '123456';

const chip = (page: Page) => page.getByTestId('base-chip-button');

async function newChartOnDataset(page: Page) {
  await page.goto('/explore/new');
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: FIX.dataset_name }) });
  await expect(select).toBeVisible();
  await select.selectOption({ label: FIX.dataset_name });
  await expect(page.getByText('Columns:')).toBeVisible();
}

async function chooseType(page: Page, group: string, type: string) {
  await page.getByRole('button', { name: 'Change' }).first().click();
  await page.locator(`button[title="${group}"]`).click();
  await page.locator(`div.grid button[title="${type}"]`).first().click();
}

async function pickY(page: Page, title: string) {
  await page.getByText('+ add value (any column)...').click();
  await page.locator(`button[title="${title}"]`).first().click();
}

async function pickX(page: Page, title: string) {
  const slot = page.locator('div').filter({ has: page.locator('label', { hasText: /^X Axis/ }) }).last();
  await slot.locator('button').first().click();
  await page.locator(`button[title="${title}"]`).first().click();
}

async function run(page: Page): Promise<Response> {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Run' }).click(),
  ]);
  return resp;
}

function rowsOf(body: { data?: Array<Record<string, unknown>> }) {
  return (body.data ?? []).map((r) => {
    const vals = Object.entries(r);
    const name = vals.find(([k]) => k.endsWith('owner_name'))?.[1];
    const rev = vals.find(([k]) => k.endsWith('revenue'))?.[1];
    return `${name ?? '∑'}=${Number(rev)}`;
  }).sort();
}

test.describe.configure({ mode: 'serial' });

test('J1+J3: choosing a dataset (and the TABLE default) commits no base', async ({ page }) => {
  const previews: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/charts/preview-data')) previews.push(r.url()); });
  await newChartOnDataset(page);
  // TABLE shows every column as an implicit default — that is not a choice.
  await expect(chip(page)).toContainText('Choose base table');
  await expect(chip(page)).toHaveAttribute('data-base-table-id', '');
  await expect(page.getByTestId('base-origin')).toHaveCount(0);
  // Unchecking ONE column turns the implicit "all" into an explicit list of the
  // rest — a bulk change, never read as picking the first of them.
  await page.getByText('id', { exact: true }).first().click();
  await expect(chip(page)).toHaveAttribute('data-base-table-id', '');
  // switching type before any field does not seed a dimension/metric either
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await expect(chip(page)).toHaveAttribute('data-base-table-id', '');
  await expect(page.getByText('+ add value (any column)...')).toBeVisible();
  expect(previews, 'nothing runs before a base exists').toHaveLength(0);
});

test('J2: the first field the user picks derives the base; Run uses it', async ({ page }) => {
  await newChartOnDataset(page);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickY(page, 'bc_pfm.revenue');
  await expect(chip(page)).toHaveAttribute('data-base-table-id', String(FIX.tables.bc_pfm));
  await expect(chip(page)).toContainText('bc_pfm');
  await expect(page.getByTestId('base-origin')).toHaveText('Set from the first field you picked');
  await pickX(page, 'bc_owner.owner_name');
  const resp = await run(page);
  expect(resp.status()).toBe(200);
  expect(resp.request().postDataJSON().dataset_table_id).toBe(FIX.tables.bc_pfm);
  expect(rowsOf(await resp.json())).toEqual(['Ann=100', 'Bob=57']);
  await expect(page.getByTestId('chart-failure')).toHaveCount(0);
});

test('J5: a two-meaning Date route is refused, structured, explained — never a number', async ({ page }) => {
  await newChartOnDataset(page);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickY(page, 'bc_pfm.revenue');
  await pickX(page, 'Date.month_label');
  const resp = await run(page);
  expect(resp.status()).toBe(400);
  expect(resp.headers()['x-appbi-refusal']).toBe('AMBIGUOUS_ROUTE');
  const body = await resp.json();
  expect(body.data).toBeUndefined();
  expect(body.refusal).toEqual({ category: 'AMBIGUOUS_ROUTE', target: 'Date',
    routes: ['bc_pfm → Date', 'bc_pfm → bc_owner → Date'] });

  const panel = page.getByTestId('chart-failure');
  await expect(panel).toHaveAttribute('data-failure-kind', 'ambiguous_route');
  await expect(page.getByTestId('chart-failure-title')).toHaveText('Cannot tell which relationship to use to reach Date');
  // the headline and body are business language, not modelling jargon
  const headline = await panel.locator(':scope > div').first().innerText();
  const visibleWithoutDetails = headline.split('Details for the data modeller')[0];
  for (const jargon of ['Inactive', 'alias', 'role-playing', 'dataset_table_']) {
    expect(visibleWithoutDetails).not.toContain(jargon);
  }
  await expect(page.getByTestId('chart-failure-actions')).toBeVisible();
  // the competing paths are there for whoever models the data
  await page.getByTestId('chart-failure-details').locator('summary').click();
  await expect(page.getByTestId('chart-failure-routes')).toContainText('bc_pfm → bc_owner → Date');
  // the chip is not "healthy/joined" during a refusal
  await expect(chip(page)).toHaveClass(/warning/);
  await expect(chip(page)).not.toHaveClass(/success/);
  // no chart drawn for a question that has no single answer
  await expect(page.locator('.recharts-wrapper, canvas')).toHaveCount(0);

  // deterministic: the same refusal on every run
  const again = await run(page);
  expect(again.status()).toBe(400);
  expect((await again.json()).refusal).toEqual(body.refusal);
});

test('J6+J7: changing the base keeps the work; recommendation never re-roots; recover by field', async ({ page }) => {
  await newChartOnDataset(page);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickY(page, 'bc_pfm.revenue');
  await pickX(page, 'Date.month_label');
  expect((await run(page)).status()).toBe(400);

  // J7: the menu marks the model's recommendation; opening it changes nothing
  await chip(page).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId(`base-option-${FIX.tables.bc_pfm}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chip(page)).toHaveAttribute('data-base-table-id', String(FIX.tables.bc_pfm));

  // J6: an explicit base change keeps every binding the new base still reaches
  await chip(page).click();
  await page.getByTestId(`base-option-${FIX.tables.bc_activity}`).click();
  await expect(chip(page)).toHaveAttribute('data-base-table-id', String(FIX.tables.bc_activity));
  await expect(page.getByTestId('base-origin')).toHaveText('Chosen by you');
  await expect(page.getByTestId('base-measure-note')).toContainText('bc_pfm');
  const kept = await run(page);
  const cfg = kept.request().postDataJSON().config.generatedRoleConfig;
  expect(cfg.dimension).toBe(`${FIX.views.Date}.month_label`);
  expect(cfg.metrics.map((m: { field: string }) => m.field)).toEqual([`${FIX.views.bc_pfm}.revenue`]);
  expect(kept.status(), 'still genuinely ambiguous — and still refused').toBe(400);

  // recover by choosing an unambiguous field: the same chart now answers
  await pickX(page, 'bc_owner.owner_name');
  const ok = await run(page);
  expect(ok.status()).toBe(200);
  expect(ok.request().postDataJSON().dataset_table_id).toBe(FIX.tables.bc_activity);
  expect(rowsOf(await ok.json())).toEqual(['Ann=100', 'Bob=57']);
  await expect(page.getByTestId('chart-failure')).toHaveCount(0);
  await expect(chip(page)).not.toHaveClass(/warning/);
});

test('J4: a saved chart reopens on its saved base with its bindings', async ({ page }) => {
  const request = page.request;
  await newChartOnDataset(page);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickY(page, 'bc_pfm.revenue');
  await pickX(page, 'bc_owner.owner_name');
  expect((await run(page)).status()).toBe(200);
  const name = `E2E CH saved ${Date.now()}`;
  const nameBox = page.getByPlaceholder('Chart name...');
  if (!(await nameBox.isVisible())) await page.getByText('New Chart', { exact: true }).click();
  await nameBox.fill(name);
  await nameBox.press('Enter');
  const [created] = await Promise.all([
    page.waitForResponse((r) => /\/api\/v1\/charts\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(created.status(), await created.text()).toBeLessThan(300);
  const saved = await created.json();
  expect(saved.dataset_table_id).toBe(FIX.tables.bc_pfm);

  const [auto] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data')),
    page.goto(`/explore/${saved.id}`),
  ]);
  await expect(page.getByTestId('base-origin')).toHaveText('Saved with this chart');
  await expect(chip(page)).toHaveAttribute('data-base-table-id', String(FIX.tables.bc_pfm));
  expect(auto.request().postDataJSON().dataset_table_id).toBe(FIX.tables.bc_pfm);
  expect(rowsOf(await auto.json())).toEqual(['Ann=100', 'Bob=57']);
  await request.delete(`/api/v1/charts/${saved.id}`);
});

test('J8: the saved chart means the same in the dashboard, with and without a filter', async ({ page }) => {
  const request = page.request;
  const cid = FIX.saved_chart_id;
  const chart = await (await request.get(`/api/v1/charts/${cid}`)).json();
  const preview = await request.post(`/api/v1/charts/preview-data`, {
    data: { dataset_table_id: chart.dataset_table_id, chart_type: 'BAR', config: chart.config } });
  const saved = await request.get(`/api/v1/charts/${cid}/data?context=dashboard`);
  expect(rowsOf(await preview.json())).toEqual(['Ann=100', 'Bob=57']);
  expect(rowsOf(await saved.json())).toEqual(rowsOf(await preview.json()));
  const flt = encodeURIComponent(JSON.stringify([{ field: `${FIX.views.bc_owner}.owner_name`, operator: 'eq', value: 'Ann' }]));
  const filtered = await request.get(`/api/v1/charts/${cid}/data?context=dashboard&filters=${flt}`);
  expect(rowsOf(await filtered.json())).toEqual(['Ann=100']);

  const [tile] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/charts/${cid}/data`)),
    page.goto(`/dashboards/${FIX.dashboard_id}`),
  ]);
  expect(rowsOf(await tile.json())).toEqual(['Ann=100', 'Bob=57']);
  await expect(page.getByTestId('tile-failure')).toHaveCount(0);
});

test('J9: TABLE → KPI → BAR never keeps a hidden grouping', async ({ page }) => {
  await newChartOnDataset(page);
  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickY(page, 'bc_pfm.revenue');
  await pickX(page, 'bc_owner.owner_name');
  expect(rowsOf(await (await run(page)).json())).toEqual(['Ann=100', 'Bob=57']);

  await chooseType(page, 'Tables, cards, and goal visuals', 'KPI');
  const kpi = await run(page);
  expect(kpi.status()).toBe(200);
  const kpiCfg = kpi.request().postDataJSON().config.generatedRoleConfig;
  expect(kpiCfg.dimension ?? null).toBeNull();
  expect(rowsOf(await kpi.json())).toEqual(['∑=157']);

  await chooseType(page, 'Compare categories and rankings', 'Bar');
  await pickX(page, 'bc_owner.owner_name');
  expect(rowsOf(await (await run(page)).json())).toEqual(['Ann=100', 'Bob=57']);
});

test('J11: a saved percent_of_total is shown as such and survives Save unchanged', async ({ page }) => {
  // percent_of_total is valid and saveable but not offered as a choice; a chart
  // that carries it must not DISPLAY another aggregation (the dropdown used to
  // show SUM for it) nor lose it on Save.
  const cid = FIX.share_chart_id;
  const field = `${FIX.views.bc_pfm}.revenue`;
  const [auto] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data')),
    page.goto(`/explore/${cid}`),
  ]);
  expect(auto.status()).toBe(200);
  expect(auto.request().postDataJSON().config.generatedRoleConfig.metrics[0].agg).toBe('percent_of_total');
  const agg = page.getByTestId(`metric-agg-${field}`);
  await expect(agg).toHaveValue('percent_of_total');
  await expect(agg.locator('option:checked')).toHaveText('% OF TOTAL');

  const [put] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/charts/${cid}`) && r.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Update', exact: true }).click(),
  ]);
  expect(put.status(), await put.text()).toBe(200);
  expect(put.request().postDataJSON().config.generatedRoleConfig.metrics[0].agg).toBe('percent_of_total');
  expect((await put.json()).config.generatedRoleConfig.metrics[0].agg).toBe('percent_of_total');
});

test('J10: a reader and the public link never receive SQL or planner internals', async ({ page, browser }) => {
  const request = page.request;
  const cid = FIX.saved_chart_id;
  const owner = await (await request.get(`/api/v1/charts/${cid}/data`)).json();
  expect(owner.debug?.sql_emitted, 'the owner keeps the Query Inspector').toBeTruthy();

  // the reader's own session — never the admin page context
  const readerApi = await pwRequest.newContext({ baseURL: new URL(page.url() === 'about:blank' ? (process.env.E2E_BASE_URL || 'http://localhost:3000') : page.url()).origin });
  const login = await readerApi.post(`/api/v1/auth/login`, { data: { email: FIX.reader_email, password: READER_PASSWORD } });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).access_token;
  const asReader = await readerApi.get(`/api/v1/charts/${cid}/data`, { headers: { Authorization: `Bearer ${token}` } });
  expect(asReader.status()).toBe(200);
  const readerText = await asReader.text();
  const readerBody = JSON.parse(readerText);
  expect(rowsOf(readerBody)).toEqual(['Ann=100', 'Bob=57']);
  for (const k of ['sql_emitted', 'sql_emitted_per_group', 'routing', 'dialect']) {
    expect(readerBody.debug?.[k] ?? null, k).toBeNull();
  }
  expect(readerText).not.toMatch(/SELECT\s/i);
  expect(readerText).not.toContain('e2e_chart.');

  const pub = await readerApi.get(`/api/v1/public/dashboards/${FIX.link_token}/charts/${cid}/data`);
  expect(pub.status()).toBe(200);
  const pubText = await pub.text();
  expect(pubText).not.toMatch(/SELECT\s/i);
  expect(JSON.parse(pubText).debug?.sql_emitted ?? null).toBeNull();

  // the reader's own browser: the tile renders, the network carries no SQL
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const rp = await ctx.newPage();
  await rp.goto('/login');
  await rp.locator('input[type="email"]').fill(FIX.reader_email);
  await rp.locator('input[type="password"]').fill(READER_PASSWORD);
  await rp.locator('input[type="password"]').press('Enter');
  await rp.waitForURL((u) => !u.pathname.startsWith('/login'));
  const [tile] = await Promise.all([
    rp.waitForResponse((r) => r.url().includes(`/charts/${cid}/data`)),
    rp.goto(`/dashboards/${FIX.dashboard_id}`),
  ]);
  expect(tile.status()).toBe(200);
  expect(await tile.text()).not.toMatch(/SELECT\s/i);
  await ctx.close();
  await readerApi.dispose();
});
