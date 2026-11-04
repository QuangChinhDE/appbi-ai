/**
 * /dashboards is ONE report list: Build Manual and AI Vibe Report differ only in how a report
 * is built. Selection and bulk delete are one mechanism for both:
 * - a row is selected by its KEY (a dashboard and a Vibe Report can share a numeric id; selecting
 *   one must never select - and delete - the other);
 * - both kinds can be selected together; each is deleted through its own builder's delete;
 * - the confirm names every target and its kind; the list and its counts update after.
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const API = process.env.E2E_API_URL || 'http://localhost:3000';
const SHOTS = path.resolve(__dirname, '../../.artifacts/dod');
const STAMP = Date.now().toString(36);

test('Manual and Vibe reports are selected and deleted together, by key, with a named confirm', async ({ page, request }) => {
  const ds = await (await request.get(`${API}/api/v1/datasets/`)).json();
  const all = Array.isArray(ds) ? ds : ds.items || [];
  const dataset = all.find((d: any) => d.name === 'E2E presentation sales') || (process.env.CI ? null : all.find((d: any) => /Olist/i.test(d.name)));
  expect(dataset, 'a dataset to build a Vibe Report on').toBeTruthy();

  const vibe = [];
  for (const n of [1, 2]) {
    const r = await request.post(`${API}/api/v1/report-artifacts/blank`, { data: { dataset_id: dataset.id, name: `BULK vibe ${n} ${STAMP}` } });
    expect(r.status(), await r.text()).toBe(201);
    vibe.push(await r.json());
  }
  const manual = [];
  for (const n of [1, 2]) {
    const r = await request.post(`${API}/api/v1/dashboards/`, { data: { name: `BULK manual ${n} ${STAMP}` } });
    expect(r.ok(), await r.text()).toBeTruthy();
    manual.push(await r.json());
  }
  // a report that must SURVIVE: unselected, of either kind
  const keep = await (await request.post(`${API}/api/v1/report-artifacts/blank`, { data: { dataset_id: dataset.id, name: `BULK keep ${STAMP}` } })).json();

  await page.goto('/dashboards');
  await page.getByPlaceholder(/search|tìm/i).first().fill(`BULK`);
  const row = (key: string) => page.getByTestId(`report-row-${key}`);
  await expect(row(`vibe-${vibe[0].id}`)).toBeVisible({ timeout: 30000 });
  const before = Number((await page.getByTestId('report-type-vibe').innerText()).replace(/\D+/g, ' ').trim().split(' ').pop());

  // a Vibe Report is selectable like a dashboard
  await page.getByTestId(`report-select-vibe-${vibe[0].id}`).check();
  await page.getByTestId(`report-select-vibe-${vibe[1].id}`).check();
  await page.getByTestId(`report-select-manual-${manual[0].id}`).check();
  await page.getByTestId(`report-select-manual-${manual[1].id}`).check();
  // selected by KEY: the unselected report stays unselected (an id-keyed selection would also
  // tick any dashboard sharing a selected Vibe id, and any Vibe sharing a dashboard's)
  await expect(page.getByTestId(`report-select-vibe-${keep.id}`)).not.toBeChecked();
  await expect(page.getByText(/^4 (selected|đã chọn)$/)).toBeVisible();

  await page.getByTestId('bulk-delete').click();
  const targets = page.getByTestId('confirm-dialog-targets');
  await expect(targets).toBeVisible();
  for (const r of [...vibe, ...manual]) await expect(targets).toContainText(r.name);
  await expect(targets.locator('li')).toHaveCount(4);
  await page.waitForTimeout(400); // the dialog's fade-in
  await page.screenshot({ path: path.join(SHOTS, 'bulk-confirm.png') });
  await page.getByTestId('confirm-dialog-confirm').click();

  for (const r of vibe) await expect(row(`vibe-${r.id}`)).toHaveCount(0, { timeout: 20000 });
  for (const r of manual) await expect(row(`manual-${r.id}`)).toHaveCount(0);
  await expect(row(`vibe-${keep.id}`)).toBeVisible();
  await expect(page.getByTestId('report-type-vibe')).toContainText(String(before - 2));
  await page.screenshot({ path: path.join(SHOTS, 'bulk-after.png') });

  // the backend agrees: the deleted are gone, the kept one is not
  for (const r of vibe) expect((await request.get(`${API}/api/v1/report-artifacts/${r.id}`)).status()).toBe(404);
  for (const r of manual) expect((await request.get(`${API}/api/v1/dashboards/${r.id}`)).status()).toBe(404);
  expect((await request.get(`${API}/api/v1/report-artifacts/${keep.id}`)).status()).toBe(200);
  await request.delete(`${API}/api/v1/report-artifacts/${keep.id}`);
});
