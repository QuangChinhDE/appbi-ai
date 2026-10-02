import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';

/**
 * Pair #5 data-state contracts, on the RENDERED page.
 *
 * Browser certification found these broken while every API test was green: a
 * live number re-served from the result cache looked current; Observability
 * read "healthy" for a dataset whose semantic model the Kernel refuses; a
 * failed Sync & Publish hid that the last published data still serves. Each
 * test below is the user-visible contract, against a real API and database.
 *
 * FIXTURE: `backend/scripts/ci/seed_e2e_data_state.py` (CI runs it) — a real
 * PostgreSQL source in its own schema, datasets / models / charts made by the
 * product's services. Nothing is route-mocked.
 *
 * NOT COVERED HERE: a SUCCESSFUL Sync & Publish and its recovery need a
 * writable BigQuery snapshot host, which CI does not have (certified manually
 * on a sandbox host; see docs/features/semantic-pair5-data-state/closure.md).
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

test.describe('Pair #5 data state', () => {
  test('a live result re-served from the cache says when it was read', async ({ page }) => {
    // The contract is about AGE: a cached read older than a minute is labelled
    // with its read time; it is never presented as the source right now.
    test.setTimeout(180_000);
    await page.goto('/d/e2e-data-state-live');
    await expect(page.getByText('E2E live ratio by region').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(65_000);
    await page.reload();
    const badge = page.getByTestId('tile-cached-as-of');
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await expect(badge).toHaveAttribute('data-as-of', /Z$/);
    await expect(badge).toHaveAttribute('title', /cache|đệm/i);
  });

  test('a dataset whose model names a missing column is never healthy', async ({ page, request }) => {
    const id = await datasetId(request, 'E2E data-state semantic invalid');
    await page.goto('/observability');
    const health = page.getByTestId(`obs-health-${id}`);
    await expect(health).toHaveAttribute('data-health', 'semantic_invalid', { timeout: 30_000 });
    const reason = page.getByTestId(`obs-semantic-${id}`);
    await expect(reason).toBeVisible();
    await expect(reason).toHaveAttribute('title', /ghost/);
  });

  test('a failed publish says the last published data keeps serving, and why it failed', async ({ page, request }) => {
    const id = await datasetId(request, 'E2E data-state failed publish');
    await page.goto(`/datasets/${id}`);
    await expect(page.getByText(/keep serving the last published data|vẫn phục vụ dữ liệu đã phát hành gần nhất/))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/column "b" does not exist/).first()).toBeVisible();
  });

  test('a chart over a relation that cannot be built refuses with the cause', async ({ page }) => {
    await page.goto('/d/e2e-data-state-broken');
    await expect(page.getByText(/column "b" does not exist/).first()).toBeVisible({ timeout: 30_000 });
  });
});
