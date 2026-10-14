import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';

/**
 * M2 Dataset construction — the Query Table "Validate SQL" button tells the
 * truth about an invalid query.
 *
 * Browser certification found: the validate endpoint answers 200 with
 * { valid:false, error } for a broken query, but the modal only reacted to a
 * thrown exception — so clicking "Validate SQL" on an invalid query did
 * NOTHING, and the user could not tell a good query from a bad one. This spec
 * drives the real button and asserts the database reason is shown.
 *
 * FIXTURE: seed_e2e_data_state.py (CI runs it) — a real PostgreSQL datasource
 * ("E2E data-state Postgres") and a dataset to open the Add-table modal from.
 */
async function datasetId(request: APIRequestContext, name: string): Promise<number> {
  const res = await request.get(`${API}/api/v1/datasets/`);
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  const rows: Array<{ id: number; name: string }> = Array.isArray(body) ? body : body.items ?? body.datasets ?? [];
  const found = rows.find((d) => d.name === name);
  expect(found, `fixture dataset "${name}" — run seed_e2e_data_state.py`).toBeTruthy();
  return found!.id;
}

test('an invalid Query Table SQL shows the database reason on Validate', async ({ page, request }) => {
  const id = await datasetId(request, 'E2E data-state live');
  await page.goto(`/datasets/${id}`);
  await page.getByRole('button', { name: 'Add' }).first().click();
  await page.getByRole('button', { name: 'From SQL Query' }).click();
  // The datasource <select> is the one that actually offers a Postgres source
  // (the page also has an unrelated "Rows:" select).
  const dsSelect = page.locator('select').filter({ has: page.locator('option', { hasText: /Postgres/i }) });
  const value = await dsSelect.locator('option', { hasText: /Postgres/i }).first().getAttribute('value');
  await dsSelect.selectOption(value!);
  const editor = page.locator('.cm-content, [contenteditable="true"], textarea').last();
  await editor.click();
  await editor.fill('SELECT nonexistent_col FROM orders');
  await page.getByRole('button', { name: 'Validate SQL' }).click();
  // The real database reason, not silence and not a generic "Preview failed".
  await expect(page.getByText(/does not exist/i)).toBeVisible({ timeout: 20_000 });
});
