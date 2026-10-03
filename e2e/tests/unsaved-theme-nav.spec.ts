import { expect, test } from '@playwright/test';
import { API } from './_helpers';

/**
 * APPBI-VERIFY-008 — an unsaved appearance/layout change must not vanish on
 * ordinary in-app navigation without warning.
 *
 * Reproduced: change the dashboard theme ("Save appearance" stages an Unsaved
 * change), click "Back to Dashboards" → the app navigated away silently and the
 * theme was lost. The fix guards the Back link (and beforeunload) with a confirm.
 *
 * Self-contained: creates its own throwaway dashboard through the real API.
 */
test('leaving the builder with an unsaved theme change asks first', async ({ page, request }) => {
  test.setTimeout(90_000);
  const res = await request.post(`${API}/api/v1/dashboards/`, {
    data: { name: `e2e unsaved theme ${Date.now()}`, pages_config: [{ id: 'p1', name: 'P1' }] },
  });
  expect(res.status(), await res.text()).toBeLessThan(400);
  const id = (await res.json()).id;

  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });

  // Open the theme panel (More options → Theme), pick a template, Save appearance.
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('button', { name: /Operational Dense|Finance Precision|Executive Command/ }).first().click();
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText(/Unsaved/).first()).toBeVisible({ timeout: 10_000 });

  // Navigating away must prompt. Dismiss → we stay on the dashboard.
  let dialogSeen = false;
  page.once('dialog', (d) => { dialogSeen = true; d.dismiss(); });
  await page.getByRole('link', { name: 'Back to Dashboards' }).click();
  await page.waitForTimeout(1500);
  expect(dialogSeen, 'a confirm dialog must appear before leaving with unsaved changes').toBe(true);
  await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));

  // cleanup
  await request.delete(`${API}/api/v1/dashboards/${id}`);
});
