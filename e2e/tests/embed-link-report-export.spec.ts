import { expect, test } from '@playwright/test';
import { DASH, deleteTestPats, dropReport, freshReport, type Fixture } from './_public-closure';

/**
 * A stable public link opened as /embed/<link.token> offers report export
 * (PDF / PowerPoint) only when its author turned on `allow_report_export` in
 * the link's viewer controls. The `emb_` grant path is covered by the backend
 * suite; this is the link the author copies from Dashboard → Public links.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let f: Fixture | null = null;

test.afterAll(async ({ request }) => {
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('a public link embed shows report export only when the link allows it, and the export runs', async ({ page, request }) => {
  f = await freshReport(request);
  const links = await (await request.get(`${DASH}/${f.id}/public-links`)).json();
  const link = (links as any[]).find((l) => l.token === f!.token);
  expect(link, 'the fixture link').toBeTruthy();

  // Default: no report export on /embed.
  await page.goto(`/embed/${f.token}`);
  await expect(page.locator('[data-tile-id], [data-export-state]').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('public-export-open')).toHaveCount(0);

  // The author turns it on for this link.
  const patch = await request.patch(`${DASH}/${f.id}/public-links/${link.id}`, {
    data: { appearance_config: { allow_report_export: true } },
  });
  expect(patch.status(), await patch.text()).toBeLessThan(400);

  await page.goto(`/embed/${f.token}`);
  const open = page.getByTestId('public-export-open').first();
  await expect(open).toBeVisible({ timeout: 60_000 });
  await open.click();
  await page.getByTestId('export-filetype-pptx').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pptx$/);
});
