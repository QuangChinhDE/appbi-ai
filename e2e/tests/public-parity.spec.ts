import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { API } from './_helpers';

/**
 * Builder ↔ /d ↔ /embed: the SAME business numbers, and the same layout.
 *
 * A published report must not change its result because it moved from the
 * Builder to a public surface (docs/features/dashboard-public-final-closure/spec.md
 * §4). Before this gate the public runtime applied no report parameter: a
 * field-bound switcher filtered the Builder (even at its default) but not /d, a
 * what-if switch swapped the Builder's dimension only — and nothing caught it,
 * because the presentation parity test compared frames and titles, not data.
 *
 * What is compared is the DATA each tile was answered with (the JSON the page
 * received), tile by tile — not pixels: Builder `GET /charts/{id}/data` against
 * the public `POST /public/dashboards/{t}/charts/data`.
 */

const DASH = `${API}/api/v1/dashboards`;
const FIXTURE = 'E2E Presentation fixture';

type Rows = Map<number, string>;
/** Every chart-data exchange seen, for a readable failure message. */
const LOG: string[] = [];

async function findFixture(request: APIRequestContext): Promise<number | null> {
  const res = await request.get(`${DASH}/?limit=200`);
  if (res.status() >= 400) return null;
  const items: any[] = await res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  return items.find((d) => d.name === FIXTURE)?.id ?? null;
}

const canon = (rows: unknown) =>
  JSON.stringify(((Array.isArray(rows) ? rows : []) as any[]).map((r) => JSON.stringify(r)).sort());

/** Collect the data rows every chart tile is answered with, keyed by chart id (last answer wins). */
function collect(page: Page): Rows {
  const rows: Rows = new Map();
  page.on('response', async (res: Response) => {
    const url = res.url();
    if (/\/charts\/(\d+\/)?data/.test(url)) LOG.push(`${res.status()} ${decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, '')).slice(0, 260)}`);
    if (!res.ok() || res.request().method() === 'OPTIONS') return;
    try {
      const builder = url.match(/\/api\/v1\/charts\/(\d+)\/data(\?|$)/);
      if (builder) {
        const body = await res.json();
        rows.set(Number(builder[1]), canon(body?.data));
        return;
      }
      if (/\/api\/v1\/public\/dashboards\/[^/]+\/charts\/data$/.test(url)) {
        const body = await res.json();
        for (const r of body?.results ?? []) if (r?.data) rows.set(Number(r.chart_id), canon(r.data?.data));
      }
    } catch {
      /* a body that is not JSON is not a chart answer */
    }
  });
  return rows;
}

async function settle(page: Page) {
  await page.waitForSelector('[data-tile-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const scrollers = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))
      .filter((el) => { const oy = getComputedStyle(el).overflowY; return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4; })]
      .filter((el): el is Element => !!el);
    for (const el of scrollers) {
      for (let y = 0; y <= el.scrollHeight; y += Math.max(200, el.clientHeight / 2)) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
      el.scrollTo(0, 0);
    }
  });
  // Tiles fetch lazily once they have been IN the viewport for a moment; a fast
  // sweep can pass a tile before it asks for data. Visit each one and dwell.
  const ids = await page.$$eval('[data-grid-item-id]', (els) => els.map((el) => el.getAttribute('data-grid-item-id') || ''));
  for (const id of ids) {
    const tile = page.locator(`[data-grid-item-id="${id}"]`).first();
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(450);
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function view(page: Page, url: string): Promise<Rows> {
  const rows = collect(page);
  await page.goto(url);
  await settle(page);
  return rows;
}

function expectSameNumbers(a: Rows, b: Rows, chartIds: number[], label: string) {
  for (const id of chartIds) {
    expect(b.get(id), `${label}: chart ${id} was not answered`).toBeTruthy();
    expect(b.get(id), `${label}: chart ${id} shows different numbers than the Builder`).toBe(a.get(id));
  }
}

/** A fresh copy of the fixture with its own public link. */
async function freshCopy(request: APIRequestContext, fixtureId: number) {
  const dup = await request.post(`${DASH}/${fixtureId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const copy = await dup.json();
  const link = await request.post(`${DASH}/${copy.id}/public-links`, { data: { name: 'e2e parity' } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  const tiles: any[] = copy.dashboard_charts ?? [];
  const chartTiles = tiles.filter((dc) => (dc.widget_type ?? 'chart') === 'chart' && dc.chart_id);
  return {
    id: copy.id as number,
    token: (await link.json()).token as string,
    chartIds: chartTiles.map((dc) => dc.chart_id as number),
    tiles: chartTiles as Array<{ id: number; chart_id: number; chart?: any }>,
  };
}

async function selectSwitcher(page: Page, tileId: number, value: string) {
  const select = page.locator(`[data-grid-item-id="${tileId}"] select`);
  await expect(select).toBeEnabled();
  const waitData = page.waitForResponse((r) => /\/charts\/(\d+\/)?data/.test(r.url()) && r.ok(), { timeout: 30_000 });
  await select.selectOption(value);
  await waitData;
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(900);
}

let fixtureId: number | null = null;

test.describe.serial('public parity — same numbers as the Builder', () => {
  test.beforeAll(async ({ request }) => {
    fixtureId = await findFixture(request);
    if (fixtureId == null && process.env.CI) {
      throw new Error(`"${FIXTURE}" is missing — the e2e workflow must run backend/scripts/ci/seed_e2e_presentation.py`);
    }
  });
  test.beforeEach(async () => {
    test.skip(fixtureId == null, `"${FIXTURE}" not seeded locally — run backend/scripts/ci/seed_e2e_presentation.py`);
  });

  test('every tile shows the same data on the Builder, /d and /embed', async ({ page, request }) => {
    const copy = await freshCopy(request, fixtureId!);
    try {
      const builder = await view(page, `/dashboards/${copy.id}`);
      expect(copy.chartIds.length).toBeGreaterThan(3);
      for (const route of [`/d/${copy.token}`, `/embed/${copy.token}`]) {
        expectSameNumbers(builder, await view(page, route), copy.chartIds, route.split('/')[1]);
      }
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('parameter switchers: field-bound + what-if give the Builder\'s numbers on /d and /embed, at default and after a switch', async ({ page, request }) => {
    const copy = await freshCopy(request, fixtureId!);
    try {
      const bar = copy.tiles.find((t) => String(t.chart?.chart_type ?? '').toUpperCase() === 'BAR');
      expect(bar, 'fixture: the BAR chart is missing').toBeTruthy();
      const add = async (widget_config: Record<string, unknown>, y: number) => {
        const res = await request.post(`${DASH}/${copy.id}/widgets`, {
          data: { widget_type: 'parameter_switcher', widget_config, layout: { x: 0, y, w: 12, h: 3 } },
        });
        expect(res.status(), await res.text()).toBeLessThan(400);
        const dash = await res.json();
        return (dash.dashboard_charts as any[]).find((dc) => dc.widget_config?.paramName === widget_config.paramName).id as number;
      };
      const regionTile = await add({ paramName: 'region', label: 'Region', field: 'region', layout: 'dropdown', default: 'South',
        options: ['North', 'South', 'Central'].map((v) => ({ label: v, value: v })) }, 60);
      const dimTile = await add({ paramName: 'dim', label: 'Group by', layout: 'dropdown', default: 'channel',
        options: [{ label: 'Region', value: 'region' }, { label: 'Channel', value: 'channel' }] }, 64);
      const bind = await request.patch(`${DASH}/${copy.id}/charts/${bar!.id}/parameters?draft=true`, {
        data: { parameters: { __whatifBindings: [{ param: 'dim', role: 'dimension' }] } },
      });
      expect(bind.status(), await bind.text()).toBeLessThan(400);
      const pub = await request.post(`${DASH}/${copy.id}/publish`, { data: { force: true } });
      expect(pub.status(), await pub.text()).toBeLessThan(400);

      // Default state: South filter + BAR grouped by channel — on every surface.
      const builder = await view(page, `/dashboards/${copy.id}`);
      const barRows = JSON.parse(builder.get(bar!.chart_id) || '[]') as string[];
      const barLog = LOG.filter((l) => l.includes(`/charts/${bar!.chart_id}/`)).join(' || ');
      expect(barRows.length, `Builder: what-if default (channel) did not regroup the BAR. Exchanges: ${barLog}`).toBe(2);
      for (const route of [`/d/${copy.token}`, `/embed/${copy.token}`]) {
        expectSameNumbers(builder, await view(page, route), copy.chartIds, `${route.split('/')[1]} default`);
      }

      // The viewer switches — same switches in the Builder — same numbers again.
      const builderAfter = collect(page);
      await page.goto(`/dashboards/${copy.id}`);
      await settle(page);
      await selectSwitcher(page, regionTile, 'North');
      await selectSwitcher(page, dimTile, 'region');
      for (const route of [`/d/${copy.token}`, `/embed/${copy.token}`]) {
        const pubRows = collect(page);
        await page.goto(route);
        await settle(page);
        await selectSwitcher(page, regionTile, 'North');
        await selectSwitcher(page, dimTile, 'region');
        expectSameNumbers(builderAfter, pubRows, copy.chartIds, `${route.split('/')[1]} switched`);
      }
      const regionRows = JSON.parse(builderAfter.get(bar!.chart_id) || '[]') as string[];
      expect(regionRows.length, 'what-if switch to region with a North filter').toBe(1);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('a forged switcher value is refused by the server, not silently widened', async ({ request }) => {
    const copy = await freshCopy(request, fixtureId!);
    try {
      const add = await request.post(`${DASH}/${copy.id}/widgets`, {
        data: { widget_type: 'parameter_switcher', layout: { x: 0, y: 60, w: 12, h: 3 },
          widget_config: { paramName: 'region', field: 'region', options: [{ label: 'North', value: 'North' }] } },
      });
      expect(add.status()).toBeLessThan(400);
      await request.post(`${DASH}/${copy.id}/publish`, { data: { force: true } });
      const tile = copy.tiles[0];
      const res = await request.post(`${API}/api/v1/public/dashboards/${copy.token}/charts/data`, {
        data: { items: [{ chart_id: tile.chart_id, tile_id: tile.id,
          filters: [{ id: 'param-region', field: 'region', operator: 'in', value: ['South'] }] }] },
      });
      const result = (await res.json()).results[0];
      expect(result.status, JSON.stringify(result)).toBe(400);
      expect(result.data).toBeFalsy();
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('responsive: /d and /embed lay tiles out identically at desktop, tablet and phone', async ({ page, request }) => {
    const copy = await freshCopy(request, fixtureId!);
    try {
      for (const vp of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        const geo: Record<string, Array<[string, number, number, number]>> = {};
        for (const route of [`/d/${copy.token}`, `/embed/${copy.token}`]) {
          await page.goto(route);
          await settle(page);
          geo[route] = await page.$$eval('[data-grid-item-id]', (els) => els
            .filter((el) => !el.closest('[aria-hidden="true"]'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              const g = el.closest('.react-grid-layout')!.getBoundingClientRect();
              return [el.getAttribute('data-grid-item-id') || '', Math.round(r.left - g.left), Math.round(r.top - g.top), Math.round(r.height)] as [string, number, number, number];
            })
            .sort((a, b) => a[2] - b[2] || a[1] - b[1]));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${route} @${vp.width}: horizontal page scroll`).toBeLessThanOrEqual(1);
        }
        const [d, e] = Object.values(geo);
        expect(e.map((t) => t[0]), `@${vp.width}: reading order differs between /d and /embed`).toEqual(d.map((t) => t[0]));
        for (let i = 0; i < d.length; i++) {
          expect(Math.abs(e[i][3] - d[i][3]), `@${vp.width}: tile ${d[i][0]} height differs`).toBeLessThanOrEqual(2);
        }
      }
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('"Preview before publish" frames the real report, and previewing publishes nothing', async ({ page, request }) => {
    const copy = await freshCopy(request, fixtureId!);
    try {
      const before = await (await request.get(`${DASH}/${copy.id}/public-links`)).json();
      const res = await request.post(`${DASH}/${copy.id}/public-links/preview`, { data: { appearance_config: { show_page_tabs: false } } });
      expect(res.status(), await res.text()).toBe(200);
      const { token } = await res.json();
      const rows = await view(page, `/d/${token}`);
      expect([...rows.keys()].filter((id) => copy.chartIds.includes(id)).length, 'the preview did not render the report').toBeGreaterThan(3);
      const after = await (await request.get(`${DASH}/${copy.id}/public-links`)).json();
      expect(after.length, 'a preview became a listed public link').toBe(before.length);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });
});
