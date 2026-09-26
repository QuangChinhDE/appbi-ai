import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';

/**
 * Report Experience — measured on the rendered report, not on the DOM tree.
 *
 *  - DATA FIRST: every axis chart on the published fixture draws data marks. A
 *    plot with axes and no marks is a failure, not a pass (this is how every
 *    time series in V2 shipped empty while the gates were green).
 *  - A design direction adds blocks bound to live findings. They are part of
 *    the DRAFT: /d does not show them until Publish, and after Publish every
 *    sentence is computed (state "ready") and carries no typed figure of its own.
 *
 * Fixture: `seed_e2e_presentation.py` (CI seeds it). Each test works on a
 * duplicate and deletes it. Missing fixture on CI = failure, never a skip.
 */

const DASH = `${API}/api/v1/dashboards`;
const FIXTURE = 'E2E Presentation fixture';
let fixtureId: number | null = null;

async function findFixture(request: APIRequestContext): Promise<number | null> {
  const res = await request.get(`${DASH}/?limit=200`);
  if (res.status() >= 400) return null;
  const items: any[] = await res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  return items.find((d) => d.name === FIXTURE)?.id ?? null;
}

async function copy(request: APIRequestContext) {
  const dup = await request.post(`${DASH}/${fixtureId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  const link = await request.post(`${DASH}/${d.id}/public-links`, { data: { name: 'e2e report experience' } });
  expect(link.status()).toBeLessThan(400);
  return { id: d.id as number, token: (await link.json()).token as string };
}

async function settled(page: Page) {
  await page.waitForSelector('[data-tile-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) {
      for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      el.scrollTo(0, 0);
    }
  });
  await page.waitForFunction(() => !document.querySelector('[data-tile-id] .animate-spin'), undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500); // chart animations
}

async function audit(page: Page) {
  const r = await page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null);
  expect(r, 'render audit not exposed').not.toBeNull();
  return r as { tiles: Array<{ tileId: number; kind: string; marks?: number }>; findings: Array<{ code: string; tileId: number; detail: string }> };
}

test.beforeAll(async ({ request }) => {
  fixtureId = await findFixture(request);
  if (!fixtureId && process.env.CI) throw new Error(`fixture "${FIXTURE}" missing — seed_e2e_presentation.py did not run`);
});

test.beforeEach(() => { test.skip(!fixtureId, 'fixture not seeded (local run)'); });

test('every axis chart on the published report draws data marks', async ({ page, request }) => {
  const c = await copy(request);
  try {
    await page.goto(`/d/${c.token}`);
    await settled(page);
    const a = await audit(page);
    const charts = a.tiles.filter((t) => t.kind === 'chart' && t.marks !== undefined);
    expect(charts.length, 'no axis charts measured').toBeGreaterThan(1);
    for (const t of charts) expect(t.marks, `tile ${t.tileId} drew no data marks`).toBeGreaterThan(0);
    expect(a.findings.filter((f) => f.code === 'chart.noMarks')).toEqual([]);
    // The time series specifically — the chart V2 shipped empty.
    const curve = await page.locator('.recharts-line-curve').first().getAttribute('d');
    expect((curve ?? '').length, 'the time series has no line').toBeGreaterThan(20);
  } finally {
    await request.delete(`${DASH}/${c.id}`);
  }
});

for (const direction of ['executive', 'operations', 'editorial'] as const) {
  test(`${direction}: blocks are draft until Publish, then live and computed`, async ({ page, request }) => {
    const c = await copy(request);
    try {
      await page.goto(`/dashboards/${c.id}`);
      await settled(page);
      await page.getByTestId('design-mode-ai').click();
      await page.getByTestId(`ai-design-direction-${direction}`).click();
      await page.getByTestId('ai-design-apply').waitFor({ timeout: 30_000 });
      // Preview == Apply: the blocks are on the canvas before anything is saved.
      await expect(page.getByTestId('narrative-widget').first()).toBeVisible();
      await page.getByTestId('ai-design-apply').click();
      await expect.poll(async () => (await request.get(`${DASH}/${c.id}`).then((r) => r.json())).dashboard_charts
        .filter((d: any) => d.widget_type === 'narrative').length, { timeout: 20_000 }).toBeGreaterThan(0);

      // Draft: /d does not have them yet.
      const pub = await page.context().newPage();
      await pub.goto(`/d/${c.token}`);
      await settled(pub);
      expect(await pub.getByTestId('narrative-widget').count(), 'an unpublished block reached /d').toBe(0);

      await page.getByTestId('dashboard-publish').click();
      await expect.poll(async () => (await request.get(`${DASH}/${c.id}`).then((r) => r.json())).dashboard_charts
        .filter((d: any) => d.widget_type === 'narrative' && !d.layout?.draftOnly).length, { timeout: 20_000 }).toBeGreaterThan(0);

      await pub.reload();
      await settled(pub);
      const blocks = await pub.getByTestId('narrative-widget').evaluateAll((els) => els.map((e) => ({
        state: e.getAttribute('data-finding-state') ?? '',
        sentences: e.querySelectorAll('[data-finding]').length,
      })));
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        // Headings are the author's words (report / chart names) and may hold
        // digits; a typed figure from the MODEL is refused at the plan boundary
        // (report-experience contract). Here: every block states live findings.
        expect(b.sentences, 'a block states no finding').toBeGreaterThan(0);
        expect(b.state.split(',').every((s) => s === 'ready'), `a sentence is ${b.state}`).toBe(true);
      }
      const a = await audit(pub);
      expect(a.findings.filter((f) => ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'].includes(f.code))).toEqual([]);
      await pub.close();
    } finally {
      await request.delete(`${DASH}/${c.id}`);
    }
  });
}
