import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API } from './_helpers';

/**
 * Dashboard presentation — the product promise, measured on the RENDERED page.
 *
 *   A user lays out a dashboard, asks AI Design for a look, previews, applies,
 *   saves a draft, publishes, and opens /d and /embed: they see exactly what they
 *   approved — no layout the AI was not allowed to change, no lost lock, no
 *   half-published state.
 *
 * The contract script (`frontend/scripts/check-presentation-contract.mjs`)
 * proves the rules on paper. This spec drives the real builder and the real
 * public report against a real API and database and measures the DOM:
 * rectangles, frame attributes, theme attributes, and the render audit
 * (`window.__APPBI_RENDER_AUDIT__`) for clipping, overflow, readable size,
 * overlap and title contrast.
 *
 * WHAT IS STUBBED: only the planner call (`/presentation-plan`) — the one call
 * that would spend money on a model and answer differently every run. Its reply
 * is a fixed plan in the shape the planner returns, so everything AFTER the
 * model is under test: permission clamp, build, preview, apply, draft, publish.
 *
 * FIXTURE: `backend/scripts/ci/seed_e2e_presentation.py` seeds "E2E Presentation
 * fixture" (real data, 3 KPIs, time series, donut, bar, table, section header,
 * slicer) — CI runs it. Every test works on a DUPLICATE and deletes it, so the
 * fixture and the database stay as found. When the fixture is missing on CI the
 * suite FAILS: a presentation gate that skips reports a pass for a check that
 * never ran.
 */

const DASH = `${API}/api/v1/dashboards`;
const FIXTURE = 'E2E Presentation fixture';
const SHOTS = path.join(__dirname, '..', 'test-results', 'presentation');

/** A grid item: position relative to its grid, size in px, and its look. */
type Box = { id: string; x: number; y: number; w: number; h: number; frame: string | null; surface: string | null };
type Audit = {
  tiles: Array<{ tileId: number | null; kind: string; frame: string; titleFontPx?: number; titleColor?: string }>;
  findings: Array<{ code: string; tileId: number | null; detail: string }>;
};

const HARD = new Set(['tile.overlap', 'tile.offCanvas', 'text.lowContrast', 'title.clipped', 'content.overflow']);

let fixtureId: number | null = null;

async function findFixture(request: APIRequestContext): Promise<number | null> {
  const res = await request.get(`${DASH}/?limit=200`);
  if (res.status() >= 400) return null;
  const items: any[] = await res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
  return items.find((d) => d.name === FIXTURE)?.id ?? null;
}

/** A fresh copy of the fixture for one test, with its own public link. */
async function freshCopy(request: APIRequestContext) {
  const dup = await request.post(`${DASH}/${fixtureId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const copy = await dup.json();
  const link = await request.post(`${DASH}/${copy.id}/public-links`, { data: { name: 'e2e presentation' } });
  expect(link.status(), await link.text()).toBeLessThan(400);
  const tiles: Array<{ id: number; type: string; widget: string; layout: any }> = (copy.dashboard_charts ?? []).map((dc: any) => ({
    id: dc.id, type: String(dc.chart?.chart_type ?? '').toUpperCase(), widget: String(dc.widget_type ?? 'chart'), layout: dc.layout,
  }));
  return {
    id: copy.id as number,
    token: (await link.json()).token as string,
    tiles,
    kpis: tiles.filter((t) => t.widget === 'chart' && t.type === 'KPI').map((t) => t.id),
    charts: tiles.filter((t) => t.widget === 'chart' && !['KPI', 'TABLE'].includes(t.type)).map((t) => t.id),
    table: tiles.find((t) => t.type === 'TABLE')!.id,
  };
}

async function boxes(page: Page, scope = '[data-dashboard-canvas-root]'): Promise<Box[]> {
  return page.$$eval(`${scope} [data-grid-item-id]`, (els) => els
    .filter((el) => !el.closest('[aria-hidden="true"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      // Position RELATIVE TO THE GRID, not the page: chrome above the grid (a
      // filter bar the new theme draws a few px shorter) may shift the whole
      // grid; that is not a tile moving. Size is absolute.
      const grid = el.closest('.react-grid-layout')?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const tile = el.querySelector('[data-tile-id]');
      return {
        id: el.getAttribute('data-grid-item-id') || '',
        x: Math.round(r.left - grid.left), y: Math.round(r.top - grid.top),
        w: Math.round(r.width), h: Math.round(r.height),
        frame: tile ? tile.getAttribute('data-tile-frame') : null,
        surface: tile ? tile.getAttribute('data-tile-surface') : null,
      };
    })
    .filter((b) => b.id && b.w > 0)
    .sort((a, b) => Number(a.id) - Number(b.id)));
}

const rects = (list: Box[]) => list.map((b) => [b.id, b.x, b.y, b.w, b.h]);
const looks = (list: Box[]) => list.map((b) => [b.id, b.frame, b.surface]);

async function themeMode(page: Page): Promise<string | null> {
  return page.locator('[data-dashboard-theme]').first().getAttribute('data-dashboard-theme');
}

async function settled(page: Page) {
  await page.waitForSelector('[data-tile-id]', { timeout: 60_000 });
  // Tiles below the fold mount lazily. Walk every scroll container to the
  // bottom and back so each tile is rendered before anything is measured.
  await page.evaluate(async () => {
    // The builder scrolls <main>; the public report scrolls its own panel.
    const scrollable = (el: Element) => {
      const oy = getComputedStyle(el).overflowY;
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4 && !el.closest('[data-tile-id]');
    };
    const scrollers = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div')).filter(scrollable)]
      .filter((el): el is Element => !!el && el.scrollHeight > el.clientHeight);
    for (const el of scrollers) {
      for (let y = 0; y <= el.scrollHeight; y += Math.max(200, el.clientHeight / 2)) {
        el.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      el.scrollTo(0, 0);
    }
  });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[data-grid-item-id]'))
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .every((el) => el.querySelector('[data-tile-id]')),
    undefined, { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => !document.querySelector('[data-tile-id] .animate-spin, [data-tile-id] [aria-busy="true"]'),
    undefined, { timeout: 60_000 },
  );
  await page.waitForTimeout(700); // react-grid-layout transforms settle
}

async function audit(page: Page): Promise<Audit> {
  const result = await page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null);
  expect(result, 'the render audit is not exposed on this page').not.toBeNull();
  return result as Audit;
}

function hardDefects(result: Audit) {
  return result.findings.filter((f) => HARD.has(f.code));
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function openBuilder(page: Page, id: number) {
  await page.goto(`/dashboards/${id}`);
  await settled(page);
}

async function openAi(page: Page) {
  await page.getByTestId('design-mode-ai').click();
  await expect(page.getByTestId('ai-design-input')).toBeVisible();
}

/** Ask with a fixed planner reply; wait for the answer and the preview paint. */
async function ask(page: Page, prompt: string, plan: unknown) {
  await page.unroute('**/presentation-plan').catch(() => {});
  await page.route('**/presentation-plan', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ plan }),
  }));
  const before = await page.getByTestId('ai-design-layer').count();
  await page.getByTestId('ai-design-input').fill(prompt);
  await page.getByTestId('ai-design-send').click();
  await expect.poll(() => page.getByTestId('ai-design-layer').count(), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId('ai-design-apply')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // preview paint + post-render quality pass
}

const premiumDark = (kpis: number[], charts: number[]) => ({
  // The model over-reaches: sections it was never allowed to use at `style`.
  layer: 'redesign',
  direction: { style: 'saas', density: 'balanced' },
  sections: [{ primitive: 'full_width', visuals: [...kpis, ...charts] }],
  themeIntent: { template: 'console', colorway: 'graphite' },
  tileStyles: Object.fromEntries([
    ...kpis.map((id) => [id, { tileFrame: 'flush' }]),
    ...charts.slice(0, 2).map((id) => [id, { tileFrame: 'subtle' }]),
  ]),
  rationale: 'Premium dark SaaS look; layout unchanged.',
});

async function publicView(page: Page, url: string) {
  await page.goto(url);
  await settled(page);
  return { list: await boxes(page, 'body'), mode: await themeMode(page), result: await audit(page) };
}

async function publish(page: Page) {
  await page.getByTestId('dashboard-publish').click();
  // Nothing pending any more → the draft controls disappear.
  await expect(page.getByTestId('dashboard-publish')).toHaveCount(0, { timeout: 30_000 });
}

test.describe.serial('dashboard presentation — draft, publish, parity, quality', () => {
  test.beforeAll(async ({ request }) => {
    fixtureId = await findFixture(request);
    if (fixtureId == null && process.env.CI) {
      throw new Error(`"${FIXTURE}" is missing — the e2e workflow must run backend/scripts/ci/seed_e2e_presentation.py`);
    }
  });

  test.beforeEach(async () => {
    test.skip(fixtureId == null, `"${FIXTURE}" not seeded locally — run backend/scripts/ci/seed_e2e_presentation.py`);
  });

  test('the render audit catches a real rendered defect', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      await openBuilder(page, copy.id);
      await page.evaluate(() => {
        const root = document.querySelector('[data-dashboard-canvas-root]')!;
        const el = document.createElement('div');
        el.setAttribute('data-tile-id', '-1');
        el.setAttribute('data-tile-kind', 'chart');
        el.style.cssText = 'width:120px;height:90px;background:#fff;position:relative';
        el.innerHTML = '<h3 data-pdf-tile-title style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d8;width:100px">Doanh thu theo khu vực và kênh bán hàng</h3>'
          + '<div data-tile-body style="overflow:hidden;height:20px"><div style="height:200px"></div></div>';
        root.appendChild(el);
      });
      const mine = (await audit(page)).findings.filter((f) => f.tileId === -1).map((f) => f.code).sort();
      expect(mine).toEqual(['content.overflow', 'text.lowContrast', 'tile.tooSmall', 'title.clipped']);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('STYLE → preview == apply → Save draft → reload: layout kept, look saved, public untouched', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      await openBuilder(page, copy.id);
      const before = await boxes(page);
      const publishedMode = await themeMode(page);
      expect(hardDefects(await audit(page)), 'the fixture itself renders with defects').toEqual([]);
      await shot(page, '1-builder-authored');

      await openAi(page);
      await ask(page, 'Làm dashboard này đẹp hơn, kiểu SaaS cao cấp', premiumDark(copy.kpis, copy.charts));
      await expect(page.getByTestId('ai-design-layer').last()).toHaveAttribute('data-layer', 'style');
      const preview = await boxes(page);
      expect(rects(preview), 'a style-only preview moved or resized a tile').toEqual(rects(before));
      for (const id of copy.kpis) expect(preview.find((b) => b.id === String(id))?.frame).toBe('flush');
      expect(await themeMode(page), 'the theme did not change in the preview').toBe('dark');
      expect(hardDefects(await audit(page)), 'the design introduced rendered defects').toEqual([]);
      await shot(page, '2-builder-style-preview');

      await page.getByTestId('ai-design-apply').click();
      await page.waitForTimeout(800);
      const applied = await boxes(page);
      expect(rects(applied), 'Apply moved what the preview did not').toEqual(rects(preview));
      expect(looks(applied), 'Apply looks different from the preview').toEqual(looks(preview));
      expect(await themeMode(page)).toBe('dark');
      await page.getByTestId('dashboard-save-draft').click();
      await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });

      // Reload: the draft is what the editor sees…
      await page.reload();
      await settled(page);
      const reloaded = await boxes(page);
      expect(rects(reloaded), 'the saved draft moved tiles').toEqual(rects(before));
      expect(looks(reloaded), 'the saved draft lost the approved look').toEqual(looks(applied));
      expect(await themeMode(page), 'the saved draft lost the theme').toBe('dark');
      // …and not what the public sees (neither Apply nor Save draft publishes).
      const pub = await publicView(page, `/d/${copy.token}`);
      expect(pub.mode, 'Save draft published the theme').toBe(publishedMode);
      expect(pub.list.filter((b) => b.frame === 'flush').length, 'Save draft published tile frames').toBe(0);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('PUBLISH → reload; /d and /embed show exactly the approved presentation, matching the builder', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      // A viewer opens the report BEFORE the author publishes — the public
      // structure is cached per token. Publishing must still be visible on the
      // viewer's next load, not a TTL later.
      for (const route of [`/d/${copy.token}`, `/embed/${copy.token}`]) {
        const early = await publicView(page, route);
        expect(early.mode, 'fixture: the report should start light').toBe('light');
      }
      await openBuilder(page, copy.id);
      await openAi(page);
      await ask(page, 'make it look premium and dark', premiumDark(copy.kpis, copy.charts));
      await page.getByTestId('ai-design-apply').click();
      await page.waitForTimeout(600);
      await publish(page);

      await page.reload();
      await settled(page);
      const builder = await boxes(page);
      const builderAudit = await audit(page);
      expect(await themeMode(page)).toBe('dark');
      const order = (list: Box[]) => [...list].sort((a, c) => a.y - c.y || a.x - c.x).map((b) => b.id);

      for (const [route, name] of [[`/d/${copy.token}`, 'd'], [`/embed/${copy.token}`, 'embed']] as const) {
        const pub = await publicView(page, route);
        expect(pub.mode, `${name}: the published theme is not the approved one`).toBe('dark');
        const pubById = new Map(pub.list.map((b) => [b.id, b]));
        for (const b of builder) {
          const p = pubById.get(b.id);
          expect(p, `${name}: tile ${b.id} is missing`).toBeTruthy();
          expect(p!.frame, `${name}: tile ${b.id} frame differs from the builder`).toBe(b.frame);
          expect(p!.surface, `${name}: tile ${b.id} surface differs from the builder`).toBe(b.surface);
        }
        expect(order(pub.list), `${name}: reading order differs from the builder`).toEqual(order(builder));
        const pubTitles = new Map(pub.result.tiles.map((t) => [t.tileId, t]));
        let compared = 0;
        for (const t of builderAudit.tiles) {
          const p = pubTitles.get(t.tileId);
          if (!p || t.kind === 'widget' || !t.titleFontPx || !p.titleFontPx) continue;
          compared += 1;
          expect(p.titleFontPx, `${name}: tile ${t.tileId} title size differs`).toBe(t.titleFontPx);
          expect(p.titleColor, `${name}: tile ${t.tileId} title colour differs`).toBe(t.titleColor);
        }
        expect(compared, `${name}: no title could be compared`).toBeGreaterThan(0);
        expect(hardDefects(pub.result), `${name}: published defects`).toEqual([]);
        await shot(page, `3-published-${name}-1440`);
      }
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('THEME-ONLY: a theme change alone can be saved as a draft and survives reload', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      await openBuilder(page, copy.id);
      const before = await boxes(page);
      await openAi(page);
      await ask(page, 'dark mode please', { layer: 'style', direction: {}, themeIntent: { colorway: 'midnight' } });
      await page.getByTestId('ai-design-apply').click();
      await expect(page.getByTestId('dashboard-save-draft')).toBeEnabled();
      await page.getByTestId('dashboard-save-draft').click();
      await expect(page.getByTestId('dashboard-save-draft')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await page.reload();
      await settled(page);
      expect(await themeMode(page), 'a theme-only draft was lost on reload').toBe('dark');
      expect(rects(await boxes(page))).toEqual(rects(before));
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('DISCARD and UNDO leave no trace; MULTI-TURN composes without resurrecting a removed style', async ({ page, request }) => {
    const copy = await freshCopy(request);
    const target = String(copy.charts[0]);
    try {
      await openBuilder(page, copy.id);
      const before = await boxes(page);
      const mode = await themeMode(page);
      await openAi(page);

      await ask(page, 'make the trend chart dark', { layer: 'style', direction: {}, tileStyles: { [target]: { chartSurface: 'dark' } } });
      expect((await boxes(page)).find((b) => b.id === target)?.surface).toBe('dark');
      await page.getByTestId('ai-design-discard').click();
      await page.waitForTimeout(500);
      expect(looks(await boxes(page)), 'Discard left the preview behind').toEqual(looks(before));
      expect(await themeMode(page)).toBe(mode);

      // Two turns before Apply: turn 2's theme change resets per-tile surfaces.
      await ask(page, 'make the trend chart dark', { layer: 'style', direction: {}, tileStyles: { [target]: { chartSurface: 'dark' } } });
      await ask(page, 'now switch the whole report to indigo', { layer: 'style', direction: {}, themeIntent: { colorway: 'indigo', accent: '#1E3A8A' } });
      const composed = await boxes(page);
      expect(composed.find((b) => b.id === target)?.surface, 'turn 1 surface came back after turn 2 reset it').toBeNull();
      await page.getByTestId('ai-design-apply').click();
      await page.waitForTimeout(600);
      expect(looks(await boxes(page)), 'Apply differs from the two-turn preview').toEqual(looks(composed));

      await page.keyboard.press('Control+z');
      await page.waitForTimeout(600);
      expect(looks(await boxes(page)), 'Undo did not restore the pre-AI look').toEqual(looks(before));
      expect(rects(await boxes(page))).toEqual(rects(before));
      expect(await themeMode(page), 'Undo did not restore the theme').toBe(mode);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('LOCK: structure and redesign never move a locked visual, and the lock survives publish', async ({ page, request }) => {
    const copy = await freshCopy(request);
    // Lock the table; ask to move the region bar to the top AND to enlarge the
    // locked table. The bar can legitimately go to the top; the table must not
    // move or grow.
    const locked = copy.table;
    const bar = copy.tiles.find((x) => x.type === 'BAR')!.id;
    const t = copy.tiles.find((x) => x.id === locked)!;
    try {
      const put = await request.put(`${DASH}/${copy.id}/layout`, { data: { chart_layouts: [{ id: locked, layout: { ...t.layout, locked: true } }] } });
      expect(put.status(), await put.text()).toBeLessThan(400);
      await openBuilder(page, copy.id);
      const before = await boxes(page);
      const lockedRect = (list: Box[]) => rects(list).find((r) => r[0] === String(locked));
      await openAi(page);
      await ask(page, 'Đưa biểu đồ khu vực lên trên cùng và làm bảng lớn hơn', {
        layer: 'structure', direction: {},
        structure: { operations: [{ op: 'move_to_top', visuals: [bar] }, { op: 'resize', visuals: [locked], size: 'larger' }] },
      });
      await expect(page.getByTestId('ai-design-layer').last()).toHaveAttribute('data-layer', 'structure');
      let now = await boxes(page);
      expect(lockedRect(now), 'structure moved the locked visual').toEqual(lockedRect(before));
      expect(now.find((b) => b.id === String(bar))!.y, 'the bar did not move to the top').toBeLessThan(before.find((b) => b.id === String(bar))!.y);
      expect((await audit(page)).findings.filter((f) => f.code === 'tile.overlap')).toEqual([]);
      await page.getByTestId('ai-design-discard').click();

      await ask(page, 'Redesign this page for the CEO', {
        layer: 'redesign', direction: { style: 'executive', density: 'balanced' },
        sections: [
          { primitive: 'kpi_strip', visuals: copy.kpis },
          { primitive: 'full_width', visuals: copy.charts },
          { primitive: 'table_full', visuals: [locked] },
        ],
      });
      await expect(page.getByTestId('ai-design-layer').last()).toHaveAttribute('data-layer', 'redesign');
      now = await boxes(page);
      expect(lockedRect(now), 'redesign moved the locked visual').toEqual(lockedRect(before));
      expect((await audit(page)).findings.filter((f) => f.code === 'tile.overlap')).toEqual([]);
      await page.getByTestId('ai-design-apply').click();
      await page.waitForTimeout(600);
      await publish(page);
      const live = await (await request.get(`${DASH}/${copy.id}`)).json();
      const liveTile = live.dashboard_charts.find((dc: any) => dc.id === locked);
      expect(liveTile.layout.locked, 'publishing the redesign dropped the lock').toBe(true);
      expect([liveTile.layout.x, liveTile.layout.y, liveTile.layout.w, liveTile.layout.h])
        .toEqual([t.layout.x, t.layout.y, t.layout.w, t.layout.h]);
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('MULTI-SELECTION: only the selected visuals change; the theme is left alone', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      await openBuilder(page, copy.id);
      const before = await boxes(page);
      const mode = await themeMode(page);
      await openAi(page);
      const [a, b, c] = copy.kpis;
      await page.locator(`[data-tile-id="${a}"]`).click();
      await page.locator(`[data-tile-id="${b}"]`).click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('ai-design-target')).toContainText('2');
      // The model reaches for an unselected KPI and the theme too.
      await ask(page, 'make these frameless', {
        layer: 'style', direction: {},
        tileStyles: { [a]: { tileFrame: 'flush' }, [b]: { tileFrame: 'flush' }, [c]: { tileFrame: 'flush' } },
        themeIntent: { colorway: 'graphite' },
      });
      const now = await boxes(page);
      expect(now.find((x) => x.id === String(a))?.frame).toBe('flush');
      expect(now.find((x) => x.id === String(b))?.frame).toBe('flush');
      expect(now.find((x) => x.id === String(c))?.frame, 'an unselected visual changed')
        .toBe(before.find((x) => x.id === String(c))?.frame);
      expect(await themeMode(page), 'a selection-scoped request repainted the report').toBe(mode);
      expect(rects(now)).toEqual(rects(before));
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });

  test('RESPONSIVE: the published report stays readable on desktop, tablet and phone (/d and /embed)', async ({ page, request }) => {
    const copy = await freshCopy(request);
    try {
      for (const [route, name] of [[`/d/${copy.token}`, 'd'], [`/embed/${copy.token}`, 'embed']] as const) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await page.goto(route);
          await settled(page);
          const result = await audit(page);
          const bad = result.findings.filter((f) => ['tile.overlap', 'tile.offCanvas', 'tile.tooSmall', 'content.overflow', 'text.lowContrast'].includes(f.code));
          expect(bad, `${name} @${viewport.width}px: ${JSON.stringify(bad)}`).toEqual([]);
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(sideways, `${name} @${viewport.width}px scrolls sideways`).toBeLessThanOrEqual(1);
          if (name === 'd') await shot(page, `4-published-${viewport.width}`);
        }
      }
    } finally {
      await request.delete(`${DASH}/${copy.id}`).catch(() => {});
    }
  });
});
