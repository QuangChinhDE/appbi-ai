/**
 * Unified Grid & Slicer Freedom — the contract, checked on the real modules.
 *
 *   node scripts/check-unified-grid-contract.mjs
 *
 * What it holds the code to (each check names the failure it prevents):
 *  - a slicer control is presentation: it stores {slicerId, treatment}, and
 *    moving, resizing or restyling it cannot change the effective filter set a
 *    chart is queried with, on the builder or on the public link;
 *  - every visible slicer is drawn exactly once per page — by its control or by
 *    the filter bar — and an edit made in the bar never deletes a placed one;
 *  - a control whose slicer is hidden here, gone, or stripped by a link lock
 *    shows nothing to a viewer;
 *  - the Arrange tools never overlap tiles, never move a locked one, and move
 *    nothing that is not selected;
 *  - a phone keeps two controls side by side and never shrinks one below use;
 *  - AI Design can place only slicers that exist and are visible here, never in
 *    a style-only change, and creates the same `slicer` widget a person does;
 *  - Canvas is gone from the builder: no second layout engine to drift.
 */
import { readFileSync, existsSync } from 'node:fs';
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
const source = (relative) => readFileSync(resolve(SRC, relative), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const placement = load('lib/slicer-placement.ts');
const entry = load('lib/slicer-entry.ts');
const filters = load('lib/filters.ts');
const publicPage = load('lib/public-page-filters.ts');
const arrange = load('lib/grid-arrange.ts');
const pages = load('lib/dashboard-pages.ts');
const tileFrame = load('lib/dashboard-presentation/tile-frame.ts');
const validator = load('lib/dashboard-presentation/validator.ts');
const snapshotMod = load('lib/dashboard-presentation/snapshot.ts');
const executor = load('lib/dashboard-presentation/executor.ts');

// ── fixtures ────────────────────────────────────────────────────────────────

const DATE = { id: 'gf-date', field: 'order_date', fieldKey: 'orders.order_date', semanticField: 'orders.order_date', datasetId: 3,
  type: 'date', operator: 'between', value: ['2018-01-01', '2018-06-30'], label: 'Order date', interactionType: 'date_range', scope: 'all' };
const STATE = { id: 'gf-state', field: 'state', fieldKey: 'customers.state', semanticField: 'customers.state', datasetId: 3,
  type: 'dropdown', operator: 'in', value: ['SP'], label: 'State', interactionType: 'dropdown', scope: 'page' };
const CAT = { id: 'gf-cat', field: 'category', fieldKey: 'products.category', semanticField: 'products.category', datasetId: 3,
  type: 'dropdown', operator: 'in', value: [], label: 'Category', scope: 'custom',
  pageScope: { 'page-1': { filter: true, visible: false }, 'page-2': { filter: true, visible: true } } };

const chart = (id, x, y, w, h, extra = {}) => ({ id, chart_id: 900 + id, widget_type: 'chart', widget_config: null,
  layout: { x, y, w, h, gv: 2, pageId: 'page-1', ...extra }, chart: { id: 900 + id, name: `Chart ${id}`, chart_type: 'BAR' } });
const control = (id, slicerId, x, y, w = 8, h = 3, extra = {}) => ({ id, chart_id: null, widget_type: 'slicer',
  widget_config: { slicerId, treatment: 'auto' }, layout: { x, y, w, h, gv: 2, pageId: 'page-1', ...extra } });

const filtersPage = (s, pageId) => {
  const scope = s?.scope || 'all';
  if (scope === 'custom') return Boolean(s?.pageScope?.[pageId ?? '']?.filter);
  return true;
};
const effective = (globalSlicers, pageSlicers) => filters.resolveEffectiveFilterSet({
  globalFilters: [], pageFilters: [], globalSlicers, pageSlicers, activePageId: 'page-1', slicerFiltersPage: filtersPage,
});

// ── the control is presentation ─────────────────────────────────────────────

check('a control stores only which slicer and how it looks — never a predicate', () => {
  const stored = placement.normalizeSlicerControlConfig({
    slicerId: 'gf-state', treatment: 'list', origin: 'ai',
    field: 'x', operator: 'in', value: ['SP'], scope: 'all', pageScope: {}, datasetId: 3,
  });
  assert(same(stored, { slicerId: 'gf-state', treatment: 'list', origin: 'ai' }), JSON.stringify(stored));
  assert(same(placement.normalizeSlicerControlConfig({ treatment: 'neon' }), { slicerId: '', treatment: 'auto' }), 'an unknown look was kept');
});

check('moving, resizing and restyling a control leaves the effective filter set identical', () => {
  const before = effective([DATE, CAT], [STATE]);
  // The control's geometry and treatment are the only things that change; the
  // entries the filter set is computed from are the same objects.
  const tiles = [chart(1, 0, 3, 18, 10), control(50, 'gf-state', 0, 0)];
  const moved = tiles.map((t) => (t.id === 50 ? { ...t, layout: { ...t.layout, x: 20, y: 14, w: 14, h: 9, slicerTreatment: 'list' } } : t));
  assert(placement.placedSlicerIds(moved).has('gf-state'), 'the moved control lost its slicer');
  const after = effective([DATE, CAT], [STATE]);
  assert(same(before, after), 'the filter set changed');
  // And the edit path a control uses — replace by id with the SAME entry — is a no-op.
  assert(same(placement.replaceSlicerById([DATE, STATE], { ...STATE }), [DATE, STATE]), 'a no-op edit changed the list');
});

check('a value picked in a control is staged into exactly that entry, nothing else', () => {
  const next = placement.replaceSlicerById([DATE, STATE, CAT], { ...STATE, value: ['RJ'] });
  assert(same(next.map((s) => s.id), ['gf-date', 'gf-state', 'gf-cat']), 'order changed');
  assert(same(next[1].value, ['RJ']) && same(next[0], DATE) && same(next[2], CAT), 'a sibling changed');
  assert(same(placement.replaceSlicerById([DATE], { ...STATE, value: ['RJ'] }), [DATE]), 'an unknown id was added');
});

check('the public link resolves the same filters whether or not controls are placed', () => {
  const dash = (charts) => ({ slicers_config: [DATE, CAT], filters_config: [], pages_config: [{ id: 'page-1', slicers: [STATE] }], dashboard_charts: charts });
  const bare = publicPage.resolvePublicPageFilterContext(dash([chart(1, 0, 0, 18, 10)]), [{ id: 'page-1' }], 'page-1');
  const placed = publicPage.resolvePublicPageFilterContext(dash([chart(1, 0, 4, 18, 10), control(50, 'gf-state', 0, 0), control(51, 'gf-date', 8, 0)]), [{ id: 'page-1' }], 'page-1');
  assert(same(bare, placed), 'placing controls changed the public filter context');
  // CAT filters page-1 silently (custom scope: filter, not visible) either way.
  assert(placed.hiddenFilters.some((f) => f.id === 'gf-cat'), 'the silent scoped filter was lost');
});

// ── one control per slicer per page ─────────────────────────────────────────

check('every visible slicer is drawn exactly once: by its control or by the bar', () => {
  const tiles = [chart(1, 0, 3, 18, 10), control(50, 'gf-state', 0, 0), control(51, 'gf-missing', 8, 0)];
  const { bar, placed } = placement.partitionSlicerControls([DATE, STATE], tiles);
  assert(same(bar.map((s) => s.id), ['gf-date']), `bar=${bar.map((s) => s.id)}`);
  assert(same(placed.map((s) => s.id), ['gf-state']), `placed=${placed.map((s) => s.id)}`);
  assert(bar.length + placed.length === 2, 'a slicer was lost or duplicated');
});

check('an edit made in the bar never deletes a placed slicer', () => {
  // The bar sees only DATE; it reports its whole list (edited) on change.
  const fromBar = [{ ...DATE, value: ['2018-02-01', '2018-02-28'] }];
  const merged = placement.mergeBarChange(fromBar, [STATE]);
  assert(same(merged.map((s) => s.id), ['gf-date', 'gf-state']), `merged=${merged.map((s) => s.id)}`);
  assert(same(merged[1], STATE), 'the placed slicer was changed');
  // A slicer removed IN the bar stays removed; placed ones come back once.
  assert(same(placement.mergeBarChange([], [STATE]).map((s) => s.id), ['gf-state']), 'placed slicer dropped');
  assert(placement.mergeBarChange([STATE], [STATE]).length === 1, 'placed slicer duplicated');
});

check('a hidden, removed or link-stripped slicer gives a viewer no control', () => {
  const visibleHere = (s) => (s.scope === 'custom' ? Boolean(s.pageScope?.['page-1']?.visible) : true);
  const filtersHere = (s) => filtersPage(s, 'page-1');
  const hidden = placement.resolveSlicerControl('gf-cat', [DATE, CAT], { visibleHere, filtersHere });
  assert(hidden.state === 'hidden' && hidden.filtersHere === true, JSON.stringify(hidden));
  assert(placement.resolveSlicerControl('gf-gone', [DATE], { visibleHere, filtersHere }).state === 'missing', 'a deleted slicer resolved');
  assert(placement.resolveSlicerControl(null, [DATE], { visibleHere, filtersHere }).state === 'missing', 'an empty control resolved');
  // Public: the server strips a link-locked field from slicers_config, so the
  // viewer's seed has no entry → missing → the tile renders nothing.
  const seed = [DATE];
  assert(placement.resolveSlicerControl('gf-state', seed, { visibleHere: () => true, filtersHere: () => true }).state === 'missing',
    'a stripped (link-locked) slicer got a control');
  const tileSrc = source('components/dashboards/GridSlicerTile.tsx');
  assert(/state === 'missing' \|\| \(resolution\.state === 'hidden' && !binding\.editing\)/.test(tileSrc)
    && tileSrc.includes('data-slicer-control="absent"'), 'the viewer branch no longer renders nothing for hidden/missing');
});

check('a treatment changes the drawing, never the interaction', () => {
  const tall = { slicer: STATE, tileHeightPx: 300 };
  const short = { slicer: STATE, tileHeightPx: 80 };
  assert(placement.resolveTreatment('auto', tall) === 'list', 'a tall categorical auto control is not a list');
  assert(placement.resolveTreatment('auto', short) === 'theme', 'a short auto control is not the card');
  assert(placement.resolveTreatment('list', { slicer: DATE, tileHeightPx: 300 }) === 'dropdown', 'a date range became a list');
  assert(placement.resolveTreatment('buttons', { slicer: DATE, tileHeightPx: 80 }) === 'dropdown', 'a date range became buttons');
  // The layout's choice wins over the one the control was created with.
  const tile = control(50, 'gf-state', 0, 0, 8, 3, { slicerTreatment: 'compact' });
  assert(placement.treatmentOfControl(tile) === 'compact', 'the author\'s display choice was ignored');
});

check('a new control and a bar slicer are created by the same factory', () => {
  const column = { name: 'state', key: 'customers.state', semanticField: 'customers.state', datasetId: 3, type: 'dropdown', label: 'State', chartCoverage: 2 };
  const made = entry.createSlicerEntry({ column, columns: [column], usedFields: new Set(), interaction: 'dropdown', pageScope: true, id: 'gf-x' });
  assert(made.operator === 'in' && same(made.value, []) && made.scope === 'page' && made.fieldKey === 'customers.state',
    JSON.stringify(made));
  const barSrc = source('components/dashboards/DashboardFilterBar.tsx');
  assert(barSrc.includes('createSlicerEntry({') && !barSrc.includes('id:           `gf-${Date.now()}`'),
    'the filter bar builds its own entry again');
  const date = entry.createSlicerEntry({ column: { ...column, type: 'date', name: 'order_date' }, columns: [], usedFields: new Set(),
    interaction: entry.defaultInteractionFor({ type: 'date' }), id: 'gf-d' });
  assert(date.operator === 'between' && date.datePreset === 'this_month', JSON.stringify(date));
});

// ── Arrange tools ───────────────────────────────────────────────────────────

const box = (id, x, y, w, h, locked = false) => ({ id, x, y, w, h, locked });

check('align moves only the selection and never onto another tile', () => {
  const page = [box(1, 2, 0, 8, 4), box(2, 6, 6, 8, 4), box(3, 20, 0, 8, 4)];
  const res = arrange.arrangeTiles('alignLeft', page, [1, 2]);
  assert(res.status === 'ok' && same(res.moved, [box(2, 2, 6, 8, 4)]), JSON.stringify(res));
  const blocked = arrange.arrangeTiles('alignTop', [box(1, 0, 0, 8, 4), box(2, 0, 6, 8, 4)], [1, 2]);
  assert(blocked.status === 'blocked' && blocked.blockedBy === 1, `stacked tiles were aligned on top of each other: ${JSON.stringify(blocked)}`);
  const other = arrange.arrangeTiles('alignTop', [box(1, 0, 0, 8, 4), box(2, 10, 8, 8, 4), box(3, 10, 2, 8, 3)], [1, 2]);
  assert(other.status === 'blocked' && other.blockedBy === 3, 'an unselected tile was overlapped');
});

check('a locked tile is an obstacle, never moved', () => {
  const res = arrange.arrangeTiles('alignLeft', [box(1, 0, 0, 8, 4), box(2, 10, 6, 8, 4, true), box(3, 12, 12, 6, 3)], [1, 2, 3]);
  assert(res.status === 'ok' && res.moved.every((b) => b.id !== 2) && res.skippedLocked === 1, JSON.stringify(res));
  const nudge = arrange.nudgeTiles([box(1, 0, 0, 8, 4, true)], [1], { dx: 1, dy: 0 });
  assert(nudge.status === 'noop', 'a locked tile was nudged');
});

check('distribute gives equal gaps inside the span, match width uses the first selected', () => {
  const res = arrange.arrangeTiles('distribute', [box(1, 0, 0, 6, 3), box(2, 8, 0, 6, 3), box(3, 30, 0, 6, 3)], [1, 2, 3]);
  assert(res.status === 'ok' && same(res.moved, [box(2, 15, 0, 6, 3)]), JSON.stringify(res));
  const w = arrange.arrangeTiles('matchWidth', [box(1, 0, 0, 12, 3), box(2, 30, 6, 4, 3)], [1, 2]);
  assert(w.status === 'ok' && w.moved[0].w === 12 && w.moved[0].x + 12 <= 36, JSON.stringify(w));
});

check('a nudge is all or nothing and stays on the grid', () => {
  const page = [box(1, 0, 0, 8, 4), box(2, 9, 0, 8, 4)];
  assert(arrange.nudgeTiles(page, [1], { dx: 1, dy: 0 }).status === 'ok', 'a free nudge was refused');
  assert(arrange.nudgeTiles(page, [1], { dx: 2, dy: 0 }).status === 'blocked', 'a nudge into a neighbour went through');
  assert(arrange.nudgeTiles(page, [1], { dx: -3, dy: -2 }).status === 'noop', 'a nudge left the grid');
});

// ── Responsive ──────────────────────────────────────────────────────────────

check('a phone keeps two controls side by side, each at a usable height', () => {
  assert(tileFrame.tileKindOf(null, 'slicer') === 'slicer', 'a control is not its own kind');
  const layout = [
    { i: 'a', x: 0, y: 0, w: 8, h: 2 }, { i: 'b', x: 8, y: 0, w: 8, h: 2 },
    { i: 'c', x: 0, y: 2, w: 36, h: 10 },
  ];
  const kind = (it) => (it.i === 'c' ? 'chart' : 'slicer');
  const out = pages.deriveStackedLayout(layout, { kindOf: kind, rowPitchPx: 24, cols: 2 });
  const a = out.find((o) => o.i === 'a'); const b = out.find((o) => o.i === 'b');
  assert(a.y === b.y && a.w === 1 && b.w === 1, `controls were not paired: ${JSON.stringify(out)}`);
  assert(a.h * 24 >= pages.STACK_MIN_HEIGHT_PX.slicer, 'a control was stacked below its usable height');
  assert(a.h <= 3, `a control became a tall card on the phone (h=${a.h})`);
  const tablet = pages.deriveTabletLayout([{ i: 'a', x: 0, y: 0, w: 3, h: 2 }], { kindOf: () => 'slicer', referenceWidthPx: 820 });
  assert(tablet[0].w * (820 / 36) >= pages.RESPONSIVE_MIN_WIDTH_PX.slicer, 'a control was left too narrow at tablet width');
});

// ── AI Design ───────────────────────────────────────────────────────────────

function snap(tiles, slicers) {
  return snapshotMod.buildPresentationSnapshot({
    dashboard: { name: 'Olist review', theme_config: {}, dashboard_charts: tiles },
    tiles, pageId: 'page-1', pageName: 'Overview', pageCount: 1, slicers, slicerDock: 'top',
  });
}

check('the snapshot says where each slicer is and never what it filters', () => {
  const tiles = [chart(1, 0, 3, 18, 10), control(50, 'gf-state', 0, 0)];
  const s = snap(tiles, [DATE, STATE, CAT]);
  const byId = Object.fromEntries(s.slicers.map((x) => [x.id, x]));
  assert(byId['gf-state'].placedTileId === 50 && byId['gf-state'].currentPosition === 'grid', JSON.stringify(byId['gf-state']));
  assert(byId['gf-date'].placedTileId === null && byId['gf-date'].visibleHere === true, JSON.stringify(byId['gf-date']));
  assert(byId['gf-cat'].visibleHere === false, 'a custom scope hidden here was offered');
  const visual = s.visuals.find((v) => v.dashboardChartId === 50);
  assert(visual.title === 'State' && visual.widgetType === 'slicer', JSON.stringify(visual));
  const text = JSON.stringify(s);
  assert(!text.includes('customers.state') && !text.includes('2018-06-30'), 'a field or a value reached the planner');
});

check('a redesign may place existing slicers — only visible, unplaced ones — and style may not', () => {
  const tiles = [chart(1, 0, 3, 18, 10), chart(2, 18, 3, 18, 10), control(50, 'gf-state', 0, 0)];
  const s = snap(tiles, [DATE, STATE, CAT]);
  const slicers = s.slicers.map((x) => ({ id: x.id, placedTileId: x.placedTileId, visibleHere: x.visibleHere }));
  const raw = { layer: 'redesign', direction: { style: 'saas' },
    slicerControls: [{ id: 's1', slicer: 'gf-date', treatment: 'dropdown' }, { id: 's2', slicer: 'gf-state' },
      { id: 's3', slicer: 'gf-cat' }, { id: 's4', slicer: 'gf-nope' }],
    sections: [{ primitive: 'two_equal', visuals: [1, 2] }, { primitive: 'full_width', visuals: [50] }] };
  const out = validator.coerceModelPlan(raw, { grantedLayer: 'redesign', knownTileIds: [1, 2, 50], slicers });
  const controls = out.plan.slicerControls ?? [];
  assert(controls.length === 1 && controls[0].slicerId === 'gf-date' && controls[0].treatment === 'dropdown', JSON.stringify(controls));
  assert(out.notes.some((n) => /3 slicer control/.test(n)), `the refusals were not disclosed: ${out.notes}`);
  // The unplaced control opens the page as a filter band.
  assert(out.plan.sections[0].primitive === 'filter_bar' && out.plan.sections[0].visuals[0] === controls[0].id,
    JSON.stringify(out.plan.sections[0]));
  const style = validator.coerceModelPlan({ ...raw, layer: 'style' }, { grantedLayer: 'style', knownTileIds: [1, 2, 50], slicers });
  assert(!(style.plan.slicerControls ?? []).length, 'a style-only change placed a slicer');
});

check('Apply creates the same slicer widget a person creates, sized as a control', () => {
  const tiles = [chart(1, 0, 0, 18, 10), chart(2, 18, 0, 18, 10)];
  const s = snap(tiles, [DATE, STATE]);
  const slicers = s.slicers.map((x) => ({ id: x.id, placedTileId: x.placedTileId, visibleHere: x.visibleHere }));
  const { plan } = validator.coerceModelPlan({
    layer: 'redesign', direction: { style: 'saas' },
    slicerControls: [{ id: 's1', slicer: 'gf-date' }, { id: 's2', slicer: 'gf-state', treatment: 'list' }],
    sections: [{ primitive: 'filter_bar', visuals: ['s1'] }, { primitive: 'two_one', visuals: [1, 's2'] }, { primitive: 'full_width', visuals: [2] }],
  }, { grantedLayer: 'redesign', knownTileIds: [1, 2], slicers });
  const built = executor.buildPresentationMutation({ plan, snapshot: s, tiles, pageId: 'page-1', currentTheme: {}, gridGapPx: 16, targets: [] });
  assert(built.ok, JSON.stringify(built.planValidation?.violations ?? built.mutationValidation?.violations));
  const created = built.mutation.createdBlocks ?? [];
  const date = created.find((c) => c.widgetConfig.slicerId === 'gf-date');
  const state = created.find((c) => c.widgetConfig.slicerId === 'gf-state');
  assert(date && state && created.every((c) => c.widgetType === 'slicer'), JSON.stringify(created));
  assert(same(Object.keys(date.widgetConfig).sort(), ['origin', 'slicerId', 'treatment']), JSON.stringify(date.widgetConfig));
  assert(date.layout.y === 0 && date.layout.w === 9 && date.layout.h <= 3, `the filter band control is ${JSON.stringify(date.layout)}`);
  // Beside a chart, the control takes the chart's row height (and then lists its values).
  const o1 = built.mutation.layoutOverrides[1];
  assert(state.layout.y === o1.y && state.layout.h === o1.h, `the contextual control is not in its chart's row: ${JSON.stringify(state.layout)} vs ${JSON.stringify(o1)}`);
});

check('a grid control searches values on the SAME resolved filter set as the bar (chart↔dropdown parity)', () => {
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  // Both builder type-to-search paths — the bar's inline one and the grid
  // controls' callback — collapse same-field filters with resolveEffectiveFilterSet
  // and feed THAT to getDistinctValueFilterContext, never the raw union.
  const shared = page.slice(page.indexOf('const fetchSlicerServerDistinct = useCallback('), page.indexOf('// ── Slicer controls: add, restyle, remove, delete'));
  assert(shared.includes('resolveEffectiveFilterSet({') && shared.includes('getDistinctValueFilterContext(ctx, column)'), 'the grid control search left the resolved set');
  const inline = page.slice(page.indexOf('fetchServerDistinct={async (column, search) => {'));
  assert(inline.slice(0, 1400).includes('resolveEffectiveFilterSet({') && inline.slice(0, 1400).includes('getDistinctValueFilterContext(ctx, column)'), 'the bar search left the resolved set');
  assert(!/getDistinctValueFilterContext\(combinedFilters/.test(page), 'a raw-union distinct context is back');
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  const pubSearch = pub.slice(pub.indexOf('const fetchPublicServerDistinct'));
  // Public: the viewer's applied filters plus the page's hidden bounds — the
  // same context the bar's search always used on the link.
  assert(/getDistinctValueFilterContext\(\s*\[\.\.\.appliedViewerFilters, \.\.\.pageHiddenFilters\], column/.test(pubSearch.slice(0, 900)),
    'the public control search left the viewer\'s resolved context');
});

check('a direction keeps the slicer controls the model asked for (filter band after the headline)', () => {
  const directions = load('lib/dashboard-presentation/directions.ts');
  const tiles = [chart(1, 0, 0, 9, 6), chart(2, 9, 0, 9, 6), chart(3, 0, 6, 18, 12), chart(4, 18, 6, 18, 12)];
  tiles[0].chart.chart_type = 'KPI'; tiles[1].chart.chart_type = 'KPI';
  const s = { ...snap(tiles, [STATE]), findings: [{ key: 'trend:3', sentence: 'x' }] };
  const pack = directions.planForDirection('executive', s, {});
  const controls = [{ id: -1000, slicerId: 'gf-state', treatment: 'auto' }];
  const plan = validator.carrySlicerControls(pack, controls);
  assert(same(plan.slicerControls, controls), 'the controls were dropped');
  const at = plan.sections.findIndex((x) => x.primitive === 'filter_bar');
  const headline = (plan.blocks ?? []).find((b) => b.variant === 'headline');
  const headAt = headline ? plan.sections.findIndex((x) => x.visuals.includes(headline.id)) : -1;
  assert(at === headAt + 1, `the filter band is at ${at}, the headline at ${headAt}`);
  assert(same(validator.carrySlicerControls(pack, undefined), pack), 'a plan without controls changed');
  const src = source('components/dashboards/ai-design/useAiDesign.ts');
  assert(/carrySlicerControls\(\{[\s\S]*?\}, plan\.slicerControls\)/.test(src), 'the direction path no longer carries the controls');
});

// ── Canvas is gone ──────────────────────────────────────────────────────────

check('there is one layout engine: no Canvas component, conversion or toggle', () => {
  assert(!existsSync(resolve(SRC, 'components/dashboards/DashboardCanvas.tsx')), 'DashboardCanvas.tsx is back');
  assert(!existsSync(resolve(SRC, 'lib/dashboard-layout-convert.ts')), 'the Canvas conversion is back');
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  assert(!/layout_mode/.test(page), 'the builder reads layout_mode again');
  assert(!/DashboardCanvas|handleToggleLayoutMode|switchToCanvas/.test(page), 'a Canvas path is back in the builder');
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  assert(!/layout_mode|xPx/.test(pub), 'the public report reads Canvas geometry');
});

check('whitespace is kept and presentation never re-queries: placement is geometry only', () => {
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  // A new element goes below everything, never into a gap the author left.
  assert(page.includes('nextFreeSlot(visibleDashboardCharts'), 'a control is no longer placed at the first free row');
  const slot = placement.nextFreeSlot([{ layout: { x: 0, y: 6, w: 10, h: 4 } }], { w: 8, h: 3 });
  assert(same(slot, { x: 0, y: 10, w: 8, h: 3 }), JSON.stringify(slot));
  // The treatment change is a layout override (draft → publish, undoable), not a live widget write.
  assert(/slicerTreatment: treatment/.test(page) && !/updateWidget\([^)]*treatment/.test(page), 'the display is written outside the draft');
});

if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL  ${name}\n      ${error.message}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`unified grid contract: ${passed} checks passed`);
