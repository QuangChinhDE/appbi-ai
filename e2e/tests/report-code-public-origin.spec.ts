/**
 * A code report's PUBLIC link in both deployment modes of REPORT_ARTIFACT_ORIGIN.
 *
 * - isolated report origin (a dedicated subdomain; on a local install the 127.0.0.1 twin):
 *   data + CSS + the author's JS all run on /d/r/<token>.
 * - shared origin (unset, or the app's own domain): data + CSS still run, the author's JS
 *   does not - and nothing on the page says the report is broken.
 *
 * The mode is the server's (`isolated` in the public meta); the spec asserts the behaviour
 * that mode promises. Run it once per mode (docs/deploy/report-artifact-origin.md).
 */
import { expect, test, type Frame, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://localhost:3000';
const RA = `${API}/api/v1/report-artifacts`;
const PUB = `${API}/api/v1/public/reports`;
const APP = process.env.E2E_BASE_URL || 'http://localhost:3000'; // pages are the frontend's; API may be the backend (CI)

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let reportId = 0;

test.afterAll(async ({ request }) => {
  if (reportId) await request.delete(`${RA}/${reportId}`);
});

async function reportFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().length, { timeout: 60_000 }).toBeGreaterThan(1);
  return page.frames().find((f) => f !== page.mainFrame())!;
}

test('a code report public link: data and CSS always, the author JS exactly when the origin is isolated', async ({ request, browser, page: studio }) => {
  const ds = await (await request.get(`${API}/api/v1/datasets/`)).json();
  const all = Array.isArray(ds) ? ds : ds.items || [];
  const dataset = all.find((d: any) => d.name === 'E2E presentation sales')
    || (process.env.CI ? null : all.find((d: any) => /Olist Sales Reporting/i.test(d.name)));
  expect(dataset, 'the E2E presentation sales fixture (CI) or the Olist dataset (local) exists').toBeTruthy();

  const pack = await (await request.get(`${RA}/context-pack?dataset_id=${dataset.id}`)).text();
  const check = JSON.parse(pack.split('```json\n')[1].split('\n```')[0]);
  const kpi = check.data.find((x: string) => check.data_kinds[x] === 'kpi');
  expect(kpi, 'the dataset offers a KPI').toBeTruthy();

  const html = `<section data-rac-region="body" data-rac-label="Tổng quan">
<h2 class="css-mark">Tổng quan</h2>
<div class="card"><b id="kpi" data-rac-value="${kpi}"></b></div>
<p id="js-mark" data-rac-static></p>
</section>`;
  const css = '.css-mark{color:rgb(1, 2, 3)}';
  const js = "document.getElementById('js-mark').textContent = 'JS-RAN';";
  const imp = await request.post(`${RA}/import`, { data: { dataset_id: dataset.id, name: `E2E origin ${Date.now()}`, html, css, js, mapping: [], filters: [], prompt: '' } });
  expect(imp.ok(), await imp.text()).toBeTruthy();
  reportId = (await imp.json()).id;
  await expect.poll(async () => (await (await request.get(`${RA}/${reportId}`)).json()).job?.state, { timeout: 120_000 })
    .not.toMatch(/running|queued/);

  const pub = await request.post(`${RA}/${reportId}/publish`, { data: {} });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  const link = await request.post(`${RA}/${reportId}/public-links`, { data: { name: 'e2e origin modes' } });
  expect(link.ok(), await link.text()).toBeTruthy();
  const token = (await link.json()).token;

  const meta = await (await request.get(`${PUB}/${token}`)).json();
  const isolated = meta.isolated === true;
  test.info().annotations.push({ type: 'origin-mode', description: isolated ? 'isolated' : 'shared (JS off)' });
  console.log(`origin-mode: ${isolated ? 'isolated' : 'shared (JS off)'}`);
  if (isolated) expect(new URL(meta.document_url).origin, 'an isolated document is on another origin').not.toBe(new URL(APP).origin);

  const anon = await browser.newContext(); // a viewer with no session
  const page = await anon.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${APP}/d/r/${token}`);
  await expect(page.getByTestId('public-report')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('public-report-error')).toHaveCount(0);
  const frame = await reportFrame(page);

  // Data: the governed KPI is drawn in both modes.
  await expect.poll(async () => (await frame.locator('#kpi').textContent())?.trim() || '', { timeout: 60_000 })
    .toMatch(/\d/);
  // CSS: the author's styles apply in both modes.
  expect(await frame.locator('.css-mark').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(1, 2, 3)');
  // JS: exactly when the origin is isolated.
  if (isolated) {
    await expect(frame.locator('#js-mark')).toHaveText('JS-RAN', { timeout: 30_000 });
  } else {
    await page.waitForTimeout(3000);
    await expect(frame.locator('#js-mark')).toHaveText('');
  }
  expect(errors, 'the public page threw').toEqual([]);
  await anon.close();

  // Studio: the author hears the same mode - "JS not running (report OK)", never a security error.
  await studio.goto(`${APP}/dashboards/code/${reportId}`);
  const pill = studio.getByTestId('studio-guard');
  await expect(pill).toBeVisible({ timeout: 60_000 });
  if (isolated) await expect(pill).toHaveText(/JS tùy biến bật|Custom JS on/);
  else await expect(pill).toHaveText(/chưa chạy|not running/);
  await expect(studio.getByText(/^(Bảo mật|Security)$/)).toHaveCount(0);
});
