import { expect, test, type Page } from '@playwright/test';
import {
  canon, collectTiles, DASH, dataQuiet, deleteTestPats, dropReport, freeze, freshReport, settle, V1, waitForTiles, type Fixture,
} from './_public-closure';

/**
 * Dashboard Public closure — the Public Links dialog as an author uses it.
 *
 * Preview contract (spec §1, PublicLinksManager): the preview shows the
 * PUBLISHED report with this link's UNSAVED settings — never unpublished
 * dashboard edits — through the real public runtime, and previewing creates
 * no listed link and publishes nothing.
 *
 * Lifecycle: password → session; changing the password, disabling and
 * re-enabling all end sessions issued before; expiry closes the link.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
const API_PUBLIC = `${process.env.E2E_API_URL || 'http://localhost:8000'}/api/v1/public/dashboards`;

/** Log in on the viewer's password form and return the session the server issued (FAILS if none). */
async function loginAndCapture(viewer: Page, token: string, password: string, label: string): Promise<string> {
  const answer = viewer.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/public/dashboards/${token}/auth`));
  await viewer.locator('input[type="password"]').fill(password);
  await viewer.locator('input[type="password"]').press('Enter');
  const res = await answer;
  expect(res.status(), `${label}: authentication failed`).toBe(200);
  const session = String((await res.json()).session_token ?? '');
  expect(session, `${label}: no session was issued`).toBeTruthy();
  return session;
}

async function openLinksDialog(page: Page, dashboardId: number) {
  await page.goto(`/dashboards/${dashboardId}`);
  await page.waitForSelector('[data-dashboard-canvas-root] [data-tile-id]', { timeout: 60_000 });
  await page.getByTestId('dashboard-more').click();
  await page.getByTestId('dashboard-open-public-links').click();
}

test.beforeAll(async ({ request }) => {
  f = await freshReport(request);
});

/** The rows one tile in the preview iframe is answered with, once a change has landed. */
async function previewRows(page: Page, tile: number, label: string, act: () => Promise<void>, differentFrom?: string) {
  const rows = collectTiles(page);
  await act();
  await expect.poll(() => {
    const r = rows.get(tile)?.rows;
    return r !== undefined && (differentFrom === undefined || r !== differentFrom);
  }, { message: `${label}: the preview never answered tile ${tile} with new data`, timeout: 60_000 }).toBe(true);
  await dataQuiet(page);
  return freeze(rows).get(tile)!.rows;
}

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('Preview frames the real published report with the unsaved link settings, on both surfaces, and saves nothing', async ({ page, request }) => {
  const before = await (await request.get(`${DASH}/${f!.id}/public-links`)).json();
  const publishedAt = (await (await request.get(`${DASH}/${f!.id}`)).json()).last_published_at;

  await openLinksDialog(page, f!.id);
  await page.getByTestId('public-link-new').click();
  await page.getByTestId('public-link-name').fill('closure preview');
  await page.getByTestId('public-link-headline').fill('Preview headline 7731');
  await expect(page.getByTestId('public-link-preview-title')).toContainText(/published report/i);

  // Public page surface: the real runtime, the draft headline, real tile data.
  const frame = page.frameLocator('[data-testid="public-link-preview-frame"]');
  await expect(page.getByTestId('public-link-preview-frame')).toHaveAttribute('src', /^\/d\//, { timeout: 30_000 });
  await expect(frame.locator('body')).toContainText('Preview headline 7731', { timeout: 60_000 });
  await expect(frame.locator('[data-tile-id]').first()).toBeVisible({ timeout: 60_000 });
  await expect(frame.locator('body')).toContainText(/\d/);

  // Embed surface.
  await page.getByTestId('public-link-preview-mode-embed').click();
  await expect(page.getByTestId('public-link-preview-frame')).toHaveAttribute('src', /^\/embed\//);
  await expect(frame.locator('[data-tile-id]').first()).toBeVisible({ timeout: 60_000 });

  // Leave without saving: no listed link, no publish.
  await page.keyboard.press('Escape');
  const after = await (await request.get(`${DASH}/${f!.id}/public-links`)).json();
  expect(after.length, 'previewing created a listed public link').toBe(before.length);
  const nowPublished = (await (await request.get(`${DASH}/${f!.id}`)).json()).last_published_at;
  expect(nowPublished, 'previewing published the report').toBe(publishedAt);
});

test('Preview applies an UNSAVED link filter to the data in the iframe, on /d and /embed, and saves nothing', async ({ page, request }) => {
  const before = await (await request.get(`${DASH}/${f!.id}/public-links`)).json();
  const publishedAt = (await (await request.get(`${DASH}/${f!.id}`)).json()).last_published_at;
  const revenue = f!.charts.find((c) => c.type === 'KPI')!;

  // What the report says for North only — the answer the preview must show.
  const expected = await request.get(`${V1}/charts/${revenue.chart}/data`, {
    params: { filters: JSON.stringify([{ field: 'region', operator: 'in', value: ['North'] }]) },
  });
  expect(expected.status(), await expected.text()).toBe(200);
  const northRows = canon((await expected.json()).data);

  await openLinksDialog(page, f!.id);
  const unfiltered = await previewRows(page, revenue.tile, 'preview before the filter', async () => {
    await page.getByTestId('public-link-new').click();
    await page.getByTestId('public-link-name').fill('closure filter preview');
  });

  // Lock the report's existing Region slicer to North — in the dialog, without saving.
  await page.getByTestId('public-link-tab-data').click();
  const row = page.getByTestId('public-link-filter-row-slicer-region');
  await expect(row, "the report's Region slicer is not offered in the link dialog").toBeVisible({ timeout: 30_000 });
  const filtered = await previewRows(page, revenue.tile, 'preview after the unsaved filter', async () => {
    await row.getByTestId('public-link-filter-action-lock').click();
    await row.getByTestId('public-link-filter-value').fill('North');
    await row.getByTestId('public-link-filter-value').press('Enter');
  }, unfiltered);
  expect(filtered, 'the unsaved filter did not change the preview').not.toBe(unfiltered);
  expect(filtered, 'the preview does not show the North-only numbers').toBe(northRows);

  // The embed surface previews the same scope.
  const embedRows = await previewRows(page, revenue.tile, 'embed preview', async () => {
    await page.getByTestId('public-link-preview-mode-embed').click();
    await expect(page.getByTestId('public-link-preview-frame')).toHaveAttribute('src', /^\/embed\//);
  });
  expect(embedRows, '/embed preview is not filtered like /d').toBe(northRows);

  // Nothing was saved or published.
  await page.keyboard.press('Escape');
  const after = await (await request.get(`${DASH}/${f!.id}/public-links`)).json();
  expect(after.length, 'previewing a filter created a listed public link').toBe(before.length);
  expect(after.some((l: any) => l.name === 'closure filter preview'), 'the unsaved link was persisted').toBe(false);
  const nowPublished = (await (await request.get(`${DASH}/${f!.id}`)).json()).last_published_at;
  expect(nowPublished, 'previewing published the report').toBe(publishedAt);
});

test('password, rotation, disable/re-enable and expiry — through the dialog and the public page', async ({ page, browser, request }) => {
  await openLinksDialog(page, f!.id);
  await page.getByTestId('public-link-new').click();
  await page.getByTestId('public-link-name').fill('closure secured');
  await page.getByTestId('public-link-tab-security').click();
  await page.getByTestId('public-link-password-require').click();
  await page.getByTestId('public-link-password').fill('first-pass-1');
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  await page.getByTestId('public-link-expires-at').fill(
    `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`);
  await page.getByTestId('public-link-create').click();
  await expect.poll(async () => (await (await request.get(`${DASH}/${f!.id}/public-links`)).json())
    .some((l: any) => l.name === 'closure secured')).toBe(true);
  const link = (await (await request.get(`${DASH}/${f!.id}/public-links`)).json()).find((l: any) => l.name === 'closure secured');
  expect(link.has_password).toBe(true);
  expect(link.expires_at, 'the expiry set in the dialog was not saved').toBeTruthy();

  // A viewer opens the link and authenticates.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/d/${link.token}`);
  await viewer.locator('input[type="password"]').fill('first-pass-1');
  await viewer.locator('input[type="password"]').press('Enter');
  const rows = collectTiles(viewer);
  await settle(viewer);
  await waitForTiles(rows, [f!.charts[0].tile], 'viewer after password');
  const oldSession = await viewer.evaluate((tok) => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      if (k.endsWith(tok)) return JSON.parse(sessionStorage.getItem(k) || '{}').sessionToken as string;
    }
    return '';
  }, link.token);
  expect(oldSession, 'the viewer holds no password session').toBeTruthy();
  expect((await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`, { headers: { 'X-Public-Session': oldSession } })).status()).toBe(200);

  // The author changes the password in the dialog: the viewer's session ends.
  await page.getByTestId(`public-link-row-${link.id}`).click();
  await page.getByTestId('public-link-tab-security').click();
  await page.getByTestId('public-link-password-change').click();
  await page.getByTestId('public-link-password').fill('second-pass-2');
  await page.getByTestId('public-link-save').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`,
    { headers: { 'X-Public-Session': oldSession } })).status(), { message: 'the old session survived a password change' }).toBe(401);
  await viewer.reload();
  await expect(viewer.locator('input[type="password"]')).toBeVisible({ timeout: 30_000 });
  // Capture the second session from the auth answer itself, the moment it is issued.
  const session2 = await loginAndCapture(viewer, link.token, 'second-pass-2', 'the new password');
  await expect(viewer.locator('[data-tile-id]').first()).toBeVisible({ timeout: 60_000 });
  expect((await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`, { headers: { 'X-Public-Session': session2 } })).status(),
    'the new session is not usable').toBe(200);

  // Disable in the dialog: session2 stops working (a disabled token is unknown: 404).
  await page.keyboard.press('Escape').catch(() => {});
  await openLinksDialog(page, f!.id);
  await page.getByTestId(`public-link-row-${link.id}`).getByTestId('public-link-toggle-active').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`,
    { headers: { 'X-Public-Session': session2 } })).status(), { message: 'session2 still reads a disabled link' }).toBe(404);
  await viewer.goto(`/d/${link.token}`);
  expect(await viewer.locator('[data-tile-id]').count(), 'a disabled link rendered tiles').toBe(0);
  await expect(viewer.locator('body')).toContainText(/revoked|not found|không tìm thấy|thu hồi/i);

  // Re-enable: the link is live again, but session2 — issued before the disable —
  // does NOT come back (active link + stale session = 401).
  await page.getByTestId(`public-link-row-${link.id}`).getByTestId('public-link-toggle-active').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`)).status(),
    { message: 'the link did not come back after re-enabling' }).not.toBe(404);
  expect((await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`, { headers: { 'X-Public-Session': session2 } })).status(),
    're-enabling revived session2, issued before the disable').toBe(401);
  await viewer.goto(`/d/${link.token}`);
  await expect(viewer.locator('input[type="password"]'), 're-enabling revived an old session in the browser').toBeVisible({ timeout: 30_000 });

  // A fresh login with the current password works.
  const session3 = await loginAndCapture(viewer, link.token, 'second-pass-2', 'a fresh login after re-enabling');
  expect(session3, 'the fresh login handed back the old session').not.toBe(session2);
  expect((await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`, { headers: { 'X-Public-Session': session3 } })).status(),
    'a fresh session after re-enabling is not usable').toBe(200);
  await expect(viewer.locator('[data-tile-id]').first()).toBeVisible({ timeout: 60_000 });

  // Expiry respected: move it into the past (dialog input accepts any time).
  await page.getByTestId(`public-link-row-${link.id}`).click();
  await page.getByTestId('public-link-tab-security').click();
  await page.getByTestId('public-link-expires-at').fill('2020-01-01T00:00');
  await page.getByTestId('public-link-save').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`)).status()).toBe(410);
  await viewerCtx.close();
});
