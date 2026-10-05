import { expect, test, type Page } from '@playwright/test';
import { collectTiles, DASH, dropReport, freshReport, settle, waitForTiles, type Fixture } from './_public-closure';

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

async function openLinksDialog(page: Page, dashboardId: number) {
  await page.goto(`/dashboards/${dashboardId}`);
  await page.waitForSelector('[data-dashboard-canvas-root] [data-tile-id]', { timeout: 60_000 });
  await page.getByTestId('dashboard-more').click();
  await page.getByTestId('dashboard-open-public-links').click();
}

test.beforeAll(async ({ request }) => {
  f = await freshReport(request);
});

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
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
  await viewer.locator('input[type="password"]').fill('second-pass-2');
  await viewer.locator('input[type="password"]').press('Enter');
  await expect(viewer.locator('[data-tile-id]').first()).toBeVisible({ timeout: 60_000 });

  // Disable in the dialog: the viewer is refused.
  await page.keyboard.press('Escape').catch(() => {});
  await openLinksDialog(page, f!.id);
  await page.getByTestId(`public-link-row-${link.id}`).getByTestId('public-link-toggle-active').click();
  await expect.poll(async () => (await viewer.goto(`/d/${link.token}`).then(() => viewer.locator('[data-tile-id]').count()))).toBe(0);
  await expect(viewer.locator('body')).toContainText(/revoked|not found|không tìm thấy|thu hồi/i);

  // Re-enable: the session issued before the disable does NOT come back.
  const beforeDisable = await viewer.evaluate((tok) => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      if (k.endsWith(tok)) return JSON.parse(sessionStorage.getItem(k) || '{}').sessionToken as string;
    }
    return '';
  }, link.token);
  await page.getByTestId(`public-link-row-${link.id}`).getByTestId('public-link-toggle-active').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`)).status()).not.toBe(404);
  if (beforeDisable) {
    expect((await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`, { headers: { 'X-Public-Session': beforeDisable } })).status(),
      're-enabling revived a session issued before the disable').toBe(401);
  }
  await viewer.goto(`/d/${link.token}`);
  await expect(viewer.locator('input[type="password"]'), 're-enabling revived an old session').toBeVisible({ timeout: 30_000 });

  // Expiry respected: move it into the past (dialog input accepts any time).
  await page.getByTestId(`public-link-row-${link.id}`).click();
  await page.getByTestId('public-link-tab-security').click();
  await page.getByTestId('public-link-expires-at').fill('2020-01-01T00:00');
  await page.getByTestId('public-link-save').click();
  await expect.poll(async () => (await request.get(`${API_PUBLIC}/${link.token}/snapshots/info`)).status()).toBe(410);
  await viewerCtx.close();
});
