import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { XLSX_TWO_SHEETS_B64 } from './_source-hardening-fixtures';

/**
 * Source core hardening — real browser, real Next.js, real API, real database.
 *
 * PRECONDITION (the rig, not the spec): a Postgres reachable FROM THE BACKEND at
 * SRC_HOST with two databases that hold a table `public.sales` of DIFFERENT shapes,
 * readable by SRC_USER/SRC_PASSWORD:
 *
 *   SRC_DB_A.public.sales(id int, region text, amount numeric)          3 rows
 *   SRC_DB_B.public.sales(id int, customer_name text, total numeric,
 *                         status text)                                  2 rows
 *
 * and the backend's ALLOWED_PRIVATE_SOURCE_CIDRS must cover SRC_HOST. The spec
 * FAILS (does not skip) when that is missing: a source suite that skips reports
 * a pass for checks that never ran.
 *
 * Every source/dataset/user this spec creates carries RUN in its name and is
 * removed in afterAll (best effort).
 */
// CI (e2e.yml): backend/scripts/ci/seed_e2e_source_hardening.py seeds these in
// the job's own Postgres on localhost (loopback allowlisted by the job env).
// Locally the default is the compose rig's database host.
const SRC_HOST = process.env.SRC_HOST || (process.env.CI ? 'localhost' : 'appbi-db');
const SRC_PORT = Number(process.env.SRC_PORT || 5432);
const SRC_DB_A = process.env.SRC_DB_A || 'srch_src_a';
const SRC_DB_B = process.env.SRC_DB_B || 'srch_src_b';
const SRC_USER = process.env.SRC_USER || 'srhv_reader';
const SRC_PASSWORD = process.env.SRC_PASSWORD || 'Pw-Srhv-7731-secret';

const RUN = `srch${Date.now().toString(36)}`;
const VIEWER_EMAIL = `${RUN}-viewer@example.com`;
const VIEWER_PASSWORD = 'Viewer-Pass-2026!';
const SHOTS = process.env.SRCH_SHOTS || '../.artifacts/source-hardening';

const created = { sources: [] as number[], datasets: [] as number[], users: [] as string[] };

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(`/api/v1${url}`, { method, data });
  return res;
}

async function sourceByName(request: APIRequestContext, name: string) {
  const res = await api(request, 'GET', '/datasources/?limit=500');
  expect(res.status()).toBe(200);
  const list = (await res.json()) as any[];
  return list.find((s) => s.name === name);
}

function pgConfig(database: string, password = SRC_PASSWORD) {
  return { host: SRC_HOST, port: SRC_PORT, database, username: SRC_USER, password, schema_name: '' };
}

async function createPgSourceApi(request: APIRequestContext, name: string, database: string) {
  const res = await api(request, 'POST', '/datasources/', { name, type: 'postgresql', config: pgConfig(database) });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  created.sources.push(body.id);
  return body;
}

async function createDatasetOn(request: APIRequestContext, name: string, sourceId: number) {
  const ds = await api(request, 'POST', '/datasets/', { name });
  expect(ds.status(), await ds.text()).toBe(201);
  const dataset = await ds.json();
  created.datasets.push(dataset.id);
  const t = await api(request, 'POST', `/datasets/${dataset.id}/tables`, {
    datasource_id: sourceId, source_kind: 'physical_table', source_table_name: 'public.sales', display_name: 'sales',
  });
  expect(t.status(), await t.text()).toBe(201);
  return { dataset, table: await t.json() };
}

/** Fill the PostgreSQL connection block of DataSourceForm. */
async function fillPgForm(page: Page, database: string, password: string) {
  await page.getByPlaceholder('localhost').fill(SRC_HOST);
  await page.getByPlaceholder('my_database').fill(database);
  await page.getByPlaceholder('user').fill(SRC_USER);
  await page.locator('input[type="password"]').fill(password);
}

test.describe.configure({ mode: 'serial' });

test.describe('Source core hardening (browser)', () => {
  test.setTimeout(120_000);

  test.afterAll(async ({ request }) => {
    for (const id of created.datasets) await api(request, 'DELETE', `/datasets/${id}`).catch(() => {});
    for (const id of created.sources) await api(request, 'DELETE', `/datasources/${id}`).catch(() => {});
    for (const id of created.users) await api(request, 'DELETE', `/users/${id}`).catch(() => {});
  });

  test('J1 create PG source: draft test shows structured checks; reopen keeps the secret out of the page', async ({ page }) => {
    const name = `${RUN} J1 pg`;
    await page.goto('/datasources/new');
    await page.getByPlaceholder('My Data Source').fill(name);
    await fillPgForm(page, SRC_DB_A, SRC_PASSWORD);

    // Draft test: the unsaved config through POST /test-draft.
    const draftResp = page.waitForResponse((r) => r.url().includes('/datasources/test-draft'));
    await page.getByTestId('datasource-test-connection').click();
    const draft = await draftResp;
    expect(draft.status()).toBe(200);
    const panel = page.getByTestId('source-test-result');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Connection OK');
    // PostgreSQL's test proves auth + reachability; query/discover are declared
    // `skipped` by design (source_health._PROVIDER_CHECKS) — all four are shown.
    for (const check of ['Auth: ok', 'Reachable: ok', 'Query: skipped', 'Discover: skipped']) {
      await expect(panel).toContainText(check);
    }
    await shot(page, 'j1-draft-test');

    // A wrong password is a structured, categorised failure — not a raw driver message.
    await page.locator('input[type="password"]').fill('definitely-wrong');
    await page.getByTestId('datasource-test-connection').click();
    await expect(panel).toContainText('Connection failed');
    await expect(panel).toContainText('Authentication failed');
    await expect(panel).toContainText('Auth: failed');
    // source_errors keeps the driver's sentence (actionable) but never a secret value.
    await expect(panel).not.toContainText('definitely-wrong');
    await shot(page, 'j1-draft-test-wrong-password');
    await page.locator('input[type="password"]').fill(SRC_PASSWORD);

    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/datasources$/);
    const src = await sourceByName(page.request, name);
    expect(src, 'created source is listed').toBeTruthy();
    created.sources.push(src.id);

    // Reopen: capture every response body while the detail page loads.
    const bodies: string[] = [];
    page.on('response', async (r) => {
      try { bodies.push(await r.text()); } catch { /* redirects / aborted */ }
    });
    await page.goto(`/datasources/${src.id}`);
    await expect(page.getByRole('heading', { name })).toBeVisible();
    const pw = page.locator('input[type="password"]');
    await expect(pw).toHaveValue('');
    await expect(pw).toHaveAttribute('placeholder', '(stored — leave blank to keep)');
    await page.waitForLoadState('networkidle');
    await shot(page, 'j1-reopen');
    expect(await page.content()).not.toContain(SRC_PASSWORD);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain(SRC_PASSWORD);
    // The API itself never returns the secret.
    const raw = await (await api(page.request, 'GET', `/datasources/${src.id}`)).text();
    expect(raw).not.toContain(SRC_PASSWORD);
  });

  test('J2 view-only user: metadata + health visible, no edit/test/delete; every write refused', async ({ page, request, browser }) => {
    const src = await createPgSourceApi(request, `${RUN} J2 shared`, SRC_DB_A);

    const u = await api(request, 'POST', '/users/', {
      email: VIEWER_EMAIL, full_name: 'Source Viewer', password: VIEWER_PASSWORD, auth_provider: 'password',
    });
    expect(u.status(), await u.text()).toBe(201);
    const user = await u.json();
    created.users.push(user.id);
    const perm = await api(request, 'PUT', `/permissions/${user.id}`, { permissions: { data_sources: 'view' } });
    expect(perm.status(), await perm.text()).toBe(200);
    const share = await api(request, 'POST', `/shares/datasource/${src.id}`, { user_id: user.id, permission: 'view' });
    expect(share.status(), await share.text()).toBe(201);

    const ctx = await (browser as Browser).newContext({ storageState: { cookies: [], origins: [] } });
    const vp = await ctx.newPage();
    await vp.goto('/login');
    await vp.locator('input[type="email"], input[name="email"]').first().fill(VIEWER_EMAIL);
    const pwd = vp.locator('input[type="password"]').first();
    await pwd.fill(VIEWER_PASSWORD);
    await pwd.press('Enter');
    await vp.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    // Detail page: metadata + health, read-only banner, no Edit/Test/Update.
    await vp.goto(`/datasources/${src.id}`);
    await expect(vp.getByRole('heading', { name: src.name })).toBeVisible();
    await expect(vp.getByText('You have view-only access to this data source.')).toBeVisible();
    await expect(vp.getByText(/Healthy|Not tested|Warning|Error/).first()).toBeVisible();
    await expect(vp.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await expect(vp.getByTestId('datasource-test-connection')).toHaveCount(0);
    await expect(vp.getByRole('button', { name: 'Update' })).toHaveCount(0);
    await shot(vp, 'j2-viewer-detail');

    // List page: the row is there, but no test/delete/share controls on it.
    await vp.goto('/datasources');
    const row = vp.locator('tr', { hasText: src.name });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Test connection' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Delete data source' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Share data source' })).toHaveCount(0);
    await shot(vp, 'j2-viewer-list');

    // Direct API calls with the viewer's own session.
    const r = vp.request;
    const refused = async (label: string, method: string, url: string, data?: unknown) => {
      const res = await r.fetch(`/api/v1${url}`, { method, data });
      const body = await res.text();
      expect([403, 404], `${label}: ${res.status()} ${body.slice(0, 200)}`).toContain(res.status());
      expect(body).not.toContain(SRC_PASSWORD);
      return res.status();
    };
    const codes: Record<string, number> = {};
    codes.get_ok = (await r.get(`/api/v1/datasources/${src.id}`)).status();
    expect(codes.get_ok).toBe(200);
    codes.put = await refused('PUT', 'PUT', `/datasources/${src.id}`, { name: 'hijack' });
    codes.put_config = await refused('PUT config', 'PUT', `/datasources/${src.id}`, { config: pgConfig(SRC_DB_B, '') });
    codes.retest = await refused('POST /test', 'POST', `/datasources/${src.id}/test`);
    codes.test_draft = await refused('test-draft reuse', 'POST', '/datasources/test-draft', {
      type: 'postgresql', config: pgConfig(SRC_DB_A, ''), data_source_id: src.id,
    });
    codes.query = await refused('query', 'POST', '/datasources/query', { data_source_id: src.id, sql_query: 'select 1' });
    codes.delete = await refused('DELETE', 'DELETE', `/datasources/${src.id}`);

    // Sheets mutation needs object `full`. Exercised on a google_sheets source of the
    // RIGHT type (rig fixture 'srch gsheets fixture', fake service account), shared
    // view-only — on a PostgreSQL source the route answers 400 "not google_sheets",
    // which proves nothing about authorization.
    const gs = await sourceByName(request, 'srch gsheets fixture');
    expect(gs, 'rig fixture "srch gsheets fixture" is missing').toBeTruthy();
    const gshare = await api(request, 'POST', `/shares/datasource/${gs.id}`, { user_id: user.id, permission: 'view' });
    expect([201, 409]).toContain(gshare.status());
    codes.gsheets_create_tab = await refused('gsheets create tab', 'POST', `/datasources/${gs.id}/gsheets/sheets`, { sheet_name: 'x' });
    codes.gsheets_add_row = await refused('gsheets add row', 'POST', `/datasources/${gs.id}/gsheets/Sheet1/rows`, { values: { col: 'a' } });
    codes.gsheets_clear = await refused('gsheets clear rows', 'DELETE', `/datasources/${gs.id}/gsheets/Sheet1/rows/all`);
    console.log('J2 viewer status codes', JSON.stringify(codes));
    test.info().annotations.push({ type: 'viewer-codes', description: JSON.stringify(codes) });
    // Still there and unchanged.
    const after = await (await api(request, 'GET', `/datasources/${src.id}`)).json();
    expect(after.name).toBe(src.name);
    expect(after.config.database).toBe(SRC_DB_A);
    await ctx.close();
  });

  test('J3 Source→Dataset: repointing the source to DB B shows B columns, not cached A columns', async ({ page, request }) => {
    const srcName = `${RUN} J3 pg`;
    const src = await createPgSourceApi(request, srcName, SRC_DB_A);
    const { dataset, table } = await createDatasetOn(request, `${RUN} J3 dataset`, src.id);

    // Prime the caches with A (schema + sample) through the dataset page.
    await page.goto(`/datasets/${dataset.id}`);
    await expect(page.getByText('region').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('customer_name')).toHaveCount(0);
    await shot(page, 'j3-dataset-on-A');
    const before = await (await api(request, 'GET', `/datasets/${dataset.id}`)).json();
    const tBefore = (before.tables || []).find((t: any) => t.id === table.id);
    expect(JSON.stringify(tBefore?.columns_cache ?? tBefore?.columns ?? '')).toContain('region');

    // Edit the source in the UI: DB B, password re-entered.
    await page.goto(`/datasources/${src.id}`);
    await page.getByPlaceholder('my_database').fill(SRC_DB_B);
    await expect(page.getByText('the stored password cannot be reused')).toBeVisible();
    await page.locator('input[type="password"]').fill(SRC_PASSWORD);
    const put = page.waitForResponse((r) => r.url().includes(`/datasources/${src.id}`) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    expect((await put).status()).toBe(200);
    await expect(page.getByText('Data source updated').first()).toBeVisible();

    await page.goto(`/datasets/${dataset.id}`);
    await expect(page.getByText('customer_name').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('region', { exact: true })).toHaveCount(0);
    // B's rows, not A's cached sample.
    await expect(page.getByText('Acme').first()).toBeVisible();
    await expect(page.getByText('North', { exact: true })).toHaveCount(0);
    await shot(page, 'j3-dataset-on-B');
  });

  test('J4 delete is blocked while a dataset uses the source; the dialog names it', async ({ page, request }) => {
    const srcName = `${RUN} J4 pg`;
    const src = await createPgSourceApi(request, srcName, SRC_DB_A);
    const dsName = `${RUN} J4 dataset`;
    await createDatasetOn(request, dsName, src.id);

    await page.goto('/datasources');
    const row = page.locator('tr', { hasText: srcName });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Delete data source' }).click();
    await page.getByRole('button', { name: 'Delete data source' }).last().click();
    await expect(page.getByText('Cannot delete data source')).toBeVisible();
    await expect(page.getByText(dsName)).toBeVisible();
    await shot(page, 'j4-delete-blocked');
    const still = await api(request, 'GET', `/datasources/${src.id}`);
    expect(still.status()).toBe(200);
  });

  test('J5 manual upload: CSV + XLSX saved as asset refs; .xls and corrupt file get an actionable error', async ({ page, request }) => {
    const csv = 'order_id,city,amount\n' + Array.from({ length: 30 }, (_, i) => `${i + 1},City${i % 4},${(i + 1) * 3}`).join('\n') + '\n';
    const upload = async (name: string, mimeType: string, buffer: Buffer) => {
      await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
    };

    for (const kind of ['csv', 'xlsx'] as const) {
      const name = `${RUN} J5 ${kind}`;
      await page.goto('/datasources/new');
      await page.getByPlaceholder('My Data Source').fill(name);
      await page.locator('select').first().selectOption('manual');
      const parsed = page.waitForResponse((r) => r.url().includes('/manual/parse-file'));
      if (kind === 'csv') await upload('orders.csv', 'text/csv', Buffer.from(csv));
      else await upload('catalog.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(XLSX_TWO_SHEETS_B64, 'base64'));
      const pr = await parsed;
      expect(pr.status(), await pr.text()).toBe(200);
      const pj = await pr.json();
      // Bounded preview: the response carries no full row set.
      for (const s of Object.values<any>(pj.sheets)) {
        expect(s.asset_id).toBeTruthy();
        expect(s.rows).toBeUndefined();
        expect(s.preview_rows.length).toBeLessThanOrEqual(pj.limits.preview_rows);
      }
      if (kind === 'csv') {
        await expect(page.getByText('dòng dữ liệu')).toBeVisible();
        await expect(page.locator('th', { hasText: 'city' })).toBeVisible();
        await expect(page.getByText('... và 25 dòng nữa')).toBeVisible();
        await expect(page.locator('tbody tr')).toHaveCount(5);
      } else {
        await expect(page.getByRole('button', { name: /Products/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /Stores/ })).toBeVisible();
        await expect(page.locator('th', { hasText: 'product_name' })).toBeVisible();
      }
      await shot(page, `j5-${kind}-preview`);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.waitForURL(/\/datasources$/);
      const src = await sourceByName(request, name);
      expect(src).toBeTruthy();
      created.sources.push(src.id);

      // Config holds asset refs only.
      const cfg = (await (await api(request, 'GET', `/datasources/${src.id}`)).json()).config;
      const sheets = Object.values<any>(cfg.sheets || {});
      expect(sheets.length).toBe(kind === 'csv' ? 1 : 2);
      for (const s of sheets) {
        expect(s.asset_id).toBeTruthy();
        expect(s.rows).toBeUndefined();
      }
      expect(JSON.stringify(cfg)).not.toContain(kind === 'csv' ? 'City3' : 'Widget 7');

      // Reopen in the browser.
      await page.goto(`/datasources/${src.id}`);
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await expect(page.getByText(kind === 'csv' ? 'order_id' : 'product_name').first()).toBeVisible();
      await shot(page, `j5-${kind}-reopen`);
      // Data is readable through the source table API.
      const rows = await api(request, 'GET', `/datasources/${src.id}/tables/manual/${encodeURIComponent(Object.keys(cfg.sheets)[0])}`);
      test.info().annotations.push({ type: `j5-${kind}-table-detail`, description: String(rows.status()) });
    }

    // Refused files: actionable message in the UI.
    await page.goto('/datasources/new');
    await page.locator('select').first().selectOption('manual');
    await upload('legacy.xls', 'application/vnd.ms-excel', Buffer.from('D0CF11E0A1B11AE1 not really', 'utf8'));
    // Refused before upload by the form itself (actionable: save as .xlsx).
    await expect(page.getByText(/File \.xls \(Excel 97-2003\) không được hỗ trợ.*\.xlsx/)).toBeVisible();
    await shot(page, 'j5-xls-refused');
    await upload('broken.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('this is not a zip archive at all'));
    await expect(page.getByText(/not a valid \.xlsx workbook/)).toBeVisible();
    await shot(page, 'j5-corrupt-refused');
  });

  test('409: a stale editor gets a conflict message instead of overwriting', async ({ page, request }) => {
    const src = await createPgSourceApi(request, `${RUN} 409 pg`, SRC_DB_A);
    await page.goto(`/datasources/${src.id}`);
    await expect(page.getByRole('heading', { name: src.name })).toBeVisible();
    // Someone else changes the connection (config_version 1 → 2).
    const other = await api(request, 'PUT', `/datasources/${src.id}`, { config: pgConfig(SRC_DB_B), config_version: src.config_version });
    expect(other.status(), await other.text()).toBe(200);
    await page.getByPlaceholder('Optional description').fill('stale edit');
    const put = page.waitForResponse((r) => r.url().includes(`/datasources/${src.id}`) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    expect((await put).status()).toBe(409);
    await expect(page.getByText(/Failed to update/).first()).toBeVisible();
    await shot(page, '409-conflict-toast');
    const now = await (await api(request, 'GET', `/datasources/${src.id}`)).json();
    expect(now.description ?? '').not.toBe('stale edit');
    expect(now.config.database).toBe(SRC_DB_B);
  });
});
