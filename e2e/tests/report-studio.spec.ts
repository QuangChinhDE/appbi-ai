import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';

/**
 * Report Studio V3 — regression contract on the real stack (no model calls).
 *
 * Everything here is deterministic: a design DIRECTION is a grammar, not a model
 * call, and "start from data" falls back to its rules when no model is set. The
 * product behaviours locked here are the ones a green contract suite used to miss:
 *
 *  - START FROM DATA builds a real report: an opening headline bound to live
 *    findings, a slicer, charts that each ran, a detail table — no typed figure.
 *  - AI-CREATED BLOCKS survive the whole lifecycle, every time, not by luck:
 *    Apply creates → Undo removes → Redo re-creates → Save draft → Reload →
 *    Publish → /d shows them computed.
 *  - STUDIO PREVIEW shows the WHOLE report before and after at 1440/820/390
 *    without moving one tile of the canvas behind it.
 *  - FILTERS move the KPI, the charts and the narrative together (no stale headline).
 *  - EXPORT is taken from the published report, and is a real PDF.
 *
 * Fixture: `seed_e2e_presentation.py` (CI seeds it). Each test works on a copy
 * and deletes what it made. Missing fixture on CI = failure, never a skip.
 */

const DASH = `${API}/api/v1/dashboards`;
const FIXTURE = 'E2E Presentation fixture';
const DATASET = 'E2E presentation sales';
let fixtureId: number | null = null;

async function listDashboards(request: APIRequestContext): Promise<any[]> {
  const res = await request.get(`${DASH}/?limit=200`);
  if (res.status() >= 400) return [];
  return res.json().then((d) => (Array.isArray(d) ? d : d.items ?? []));
}

async function copy(request: APIRequestContext) {
  const dup = await request.post(`${DASH}/${fixtureId}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(400);
  const d = await dup.json();
  const link = await request.post(`${DASH}/${d.id}/public-links`, { data: { name: 'e2e report studio' } });
  expect(link.status()).toBeLessThan(400);
  return { id: d.id as number, token: (await link.json()).token as string };
}

const narratives = async (request: APIRequestContext, id: number) =>
  (await request.get(`${DASH}/${id}`).then((r) => r.json())).dashboard_charts.filter((d: any) => d.widget_type === 'narrative');

async function settled(page: Page) {
  await page.waitForSelector('[data-tile-id], [data-grid-item-id]', { timeout: 60_000 });
  await page.evaluate(async () => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, div'))]
      .filter((e): e is Element => !!e && e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const el of els) {
      for (let y = 0; y <= el.scrollHeight; y += 300) { el.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
      el.scrollTo(0, 0);
    }
  });
  await page.waitForFunction(() => !document.querySelector('[data-grid-item-id] .animate-spin, .dashboard-narrative__item.is-pending'), undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}

async function audit(page: Page) {
  const r = await page.evaluate(() => (window as any).__APPBI_RENDER_AUDIT__?.() ?? null);
  expect(r, 'render audit not exposed').not.toBeNull();
  return r as { tiles: Array<{ tileId: number; kind: string; marks?: number }>; findings: Array<{ code: string; tileId: number }> };
}

// Relative to the grid, so a scroll of the page is not mistaken for a moved tile.
const canvasRects = (page: Page) => page.evaluate(() => {
  const g = document.querySelector('main .react-grid-layout')?.getBoundingClientRect();
  return Object.fromEntries(Array.from(document.querySelectorAll('main [data-grid-item-id]')).map((e) => {
    const r = e.getBoundingClientRect();
    return [e.getAttribute('data-grid-item-id'), [Math.round(r.x - (g?.x ?? 0)), Math.round(r.y - (g?.y ?? 0)), Math.round(r.width), Math.round(r.height)]];
  }));
});

/** The count once it has stopped changing (blocks are created one after another). */
async function stableCount(read: () => Promise<number>) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    const n = await read();
    same = n === last && n > 0 ? same + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 700));
  }
  return last;
}

test.beforeAll(async ({ request }) => {
  fixtureId = (await listDashboards(request)).find((d) => d.name === FIXTURE)?.id ?? null;
  if (!fixtureId && process.env.CI) throw new Error(`fixture "${FIXTURE}" missing — seed_e2e_presentation.py did not run`);
});

test.beforeEach(() => { test.skip(!fixtureId, 'fixture not seeded (local run)'); });

test('start from data builds a real report: headline bound to findings, a slicer, charts that ran, a detail table', async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.goto('/dashboards');
  await page.getByTestId('report-starter-open').click();
  await page.selectOption('[data-testid="report-starter-dataset"]', { label: DATASET });
  await page.fill('[data-testid="report-starter-goal"]', 'Where does revenue come from, by region and channel?');
  await page.getByTestId('report-starter-create').click();
  await page.waitForURL(/\/dashboards\/\d+/, { timeout: 120_000 });
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  try {
    const d = await request.get(`${DASH}/${id}`).then((r) => r.json());
    const charts = d.dashboard_charts.filter((c: any) => c.widget_type === 'chart');
    expect(charts.length, 'no charts').toBeGreaterThan(2);
    expect(charts.some((c: any) => c.chart?.chart_type === 'TABLE'), 'no detail table').toBe(true);
    const head = d.dashboard_charts.find((c: any) => c.widget_type === 'narrative' && c.widget_config?.variant === 'headline');
    expect(head, 'no opening headline').toBeTruthy();
    expect(head.layout.y, 'the headline does not open the report').toBe(0);
    const ids = new Set(charts.map((c: any) => c.id));
    for (const item of head.widget_config.items) {
      expect(item.finding).toMatch(/^[a-z_]+:\d+$/);
      expect(ids.has(Number(item.finding.split(':')[1])), `headline cites a chart not on the report: ${item.finding}`).toBe(true);
    }
    expect(JSON.stringify(head.widget_config.items), 'a typed figure in the headline').not.toMatch(/\d{2,}[%$]|\$\d/);
    expect((d.slicers_config ?? []).length, 'no slicer').toBeGreaterThan(0);
    // The opening headline states only what the data supports: every sentence ready.
    await settled(page);
    const states = await page.getByTestId('narrative-widget').first().getAttribute('data-finding-state');
    expect((states ?? '').split(',').filter(Boolean).every((s) => s === 'ready'), `headline sentences: ${states}`).toBe(true);
    const a = await audit(page);
    expect(a.findings.filter((f) => ['chart.noMarks', 'tile.overlap', 'tile.offCanvas'].includes(f.code))).toEqual([]);
  } finally {
    await request.delete(`${DASH}/${id}`);
  }
});

test('AI-created blocks: Apply → Undo removes → Redo re-creates → Save draft → Reload → Publish', async ({ page, request }) => {
  test.setTimeout(150_000);
  const c = await copy(request);
  try {
    await page.goto(`/dashboards/${c.id}`);
    await settled(page);
    await page.getByTestId('design-mode-ai').click();
    await page.getByTestId('ai-design-direction-executive').click();
    await page.getByTestId('ai-design-apply').waitFor({ timeout: 30_000 });
    await page.getByTestId('ai-design-apply').click();
    const created = await stableCount(async () => (await narratives(request, c.id)).length);
    expect(created, 'Apply created no block').toBeGreaterThan(0);

    // The toolbar's own Undo/Redo (the same actions as Ctrl+Z / Ctrl+Shift+Z;
    // a key press would land in the AI panel's focused prompt box instead).
    await page.getByRole('button', { name: /^Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await narratives(request, c.id)).length, { timeout: 20_000, message: 'undo left AI blocks behind' }).toBe(0);
    await expect(page.getByTestId('narrative-widget')).toHaveCount(0);

    await page.getByRole('button', { name: /^Redo \(Ctrl\+Shift\+Z\)/ }).click();
    await expect.poll(async () => (await narratives(request, c.id)).length, { timeout: 20_000, message: 'redo did not re-create the AI blocks' }).toBe(created);
    await expect(page.getByTestId('narrative-widget').first()).toBeVisible();

    await page.getByTestId('dashboard-save-draft').click();
    await page.waitForTimeout(1500);
    await page.reload();
    await settled(page);
    await expect(page.getByTestId('narrative-widget'), 'the blocks did not survive a reload').toHaveCount(created);

    await page.getByTestId('dashboard-publish').click();
    await expect.poll(async () => (await narratives(request, c.id)).filter((n: any) => !n.layout?.draftOnly).length, { timeout: 20_000 }).toBe(created);
    const pub = await page.context().newPage();
    await pub.goto(`/d/${c.token}`);
    await settled(pub);
    const states = await pub.getByTestId('narrative-widget').evaluateAll((els) => els.map((e) => e.getAttribute('data-finding-state') ?? ''));
    expect(states.length, 'published report has no blocks').toBe(created);
    for (const s of states) expect(s.split(',').filter(Boolean).every((x) => x === 'ready'), `a published sentence is ${s}`).toBe(true);
    await pub.close();
  } finally {
    await request.delete(`${DASH}/${c.id}`);
  }
});

test('studio preview shows the whole report before/after at 1440/820/390 and never moves the canvas', async ({ page, request }) => {
  test.setTimeout(180_000);
  const c = await copy(request);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/dashboards/${c.id}`);
    await settled(page);
    await page.getByTestId('design-mode-ai').click();
    await page.getByTestId('ai-design-direction-operations').click();
    await page.getByTestId('ai-design-apply').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const before = await canvasRects(page);
    await page.getByTestId('ai-design-preview-full').click();
    await page.getByTestId('studio-preview').waitFor();
    for (const [device, width] of [['desktop', 1440], ['tablet', 820], ['phone', 390]] as const) {
      await page.getByTestId(`studio-device-${device}`).click();
      await page.getByTestId('studio-view-compare').click();
      await expect.poll(() => page.locator('[data-studio-frame][data-studio-settled="true"]').count(), { timeout: 60_000, message: `${device}: frames did not settle` }).toBe(2);
      for (const name of ['before', 'after']) {
        const frame = page.frameLocator(`[data-studio-frame="${name}"] iframe`);
        const info = await frame.locator('main').evaluate((main) => ({
          width: window.innerWidth,
          overflowX: main.scrollWidth > window.innerWidth + 1,
          sidebar: !!document.querySelector('nav, aside'),
          spinners: document.querySelectorAll('.animate-spin').length,
          tiles: document.querySelectorAll('[data-grid-item-id]').length,
          blocks: document.querySelectorAll('[data-testid="narrative-widget"]').length,
        }));
        expect(info.width, `${device}/${name}: not rendered at the device width`).toBe(width);
        expect(info.overflowX, `${device}/${name}: sideways scroll`).toBe(false);
        expect(info.sidebar, `${device}/${name}: app chrome in the preview`).toBe(false);
        expect(info.spinners, `${device}/${name}: still loading`).toBe(0);
        expect(info.tiles, `${device}/${name}: empty preview`).toBeGreaterThan(3);
        // "after" is what Apply would give: the operations blocks are in it, not in "before".
        if (name === 'after') expect(info.blocks, 'after has no AI blocks').toBeGreaterThan(0);
        else expect(info.blocks, 'before already shows the AI blocks').toBe(0);
      }
    }
    await page.getByTestId('studio-close').click();
    await expect(page.getByTestId('ai-design-apply'), 'closing the preview dropped the pending design').toBeVisible();
    expect(await canvasRects(page), 'opening the preview moved the canvas').toEqual(before);
  } finally {
    await request.delete(`${DASH}/${c.id}`);
  }
});

test('a filter moves the KPI, the charts and the narrative together — no stale headline', async ({ page, request }) => {
  test.setTimeout(150_000);
  const c = await copy(request);
  try {
    await page.goto(`/dashboards/${c.id}`);
    await settled(page);
    await page.getByTestId('design-mode-ai').click();
    await page.getByTestId('ai-design-direction-executive').click();
    await page.getByTestId('ai-design-apply').click();
    await expect.poll(async () => (await narratives(request, c.id)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.getByTestId('dashboard-publish').click();
    await expect.poll(async () => (await narratives(request, c.id)).filter((n: any) => !n.layout?.draftOnly).length, { timeout: 20_000 }).toBeGreaterThan(0);

    const pub = await page.context().newPage();
    await pub.goto(`/d/${c.token}`);
    await settled(pub);
    const read = () => pub.evaluate(() => ({
      text: Array.from(document.querySelectorAll('[data-testid="narrative-widget"] [data-finding]')).map((e) => e.textContent).join(' | '),
      kpi: Array.from(document.querySelectorAll('[data-grid-item-id]')).map((e) => e.textContent ?? '').find((s) => /revenue/i.test(s)) ?? '',
      states: Array.from(document.querySelectorAll('[data-testid="narrative-widget"]')).map((e) => e.getAttribute('data-finding-state')).join(','),
    }));
    const all = await read();
    await pub.locator('button[title^="Region"]').first().click();
    await pub.locator('input[type=checkbox]').locator('xpath=..').filter({ hasText: /^\s*North\s*$/ }).first().click();
    // The filter bar stages a choice; Apply commits it.
    await pub.getByRole('button', { name: /^\s*Apply\s*$/ }).first().click();
    await settled(pub);
    const north = await read();
    expect(north.kpi, 'the KPI did not follow the filter').not.toEqual(all.kpi);
    expect(north.text, 'the narrative did not follow the filter (stale headline)').not.toEqual(all.text);
    expect(north.states, 'a sentence is still computing after the report settled').not.toContain('pending');
    await pub.close();
  } finally {
    await request.delete(`${DASH}/${c.id}`);
  }
});

test('export is taken from the published report and is a real PDF', async ({ page, request }) => {
  test.setTimeout(240_000);
  const c = await copy(request);
  try {
    await page.goto(`/d/${c.token}`);
    await settled(page);
    const download = page.waitForEvent('download', { timeout: 200_000 });
    await page.getByRole('button', { name: /^Export PDF$/ }).first().click();
    // The options dialog's own confirm carries the same label.
    await page.getByRole('button', { name: /^Export PDF$/ }).last().click();
    const file = await download;
    const path = await file.path();
    expect(path, 'no file').toBeTruthy();
    const { readFileSync } = await import('fs');
    const bytes = readFileSync(path!);
    expect(bytes.subarray(0, 4).toString(), 'not a PDF').toBe('%PDF');
    expect(bytes.length, 'an empty PDF').toBeGreaterThan(10_000);
  } finally {
    await request.delete(`${DASH}/${c.id}`);
  }
});
