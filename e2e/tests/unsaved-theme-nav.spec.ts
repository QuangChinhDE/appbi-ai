import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';

/** APPBI-VERIFY-008 / closure R2 — every ordinary editor exit shares one guard. */

async function createDashboard(request: APIRequestContext, suffix: string) {
  const res = await request.post(`${API}/api/v1/dashboards/`, {
    data: { name: `e2e unsaved ${suffix} ${Date.now()}`, pages_config: [{ id: 'p1', name: 'P1' }] },
  });
  expect(res.status(), await res.text()).toBeLessThan(400);
  return (await res.json()).id as number;
}

async function openDashboard(page: Page, id: number) {
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
}

async function makeThemeDirty(page: Page) {
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('button', { name: /Operational Dense|Finance Precision|Executive Command/ }).first().click();
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.locator('button[data-state="unsaved"]')).toBeVisible({ timeout: 10_000 });
}

async function handleDialogWhile(
  page: Page,
  action: () => Promise<unknown>,
  decision: 'accept' | 'dismiss',
) {
  const dialogPromise = page.waitForEvent('dialog');
  await Promise.all([
    dialogPromise.then(dialog => decision === 'accept' ? dialog.accept() : dialog.dismiss()),
    action(),
  ]);
}

async function dashboardByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/dashboards/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.dashboards ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dashboard ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  return Number(found.id);
}

test('dirty layout sidebar navigation prompts and cancel preserves the edit', async ({ page, request }) => {
  test.setTimeout(90_000);
  const id = await dashboardByName(request, 'E2E closure original 007');
  await openDashboard(page, id);

  const tile = page.locator('[data-grid-item-id]').filter({ hasText: 'E2E 007 A Total' });
  await expect(tile).toBeVisible({ timeout: 30_000 });
  const resize = tile.locator('.react-resizable-handle-se');
  await expect(resize).toBeVisible();
  const box = await resize.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 45, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'unsaved', { timeout: 15_000 });

  await handleDialogWhile(page, () => page.getByRole('link', { name: /Datasets/i }).click(), 'dismiss');
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'unsaved');
});

test('dirty sidebar navigation prompts, cancel preserves work, accept leaves', async ({ page, request }) => {
  test.setTimeout(90_000);
  const id = await createDashboard(request, 'sidebar');
  try {
    await openDashboard(page, id);
    await makeThemeDirty(page);

    await handleDialogWhile(page, () => page.getByRole('link', { name: /Datasets/i }).click(), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(page.locator('button[data-state="unsaved"]')).toBeVisible();

    await handleDialogWhile(page, () => page.getByRole('link', { name: /Explore/i }).click(), 'accept');
    await expect(page).toHaveURL(/\/explore(?:\?|$)/, { timeout: 15_000 });
  } finally {
    await request.delete(`${API}/api/v1/dashboards/${id}`);
  }
});

test('header Back, browser Back and reload protect dirty presentation state', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await createDashboard(request, 'history');
  try {
    await page.goto('/dashboards');
    await openDashboard(page, id);
    await makeThemeDirty(page);

    await handleDialogWhile(page, () => page.getByRole('link', { name: 'Back to Dashboards' }).click(), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));

    await handleDialogWhile(page, () => page.goBack({ waitUntil: 'commit' }).catch(() => null), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(page.locator('button[data-state="unsaved"]')).toBeVisible();

    await handleDialogWhile(page, () => page.reload({ waitUntil: 'commit' }).catch(() => null), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(page.locator('button[data-state="unsaved"]')).toBeVisible();

    await handleDialogWhile(page, () => page.goBack({ waitUntil: 'commit' }).catch(() => null), 'accept');
    await expect(page).toHaveURL(/\/dashboards(?:\?|$)/, { timeout: 15_000 });
  } finally {
    await request.delete(`${API}/api/v1/dashboards/${id}`);
  }
});

test('successful Save draft and Publish clear the guard for sidebar and Dashboard A-to-B', async ({ page, request }) => {
  test.setTimeout(120_000);
  const firstId = await createDashboard(request, 'saved');
  const secondId = await createDashboard(request, 'target');
  try {
    await openDashboard(page, firstId);
    await makeThemeDirty(page);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button[data-state="unsaved"]')).toHaveCount(0);

    let unexpectedDialogs = 0;
    page.on('dialog', async dialog => { unexpectedDialogs += 1; await dialog.dismiss(); });
    await page.getByRole('link', { name: /Datasets/i }).click();
    await expect(page).toHaveURL(/\/datasets(?:\?|$)/, { timeout: 15_000 });
    expect(unexpectedDialogs).toBe(0);

    await openDashboard(page, firstId);
    await makeThemeDirty(page);
    await page.getByRole('button', { name: 'Save & publish' }).click();
    await expect(page.getByText(/Published — public link now serves/)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('button[data-state="unsaved"]')).toHaveCount(0);

    // Dashboard cards use this direct same-origin route shape. A dedicated link
    // isolates the leave contract from unrelated list ordering.
    await page.evaluate((targetId) => {
      const link = document.createElement('a');
      link.href = `/dashboards/${targetId}`;
      link.textContent = 'Open target dashboard';
      link.setAttribute('data-testid', 'target-dashboard-link');
      document.body.appendChild(link);
    }, secondId);
    await page.getByTestId('target-dashboard-link').click();
    await expect(page).toHaveURL(new RegExp(`/dashboards/${secondId}`), { timeout: 15_000 });
    expect(unexpectedDialogs).toBe(0);
  } finally {
    await request.delete(`${API}/api/v1/dashboards/${firstId}`);
    await request.delete(`${API}/api/v1/dashboards/${secondId}`);
  }
});

test('failed Save draft and Publish keep the dirty leave guard active', async ({ page, request }) => {
  test.setTimeout(90_000);
  const id = await createDashboard(request, 'failed-save');
  await openDashboard(page, id);
  await makeThemeDirty(page);

  // Remove the backing resource after the editor is loaded. Both actions now
  // reach the real API and fail honestly; neither may clear the local edit.
  const removed = await request.delete(`${API}/api/v1/dashboards/${id}`);
  expect(removed.status()).toBe(204);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'unsaved');
  await page.getByRole('button', { name: 'Save & publish' }).click();
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'unsaved');

  await handleDialogWhile(page, () => page.getByRole('link', { name: /Datasets/i }).click(), 'dismiss');
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
  await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'unsaved');
});
