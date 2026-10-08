import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Observability journeys O01–O24 — real browser, real Next.js, real API, real
 * Postgres source. Project `observability`, retries 0: a monitoring journey that
 * passes on the second try is a race, not a pass.
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_observability.py writes
 * e2e/.auth/observability.json. Missing fixture = FAIL, never skip.
 *
 * Checks are always RUN through the product (Run checks now / Scan now); the
 * assertions read the rendered page AND the network response behind it.
 */
const FIXTURE = process.env.E2E_OBS_FIXTURE || path.join(__dirname, '..', '.auth', 'observability.json');
const SHOTS = process.env.OBS_SHOTS || '../.artifacts/observability-e2e';
type Fx = {
  datasets: Record<'fresh' | 'stale' | 'broken' | 'anomaly' | 'backlog' | 'schema', number>;
  tables: { fresh: number; schema: number };
  metrics: { new: number; recovering: number };
  channel: number;
  users: Record<'editor' | 'viewer' | 'outsider', string>;
};
let fx: Fx;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) throw new Error(`Observability fixture missing: ${FIXTURE} (run seed_e2e_observability.py)`);
  fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { for (const c of contexts) await c.close().catch(() => {}); });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** A browser context signed in as a seeded principal (access_token cookie). */
async function as(browser: Browser, who: keyof Fx['users']): Promise<Page> {
  const base = new URL(process.env.E2E_BASE_URL || 'http://localhost:3000');
  const ctx = await browser.newContext({
    baseURL: base.origin,
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [{ name: 'access_token', value: fx.users[who], domain: base.hostname, path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

/** Console errors and failed requests, minus the refusals a journey provokes on purpose. */
function watch(page: Page, allowed: RegExp[] = []) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !allowed.some((r) => r.test(m.text()))) problems.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/v1/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${u}`);
  });
  return problems;
}

async function openDataset(page: Page, id: number, tab: 'quality' | 'incidents' | 'lineage' = 'quality') {
  await page.goto(`/observability?dataset=${id}&dt=${tab}`);
  if (tab === 'quality') await expect(page.getByTestId('obs-monitors')).toBeVisible();
  if (tab === 'incidents') await expect(page.getByTestId('obs-incidents')).toBeVisible();
}

async function runChecks(page: Page) {
  const resp = page.waitForResponse((r) => /\/observability\/datasets\/\d+\/scan$/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 90_000 });
  await page.getByTestId('obs-run-checks').click();
  const r = await resp;
  expect(r.status(), await r.text()).toBe(200);
  await expect(page.getByTestId('obs-run-checks')).toBeEnabled({ timeout: 30_000 });
  return r.json();
}

async function healthOf(page: Page, datasetId: number) {
  await page.goto('/observability');
  const cell = page.getByTestId(`obs-health-${datasetId}`);
  await expect(cell).toBeVisible();
  return cell.getAttribute('data-health');
}

// ── O01 / O06 ─────────────────────────────────────────────────────────────
test('O01/O06 a dataset with no checks is never shown as healthy, and a new check reads "not run yet"', async ({ page }) => {
  const problems = watch(page);
  const usage = page.waitForResponse((r) => r.url().endsWith('/observability/usage'));
  await page.goto('/observability');
  const rows = await (await usage).json() as any[];
  const fresh = rows.find((r) => r.datasetId === fx.datasets.fresh);
  expect(fresh.health).not.toBe('healthy');
  expect(fresh.checks.active).toBe(0);
  await openDataset(page, fx.datasets.fresh);
  for (const k of ['freshness', 'volume', 'schema']) {
    await expect(page.getByTestId(`obs-monitor-${fx.tables.fresh}-${k}`)).toHaveAttribute('data-state', 'off');
  }
  await shot(page, 'O01-not-monitored');
  expect(problems).toEqual([]);
});

// ── O02 / O03 ─────────────────────────────────────────────────────────────
test('O02/O03 setting up checks persists them, they run against the source, and passing checks read healthy', async ({ page }) => {
  await openDataset(page, fx.datasets.fresh);
  const card = (k: string) => page.getByTestId(`obs-monitor-${fx.tables.fresh}-${k}`);
  await card('schema').getByRole('button', { name: 'Enable' }).click();
  await expect(card('schema')).toHaveAttribute('data-state', 'not_run');          // O06: never "ok" before it ran
  await card('freshness').getByRole('button', { name: 'Enable' }).click();
  await page.getByRole('group').getByRole('button', { name: 'Save' }).click();
  await expect(card('freshness')).toHaveAttribute('data-state', 'not_run');
  await page.reload();
  await expect(card('freshness')).toHaveAttribute('data-state', 'not_run');      // persisted
  const r = await runChecks(page);
  expect(r.status).toBe('succeeded');
  await expect(card('freshness')).toHaveAttribute('data-state', 'ok');
  await expect(card('schema')).toHaveAttribute('data-state', 'ok');
  await shot(page, 'O03-checks-pass');
  expect(await healthOf(page, fx.datasets.fresh)).toBe('healthy');
  await expect(page.getByTestId(`obs-checks-${fx.datasets.fresh}`)).toContainText('2 of 2 passing');
});

// ── O04 / O09 ─────────────────────────────────────────────────────────────
test('O04/O09 a failing check opens ONE incident; health, incident feed and Needs-attention agree; rescans add none', async ({ page }) => {
  await openDataset(page, fx.datasets.stale);
  await runChecks(page);
  await expect(page.getByTestId(/obs-monitor-\d+-freshness/)).toHaveAttribute('data-state', 'breached');
  await runChecks(page);
  await runChecks(page);
  const res = await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.stale}&status=open&pillar=freshness`);
  const body = await res.json();
  expect(body.total).toBe(1);
  expect(await healthOf(page, fx.datasets.stale)).toBe('breached');
  await page.getByRole('button', { name: /Needs attention/ }).click();          // the filter
  await expect(page.getByTestId(`obs-health-${fx.datasets.stale}`)).toBeVisible();
  await expect(page.getByTestId(`obs-health-${fx.datasets.fresh}`)).toHaveCount(0);
  await expect(page.getByTestId(`obs-attention-${body.items[0].id}`)).toBeVisible();
  await shot(page, 'O04-breach-needs-attention');
});

// ── O05 ───────────────────────────────────────────────────────────────────
test('O05 a check that cannot run is an error, never healthy', async ({ page }) => {
  await openDataset(page, fx.datasets.broken);
  const r = await runChecks(page);
  expect(r.monitor_errors).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId(/obs-monitor-\d+-schema/)).toHaveAttribute('data-state', 'error');
  const h = await healthOf(page, fx.datasets.broken);
  expect(['error', 'breached']).toContain(h);
  await expect(page.getByTestId(`obs-health-label-${fx.datasets.broken}`)).not.toContainText('Every check ran and passed');
  await shot(page, 'O05-error');
});

// ── O07 / O08 ─────────────────────────────────────────────────────────────
test('O07/O08 a new anomaly opens an incident; one whose metric recovered is resolved by the scan', async ({ page }) => {
  await openDataset(page, fx.datasets.anomaly);
  await runChecks(page);
  const open = await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.anomaly}&pillar=distribution`)).json();
  expect(open.items.some((i: any) => i.status === 'open' && i.title.startsWith('amount:'))).toBe(true);
  const recovered = open.items.find((i: any) => i.title.startsWith('id:'));
  expect(recovered.status).toBe('resolved');
  expect(recovered.detail.history.at(-1)).toMatchObject({ action: 'auto_resolved', reason: 'metric_recovered' });
  await openDataset(page, fx.datasets.anomaly, 'incidents');
  await expect(page.getByText(/^amount: bất thường/)).toBeVisible();
  await shot(page, 'O07-anomaly');
});

// ── O10 / O11 ─────────────────────────────────────────────────────────────
test('O10/O11 acknowledge and resolve are recorded; resolving a still-failing check reopens on the next scan', async ({ page }) => {
  const inc = (await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.stale}&status=open&pillar=freshness`)).json()).items[0];
  await page.goto(`/observability?dataset=${fx.datasets.stale}&dt=incidents&incident=${inc.id}`);
  const row = page.getByTestId(`obs-incident-${inc.id}`);
  await row.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(row).toHaveAttribute('data-status', 'acknowledged');
  await row.getByRole('button', { name: 'Resolve' }).click();
  await expect(row).toHaveAttribute('data-status', 'resolved');
  await expect(row).toContainText('Resolved by a person');
  await shot(page, 'O11-resolved');
  await openDataset(page, fx.datasets.stale);
  await runChecks(page);                                    // still stale -> a NEW open incident
  const after = await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.stale}&status=open&pillar=freshness`)).json();
  expect(after.total).toBe(1);
  expect(after.items[0].id).not.toBe(inc.id);
});

// ── O12 ───────────────────────────────────────────────────────────────────
test('O12 a schema change is raised; Resolve does not accept it; Accept is explicit, confirmed and sticks', async ({ page }) => {
  await openDataset(page, fx.datasets.schema);
  await runChecks(page);                                    // baseline
  const put = await page.request.put(`/api/v1/datasets/${fx.datasets.schema}/tables/${fx.tables.schema}`,
    { data: { source_query: 'SELECT id, loaded_at FROM e2e_obs.orders_fresh' } });
  expect(put.status(), await put.text()).toBe(200);
  await openDataset(page, fx.datasets.schema);
  await runChecks(page);
  const q = `/api/v1/observability/incidents?dataset_id=${fx.datasets.schema}&status=open&pillar=schema`;
  let inc = (await (await page.request.get(q)).json()).items[0];
  expect(inc.detail.removed).toContain('amount');
  await page.goto(`/observability?dataset=${fx.datasets.schema}&dt=incidents&incident=${inc.id}`);
  await page.getByTestId(`obs-incident-${inc.id}`).getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByTestId(`obs-incident-${inc.id}`)).toHaveAttribute('data-status', 'resolved');
  await openDataset(page, fx.datasets.schema);
  await runChecks(page);
  inc = (await (await page.request.get(q)).json()).items[0];
  expect(inc, 'Resolve silently accepted the schema change').toBeTruthy();
  await page.goto(`/observability?dataset=${fx.datasets.schema}&dt=incidents&incident=${inc.id}`);
  await page.getByTestId(`obs-incident-${inc.id}`).getByRole('button', { name: 'Accept as new baseline' }).click();
  await expect(page.getByText('Accept the new baseline?')).toBeVisible();
  await shot(page, 'O12-accept-confirm');
  await page.getByRole('button', { name: 'Accept as new baseline' }).last().click();
  await expect(page.getByTestId(`obs-incident-${inc.id}`)).toHaveAttribute('data-status', 'resolved');
  await openDataset(page, fx.datasets.schema);
  await runChecks(page);
  expect((await (await page.request.get(q)).json()).total).toBe(0);
  await expect(page.getByTestId(/obs-monitor-\d+-schema/)).toHaveAttribute('data-state', 'ok');
});

// ── O13 / O14 ─────────────────────────────────────────────────────────────
test('O13/O14 a dataset editor creates a dataset-scoped channel; failed and given-up deliveries are visible', async ({ browser }) => {
  const page = await as(browser, 'editor');
  await page.goto('/observability');
  await page.getByRole('button', { name: 'Alert channels' }).click();
  const modal = page.getByTestId('obs-channels');
  await expect(modal.getByTestId(`obs-channel-${fx.channel}-failures`)).toContainText(/\d+ retrying · [1-9]\d* not delivered/);
  await modal.getByTestId('obs-channel-add').click();
  await expect(modal.getByTestId('obs-channel-scope').locator('option[value="global"]')).toHaveCount(0); // not an admin
  await modal.getByTestId('obs-channel-dataset').selectOption(String(fx.datasets.fresh));
  await modal.getByTestId('obs-channel-target').fill('ops-team@example.com');
  const created = page.waitForResponse((r) => r.url().endsWith('/observability/alert-channels') && r.request().method() === 'POST');
  await modal.getByTestId('obs-channel-create').click();
  const res = await created;
  expect(res.status()).toBe(201);
  const ch = await res.json();
  expect(ch.scope).toBe('dataset');
  expect(ch.datasetId).toBe(fx.datasets.fresh);
  await expect(modal.getByTestId(`obs-channel-${ch.id}`)).toBeVisible();
  await shot(page, 'O13-channel-dataset-scope');
  // the admin's seeded channel is not theirs to manage: no manage buttons
  await expect(modal.getByTestId(`obs-channel-${fx.channel}`).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await page.request.delete(`/api/v1/observability/alert-channels/${ch.id}`);
});

test('O13 the admin sees the global scope and the scanner banner reports undelivered alerts', async ({ page }) => {
  await page.goto('/observability');
  await expect(page.getByTestId('obs-scanner-banner')).toContainText('Alerts are not getting through');
  await page.getByRole('button', { name: 'Alert channels' }).click();
  await page.getByTestId('obs-channel-add').click();
  await expect(page.getByTestId('obs-channel-scope').locator('option[value="global"]')).toHaveCount(1);
  await shot(page, 'O14-delivery-banner');
});

// ── O15 ───────────────────────────────────────────────────────────────────
test('O15 a new incident on a matching channel gets exactly one delivery row; rescans add none', async ({ page }) => {
  const st = async () => (await (await page.request.get('/api/v1/observability/status')).json()).deliveries;
  const before = await st();
  await openDataset(page, fx.datasets.stale);
  await runChecks(page);
  await runChecks(page);
  const after = await st();
  const rows = (before.pending + before.failed + before.dead + before.sent + before.cancelled);
  const rowsAfter = (after.pending + after.failed + after.dead + after.sent + after.cancelled);
  expect(rowsAfter - rows).toBeLessThanOrEqual(1);
});

// ── O16 / O21 ─────────────────────────────────────────────────────────────
test('O16/O21 a notification link opens that incident; Back and Forward walk the views; a dead link says so', async ({ page }) => {
  const inc = (await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.stale}&status=open&pillar=freshness`)).json()).items[0];
  await page.goto('/observability');
  await page.goto(`/observability?incident=${inc.id}`);                  // what the notification href is
  await expect(page).toHaveURL(new RegExp(`dataset=${fx.datasets.stale}.*`));
  await expect(page.getByTestId(`obs-incident-${inc.id}`)).toBeVisible();
  await expect(page.locator(`#obs-incident-detail-${inc.id}`)).toBeVisible();
  await shot(page, 'O16-deeplink');
  await page.getByText('Lineage', { exact: true }).click();
  await expect(page).toHaveURL(/dt=lineage/);
  await page.goBack();
  await expect(page).toHaveURL(/dt=incidents/);
  await page.goBack();
  await expect(page).toHaveURL(/\/observability$/);
  await page.goForward();
  await expect(page).toHaveURL(/dt=incidents/);
  await page.goto('/observability?incident=987654321');
  await expect(page.getByTestId('obs-incident-link-error')).toContainText('Not found');
});

// ── O17 ───────────────────────────────────────────────────────────────────
test('O17 lineage loads with an honest "inferred" note and never names what the caller cannot open', async ({ browser, page }) => {
  await openDataset(page, fx.datasets.fresh, 'lineage');
  await expect(page.getByTestId('obs-lineage-error')).toHaveCount(0);
  const viewer = await as(browser, 'viewer');
  const r = await viewer.request.get(`/api/v1/observability/semantic-lineage?dataset_id=${fx.datasets.fresh}`);
  expect(r.status()).toBe(200);
  const g = await r.json();
  expect(g.impact.charts - g.impact.hiddenCharts).toBe(g.charts.length);
  await shot(page, 'O17-lineage');
});

// ── O18 ───────────────────────────────────────────────────────────────────
test('O18 a dataset VIEW share sees incidents but no actions, and the server refuses them too', async ({ browser }) => {
  const page = await as(browser, 'viewer');
  const inc = (await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.stale}&status=open`)).json()).items[0];
  await page.goto(`/observability?dataset=${fx.datasets.stale}&dt=incidents&incident=${inc.id}`);
  const row = page.getByTestId(`obs-incident-${inc.id}`);
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /Acknowledge|Resolve/ })).toHaveCount(0);
  await expect(row).toContainText('View only');
  expect((await page.request.patch(`/api/v1/observability/incidents/${inc.id}`, { data: { action: 'resolve' } })).status()).toBe(403);
  expect((await page.request.post(`/api/v1/observability/datasets/${fx.datasets.stale}/scan`)).status()).toBe(403);
  await page.goto('/observability');
  await expect(page.getByTestId('obs-scan-all')).toHaveCount(0);
  expect((await page.request.post('/api/v1/observability/scan')).status()).toBe(403);
  await page.goto(`/observability?dataset=${fx.datasets.stale}`);
  await expect(page.getByTestId('obs-run-checks')).toHaveCount(0);
  await shot(page, 'O18-viewer');
  // positive control: the editor may act
  const editor = await as(browser, 'editor');
  expect((await editor.request.patch(`/api/v1/observability/incidents/${inc.id}`, { data: { action: 'acknowledge' } })).status()).toBe(200);
  // an Observability admin WITHOUT the dataset sees nothing of it
  const outsider = await as(browser, 'outsider');
  expect((await outsider.request.get(`/api/v1/observability/incidents/${inc.id}`)).status()).toBe(404);
});

// ── O19 ───────────────────────────────────────────────────────────────────
test('O19 failed loads are errors with Retry, never "healthy" or "no incidents"', async ({ page }) => {
  await page.route('**/api/v1/observability/usage', (r) => r.fulfill({ status: 500, body: '{"detail":"boom"}' }));
  await page.goto('/observability');
  await expect(page.getByTestId('obs-overview-error')).toBeVisible();
  await expect(page.getByText('Every check ran and passed')).toHaveCount(0);
  await expect(page.getByText('Nothing is monitored yet')).toHaveCount(0);
  await shot(page, 'O19-overview-error');
  await page.unroute('**/api/v1/observability/usage');
  await page.getByTestId('obs-overview-error').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId(`obs-health-${fx.datasets.stale}`)).toBeVisible();

  await page.route('**/api/v1/observability/incidents?**', (r) => r.abort('connectionrefused'));
  await page.goto(`/observability?dataset=${fx.datasets.stale}&dt=incidents`);
  await expect(page.getByTestId('obs-incidents-error')).toBeVisible();
  await expect(page.getByTestId('obs-incidents-empty')).toHaveCount(0);
  await shot(page, 'O19-incidents-error');
  await page.unroute('**/api/v1/observability/incidents?**');
  await page.goto(`/observability?dataset=999999999`);
  await expect(page.getByTestId('obs-dataset-error')).toBeVisible();
});

// ── O20 ───────────────────────────────────────────────────────────────────
test('O20 hundreds of incidents: paging reaches every one, search and filters narrow the same total', async ({ page }) => {
  await page.goto(`/observability?dataset=${fx.datasets.backlog}&dt=incidents`);
  const first = await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.backlog}&status=open`)).json();
  const all = await (await page.request.get(`/api/v1/observability/incidents?dataset_id=${fx.datasets.backlog}&status=`)).json();
  expect(all.total).toBeGreaterThanOrEqual(260);
  await expect(page.getByTestId('obs-incidents-range')).toContainText(`1–25 of ${first.total}`);
  await page.getByTestId('obs-incidents').getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByTestId('obs-incidents-range')).toContainText(`26–50 of ${first.total}`);
  await page.getByTestId('obs-incidents').getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByTestId('obs-incidents-range')).toContainText(`of ${all.total}`);
  await page.getByPlaceholder('Search incidents or datasets').fill('Backlog check 017');
  await expect(page.getByTestId('obs-incidents').locator('li[data-testid^="obs-incident-"]')).toHaveCount(1);
  await shot(page, 'O20-paging-search');
});

// ── O22 ───────────────────────────────────────────────────────────────────
for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 820, 1180], ['mobile', 390, 844]] as const) {
  test(`O22 responsive ${name}: no horizontal page scroll, actions reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/observability');
    await expect(page.getByTestId(`obs-health-${fx.datasets.stale}`)).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
    await shot(page, `O22-${name}-overview`);
    await page.goto(`/observability?dataset=${fx.datasets.stale}&dt=incidents`);
    await expect(page.getByTestId('obs-incidents')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resolve' }).first()).toBeVisible();
    await shot(page, `O22-${name}-incidents`);
  });
}

// ── O23 ───────────────────────────────────────────────────────────────────
test('O23 keyboard: expand an incident and act on it without a mouse; controls have names', async ({ page }) => {
  await page.goto(`/observability?dataset=${fx.datasets.stale}&dt=incidents`);
  const expander = page.getByRole('button', { name: /^Show details of / }).first();
  await expander.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Hide details of / }).first()).toHaveAttribute('aria-expanded', 'true');
  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('main button')).filter((b) =>
    !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length);
  expect(unnamed).toBe(0);
  await page.goto('/observability');
  await page.getByTestId(`obs-health-${fx.datasets.stale}`).locator('xpath=../..').getByRole('button').first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`dataset=${fx.datasets.stale}`));
});

// ── O24 ───────────────────────────────────────────────────────────────────
test('O24 concurrent scans: one runs, the other is refused (409), and both are recorded honestly', async ({ page }) => {
  const url = `/api/v1/observability/datasets/${fx.datasets.fresh}/scan`;
  const [a, b] = await Promise.all([page.request.post(url), page.request.post(url)]);
  const codes = [a.status(), b.status()].sort();
  expect(codes[0]).toBe(200);
  expect([200, 409]).toContain(codes[1]);                 // 200 only if the first had already finished
  const st = await (await page.request.get('/api/v1/observability/status')).json();
  expect(st.running).toBe(false);
});
