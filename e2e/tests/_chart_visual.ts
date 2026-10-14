import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Chart VISUAL certification helpers. Fixture:
 * backend/scripts/ci/seed_e2e_chart_visual.py (oracle computed from the rows).
 *
 * A chart is certified on three layers, all of which must hold:
 *   DATA    — the preview response carries the oracle values;
 *   MODEL   — the series / categories the renderer was given (legend, ticks);
 *   VISIBLE — data marks with real geometry inside the chart container.
 * "HTTP 200 + rows + a legend" is NOT a pass: that is exactly what a blank
 * plot (every mark at NaN) looked like.
 */
export type VisualFixture = {
  dataset_id: number; dataset_name: string; table_id: number; view: string;
  expected: {
    rows: number;
    revenue_by_region: Record<string, number>;
    profit_by_product: Record<string, number>;
    leads_by_stage: Record<string, number>;
    revenue_by_state: Record<string, number>;
    revenue_by_channel: Record<string, number>;
    leads_won_by_month: Record<string, { leads: number; won: number }>;
    total_revenue: number;
    total_leads: number;
  };
};

export const VIS: VisualFixture = (() => {
  const file = path.join(__dirname, '..', '.auth', 'chart_visual.json');
  if (!fs.existsSync(file)) throw new Error(`${file} missing — run backend/scripts/ci/seed_e2e_chart_visual.py`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();

export const f = (col: string) => `${VIS.view}.${col}`;
export const sum = (col: string) => ({ field: f(col), agg: 'sum' });
export const asIs = (measure: string) => ({ field: f(measure), agg: 'auto' });

/** Create a chart through the canonical Chart API (the same POST the Builder's Save sends). */
export async function createChart(
  request: APIRequestContext, type: string, role: Record<string, unknown>, style: Record<string, unknown> = {},
): Promise<number> {
  const res = await request.post('/api/v1/charts/', {
    data: {
      name: `E2E VIS ${type} ${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      chart_type: type,
      dataset_table_id: VIS.table_id,
      config: {
        chartType: type, queryMode: 'generated', dataset_id: VIS.dataset_id,
        roleConfig: role, generatedRoleConfig: role, customRoleConfig: { metrics: [] },
        filters: [], baseFilters: [], styleConfig: { animate: false, ...style },
      },
    },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()).id;
}

/** Console + page errors that affect rendering correctness. Nothing is blanket-ignored. */
export function watchConsole(page: Page): string[] {
  const bad: string[] = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (/NaN|Infinity|undefined.*dataKey|Expected (length|number)|invalid|Maximum update depth|Encountered two children with the same key|Each child in a list|Cannot read prop|is not a function/i.test(t)) {
      bad.push(`${m.type()}: ${t.slice(0, 300)}`);
    }
  });
  return bad;
}

/** Open a saved chart in the Builder; returns the preview response it auto-ran. */
export async function openInBuilder(page: Page, chartId: number) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charts/preview-data') && r.request().method() === 'POST'),
    page.goto(`/explore/${chartId}`),
  ]);
  const chart = page.getByTestId('explore-chart');
  await expect(chart).toBeVisible();
  await settle(chart);
  return { resp, body: await resp.json(), chart };
}

/** Wait until what is drawn stops changing: Recharts animates bars / lines in
 *  (~1.5s) and a mid-animation measurement or screenshot shows a half line. */
export async function settle(container: Locator, timeoutMs = 6000): Promise<void> {
  const sig = () => container.evaluate((root) => [...root.querySelectorAll('svg path, svg rect, svg circle')]
    .map((el) => `${el.getAttribute('d') ?? ''}|${el.getAttribute('height') ?? ''}|${el.getAttribute('cx') ?? ''}`).join(';').length
    + ':' + [...root.querySelectorAll('svg path')].map((el) => el.getAttribute('d') ?? '').join('').slice(-200));
  const end = Date.now() + timeoutMs;
  let prev = await sig();
  for (;;) {
    await new Promise((r) => setTimeout(r, 350));
    const cur = await sig();
    if (cur === prev || Date.now() > end) return;
    prev = cur;
  }
}

export type MarkReport = {
  /** shapes with real geometry and a visible fill/stroke, outside axes/grid/legend/defs */
  marks: number;
  bars: number;
  linePaths: number;
  linePoints: number;
  sectors: number;
  nan: number;
  htmlCells: number;
  /** HTML-rendered marks (podium blocks, region bars, …): elements whose own
   *  inline background colour paints a box with real area */
  htmlMarks: number;
  text: string;
  legend: string[];
  /** left value-axis tick labels */
  yTicks: string[];
  /** category / time axis tick labels */
  xTicks: string[];
  /** horizontal extent of the widest line/area path ÷ plot width (1 = spans the plot) */
  lineSpan: number;
  /** circles/rects whose box leaves the chart's svg viewport (clipped marks) */
  clipped: number;
};

/** Measure what is VISIBLY drawn inside a chart container. Renderer-agnostic:
 *  SVG shapes (rect/path/circle/polygon/ellipse) with area, a visible paint and
 *  non-zero opacity, excluding chrome (axes, grid, legend, clip/defs). */
export async function measureMarks(container: Locator): Promise<MarkReport> {
  return container.evaluate((root) => {
    const chrome = '.recharts-cartesian-axis, .recharts-cartesian-grid, .recharts-legend-wrapper, defs, clipPath, .recharts-tooltip-wrapper, [data-chart-chrome], .recharts-reference-line';
    const visible = (el: Element) => {
      const cs = getComputedStyle(el as HTMLElement);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const fill = el.getAttribute('fill') ?? cs.fill;
      const stroke = el.getAttribute('stroke') ?? cs.stroke;
      const fillOpacity = Number(el.getAttribute('fill-opacity') ?? cs.fillOpacity ?? 1);
      const paintedFill = fill && fill !== 'none' && fill !== 'transparent' && fillOpacity > 0;
      const paintedStroke = stroke && stroke !== 'none' && stroke !== 'transparent';
      return paintedFill || paintedStroke;
    };
    const shapes = [...root.querySelectorAll('svg rect, svg path, svg circle, svg polygon, svg ellipse')]
      .filter((el) => !el.closest(chrome))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > 4 || (r.width > 1 && el.tagName === 'path'); })
      .filter(visible);
    const geom = (sel: string) => [...root.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).length;
    const linePaths = [...root.querySelectorAll('.recharts-line-curve, .recharts-area-curve, .recharts-area-area')]
      .filter((el) => { const d = el.getAttribute('d') || ''; const r = el.getBoundingClientRect(); return d.length > 4 && !/NaN/.test(d) && (r.width > 0 || r.height > 0); }).length;
    const cells = [...root.querySelectorAll('td, [role="cell"], [role="gridcell"]')].filter((el) => (el.textContent || '').trim()).length;
    const htmlMarks = [...root.querySelectorAll('[style*="background"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      const bg = getComputedStyle(el as HTMLElement).backgroundColor;
      return r.width * r.height > 4 && bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(bg) && Number(getComputedStyle(el as HTMLElement).opacity) > 0;
    }).length;
    return {
      marks: shapes.length,
      bars: geom('.recharts-bar-rectangle path, .recharts-bar-rectangle rect'),
      linePaths,
      linePoints: geom('.recharts-line-dots circle, .recharts-line-dot, .recharts-dot'),
      sectors: geom('.recharts-pie-sector path, .recharts-sector, .recharts-radial-bar-sector'),
      nan: (root.innerHTML.match(/="[^"]*NaN[^"]*"/g) || []).length,
      htmlCells: cells,
      htmlMarks,
      text: (root as HTMLElement).innerText.slice(0, 2000),
      legend: [...root.querySelectorAll('.recharts-legend-item-text, [data-legend-item]')].map((e) => (e.textContent || '').trim()),
      // Ticks are custom-rendered (CustomAxisTick): read the axis group's text.
      yTicks: [...(root.querySelector('.recharts-yAxis')?.querySelectorAll('.recharts-cartesian-axis-tick text, .recharts-cartesian-axis-tick-value') ?? [])].map((e) => (e.textContent || '').trim()).filter(Boolean),
      xTicks: [...new Set([...root.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick text, .recharts-xAxis .recharts-cartesian-axis-tick-value')].map((e) => (e.textContent || '').trim()).filter(Boolean))],
      lineSpan: (() => {
        const grid = root.querySelector('.recharts-cartesian-grid')?.getBoundingClientRect();
        const lines = [...root.querySelectorAll('.recharts-line-curve, .recharts-area-curve')].map((e) => e.getBoundingClientRect().width);
        return grid && grid.width > 0 && lines.length ? Math.max(...lines) / grid.width : 0;
      })(),
      clipped: (() => {
        let n = 0;
        for (const svg of root.querySelectorAll('svg')) {
          const box = svg.getBoundingClientRect();
          for (const el of svg.querySelectorAll('circle')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) n += 1;
          }
        }
        return n;
      })(),
    };
  });
}

export function shotPath(name: string): string {
  // Outside test-results/ (Playwright wipes it per run): the per-type evidence
  // a reviewer opens. CI uploads this directory as an artifact.
  const dir = process.env.CHART_VISUAL_DIR || path.join(__dirname, '..', '..', '.artifacts', 'chart-visual');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/** Numeric values of a preview response, keyed by the dimension value. */
export function valuesBy(body: { data?: Array<Record<string, unknown>> }, dimCol: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of body.data ?? []) {
    const dimKey = Object.keys(row).find((k) => k === f(dimCol) || k.endsWith(`.${dimCol}`) || k === dimCol);
    const valKey = Object.keys(row).find((k) => k !== dimKey && typeof row[k] === 'number');
    if (dimKey && valKey) out[String(row[dimKey])] = Number(row[valKey]);
  }
  return out;
}
