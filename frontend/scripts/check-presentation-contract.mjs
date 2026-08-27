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
    scope: 'page',
    direction: { style: 'executive', density: 'balanced' },
    sections: [
      { primitive: 'kpi_strip', visuals: kpis },
      { primitive: 'two_one', visuals: [105, 106] },
      { primitive: 'full_width', visuals: [107] },
      { primitive: 'table_full', visuals: [108] },
    ],
    visualPreferences: {
      105: { role: 'primary', span: 'large', emphasis: 'high' },
      106: { role: 'breakdown', span: 'small', emphasis: 'normal' },
      107: { role: 'secondary', span: 'full', emphasis: 'normal' },
      108: { role: 'table', span: 'full', emphasis: 'low' },
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

check('role inference reads chart type and authored size', () => {
  const kpi = roles.inferPresentationRole({ chartType: 'KPI', widgetType: 'chart', w: 9, y: 0, gridColumns: COLS });
  assertEqual(kpi, 'kpi', 'a narrow KPI is a strip KPI');
  const headline = roles.inferPresentationRole({ chartType: 'KPI', widgetType: 'chart', w: 36, y: 0, gridColumns: COLS });
  assertEqual(headline, 'headline', 'a full-width KPI at the top is the headline');
  const trend = roles.inferPresentationRole({ chartType: 'LINE', widgetType: 'chart', w: 24, y: 2, gridColumns: COLS });
  assertEqual(trend, 'primary', 'a wide trend carries the page');
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
      scope: 'page',
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
    scope: 'page',
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
    scope: 'page',
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
    scope: 'page',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'hero_with_rail', visuals: [105, 106, 107] }],
    visualPreferences: {
      105: { role: 'primary', span: 'large', emphasis: 'high' },
      106: { role: 'secondary', span: 'medium', emphasis: 'normal' },
      107: { role: 'breakdown', span: 'small', emphasis: 'normal' },
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
    scope: 'page',
    direction: { style: 'saas', density: 'balanced' },
    sections: [
      { primitive: 'kpi_strip', visuals: [101, 102, 103, 104] },
      { primitive: 'hero_with_rail', visuals: [105, 106, 107] },
      { primitive: 'table_full', visuals: [108] },
    ],
    visualPreferences: {
      105: { role: 'primary', span: 'large', emphasis: 'high' },
      106: { role: 'secondary', span: 'medium', emphasis: 'normal' },
      107: { role: 'breakdown', span: 'small', emphasis: 'normal' },
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
    scope: 'page', direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'hero_with_rail', visuals: [105] }], visualPreferences: {},
  });
  assertEqual(single.mutation.layoutOverrides[105].w, COLS, 'a lone hero was not made full width');
  // Six visuals: too many for a legible rail, so it falls back to a clean wall
  // rather than a column of slivers.
  const many = compile(tiles, {
    scope: 'page', direction: { style: 'saas', density: 'balanced' },
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
      scope: 'page',
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
    scope: 'page',
    direction: { style: 'saas', density: 'balanced' },
    sections: [
      { primitive: 'two_equal', visuals: [101, 102] },
      { primitive: 'two_equal', visuals: [103, 104] },
      { primitive: 'two_one', visuals: [105, 106] },
    ],
    visualPreferences: {
      101: { role: 'kpi', span: 'small', emphasis: 'normal' },
      102: { role: 'kpi', span: 'small', emphasis: 'normal' },
      103: { role: 'kpi', span: 'small', emphasis: 'normal' },
      104: { role: 'kpi', span: 'small', emphasis: 'normal' },
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
    scope: 'page',
    direction: { style: 'saas', density: 'balanced' },
    sections: [{ primitive: 'two_equal', visuals: [101, 105] }],
    visualPreferences: {
      101: { role: 'kpi', span: 'small', emphasis: 'normal' },
      105: { role: 'primary', span: 'large', emphasis: 'high' },
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
      scope: 'page', direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'full_width', visuals: [101] }],
      visualPreferences: { 101: { role: 'kpi', span: 'small', emphasis: 'normal' } },
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
    for (const span of ['small', 'medium', 'large', 'full']) {
      const prefs = {};
      for (const tile of tiles) prefs[tile.id] = { role: 'kpi', span, emphasis: 'low' };
      const plan = {
        scope: 'page',
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
    layoutOverrides: { 105: { styleConfigOverride: { lineWidth: 'thick', showGrid: false, showDots: true } } },
    themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
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
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
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
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
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
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
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
    before, after, mutation: { layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
    pageId: 'page-1',
  });
  assert(result.ok, `a legitimate restyle was rejected: ${JSON.stringify(result.violations)}`);
});

check('moving a visual to another page is caught', () => {
  const tiles = makeTiles();
  const before = snapshotMod.buildPresentationFingerprint(tiles);
  const mutation = {
    layoutOverrides: { 105: { x: 0, y: 0, w: 18, h: 4, pageId: 'page-2' } },
    themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
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

check('a generated widget must be stamped and markup-free', () => {
  const base = {
    layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [],
  };
  const unstamped = validator.validatePresentationMutation({
    before: {}, after: {}, pageId: 'page-1',
    mutation: { ...base, createdWidgets: [{ widgetType: 'section_header', widgetConfig: { title: 'Overview' }, layout: {} }] },
  });
  assert(unstamped.violations.some((v) => v.code === 'widget.provenance'), 'an unstamped widget was accepted');

  const markup = validator.validatePresentationMutation({
    before: {}, after: {}, pageId: 'page-1',
    mutation: { ...base, createdWidgets: [{ widgetType: 'section_header', widgetConfig: { createdBy: 'ai-presentation', title: '<b>Overview</b>' }, layout: {} }] },
  });
  assert(markup.violations.some((v) => v.code === 'widget.markup'), 'markup reached a widget');
});

check('geometry problems are repairable, semantic problems are not', () => {
  const geometryOnly = validator.validatePresentationMutation({
    before: {}, after: {}, pageId: 'page-1',
    mutation: {
      layoutOverrides: { 1: { x: 30, y: 0, w: 12, h: 4 } }, // ends at column 42
      themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
    },
  });
  assert(!geometryOnly.ok, 'an overflowing tile was accepted');
  assert(geometryOnly.repairable, 'a pure geometry problem should be repairable');
});

// ── Snapshot hygiene ────────────────────────────────────────────────────────

check('the snapshot carries no data-source information', () => {
  const tiles = makeTiles();
  const snapshot = makeSnapshot(tiles);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['dataset_id', 'datasetId', 'SELECT', 'config', 'measures', 'dimensions', 'payment_type']) {
    assert(!serialized.includes(forbidden), `the snapshot leaks "${forbidden}"`);
  }
  assertEqual(snapshot.visuals.length, tiles.length, 'snapshot lost a visual');
  assertEqual(snapshot.slicers[0].displayLabel, 'Payment Type', 'slicer label missing');
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

function buildFor(tiles, plan, theme = {}) {
  return executor.buildPresentationMutation({
    plan, snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: theme,
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
      scope: 'page',
      direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { lineWidth: 'thick', showGrid: false, showDots: true } },
      rationale: 'thicker line',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 105,
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

check('a focused restyle cannot smuggle a data-semantic key', () => {
  // resolveTileStyles drops anything off the allow-list, so a plan that tries a
  // data key (Top-N) produces an empty no-op mutation, never a data change.
  const tiles = makeTiles();
  const built = executor.buildPresentationMutation({
    plan: {
      scope: 'page', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { dataLimit: 5 } }, rationale: 'sneaky',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 105,
  });
  assertEqual(Object.keys(built.mutation.layoutOverrides).length, 0, 'a data key survived a focused restyle');
});

check('chartSurface repaints any chart type via a focused restyle', () => {
  const tiles = makeTiles(); // 105 is a LINE chart
  const built = executor.buildPresentationMutation({
    plan: {
      scope: 'page', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { chartSurface: 'dark' } }, rationale: 'dark chart',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 105,
  });
  assert(built.ok, `chartSurface restyle refused: ${JSON.stringify(built.mutationValidation?.violations)}`);
  assertEqual(built.mutation.layoutOverrides[105].styleConfigOverride.chartSurface, 'dark', 'chartSurface was dropped');
});

check('a KPI-only key is dropped on a chart but kept on a KPI', () => {
  const tiles = makeTiles(); // 105 LINE, 101 KPI
  const onChart = executor.buildPresentationMutation({
    plan: { scope: 'page', direction: { style: 'x', density: 'y' }, tileStyles: { 105: { kpiBackgroundMode: 'dark' } }, rationale: 'r' },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 105,
  });
  assertEqual(Object.keys(onChart.mutation.layoutOverrides).length, 0, 'a kpi-only key rendered on a chart');
  const onKpi = executor.buildPresentationMutation({
    plan: { scope: 'page', direction: { style: 'x', density: 'y' }, tileStyles: { 101: { kpiBackgroundMode: 'dark' } }, rationale: 'r' },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 101,
  });
  assertEqual(onKpi.mutation.layoutOverrides[101].styleConfigOverride.kpiBackgroundMode, 'dark', 'a kpi key was dropped from a KPI');
});

check('a report theme change resets per-tile colour but keeps non-colour styles', () => {
  // A KPI carrying a leftover accent + a hand-set line width. A report-scoped
  // theme change must clear the colour (so the new theme shows) but keep the
  // line width (not a colour, not the theme's business).
  const tiles = makeTiles().map((t) => (t.id === 101
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { kpiAccentColor: 'blue', lineWidth: 'thick' } } }
    : t));
  const built = executor.buildPresentationMutation({
    plan: {
      scope: 'report',
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
  assertEqual(ov.lineWidth, 'thick', 'a non-colour per-tile style was wrongly cleared');
  assert(Object.keys(built.mutation.themePatch).length > 0, 'the theme patch was not written');
});

check('a mode/surface per-tile key is reset (not re-pointed) by a report theme change', () => {
  const tiles = makeTiles().map((t) => (t.id === 105
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { chartSurface: 'dark', lineWidth: 'thick' } } }
    : t));
  const built = executor.buildPresentationMutation({
    plan: {
      scope: 'report', direction: { style: 'saas', density: 'balanced' },
      sections: [{ primitive: 'kpi_strip', visuals: [101, 102, 103, 104] }, { primitive: 'full_width', visuals: [105] }],
      visualPreferences: {}, themeIntent: { colorway: 'indigo', accent: '#1E3A8A' }, rationale: 'deep blue',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {},
  });
  const ov = built.mutation.layoutOverrides[105]?.styleConfigOverride ?? {};
  assert(!('chartSurface' in ov), 'a per-tile surface survived a report theme change');
  assertEqual(ov.lineWidth, 'thick', 'a non-colour per-tile style was wrongly cleared');
});

check('a page-scoped or layout-only redesign never clears per-tile colour', () => {
  const tiles = makeTiles().map((t) => (t.id === 101
    ? { ...t, layout: { ...t.layout, styleConfigOverride: { kpiAccentColor: 'blue' } } }
    : t));
  // Report scope but NO themeIntent → not a theme change → colour is kept.
  const built = executor.buildPresentationMutation({
    plan: {
      scope: 'report', direction: { style: 'saas', density: 'balanced' },
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
    { scope: 'report', direction: { style: 'x', density: 'y' }, sections: [], themeIntent: { fontFamily: 'comic sans' } },
    { scope: 'report' },
  );
  assert(!(plan.themeIntent && 'fontFamily' in plan.themeIntent), 'an unshipped font survived coercion');
  assert(notes.some((n) => /font/i.test(n)), 'the dropped font was not disclosed');
});

check('an invalid accent is dropped with a note, not hard-failed', () => {
  const { plan, notes } = validator.coerceModelPlan(
    { scope: 'report', direction: { style: 'x', density: 'y' }, sections: [], themeIntent: { colorway: 'indigo', accent: 'deep blue' } },
    { scope: 'report' },
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
      scope: 'page', direction: { style: 'executive', density: 'spacious' },
      tileStyles: { 105: { lineWidth: 'thick', showGrid: false, showDots: true } },
      rationale: 'thicker line',
    },
    snapshot: makeSnapshot(tiles), tiles, pageId: 'page-1', currentTheme: {}, focusedChartId: 105,
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
  scope: 'report',
  direction: { style: 'executive', density: 'balanced' },
  sections: [
    { primitive: 'kpi_strip', visuals: ['101', '102', '103', '104'], title: '' },
    { primitive: 'full_width', visuals: ['105'], title: '' },
    { primitive: 'table_full', visuals: ['108'], title: '' },
    { primitive: 'two_equal', visuals: ['106', '107'], title: '' },
  ],
  visualPreferences: {
    101: { role: 'kpi', span: 'small', emphasis: 'normal' },
    105: { role: 'primary', span: 'large', emphasis: 'high' },
  },
  themeIntent: { template: 'brief', colorway: 'slate' },
  rationale: 'Executive layout.',
};

check('string visual ids from a model are accepted, not read as hallucinations', () => {
  const tiles = makeTiles();
  const { plan } = validator.coerceModelPlan(REAL_MODEL_REPLY, { scope: 'page' });
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
  const { plan, notes } = validator.coerceModelPlan(reply, { scope: 'report' });
  assertEqual(plan.themeIntent.template, 'console', '"saas" was not read as the console template');
  assert(notes.some((n) => /saas/.test(n)), 'the translation was not disclosed');
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.ok, `the translated plan was still refused: ${JSON.stringify(result.violations)}`);
});

check('an unrecognisable theme name is dropped, not fatal', () => {
  const tiles = makeTiles();
  const reply = { ...REAL_MODEL_REPLY, themeIntent: { template: 'cyberpunk', colorway: 'neon' } };
  const { plan, notes } = validator.coerceModelPlan(reply, { scope: 'report' });
  assertEqual(plan.themeIntent, undefined, 'an invented theme survived coercion');
  assertEqual(notes.length, 2, 'the user was not told both names were dropped');
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(result.ok, 'a layout was lost because of a theme name');
});

check('a semantic violation is still fatal after coercion', () => {
  // Leniency about cosmetic names must not have softened the real gate.
  const tiles = makeTiles();
  const reply = { ...REAL_MODEL_REPLY, tileStyles: { 105: { dataLimit: 5 } } };
  const { plan } = validator.coerceModelPlan(reply, { scope: 'page' });
  const result = validator.validatePresentationPlan(plan, tiles.map((t) => t.id));
  assert(!result.ok && !result.repairable, 'a row limit survived the softened boundary');
});

check('the panel decides LAYOUT scope, not the model', () => {
  // The reply above asks for 'report'. The user chose this page; the scope the
  // model wanted is imposed back to the panel's choice for LAYOUT reach. (Theme
  // is report-wide by nature and applies whenever requested — see below.)
  const { plan } = validator.coerceModelPlan(REAL_MODEL_REPLY, { scope: 'page' });
  assertEqual(plan.scope, 'page', 'the model widened its own blast radius');
});

check('a real model reply compiles to a clean page', () => {
  const tiles = makeTiles();
  const { plan } = validator.coerceModelPlan(REAL_MODEL_REPLY, { scope: 'page' });
  const result = buildFor(tiles, plan);
  assert(result.ok, `the reply did not survive the contract: ${JSON.stringify(result.mutationValidation.violations)}`);
  assertEqual(validator.findOverlaps(result.mutation.layoutOverrides), [], 'overlaps');
  assertEqual(Object.keys(result.mutation.layoutOverrides).length, tiles.length, 'a visual was lost');
});

check('an echoed prompt is refused rather than compiled', () => {
  // The planner's first deployed reply was the input payload echoed back. The
  // server now catches that, but the client must not depend on it.
  const tiles = makeTiles();
  const echoed = { report: {}, visuals: [], capabilities: {}, planSchema: {} };
  const { plan } = validator.coerceModelPlan(echoed, { scope: 'page' });
  const result = buildFor(tiles, plan);
  const diff = diffMod.diffPresentation(tiles, result.mutation);
  // No sections means nothing was asked for; every visual is appended in
  // reading order rather than the page being silently emptied.
  assertEqual(Object.keys(result.mutation.layoutOverrides).length, tiles.length, 'an empty plan lost visuals');
  assert(result.mutation.notes.some((n) => /not placed/.test(n)), 'the user was not warned the plan was empty');
  void diff;
});

// ── Executor: scope, baseline and the single write path ─────────────────────

check('theme applies whenever requested; a layout-only redesign writes no theme', () => {
  const tiles = makeTiles();
  // Theme is a report-level property, so a theme intent applies report-wide the
  // moment it is asked for — even on page scope. No deferral, no "switch scope".
  const themed = buildFor(tiles, { ...planFor(tiles), scope: 'page', themeIntent: { template: 'ops', colorway: 'slate' } });
  assert(Object.keys(themed.mutation.themePatch).length > 0, 'a requested theme was deferred instead of applied');
  assert(!themed.mutation.notes.some((n) => /Entire report/i.test(n)), 'a stale "switch scope" note was emitted');
  // But a redesign that asked for NO theme (planFor carries none) must never
  // repaint the theme, on any scope.
  const layoutOnly = buildFor(tiles, { ...planFor(tiles), scope: 'report' });
  assertEqual(layoutOnly.mutation.themePatch, {}, 'a layout-only redesign repainted the theme');
});

check('a report-scoped redesign writes theme keys from the catalog', () => {
  const tiles = makeTiles();
  const plan = { ...planFor(tiles), scope: 'report', themeIntent: { template: 'ops', colorway: 'slate' } };
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
    mutation: { layoutOverrides: {}, themePatch: { cardShadow: undefined, titleFontSize: undefined, accent: '#325ac2' }, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
  });
  assert(okClear.ok, `clearing legacy keys was refused: ${JSON.stringify(okClear.violations)}`);
  const badSet = validator.validatePresentationMutation({
    before, after: before, pageId: 'page-1',
    mutation: { layoutOverrides: {}, themePatch: { cardShadow: '0 4px 20px red' }, slicerClusterPatch: {}, createdWidgets: [], notes: [] },
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
  const plan = { ...planFor(tiles), scope: 'report', slicerPresentation: { dock: 'left', variant: 'compact' } };
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
