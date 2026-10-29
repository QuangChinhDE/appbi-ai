import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';
import { dropReport } from './_public-closure';

/**
 * A report-wide filter with a default value is never published away silently.
 *
 * Customer demo 2026-10-28: the period slicer ("Kỳ" = T08) disappeared from
 * slicers_config and the report showed every period summed, with no warning.
 * Publish now refuses (409 `slicer_removal_unconfirmed`) to drop a report-wide
 * slicer that has a default value unless the author confirms it; the Builder asks,
 * naming the filter and its value, and publishes only on a yes.
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_presentation.py — "E2E Presentation fixture"
 * with the report-wide "Region" slicer (slicer-region). Each test works on a duplicate.
 */

const V1 = `${API}/api/v1`;
const DASH = `${V1}/dashboards`;
const FIXTURE = 'E2E Presentation fixture';

async function copyOfFixture(request: APIRequestContext) {
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
  return { id: copy.id as number, ownCharts };
}

async function stageSlicers(request: APIRequestContext, id: number, slicers: any[]) {
  const d = await (await request.get(`${DASH}/${id}`)).json();
  const res = await request.put(`${DASH}/${id}/draft-filters`, {
    data: { slicers_config: slicers, base_rev: d.shared_draft?.rev },
  });
  expect(res.status(), await res.text()).toBe(200);
  return d;
}

const liveRegion = async (request: APIRequestContext, id: number) => {
  // the authed GET overlays the draft; with no draft pending it is the live report
  const d = await (await request.get(`${DASH}/${id}`)).json();
  return ((d.slicers_config ?? []) as any[]).find((s) => s.id === 'slicer-region') ?? null;
};

test('publishing away a report-wide filter that has a default value asks first, naming it', async ({ page, request }) => {
  const f = await copyOfFixture(request);
  try {
    // the Region slicer gets a default (North) on the live report
    const before = await stageSlicers(request, f.id, []);
    const region = (before.slicers_config as any[]).find((s) => s.id === 'slicer-region');
    expect(region, 'the fixture\'s Region slicer').toBeTruthy();
    await stageSlicers(request, f.id, [{ ...region, value: ['North'] }]);
    expect((await request.post(`${DASH}/${f.id}/publish`, { data: { force: true } })).status()).toBe(200);
    expect((await liveRegion(request, f.id))?.value).toEqual(['North']);

    // an author removes it in the draft, then presses Publish in the Builder
    await stageSlicers(request, f.id, []);
    await page.goto(`/dashboards/${f.id}`);
    const publish = page.getByTestId('dashboard-publish');
    await expect(publish).toBeVisible({ timeout: 60_000 });

    const asked: string[] = [];
    page.once('dialog', (dlg) => { asked.push(dlg.message()); void dlg.dismiss(); });
    await publish.click();
    await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1);
    expect(asked[0]).toContain('Region');
    expect(asked[0]).toContain('North');
    // "No": nothing went live - a publish without the yes is still refused
    const refused = await request.post(`${DASH}/${f.id}/publish`, { data: { force: true } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).detail.code).toBe('slicer_removal_unconfirmed');

    // "Yes": published without it
    page.once('dialog', (dlg) => { void dlg.accept(); });
    await publish.click();
    await expect.poll(async () => liveRegion(request, f.id), { timeout: 30_000 }).toBeNull();
  } finally {
    await dropReport(request, f);
  }
});
