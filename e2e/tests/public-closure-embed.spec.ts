import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  collectTiles, deleteTestPats, dropReport, freshReport, mintTestPat, openSurface, settle, V1, waitForTiles, type Fixture,
} from './_public-closure';

/**
 * Dashboard Public closure — the INTEGRATION embed in a real browser, and the
 * responsive contract with the Builder taking part.
 *
 * Origins: a real parent page is served from this test process on its own port
 * (a different site from the report), framing /embed/emb_… exactly as a host
 * application does. Nothing is route-mocked: the request goes through Next's
 * middleware, its policy lookup, the backend and Postgres.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';

test.describe.configure({ mode: 'serial', timeout: 600_000 });

let f: Fixture | null = null;
const servers: http.Server[] = [];

/** A host application on 127.0.0.1:<port>; set `.src` before loading it. */
async function hostPage(src = 'about:blank'): Promise<{ origin: string; url: string; setSrc: (s: string) => void }> {
  let current = src;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0">
      <iframe id="report" src="${current}" style="width:1280px;height:900px;border:0"
        referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/`, setSrc: (s) => { current = s; } };
}

/** A PAT of its own (an allowlist declared at mint is remembered on the PAT); tracked for teardown. */
const ownPat = (request: APIRequestContext) => mintTestPat(request, 'origin');

async function mint(request: APIRequestContext, pat: string, body: Record<string, unknown>) {
  const res = await request.post(`${V1}/integrations/embed/resolve`, {
    headers: { Authorization: `Bearer ${pat}` }, data: { dashboard_id: f!.id, full_report: true, ...body },
  });
  expect(res.status(), await res.text()).toBe(200);
  return String((await res.json()).embed_path);
}

async function frameShowsReport(page: Page): Promise<boolean> {
  const frame = page.frameLocator('#report');
  try {
    await frame.locator('[data-tile-id]').first().waitFor({ timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async ({ request }) => {
  f = await freshReport(request);
});

test.afterAll(async ({ request }) => {
  for (const s of servers) s.close();
  await dropReport(request, f);
  await deleteTestPats(request);
});

test('integration embed: a real PAT mint renders every tile with data in the browser', async ({ page }) => {
  const tiles = f!.charts.map((c) => c.tile);
  const rows = await openSurface(page, f!, 'emb', tiles);
  expect(rows.size).toBe(tiles.length);
  // The grant is refused as a public page.
  const d = await page.goto(f!.emb.replace('/embed/', '/d/'));
  expect(d?.status(), '/d/emb_… must be refused').toBe(404);
  await expect(page.locator('body')).toContainText(/\/embed\//);
});

test('origin allowlist: the declared host frames the report; another site and a direct open are refused', async ({ page, request }) => {
  const allowed = await hostPage();
  const other = await hostPage();
  const pat = await ownPat(request);
  const path = await mint(request, pat.token, { allowed_origins: [allowed.origin] });
  allowed.setSrc(`${BASE}${path}`);
  other.setSrc(`${BASE}${path}`);

  await page.goto(allowed.url);
  expect(await frameShowsReport(page), 'the declared host could not frame the report').toBe(true);

  await page.goto(other.url);
  expect(await frameShowsReport(page), 'an undeclared site framed the report').toBe(false);

  const direct = await page.goto(`${BASE}${path}`);
  expect(direct?.status(), 'opened directly in a tab').toBe(403);
  expect(await page.locator('[data-tile-id]').count()).toBe(0);
});

test('a restricted grant whose policy cannot be read is refused, never served unrestricted', async ({ page, request }) => {
  const site = await hostPage();
  const pat = await ownPat(request);
  const path = await mint(request, pat.token, { allowed_origins: [site.origin] });
  const token = path.replace('/embed/', '');
  // Exhaust this grant's policy lookups (rate-limited per token) so the
  // middleware's fresh lookup fails — a real failure, not a mocked one.
  const api = process.env.E2E_API_URL || 'http://localhost:8000';
  let limited = false;
  for (let i = 0; i < 700 && !limited; i++) {
    const r = await request.get(`${api}/api/v1/public/embed/${token}/policy`);
    if (r.status() === 429) limited = true;
  }
  expect(limited, 'could not provoke a policy-lookup failure').toBe(true);
  const res = await page.goto(`${BASE}${path}`, { referer: site.url });
  expect(res?.status(), 'a policy failure must not downgrade to an open report').toBe(503);
  expect(await page.locator('[data-tile-id]').count()).toBe(0);
});

test('revoking the PAT ends the grant it minted in the browser', async ({ page, request }) => {
  const pat = await ownPat(request);
  const path = await mint(request, pat.token, {});
  const rows = collectTiles(page);
  await page.goto(path);
  await settle(page);
  await waitForTiles(rows, [f!.charts[0].tile], 'emb before revoke');
  const del = await request.delete(`${V1}/auth/personal-access-tokens/${pat.id}`);
  expect(del.status(), await del.text()).toBeLessThan(300);
  // The data boundary closes at once: every public route refuses the grant.
  const token = path.replace('/embed/', '');
  const api = process.env.E2E_API_URL || 'http://localhost:8000';
  expect((await request.get(`${api}/api/v1/public/dashboards/${token}/snapshots/info`)).status(),
    'a grant of a revoked PAT still reads data').toBe(410);
  // In the browser: no tile is served (the document may come from the framing
  // policy cache for up to 60s for an UNRESTRICTED grant — nothing to frame-guard
  // there — but it renders no data).
  const answered = collectTiles(page);
  await page.goto(path);
  await expect(page.locator('body')).toContainText(/revoked|expired|thu hồi|hết hạn/i, { timeout: 30_000 });
  expect(await page.locator('[data-tile-id]').count(), 'a revoked grant rendered tiles').toBe(0);
  expect(answered.size, 'a revoked grant was answered with data').toBe(0);
});

test('responsive: the Builder canvas, /d, /embed and emb_ lay out the same tiles at 1440, 820 and 390', async ({ page }) => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    const geo: Record<string, Array<{ id: string; h: number; w: number; top: number; left: number }>> = {};
    for (const [name, url, scope] of [
      // The Builder's READ canvas: the Builder route with editing off and the
      // published projection on (what Studio frames) — the report the author approves.
      ['builder', `/dashboards/${f!.id}?studio=preview`, '[data-dashboard-canvas-root]'],
      ['d', `/d/${f!.token}`, 'body'],
      ['embed', `/embed/${f!.token}`, 'body'],
      ['emb', f!.emb, 'body'],
    ] as const) {
      await page.goto(url);
      await settle(page, scope);
      const items = await page.$$eval(`${scope} [data-grid-item-id]`, (els) => els
        .filter((el) => !el.closest('[aria-hidden="true"]'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          const g = el.closest('.react-grid-layout')!.getBoundingClientRect();
          return { id: el.getAttribute('data-grid-item-id') || '', h: Math.round(r.height), w: Math.round(r.width),
            top: Math.round(r.top - g.top), left: Math.round(r.left - g.left), gw: Math.round(g.width) };
        }));
      // No overlap, nothing off canvas, no horizontal page scroll.
      for (const a of items) {
        expect(a.left + a.w, `${name}@${vp.width}: tile ${a.id} runs off the canvas`).toBeLessThanOrEqual((a as any).gw + 2);
        for (const b of items) {
          if (a === b) continue;
          const overlap = a.left < b.left + b.w - 2 && b.left < a.left + a.w - 2 && a.top < b.top + b.h - 2 && b.top < a.top + a.h - 2;
          expect(overlap, `${name}@${vp.width}: tiles ${a.id} and ${b.id} overlap`).toBe(false);
        }
      }
      if (name !== 'builder') {
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(scroll, `${name}@${vp.width}: horizontal page scroll`).toBeLessThanOrEqual(1);
      }
      geo[name] = items.sort((x, y) => x.top - y.top || x.left - y.left);
    }
    const order = (n: string) => geo[n].map((t) => t.id);
    for (const n of ['d', 'embed', 'emb']) {
      expect(new Set(order(n)), `${n}@${vp.width}: different tiles than the Builder`).toEqual(new Set(order('builder')));
      expect(order(n), `${n}@${vp.width}: reading order differs from the Builder`).toEqual(order('builder'));
      const byId = new Map(geo[n].map((t) => [t.id, t]));
      for (const b of geo.builder) {
        const p = byId.get(b.id)!;
        // Same row metric on every width: tile heights agree within a rounding margin.
        expect(Math.abs(p.h - b.h), `${n}@${vp.width}: tile ${b.id} height ${p.h} vs Builder ${b.h}`).toBeLessThanOrEqual(Math.max(4, b.h * 0.04));
      }
    }
  }
});
