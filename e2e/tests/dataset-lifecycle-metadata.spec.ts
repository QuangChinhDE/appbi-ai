import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';
import { SCHEMA } from './_dataset';

/**
 * J9 — Dictionary / Quality / metadata on a real dataset.
 *
 *   * a dictionary note persists and is shown back in the UI after a reload;
 *   * a note for a column the table no longer has stays STORED (the author can
 *     repair it) but never reaches the AI context;
 *   * a manual quality run honours the overlap guard (a second click while one is
 *     queued/running is refused, not a second full scan).
 *
 * Runs everywhere (no snapshot host needed). Creates and deletes its own dataset.
 */
const NAME = 'E2E metadata journey';

async function ok(res: any) {
  expect(res.status(), await res.text()).toBeLessThan(300);
  return res.json().catch(() => ({}));
}

async function sourceId(request: APIRequestContext): Promise<number> {
  const body = await ok(await request.get(`${API}/api/v1/datasources/`));
  return (Array.isArray(body) ? body : body.items).find((d: any) => d.name === 'E2E dataset-lifecycle Postgres').id;
}

test.describe('Dataset metadata', () => {
  let id = 0;
  test.afterAll(async ({ request }) => { if (id) await request.delete(`${API}/api/v1/datasets/${id}`); });

  test('J9 dictionary persists and follows the schema; quality runs do not overlap', async ({ page, request }) => {
    test.setTimeout(180_000);
    for (const d of (await ok(await request.get(`${API}/api/v1/datasets/`))) as any[]) {
      if (d.name === NAME) await request.delete(`${API}/api/v1/datasets/${d.id}`);
    }
    id = (await ok(await request.post(`${API}/api/v1/datasets/`, { data: { name: NAME } }))).id;
    const table = await ok(await request.post(`${API}/api/v1/datasets/${id}/tables`, { data: {
      datasource_id: await sourceId(request), source_kind: 'physical_table',
      source_table_name: `${SCHEMA}.products`, display_name: 'products' } }));
    await page.goto(`/datasets/${id}`);                                   // first preview seeds the schema
    await page.getByText(/^products$/).first().click();
    await expect(page.getByRole('columnheader', { name: /price/i }).first()).toBeVisible({ timeout: 30_000 });
    await ok(await request.post(`${API}/api/v1/datasets/${id}/generate-model`));

    // dictionary: one note on a real column, one on a column the table does not have
    await ok(await request.put(`${API}/api/v1/datasets/${id}/dictionary`, { data: {
      overview: 'Product catalogue', table_notes: [{ table_id: table.id, owner_note: 'one row per SKU',
        column_notes: [{ column_name: 'price', description: 'list price in VND' },
                       { column_name: 'discount_pct', description: 'GHOST COLUMN MEANING' }] }] } }));
    const dict = await ok(await request.get(`${API}/api/v1/datasets/${id}/dictionary`));
    expect(JSON.stringify(dict.dictionary)).toContain('GHOST COLUMN MEANING');          // stored for repair
    expect(dict.compiled_context).toContain('list price in VND');
    expect(dict.compiled_context, 'AI context never describes a missing column').not.toContain('GHOST');

    // …and the UI shows the persisted note after a reload
    await page.goto(`/datasets/${id}?tab=model`);
    await page.getByRole('button', { name: /^(Dictionary|Từ điển)$/ }).click();
    await expect.poll(async () => page.locator('textarea').evaluateAll(
      (els) => els.map((e) => (e as HTMLTextAreaElement).value)), { timeout: 30_000 })
      .toContain('list price in VND');
    await expect(page.getByText(/Dictionary Modal (Title|Desc)/)).toHaveCount(0);      // no raw i18n keys

    // quality: a manual run while another is queued/running is refused (409), not doubled
    const first = await request.post(`${API}/api/v1/datasets/${id}/quality/runs`);
    expect(first.status(), await first.text()).toBeLessThan(300);
    const second = await request.post(`${API}/api/v1/datasets/${id}/quality/runs`);
    const runs = await ok(await request.get(`${API}/api/v1/datasets/${id}/quality/runs`));
    const active = (Array.isArray(runs) ? runs : runs.items ?? []).filter((r: any) => ['queued', 'running'].includes(r.status));
    if (second.status() < 300) {
      // only acceptable when the first run had ALREADY finished (no rules → instant)
      expect(active.length, 'never two concurrent runs').toBeLessThanOrEqual(1);
    } else {
      expect(second.status()).toBe(409);
    }
  });
});
