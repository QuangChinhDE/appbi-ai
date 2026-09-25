/**
 * Contract tests for the presentation layer.
 *
 * The repo has no frontend test runner and this is not the change that should
 * introduce one, so this follows the convention already here: a plain node
 * script under `scripts/`, wired into `npm run qa`. TypeScript is already a
 * devDependency, so the modules under test are transpiled in memory rather than
 * built — no new package, no build step, and the assertions run against the
 * same source the app ships.
 *
 * What is asserted is the promise the feature makes: a redesign may move,
 * resize and restyle, and may not change what a single number means.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

// ── A tiny in-memory TS module loader ───────────────────────────────────────

const cache = new Map();

function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith('@/')) base = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null; // node builtin or package — let require handle it
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js']) {
    const candidate = base + suffix;
    try { readFileSync(candidate); return candidate; } catch { /* keep looking */ }
  }
  return base + '.ts';
}

function loadModule(file) {
  if (cache.has(file)) return cache.get(file);
  const source = readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.Preserve,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const module = { exports: {} };
  cache.set(file, module.exports);
  const localRequire = (specifier) => {
    const resolved = resolveSpecifier(specifier, file);
    if (!resolved) return require_(specifier);
    return loadModule(resolved);
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', outputText);
  factory(localRequire, module, module.exports, file, dirname(file));
  cache.set(file, module.exports);
  return module.exports;
}

const load = (relative) => loadModule(resolve(SRC, relative));

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

// ── Modules under test ──────────────────────────────────────────────────────

const capabilities = load('lib/dashboard-presentation/capabilities.ts');
const compiler = load('lib/dashboard-presentation/compiler.ts');
const validator = load('lib/dashboard-presentation/validator.ts');
const roles = load('lib/dashboard-presentation/roles.ts');
const snapshotMod = load('lib/dashboard-presentation/snapshot.ts');
const pages = load('lib/dashboard-pages.ts');

const COLS = pages.DASHBOARD_GRID_COLS;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The shape §29 asks for: 4 KPI, a trend, two breakdowns, a table. */
function makeTiles() {
  const spec = [
    { id: 101, type: 'KPI', name: 'Revenue' },
    { id: 102, type: 'KPI', name: 'Orders' },
    { id: 103, type: 'KPI', name: 'AOV' },
    { id: 104, type: 'KPI', name: 'Conversion' },
    { id: 105, type: 'LINE', name: 'Revenue trend' },
    { id: 106, type: 'DONUT', name: 'Category mix' },
    { id: 107, type: 'BAR', name: 'Region performance' },
    { id: 108, type: 'TABLE', name: 'Details' },
  ];
  return spec.map((s, index) => ({
    id: s.id,
    chart_id: 900 + index,
    widget_type: 'chart',
    layout: { x: (index % 3) * 12, y: Math.floor(index / 3) * 4, w: 12, h: 4, gv: 2, pageId: 'page-1' },
    parameters: null,
    chart: {
      id: 900 + index,
      name: s.name,
      chart_type: s.type,
      dataset_id: 111,
      config: { dimensions: ['d'], measures: ['m'], agg: 'SUM' },
    },
  }));
}

function makeSnapshot(tiles) {
  return snapshotMod.buildPresentationSnapshot({
    dashboard: { name: 'Fixture', theme_config: {}, dashboard_charts: tiles },
    tiles,
    pageId: 'page-1',
    pageName: 'Page 1',
    pageCount: 1,
    slicers: [{ id: 's1', label: 'Payment Type', type: 'dropdown', field: 'payment_type' }],
    slicerDock: 'top',
  });
}

function planFor(tiles) {
  const kpis = tiles.filter((t) => t.chart.chart_type === 'KPI').map((t) => t.id);
  return {
    layer: 'redesign',
    direction: { style: 'executive', density: 'balanced' },
    sections: [
      { primitive: 'kpi_strip', visuals: kpis },
      { primitive: 'two_one', visuals: [105, 106] },
      { primitive: 'full_width', visuals: [107] },
      { primitive: 'table_full', visuals: [108] },
    ],
    visualPreferences: {
      105: { role: 'primary', emphasis: 'high' },
      106: { role: 'breakdown', emphasis: 'normal' },
      107: { role: 'secondary', emphasis: 'normal' },
      108: { role: 'table', emphasis: 'low' },
    },
  };
}

function compile(tiles, plan) {
  const snapshot = makeSnapshot(tiles);
  return compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
}

/** Apply a compiled mutation to the fixture tiles, the way the executor will. */
function applyMutation(tiles, mutation) {
  return tiles.map((tile) => {
    const override = mutation.layoutOverrides[tile.id];
    return override ? { ...tile, layout: { ...tile.layout, ...override } } : tile;
  });
}

// ── Capability registry ─────────────────────────────────────────────────────

check('no data-semantic style key is reachable from a plan', () => {
  for (const key of capabilities.SEMANTIC_CHART_STYLE_KEYS) {
    assert(
      !capabilities.isAllowedChartStyleKey(key),
      `"${key}" changes what the chart shows but is in the AI style allow-list`,
    );
  }
});

check('the style allow-list and the semantic list do not intersect', () => {
  const allowed = new Set(capabilities.AI_ALLOWED_CHART_STYLE_KEYS);
  const overlap = capabilities.SEMANTIC_CHART_STYLE_KEYS.filter((k) => allowed.has(k));
  assertEqual(overlap, [], 'keys claimed as both presentation and semantic');
});

check('theme keys come from the catalog, not from a second list', () => {
  const catalog = load('lib/dashboard-theme-catalog.ts');
  for (const key of [...catalog.TEMPLATE_KEYS, ...catalog.COLORWAY_KEYS]) {
    assert(capabilities.isAllowedThemeKey(key), `catalog key "${key}" is not reachable`);
  }
  assert(!capabilities.isAllowedThemeKey('backgroundImage'), 'backgroundImage should not be settable by a plan');
  assert(!capabilities.isAllowedThemeKey('__proto__x'), 'unknown key accepted');
});

check('the capability schema only advertises real ids', () => {
  const schema = capabilities.buildCapabilitySchema();
  assert(schema.theme.templates.includes('console'), 'template ids missing from schema');
  assert(schema.theme.colorways.includes('slate'), 'colorway ids missing from schema');
  assert(schema.grid.columns === COLS, `schema says ${schema.grid.columns} columns, grid has ${COLS}`);
});

check('the schema names the mood of every theme option so dark/modern is choosable', () => {
  const schema = capabilities.buildCapabilitySchema();
  const guide = schema.theme.colorwayGuide;
  assert(Array.isArray(guide) && guide.length === schema.theme.colorways.length, 'colorwayGuide does not cover every colorway');
  // A "dark violet SaaS" request has to be answerable on purpose, not by luck:
  // at least one option is dark, and every option carries the accent a planner
  // matches a named colour to.
  assert(guide.some((c) => c.mode === 'dark'), 'no dark colorway is advertised — a dark request cannot be honoured');
  for (const c of guide) {
    assert(typeof c.accent === 'string' && c.accent.length > 0, `colorway ${c.id} advertises no accent colour`);
  }
  const templateGuide = schema.theme.templateGuide;
  assert(Array.isArray(templateGuide) && templateGuide.some((t) => t.skin === 'modern'), 'no modern-skinned template is advertised');
});

check('the rail primitive is advertised to the planner', () => {
  const types = load('lib/dashboard-presentation/types.ts');
  assert(types.LAYOUT_PRIMITIVES.includes('hero_with_rail'), 'hero_with_rail missing from the primitive list');
  const schema = capabilities.buildCapabilitySchema();
  assert(schema.composition.primitives.includes('hero_with_rail'), 'hero_with_rail is not offered in the capability schema');
});

// ── Role inference ──────────────────────────────────────────────────────────

check('role inference reads meaning first, geometry last', () => {
  const kpi = roles.inferPresentationRole({ chartType: 'KPI', widgetType: 'chart', w: 9, y: 0, gridColumns: COLS });
  assertEqual(kpi, 'kpi', 'a KPI is a KPI');
  // Geometry no longer promotes a number to the headline: that was the layout
  // re-confirming itself. The planner chooses a headline from meaning.
  const wideKpi = roles.inferPresentationRole({ chartType: 'KPI', widgetType: 'chart', w: 36, y: 0, gridColumns: COLS });
  assertEqual(wideKpi, 'kpi', 'a KPI was promoted by its width alone');
  // A series over time carries the argument however narrow the author made it.
  const narrowTrend = roles.inferPresentationRole({ chartType: 'LINE', widgetType: 'chart', w: 9, y: 20, gridColumns: COLS });
  assertEqual(narrowTrend, 'primary', 'a narrow trend was demoted by its width');
  const temporalBar = roles.inferPresentationRole({ chartType: 'BAR', widgetType: 'chart', w: 9, y: 20, gridColumns: COLS, temporal: true });
  assertEqual(temporalBar, 'primary', 'a bar over time was not read as the argument');
  const ranking = roles.inferPresentationRole({ chartType: 'BAR', widgetType: 'chart', w: 30, y: 0, gridColumns: COLS, intent: 'ranking' });
  assertEqual(ranking, 'secondary', 'metadata intent did not outrank width');
  // With no meaning to go on, the author's sizing is still evidence.
  const wideBar = roles.inferPresentationRole({ chartType: 'BAR', widgetType: 'chart', w: 30, y: 0, gridColumns: COLS });
  assertEqual(wideBar, 'primary', 'a wide bar with no other signal lost its prominence');
  const table = roles.inferPresentationRole({ chartType: 'TABLE', widgetType: 'chart', w: 36, y: 9, gridColumns: COLS });
  assertEqual(table, 'table', 'tables are detail');
});

// ── Compiler ────────────────────────────────────────────────────────────────

check('a compiled page has no overlaps and no overflow', () => {
  const tiles = makeTiles();
  const { mutation } = compile(tiles, planFor(tiles));
  const overlaps = validator.findOverlaps(mutation.layoutOverrides);
  assertEqual(overlaps, [], 'compiled layout overlaps');
  for (const [id, l] of Object.entries(mutation.layoutOverrides)) {
    assert(l.x >= 0 && l.y >= 0, `visual ${id} has a negative coordinate`);
    assert(l.x + l.w <= COLS, `visual ${id} ends at ${l.x + l.w}, past the ${COLS}-column grid`);
  }
});

check('every visual is placed exactly once', () => {
  const tiles = makeTiles();
  const { mutation } = compile(tiles, planFor(tiles));
  const placed = Object.keys(mutation.layoutOverrides).map(Number).sort((a, b) => a - b);
  assertEqual(placed, tiles.map((t) => t.id).sort((a, b) => a - b), 'placed set differs from the page');
});

check('a plan that forgets a visual still places it', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.sections = plan.sections.filter((s) => !s.visuals.includes(108)); // drop the table
  const { mutation, orphanIds } = compile(tiles, plan);
  assertEqual(orphanIds, [108], 'the forgotten visual was not detected');
  assert(mutation.layoutOverrides[108] != null, 'the forgotten visual was lost');
  assert(mutation.notes.some((n) => /not placed/.test(n)), 'the user was not told the plan was incomplete');
});

check('a plan listing the same visual twice places it once', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.sections.push({ primitive: 'full_width', visuals: [105] });
  const { mutation } = compile(tiles, plan);
  const count = Object.keys(mutation.layoutOverrides).filter((id) => Number(id) === 105).length;
  assertEqual(count, 1, 'duplicate placement');
});

check('a KPI strip divides the grid exactly', () => {
  for (const n of [2, 3, 4, 6]) {
    const spans = compiler.splitRow(n);
    assertEqual(spans.reduce((a, b) => a + b, 0), COLS, `${n} KPIs do not fill the row`);
  }
});

check('a KPI never gets a column count too narrow for its title', () => {
  // Six KPIs across gave each card 6 of 36 columns and every title truncated
  // to "GMV (...". Four is the most a strip may hold; past that it wraps.
  const tiles = makeTiles();
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const extra = [];
    for (let i = 0; i < n; i += 1) {
      extra.push({
        id: 300 + i, chart_id: 800 + i, widget_type: 'chart',
        layout: { x: 0, y: 0, w: 9, h: 6, gv: 2, pageId: 'page-1' },
        chart: { id: 800 + i, name: `KPI ${i}`, chart_type: 'KPI', dataset_id: 111, config: {} },
      });
    }
    const ids = extra.map((t) => t.id);
    const plan = {
      layer: 'redesign',
      direction: { style: 'executive', density: 'balanced' },
      sections: [{ primitive: 'kpi_strip', visuals: ids }],
      visualPreferences: {},
    };
    const snapshot = makeSnapshot(extra);
    const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
    for (const id of ids) {
      assert(mutation.layoutOverrides[id].w >= 9, `${n} KPIs: card ${id} got ${mutation.layoutOverrides[id].w} columns`);
    }
    // and no lonely full-width leftover
    const byRow = new Map();
    for (const id of ids) {
      const y = mutation.layoutOverrides[id].y;
      byRow.set(y, (byRow.get(y) ?? 0) + 1);
    }
    if (byRow.size > 1) {
      for (const [y, cardsInRow] of byRow) {
        assert(cardsInRow >= 2, `${n} KPIs: row y=${y} has a single stranded card`);
      }
    }
    assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], `${n} KPIs overlap`);
  }
  void tiles;
});

check('a chart never gets fewer than a third of the width', () => {
  // Four charts in one section became four 9-column slivers: the line chart's
  // month labels smeared together and the treemap showed "health_", "watche".
  const tiles = makeTiles();
  const charts = [105, 106, 107, 108];
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'two_equal', visuals: charts }], // declares 2, holds 4
    visualPreferences: {},
  };
  const { mutation } = compile(tiles, plan);
  for (const id of charts) {
    assert(mutation.layoutOverrides[id].w >= 12, `chart ${id} got ${mutation.layoutOverrides[id].w} columns`);
  }
  assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], 'the wrapped charts overlap');
});

check('a primitive that fits its section is honoured, not capped', () => {
  // analysis_with_sidebar deliberately pairs a 27-column chart with a 9-column
  // one. Capping everything at a third would erase intentional compositions.
  const tiles = makeTiles();
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'analysis_with_sidebar', visuals: [105, 106] }],
    visualPreferences: {},
  };
  const { mutation } = compile(tiles, plan);
  assertEqual(mutation.layoutOverrides[105].w, 27, 'the wide half was rewritten');
  assertEqual(mutation.layoutOverrides[106].w, 9, 'the sidebar was rewritten');
});

check('hero_with_rail stacks a vertical rail beside a full-height hero', () => {
  const tiles = makeTiles();
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'hero_with_rail', visuals: [105, 106, 107] }],
    visualPreferences: {
      105: { role: 'primary', emphasis: 'high' },
      106: { role: 'secondary', emphasis: 'normal' },
      107: { role: 'breakdown', emphasis: 'normal' },
    },
  };
  const { mutation } = compile(tiles, plan);
  const hero = mutation.layoutOverrides[105];
  const r1 = mutation.layoutOverrides[106];
  const r2 = mutation.layoutOverrides[107];
  // Hero on the left, the rail a single column on the right, together filling
  // the grid with no shared column.
  assertEqual(hero.x, 0, 'the hero is not at the left edge');
  assert(hero.w >= 24, `the hero is only ${hero.w} columns wide`);
  assertEqual(r1.x, hero.w, 'the rail does not begin where the hero ends');
  assertEqual(r1.x, r2.x, 'the rail is not a single column');
  assertEqual(hero.w + r1.w, COLS, `hero ${hero.w} + rail ${r1.w} do not fill ${COLS}`);
  // The rail is stacked, not overlapping, and its bottom meets the hero's — the
  // whole point of the primitive, and the thing the grid's row model buys us.
  assertEqual(r2.y, r1.y + r1.h, 'the second rail tile does not sit below the first');
  assertEqual(hero.y + hero.h, r2.y + r2.h, "the rail bottom does not meet the hero's");
  assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], 'the hero and rail overlap');
  // Nothing may exceed a tile's maximum height, or the mutation validator would
  // reject the whole redesign as un-actionable geometry.
  for (const id of [105, 106, 107]) {
    assert(mutation.layoutOverrides[id].h <= 24, `visual ${id} is ${mutation.layoutOverrides[id].h} rows (max 24)`);
    assert(mutation.layoutOverrides[id].x + mutation.layoutOverrides[id].w <= COLS, `visual ${id} overflows the grid`);
  }
});

check('hero_with_rail keeps identity and semantics like any other primitive', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [
      { primitive: 'kpi_strip', visuals: [101, 102, 103, 104] },
      { primitive: 'hero_with_rail', visuals: [105, 106, 107] },
      { primitive: 'table_full', visuals: [108] },
    ],
    visualPreferences: {
      105: { role: 'primary', emphasis: 'high' },
      106: { role: 'secondary', emphasis: 'normal' },
      107: { role: 'breakdown', emphasis: 'normal' },
    },
  };
  const { mutation, orphanIds } = compile(tiles, plan);
  assertEqual(orphanIds, [], 'a rail composition dropped a visual');
  const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
  const result = validator.validatePresentationMutation({ before, after, mutation, pageId: 'page-1' });
  assert(result.ok, `a rail composition broke the contract: ${JSON.stringify(result.violations)}`);
});

check('hero_with_rail degrades to something sane when it holds too few or too many', () => {
  const tiles = makeTiles();
  // One visual: no rail to build, so it is simply full width.
  const single = compile(tiles, {
    layer: 'redesign', direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'hero_with_rail', visuals: [105] }], visualPreferences: {},
  });
  assertEqual(single.mutation.layoutOverrides[105].w, COLS, 'a lone hero was not made full width');
  // Six visuals: too many for a legible rail, so it falls back to a clean wall
  // rather than a column of slivers.
  const many = compile(tiles, {
    layer: 'redesign', direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'hero_with_rail', visuals: [101, 102, 103, 104, 105, 106] }], visualPreferences: {},
  });
  assertEqual(validator.findOverlaps(many.mutation.layoutOverrides), [], 'the oversized rail fell back into overlaps');
  for (const id of [101, 102, 103, 104, 105, 106]) {
    assert(many.mutation.layoutOverrides[id].w >= 12, `fallback gave visual ${id} only ${many.mutation.layoutOverrides[id].w} columns`);
  }
});

check('five KPIs wrap instead of producing a 5th sliver', () => {
  const tiles = makeTiles();
  tiles.push({
    id: 109, chart_id: 909, widget_type: 'chart',
    layout: { x: 0, y: 20, w: 12, h: 2, gv: 2, pageId: 'page-1' },
    chart: { id: 909, name: 'Refunds', chart_type: 'KPI', dataset_id: 111, config: {} },
  });
  const plan = planFor(tiles);
  plan.sections[0].visuals = [101, 102, 103, 104, 109];
  const { mutation } = compile(tiles, plan);
  const rows = new Set([101, 102, 103, 104, 109].map((id) => mutation.layoutOverrides[id].y));
  assert(rows.size > 1, 'five KPIs were crammed into one row');
  assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], 'wrapped KPIs overlap');
});

check('every primitive divides the grid exactly', () => {
  const types = load('lib/dashboard-presentation/types.ts');
  for (const primitive of types.LAYOUT_PRIMITIVES) {
    const spans = compiler.primitiveSpans(primitive);
    if (spans === null) continue; // kpi_strip sizes itself to the count
    const total = spans.reduce((a, b) => a + b, 0);
    assertEqual(total, COLS, `primitive "${primitive}" spans sum to ${total}, not ${COLS}`);
  }
});

check('every primitive compiles without overlap or overflow', () => {
  // The fixture plan only exercises a few primitives, and `placeRow` clamps an
  // over-wide span to the space left — which would let a wrong span table ship
  // looking fine. Drive each primitive with the number of visuals it declares.
  const types = load('lib/dashboard-presentation/types.ts');
  const tiles = makeTiles();
  for (const primitive of types.LAYOUT_PRIMITIVES) {
    const declared = compiler.primitiveSpans(primitive);
    const count = declared ? declared.length : 4;
    const visuals = tiles.slice(0, count).map((t) => t.id);
    const plan = {
      layer: 'redesign',
      direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive, visuals }],
      visualPreferences: {},
    };
    const { mutation } = compile(tiles, plan);
    assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], `"${primitive}" produced overlapping tiles`);
    for (const [id, l] of Object.entries(mutation.layoutOverrides)) {
      assert(l.x + l.w <= COLS, `"${primitive}": visual ${id} ends at column ${l.x + l.w}`);
    }
    // The primitive's own row must fill the width — a composition that leaves a
    // ragged right edge reads as a bug even when nothing overlaps.
    if (declared) {
      const row = visuals.map((id) => mutation.layoutOverrides[id]);
      const width = row.reduce((sum, l) => sum + l.w, 0);
      assertEqual(width, COLS, `"${primitive}" filled ${width} of ${COLS} columns`);
    }
  }
});

check('KPIs asked for at half-page width are folded into a strip', () => {
  // What the model actually did on the real report: four headline numbers in
  // two_equal pairs, each 18 columns wide and two rows tall.
  const tiles = makeTiles();
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [
      { primitive: 'two_equal', visuals: [101, 102] },
      { primitive: 'two_equal', visuals: [103, 104] },
      { primitive: 'two_one', visuals: [105, 106] },
    ],
    visualPreferences: {
      101: { role: 'kpi', emphasis: 'normal' },
      102: { role: 'kpi', emphasis: 'normal' },
      103: { role: 'kpi', emphasis: 'normal' },
      104: { role: 'kpi', emphasis: 'normal' },
    },
  };
  const { mutation } = compile(tiles, plan);
  const rows = new Set([101, 102, 103, 104].map((id) => mutation.layoutOverrides[id].y));
  assertEqual([...rows].length, 1, 'the four KPIs did not end up on one row');
  for (const id of [101, 102, 103, 104]) {
    assertEqual(mutation.layoutOverrides[id].w, 9, `KPI ${id} is ${mutation.layoutOverrides[id].w} columns wide`);
  }
  assert(mutation.notes.some((n) => /strip/i.test(n)), 'the regrouping was not disclosed');
  assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], 'regrouping caused an overlap');
});

check('a mixed section is left alone', () => {
  // Only sections that are ENTIRELY headline numbers get folded — a KPI sitting
  // deliberately beside a chart is a composition, not a mistake.
  const tiles = makeTiles();
  const plan = {
    layer: 'redesign',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'two_equal', visuals: [101, 105] }],
    visualPreferences: {
      101: { role: 'kpi', emphasis: 'normal' },
      105: { role: 'primary', emphasis: 'high' },
    },
  };
  const { mutation } = compile(tiles, plan);
  assertEqual(mutation.layoutOverrides[101].w, 18, 'a deliberate KPI-beside-chart pairing was rewritten');
});

check('the compiler is deterministic', () => {
  const tiles = makeTiles();
  const a = compile(tiles, planFor(tiles)).mutation.layoutOverrides;
  const b = compile(tiles, planFor(tiles)).mutation.layoutOverrides;
  assertEqual(a, b, 'two compilations of the same plan differ');
});

/** What a tile of `h` rows actually measures, by the renderer's arithmetic. */
function tileHeightPx(h, gap = 8) {
  const rowHeight = pages.dashboardRowHeight(gap);
  return h * rowHeight + (h - 1) * gap;
}

check('a compiled tile is tall enough to read', () => {
  // The published redesign had 51px KPI cards and 109px charts: the numbers
  // were clipped and the axes unreadable. Row counts alone never showed it —
  // the finer grid's row is ~21px, so h=2 is not "two rows of something", it is
  // half a line of text.
  const tiles = makeTiles();
  const { mutation } = compile(tiles, planFor(tiles));
  const px = (id) => tileHeightPx(mutation.layoutOverrides[id].h);
  for (const id of [101, 102, 103, 104]) {
    // A KPI is a number + label, not an axis — a compact strip card (~1 line of
    // value) reads fine; holding it to the chart floor left tall, half-empty
    // cards (§ KPI-too-tall). Still must clear a floor a value can be read in.
    assert(px(id) >= 105, `KPI ${id} compiles to ${Math.round(px(id))}px — a number cannot be read in that`);
    assert(px(id) <= 150, `KPI ${id} compiles to ${Math.round(px(id))}px — a single number does not need a card that tall`);
  }
  assert(px(105) >= 300, `the primary chart is ${Math.round(px(105))}px tall`);
  assert(px(108) >= 380, `the table is ${Math.round(px(108))}px tall`);
});

check('a gauge/funnel keeps chart height even when the role is a compact KPI', () => {
  // The on-time gauge came out as a squished 91.9 because GAUGE is a KPI_TYPE →
  // 'kpi' role → the compact strip height. A gauge is a chart; it must keep the
  // height its shape needs regardless of the role.
  for (const type of ['GAUGE', 'FUNNEL']) {
    const tiles = makeTiles();
    tiles[0].chart.chart_type = type; // 101 becomes a gauge/funnel
    const plan = {
      layer: 'redesign', direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'full_width', visuals: [101] }],
      visualPreferences: { 101: { role: 'kpi', emphasis: 'normal' } },
    };
    const { mutation } = compile(tiles, plan);
    const px = tileHeightPx(mutation.layoutOverrides[101].h);
    assert(px >= 200, `a ${type} in a kpi role compiled to ${Math.round(px)}px — too short to render`);
  }
});

check('no data visual compiles below the readable floor, at any density', () => {
  // `compact` applied to a gauge produced a 109px tile next to 300px charts.
  // Role × density × emphasis multiply, so the outcome is clamped rather than
  // every combination audited.
  const tiles = makeTiles();
  for (const density of ['compact', 'balanced', 'spacious']) {
    for (const span of ['low', 'normal', 'high']) {
      const prefs = {};
      for (const tile of tiles) prefs[tile.id] = { role: 'kpi', span, emphasis: 'low' };
      const plan = {
        layer: 'redesign',
        direction: { style: 'minimal', density },
        sections: [{ primitive: 'full_width', visuals: [108] }],
        visualPreferences: prefs,
      };
      const { mutation } = compile(tiles, plan);
      for (const [id, l] of Object.entries(mutation.layoutOverrides)) {
        const px = tileHeightPx(l.h);
        // KPI role floors lower than a chart (a number, not an axis).
        assert(px >= 100, `${density}/${span}: visual ${id} compiled to ${Math.round(px)}px`);
      }
    }
  }
});

check('every tile in a row shares one height', () => {
  const tiles = makeTiles();
  const { mutation } = compile(tiles, planFor(tiles));
  const rows = new Map();
  for (const [id, l] of Object.entries(mutation.layoutOverrides)) {
    const list = rows.get(l.y) ?? [];
    list.push({ id, h: l.h });
    rows.set(l.y, list);
  }
  for (const [y, list] of rows) {
    const heights = new Set(list.map((t) => t.h));
    assertEqual([...heights].length, 1, `row y=${y} has mixed heights ${JSON.stringify(list)}`);
  }
});

check('heights follow the theme gap, not a hard-coded row count', () => {
  // The row pitch is (80 − 2·gap)/3, so a denser theme changes how many rows a
  // given pixel height needs. A compiler that ignored the gap would be right at
  // one density and wrong at every other.
  const tight = compiler.rowsForHeight(380, 4);
  const loose = compiler.rowsForHeight(380, 16);
  assert(tight !== loose, 'row count is identical at two very different gaps');
  for (const gap of [4, 8, 12, 16]) {
    const h = compiler.rowsForHeight(380, gap);
    const px = tileHeightPx(h, gap);
    assert(Math.abs(px - 380) <= 40, `at gap ${gap}, a 380px target compiled to ${Math.round(px)}px`);
  }
});

check('density changes heights, not identity', () => {
  const tiles = makeTiles();
  const compact = compile(tiles, { ...planFor(tiles), direction: { style: 'executive', density: 'compact' } });
  const spacious = compile(tiles, { ...planFor(tiles), direction: { style: 'executive', density: 'spacious' } });
  assertEqual(
    Object.keys(compact.mutation.layoutOverrides).sort(),
    Object.keys(spacious.mutation.layoutOverrides).sort(),
    'density changed which visuals exist',
  );
  assert(
    spacious.mutation.layoutOverrides[105].h > compact.mutation.layoutOverrides[105].h,
    'spacious is not taller than compact',
  );
});

// ── The data-integrity invariant (§4) ───────────────────────────────────────

check('identity and semantics survive a redesign', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const { mutation } = compile(tiles, planFor(tiles));
  const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
  const result = validator.validatePresentationMutation({ before, after, mutation, pageId: 'page-1' });
  assert(result.ok, `redesign violated the contract: ${JSON.stringify(result.violations)}`);
});

check('a style-only override (no x/y/w/h) is not rejected for phantom geometry', () => {
  // A focused single-chart restyle writes only styleConfigOverride — nothing
  // moves. The mutation validator must not read a missing x/y/w/h as NaN and
  // reject a restyle for a geometry it never touched.
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutation = {
    layoutOverrides: { 105: { styleConfigOverride: { lineWidth: 3, showGrid: false, showDots: true } } },
    themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign',
  };
  const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
  const result = validator.validatePresentationMutation({ before, after, mutation, pageId: 'page-1' });
  assert(result.ok, `a pure restyle was rejected: ${JSON.stringify(result.violations)}`);
  assert(!result.violations.some((v) => String(v.code).startsWith('grid.')), 'phantom geometry violation raised');
});

check('a removed chart is caught', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const after = snapshotMod.buildPresentationFingerprint(tiles.filter((t) => t.id !== 106));
  const result = validator.validatePresentationMutation({
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
    pageId: 'page-1',
  });
  assert(!result.ok && !result.repairable, 'a missing chart was not a hard failure');
  assert(result.violations.some((v) => v.code === 'identity.missing'), 'wrong violation code');
});

check('BAR becoming LINE is caught', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutated = tiles.map((t) => (t.id === 107 ? { ...t, chart: { ...t.chart, chart_type: 'LINE' } } : t));
  const after = snapshotMod.buildPresentationFingerprint(mutated);
  const result = validator.validatePresentationMutation({
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
    pageId: 'page-1',
  });
  assert(result.violations.some((v) => v.code === 'identity.chartType'), 'chart-type change slipped through');
});

check('a changed Top-N is caught even though it lives in styleConfigOverride', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutated = tiles.map((t) => (t.id === 107
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { dataLimit: 5 } } }
    : t));
  const after = snapshotMod.buildPresentationFingerprint(mutated);
  const result = validator.validatePresentationMutation({
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
    pageId: 'page-1',
  });
  assert(result.violations.some((v) => v.code === 'identity.semantics'), 'a row limit passed as a restyle');
});

check('a purely visual restyle is NOT flagged as semantic', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutated = tiles.map((t) => (t.id === 107
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { legendPosition: 'right', showGrid: false } } }
    : t));
  const after = snapshotMod.buildPresentationFingerprint(mutated);
  const result = validator.validatePresentationMutation({
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
    pageId: 'page-1',
  });
  assert(result.ok, `a legitimate restyle was rejected: ${JSON.stringify(result.violations)}`);
});

check('moving a visual to another page is caught', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutation = {
    layoutOverrides: { 105: { x: 0, y: 0, w: 18, h: 4, pageId: 'page-2' } },
    themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign',
  };
  const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
  const result = validator.validatePresentationMutation({ before, after, mutation, pageId: 'page-1' });
  assert(!result.ok && !result.repairable, 'a cross-page move was not a hard failure');
  assert(result.violations.some((v) => v.code === 'identity.page' || v.code === 'grid.pageEscape'), 'wrong code');
});

// ── Plan validation ─────────────────────────────────────────────────────────

check('a plan naming a visual that is not on the page is refused', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.sections.push({ primitive: 'full_width', visuals: [9999] });
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(!result.ok && !result.repairable, 'a hallucinated visual was accepted');
});

check('an unknown capability key is refused', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.tileStyles = { 105: { glassmorphism: true } };
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.violations.some((v) => v.code === 'plan.styleKey'), 'an invented style key was accepted');
});

check('a plan cannot set a row limit through tileStyles', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.tileStyles = { 107: { dataLimit: 5 } };
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(!result.ok, 'dataLimit was accepted as a tile style');
});

check('an unknown template or colorway is refused', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.themeIntent = { template: 'cyberpunk', colorway: 'neon' };
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.violations.some((v) => v.code === 'plan.template'), 'invented template accepted');
  assert(result.violations.some((v) => v.code === 'plan.colorway'), 'invented colorway accepted');
});

check('a slicer intent cannot carry a field', () => {
  const tiles = makeTiles();
  const plan = planFor(tiles);
  plan.slicerPresentation = { dock: 'left', field: 'order_status' };
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.violations.some((v) => v.code === 'plan.slicerSemantic'), 'a slicer field passed as presentation');
});

check('a decorative caption may name a section but not state a finding', () => {
  assert(!validator.looksLikeAFabricatedFinding('Revenue'), 'a plain heading was rejected');
  assert(!validator.looksLikeAFabricatedFinding('Performance by region'), 'a plain heading was rejected');
  assert(validator.looksLikeAFabricatedFinding('Revenue grew 24% this quarter'), 'a fabricated finding passed');
  assert(validator.looksLikeAFabricatedFinding('Doanh thu tăng 12 tỷ'), 'a fabricated Vietnamese finding passed');
  assert(validator.looksLikeAFabricatedFinding('Best performing region'), 'a superlative passed');
});

check('decorative widgets are not advertised, and asking for one is disclosed', () => {
  // They were validated and then never created — a capability the model was
  // offered that silently did nothing. Removed from the contract until real.
  const schema = capabilities.buildCapabilitySchema();
  assert(!('decorative' in schema), 'the schema still advertises decorative widgets');
  assert(!('decorativeWidgets' in schema.capabilities), 'decorative widgets still listed as a capability');
  const { plan, notes } = validator.coerceModelPlan(
    { layer: 'redesign', direction: {}, sections: [], decorativeElements: [{ widgetType: 'section_header', text: 'Overview' }] },
    { grantedLayer: 'redesign' },
  );
  assert(!('decorativeElements' in plan), 'a decorative element survived coercion');
  assert(notes.some((n) => /section header/i.test(n)), 'the user was not told no header was created');
});

check('span is no longer a lever, emphasis is — and it really changes height', () => {
  const schema = capabilities.buildCapabilitySchema();
  assert(!('spans' in schema.visual), 'the schema still offers span');
  assert(!('allowedSpans' in (schema.grid ?? {})), 'the schema still offers allowedSpans');
  const tiles = makeTiles();
  const base = { layer: 'redesign', direction: { style: 'saas', density: 'balanced' }, sections: [{ primitive: 'full_width', visuals: [105] }] };
  const low = compile(tiles, { ...base, visualPreferences: { 105: { role: 'primary', emphasis: 'low' } } }).mutation.layoutOverrides[105].h;
  const high = compile(tiles, { ...base, visualPreferences: { 105: { role: 'primary', emphasis: 'high' } } }).mutation.layoutOverrides[105].h;
  assert(high > low, `emphasis did not change height (low ${low}, high ${high})`);
});

check('section_break is read as what it did — full width — not as a heading', () => {
  const { plan } = validator.coerceModelPlan(
    { layer: 'redesign', direction: {}, sections: [{ primitive: 'section_break', visuals: [105], title: 'Trends' }] },
    { grantedLayer: 'redesign' },
  );
  assertEqual(plan.sections[0].primitive, 'full_width', 'section_break was not mapped');
  assert(!('title' in plan.sections[0]), 'a heading nobody renders survived');
});

check('geometry problems are repairable, semantic problems are not', () => {
  const geometryOnly = validator.validatePresentationMutation({
    before: {}, after: {}, pageId: 'page-1',
    mutation: {
      layoutOverrides: { 1: { x: 30, y: 0, w: 12, h: 4 } }, // ends at column 42
      themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign',
    },
  });
  assert(!geometryOnly.ok, 'an overflowing tile was accepted');
  assert(geometryOnly.repairable, 'a pure geometry problem should be repairable');
});

// ── Snapshot hygiene ────────────────────────────────────────────────────────

check('the snapshot carries meaning as labels, never data-source identity', () => {
  // The Design Context must say what a visual is ABOUT (measure/dimension
  // labels, time, description) without exposing where the data comes from.
  const tiles = makeTiles().map((t) => (t.id === 105
    ? {
        ...t,
        chart: {
          ...t.chart,
          description: 'Monthly revenue',
          config: {
            roleConfig: {
              dimension: 'orders.order_purchase_date',
              metrics: [{ field: 'orders.total_revenue', agg: 'sum' }],
              timeGrains: { 'orders.order_purchase_date': 'month' },
            },
            customSql: 'SELECT secret FROM warehouse',
            semanticBinding: { datasetId: 111 },
          },
        },
      }
    : t));
  const snapshot = makeSnapshot(tiles);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['dataset_id', 'datasetId', 'SELECT', 'secret', '"config"', 'payment_type', 'orders.total_revenue', 'orders.order_purchase_date']) {
    assert(!serialized.includes(forbidden), `the snapshot leaks "${forbidden}"`);
  }
  const trend = snapshot.visuals.find((v) => v.dashboardChartId === 105);
  assertEqual(trend.meaning.measures[0].label, 'Total revenue', 'the measure was not described');
  assertEqual(trend.meaning.temporal, true, 'a time series was not recognised as temporal');
  assertEqual(trend.meaning.description, 'Monthly revenue', 'the chart description was not carried');
  assertEqual(snapshot.visuals.length, tiles.length, 'snapshot lost a visual');
  assertEqual(snapshot.slicers[0].displayLabel, 'Payment Type', 'slicer label missing');
});

check('semantic labels from the dataset model win over humanised field names', () => {
  const designContext = load('lib/dashboard-presentation/design-context.ts');
  const index = designContext.buildFieldMetaIndex([[
    { name: 'orders', dimensions: [{ name: 'created', label: 'Order date', type: 'date' }], measures: [{ name: 'gmv', label: 'GMV', format: { kind: 'currency' } }] },
  ]]);
  const meaning = designContext.buildVisualMeaning({
    chart: { chart_type: 'BAR', config: { roleConfig: { dimension: 'orders.created', metrics: [{ field: 'orders.gmv', agg: 'sum' }] } } },
    fieldMeta: index,
  });
  assertEqual(meaning.measures[0].label, 'GMV', 'the semantic label was not used');
  assertEqual(meaning.measures[0].format, 'currency', 'the measure format was not carried');
  assertEqual(meaning.dimensions[0].label, 'Order date', 'the dimension label was not used');
  assertEqual(meaning.temporal, true, 'a date-typed dimension was not temporal');
  // Graceful with nothing: an empty chart has an empty meaning, not an error.
  const empty = designContext.buildVisualMeaning({ chart: null });
  assertEqual(empty.measures, [], 'an empty chart produced measures');
});

check('the snapshot records reading order and locks', () => {
  const tiles = makeTiles().map((t) => (t.id === 106 ? { ...t, layout: { ...t.layout, locked: true } } : t));
  const snapshot = makeSnapshot(tiles);
  const orders = snapshot.visuals.map((v) => v.readingOrder).sort((a, b) => a - b);
  assertEqual(orders, tiles.map((_, i) => i + 1), 'reading order is not a permutation');
  assertEqual(snapshot.visuals.find((v) => v.dashboardChartId === 101).readingOrder, 1, 'top-left is not first');
  assertEqual(snapshot.visuals.find((v) => v.dashboardChartId === 106).locked, true, 'a lock was not reported');
});

check('the snapshot describes tiles at their rendered coordinates', () => {
  const legacy = makeTiles().map((t) => ({ ...t, layout: { x: 0, y: 0, w: 4, h: 2 } })); // gv absent = 12-col
  const snapshot = makeSnapshot(legacy);
  assertEqual(snapshot.visuals[0].currentLayout.w, 12, 'a legacy 12-column tile was not upscaled for the planner');
});

// ── Template convergence (§19) ──────────────────────────────────────────────

const templates = load('lib/dashboard-presentation/templates.ts');

check('every template is a plan the validator accepts', () => {
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  for (const id of templates.templateIntentIds()) {
    const plan = templates.planFromTemplate(id, snapshot);
    const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
    assert(result.ok, `template "${id}" produced an invalid plan: ${JSON.stringify(result.violations)}`);
  }
});

check('every template compiles to a clean page that keeps every visual', () => {
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  for (const id of templates.templateIntentIds()) {
    const plan = templates.planFromTemplate(id, snapshot);
    const { mutation, orphanIds } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
    assertEqual(orphanIds, [], `template "${id}" forgot a visual`);
    assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], `template "${id}" overlaps`);
    const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
    const check2 = validator.validatePresentationMutation({ before, after, mutation, pageId: 'page-1' });
    assert(check2.ok, `template "${id}" broke the contract: ${JSON.stringify(check2.violations)}`);
  }
});

check('templates differ in COMPOSITION, not only in colour', () => {
  // The complaint that started this: five presets that were one layout in five
  // palettes. Two templates must not compile to the same geometry.
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  const shapes = new Map();
  for (const id of templates.templateIntentIds()) {
    const plan = templates.planFromTemplate(id, snapshot);
    const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
    const shape = JSON.stringify(
      Object.entries(mutation.layoutOverrides)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, l]) => [l.x, l.y, l.w, l.h]),
    );
    shapes.set(id, shape);
  }
  const distinct = new Set(shapes.values());
  assert(
    distinct.size >= 4,
    `${templates.templateIntentIds().length} templates produced only ${distinct.size} distinct layouts`,
  );
});

check('the saas composition anchors the page on a hero with a rail', () => {
  // The fixture's trend is narrow, so widen it into a primary the way an author
  // who cared about it would have — then the saas template must build a hero
  // with a rail of secondary charts, not fall back to a row of equal cards.
  const tiles = makeTiles().map((t) => (t.id === 105 ? { ...t, layout: { ...t.layout, w: 24 } } : t));
  const snapshot = makeSnapshot(tiles);
  const plan = templates.planFromTemplate('console', snapshot); // console → saas composition
  assert(
    plan.sections.some((s) => s.primitive === 'hero_with_rail'),
    'the saas composition produced no hero_with_rail section',
  );
  const { mutation, orphanIds } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
  assertEqual(orphanIds, [], 'the saas rail dropped a visual');
  assertEqual(validator.findOverlaps(mutation.layoutOverrides), [], 'the saas rail overlaps');
  const hero = mutation.layoutOverrides[105];
  assert(hero.w >= 24, `the hero is only ${hero.w} columns wide`);
});

check('a template puts numbers above the argument and detail last', () => {
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  const plan = templates.planFromTemplate('console', snapshot);
  const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
  const kpiY = Math.max(...[101, 102, 103, 104].map((id) => mutation.layoutOverrides[id].y));
  const trendY = mutation.layoutOverrides[105].y;
  const tableY = mutation.layoutOverrides[108].y;
  assert(kpiY < trendY, 'KPIs are not above the trend');
  assert(tableY > trendY, 'the table is not below the trend');
});

check('the four KPIs land on one row', () => {
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  const plan = templates.planFromTemplate('console', snapshot);
  const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId: 'page-1' });
  const rows = new Set([101, 102, 103, 104].map((id) => mutation.layoutOverrides[id].y));
  assertEqual([...rows].length, 1, 'the KPI strip was split across rows');
  const width = [101, 102, 103, 104].reduce((sum, id) => sum + mutation.layoutOverrides[id].w, 0);
  assertEqual(width, COLS, 'the KPI strip does not fill the row');
});

// ── The transport boundary (what a real model actually returned) ────────────

const executor = load('lib/dashboard-presentation/executor.ts');
const diffMod = load('lib/dashboard-presentation/diff.ts');

/** Whole-page build. These checks exercise recomposition, so an unlabelled
 *  plan is a redesign; the layer checks below label theirs explicitly. */
function buildFor(tiles, plan, theme = {}, targets = []) {
  return executor.buildPresentationMutation({
    plan: { layer: 'redesign', ...plan }, snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: theme, targets,
  });
}

check('a focused restyle applies only that tile and survives a stray direction', () => {
  // Verbatim shape from the deployed planner on dashboard 129 for a click-to-
  // edit restyle: `direction` filled in, `sections` omitted, one tileStyle. The
  // focused path applies ONLY the tile's tileStyle, so an unknown composition
  // style it never uses (and a missing sections list) must not sink the restyle.
  const tiles = makeTiles();
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'style',
      direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { lineWidth: 3, showGrid: false, showDots: true } },
      rationale: 'thicker line',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [105],
  });
  assert(built.ok, `focused restyle was refused: ${JSON.stringify(built.mutationValidation?.violations)}`);
  const ids = Object.keys(built.mutation.layoutOverrides);
  assertEqual(ids.length, 1, 'focused restyle touched more than one tile');
  assertEqual(ids[0], '105', 'focused restyle touched the wrong tile');
  const ov = built.mutation.layoutOverrides[105];
  assert(ov.styleConfigOverride && ov.x == null && ov.y == null && ov.w == null && ov.h == null,
    'focused restyle wrote geometry it should not have');
  assert(Object.keys(built.mutation.themePatch).length === 0, 'focused restyle leaked a theme patch');
});

check('a selected-visual restyle cannot smuggle a data-semantic key', () => {
  // The plan is refused whole (plan.styleKey) and nothing is written.
  const tiles = makeTiles();
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'style', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { dataLimit: 5 } }, rationale: 'sneaky',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [105],
  });
  assertEqual(Object.keys(built.mutation.layoutOverrides).length, 0, 'a data key survived a restyle');
  assert(!built.ok, 'a plan carrying a row limit was accepted');
});

check('chartSurface repaints any chart type via a focused restyle', () => {
  const tiles = makeTiles(); // 105 is a LINE chart
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'style', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { chartSurface: 'dark' } }, rationale: 'dark chart',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [105],
  });
  assert(built.ok, `chartSurface restyle refused: ${JSON.stringify(built.mutationValidation?.violations)}`);
  assertEqual(built.mutation.layoutOverrides[105].styleConfigOverride.chartSurface, 'dark', 'chartSurface was dropped');
});

check('a KPI-only key is dropped on a chart but kept on a KPI', () => {
  const tiles = makeTiles(); // 105 LINE, 101 KPI
  const onChart = executor.buildPresentationMutation({
    plan: { layer: 'style', direction: { style: 'x', density: 'y' }, tileStyles: { 105: { kpiBackgroundMode: 'accent' } }, rationale: 'r' },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [105],
  });
  assertEqual(Object.keys(onChart.mutation.layoutOverrides).length, 0, 'a kpi-only key rendered on a chart');
  const onKpi = executor.buildPresentationMutation({
    plan: { layer: 'style', direction: { style: 'x', density: 'y' }, tileStyles: { 101: { kpiBackgroundMode: 'accent' } }, rationale: 'r' },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [101],
  });
  assertEqual(onKpi.mutation.layoutOverrides[101].styleConfigOverride.kpiBackgroundMode, 'accent', 'a kpi key was dropped from a KPI');
});

check('a report theme change resets per-tile colour but keeps non-colour styles', () => {
  // A KPI carrying a leftover accent + a hand-set line width. A report-scoped
  // theme change must clear the colour (so the new theme shows) but keep the
  // line width (not a colour, not the theme's business).
  const tiles = makeTiles().map((t) => (t.id === 101
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { kpiAccentColor: 'blue', lineWidth: 3 } } }
    : t));
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'redesign',
      direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'kpi_strip', visuals: [101, 102, 103, 104] }, { primitive: 'full_width', visuals: [105] }],
      visualPreferences: {},
      themeIntent: { colorway: 'indigo', accent: '#1E3A8A' },
      rationale: 'deep blue',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {},
  });
  const ov = built.mutation.layoutOverrides[101]?.styleConfigOverride ?? {};
  // The KPI's own colour follows the new theme accent (not blanked to plain text).
  assertEqual(ov.kpiAccentColor, '#1E3A8A', 'a KPI colour did not follow the new theme accent');
  assertEqual(ov.lineWidth, 3, 'a non-colour per-tile style was wrongly cleared');
  assert(Object.keys(built.mutation.themePatch).length > 0, 'the theme patch was not written');
});

check('a mode/surface per-tile key is reset (not re-pointed) by a report theme change', () => {
  const tiles = makeTiles().map((t) => (t.id === 105
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { chartSurface: 'dark', lineWidth: 3 } } }
    : t));
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'redesign', direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'kpi_strip', visuals: [101, 102, 103, 104] }, { primitive: 'full_width', visuals: [105] }],
      visualPreferences: {}, themeIntent: { colorway: 'indigo', accent: '#1E3A8A' }, rationale: 'deep blue',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {},
  });
  const ov = built.mutation.layoutOverrides[105]?.styleConfigOverride ?? {};
  assert(!('chartSurface' in ov), 'a per-tile surface survived a report theme change');
  assertEqual(ov.lineWidth, 3, 'a non-colour per-tile style was wrongly cleared');
});

check('a page-scoped or layout-only redesign never clears per-tile colour', () => {
  const tiles = makeTiles().map((t) => (t.id === 101
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { kpiAccentColor: 'blue' } } }
    : t));
  // Report scope but NO themeIntent → not a theme change → colour is kept.
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'redesign', direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'kpi_strip', visuals: [101, 102, 103, 104] }, { primitive: 'full_width', visuals: [105] }],
      visualPreferences: {}, rationale: 'layout only',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {},
  });
  const ov = built.mutation.layoutOverrides[101]?.styleConfigOverride;
  assert(!ov || ov.kpiAccentColor === 'blue', 'a layout-only redesign wrongly cleared a per-tile colour');
});

check('a custom hex accent overrides the colorway accent', () => {
  // "deep blue #1E3A8A" should show the exact colour, not the nearest named
  // colorway's approximation.
  const patch = executor.resolveThemePatch(
    { colorway: 'slate', accent: '#1E3A8A' },
    {},
  );
  assertEqual(patch.accent, '#1E3A8A', 'the custom accent was not honoured');
  assertEqual(patch.colorwayId, 'slate', 'the colorway (palette/surface) was dropped');
});

check('a second brand colour + a font reach the theme patch', () => {
  const patch = executor.resolveThemePatch(
    { colorway: 'indigo', accent: '#1E3A8A', dataColors: ['#1E3A8A', '#F97316'], fontFamily: 'inter' },
    {},
  );
  assertEqual(patch.accent, '#1E3A8A', 'accent lost');
  assertEqual(patch.dataColors, ['#1E3A8A', '#F97316'], 'the chart palette (second colour) was dropped');
  assertEqual(patch.fontFamily, 'inter', 'the font was dropped');
});

check('an unshipped font and non-hex palette entries are dropped', () => {
  // resolveThemePatch keeps only shipped fonts and real hexes.
  const patch = executor.resolveThemePatch(
    { colorway: 'indigo', fontFamily: 'comic sans', dataColors: ['#1E3A8A', 'orange', 'not-a-hex'] },
    {},
  );
  assert(!('fontFamily' in patch), 'an unshipped font survived');
  assertEqual(patch.dataColors, ['#1E3A8A'], 'a non-hex palette entry survived');
  // And coerce discloses the dropped font rather than hard-failing.
  const { plan, notes } = validator.coerceModelPlan(
    { layer: 'redesign', direction: { style: 'x', density: 'y' }, sections: [], themeIntent: { fontFamily: 'comic sans' } },
    { grantedLayer: 'redesign' },
  );
  assert(!(plan.themeIntent && 'fontFamily' in plan.themeIntent), 'an unshipped font survived coercion');
  assert(notes.some((n) => /font/i.test(n)), 'the dropped font was not disclosed');
});

check('an invalid accent is dropped with a note, not hard-failed', () => {
  const { plan, notes } = validator.coerceModelPlan(
    { layer: 'redesign', direction: { style: 'x', density: 'y' }, sections: [], themeIntent: { colorway: 'indigo', accent: 'deep blue' } },
    { grantedLayer: 'redesign' },
  );
  assert(!(plan.themeIntent && 'accent' in plan.themeIntent), 'a non-hex accent survived coercion');
  assert(notes.some((n) => /#RRGGBB|colour/.test(n)), 'the dropped accent was not disclosed');
  const result = validator.validatePresentationPlan(plan, [101]);
  assert(!result.violations.some((v) => v.code === 'plan.accent'), 'a dropped accent still raised an accent violation');
});

check('a focused restyle is reported as restyled only, never moved or resized', () => {
  // The diff summary must be honest: a style-only override has no x/y/w/h, so
  // `Number(undefined)` must not be read as NaN and counted as a move/resize.
  const tiles = makeTiles();
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'redesign', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { lineWidth: 3, showGrid: false, showDots: true } },
      rationale: 'thicker line',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, targets: [105],
  });
  const diff = diffMod.diffPresentation(tiles, built.mutation);
  assertEqual(diff.moved, [], 'a pure restyle was counted as a move');
  assertEqual(diff.resized, [], 'a pure restyle was counted as a resize');
  assertEqual(diff.restyled, [105], 'the restyle was not reported');
});


/** Verbatim from the deployed planner on dashboard 129 — string ids, a scope
 *  the model chose for itself, empty section titles. Kept as-is so the boundary
 *  is tested against what happens, not against what the schema says. */
const REAL_MODEL_REPLY = {
  layer: 'redesign',
  direction: { style: 'executive', density: 'balanced' },
  sections: [
    { primitive: 'kpi_strip', visuals: ['101', '102', '103', '104'], title: '' },
    { primitive: 'full_width', visuals: ['105'], title: '' },
    { primitive: 'table_full', visuals: ['108'], title: '' },
    { primitive: 'two_equal', visuals: ['106', '107'], title: '' },
  ],
  visualPreferences: {
    101: { role: 'kpi', emphasis: 'normal' },
    105: { role: 'primary', emphasis: 'high' },
  },
  themeIntent: { template: 'brief', colorway: 'slate' },
  rationale: 'Executive layout.',
};

check('string visual ids from a model are accepted, not read as hallucinations', () => {
  const tiles = makeTiles();
  const { plan } = validator.coerceModelPlan(REAL_MODEL_REPLY, { grantedLayer: 'redesign' });
  for (const section of plan.sections) {
    for (const id of section.visuals) {
      assertEqual(typeof id, 'number', 'a visual id survived as a string');
    }
  }
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.ok, `a real model reply was refused: ${JSON.stringify(result.violations)}`);
});

check('a composition style used as a template name is translated, not refused', () => {
  // Observed on the real report: the model answered `themeIntent.template:
  // "saas"` — a word from the composition vocabulary, not the template one —
  // and a good layout was thrown away over the name.
  const tiles = makeTiles();
  const reply = { ...REAL_MODEL_REPLY, themeIntent: { template: 'saas', colorway: 'slate' } };
  const { plan, notes } = validator.coerceModelPlan(reply, { grantedLayer: 'redesign' });
  assertEqual(plan.themeIntent.template, 'console', '"saas" was not read as the console template');
  assert(notes.some((n) => /saas/.test(n)), 'the translation was not disclosed');
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.ok, `the translated plan was still refused: ${JSON.stringify(result.violations)}`);
});

check('an unrecognisable theme name is dropped, not fatal', () => {
  const tiles = makeTiles();
  const reply = { ...REAL_MODEL_REPLY, themeIntent: { template: 'cyberpunk', colorway: 'neon' } };
  const { plan, notes } = validator.coerceModelPlan(reply, { grantedLayer: 'redesign' });
  assertEqual(plan.themeIntent, undefined, 'an invented theme survived coercion');
  assertEqual(notes.length, 2, 'the user was not told both names were dropped');
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.ok, 'a layout was lost because of a theme name');
});

check('a semantic violation is still fatal after coercion', () => {
  // Leniency about cosmetic names must not have softened the real gate.
  const tiles = makeTiles();
  const reply = { ...REAL_MODEL_REPLY, tileStyles: { 105: { dataLimit: 5 } } };
  const { plan } = validator.coerceModelPlan(reply, { grantedLayer: 'redesign' });
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(!result.ok && !result.repairable, 'a row limit survived the softened boundary');
});

check("the user's words decide the layer, not the model", () => {
  // The model asks to recompose; the user only asked for a look. The plan is
  // clamped to style: its sections are removed, the user is told, and the rest
  // (the theme) still applies.
  const { plan, notes } = validator.coerceModelPlan({ ...REAL_MODEL_REPLY, layer: 'redesign' }, { grantedLayer: 'style' });
  assertEqual(plan.layer, 'style', 'the model widened its own permission');
  assertEqual(plan.sections, [], 'a style plan kept a recomposition');
  assert(plan.themeIntent && plan.themeIntent.template === 'brief', 'the look was lost with the layout');
  assert(notes.some((n) => /layout/i.test(n)), 'the clamp was not disclosed');
  // A model may always ask for LESS than was granted.
  const lower = validator.coerceModelPlan({ layer: 'style', direction: {} }, { grantedLayer: 'redesign' });
  assertEqual(lower.plan.layer, 'style', 'a narrower answer was widened');
});

check('a real model reply compiles to a clean page', () => {
  const tiles = makeTiles();
  const { plan } = validator.coerceModelPlan(REAL_MODEL_REPLY, { grantedLayer: 'redesign' });
  const result = buildFor(tiles, plan);
  assert(result.ok, `the reply did not survive the contract: ${JSON.stringify(result.mutationValidation.violations)}`);
  assertEqual(validator.findOverlaps(result.mutation.layoutOverrides), [], 'overlaps');
  assertEqual(Object.keys(result.mutation.layoutOverrides).length, tiles.length, 'a visual was lost');
});

check('an echoed prompt changes nothing — it is not a request to re-pack', () => {
  // The planner's first deployed reply was the input payload echoed back. The
  // old compiler read "no sections" as "append everything two per row" and
  // rearranged the page. An empty plan is a no-op, even at redesign.
  const tiles = makeTiles();
  const echoed = { report: {}, visuals: [], capabilities: {}, planSchema: {} };
  const { plan } = validator.coerceModelPlan(echoed, { grantedLayer: 'redesign' });
  const result = buildFor(tiles, plan);
  const diff = diffMod.diffPresentation(tiles, result.mutation);
  assert(diffMod.isEmptyDiff(diff), `an empty plan moved things: ${JSON.stringify(diff)}`);
});

// ── Executor: scope, baseline and the single write path ─────────────────────

check('theme applies whenever requested; a layout-only redesign writes no theme', () => {
  const tiles = makeTiles();
  // Theme is a report-level property, so a theme intent applies report-wide the
  // moment it is asked for — even on page scope. No deferral, no "switch scope".
  const themed = buildFor(tiles, { ...planFor(tiles), themeIntent: { template: 'ops', colorway: 'slate' } });
  assert(themed.ok, `a themed redesign was refused: ${JSON.stringify(themed.mutationValidation.violations)}`);
  assert(Object.keys(themed.mutation.themePatch).length > 0, 'a requested theme was deferred instead of applied');
  assert(!themed.mutation.notes.some((n) => /Entire report/i.test(n)), 'a stale "switch scope" note was emitted');
  // But a redesign that asked for NO theme (planFor carries none) must never
  // repaint the theme, on any scope.
  const layoutOnly = buildFor(tiles, { ...planFor(tiles), scope: 'report' });
  assertEqual(layoutOnly.mutation.themePatch, {}, 'a layout-only redesign repainted the theme');
});

check('a report-scoped redesign writes theme keys from the catalog', () => {
  const tiles = makeTiles();
  const plan = { ...planFor(tiles), layer: 'redesign', themeIntent: { template: 'ops', colorway: 'slate' } };
  const result = buildFor(tiles, plan);
  // The whole build must SURVIVE validation — a template switch clears the
  // inline legacy-look keys (cardShadow, titleFontSize, …) by setting them to
  // undefined, and the mutation validator must accept that clear rather than
  // reject the redesign for naming a non-allow-listed key. Regression guard for
  // the live bug where every "Entire report" dark-SaaS redesign was refused.
  assert(result.ok, `a report-scoped redesign was refused: ${JSON.stringify(result.mutationValidation.violations)}`);
  const patch = result.mutation.themePatch;
  assert(Object.keys(patch).length > 0, 'a report redesign changed no theme keys');
  assertEqual(patch.templateId, 'ops', 'template identity not recorded');
  assertEqual(patch.colorwayId, 'slate', 'colorway identity not recorded');
  // The catalog's own values, not invented ones.
  const catalog = load('lib/dashboard-theme-catalog.ts');
  const ops = catalog.TEMPLATES.find((t) => t.id === 'ops').value;
  assertEqual(patch.kpiStyle, ops.kpiStyle, 'template tokens were not taken from the catalog');
});

check('clearing a legacy-look key is allowed; setting a bad key is not', () => {
  // The clear (undefined) must pass; a real disallowed value must still fail.
  const before = snapshotMod.buildPresentationFingerprint(makeTiles());
  const okClear = validator.validatePresentationMutation({
    before, after: before, pageId: 'page-1',
    mutation: { layoutOverrides: {}, themePatch: { cardShadow: undefined, titleFontSize: undefined, accent: '#325ac2' }, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
  });
  assert(okClear.ok, `clearing legacy keys was refused: ${JSON.stringify(okClear.violations)}`);
  const badSet = validator.validatePresentationMutation({
    before, after: before, pageId: 'page-1',
    mutation: { layoutOverrides: {}, themePatch: { cardShadow: '0 4px 20px red' }, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
  });
  assert(badSet.violations.some((v) => v.code === 'theme.key'), 'a real value for a disallowed key slipped through');
});

check('a theme patch cannot carry a key outside the catalog allow-list', () => {
  const patch = executor.resolveThemePatch({ template: 'console' }, {});
  for (const key of Object.keys(patch)) {
    const identity = ['templateId', 'colorwayId', 'presetId'].includes(key);
    const legacy = ['cardShadow', 'titleFontSize', 'kpiFontSize', 'labelFontSize', 'radius', 'cardBorderWidth'].includes(key);
    assert(identity || legacy || capabilities.isAllowedThemeKey(key), `theme patch leaked "${key}"`);
  }
});

check('a dock change writes the field the renderer actually reads', () => {
  const tiles = makeTiles();
  const plan = { ...planFor(tiles), layer: 'redesign', slicerPresentation: { dock: 'left', variant: 'compact' } };
  const result = buildFor(tiles, plan);
  // slicer_cluster_layout.position outranks theme.filterDock — writing only the
  // theme key would look like the dock change did nothing.
  assertEqual(result.mutation.slicerClusterPatch.position, 'left', 'cluster position not written');
  assertEqual(result.mutation.themePatch.filterDock, 'left', 'theme dock not written');
});

check('a restyle merges over the tile, it does not replace what the author set', () => {
  const tiles = makeTiles().map((t) => (t.id === 107
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { dataLimit: 10, showGrid: true } } }
    : t));
  const plan = { ...planFor(tiles), tileStyles: { 107: { legendPosition: 'right' } } };
  const result = buildFor(tiles, plan);
  const style = result.mutation.layoutOverrides[107].styleConfigOverride;
  assertEqual(style.dataLimit, 10, "the author's Top-N was wiped by a restyle");
  assertEqual(style.legendPosition, 'right', 'the restyle was not applied');
});

check('a plan smuggling a row limit into tileStyles is refused whole, not trimmed', () => {
  // Trimming would be the friendlier-looking behaviour and the wrong one: a
  // plan that tried to change what a chart shows is not a plan with a typo in
  // it, and applying the rest of it would hide the attempt.
  const tiles = makeTiles();
  const plan = { ...planFor(tiles), tileStyles: { 105: { legendPosition: 'top', dataLimit: 3 } } };
  const result = buildFor(tiles, plan);
  assert(!result.ok, 'a plan carrying a row limit was accepted');
  assertEqual(result.mutation.layoutOverrides, {}, 'a refused plan still wrote layout');
  assertEqual(result.mutation.themePatch, {}, 'a refused plan still wrote theme');
  assert(
    result.planValidation.violations.some((v) => v.code === 'plan.styleKey'),
    'the refusal did not name the offending key',
  );
});

check('the baseline is the local state, not the server copy (§24)', () => {
  const serverTiles = makeTiles();
  // The user dragged 105 to the top-left and has not saved.
  const localOverrides = { 105: { x: 0, y: 0, w: 36, h: 6 } };
  const local = executor.tilesWithLocalEdits(null, localOverrides, serverTiles);
  const snapshot = makeSnapshot(local);
  const visual = snapshot.visuals.find((v) => v.dashboardChartId === 105);
  assertEqual(visual.currentLayout.w, 36, 'the planner was shown the stale server position');
  // And a full-width trend at the top now reads as the page's argument.
  assertEqual(visual.displayRoleHint, 'primary', 'the unsaved move did not inform the role');
});

check('apply produces a localLayoutOverrides patch, not a new store', () => {
  const tiles = makeTiles();
  const result = buildFor(tiles, planFor(tiles));
  const previous = { 999: { x: 1, y: 1, w: 6, h: 2 } };
  const next = executor.toLocalLayoutOverrides(result.mutation, previous);
  assertEqual(next[999], previous[999], 'an unrelated pending edit was discarded');
  assert(next[105] != null, 'the redesign did not reach the override map');
  assertEqual(next[105].w, result.mutation.layoutOverrides[105].w, 'the override does not match the mutation');
});

check('the diff counts what actually changed', () => {
  const tiles = makeTiles();
  const result = buildFor(tiles, planFor(tiles));
  const diff = diffMod.diffPresentation(tiles, result.mutation);
  assert(diff.moved.length + diff.resized.length > 0, 'the diff reports no change for a full recompose');
  assertEqual(
    new Set([...diff.moved, ...diff.resized, ...diff.unchanged]).size,
    tiles.length,
    'the diff does not account for every visual',
  );
  assert(diffMod.summarizeDiff(diff).length > 0, 'the summary is empty');
});

check('re-running the same plan on its own output is a no-op', () => {
  // Conversational iteration re-plans from the CURRENT state; if that were not
  // idempotent, "make it modern" twice would drift.
  const tiles = makeTiles();
  const first = buildFor(tiles, planFor(tiles));
  const settled = executor.applyMutationToTiles(tiles, first.mutation);
  const second = buildFor(settled, planFor(settled));
  const diff = diffMod.diffPresentation(settled, second.mutation);
  assert(diffMod.isEmptyDiff(diff), `re-applying the same plan moved things: ${JSON.stringify(diff)}`);
});

// ── The real report (§29, on dashboard 129: 70 visuals, 5 pages) ────────────

/**
 * A synthetic fixture agrees with whatever the compiler happens to do. This one
 * is a copy of a real report — 70 visuals across 5 pages, 33 chart types, and
 * 67 tiles still on the legacy 12-column grid — so it disagrees when something
 * real breaks. It is a snapshot of presentation state only: no rows, no SQL, no
 * credentials.
 */
function loadRealDashboard() {
  const path = resolve(HERE, 'fixtures', 'dashboard-129.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const real = loadRealDashboard();

if (!real) {
  console.warn('  (skipped real-dashboard checks — fixtures/dashboard-129.json not present)');
} else {
  const realPages = (real.pages_config ?? []).map((p) => p.id);

  check('real report: every page compiles under every template', () => {
    for (const pageId of realPages) {
      const tiles = snapshotMod.tilesOnPage({ dashboard_charts: real.dashboard_charts }, pageId);
      assert(tiles.length > 0, `page ${pageId} has no tiles`);
      const snapshot = snapshotMod.buildPresentationSnapshot({
        dashboard: real,
        tiles,
        pageId,
        pageName: pageId,
        pageCount: realPages.length,
        slicers: real.slicers_config ?? [],
        slicerDock: 'top',
      });
      const before = snapshotMod.buildPresentationFingerprint(tiles);

      for (const templateId of templates.templateIntentIds()) {
        const plan = templates.planFromTemplate(templateId, snapshot);
        const planCheck = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
        assert(planCheck.ok, `${pageId}/${templateId}: invalid plan ${JSON.stringify(planCheck.violations)}`);

        const { mutation, orphanIds } = compiler.compilePresentationPlan({ plan, snapshot, pageId });
        assertEqual(orphanIds, [], `${pageId}/${templateId} dropped visuals`);
        assertEqual(
          validator.findOverlaps(mutation.layoutOverrides), [],
          `${pageId}/${templateId} produced overlapping tiles`,
        );

        const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
        const contract = validator.validatePresentationMutation({ before, after, mutation, pageId });
        assert(contract.ok, `${pageId}/${templateId} broke the contract: ${JSON.stringify(contract.violations)}`);
      }
    }
  });

  check('real report: 33 chart types all survive a redesign unchanged', () => {
    const tiles = real.dashboard_charts;
    const typesBefore = tiles.map((t) => (t.chart || {}).chart_type).filter(Boolean).sort();
    const pageId = realPages[0];
    const onPage = snapshotMod.tilesOnPage({ dashboard_charts: tiles }, pageId);
    const snapshot = snapshotMod.buildPresentationSnapshot({
      dashboard: real, tiles: onPage, pageId, pageName: pageId,
      pageCount: realPages.length, slicers: [], slicerDock: 'top',
    });
    const plan = templates.planFromTemplate('console', snapshot);
    const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId });
    const applied = tiles.map((t) => {
      const o = mutation.layoutOverrides[t.id];
      return o ? { ...t, layout: { ...t.layout, ...o } } : t;
    });
    const typesAfter = applied.map((t) => (t.chart || {}).chart_type).filter(Boolean).sort();
    assertEqual(typesAfter, typesBefore, 'a chart type changed');
    assertEqual(applied.length, tiles.length, 'the tile count changed');
  });

  check('real report: every tile\'s data semantics are byte-identical after a redesign (numbers cannot move)', () => {
    // The guarantee a user checks by duplicating a 70-chart report and comparing
    // the numbers before and after AI Design. Proven here deterministically and
    // for every page: the semanticHash folds in the chart ref, type, config,
    // dataset, parameters, tile filters and the NON-presentational half of
    // styleConfigOverride (Top-N, sort, benchmarks) — everything a rendered
    // number depends on. If it is identical for all 70 tiles after the most
    // aggressive composition the system has (console → saas → hero_with_rail),
    // then no query, filter or limit changed, so no number can. The
    // reference-image path shares this exact gate: an image only steers the
    // PLAN, and the plan is fingerprint-checked the same way.
    for (const pageId of realPages) {
      const tiles = snapshotMod.tilesOnPage({ dashboard_charts: real.dashboard_charts }, pageId);
      const snapshot = snapshotMod.buildPresentationSnapshot({
        dashboard: real, tiles, pageId, pageName: pageId,
        pageCount: realPages.length, slicers: real.slicers_config ?? [], slicerDock: 'top',
      });
      const before = snapshotMod.buildPresentationFingerprint(tiles);
      const plan = templates.planFromTemplate('console', snapshot);
      const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId });
      const after = snapshotMod.buildPresentationFingerprint(applyMutation(tiles, mutation));
      for (const id of Object.keys(before)) {
        assertEqual(after[id].semanticHash, before[id].semanticHash,
          `tile ${id} on ${pageId}: DATA SEMANTICS changed by the redesign`);
        assertEqual(after[id].chartId, before[id].chartId, `tile ${id} on ${pageId}: chart ref changed`);
        assertEqual(after[id].chartType, before[id].chartType, `tile ${id} on ${pageId}: chart type changed`);
        assertEqual(after[id].pageId, before[id].pageId, `tile ${id} on ${pageId}: page changed`);
      }
    }
  });

  check('real report: redesigning one page leaves the other four untouched', () => {
    const target = realPages[0];
    const tiles = snapshotMod.tilesOnPage({ dashboard_charts: real.dashboard_charts }, target);
    const snapshot = snapshotMod.buildPresentationSnapshot({
      dashboard: real, tiles, pageId: target, pageName: target,
      pageCount: realPages.length, slicers: [], slicerDock: 'top',
    });
    const plan = templates.planFromTemplate('editorial', snapshot);
    const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId: target });

    const touched = new Set(Object.keys(mutation.layoutOverrides).map(Number));
    const offPage = real.dashboard_charts.filter(
      (t) => pages.getDashboardChartPageId(t.layout) !== target,
    );
    assert(offPage.length > 0, 'the fixture is not multi-page');
    for (const tile of offPage) {
      assert(!touched.has(tile.id), `visual ${tile.id} on another page was moved`);
    }
    for (const layout of Object.values(mutation.layoutOverrides)) {
      assertEqual(layout.pageId, target, 'a compiled tile was assigned to a different page');
    }
  });

  check('real report: legacy 12-column tiles are read at rendered scale', () => {
    const legacy = real.dashboard_charts.filter((t) => (t.layout || {}).gv == null);
    assert(legacy.length > 0, 'the fixture has no legacy tiles to check');
    const pageId = pages.getDashboardChartPageId(legacy[0].layout);
    const tiles = snapshotMod.tilesOnPage({ dashboard_charts: real.dashboard_charts }, pageId);
    const snapshot = snapshotMod.buildPresentationSnapshot({
      dashboard: real, tiles, pageId, pageName: pageId,
      pageCount: realPages.length, slicers: [], slicerDock: 'top',
    });
    for (const visual of snapshot.visuals) {
      assert(
        visual.currentLayout.w <= COLS,
        `visual ${visual.dashboardChartId} described as ${visual.currentLayout.w} columns wide`,
      );
    }
    // A legacy tile authored at 4/12 must reach the planner as 12/36, not 4/36
    // — otherwise every legacy tile looks tiny and the composer demotes it.
    const sample = snapshot.visuals.find((v) => v.dashboardChartId === legacy[0].id);
    const raw = Number((legacy[0].layout || {}).w) || 0;
    assertEqual(sample.currentLayout.w, raw * 3, 'a legacy tile was not upscaled');
  });

  check('real report: every compiled tile is written at the current grid version', () => {
    const pageId = realPages[1];
    const tiles = snapshotMod.tilesOnPage({ dashboard_charts: real.dashboard_charts }, pageId);
    const snapshot = snapshotMod.buildPresentationSnapshot({
      dashboard: real, tiles, pageId, pageName: pageId,
      pageCount: realPages.length, slicers: [], slicerDock: 'top',
    });
    const plan = templates.planFromTemplate('ops', snapshot);
    const { mutation } = compiler.compilePresentationPlan({ plan, snapshot, pageId });
    for (const [id, layout] of Object.entries(mutation.layoutOverrides)) {
      assertEqual(layout.gv, pages.GRID_VERSION, `visual ${id} written without the current grid version`);
    }
  });
}

// ══ AI Design v2 — the permission contract ══════════════════════════════════
//
// These are the proofs the product promise rests on: the author owns the
// layout; AI changes only what the user's words (and selection) hand over;
// locks hold on every path; semantics never move; preview is what Apply writes.

const intentMod = load('lib/dashboard-presentation/intent.ts');
const structureMod = load('lib/dashboard-presentation/structure.ts');
const tileFrameMod = load('lib/dashboard-presentation/tile-frame.ts');
const renderAudit = load('lib/dashboard-presentation/render-audit.ts');

/** Every tile's rendered rectangle, keyed by id. */
function rectsById(tiles) {
  const out = {};
  for (const t of tiles) {
    const l = pages.scaleGridLayoutForRender(t.layout);
    out[t.id] = { x: l.x, y: l.y, w: l.w, h: l.h };
  }
  return out;
}

function build(tiles, plan, extra = {}) {
  return executor.buildPresentationMutation({
    plan, snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, ...extra,
  });
}

/** A whole-page style request as a model actually answers it. */
const STYLE_REPLY = {
  layer: 'style',
  direction: { style: 'saas', density: 'balanced' },
  themeIntent: { template: 'console', colorway: 'graphite', fontFamily: 'inter' },
  tileStyles: {
    101: { tileFrame: 'flush', kpiValueFontSize: 36 },
    102: { tileFrame: 'flush' },
    105: { chartSurface: 'dark', lineWidth: 3 },
    108: { tileFrame: 'subtle' },
  },
  slicerPresentation: { style: 'pill' },
  rationale: 'Premium dark SaaS look, layout unchanged.',
};

// ── Intent → permission ─────────────────────────────────────────────────────

check('the user\'s words grant the layer; ambiguity is style', () => {
  const cases = [
    ['Make this dashboard prettier', 'style'],
    ['Làm dashboard này đẹp hơn', 'style'],
    ['Make it more premium, like an enterprise SaaS', 'style'],
    ['Đổi sang style tối giản', 'style'],
    ['dark mode please', 'style'],
    ['Apply our brand colours #1E3A8A', 'style'],
    ['Giữ nguyên bố cục, làm cho sang hơn', 'style'],
    ['keep the layout but make it modern', 'style'],
    ['Rearrange it to look nicer but don\'t move anything', 'style'],
    ['Gom KPI lên trên', 'structure'],
    ['Put the KPIs on top', 'structure'],
    ['Make the revenue chart bigger', 'structure'],
    ['Đưa filter sang trái', 'structure'],
    ['Cho Revenue làm chart chính', 'structure'],
    ['move the table to the bottom', 'structure'],
    ['Sắp xếp lại cho đẹp hơn', 'redesign'],
    ['rearrange this page', 'redesign'],
    ['Redesign this page for the CEO', 'redesign'],
    ['Thiết kế lại trang này cho CEO', 'redesign'],
    ['Biến nó thành executive report', 'redesign'],
    ['Create an executive dashboard composition', 'redesign'],
  ];
  for (const [prompt, expected] of cases) {
    assertEqual(intentMod.inferDesignLayer(prompt).layer, expected, `"${prompt}"`);
  }
});

check('a plan can ask for less than was granted, never more', () => {
  assertEqual(intentMod.clampLayer('redesign', 'style'), 'style', 'redesign escaped a style grant');
  assertEqual(intentMod.clampLayer('structure', 'style'), 'style', 'structure escaped a style grant');
  assertEqual(intentMod.clampLayer('style', 'redesign'), 'style', 'a narrower answer was widened');
  assertEqual(intentMod.clampLayer(undefined, 'structure'), 'structure', 'no answer did not default to the grant');
});

// ── Style-only is a hard invariant ──────────────────────────────────────────

check('STYLE proof: whole-page restyle — geometry identical, semantics identical, look changed', () => {
  const tiles = makeTiles();
  const { plan } = validator.coerceModelPlan(STYLE_REPLY, { grantedLayer: 'style' });
  const built = build(tiles, plan);
  assert(built.ok, `a style plan was refused: ${JSON.stringify([...built.planValidation.violations, ...built.mutationValidation.violations])}`);
  const after = executor.applyMutationToTiles(tiles, built.mutation);
  assertEqual(rectsById(after), rectsById(tiles), 'a style-only change moved or resized a visual');
  for (const t of after) {
    assertEqual(t.layout.pageId, 'page-1', `visual ${t.id} changed page`);
  }
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const afterFp = snapshotMod.buildPresentationFingerprint(after);
  assertEqual(afterFp, before, 'a style-only change moved a semantic fingerprint');
  // …and it really did something.
  assert(Object.keys(built.mutation.themePatch).length > 0, 'the theme did not change');
  assertEqual(after.find((t) => t.id === 101).layout.styleConfigOverride.tileFrame, 'flush', 'the KPI frame did not change');
  assertEqual(after.find((t) => t.id === 105).layout.styleConfigOverride.chartSurface, 'dark', 'the chart surface did not change');
  assertEqual(built.mutation.themePatch.slicerStyle, 'pill', 'the slicer look did not change');
  for (const override of Object.values(built.mutation.layoutOverrides)) {
    for (const key of ['x', 'y', 'w', 'h']) {
      assert(!(key in override), `a style mutation wrote "${key}"`);
    }
  }
});

check('STYLE proof: a model that recomposes anyway is clamped, not obeyed', () => {
  const tiles = makeTiles();
  const greedy = { ...REAL_MODEL_REPLY, layer: 'redesign', structure: { operations: [{ op: 'move_to_top', visuals: [108] }] } };
  const { plan } = validator.coerceModelPlan(greedy, { grantedLayer: 'style' });
  const built = build(tiles, plan);
  assert(built.ok, 'the clamped plan was refused');
  assertEqual(rectsById(executor.applyMutationToTiles(tiles, built.mutation)), rectsById(tiles), 'a clamped plan still moved tiles');
});

check('STYLE proof: the validator refuses a style mutation that writes geometry, whatever built it', () => {
  const tiles = makeTiles();
  const mutation = {
    layoutOverrides: { 105: { x: 0, y: 0, w: 36, h: 12, gv: 2, pageId: 'page-1' } },
    themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'style',
  };
  const result = executor.validateMutationAgainst({ tiles, mutation, pageId: 'page-1' });
  assert(!result.ok && !result.repairable, 'a style mutation moving a tile was accepted');
  assert(result.violations.some((v) => v.code === 'layer.styleGeometry'), 'wrong violation code');
  // A dock move is structure too.
  const dock = executor.validateMutationAgainst({
    tiles, pageId: 'page-1',
    mutation: { layoutOverrides: {}, themePatch: { filterDock: 'left' }, slicerClusterPatch: { position: 'left' }, notes: [], layer: 'style' },
  });
  assert(dock.violations.some((v) => v.code === 'layer.slicerDock'), 'a style change moved the filters');
});

check('STYLE proof: choosing a template changes the look, never the filter dock', () => {
  const tiles = makeTiles();
  // `brief` carries filterDock: left. Under style it must not move the filters.
  const built = build(tiles, { layer: 'style', direction: {}, sections: [], visualPreferences: {}, themeIntent: { template: 'brief' } });
  assert(built.ok, `template restyle refused: ${JSON.stringify(built.mutationValidation.violations)}`);
  assert(!('filterDock' in built.mutation.themePatch), 'a template restyle moved the filter dock');
  assertEqual(built.mutation.slicerClusterPatch, {}, 'a template restyle wrote the slicer cluster position');
  assertEqual(built.mutation.themePatch.templateId, 'brief', 'the template look was not applied');
});

check('STYLE proof: a style value the renderer cannot draw is dropped with a note', () => {
  const { plan, notes } = validator.coerceModelPlan(
    { layer: 'style', tileStyles: { 105: { palette: 'emerald', chartSurface: 'navy', lineWidth: 'thick', showGrid: false } } },
    { grantedLayer: 'style' },
  );
  assertEqual(plan.tileStyles, { 105: { showGrid: false } }, 'an unrenderable value survived');
  assert(notes.some((n) => /cannot render/.test(n)), 'the drop was not disclosed');
});

// ── Locks hold on every path ────────────────────────────────────────────────

function withLock(tiles, id) {
  return tiles.map((t) => (t.id === id ? { ...t, layout: { ...t.layout, locked: true } } : t));
}

check('LOCK proof: AI structure cannot move or resize a locked visual', () => {
  const tiles = withLock(makeTiles(), 105);
  for (const operation of [
    { op: 'move_to_top', visuals: [105, 108] },
    { op: 'resize', visuals: [105], size: 'larger' },
    { op: 'swap', visuals: [105, 106] },
    { op: 'arrange_row', visuals: [105, 106, 107] },
  ]) {
    const built = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [operation] } });
    assert(built.ok, `${operation.op}: refused ${JSON.stringify(built.mutationValidation.violations)}`);
    const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
    assertEqual(after[105], rectsById(tiles)[105], `${operation.op} moved the locked visual`);
    assertEqual(validator.findOverlaps(after), [], `${operation.op} produced overlaps`);
    assert(!(105 in built.mutation.layoutOverrides), `${operation.op} wrote the locked visual`);
  }
});

check('LOCK proof: a neighbour growing into a locked visual stops short of it', () => {
  // 104 sits beside 105 in the fixture's second row; growing it must not cover 105.
  const tiles = withLock(makeTiles(), 105);
  const built = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'resize', visuals: [104], size: 'larger' }] } });
  assert(built.ok, 'resize beside a lock was refused');
  const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
  assertEqual(after[105], rectsById(tiles)[105], 'the locked visual was displaced');
  assertEqual(validator.findOverlaps(after), [], 'the grown tile covers the locked one');
});

check('LOCK proof: AI redesign and template re-arrange route around a locked visual', () => {
  const tiles = withLock(makeTiles(), 106);
  const snapshot = makeSnapshot(tiles);
  const plans = [planFor(tiles), ...templates.templateIntentIds().map((id) => templates.planFromTemplate(id, snapshot))];
  for (const plan of plans) {
    const built = build(tiles, { ...plan, layer: 'redesign' });
    assert(built.ok, `redesign refused: ${JSON.stringify(built.mutationValidation.violations)}`);
    const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
    assertEqual(after[106], rectsById(tiles)[106], 'a redesign moved the locked visual');
    assertEqual(validator.findOverlaps(after), [], 'a redesign overlapped the locked visual');
  }
});

check('LOCK proof: a mutation that moves a locked visual or flips a lock is refused', () => {
  const tiles = withLock(makeTiles(), 105);
  const moved = executor.validateMutationAgainst({
    tiles, pageId: 'page-1',
    mutation: { layoutOverrides: { 105: { x: 0, y: 40, w: 12, h: 12 } }, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'redesign' },
  });
  assert(moved.violations.some((v) => v.code === 'lock.geometry'), 'moving a locked tile was not refused');
  const unlocked = executor.validateMutationAgainst({
    tiles, pageId: 'page-1',
    mutation: { layoutOverrides: { 105: { locked: false } }, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'style' },
  });
  assert(unlocked.violations.some((v) => v.code === 'lock.write'), 'AI unlocked a visual');
});

check('LOCK proof: tidy and compact-up leave locked tiles where they are', () => {
  const tiles = [
    { id: 1, x: 0, y: 6, w: 12, h: 6 },
    { id: 2, x: 12, y: 6, w: 12, h: 6 },
    { id: 3, x: 0, y: 14, w: 36, h: 6 },
  ];
  const locked = new Set([2]);
  const tidied = pages.tidyPageLayout(tiles, locked);
  assertEqual(tidied.find((t) => t.id === 2), tiles[1], 'tidy moved a locked tile');
  const up = pages.compactPageUp(tiles, locked);
  assertEqual(up.find((t) => t.id === 2), tiles[1], 'compact-up moved a locked tile');
  for (const result of [tidied, up]) {
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        assert(!structureMod.overlaps(result[i], result[j]), `tiles ${result[i].id} and ${result[j].id} overlap`);
      }
    }
  }
});

// ── Scope follows the selection ─────────────────────────────────────────────

check('SCOPE proof: selected visuals change; unselected ones and the theme do not', () => {
  const tiles = makeTiles();
  const targets = [105, 106];
  const { plan, notes } = validator.coerceModelPlan(STYLE_REPLY, { grantedLayer: 'style', targets });
  assert(!plan.themeIntent, 'a selection-scoped request kept a report theme');
  assert(notes.some((n) => /theme/i.test(n)), 'dropping the theme was not disclosed');
  const built = build(tiles, plan, { targets });
  assert(built.ok, `scoped restyle refused: ${JSON.stringify(built.mutationValidation.violations)}`);
  const touched = Object.keys(built.mutation.layoutOverrides).map(Number).sort((a, b) => a - b);
  assert(touched.every((id) => targets.includes(id)), `touched outside the selection: ${touched}`);
  assertEqual(built.mutation.themePatch, {}, 'a scoped change repainted the report');
  assertEqual(built.mutation.slicerClusterPatch, {}, 'a scoped change touched the filters');
});

check('SCOPE proof: a structure change on a selection never displaces the rest', () => {
  const tiles = makeTiles();
  const targets = [106, 107];
  const built = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'arrange_row', visuals: targets }] } }, { targets });
  assert(built.ok, `scoped arrangement refused: ${JSON.stringify(built.mutationValidation.violations)}`);
  const before = rectsById(tiles);
  const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
  for (const tile of tiles) {
    if (targets.includes(tile.id)) continue;
    assertEqual(after[tile.id], before[tile.id], `unselected visual ${tile.id} moved`);
  }
  assertEqual(validator.findOverlaps(after), [], 'the scoped arrangement overlaps');
});

check('SCOPE proof: the validator refuses a change outside the selection', () => {
  const tiles = makeTiles();
  const result = executor.validateMutationAgainst({
    tiles, pageId: 'page-1', targets: [105],
    mutation: { layoutOverrides: { 107: { styleConfigOverride: { showGrid: false } } }, themePatch: { accent: '#112233' }, slicerClusterPatch: {}, notes: [], layer: 'style' },
  });
  assert(result.violations.some((v) => v.code === 'scope.outside'), 'an unselected visual was restyled');
  assert(result.violations.some((v) => v.code === 'scope.theme'), 'a scoped change repainted the report');
});

// ── Structure has a blast radius the size of the request ────────────────────

/** A realistic authored page: KPIs at the BOTTOM, an intentional gap on the
 *  right of the chart row. */
function authoredPage() {
  const L = (id, type, x, y, w, h) => ({
    id, chart_id: 900 + id, widget_type: 'chart',
    layout: { x, y, w, h, gv: 2, pageId: 'page-1' },
    chart: { id: 900 + id, name: `V${id}`, chart_type: type, dataset_id: 1, config: {} },
  });
  return [
    L(1, 'LINE', 0, 0, 24, 14),
    L(2, 'DONUT', 24, 0, 8, 14),      // columns 32–36 intentionally empty
    L(3, 'BAR', 0, 14, 18, 12),
    L(4, 'TABLE', 18, 14, 18, 12),
    L(5, 'KPI', 0, 26, 9, 5),
    L(6, 'KPI', 9, 26, 9, 5),
  ];
}

check('STRUCTURE proof: "KPIs on top" moves the KPIs and only shifts the rest down', () => {
  const tiles = authoredPage();
  const built = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'move_to_top', visuals: [5, 6] }] } });
  assert(built.ok, `move_to_top refused: ${JSON.stringify(built.mutationValidation.violations)}`);
  const before = rectsById(tiles);
  const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
  assertEqual([after[5].y, after[6].y], [0, 0], 'the KPIs are not on top');
  for (const id of [1, 2, 3, 4]) {
    assertEqual([after[id].x, after[id].w, after[id].h], [before[id].x, before[id].w, before[id].h], `visual ${id} was rearranged, not just shifted`);
  }
  // Relative arrangement of the untouched content is preserved exactly.
  assertEqual(after[3].y - after[1].y, before[3].y - before[1].y, 'the untouched rows changed spacing');
  // The author's intentional gap (columns 32–36 beside the donut) survives.
  assertEqual(after[2].x + after[2].w, 32, 'the intentional gap was filled');
  assertEqual(validator.findOverlaps(after), [], 'move_to_top overlaps');
  // And the KPIs' old row did not leave a hole at the bottom.
  const bottom = Math.max(...Object.values(after).map((r) => r.y + r.h));
  assert(bottom <= Math.max(...Object.values(before).map((r) => r.y + r.h)), 'moving the KPIs grew the page');
});

check('STRUCTURE proof: "make this bigger" disturbs only what it would cover', () => {
  const tiles = authoredPage();
  const built = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'resize', visuals: [3], size: 'larger' }] } });
  assert(built.ok, 'resize refused');
  const before = rectsById(tiles);
  const after = rectsById(executor.applyMutationToTiles(tiles, built.mutation));
  assert(after[3].w > before[3].w && after[3].h > before[3].h, 'the visual did not grow');
  // Nothing above the grown tile moved.
  for (const id of [1, 2]) assertEqual(after[id], before[id], `visual ${id} above the change moved`);
  assertEqual(validator.findOverlaps(after), [], 'the grown tile overlaps');
});

// ── Safety is unchanged ─────────────────────────────────────────────────────

check('SAFETY proof: no layer can change semantics through the presentation path', () => {
  const tiles = makeTiles();
  for (const layer of ['style', 'structure', 'redesign']) {
    const { plan } = validator.coerceModelPlan(
      { ...REAL_MODEL_REPLY, layer, tileStyles: { 105: { dataLimit: 3, chartSortRules: [], seriesRenderAs: { a: 'line' } } } },
      { grantedLayer: layer },
    );
    const built = build(tiles, plan);
    assert(!built.ok, `${layer}: a semantic key was accepted`);
    assertEqual(built.mutation.layoutOverrides, {}, `${layer}: a refused plan still wrote layout`);
  }
  // A semantic change smuggled into the tiles themselves is caught by the fingerprint.
  const tampered = executor.validateMutationAgainst({
    tiles, pageId: 'page-1',
    mutation: { layoutOverrides: { 105: { styleConfigOverride: { dataLimit: 3 } } }, themePatch: {}, slicerClusterPatch: {}, notes: [], layer: 'style' },
  });
  assert(tampered.violations.some((v) => v.code === 'identity.semantics'), 'a Top-N passed as a restyle');
});

// ── Preview is what Apply writes ────────────────────────────────────────────

check('PREVIEW proof: the previewed tiles equal the tiles after Apply', () => {
  const tiles = makeTiles();
  for (const plan of [
    validator.coerceModelPlan(STYLE_REPLY, { grantedLayer: 'style' }).plan,
    { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'move_to_top', visuals: [108] }] } },
    { ...planFor(tiles), layer: 'redesign' },
  ]) {
    const built = build(tiles, plan);
    assert(built.ok, `${plan.layer}: refused`);
    const preview = executor.applyMutationToTiles(tiles, built.mutation);
    // Apply: the mutation becomes localLayoutOverrides, the page re-reads its tiles through them.
    const local = executor.toLocalLayoutOverrides(built.mutation, {});
    const applied = executor.tilesWithLocalEdits(null, local, tiles);
    assertEqual(applied.map((t) => t.layout), preview.map((t) => t.layout), `${plan.layer}: Apply differs from the preview`);
  }
});

check('PREVIEW proof: a follow-up on an unapplied preview composes, and the composite is what applies', () => {
  const tiles = makeTiles();
  const first = build(tiles, { layer: 'structure', direction: {}, sections: [], visualPreferences: {}, structure: { operations: [{ op: 'move_to_top', visuals: [108] }] } });
  const previewed = executor.applyMutationToTiles(tiles, first.mutation);
  const second = build(previewed, validator.coerceModelPlan(STYLE_REPLY, { grantedLayer: 'style' }).plan);
  assert(first.ok && second.ok, 'a step was refused');
  const composite = executor.composeMutations(first.mutation, second.mutation);
  const check2 = executor.validateMutationAgainst({ tiles, mutation: composite, pageId: 'page-1' });
  assert(check2.ok, `the composite was refused: ${JSON.stringify(check2.violations)}`);
  assertEqual(composite.layer, 'structure', 'the composite lost the wider layer');
  const sequential = executor.applyMutationToTiles(previewed, second.mutation);
  const composed = executor.applyMutationToTiles(tiles, composite);
  assertEqual(rectsById(composed), rectsById(sequential), 'the composite does not reproduce what the user saw (geometry)');
  assertEqual(
    composed.map((t) => t.layout.styleConfigOverride ?? null),
    sequential.map((t) => t.layout.styleConfigOverride ?? null),
    'the composite does not reproduce what the user saw (style)',
  );
});

// ── One presentation definition for builder and published tiles ────────────

check('PARITY proof: builder and published tiles resolve their frame from ONE module', () => {
  const tileSrc = readFileSync(resolve(SRC, 'components/dashboards/ChartTile.tsx'), 'utf8');
  const readonlySrc = readFileSync(resolve(SRC, 'components/dashboards/ReadonlyChartTile.tsx'), 'utf8');
  for (const [name, src] of [['ChartTile', tileSrc], ['ReadonlyChartTile', readonlySrc]]) {
    assert(src.includes('resolveTileFrameStyle('), `${name} does not use the shared frame resolver`);
    assert(src.includes('TILE_TITLE_CLASS') && src.includes('TILE_KPI_LABEL_CLASS'), `${name} does not use the shared title typography`);
    assert(src.includes('{...tileFrame.dataAttributes}'), `${name} does not publish its frame attributes`);
    // A second copy of the surface palette is how the two drifted before.
    assert(!src.includes("'#0f172a'") && !src.includes('surfaceVars'), `${name} carries its own surface palette again`);
    assert(src.includes('data-tile-id='), `${name} tiles cannot be paired for parity checks`);
  }
  const publicSrc = readFileSync(resolve(SRC, 'components/dashboards/PublicDashboardView.tsx'), 'utf8');
  const gridSrc = readFileSync(resolve(SRC, 'components/dashboards/DashboardGrid.tsx'), 'utf8');
  assert(publicSrc.includes('<SectionBands') && gridSrc.includes('<SectionBands'), 'section surfaces are drawn on only one side');
});

check('PARITY proof: the frame vocabulary resolves deterministically and honours legacy flags', () => {
  const card = tileFrameMod.resolveTileFrameStyle({ style: {} });
  assertEqual(card.frame, 'card', 'default is not a card');
  assert(card.className.includes('border') && card.className.includes('bg-surface-1'), 'a card has no container');
  const legacy = tileFrameMod.resolveTileFrameStyle({ style: { transparentBackground: true } });
  assertEqual(legacy.frame, 'flush', 'transparentBackground no longer means flush');
  const flush = tileFrameMod.resolveTileFrameStyle({ style: { tileFrame: 'flush', chartSurface: 'dark' } });
  assertEqual(flush.style.borderWidth, 0, 'flush kept a border');
  assertEqual(flush.style.boxShadow, 'none', 'flush kept a shadow');
  assertEqual(flush.style.background, 'transparent', 'a flush tile painted a surface behind itself');
  assertEqual(flush.style['--text-primary'], '226 232 240', 'a dark surface on a flush tile did not flip its text tokens');
  assertEqual(flush.dataAttributes['data-tile-frame'], 'flush', 'the frame attribute is missing');
  const subtle = tileFrameMod.resolveTileFrameStyle({ style: { tileFrame: 'subtle' } });
  assert(!subtle.className.includes(' border'), 'subtle kept a border class');
  assertEqual(JSON.stringify(tileFrameMod.resolveTileFrameStyle({ style: { tileFrame: 'subtle' } })), JSON.stringify(subtle), 'not deterministic');
});

// ── Responsive is derived, not configured ───────────────────────────────────

check('RESPONSIVE proof: a layout that already reads at tablet width is left exactly as authored', () => {
  const layout = [
    { i: '1', x: 0, y: 0, w: 12, h: 5 }, { i: '2', x: 12, y: 0, w: 12, h: 5 }, { i: '3', x: 24, y: 0, w: 12, h: 5 },
    { i: '4', x: 0, y: 5, w: 24, h: 14 }, { i: '5', x: 24, y: 5, w: 12, h: 14 },
  ];
  const out = pages.deriveTabletLayout(layout, { kindOf: (it) => (Number(it.i) <= 3 ? 'kpi' : 'chart'), referenceWidthPx: 820 });
  assert(out === layout, 'a readable layout was re-flowed at tablet width');
});

check('RESPONSIVE proof: slivers are widened at tablet width, in reading order, without overlap', () => {
  const layout = [1, 2, 3, 4, 5, 6].map((n) => ({ i: String(n), x: (n - 1) * 6, y: 0, w: 6, h: 5 }))
    .concat([{ i: '7', x: 0, y: 5, w: 9, h: 14 }, { i: '8', x: 9, y: 5, w: 27, h: 14 }]);
  const kindOf = (it) => (Number(it.i) <= 6 ? 'kpi' : 'chart');
  const out = pages.deriveTabletLayout(layout, { kindOf, referenceWidthPx: 820 });
  const colPx = 820 / 36;
  for (const item of out) {
    const min = pages.RESPONSIVE_MIN_WIDTH_PX[kindOf(item)];
    assert(item.w * colPx >= min, `tile ${item.i} is ${Math.round(item.w * colPx)}px at tablet width (min ${min})`);
    assert(item.x + item.w <= 36, `tile ${item.i} overflows`);
  }
  for (let a = 0; a < out.length; a += 1) {
    for (let b = a + 1; b < out.length; b += 1) {
      assert(!structureMod.overlaps(out[a], out[b]), `tablet tiles ${out[a].i}/${out[b].i} overlap`);
    }
  }
  const order = [...out].sort((p, q) => p.y - q.y || p.x - q.x).map((it) => it.i);
  assertEqual(order, ['1', '2', '3', '4', '5', '6', '7', '8'], 'reading order changed');
});

check('RESPONSIVE proof: the phone stack keeps order and a readable height per kind', () => {
  const layout = [{ i: 'k', x: 20, y: 0, w: 8, h: 2 }, { i: 'c', x: 0, y: 0, w: 20, h: 4 }];
  const out = pages.deriveStackedLayout(layout, { kindOf: (it) => (it.i === 'k' ? 'kpi' : 'chart'), rowPitchPx: 24 });
  assertEqual(out.map((it) => it.i), ['c', 'k'], 'reading order lost in the stack');
  assert(out.find((it) => it.i === 'k').h * 24 >= pages.STACK_MIN_HEIGHT_PX.kpi, 'a stacked KPI is too short');
  assert(out.find((it) => it.i === 'c').h * 24 >= pages.STACK_MIN_HEIGHT_PX.chart, 'a stacked chart is too short');
  // The builder's narrow projection is the same rule, not a second one.
  const gridSrc = readFileSync(resolve(SRC, 'components/dashboards/DashboardGrid.tsx'), 'utf8');
  assert(gridSrc.includes('REPORT_STACK_BREAKPOINT') && gridSrc.includes('deriveStackedLayout('), 'the builder projects narrow screens differently from the report');
});

// ── The render audit's arithmetic ───────────────────────────────────────────

check('render audit: contrast arithmetic matches WCAG reference values', () => {
  const white = [255, 255, 255, 1];
  const black = [0, 0, 0, 1];
  assert(Math.abs(renderAudit.contrastRatio(white, black) - 21) < 0.01, 'black on white is not 21:1');
  const grey = [148, 163, 184, 1];     // text-tertiary on the dark surface
  const navy = [15, 23, 42, 1];
  assert(renderAudit.contrastRatio(grey, navy) >= renderAudit.MIN_TITLE_CONTRAST, 'the dark surface token pair fails its own gate');
  const pale = [203, 213, 225, 1];
  assert(renderAudit.contrastRatio(pale, white) < renderAudit.MIN_TITLE_CONTRAST, 'light grey on white passed the contrast gate');
});

// ── i18n interpolation ──────────────────────────────────────────────────────

check('no catalog string uses single-brace interpolation', () => {
  // `t()` substitutes {{name}}. A string written with {name} renders the braces
  // literally — "Moved {count} visuals" shipped exactly that way, and it is
  // invisible to tsc, to lint and to anyone not reading that specific panel.
  const { readdirSync } = require_('node:fs');
  const dir = resolve(SRC, 'i18n', 'catalog');
  const offenders = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(resolve(dir, file), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      // A single { not doubled on either side, wrapping a bare identifier.
      const match = line.match(/(^|[^{])\{([a-zA-Z][a-zA-Z0-9_]*)\}([^}]|$)/);
      if (match && /^\s*'[\w.]+'\s*:/.test(line)) {
        offenders.push(`${file}:${index + 1} {${match[2]}}`);
      }
    }
  }
  assertEqual(offenders, [], 'single-brace placeholders will render literally');
});

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} presentation-contract check(s) FAILED:\n`);
  for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.message}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`All ${passed} presentation-contract checks passed.`);
