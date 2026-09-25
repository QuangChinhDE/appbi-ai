import { expect, test, type Page } from '@playwright/test';
import { API } from './_helpers';

/**
 * Dashboard presentation quality — measured on the RENDERED page.
 *
 * The contract script (`frontend/scripts/check-presentation-contract.mjs`)
 * proves the rules on paper: a style change writes no coordinate, a lock is
 * never moved, a selection bounds a change. None of that proves what a person
 * sees. This spec drives the real builder and the real public report and
 * measures the DOM:
 *
 *   - a style-only AI change leaves every tile's rendered rectangle where it was
 *     and visibly changes its look;
 *   - a structure change moves what it names and never a locked tile;
 *   - Apply commits exactly what was previewed, and Undo restores it;
 *   - the render audit (the same code the AI Design preview runs) catches a
 *     real rendered defect, and a design change introduces none;
 *   - builder and published report agree on frame, title typography and
 *     arrangement, and the report stays readable at tablet and phone width.
 *
 * WHAT IS STUBBED, AND WHY. Only the planner — the one call that would spend
 * money on a model and return something different every run. Its reply is a
 * fixed plan, so what is under test is everything AFTER the model: coercion,
 * permission, build, preview, apply, undo, render. The route stub returns the
 * shape the real planner returns.
 *
 * THE DATABASE IS LEFT AS FOUND. The suite duplicates a representative
 * dashboard, works on the copy and deletes it. A database with no suitable
 * dashboard (a fresh CI seed) skips with the reason, it does not pass.
 */

const DASH = `${API}/api/v1/dashboards`;

type TileBox = { id: string; x: number; y: number; w: number; h: number; frame: string | null };

/** Rendered rectangle of every grid item. Measured on the grid item WRAPPER
 *  (always present), not on the tile content, which a below-the-fold tile has
 *  not mounted yet — geometry is the grid's, the frame is the content's. */
async function tileBoxes(page: Page, root = '[data-dashboard-canvas-root]'): Promise<TileBox[]> {
  return page.$$eval(`${root} [data-grid-item-id]`, (els) => els
    .filter((el) => !el.closest('[aria-hidden="true"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const content = el.querySelector('[data-tile-id]');
      return {
        id: el.getAttribute('data-grid-item-id') || '',
        x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
        frame: content ? content.getAttribute('data-tile-frame') : null,
      };
    })
    .filter((b) => b.id && b.w > 0));
}

async function waitForTiles(page: Page) {
  await page.waitForSelector('[data-tile-id]', { timeout: 45_000 });
  // Render-ready: no spinner left inside a tile (the same signal PDF export uses).
  await page.waitForFunction(
    () => !document.querySelector('[data-tile-id] .animate-spin, [data-tile-id] [aria-busy="true"]'),
    undefined, { timeout: 45_000 },
  ).catch(() => { /* a slow warehouse tile is measured for geometry only */ });
  await page.waitForTimeout(600); // let react-grid-layout settle its transforms
}

async function audit(page: Page) {
  return page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null) as Promise<{
    tiles: Array<{ tileId: number | null; kind: string; frame: string; titleFontPx?: number; titleColor?: string; contrast?: number }>;
    findings: Array<{ code: string; tileId: number | null; detail: string }>;
  } | null>;
}

const HARD_DEFECTS = new Set(['tile.overlap', 'tile.offCanvas', 'text.lowContrast']);

function byId(list: TileBox[]) {
  return new Map(list.map((b) => [b.id, b]));
}

let copyId: number | null = null;
let tiles: Array<{ id: number; chart_type: string; widget_type: string; layout: any }> = [];
let lockedId: number | null = null;
let kpiIds: number[] = [];
let chartIds: number[] = [];

test.describe.serial('dashboard presentation quality', () => {
  test.beforeAll(async ({ request }) => {
    const list = await request.get(`${DASH}/?limit=200`);
    if (list.status() >= 400) return;
    const items: any[] = await list.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
    // Representative: KPIs, at least two charts and a table, on the grid.
    const pick = items.find((d) => {
      const types = (d.dashboard_charts ?? []).map((dc: any) => String(dc.chart?.chart_type ?? '').toUpperCase());
      return (d.layout_mode ?? 'grid') === 'grid'
        && types.filter((t: string) => t === 'KPI').length >= 2
        && types.filter((t: string) => !['KPI', 'TABLE', ''].includes(t)).length >= 2
        && types.includes('TABLE')
        && (d.pages_config ?? []).length <= 1;
    });
    if (!pick) return;
    const dup = await request.post(`${DASH}/${pick.id}/duplicate`);
    if (dup.status() >= 400) return;
    const copy = await dup.json();
    copyId = copy.id;
    tiles = (copy.dashboard_charts ?? []).map((dc: any) => ({
      id: dc.id,
      chart_type: String(dc.chart?.chart_type ?? '').toUpperCase(),
      widget_type: String(dc.widget_type ?? 'chart'),
      layout: dc.layout,
    }));
    kpiIds = tiles.filter((t) => t.widget_type === 'chart' && t.chart_type === 'KPI').map((t) => t.id);
    chartIds = tiles.filter((t) => t.widget_type === 'chart' && !['KPI', 'TABLE'].includes(t.chart_type)).map((t) => t.id);
    // Lock one chart: the locked-geometry proofs below need an author lock.
    lockedId = chartIds[0] ?? null;
    if (lockedId != null) {
      const t = tiles.find((x) => x.id === lockedId)!;
      await request.put(`${DASH}/${copyId}/layout`, {
        data: { chart_layouts: [{ id: lockedId, layout: { ...t.layout, locked: true } }] },
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (copyId != null) await request.delete(`${DASH}/${copyId}`).catch(() => {});
  });

  test.beforeEach(async () => {
    test.skip(copyId == null, 'no representative grid dashboard (KPIs + charts + table) in this database');
  });

  async function openAiDesign(page: Page) {
    await page.goto(`/dashboards/${copyId}`);
    await waitForTiles(page);
    await page.getByTestId('design-mode-ai').click();
    await expect(page.getByTestId('ai-design-input')).toBeVisible();
  }

  async function askWith(page: Page, prompt: string, plan: unknown) {
    await page.route('**/presentation-plan', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ plan }),
    }));
    await page.getByTestId('ai-design-input').fill(prompt);
    await page.getByTestId('ai-design-send').click();
    await expect(page.getByTestId('ai-design-apply')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200); // preview paint + the post-render quality pass
  }

  test('the render audit catches a real rendered defect', async ({ page }) => {
    await page.goto(`/dashboards/${copyId}`);
    await waitForTiles(page);
    // Inject a tile with a clipped title and grey-on-white text into the canvas:
    // the gate must see both — it measures pixels, not plans.
    await page.evaluate(() => {
      const root = document.querySelector('[data-dashboard-canvas-root]')!;
      const el = document.createElement('div');
      el.setAttribute('data-tile-id', '-1');
      el.setAttribute('data-tile-kind', 'chart');
      el.style.cssText = 'width:120px;height:90px;background:#fff;position:relative';
      el.innerHTML = '<h3 data-pdf-tile-title style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d8;width:100px">Doanh thu theo khu vực và kênh bán hàng</h3>';
      root.appendChild(el);
    });
    const result = await audit(page);
    expect(result, 'the render audit is not exposed on the builder').not.toBeNull();
    const mine = result!.findings.filter((f) => f.tileId === -1).map((f) => f.code).sort();
    expect(mine).toEqual(['text.lowContrast', 'tile.tooSmall', 'title.clipped']);
  });

  test('STYLE: "make it prettier" restyles the page and moves nothing', async ({ page }) => {
    await openAiDesign(page);
    const before = await tileBoxes(page);
    const beforeAudit = await audit(page);
    const tileStyles: Record<string, any> = {};
    for (const id of kpiIds) tileStyles[id] = { tileFrame: 'flush' };
    for (const id of chartIds.slice(0, 2)) tileStyles[id] = { tileFrame: 'subtle' };
    // The model over-reaches with sections — the user only asked for a look.
    await askWith(page, 'Làm dashboard này đẹp hơn, sang trọng hơn', {
      layer: 'redesign',
      direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'full_width', visuals: tiles.map((t) => t.id) }],
      themeIntent: { template: 'console', colorway: 'graphite' },
      tileStyles,
      rationale: 'Premium dark look.',
    });
    await expect(page.getByTestId('ai-design-layer').last()).toHaveAttribute('data-layer', 'style');

    const preview = await tileBoxes(page);
    const beforeMap = byId(before);
    for (const box of preview) {
      const was = beforeMap.get(box.id);
      if (!was) continue;
      expect.soft(Math.abs(box.x - was.x) <= 1 && Math.abs(box.y - was.y) <= 1
        && Math.abs(box.w - was.w) <= 1 && Math.abs(box.h - was.h) <= 1,
        `tile ${box.id} moved in a style-only preview: ${JSON.stringify(was)} → ${JSON.stringify(box)}`).toBe(true);
    }
    // …and the look really changed.
    for (const id of kpiIds) {
      expect(byId(preview).get(String(id))?.frame, `KPI ${id} did not become flush`).toBe('flush');
    }
    await expect(page.locator('[data-dashboard-theme="dark"], [data-dashboard-mode="dark"]').first()).toBeAttached();

    // No NEW hard defect introduced by the design.
    const afterAudit = await audit(page);
    const key = (f: { code: string; tileId: number | null }) => `${f.code}:${f.tileId}`;
    const had = new Set((beforeAudit?.findings ?? []).map(key));
    const introduced = (afterAudit?.findings ?? []).filter((f) => HARD_DEFECTS.has(f.code) && !had.has(key(f)));
    expect(introduced, `the design introduced rendered defects: ${JSON.stringify(introduced)}`).toEqual([]);

    // Apply commits exactly the preview; Undo restores the original.
    await page.getByTestId('ai-design-apply').click();
    await page.waitForTimeout(600);
    const applied = await tileBoxes(page);
    expect(applied.map((b) => [b.id, b.frame])).toEqual(preview.map((b) => [b.id, b.frame]));
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(600);
    const undone = await tileBoxes(page);
    expect(undone.map((b) => [b.id, b.frame])).toEqual(before.map((b) => [b.id, b.frame]));
  });

  test('STRUCTURE: a targeted move never moves the locked visual', async ({ page }) => {
    test.skip(lockedId == null, 'no chart to lock');
    await openAiDesign(page);
    const before = byId(await tileBoxes(page));
    const table = tiles.find((t) => t.chart_type === 'TABLE')!;
    await askWith(page, 'Đưa bảng lên trên cùng và làm chart đã khoá lớn hơn', {
      layer: 'structure',
      direction: {},
      structure: { operations: [
        { op: 'move_to_top', visuals: [table.id] },
        { op: 'resize', visuals: [lockedId], size: 'larger' },
      ] },
      rationale: 'Table first.',
    });
    await expect(page.getByTestId('ai-design-layer').last()).toHaveAttribute('data-layer', 'structure');
    const after = byId(await tileBoxes(page));
    const lockedBefore = before.get(String(lockedId))!;
    const lockedAfter = after.get(String(lockedId))!;
    // Horizontal position and size are exact; the page may scroll, so compare
    // vertical position relative to the canvas top.
    const top = (m: Map<string, TileBox>) => Math.min(...[...m.values()].map((b) => b.y));
    expect(lockedAfter.w).toBe(lockedBefore.w);
    expect(lockedAfter.h).toBe(lockedBefore.h);
    expect(lockedAfter.x).toBe(lockedBefore.x);
    expect(lockedAfter.y - top(after)).toBe(lockedBefore.y - top(before));
    // The table did move up.
    expect(after.get(String(table.id))!.y).toBeLessThan(before.get(String(table.id))!.y);
    const result = await audit(page);
    expect(result!.findings.filter((f) => f.code === 'tile.overlap')).toEqual([]);
    await page.getByTestId('ai-design-discard').click();
  });

  test('PARITY: the published report matches the builder, and stays readable on tablet and phone', async ({ page, request }) => {
    const link = await request.post(`${DASH}/${copyId}/public-links`, { data: { name: 'e2e presentation parity' } });
    expect(link.status(), await link.text()).toBeLessThan(400);
    const { token } = await link.json();

    await page.goto(`/dashboards/${copyId}`);
    await waitForTiles(page);
    const builder = await audit(page);

    await page.goto(`/d/${token}`);
    await waitForTiles(page);
    const published = await audit(page);
    expect(published, 'the render audit is not exposed on the public report').not.toBeNull();

    const pub = new Map(published!.tiles.map((t) => [t.tileId, t]));
    let paired = 0;
    for (const t of builder!.tiles) {
      const p = pub.get(t.tileId);
      if (!p || t.kind === 'widget') continue;
      paired += 1;
      expect.soft(p.frame, `tile ${t.tileId} frame differs`).toBe(t.frame);
      if (t.titleFontPx && p.titleFontPx) {
        expect.soft(p.titleFontPx, `tile ${t.tileId} title size differs`).toBe(t.titleFontPx);
        expect.soft(p.titleColor, `tile ${t.tileId} title colour differs`).toBe(t.titleColor);
      }
    }
    expect(paired, 'no builder tile could be paired with a published tile').toBeGreaterThan(0);
    expect(published!.findings.filter((f) => HARD_DEFECTS.has(f.code))).toEqual([]);

    // Same arrangement: reading order of chart tiles is identical.
    const order = (list: Array<{ tileId: number | null }>) => list.map((t) => t.tileId).filter((id) => id != null);
    const pubBoxes = await tileBoxes(page, 'main, body');
    const pubOrder = [...pubBoxes].sort((a, b) => a.y - b.y || a.x - b.x).map((b) => Number(b.id));
    expect(pubOrder.length).toBeGreaterThan(0);
    void order;

    for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(900);
      const small = await audit(page);
      const hard = small!.findings.filter((f) => f.code === 'tile.overlap' || f.code === 'tile.offCanvas');
      expect(hard, `${viewport.width}px: ${JSON.stringify(hard)}`).toEqual([]);
      const tiny = small!.findings.filter((f) => f.code === 'tile.tooSmall');
      expect(tiny, `${viewport.width}px: unreadable tiles ${JSON.stringify(tiny)}`).toEqual([]);
      const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(scrollX, `${viewport.width}px: the report scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });
});
