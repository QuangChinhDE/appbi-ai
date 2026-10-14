import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';
import { SCHEMA } from './_dataset';

/**
 * J7 — Dataset settings namespaces never erase each other.
 *
 * `Dataset.settings` holds one namespace per subsystem: snapshot_config (Sync &
 * Publish modal), model layout (canvas), calendar_dimension (Calendar). Enabling
 * or removing the Calendar used to rewrite the whole column and silently erase the
 * snapshot schedule / partition-cluster config and the canvas layout.
 *
 * Every namespace is read back through its OWN endpoint after every change.
 * Runs everywhere (no snapshot host needed). Creates and deletes its own dataset.
 */
const NAME = 'E2E settings isolation';

async function ok(res: any, code = 200) {
  expect(res.status(), await res.text()).toBeLessThan(300);
  return res.json().catch(() => ({}));
}

async function sourceId(request: APIRequestContext): Promise<number> {
  const body = await ok(await request.get(`${API}/api/v1/datasources/`));
  const rows: any[] = Array.isArray(body) ? body : body.items ?? [];
  const found = rows.find((d) => d.name === 'E2E dataset-lifecycle Postgres');
  expect(found, 'run seed_e2e_dataset_lifecycle.py').toBeTruthy();
  return found.id;
}

async function namespaces(request: APIRequestContext, id: number) {
  const snap = await ok(await request.get(`${API}/api/v1/datasets/${id}/snapshot-config`));
  const layout = await ok(await request.get(`${API}/api/v1/datasets/${id}/model/layout`));
  const ds = await ok(await request.get(`${API}/api/v1/datasets/${id}`));
  const products = snap.tables.find((t: any) => t.display_name === 'products');
  return {
    schedule: snap.schedule?.mode,
    cluster: products?.config?.cluster_fields ?? products?.config?.cluster ?? null,
    layout: layout.positions ?? layout,
    calendar: Boolean(ds.settings?.calendar_dimension?.enabled),
  };
}

test.describe('Dataset settings isolation', () => {
  let id = 0;

  test.afterAll(async ({ request }) => {
    if (id) await request.delete(`${API}/api/v1/datasets/${id}`);
  });

  test('J7 snapshot config, model layout and Calendar survive each other', async ({ page, request }) => {
    test.setTimeout(180_000);
    // a fresh dataset with one source table
    for (const old of (await ok(await request.get(`${API}/api/v1/datasets/`))) as any[]) {
      if (old.name === NAME) await request.delete(`${API}/api/v1/datasets/${old.id}`);
    }
    id = (await ok(await request.post(`${API}/api/v1/datasets/`, { data: { name: NAME } }))).id;
    await ok(await request.post(`${API}/api/v1/datasets/${id}/tables`, { data: {
      datasource_id: await sourceId(request), source_kind: 'physical_table',
      source_table_name: `${SCHEMA}.products`, display_name: 'products' } }), 201);

    // 1) snapshot config through the Sync & Publish modal (cluster by category)
    await page.goto(`/datasets/${id}`);
    await page.getByText('products', { exact: true }).first().click();       // first preview seeds the schema
    await expect(page.getByRole('columnheader', { name: /category/i }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^(Sync & Publish|Đồng bộ & Phát hành)$/ }).first().click();
    await page.getByRole('button', { name: /^\+\s*category$/ }).click();
    await page.getByRole('button', { name: /^(Save config|Lưu cấu hình)$/ }).click();
    await expect.poll(async () => (await namespaces(request, id)).cluster, { timeout: 20_000 })
      .toEqual(['category']);

    // 2) model layout (the canvas persists positions through this endpoint)
    const model = await ok(await request.get(`${API}/api/v1/datasets/${id}/model`));
    const viewId = String((model.views ?? model.semantic_views ?? [])[0]?.id ?? 'v');
    await ok(await request.put(`${API}/api/v1/datasets/${id}/model/layout`, { data: { [viewId]: { x: 120, y: 80 } } }));

    // 3) enable the Calendar through the UI
    await page.reload();
    await page.getByRole('button', { name: /^Calendar/ }).locator('xpath=..').getByRole('button', { name: /^(Add|Thêm)$/ }).click();
    await page.getByRole('button', { name: /^(Create Calendar|Tạo lịch)$/ }).click();
    await expect.poll(async () => (await namespaces(request, id)).calendar, { timeout: 30_000 }).toBe(true);

    let ns = await namespaces(request, id);
    expect(ns.cluster, 'enabling the Calendar kept the snapshot config').toEqual(['category']);
    expect(JSON.stringify(ns.layout), 'enabling the Calendar kept the model layout').toContain('"x":120');

    // 4) remove the Calendar (the page's own call) — the others still survive
    await ok(await request.put(`${API}/api/v1/datasets/${id}`, {
      data: { settings: { calendar_dimension: { enabled: false } } } }));
    ns = await namespaces(request, id);
    expect(ns.calendar).toBe(false);
    expect(ns.cluster, 'removing the Calendar kept the snapshot config').toEqual(['category']);
    expect(JSON.stringify(ns.layout), 'removing the Calendar kept the model layout').toContain('"x":120');

    // 5) and the page shows the persisted snapshot config after a reload (no stale UI)
    await page.reload();
    await page.getByRole('button', { name: /^(Sync & Publish|Đồng bộ & Phát hành)$/ }).first().click();
    await expect(page.getByRole('button', { name: /category/ }).first()).toBeVisible();
  });
});
