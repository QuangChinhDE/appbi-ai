#!/usr/bin/env node
/**
 * Captures the AUTO responsive layout the PUBLIC report produced before
 * authored device layouts existed, as golden vectors
 * (scripts/fixtures/responsive-auto-vectors.json).
 *
 * It replays PublicDashboardView's pipeline exactly as it stood at 11473148:
 * page tiles (w/h default 4) → reading order → buildResponsiveReportLayouts →
 * fitLayoutToContent on the active breakpoint ('stack' xs / 'grow' md).
 * The vectors are the compatibility contract of the AUTO resolver
 * (check-responsive-layout-contract.mjs). Re-run ONLY to deliberately change
 * AUTO behaviour, and say so in the change.
 *
 *   node scripts/capture-responsive-auto-vectors.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const cache = new Map();
function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith('@/')) base = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js']) {
    try { readFileSync(base + suffix); return base + suffix; } catch { /* next */ }
  }
  return base + '.ts';
}
function loadModule(file) {
  if (cache.has(file)) return cache.get(file);
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true },
    fileName: file,
  });
  const module = { exports: {} };
  cache.set(file, module.exports);
  const localRequire = (specifier) => {
    const resolved = resolveSpecifier(specifier, file);
    return resolved ? loadModule(resolved) : require_(specifier);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname', outputText)(localRequire, module, module.exports, file, dirname(file));
  cache.set(file, module.exports);
  return module.exports;
}
const load = (relative) => loadModule(resolve(SRC, relative));

const pages = load('lib/dashboard-pages.ts');
const fit = load('lib/responsive-fit.ts');
const structure = load('lib/report-structure.ts');
const frame = load('lib/dashboard-presentation/tile-frame.ts');

const chart = (id, type, x, y, w, h, extra = {}) => ({ id, chart_id: extra.chart_id ?? id + 1000, widget_type: 'chart', widget_config: null, chart: { chart_type: type }, layout: { x, y, w, h, gv: 2, ...(extra.layout ?? {}) } });
const widget = (id, widget_type, x, y, w, h, extra = {}) => ({ id, chart_id: null, widget_type, widget_config: extra.widget_config ?? {}, chart: null, layout: { x, y, w, h, gv: 2, ...(extra.layout ?? {}) } });

/** Representative pages: KPIs, charts, a table, text/narrative widgets, slicers,
 *  sections, several rows, the same chart twice (two tile ids). */
const FIXTURES = {
  presentation: [
    widget(1, 'hero_strip', 0, 0, 36, 4),
    chart(2, 'KPI', 0, 4, 9, 5), chart(3, 'KPI', 9, 4, 9, 5), chart(4, 'KPI', 18, 4, 9, 5), chart(5, 'KPI', 27, 4, 9, 5),
    chart(6, 'TIME_SERIES', 0, 9, 24, 14), chart(7, 'PIE', 24, 9, 12, 14),
    chart(8, 'BAR', 0, 23, 18, 12, { chart_id: 1100 }), chart(9, 'BAR', 18, 23, 18, 12, { chart_id: 1100 }),
    chart(10, 'TABLE', 0, 35, 36, 14),
  ],
  sections: [
    widget(20, 'section_header', 0, 0, 36, 3, { widget_config: { title: 'A' } }),
    chart(21, 'KPI', 0, 3, 12, 5, { layout: { sectionId: 20 } }), chart(22, 'BAR', 12, 3, 24, 12, { layout: { sectionId: 20 } }),
    widget(23, 'section_header', 0, 15, 36, 3, { widget_config: { title: 'B' } }),
    chart(24, 'TABLE', 0, 18, 18, 12, { layout: { sectionId: 23 } }), widget(25, 'narrative', 18, 18, 18, 6, { layout: { sectionId: 23 } }),
    chart(26, 'LINE', 0, 30, 36, 10),
  ],
  slicers_and_text: [
    widget(30, 'slicer', 0, 0, 9, 3), widget(31, 'slicer', 9, 0, 9, 3), widget(32, 'slicer', 18, 0, 9, 3),
    widget(33, 'text', 27, 0, 9, 3),
    chart(34, 'KPI', 0, 3, 6, 4), chart(35, 'KPI', 6, 3, 6, 4), chart(36, 'BAR', 12, 3, 24, 10),
    widget(37, 'callout', 0, 13, 36, 4), chart(38, 'TABLE', 0, 17, 12, 10),
  ],
  // A legacy 12-column page (no gv): upscaled ×3 at read time.
  legacy_12col: [
    chart(50, 'KPI', 0, 0, 3, 2, { layout: { gv: undefined } }), chart(51, 'KPI', 3, 0, 3, 2, { layout: { gv: undefined } }),
    chart(52, 'BAR', 6, 0, 6, 4, { layout: { gv: undefined } }), chart(53, 'TABLE', 0, 2, 6, 4, { layout: { gv: undefined } }),
  ],
  narrow_tiles: [
    chart(40, 'KPI', 0, 0, 4, 4), chart(41, 'KPI', 4, 0, 4, 4), chart(42, 'BAR', 8, 0, 8, 10), chart(43, 'TABLE', 16, 0, 10, 10), chart(44, 'PIE', 26, 0, 10, 10),
    chart(45, 'LINE', 0, 10, 12, 8), widget(46, 'text', 12, 10, 24, 2),
  ],
};
const WIDTHS = [1440, 1024, 1023, 820, 640, 639, 390];
const GAPS = [16, 8];
/** Measured content rows (what useMeasuredContentRows reports), to pin the fit:
 *  none, and a set that grows a KPI and a text block. */
const MEASURES = {
  none: {},
  grown: { 2: 9, 21: 8, 33: 6, 34: 7, 40: 8, 46: 5, 25: 10, 37: 6 },
};

function publicPipeline(tiles, width, gap, measured) {
  const visible = pages.normalizeDashboardGridForRender({ dashboard_charts: tiles }).dashboard_charts;
  const layouts = visible.map((dc) => ({ i: String(dc.id), x: dc.layout.x || 0, y: dc.layout.y || 0, w: dc.layout.w || 4, h: dc.layout.h || 4 }));
  const kind = new Map(visible.map((dc) => [String(dc.id), frame.tileKindOf(dc.chart?.chart_type, dc.widget_type)]));
  const geometry = new Map(layouts.map((l) => [l.i, l]));
  const responsive = pages.buildResponsiveReportLayouts(layouts, {
    kindOf: (item) => kind.get(item.i) ?? 'chart',
    gridWidth: width,
    gridGap: gap,
    order: structure.readingOrder(structure.toStructTiles(visible, (id) => ({
      ...((visible.find((dc) => dc.id === id)?.layout) ?? {}), ...geometry.get(String(id)),
    }))).map(String),
  });
  const bp = pages.reportBreakpointFor(width);
  let out = responsive[bp];
  if (bp !== 'lg') out = fit.fitLayoutToContent(out, measured, bp === 'xs' ? 'stack' : 'grow');
  return { breakpoint: bp, cols: pages.REPORT_RESPONSIVE_COLS[bp], layout: out.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) };
}

const vectors = [];
for (const [name, tiles] of Object.entries(FIXTURES)) {
  for (const width of WIDTHS) for (const gap of GAPS) for (const [mname, measured] of Object.entries(MEASURES)) {
    vectors.push({ fixture: name, width, gap, measured: mname, expected: publicPipeline(tiles, width, gap, measured) });
  }
}
const out = resolve(HERE, 'fixtures', 'responsive-auto-vectors.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  capturedFrom: 'PublicDashboardView pipeline at 11473148 (before authored device layouts)',
  fixtures: FIXTURES, measures: MEASURES, vectors,
}, null, 1) + '\n');
console.log(`captured ${vectors.length} vectors → ${out}`);
