/**
 * report-data-perf on the real stack: a code report's page loads its data in batches and only
 * for what it shows. A KPI inside a closed <details> is not asked until the section opens;
 * then it is asked (one batch) and filled. Studio uses the same batched path.
 */
import { expect, test, type Request } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://localhost:3000';
const APP = process.env.E2E_BASE_URL || 'http://localhost:3000';
const RA = `${API}/api/v1/report-artifacts`;

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let reportId = 0;
test.afterAll(async ({ request }) => { if (reportId) await request.delete(`${RA}/${reportId}`); });

const asked = (reqs: Request[]) => reqs.flatMap((r) => (r.postDataJSON()?.bindings as string[]) || []);

test('a hidden section loads its data only when opened, in batches, on the public link and in Studio', async ({ request, browser, page: studio }) => {
  const ds = await (await request.get(`${API}/api/v1/datasets/`)).json();
  const all = Array.isArray(ds) ? ds : ds.items || [];
  const dataset = all.find((d: any) => d.name === 'E2E presentation sales')
    || (process.env.CI ? null : all.find((d: any) => /Olist Sales Reporting/i.test(d.name)));
  expect(dataset, 'the E2E presentation sales fixture (CI) or the Olist dataset (local) exists').toBeTruthy();
  const pack = await (await request.get(`${RA}/context-pack?dataset_id=${dataset.id}`)).text();
  const check = JSON.parse(pack.split('```json\n')[1].split('\n```')[0]);
  const kpis = check.data.filter((x: string) => check.data_kinds[x] === 'kpi');
  const other = check.data.find((x: string) => check.data_kinds[x] !== 'kpi');
  expect(kpis.length >= 1 && other, 'a KPI and a second placeholder').toBeTruthy();

  const html = `<section data-rac-region="body" data-rac-label="Tổng quan">
<b id="shown" data-rac-value="${kpis[0]}"></b>
<details id="more"><summary>Thêm</summary><div data-rac-viz="bar" data-rac-bind="${other}" style="height:160px"></div></details>
</section>`;
  const imp = await request.post(`${RA}/import`, { data: { dataset_id: dataset.id, name: `E2E lazy ${Date.now()}`, html, css: '', js: '', mapping: [], filters: [], prompt: '' } });
  expect(imp.ok(), await imp.text()).toBeTruthy();
  reportId = (await imp.json()).id;
  await expect.poll(async () => (await (await request.get(`${RA}/${reportId}`)).json()).job?.state, { timeout: 120_000 }).not.toMatch(/running|queued/);
  const draft = (await (await request.get(`${RA}/${reportId}`)).json()).draft;
  expect(draft.bindings.length).toBe(2);
  const hiddenId = draft.html.match(/data-rac-bind="([^"]+)"/)[1];
  const shownId = draft.html.match(/data-rac-value="([^"]+)"/)[1];
  expect((await request.post(`${RA}/${reportId}/publish`, { data: {} })).ok()).toBeTruthy();
  const token = (await (await request.post(`${RA}/${reportId}/public-links`, { data: { name: 'lazy' } })).json()).token;

  const anon = await browser.newContext();
  const page = await anon.newPage();
  const batches: Request[] = [];
  let single = 0;
  page.on('request', (r) => {
    if (/\/public\/reports\/[^/]+\/data-batch$/.test(r.url())) batches.push(r);
    else if (/\/public\/reports\/[^/]+\/data$/.test(r.url())) single += 1;
  });
  await page.goto(`${APP}/d/r/${token}`);
  const frame = await (async () => { await expect.poll(() => page.frames().length, { timeout: 60_000 }).toBeGreaterThan(1); return page.frames().find((f) => f !== page.mainFrame())!; })();
  await expect.poll(async () => (await frame.locator('#shown').textContent())?.trim() || '', { timeout: 60_000 }).toMatch(/\d/);
  await page.waitForTimeout(1500);
  expect(asked(batches)).toContain(shownId);
  expect(asked(batches), 'a closed section is not asked').not.toContain(hiddenId);
  expect(single, 'the page uses the batched path').toBe(0);

  await frame.locator('#more > summary').click();
  await expect.poll(() => asked(batches), { timeout: 30_000 }).toContain(hiddenId);
  await expect(frame.locator(`[data-rac-bind="${hiddenId}"] svg, [data-rac-bind="${hiddenId}"] .rac-state`).first()).toBeVisible({ timeout: 30_000 });
  await anon.close();

  // Studio: the same batched path
  const studioBatches: string[] = [];
  studio.on('request', (r) => { if (/\/report-artifacts\/\d+\/data-batch$/.test(r.url())) studioBatches.push(r.url()); });
  await studio.goto(`${APP}/dashboards/code/${reportId}`);
  await expect.poll(() => studioBatches.length, { timeout: 60_000 }).toBeGreaterThan(0);
});
