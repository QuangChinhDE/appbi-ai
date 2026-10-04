import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { API } from './_helpers';

/**
 * Final independent release verification — the high-risk contracts that the
 * candidate's own suite did not lock:
 *  - report-anchor lifecycle (no stale-anchor leak, fresh read, fixed PDF asOf);
 *  - next logical day changes the VISIBLE value, not only a header;
 *  - three-page public journey A→B→C→A with a delayed (out-of-order) response;
 *  - every meaningful Builder edit is guarded on leave (report details,
 *    pending Inspector content incl. a failed save).
 * Fixtures: backend/scripts/ci/seed_e2e_data_state.py.
 */

const utcDay = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function dashboardIdByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/dashboards/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.dashboards ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dashboard ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  return Number(found.id);
}

function tile(page: Page, title: string) {
  return page.locator('[data-grid-item-id]').filter({ hasText: title });
}

async function handleDialogWhile(page: Page, action: () => Promise<unknown>, decision: 'accept' | 'dismiss') {
  const dialogPromise = page.waitForEvent('dialog');
  await Promise.all([
    dialogPromise.then(dialog => (decision === 'accept' ? dialog.accept() : dialog.dismiss())),
    action(),
  ]);
}

// ── Relative-date anchor lifecycle ─────────────────────────────────────────

test('fixed public asOf stays immutable across A→B→C page reads', async ({ page }) => {
  test.setTimeout(120_000);
  const anchor = `${utcDay(0)}T12:00:00.000Z`;
  const seen: string[] = [];
  page.on('request', (req: Request) => {
    if (req.url().includes('/public/dashboards/e2e-closure-pdf/charts')) seen.push(req.headers()['x-appbi-as-of'] ?? '<none>');
  });
  await page.goto(`/d/e2e-closure-pdf?asOf=${encodeURIComponent(anchor)}`);
  await expect(tile(page, 'E2E PDF A Today')).toContainText('300', { timeout: 60_000 });
  await page.getByRole('button', { name: 'B — Nam Bộ' }).click();
  await expect(tile(page, 'E2E PDF B Today')).toContainText('70', { timeout: 60_000 });
  await page.getByRole('button', { name: 'C — Tổng cộng' }).click();
  await expect(tile(page, 'E2E PDF C Today')).toContainText('350', { timeout: 60_000 });
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(new Set(seen)).toEqual(new Set([anchor]));
});

test('next logical day changes the visible value (D-1 vs D)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`/d/e2e-closure-pdf?asOf=${encodeURIComponent(`${utcDay(-1)}T12:00:00.000Z`)}`);
  await expect(tile(page, 'E2E PDF A Today')).toContainText('11', { timeout: 60_000 });
  await expect(tile(page, 'E2E PDF A Today')).not.toContainText('300');
  await page.goto(`/d/e2e-closure-pdf?asOf=${encodeURIComponent(`${utcDay(0)}T12:00:00.000Z`)}`);
  await expect(tile(page, 'E2E PDF A Today')).toContainText('300', { timeout: 60_000 });
});

test('leaving a report clears its anchor; returning starts a fresh read', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await dashboardIdByName(request, 'E2E closure original 007');
  let phase: 'report' | 'away' = 'report';
  const reportAnchors: string[] = [];
  const leaked: string[] = [];
  page.on('request', (req: Request) => {
    if (!req.url().includes('/api/v1/')) return;
    const a = req.headers()['x-appbi-as-of'];
    if (phase === 'report' && a) reportAnchors.push(a);
    if (phase === 'away' && a) leaked.push(`${req.method()} ${req.url()}`);
  });

  await page.goto(`/dashboards/${id}`);
  await expect(tile(page, 'E2E 007 A Total')).toContainText('610', { timeout: 60_000 });
  expect(reportAnchors.length).toBeGreaterThan(0);
  const first = reportAnchors[0];
  expect(new Set(reportAnchors)).toEqual(new Set([first])); // one read, one anchor

  phase = 'away';
  await page.getByRole('link', { name: /Datasets/i }).first().click();
  await expect(page).toHaveURL(/\/datasets(?:\?|$)/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: /Explore/i }).first().click();
  await expect(page).toHaveURL(/\/explore/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  expect(leaked, 'requests after leaving the report must not carry its anchor').toEqual([]);

  phase = 'report';
  reportAnchors.length = 0;
  await page.goto(`/dashboards/${id}`);
  await expect(tile(page, 'E2E 007 A Total')).toContainText('610', { timeout: 60_000 });
  expect(reportAnchors.length).toBeGreaterThan(0);
  expect(reportAnchors[0]).not.toBe(first);
});

// ── Public three-page journey with an out-of-order response ────────────────

test('public A→B→C→A keeps page scope and a delayed old response never overwrites', async ({ page }) => {
  test.setTimeout(150_000);
  // Delay page B's chart reads so the user is already on C when they land.
  await page.route('**/public/dashboards/e2e-closure-007/charts/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"South"')) await new Promise(r => setTimeout(r, 4_000));
    await route.continue();
  });
  await page.goto('/d/e2e-closure-007');
  await expect(tile(page, 'E2E 007 A Total')).toContainText('610', { timeout: 60_000 });

  await page.getByRole('button', { name: 'B South' }).click();
  await page.getByRole('button', { name: 'C All' }).click();
  await expect(tile(page, 'E2E 007 C Total')).toContainText('685', { timeout: 60_000 });
  await page.waitForTimeout(5_000); // let the delayed page-B response arrive
  await expect(tile(page, 'E2E 007 C Total')).toContainText('685');
  await expect(tile(page, 'E2E 007 B Total')).toHaveCount(0);

  await page.getByRole('button', { name: 'B South' }).click();
  await expect(tile(page, 'E2E 007 B Total')).toContainText('95', { timeout: 60_000 });
  await expect(tile(page, 'E2E 007 B Detail')).not.toContainText('North');

  await page.getByRole('button', { name: 'A North' }).click();
  await expect(tile(page, 'E2E 007 A Total')).toContainText('610', { timeout: 60_000 });
  await expect(tile(page, 'E2E 007 A Detail')).not.toContainText('South');
  // Public viewer never shows Builder chrome.
  await expect(page.getByTestId('dashboard-save-draft')).toHaveCount(0);
  await expect(page.getByTestId('inspector-toggle')).toHaveCount(0);
});

// ── Builder: every meaningful edit is guarded on leave ─────────────────────

async function createDashboard(request: APIRequestContext, suffix: string) {
  const res = await request.post(`${API}/api/v1/dashboards/`, {
    data: { name: `e2e verify ${suffix} ${Date.now()}`, pages_config: [{ id: 'p1', name: 'P1' }] },
  });
  expect(res.status(), await res.text()).toBeLessThan(400);
  return (await res.json()).id as number;
}

test('dirty Inspector report name is guarded; cancel keeps the text', async ({ page, request }) => {
  test.setTimeout(90_000);
  const id = await createDashboard(request, 'report-meta');
  try {
    await page.goto(`/dashboards/${id}`);
    await page.getByTestId('inspector-toggle').click();
    const name = page.getByTestId('inspector-report-name');
    await name.fill('Renamed but not saved');

    await handleDialogWhile(page, () => page.getByRole('link', { name: /Datasets/i }).first().click(), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(name).toHaveValue('Renamed but not saved');

    // Saving it clears the guard: a clean leave asks nothing.
    await page.getByTestId('inspector-report-save').click();
    await expect(page.getByTestId('inspector-report-save')).toBeDisabled({ timeout: 15_000 });
    let dialogs = 0;
    page.on('dialog', d => { dialogs += 1; void d.dismiss(); });
    await page.getByRole('link', { name: /Datasets/i }).first().click();
    await expect(page).toHaveURL(/\/datasets(?:\?|$)/, { timeout: 15_000 });
    expect(dialogs).toBe(0);
  } finally {
    await request.delete(`${API}/api/v1/dashboards/${id}`);
  }
});

test('pending Inspector content is saved before leaving; a failed save keeps the user', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await createDashboard(request, 'content');
  try {
    const added = await request.post(`${API}/api/v1/dashboards/${id}/widgets`, {
      data: { widget_type: 'text', widget_config: { text: 'Original' }, layout: { x: 0, y: 0, w: 12, h: 6, pageId: 'p1' } },
    });
    expect(added.status(), await added.text()).toBeLessThan(400);
    const dash = await added.json();
    const widgetId = (dash.dashboard_charts ?? []).find((dc: any) => dc.widget_type === 'text')?.id as number;
    expect(widgetId, 'text widget created').toBeTruthy();

    await page.goto(`/dashboards/${id}`);
    await page.locator(`[data-grid-item-id="${widgetId}"]`).click();
    await page.getByTestId('inspector-toggle').click().catch(() => {});
    const field = page.getByTestId('report-inspector').locator('textarea, input[type="text"]').first();
    await expect(field).toBeVisible({ timeout: 15_000 });

    // 1) Failure: the widget save is rejected → user stays (no silent loss).
    await page.route(`**/api/v1/dashboards/${id}/widgets/${widgetId}*`, route =>
      route.request().method() === 'GET' ? route.continue() : route.fulfill({ status: 500, body: '{"detail":"boom"}' }));
    await field.fill('Edited — failing save');
    await handleDialogWhile(page, () => page.getByRole('link', { name: /Datasets/i }).first().click(), 'dismiss');
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(field).toHaveValue('Edited — failing save');

    // 2) Success: the edit is flushed BEFORE the leave and is in the draft.
    await page.unroute(`**/api/v1/dashboards/${id}/widgets/${widgetId}*`);
    await field.fill('Edited — saved on leave');
    await page.getByRole('link', { name: /Datasets/i }).first().click();
    await expect(page).toHaveURL(/\/datasets(?:\?|$)/, { timeout: 15_000 });
    await expect.poll(async () => {
      const a = await (await request.get(`${API}/api/v1/dashboards/${id}`)).text();
      const b = await (await request.get(`${API}/api/v1/dashboards/${id}?draft=true`)).text();
      return a + b;
    }, { timeout: 15_000 }).toContain('Edited — saved on leave');
  } finally {
    await request.delete(`${API}/api/v1/dashboards/${id}`);
  }
});
