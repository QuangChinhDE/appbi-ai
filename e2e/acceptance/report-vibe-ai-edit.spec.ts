/**
 * AI Vibe Report — a scoped AI edit with the deployment's REAL Studio model, on the local
 * stack. Moved out of tests/report-vibe-dod.spec.ts (J3) because CI has no Studio model:
 * in the default suite it could only fail or be skipped, and a skip is not coverage.
 * Explicit run only: `npx playwright test -c report-vibe-ai.config.ts`.
 *
 * The edit names ONE region; every rule it adds is scoped to that region and the rest of
 * the HTML is byte-identical. No revision = the edit did not happen = FAIL.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const RA = '/api/v1/report-artifacts';
const SHOTS = path.resolve(__dirname, '../../.artifacts/dod');
fs.mkdirSync(SHOTS, { recursive: true });

test('AI scoped edit changes one region and scopes its CSS', async ({ page }) => {
  const ds = await (await page.request.get('/api/v1/datasets/')).json();
  const list = Array.isArray(ds) ? ds : ds.items || [];
  const dataset = list.find((d: any) => /Olist Sales Reporting|E2E presentation sales/i.test(d.name)) || list[0];
  expect(dataset, 'a dataset exists on this stack').toBeTruthy();
  const created = await page.request.post(`${RA}/blank`, { data: { dataset_id: dataset.id, name: `DOD AI edit ${Date.now().toString(36)}` } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const reportId = (await created.json()).id;
  try {
    await page.goto(`/dashboards/code/${reportId}`);
    const before = await (await page.request.get(`${RA}/${reportId}`)).json();
    await page.getByTestId('studio-tab-ai').click();
    await expect(page.getByTestId('studio-ai-allow-data')).not.toBeChecked();
    await page.getByTestId('studio-select-region').click();
    await page.frameLocator('[data-testid="report-frame"]').locator('[data-rac-region="kpis"]').dispatchEvent('click');
    await expect(page.getByTestId('studio-region-chip')).toBeVisible();
    await page.getByTestId('studio-ai-input').fill('Đổi nền vùng này sang xanh lá nhạt, giữ nguyên chữ và số');
    await page.getByTestId('studio-ai-send').click();
    await expect(page.getByTestId('studio-job')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('studio-job')).toBeHidden({ timeout: 180_000 });
    const after = await (await page.request.get(`${RA}/${reportId}`)).json();
    expect(after.draft.number, 'the AI edit produced a new revision').toBeGreaterThan(before.draft.number);
    expect(after.draft.source).toBe('ai_edit');
    const added = after.draft.css.slice(before.draft.css.length);
    const rules = added.split('\n').filter((l: string) => l.includes('{') && !/^\s*(@|\/\*|\})/.test(l));
    expect(rules.length, added).toBeGreaterThan(0);
    expect(rules.every((r: string) => r.trim().startsWith('[data-rac-region="kpis"]')), added).toBeTruthy();
    const strip = (h: string) => h.replace(/<section[^>]*data-rac-region="kpis"[\s\S]*?<\/section>/, '');
    expect(strip(after.draft.html)).toBe(strip(before.draft.html));
    await page.screenshot({ path: path.join(SHOTS, 'j3-ai-region-edit.png') });
  } finally {
    const del = await page.request.delete(`${RA}/${reportId}`);
    expect(del.status()).toBe(204);
  }
});
