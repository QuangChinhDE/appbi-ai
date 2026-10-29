import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';
import { SCHEMA } from './_dataset';

/**
 * F4 — two editors on the same semantic view cannot silently overwrite each other.
 *
 * Two browser sessions open the same measure. A saves first. B's save quotes the
 * version B loaded, so it is REFUSED (409 view_stale) with a visible message — A's
 * edit stays on the server and B's typed text stays in B's editor. B reloads (sees
 * A's edit), re-applies its own change and saves on top of the new version.
 *
 * Runs everywhere (no snapshot host needed). Creates and deletes its own dataset.
 */
const NAME = 'E2E concurrent model edit';
const MEASURE_LABEL = 'Units in stock';
const MEANING = /Tổng giá trị giao dịch/;

async function ok(res: any) {
  expect(res.status(), await res.text()).toBeLessThan(300);
  return res.json().catch(() => ({}));
}

async function sourceId(request: APIRequestContext): Promise<number> {
  const body = await ok(await request.get(`${API}/api/v1/datasources/`));
  return (Array.isArray(body) ? body : body.items).find((d: any) => d.name === 'E2E dataset-lifecycle Postgres').id;
}

async function storedMeaning(request: APIRequestContext, id: number, viewId: number): Promise<string | undefined> {
  const model = await ok(await request.get(`${API}/api/v1/datasets/${id}/model`));
  const view = (model.views ?? []).find((v: any) => v.id === viewId);
  return (view?.measures ?? []).find((m: any) => m.name === 'units')?.description;
}

async function openMeasure(page: Page, id: number) {
  await page.goto(`/datasets/${id}`);
  await page.getByRole('button', { name: new RegExp(`^${MEASURE_LABEL}$`) }).first().click();
  const meaning = page.getByPlaceholder(MEANING).first();
  await expect(meaning).toHaveValue('seeded meaning', { timeout: 30_000 });
  return meaning;
}

test.describe('Dataset model concurrent edit', () => {
  let id = 0;
  test.afterAll(async ({ request }) => { if (id) await request.delete(`${API}/api/v1/datasets/${id}`); });

  test('F4 a second save over a newer edit is refused visibly and both edits survive', async ({ browser, request }) => {
    test.setTimeout(240_000);
    for (const d of (await ok(await request.get(`${API}/api/v1/datasets/`))) as any[]) {
      if (d.name === NAME) await request.delete(`${API}/api/v1/datasets/${d.id}`);
    }
    id = (await ok(await request.post(`${API}/api/v1/datasets/`, { data: { name: NAME } }))).id;
    const table = await ok(await request.post(`${API}/api/v1/datasets/${id}/tables`, { data: {
      datasource_id: await sourceId(request), source_kind: 'physical_table',
      source_table_name: `${SCHEMA}.products`, display_name: 'products' } }));

    const a = await browser.newContext({ storageState: '.auth/admin.json', viewport: { width: 1440, height: 900 } });
    const b = await browser.newContext({ storageState: '.auth/admin.json', viewport: { width: 1440, height: 900 } });
    try {
      const pageA = await a.newPage();
      const pageB = await b.newPage();

      await pageA.goto(`/datasets/${id}`);                              // first preview seeds the schema
      await pageA.getByText(/^products$/).first().click();
      await expect(pageA.getByRole('columnheader', { name: /qty/i }).first()).toBeVisible({ timeout: 30_000 });
      await ok(await request.post(`${API}/api/v1/datasets/${id}/generate-model`));
      const model = await ok(await request.get(`${API}/api/v1/datasets/${id}/model`));
      const view = (model.views ?? []).find((v: any) => v.dataset_table_id === table.id);
      expect(view?.view_version, 'GET model exposes the view version').toBeTruthy();
      await ok(await request.put(`${API}/api/v1/datasets/${id}/model/views/${view.id}`, { data: {
        measures: [...(view.measures ?? []).filter((m: any) => m.name !== 'units'),
          { name: 'units', label: MEASURE_LABEL, type: 'sum', sql: 'qty', description: 'seeded meaning' }] } }));

      // Both sessions load the same version of the view.
      const meaningA = await openMeasure(pageA, id);
      const meaningB = await openMeasure(pageB, id);

      // A saves first.
      await meaningA.fill('edit from A');
      await pageA.getByRole('button', { name: /^Save$/ }).click();
      await expect.poll(() => storedMeaning(request, id, view.id), { timeout: 20_000 }).toBe('edit from A');

      // B saves from its stale read: refused, visibly; nothing overwritten; B's text kept.
      await meaningB.fill('edit from B');
      await pageB.getByRole('button', { name: /^Save$/ }).click();
      const banner = pageB.getByTestId('model-view-stale-banner');
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText(/someone else changed|người khác đã thay đổi/);
      expect(await storedMeaning(request, id, view.id), 'A\'s edit was not overwritten').toBe('edit from A');
      await expect(meaningB).toHaveValue('edit from B');

      // Reload shows A's edit; B's change is still offered for re-applying.
      await pageB.getByTestId('model-view-stale-reload').click();
      await expect(meaningB).toHaveValue('edit from A', { timeout: 20_000 });
      await pageB.getByTestId('model-view-stale-reapply').click();
      await expect(meaningB).toHaveValue('edit from B');
      await expect(banner).toHaveCount(0);

      // B's save now quotes the reloaded version and goes through.
      await pageB.getByRole('button', { name: /^Save$/ }).click();
      await expect.poll(() => storedMeaning(request, id, view.id), { timeout: 20_000 }).toBe('edit from B');
      await expect(banner).toHaveCount(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
