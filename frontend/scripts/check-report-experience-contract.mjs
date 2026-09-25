/**
 * Report Experience contract — the guarantees behind findings, blocks,
 * directions and the phone reading stack, checked on the real modules.
 *
 *   node scripts/check-report-experience-contract.mjs
 *
 * What it holds the code to (each check names the failure it prevents):
 *  - a finding states only what the rows support: partial periods are left out
 *    AND named, a share is never claimed for a non-additive measure, no rows →
 *    no finding;
 *  - a block the model writes can never carry a typed number, cite a chart that
 *    is not on the page, or appear outside a redesign;
 *  - the three directions are different reading experiences (hierarchy, blocks,
 *    frames, dock, density), lose no visual, respect locks, and are deterministic;
 *  - the same grammar on a report of a different shape still composes;
 *  - the phone stack keeps KPIs side by side;
 *  - a declared currency is shown with its own symbol.
 */
import { readFileSync } from 'node:fs';
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
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__filename', '__dirname', outputText)(localRequire, module, module.exports, file, dirname(file));
  cache.set(file, module.exports);
  return module.exports;
}
const load = (relative) => loadModule(resolve(SRC, relative));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const findings = load('lib/report-findings.ts');
const blocksMod = load('lib/dashboard-presentation/blocks.ts');
const validator = load('lib/dashboard-presentation/validator.ts');
const directions = load('lib/dashboard-presentation/directions.ts');
const snapshotMod = load('lib/dashboard-presentation/snapshot.ts');
const executor = load('lib/dashboard-presentation/executor.ts');
const designContext = load('lib/dashboard-presentation/design-context.ts');
const pages = load('lib/dashboard-pages.ts');
const maps = load('lib/chart-semantic-maps.ts');

// ── fixtures ────────────────────────────────────────────────────────────────

const months = (n, start = [2016, 8]) => {
  const out = []; let [y, m] = start;
  for (let i = 0; i < n; i += 1) { out.push(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 19)); m += 1; if (m > 11) { m = 0; y += 1; } }
  return out;
};

function series(values, field = 'rev') {
  return months(values.length).map((t, i) => ({ 't': t, [field]: values[i] }));
}

const OLIST_REV = [267, 49507, 10.9, 120000, 250000, 370000, 500000, 610000, 700000, 750000,
  1000000, 850000, 960000, 900000, 990000, 1000000, 1000000, 990000, 870000, 900000, 850000, 145, 89];

function evidence(over = {}) {
  return {
    tileId: 5, chartType: 'TIME_SERIES', title: 'Revenue by month', measureField: 'rev', measureLabel: 'Revenue',
    additive: true, format: { kind: 'currency', currencySymbol: 'R$' }, timeField: 't', grain: 'month',
    rows: series(OLIST_REV), partialBuckets: [], ...over,
  };
}

const t = (key, params = {}) => `${key}${Object.keys(params).length ? ' ' + JSON.stringify(params) : ''}`;

// Tiles shaped like the Olist review report, with real role configs.
function roleTile(id, type, name, role, y, x = 0, w = 12, h = 6) {
  return {
    id, chart_id: 900 + id, widget_type: 'chart',
    layout: { x, y, w, h, gv: 2, pageId: 'page-1' }, parameters: null,
    chart: { id: 900 + id, name, chart_type: type, config: { chartType: type, roleConfig: role, generatedRoleConfig: role } },
  };
}
const M = (f) => ({ field: f, agg: 'auto' });
function olistTiles() {
  return [
    roleTile(1, 'KPI', 'Revenue', { metrics: [M('oi.revenue')] }, 0, 0, 9),
    roleTile(2, 'KPI', 'Orders', { metrics: [M('oi.orders')] }, 0, 9, 9),
    roleTile(3, 'KPI', 'Average order value', { metrics: [M('oi.aov')] }, 0, 18, 9),
    roleTile(4, 'KPI', 'On-time delivery', { metrics: [M('o.on_time')] }, 0, 27, 9),
    roleTile(5, 'TIME_SERIES', 'Revenue by month', { metrics: [M('oi.revenue')], timeField: 'o.purchase', dimension: 'o.purchase', timeGrains: { 'o.purchase': 'month' } }, 6, 0, 24, 14),
    roleTile(6, 'PIE', 'Payment mix', { metrics: [M('p.value')], dimension: 'p.type' }, 6, 24, 12, 14),
    roleTile(7, 'BAR', 'Revenue by category', { metrics: [M('oi.revenue')], dimension: 'c.category' }, 20, 0, 18, 14),
    roleTile(8, 'BAR', 'Revenue by state', { metrics: [M('oi.revenue')], dimension: 'cu.state' }, 20, 18, 18, 14),
    roleTile(9, 'TIME_SERIES', 'Delivery days by month', { metrics: [M('o.days')], timeField: 'o.purchase', dimension: 'o.purchase', timeGrains: { 'o.purchase': 'month' } }, 34, 0, 18, 12),
    roleTile(12, 'TABLE', 'Top sellers', { metrics: [M('oi.revenue')], dimension: 's.state' }, 46, 0, 36, 12),
  ];
}
const FIELD_META = designContext.buildFieldMetaIndex([[
  { name: 'oi', measures: [{ name: 'revenue', label: 'Revenue', type: 'sum', format: { kind: 'currency' } }, { name: 'orders', label: 'Orders', type: 'count_distinct' }, { name: 'aov', label: 'AOV', type: 'formula' }], dimensions: [] },
  { name: 'o', measures: [{ name: 'on_time', label: 'On-time', type: 'formula', format: { kind: 'percent' } }, { name: 'days', label: 'Delivery days', type: 'avg' }], dimensions: [{ name: 'purchase', label: 'Purchase date', type: 'date' }] },
  { name: 'p', measures: [{ name: 'value', label: 'Payment value', type: 'sum' }], dimensions: [{ name: 'type', label: 'Payment type' }] },
  { name: 'c', measures: [], dimensions: [{ name: 'category', label: 'Category' }] },
  { name: 'cu', measures: [], dimensions: [{ name: 'state', label: 'State' }] },
  { name: 's', measures: [], dimensions: [{ name: 'state', label: 'Seller state' }] },
]]);
function snap(tiles) {
  return snapshotMod.buildPresentationSnapshot({
    dashboard: { name: 'Olist review', theme_config: {}, dashboard_charts: tiles },
    tiles, pageId: 'page-1', pageName: 'Overview', pageCount: 1,
    slicers: [{ id: 's1', label: 'State', type: 'dropdown' }], slicerDock: 'top', fieldMeta: FIELD_META,
  });
}
function build(direction, tiles = olistTiles()) {
  const snapshot = snap(tiles);
  const plan = directions.planForDirection(direction, snapshot);
  const built = executor.buildPresentationMutation({ plan, snapshot, tiles, pageId: 'page-1', currentTheme: {}, gridGapPx: 8, targets: [] });
  return { plan, built, snapshot };
}

// ── findings ────────────────────────────────────────────────────────────────

check('a partial period is left out of the comparison AND named, never silently dropped', () => {
  const partial = ['2016-09-01T00:00:00', '2016-10-01T00:00:00', '2016-11-01T00:00:00', months(23)[21], months(23)[22]];
  const out = findings.findingsForReport([evidence({ partialBuckets: partial })]);
  const trend = out.get('trend:5');
  assert(trend, 'no trend finding');
  assert(trend.values.from === 120000, `trend started at a partial month (${trend.values.from})`);
  assert(trend.values.to === 850000, `trend ended at a partial month (${trend.values.to})`);
  const p = out.get('partial_periods:5');
  assert(p && p.values.count === 5, 'the left-out periods were not stated');
  assert(trend.evidence.excluded.length === 5, 'the trend does not say what it excluded');
});

check('without the partial flags the trend is the endpoint artefact the flags exist to prevent', () => {
  const trend = findings.findingsForReport([evidence()]).get('trend:5');
  assert(trend.direction === 'down', 'expected the naive endpoint read to be "down" — the control for the check above');
});

check('a partial period found by a volume series is applied to an average series on the same axis', () => {
  // An average over three launch-month orders looks like any other month; the
  // revenue series on the same time field is what reveals it.
  const partial = ['2016-09-01T00:00:00'];
  const avg = evidence({ tileId: 9, measureLabel: 'Avg delivery days', additive: false, format: {},
    rows: series([54.8, 20, 19, 18, 17]), partialBuckets: [] });
  const vol = evidence({ rows: series([267, 120000, 130000, 140000, 150000]), partialBuckets: partial });
  const out = findings.findingsForReport([vol, avg]);
  assert(out.get('trend:9').values.from === 20, `the average trend started at the launch month (${out.get('trend:9').values.from})`);
  assert(out.get('partial_periods:9'), 'the average series does not say what it left out');
});

check('same-months year-over-year pairs only months present in both years', () => {
  const rows = series([...Array(12).fill(100), 110, 120, 130, 140, 150, 160, 170, 180], 'rev');
  const pc = findings.findingsForReport([evidence({ rows })]).get('period_comparison:5');
  assert(pc, 'no period comparison');
  assert(pc.values.months === 4, `paired ${pc.values.months} months, expected Jan–Apr of the last year`);
  assert(pc.labels.previousYear === '2017', 'wrong comparison year');
});

check('an undeclared grain is read from the buckets, so a monthly series still compares like months', () => {
  const rows = series([...Array(12).fill(100), 110, 120, 130], 'rev');
  const pc = findings.findingsForReport([evidence({ rows, grain: undefined })]).get('period_comparison:5');
  assert(pc && pc.values.months === 3, 'no same-months comparison without a declared grain');
});

check('a share of the total is never claimed for a non-additive measure', () => {
  const rows = [{ c: 'a', v: 4.5 }, { c: 'b', v: 4.2 }, { c: 'c', v: 3.9 }, { c: 'd', v: 3.1 }];
  const base = { tileId: 10, chartType: 'BAR', title: 'Review by state', measureField: 'v', measureLabel: 'Avg review', format: {}, dimensionField: 'c', rows };
  const avg = findings.findingsForReport([{ ...base, additive: false }]);
  assert(avg.get('top_item:10') && avg.get('top_item:10').values.share === undefined, 'an average was given a share');
  assert(!avg.get('concentration:10'), 'an average was given a concentration');
  const sum = findings.findingsForReport([{ ...base, additive: true }]);
  assert(sum.get('top_item:10').values.share > 0 && sum.get('concentration:10'), 'an additive measure lost its share');
});

check('no rows, no finding — a filter that empties a chart silences its sentences', () => {
  const out = findings.findingsForReport([evidence({ rows: [] }), { ...evidence({ tileId: 6, chartType: 'PIE', timeField: undefined, grain: undefined, dimensionField: 'x', rows: [{ x: 'a', rev: 1 }] }) }]);
  assert(out.size === 0, `${out.size} finding(s) invented from nothing`);
});

check('a sentence takes every figure from the finding, and the direction word from the data', () => {
  const up = findings.findingsForReport([evidence({ rows: series([100, 200, 300]) })]).get('trend:5');
  const down = findings.findingsForReport([evidence({ rows: series([300, 200, 100]) })]).get('trend:5');
  const su = findings.renderFindingSentence(up, t, 'en');
  const sd = findings.renderFindingSentence(down, t, 'en');
  assert(su.startsWith('report.finding.trend.up') && sd.startsWith('report.finding.trend.down'), 'direction not from data');
  assert(su.includes('R$ 100') && su.includes('"pct":"200%"'), `figures not from the finding: ${su}`);
  // The verb carries the sign; "rose +200%" says it twice.
  assert(!su.includes('"pct":"+'), `the trend figure repeats the sign the verb states: ${su}`);
});

check('percent follows the platform convention (ratio ×100), the same figure the tile prints', () => {
  assert(findings.formatValue(0.9188, { kind: 'percent' }, 'en') === '91.9%', findings.formatValue(0.9188, { kind: 'percent' }, 'en'));
});

check('a naive engine timestamp names its calendar month in every time zone', () => {
  // Parsed as local time, "2018-01-01T00:00:00" is 2017-12-31 17:00 UTC in
  // UTC+7 — every monthly finding and footnote was a month early east of UTC.
  const d = findings.parseBucket('2018-01-01T00:00:00');
  assert(d.getUTCFullYear() === 2018 && d.getUTCMonth() === 0 && d.getUTCDate() === 1, d.toISOString());
  assert(findings.parseBucket('2018-01-01').getUTCMonth() === 0, 'date-only form');
  assert(findings.parseBucket('2018-01-01T00:00:00+07:00').toISOString() === '2017-12-31T17:00:00.000Z', 'an explicit offset must be honoured');
});

// ── blocks at the boundary ──────────────────────────────────────────────────

check('a model-written heading with a figure is dropped; the block keeps its findings', () => {
  const { blocks, notes } = blocksMod.coercePlanBlocks(
    [{ id: 'b1', variant: 'headline', title: 'Revenue up 137% in 2018', findings: ['trend:5'] }], new Set([5]));
  assert(blocks.length === 1 && !blocks[0].title, 'a typed figure survived');
  assert(blocks[0].findings[0] === 'trend:5', 'the finding was lost with the text');
  assert(notes.some((n) => /numbers/i.test(n)), 'the drop was not reported');
});

check('a finding reference to a chart not on the page, or an unknown kind, is dropped', () => {
  const { blocks } = blocksMod.coercePlanBlocks(
    [{ id: 'b1', variant: 'summary', findings: ['trend:999', 'forecast:5', 'peak:5'] }], new Set([5]));
  assert(blocks[0].findings.join() === 'peak:5', blocks[0].findings.join());
});

check('blocks exist only in a redesign; sections place them by the model id', () => {
  const raw = { layer: 'redesign', direction: { style: 'executive' }, blocks: [{ id: 'b1', variant: 'headline', findings: ['trend:5'] }],
    sections: [{ primitive: 'full_width', visuals: ['b1'] }, { primitive: 'full_width', visuals: [5] }] };
  const red = validator.coerceModelPlan(raw, { grantedLayer: 'redesign', knownTileIds: [5] }).plan;
  assert(red.blocks.length === 1 && red.sections[0].visuals[0] === red.blocks[0].id && red.blocks[0].id < 0, 'block not placed by id');
  const sty = validator.coerceModelPlan(raw, { grantedLayer: 'style', knownTileIds: [5] });
  assert(!sty.plan.blocks && sty.notes.some((n) => /redesign/i.test(n)), 'a style change created blocks');
});

// ── directions ──────────────────────────────────────────────────────────────

const signature = (r) => ({
  primitives: r.plan.sections.map((s) => s.primitive).join(','),
  variants: [...new Set((r.plan.blocks ?? []).map((b) => b.variant))].sort().join(','),
  dock: r.plan.slicerPresentation?.dock,
  density: r.plan.direction.density,
  mode: r.plan.themeIntent?.mode,
  frames: [...new Set(Object.values(r.plan.tileStyles ?? {}).map((s) => s.tileFrame))].sort().join(','),
  firstBlock: r.plan.sections[0]?.visuals?.[0] < 0 ? 'block' : 'visual',
});

check('each direction is valid, loses no visual and creates live-bound blocks', () => {
  for (const d of directions.DIRECTION_IDS) {
    const r = build(d);
    assert(r.built.ok, `${d}: ${JSON.stringify(r.built.mutationValidation.violations.slice(0, 2))}`);
    const placed = new Set(Object.keys(r.built.mutation.layoutOverrides).map(Number));
    for (const tile of olistTiles()) assert(placed.has(tile.id), `${d}: visual ${tile.id} was not placed`);
    const created = r.built.mutation.createdBlocks ?? [];
    assert(created.length > 0, `${d}: no blocks`);
    for (const b of created) {
      assert(!/\d/.test(JSON.stringify(b.widgetConfig.title ?? '')), `${d}: a block title carries a figure`);
      for (const i of b.widgetConfig.items) assert(/^[a-z_]+:\d+$/.test(i.finding), `${d}: bad finding ref ${i.finding}`);
    }
  }
});

check('the three directions differ in hierarchy, content treatment, density and reading — not only colour', () => {
  const sig = Object.fromEntries(directions.DIRECTION_IDS.map((d) => [d, signature(build(d))]));
  const pairs = [['executive', 'operations'], ['executive', 'editorial'], ['operations', 'editorial']];
  for (const [a, b] of pairs) {
    const axes = ['primitives', 'variants', 'dock', 'density', 'frames'].filter((k) => sig[a][k] !== sig[b][k]);
    assert(axes.length >= 4, `${a} vs ${b} differ on only ${axes.join(', ') || 'nothing'}`);
  }
  assert(sig.executive.firstBlock === 'block' && sig.editorial.firstBlock === 'block', 'executive/editorial do not open with a verdict');
  assert(sig.operations.variants.includes('takeaway'), 'operations has no status cards');
  assert(sig.editorial.variants.includes('chapter'), 'editorial has no chapters');
});

check('the executive verdict cites the comparable-period change of the additive series, not the average', () => {
  const r = build('executive');
  const headline = r.plan.blocks.find((b) => b.variant === 'headline');
  assert(headline && headline.findings[0] === 'period_comparison:5', `headline cites ${headline?.findings}`);
});

check('a locked visual keeps its rectangle under every direction', () => {
  const tiles = olistTiles().map((tile) => (tile.id === 7 ? { ...tile, layout: { ...tile.layout, locked: true } } : tile));
  for (const d of directions.DIRECTION_IDS) {
    const r = build(d, tiles);
    assert(r.built.ok, `${d} refused with a lock`);
    assert(!r.built.mutation.layoutOverrides[7] || r.built.mutation.layoutOverrides[7].x === undefined, `${d} moved the locked visual`);
  }
});

check('directions are deterministic', () => {
  for (const d of directions.DIRECTION_IDS) {
    assert(JSON.stringify(build(d).plan) === JSON.stringify(build(d).plan), `${d} differs between runs`);
  }
});

check('the grammar adapts to a report of a different shape (no time series, no KPIs)', () => {
  const tiles = [
    roleTile(21, 'BAR', 'Tickets by team', { metrics: [M('p.value')], dimension: 'p.type' }, 0, 0, 18, 12),
    roleTile(22, 'PIE', 'Tickets by channel', { metrics: [M('p.value')], dimension: 'c.category' }, 0, 18, 18, 12),
    roleTile(23, 'TABLE', 'Open tickets', { metrics: [M('p.value')], dimension: 'cu.state' }, 12, 0, 36, 12),
  ];
  for (const d of directions.DIRECTION_IDS) {
    const r = build(d, tiles);
    assert(r.built.ok, `${d} failed on a category-only report`);
    for (const b of r.plan.blocks ?? []) for (const f of b.findings) assert(!/^(trend|peak|latest|period_comparison)/.test(f), `${d} cited a time finding on a report with no time axis: ${f}`);
  }
  assert((build('editorial', tiles).plan.blocks ?? []).some((b) => b.variant === 'chapter' && b.findings.some((f) => f.startsWith('top_item'))), 'editorial chapters lost their category findings');
});

check('an existing AI block is reused in its slot, not duplicated', () => {
  const first = build('executive');
  const headline = first.built.mutation.createdBlocks.find((b) => b.widgetConfig.variant === 'headline');
  const existing = { id: 500, chart_id: null, widget_type: 'narrative', widget_config: headline.widgetConfig, layout: { ...headline.layout, draftOnly: true }, chart: null };
  const second = build('executive', [...olistTiles(), existing]);
  assert(!second.built.mutation.createdBlocks.some((b) => b.widgetConfig.variant === 'headline'), 'a second headline was created');
  assert(second.built.mutation.layoutOverrides[500], 'the existing headline was not placed');
});

// ── responsive + currency ───────────────────────────────────────────────────

check('the phone stack keeps side-by-side KPIs as a 2-up grid; charts stay full width', () => {
  const layouts = [
    { i: 'k1', x: 0, y: 0, w: 9, h: 4 }, { i: 'k2', x: 9, y: 0, w: 9, h: 4 }, { i: 'k3', x: 18, y: 0, w: 9, h: 4 }, { i: 'k4', x: 27, y: 0, w: 9, h: 4 },
    { i: 'c1', x: 0, y: 4, w: 24, h: 10 },
  ];
  const kind = (item) => (item.i.startsWith('k') ? 'kpi' : 'chart');
  const out = pages.deriveStackedLayout(layouts, { kindOf: kind, rowPitchPx: 30, cols: 2 });
  const byId = Object.fromEntries(out.map((l) => [l.i, l]));
  assert(byId.k1.w === 1 && byId.k2.w === 1 && byId.k1.y === byId.k2.y && byId.k2.x === 1, 'KPIs were not paired');
  assert(byId.k3.y > byId.k1.y && byId.k3.y === byId.k4.y, 'second KPI pair not on its own row');
  assert(byId.c1.w === 2 && byId.c1.x === 0, 'chart is not full width');
  assert(pages.REPORT_RESPONSIVE_COLS.xs === 2, 'the published phone grid is not 2 columns');
});

check('a declared currency is shown with its own symbol, not a default dollar', () => {
  assert(maps.currencySymbolFor('BRL') === 'R$', maps.currencySymbolFor('BRL'));
  assert(maps.currencySymbolFor('VND') === '₫', maps.currencySymbolFor('VND'));
  const m = maps.buildSemanticCurrencyMap([{ name: 'oi', measures: [{ name: 'revenue', format: { kind: 'currency', currency: 'BRL' } }, { name: 'aov', format: { kind: 'currency' } }] }]);
  assert(m.get('oi.revenue') === 'R$', 'BRL measure lost its symbol');
  assert(!m.has('oi.aov'), 'a currency without a code was given a symbol it never declared');
});

if (failures.length) {
  console.error(`${failures.length} report-experience check(s) FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f.name}\n      ${f.error?.message ?? f.error}`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`All ${passed} report-experience checks passed.`);
