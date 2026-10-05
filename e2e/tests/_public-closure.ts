/**
 * Shared machinery for the Dashboard Public closure suites (public-*.spec.ts).
 *
 * Everything goes through the real stack: production Next build, real backend,
 * real Postgres, real public API. No route mocking. Fixtures are built through
 * the same API an author uses, from the seeded "E2E Presentation fixture"
 * (backend/scripts/ci/seed_e2e_presentation.py: 24 months × North/South/Central
 * × Online/Retail — every selection below changes the numbers).
 *
 * IDENTITY. Parity is keyed by TILE (dashboard_chart id), never by chart id: a
 * chart may sit on a report twice with different tile parameters. The public
 * batch echoes `tile_id`; Builder tiles send `tile_id` on their own requests
 * (observability only, ignored by the server).
 */
import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { API } from './_helpers';

export const V1 = `${API}/api/v1`;
export const DASH = `${V1}/dashboards`;
export const FIXTURE = 'E2E Presentation fixture';

export type Surface = 'builder' | 'd' | 'embed' | 'emb';
export const PUBLIC_SURFACES: Surface[] = ['d', 'embed', 'emb'];

/** tile id → canonical rows + where they came from. */
export type TileRows = Map<number, { rows: string; chartId: number; url: string; seq?: number }>;

export async function findFixture(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${DASH}/?limit=200`);
  const items: any[] = await res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  const id = items.find((d) => d.name === FIXTURE)?.id;
  // A critical closure gate must not pass by skipping: no fixture in CI = FAIL.
  if (id == null) {
    throw new Error(`"${FIXTURE}" is missing — run backend/scripts/ci/seed_e2e_presentation.py (the e2e workflow does)`);
  }
  return id;
}

/** Rows as a set: order-free and key-order-free (a cached answer may list keys differently). */
export const canon = (rows: unknown) =>
  JSON.stringify(((Array.isArray(rows) ? rows : []) as any[])
    .map((r) => JSON.stringify(r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))) : r))
    .sort());

/**
 * Record the rows every tile is answered with, keyed by TILE. Builder: GET
 * /charts/{id}/data?…&tile_id=N. Public (/d, /embed, emb_): POST
 * /public/dashboards/{t}/charts/data, results carry tile_id.
 */
export function collectTiles(page: Page): TileRows {
  const rows: TileRows = new Map();
  const onResponse = async (res: Response) => {
    const url = res.url();
    if (!res.ok() || res.request().method() !== (url.includes('/public/') ? 'POST' : 'GET')) return;
    try {
      const m = url.match(/\/api\/v1\/charts\/(\d+)\/data\?(.*)$/);
      if (m) {
        const tile = new URLSearchParams(m[2]).get('tile_id');
        if (!tile) return;
        const body = await res.json();
        keepLatest(rows, Number(tile), { rows: canon(body?.data), chartId: Number(m[1]), url: shortUrl(url), seq: seqOf(res) });
        return;
      }
      if (/\/api\/v1\/public\/dashboards\/[^/]+\/charts\/data$/.test(url)) {
        const body = await res.json();
        for (const r of body?.results ?? []) {
          if (r?.data && r.tile_id != null) {
            keepLatest(rows, Number(r.tile_id), { rows: canon(r.data?.data), chartId: Number(r.chart_id), url: shortUrl(url), seq: seqOf(res) });
          }
        }
      }
    } catch {
      // A body that is not JSON is not a chart answer; it is simply not recorded,
      // and the missing tile fails the comparison below with its context.
    }
  };
  page.on('response', onResponse);
  listeners.set(rows, { page, fn: onResponse });
  trackInflight(page);
  return rows;
}

// In-flight chart-data requests per page. An answer to a request the page has
// already superseded (a switch made while an earlier query was still running)
// can land after a collector starts; the page ignores it, a collector must too —
// so reads wait until no chart-data request is pending.
const inflight = new WeakMap<Page, { pending: Set<unknown>; lastChange: number }>();
const isDataRequest = (url: string) => /\/api\/v1\/(public\/dashboards\/[^/]+\/)?charts\/(\d+\/)?data/.test(url);

function trackInflight(page: Page) {
  if (inflight.has(page)) return;
  const state = { pending: new Set<unknown>(), lastChange: Date.now() };
  inflight.set(page, state);
  page.on('request', (r) => { if (isDataRequest(r.url())) { requestSeq.set(r, ++requestCounter); state.pending.add(r); state.lastChange = Date.now(); } });
  const done = (r: any) => { if (state.pending.delete(r)) state.lastChange = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}

/** Resolve once no chart-data request has been pending for `quietMs`. */
export async function dataQuiet(page: Page, quietMs = 1500, timeout = 60_000) {
  trackInflight(page);
  const state = inflight.get(page)!;
  await expect.poll(() => state.pending.size === 0 && Date.now() - state.lastChange >= quietMs, {
    message: 'chart-data requests never went quiet', timeout, intervals: [250],
  }).toBe(true);
}

const listeners = new WeakMap<TileRows, { page: Page; fn: (res: Response) => Promise<void> }>();

// Answers can arrive out of order (an earlier, superseded query finishing after
// the current one). The page keeps the answer to its LATEST request; so does a
// collector — by the order requests were SENT, not the order answers arrived.
let requestCounter = 0;
const requestSeq = new WeakMap<object, number>();
const seqOf = (res: Response) => requestSeq.get(res.request()) ?? 0;
function keepLatest(rows: TileRows, tile: number, entry: { rows: string; chartId: number; url: string; seq: number }) {
  const prev = rows.get(tile);
  if (!prev || (prev.seq ?? 0) <= entry.seq) rows.set(tile, entry);
}

/**
 * Stop recording and return an immutable copy. A collector that kept listening
 * would be overwritten by LATER answers — including another surface's — and a
 * comparison against it would pass trivially. Every read freezes.
 */
export function freeze(rows: TileRows): TileRows {
  const l = listeners.get(rows);
  if (l) {
    l.page.off('response', l.fn);
    listeners.delete(rows);
  }
  return new Map(rows);
}

function shortUrl(url: string) {
  // Never print a bearer token in a failure message.
  return decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, ''))
    .replace(/\/public\/dashboards\/[^/]+\//, '/public/dashboards/<token>/')
    .slice(0, 300);
}

/** Visit every tile (they fetch lazily once in view) and wait for the network to settle. */
export async function settle(page: Page, scope = 'body') {
  await page.waitForSelector(`${scope} [data-tile-id]`, { timeout: 60_000 });
  const ids = await page.$$eval(`${scope} [data-grid-item-id]`, (els) => els.map((el) => el.getAttribute('data-grid-item-id') || ''));
  for (const id of ids) {
    await page.locator(`${scope} [data-grid-item-id="${id}"]`).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(350);
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
}

/** Wait until every listed tile has an answer in `rows`. */
export async function waitForTiles(rows: TileRows, tiles: number[], label: string, timeout = 45_000) {
  await expect.poll(() => tiles.filter((t) => !rows.has(t)), {
    message: `${label}: tiles never answered`, timeout,
  }).toEqual([]);
  const l = listeners.get(rows);
  if (l) await dataQuiet(l.page);
}

export function expectSameTiles(expected: TileRows, actual: TileRows, tiles: number[], label: string, state = '') {
  for (const t of tiles) {
    const e = expected.get(t);
    const a = actual.get(t);
    expect(a, `${label}: tile ${t} was not answered (state: ${state})`).toBeTruthy();
    expect(e, `${label}: expected tile ${t} missing (state: ${state})`).toBeTruthy();
    expect(a!.rows, [
      `${label}: tile ${t} (chart ${a!.chartId}) differs from the Builder`,
      `  state: ${state}`,
      `  builder request: ${e!.url}`,
      `  ${label} request: ${a!.url}`,
      `  builder rows: ${e!.rows.slice(0, 400)}`,
      `  ${label} rows: ${a!.rows.slice(0, 400)}`,
    ].join('\n')).toBe(e!.rows);
  }
}

export type Fixture = {
  id: number;
  token: string;
  emb: string;
  charts: Array<{ tile: number; chart: number; type: string; name: string }>;
  tile: (type: string) => number;
};

/** A fresh copy of the seeded report with a public link; optional author steps before publish. */
export async function freshReport(
  request: APIRequestContext,
  author?: (id: number, charts: Fixture['charts']) => Promise<void>,
): Promise<Fixture> {
  const fixtureId = await findFixture(request);
  const dup = await request.post(`${DASH}/${fixtureId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const copy = await dup.json();
  const charts = (copy.dashboard_charts as any[])
    .filter((dc) => (dc.widget_type ?? 'chart') === 'chart' && dc.chart_id)
    .map((dc) => ({ tile: dc.id, chart: dc.chart_id, type: String(dc.chart?.chart_type ?? '').toUpperCase(), name: dc.chart?.name ?? '' }));
  if (author) {
    await author(copy.id, charts);
    const pub = await request.post(`${DASH}/${copy.id}/publish`, { data: { force: true } });
    expect(pub.status(), await pub.text()).toBeLessThan(400);
  }
  const fresh = await (await request.get(`${DASH}/${copy.id}`)).json();
  const all = (fresh.dashboard_charts as any[])
    .filter((dc) => (dc.widget_type ?? 'chart') === 'chart' && dc.chart_id)
    .map((dc) => ({ tile: dc.id, chart: dc.chart_id, type: String(dc.chart?.chart_type ?? '').toUpperCase(), name: dc.chart?.name ?? '' }));
  const link = await request.post(`${DASH}/${copy.id}/public-links`, { data: { name: 'closure' } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  const emb = await mintEmbed(request, copy.id, { full_report: true });
  return {
    id: copy.id,
    token: (await link.json()).token,
    emb,
    charts: all,
    tile: (type) => {
      const hit = all.find((c) => c.type === type);
      if (!hit) throw new Error(`fixture: no ${type} tile`);
      return hit.tile;
    },
  };
}

export async function dropReport(request: APIRequestContext, f: { id: number } | null | undefined) {
  if (f) await request.delete(`${DASH}/${f.id}`).catch(() => {});
}

// ── integration embed: a real PAT, a real grant ─────────────────────────────

let pat: { id: string; token: string } | null = null;

export async function integrationPat(request: APIRequestContext): Promise<{ id: string; token: string }> {
  if (pat) return pat;
  const res = await request.post(`${V1}/auth/personal-access-tokens/`, {
    data: { name: `e2e closure ${Date.now()}`, scopes: { dashboards: 'edit' }, expires_in_days: 1 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  pat = { id: String(body.item?.id ?? ''), token: String(body.token) };
  return pat;
}

/** Mint an `emb_` grant with a PAT (a browser session is refused by contract). Returns the path. */
export async function mintEmbed(request: APIRequestContext, dashboardId: number, body: Record<string, unknown>, token?: string) {
  const bearer = token ?? (await integrationPat(request)).token;
  const res = await request.post(`${V1}/integrations/embed/resolve`, {
    headers: { Authorization: `Bearer ${bearer}` },
    data: { dashboard_id: dashboardId, ...body },
  });
  expect(res.status(), await res.text()).toBe(200);
  return String((await res.json()).embed_path);
}

export function surfaceUrl(f: Fixture, s: Surface) {
  if (s === 'builder') return `/dashboards/${f.id}`;
  if (s === 'd') return `/d/${f.token}`;
  if (s === 'embed') return `/embed/${f.token}`;
  return f.emb;
}

/** Open a surface and return every tile's answer once the page has settled. */
export async function openSurface(page: Page, f: Fixture, s: Surface, tiles: number[]): Promise<TileRows> {
  const rows = collectTiles(page);
  await page.goto(surfaceUrl(f, s));
  await settle(page, s === 'builder' ? '[data-dashboard-canvas-root]' : 'body');
  await waitForTiles(rows, tiles, s);
  return freeze(rows);
}

// ── parameter switchers (author side) ────────────────────────────────────────

export async function addSwitcher(request: APIRequestContext, dashboardId: number, cfg: Record<string, unknown>, y: number) {
  const res = await request.post(`${DASH}/${dashboardId}/widgets`, {
    data: { widget_type: 'parameter_switcher', widget_config: { layout: 'dropdown', ...cfg }, layout: { x: 0, y, w: 12, h: 3 } },
  });
  expect(res.status(), await res.text()).toBeLessThan(400);
  const dash = await res.json();
  return (dash.dashboard_charts as any[]).find((dc) => dc.widget_config?.paramName === cfg.paramName).id as number;
}

export async function bindWhatIf(request: APIRequestContext, dashboardId: number, tile: number, bindings: Array<{ param: string; role: 'dimension' | 'metric' }>) {
  const res = await request.patch(`${DASH}/${dashboardId}/charts/${tile}/parameters?draft=true`, {
    data: { parameters: { __whatifBindings: bindings } },
  });
  expect(res.status(), await res.text()).toBeLessThan(400);
}

export async function addChartTile(request: APIRequestContext, dashboardId: number, chartId: number, layout: Record<string, number>) {
  const res = await request.post(`${DASH}/${dashboardId}/charts`, { data: { chart_id: chartId, layout } });
  expect(res.status(), await res.text()).toBeLessThan(400);
  const dash = await res.json();
  const ids = (dash.dashboard_charts as any[]).filter((dc) => dc.chart_id === chartId).map((dc) => dc.id as number);
  return Math.max(...ids);
}

/** Choose a value on a parameter switcher through the UI. */
export async function chooseParam(page: Page, switcherTile: number, value: string) {
  const select = page.locator(`[data-grid-item-id="${switcherTile}"] select`).first();
  await select.scrollIntoViewIfNeeded();
  await expect(select, `switcher ${switcherTile} is not interactive`).toBeEnabled();
  await select.selectOption(value);
  // The control holds the value; tiles re-ask once they are in view — callers
  // re-read every tile (collectTiles + settle + waitForTiles) afterwards.
  await expect(select).toHaveValue(value);
}
