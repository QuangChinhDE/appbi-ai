import crypto from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';
import { collectTiles, dataQuiet, dropReport, type TileRows } from './_public-closure';

/**
 * A VIEW-only user applies a placed report slicer on the authed dashboard page.
 *
 * Bug: `handleApplyFilters` returned for a non-editor right after applying the
 * filter pane, so the slicer state (applied global slicers, the page's slicers,
 * cluster layout) was only ever applied on the editor branch. A viewer picked a
 * value, the bar said "1 filter change not applied yet", Apply did nothing — no
 * re-query, KPIs unchanged, the bar stayed.
 *
 * Contract: a viewer's Apply is an in-session apply (charts re-query with the
 * pick) and writes NOTHING (no draft-filters call). The editor path is
 * unchanged: same in-session apply plus the draft write.
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_presentation.py — "E2E Presentation
 * fixture" with a placed "Region" slicer and the "E2E Revenue" KPI (SUM of
 * revenue). Revenue is arithmetic: all regions 1,734,900; North 491,220.
 * Each test works on a duplicate; the viewer account is created per run with
 * a random password and deleted afterwards.
 */

const V1 = `${API}/api/v1`;
const DASH = `${V1}/dashboards`;
const FIXTURE = 'E2E Presentation fixture';
const TOTAL = 1734900;
const NORTH = 491220;

async function fixtureCopy(request: APIRequestContext) {
  const list = await (await request.get(`${DASH}/?limit=300`)).json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  const src = list.find((d: any) => d.name === FIXTURE)?.id;
  expect(src, 'run seed_e2e_presentation.py').toBeTruthy();
  const dup = await request.post(`${DASH}/${src}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const copy = await dup.json();
  const seeded = new Set(((await (await request.get(`${DASH}/${src}`)).json()).dashboard_charts as any[])
    .map((dc) => dc.chart_id).filter((c) => c != null));
  const ownCharts = [...new Set((copy.dashboard_charts as any[]).map((dc) => dc.chart_id as number)
    .filter((c) => c != null && !seeded.has(c)))];
  // A duplicate gets its OWN charts, renamed to stay unique per owner ("E2E Revenue (2)", suffixes can stack),
  // and the duplicate response may not embed them: read the copy back and match the KPI.
  const full = await (await request.get(`${DASH}/${copy.id}`)).json();
  const kpi = (full.dashboard_charts as any[]).find((dc) => {
    const name = String(dc.chart?.name ?? '');
    const type = String(dc.chart?.chart_type ?? '').toUpperCase();
    return type === 'KPI' && /^E2E Revenue(?: \(\d+\))*$/.test(name);
  });
  expect(kpi, 'the E2E Revenue KPI tile').toBeTruthy();
  return { id: copy.id as number, ownCharts, kpiTile: kpi.id as number };
}

/** The numbers in the KPI tile's latest answer. */
function kpiNumbers(rows: TileRows, tile: number): number[] {
  const hit = rows.get(tile);
  if (!hit) return [];
  return (JSON.parse(hit.rows) as string[]).flatMap((r) => Object.values(JSON.parse(r)))
    .map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

async function pickAndApply(page: Page, value: string) {
  const ctl = page.locator('main [data-widget-type="slicer"]').filter({ hasText: /Region/ }).first();
  await ctl.waitFor({ timeout: 30_000 });
  await ctl.scrollIntoViewIfNeeded();
  await ctl.locator('.dashboard-slicer button[aria-expanded][aria-label]').first().click();
  const menu = page.locator('[data-slicer-menu]');
  await menu.waitFor({ timeout: 15_000 });
  await menu.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) }).first().click();
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 300);
  const apply = page.getByTestId('filter-apply-bar-apply');
  await expect(apply, 'the bar offers Apply for the staged pick').toBeVisible({ timeout: 15_000 });
  await apply.click();
}

async function expectKpi(rows: TileRows, page: Page, tile: number, want: number, label: string) {
  await expect.poll(async () => { await dataQuiet(page); return kpiNumbers(rows, tile).some((n) => Math.round(n) === want); },
    { timeout: 60_000, message: label }).toBe(true);
}

test.describe('dashboard slicer Apply — viewer and editor', () => {
  test.describe.configure({ mode: 'serial' });

  test('a VIEW-only user applies a placed slicer: KPI re-queries, nothing is written', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const f = await fixtureCopy(request);
    const email = `viewer-slicer-${Date.now()}@appbi.io`;
    const password = `${crypto.randomBytes(18).toString('base64url')}!aA1`;
    let userId: string | null = null;
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1440, height: 1200 },
      extraHTTPHeaders: { 'x-e2e': '1' } });
    try {
      const created = await request.post(`${V1}/users/`, { data: { email, full_name: 'Viewer Slicer', password, auth_provider: 'password' } });
      expect(created.status(), await created.text()).toBeLessThan(400);
      userId = String((await created.json()).id);
      const preset = await request.put(`${V1}/permissions/${userId}/preset`, { data: { preset: 'viewer' } });
      expect(preset.status(), await preset.text()).toBeLessThan(400);
      // Dashboard share cascades to its datasets; 'view' only.
      const share = await request.post(`${V1}/shares/dashboard/${f.id}`, { data: { email, permission: 'view' } });
      expect(share.status(), await share.text()).toBeLessThan(400);

      const page = await ctx.newPage();
      await page.goto('/login');
      await page.locator('input[type="email"], input[name="email"]').first().fill(email);
      const pw = page.locator('input[type="password"]').first();
      await pw.fill(password);
      await pw.press('Enter');
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

      const writes: string[] = [];
      page.on('request', (r) => { if (/\/dashboards\/\d+\/draft-filters/.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
      const rows = collectTiles(page);
      await page.goto(`/dashboards/${f.id}`);
      await expectKpi(rows, page, f.kpiTile, TOTAL, 'the unfiltered revenue');

      await pickAndApply(page, 'North');
      await expectKpi(rows, page, f.kpiTile, NORTH, 'the viewer\'s Apply re-queries the KPI with Region = North');
      await expect(page.getByTestId('filter-apply-bar'), 'nothing is left pending after Apply').toBeHidden({ timeout: 15_000 });
      expect(writes, 'a viewer\'s Apply writes nothing').toEqual([]);
    } finally {
      await ctx.close();
      await dropReport(request, f);
      if (userId) await request.delete(`${V1}/users/${userId}/permanent`).catch(() => {});
    }
  });

  test('the editor path is unchanged: KPI re-queries and the draft is written', async ({ page, request }) => {
    test.setTimeout(180_000);
    const f = await fixtureCopy(request);
    try {
      const writes: string[] = [];
      page.on('request', (r) => { if (/\/dashboards\/\d+\/draft-filters/.test(r.url())) writes.push(r.method()); });
      const rows = collectTiles(page);
      await page.goto(`/dashboards/${f.id}`);
      await expectKpi(rows, page, f.kpiTile, TOTAL, 'the unfiltered revenue');
      await pickAndApply(page, 'North');
      await expectKpi(rows, page, f.kpiTile, NORTH, 'the editor\'s Apply re-queries the KPI with Region = North');
      await expect.poll(() => writes.length, { message: 'the editor\'s Apply stages the draft' }).toBeGreaterThan(0);
      await expect(page.getByTestId('filter-apply-bar')).toBeHidden({ timeout: 15_000 });
    } finally {
      await dropReport(request, f);
    }
  });
});
