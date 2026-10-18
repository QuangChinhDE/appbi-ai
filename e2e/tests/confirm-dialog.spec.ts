import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Confirmation lifecycle, on the real dataset list (bulk delete). Every DELETE
 * is answered by the test (route.fulfill) — no dataset is ever deleted, and the
 * test decides whether the request succeeds or fails.
 *
 *  - Cancel / Escape send nothing; a click on the backdrop does not dismiss a
 *    destructive dialog.
 *  - the dialog names the objects it deletes and starts focus on Cancel;
 *  - confirm sends exactly ONE request, however fast the user double-clicks;
 *  - a failed delete keeps the dialog open with the error — no success toast;
 *  - a successful delete closes it.
 */

const DELETE_URL = /\/api\/v1\/datasets\/\d+$/;

async function openBulkDelete(page: Page) {
  await page.goto('/datasets');
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 60_000 });
  const box = firstRow.getByRole('checkbox');
  if (!(await box.isChecked())) await box.check();
  await page.getByTestId('bulk-delete').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

function answerDeletes(page: Page, status: number) {
  const seen: string[] = [];
  const handler = async (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    seen.push(route.request().url());
    // Slow enough that a double-click lands while the first request is in flight.
    await new Promise((r) => setTimeout(r, 600));
    if (status >= 400) {
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated failure (e2e)' }) });
    }
    return route.fulfill({ status: 204, body: '' });
  };
  return { seen, install: () => page.route(DELETE_URL, handler) };
}

test.describe('Confirm dialog lifecycle', () => {
  test('cancel, escape and the backdrop send nothing; focus starts on Cancel; the targets are named', async ({ page }) => {
    const deletes = answerDeletes(page, 204);
    await deletes.install();
    let dialog = await openBulkDelete(page);

    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByTestId('confirm-dialog-targets').locator('li').first()).not.toBeEmpty();
    await expect(dialog.getByTestId('confirm-dialog-cancel')).toBeFocused();

    await dialog.getByTestId('confirm-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);

    dialog = await openBulkDelete(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    dialog = await openBulkDelete(page);
    await page.mouse.click(5, 5); // the backdrop, outside the panel
    await expect(dialog, 'a destructive dialog does not close from the backdrop').toBeVisible();
    await dialog.getByTestId('confirm-dialog-cancel').click();

    expect(deletes.seen, 'cancel / escape / backdrop sent a delete').toEqual([]);
  });

  test('a failed delete: one request for a double-click, the dialog stays open with the error, no success', async ({ page }) => {
    const deletes = answerDeletes(page, 500);
    await deletes.install();
    const dialog = await openBulkDelete(page);
    const confirm = dialog.getByTestId('confirm-dialog-confirm');
    const before = await confirm.boundingBox();

    await confirm.dblclick();
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    const busy = await confirm.boundingBox();
    expect(Math.round(busy!.width), 'the loading button changed width').toBe(Math.round(before!.width));
    // Escape while the request is in flight does not abandon it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await expect(dialog.getByTestId('confirm-dialog-error')).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeVisible();
    expect(deletes.seen.length, `requests sent: ${deletes.seen.join(', ')}`).toBe(1);
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
    await expect(confirm).toBeEnabled();
  });

  test('a successful delete: one request, the dialog closes', async ({ page }) => {
    const deletes = answerDeletes(page, 204);
    await deletes.install();
    const dialog = await openBulkDelete(page);
    await dialog.getByTestId('confirm-dialog-confirm').click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    expect(deletes.seen.length).toBe(1);
  });
});
