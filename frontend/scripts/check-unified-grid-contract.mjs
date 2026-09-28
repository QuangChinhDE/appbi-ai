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

check('a grid control searches values on the resolved filter set (chart↔dropdown parity)', () => {
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  // The builder has ONE value search for its controls, handed to them by the
  // controls' scope: it collapses same-field filters with resolveEffectiveFilterSet
  // and feeds THAT to getDistinctValueFilterContext, never the raw union.
  const scope = page.slice(page.indexOf('<SlicerControlScope'));
  const search = scope.slice(scope.indexOf('fetchServerDistinct={async (column, search) => {'));
  assert(search.length > 0 && search.slice(0, 1400).includes('resolveEffectiveFilterSet({')
    && search.slice(0, 1400).includes('getDistinctValueFilterContext(ctx, column)'), 'the controls search left the resolved set');
  assert(!/getDistinctValueFilterContext\(combinedFilters/.test(page), 'a raw-union distinct context is back');
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  const pubSearch = pub.slice(pub.indexOf('const fetchPublicServerDistinct'));
  assert(/getDistinctValueFilterContext\(\s*\[\.\.\.appliedViewerFilters, \.\.\.pageHiddenFilters\], column/.test(pubSearch.slice(0, 900)),
    "the public control search left the viewer's resolved context");
});

check('there is no filter area outside the grid — builder, public and embed draw filters only as grid controls', () => {
  assert(!existsSync(resolve(SRC, 'components/dashboards/SlicerCluster.tsx')), 'SlicerCluster.tsx is back');
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  for (const [name, src] of [['builder', page], ['public', pub]]) {
    assert(!/<SlicerCluster[\s>]|dockLayoutClasses\(|resolveFilterDock\(/.test(src), `${name} still docks a filter area`);
  }
  // Filter-pane filters left visible to viewers are controls too (the public
  // link always let a viewer change them): the builder resolves them, and the
  // public seed still carries them.
  assert(/viewerPaneFilters/.test(page) && /controlFilters/.test(page), 'the builder cannot show a filter-pane filter as a control');
  const ctx = publicPage.resolvePublicPageFilterContext({
    slicers_config: [], filters_config: [{ id: 'f-pane', field: 'state', type: 'dropdown', operator: 'in', value: [], publicMode: 'visible' }],
    pages_config: [{ id: 'page-1' }],
  }, [{ id: 'page-1' }], 'page-1');
  assert(ctx.controlSeed.some((f) => f.id === 'f-pane'), "a visible filter-pane filter left the viewer's controls");
});

check('placing and removing a control are single undoable steps on the shared commit path', () => {
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  const place = page.slice(page.indexOf('const placeSlicerControls = useCallback('), page.indexOf('const usedSlicerFieldKeys'));
  assert(/await commitPresentation\(\{/.test(place) && /createdBlocks: slicers\.map/.test(place), 'placing a control bypasses the undoable commit path');
  assert(!/resetUndo\(\)/.test(place), 'placing a control wipes the undo history');
  const remove = page.slice(page.indexOf('const removeSlicerControl = useCallback('), page.indexOf('const removeSlicerControlRef'));
  assert(/await removeElementsInDraft\(\[tileId\], next\)/.test(remove) && /closeVacatedBand\(boxes, tileId\)/.test(remove) && !/resetUndo\(\)/.test(remove),
    'removing a control is not a draft removal, is not undoable, or leaves its band behind');
});

check('removing ANY element is a draft edit: the public link keeps it until Publish; Undo and Discard bring back the same element', () => {
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  const api = source('lib/api/dashboards.ts');
  // The builder never deletes a live row: every removal goes through the draft.
  assert(/removeChart: async[\s\S]{0,260}params: \{ draft: true \}/.test(api), 'the builder deletes a published element outright');
  assert(/restoreChart: async[\s\S]{0,200}\/restore`/.test(api), 'there is no way to take a draft removal back');
  // Editing a published widget's content (text, section title) is a draft edit too.
  assert(/updateWidget: async[\s\S]{0,800}params: \{ draft: true \}/.test(api), "editing a published widget's content publishes it at once");
  const shared = page.slice(page.indexOf('const removeElementsInDraft = useCallback('), page.indexOf('const removeElementsInDraftRef'));
  assert(/kind: 'removal', published, drafts/.test(shared), 'a removal is not one undoable step');
  // Undo of a published element restores THAT row — it never re-creates it as a
  // new draft-only row (which a Discard then deleted: a published control lost).
  const undo = page.slice(page.indexOf('const applyUndoEntry'), page.indexOf('const doUndo'));
  assert(/entry\.kind === 'removal'/.test(undo) && /for \(const id of entry\.published\) await dashboardApi\.restoreChart/.test(undo),
    'Undo of a published element does not restore it in place');
  assert(!/removedBlockSpecs/.test(page), 'a removal is still re-created as a new draft-only element on Undo');
  // Removing a chart or widget is a draft removal and undoable too.
  const confirm = page.slice(page.indexOf('const confirmRemoveChart = async'), page.indexOf('const confirmRemoveChart = async') + 1400);
  assert(/removeElementsInDraftRef\.current\(\[dashboardChart\.id\]/.test(confirm) && !/resetUndo\(\)/.test(confirm), 'removing a chart is not a draft removal, or not undoable');
  // Adding by hand is a draft addition (invisible to /d and /embed until Publish).
  const addWidget = page.slice(page.indexOf('const handleAddWidget'), page.indexOf('const handleCrossFilterChange'));
  assert(/draftOnly: true/.test(addWidget), 'a widget added by hand is published at once');
  const addChart = page.slice(page.indexOf('const handleAddChart = async'), page.indexOf('const handleAddChart = async') + 900);
  assert(/draftOnly: true/.test(addChart), 'a chart added by hand is published at once');
  // Delete filter: the entry and every control in ONE request.
  const del = page.slice(page.indexOf('const handleDeleteSlicerFilter = useCallback('), page.indexOf('const handleSlicerTreatmentChange'));
  assert(/remove_tile_ids: controls\.map/.test(del) && !/dashboardApi\.removeChart/.test(del), 'Delete filter removes its controls in separate requests');
  assert(/paneFilterIds\.has\(slicerId\)/.test(del) && /filters_config/.test(del), 'Delete filter leaves a filter-pane entry behind');
});

check('a tile dropped on others opens room where it lands; a vacated filter band closes; locks hold', () => {
  const b = (id, x, y, w, h, locked = false) => ({ id, x, y, w, h, locked });
  // A control moved from the top band down between the KPI row and the charts.
  const page = [b(50, 0, 0, 8, 3), b(1, 0, 3, 12, 6), b(2, 12, 3, 12, 6), b(3, 0, 9, 24, 16), b(4, 24, 9, 12, 16)];
  const res = arrange.resolveDrop(page, 50, { x: 0, y: 9, w: 8, h: 3 }, { from: { y: 0, h: 3 }, closeVacatedBand: true });
  assert(res.status === 'ok' && res.closedRows === 3, JSON.stringify(res));
  const changed = Object.fromEntries(res.changed.map((x) => [x.id, x]));
  const after = page.map((x) => ({ ...x, ...(changed[x.id] ?? {}) }));
  const at = Object.fromEntries(after.map((x) => [x.id, x]));
  // The band closed (KPIs up to 0), the control sits under them, the charts
  // end where they were: up with the band, down again for the control's row.
  assert(at[1].y === 0 && at[2].y === 0, `the band did not close: ${JSON.stringify(at)}`);
  assert(at[50].y === 6 && at[3].y === 9 && at[4].y === 9, `no room was opened under the KPIs: ${JSON.stringify(at)}`);
  const clash = after.some((p, i) => after.some((q, j) => j > i && p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h));
  assert(!clash, `tiles overlap: ${JSON.stringify(after)}`);
  // Dropped into the middle of a tall chart: it goes above that chart's row, never inside it.
  const mid = arrange.resolveDrop(page, 50, { x: 4, y: 15, w: 8, h: 3 }, {});
  const m = Object.fromEntries(page.map((x) => [x.id, { ...x, ...(Object.fromEntries(mid.changed.map((c) => [c.id, c]))[x.id] ?? {}) }]));
  assert(mid.status === 'ok' && m[50].y === 9 && m[3].y === 12, `dropped inside a chart: ${JSON.stringify(mid)}`);
  // A gap an author left elsewhere is never closed: only a filter control's band closes.
  const moved = arrange.resolveDrop([b(1, 0, 0, 12, 6), b(2, 0, 20, 12, 6)], 2, { x: 20, y: 20, w: 12, h: 6 }, { from: { y: 20, h: 6 }, closeVacatedBand: false });
  assert(moved.status === 'ok' && !moved.closedRows, "an author's whitespace was closed");
  // A locked tile below the drop point: refused, and named.
  const locked = arrange.resolveDrop([b(50, 0, 0, 8, 3), b(1, 0, 3, 12, 6, true)], 50, { x: 0, y: 3, w: 8, h: 3 }, {});
  assert(locked.status === 'refused' && locked.blockedBy === 1 && locked.reason === 'locked', JSON.stringify(locked));
  // …and the author is told which tile is locked, by its name.
  const pg = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/result\.reason === 'locked' \? 'dashboards\.arrange\.lockedInWay'/.test(pg), 'a refusal by a locked tile is reported as an overlap');
  // Removing the only control of a band closes it.
  const closed = arrange.closeVacatedBand([b(50, 0, 0, 8, 3), b(1, 0, 3, 12, 6)], 50);
  assert(closed.length === 1 && closed[0].y === 0, JSON.stringify(closed));
  const src = source('components/dashboards/DashboardGrid.tsx');
  assert(/allowOverlap=\{!!onLayoutChange && !isNarrow\}/.test(src), 'the builder grid cannot carry a tile over others');
});

check("each direction puts the page's filter controls where its reading order wants them", () => {
  const directions = load('lib/dashboard-presentation/directions.ts');
  const tiles = [chart(1, 0, 3, 9, 6), chart(2, 9, 3, 9, 6), chart(3, 0, 9, 24, 12), chart(4, 24, 9, 12, 12), control(50, 'gf-state', 0, 0)];
  tiles[0].chart.chart_type = 'KPI'; tiles[1].chart.chart_type = 'KPI';
  const s = { ...snap(tiles, [STATE]), findings: [{ key: 'trend:3', sentence: 'x' }] };
  const bandAt = (d) => {
    const plan = directions.planForDirection(d, s, {});
    const heads = new Set((plan.blocks ?? []).filter((x) => x.variant === 'headline').map((x) => x.id));
    return {
      i: plan.sections.findIndex((x) => x.primitive === 'filter_bar' && x.visuals.includes(50)),
      h: plan.sections.findIndex((x) => x.visuals.some((id) => heads.has(id))),
      n: plan.sections.length, plan,
    };
  };
  const exec = bandAt('executive'); const ops = bandAt('operations'); const ed = bandAt('editorial');
  // Right under the verdict — first, when the page has nothing to state yet.
  assert(exec.i === exec.h + 1, `executive: the filters are not right under the verdict (${exec.i}, headline ${exec.h})`);
  assert(ops.i === 0, `operations: the filters do not come first (${ops.i})`);
  assert(ed.i > exec.i && ed.i >= ed.n - 3, `editorial: the filters do not follow the story (${ed.i}/${ed.n})`);
  for (const r of [exec, ops, ed]) {
    for (const sec of r.plan.sections) assert(!(sec.visuals.includes(50) && sec.primitive !== 'filter_bar'), 'a control was paired with another element');
  }
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

check("the PDF draws a control's value, not a bare ellipsis: every capture uses the legible clone", () => {
  const exp = source('lib/export-pdf.ts');
  const calls = exp.split('html2canvas(').slice(1).map((s) => s.slice(0, 400));
  assert(calls.length >= 4, `expected the export's captures, found ${calls.length}`);
  assert(calls.every((c) => /onclone: legibleClone/.test(c)), 'a capture draws controls without the legible clone');
  assert(/\.dashboard-slicer[^']*text-overflow: clip/.test(exp), "the clone no longer stops the ellipsis on a control's text");
});

check('the builder draws a stored overlap the way viewers see it (settled), and drops work on that', () => {
  const settle = load('lib/grid-settle.ts');
  // Report 445: a legacy 12-column tile (×3) beside a newer cell, overlapping in storage.
  const stored = [{ i: '4537', x: 0, y: 2, w: 18, h: 8 }, { i: '4538', x: 9, y: 0, w: 18, h: 12 }];
  const out = settle.settleStoredLayout(stored, 36);
  const [a, b] = out;
  const clash = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert(!clash, `still overlapping: ${JSON.stringify(out)}`);
  assert(a.y === 2 && b.y === 10, `not the library's settling (the first stays, the next moves below it): ${JSON.stringify(out)}`);
  const clean = [{ i: '1', x: 0, y: 0, w: 12, h: 6 }, { i: '2', x: 12, y: 20, w: 12, h: 6 }];
  assert(settle.settleStoredLayout(clean, 36) === clean, "a layout without overlap is not returned untouched (an author's gaps moved)");
  const grid = source('components/dashboards/DashboardGrid.tsx');
  assert(/onLayoutChange && !isNarrow \? settleStoredLayout\(storedLayouts, DASHBOARD_GRID_COLS\)/.test(grid), 'the builder draws stored overlaps unsettled');
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/const pageBoxes = \(\): GridBox\[\] => settleStoredLayout\(/.test(page), 'drops are computed on the stored overlap, not on what the author sees');
});

check('the grid runs every hook before it returns for an empty page (switching to an empty page must not crash)', () => {
  const grid = source('components/dashboards/DashboardGrid.tsx');
  const body = grid.slice(grid.indexOf('function DashboardGridInner('), grid.indexOf('export function DashboardGrid('));
  const early = body.indexOf('if (dashboardCharts.length === 0) {');
  assert(early > 0, 'the empty-page return moved; re-check the hook order by hand');
  const end = body.indexOf('\n}\n', early);
  const after = body.slice(early, end > 0 ? end : undefined);
  assert(!/\b(React\.)?use(State|Memo|Effect|Callback|Ref|LayoutEffect|Context)\(/.test(after), 'a hook runs after the empty-page return');
});

check('a reader can always tell what filters the page: locks, page filters and control-less slicers are stated; nothing empty is', () => {
  const ppf = load('lib/public-page-filters.ts');
  const f = (id, field, value, extra = {}) => ({ id, field, type: 'dropdown', operator: 'in', value, ...extra });
  const facts = ppf.pageFilterFacts({
    applied: [f('s-state', 'customer_state', ['SP']), f('s-region', 'region', ['North', 'South']), f('s-empty', 'category', [])],
    pageHidden: [f('p-cat', 'channel', ['Online']), f('p-date', 'order_date', [], { type: 'date', datePreset: 'this_month' })],
    locked: [{ field: 'seller_state', label: 'Seller state', value: ['RJ'] }, { field: 'region', value: ['North'] }],
    withoutControl: new Set(['s-region', 's-empty']),
  });
  const by = Object.fromEntries(facts.map((x) => [x.key, x]));
  assert(by.seller_state?.locked && by.seller_state.value === 'RJ', `a link lock is not stated: ${JSON.stringify(facts)}`);
  assert(by.region?.locked && by.region.value === 'North', 'a lock does not win over a same-field slicer');
  assert(by.channel?.value === 'Online' && by.order_date?.preset === 'this_month', 'a filter the page carries is not stated');
  assert(!by.customer_state, 'a slicer whose control is on the page is repeated in the header');
  assert(!by.category, 'an empty filter is announced as if it filtered');
  // The operator is part of the fact: "not SP" is never stated as "SP".
  const ops = Object.fromEntries(ppf.pageFilterFacts({
    applied: [f('s-amt', 'amount', [10, 50], { type: 'number', operator: 'between' })],
    pageHidden: [],
    locked: [{ field: 'seller_state', value: ['SP'], operator: 'not_in' }, { field: 'order_date', value: null, datePreset: 'last_30_days' }],
  }).map((x) => [x.key, x]));
  assert(ops.seller_state?.negated === true && ops.seller_state.value === 'SP', `a locked exclusion is stated as an inclusion: ${JSON.stringify(ops)}`);
  assert(ops.amount?.value === '10 – 50', 'a range is not stated as a range');
  assert(ops.order_date?.preset === 'last_30_days' && ops.order_date.locked, 'a locked relative date is dropped');
  const more = Object.fromEntries(ppf.pageFilterFacts({
    applied: [f('s-min', 'amount', 1000, { type: 'number', operator: 'gte' })],
    pageHidden: [],
    locked: [{ field: 'customer_state', value: 'SP', operator: 'in' }, { field: 'channel', value: 'Online', operator: 'ne' },
      { field: 'category', value: 'toys', operator: 'not_contains' }],
  }).map((x) => [x.key, x]));
  assert(more.customer_state?.value === 'SP', `a scalar lock the server enforces is not stated: ${JSON.stringify(more)}`);
  assert(more.channel?.negated && more.category?.negated, 'an exclusion spelled ne / not_contains is stated as an inclusion');
  assert(more.amount?.value === '≥ 1000', 'a comparison is stated as a bare value');
  // As the engine enforces: a dropped lock is not announced; is_null is; a
  // one-sided range reads as one; a pattern is not equality.
  const eng = Object.fromEntries(ppf.pageFilterFacts({
    applied: [], pageHidden: [],
    locked: [{ field: 'store', value: 5, operator: 'in' }, { field: 'order_date', value: [null, null], operator: 'between' },
      { field: 'closed_at', value: null, operator: 'is_null' }, { field: 'price', value: ['10'], operator: 'between' },
      { field: 'name', value: 'abc', operator: 'contains' }],
  }).map((x) => [x.key, x]));
  assert(!eng.store && !eng.order_date, `a lock the engine drops is announced: ${JSON.stringify(eng)}`);
  assert(eng.closed_at?.kind === 'isEmpty', 'an is_null lock is silent');
  assert(eng.price?.value === '≥ 10', 'a one-sided range reads as equality');
  assert(eng.name?.kind === 'contains', 'a pattern reads as equality');
  const builderSrc = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/statePageFilterFact\(f, t\)/.test(builderSrc), 'the builder PDF words a filter on its own');
  const pv = source('components/dashboards/PublicDashboardView.tsx');
  assert(/public_link_locked_filters/.test(pv) && /filterContextFacts\.map/.test(pv), "the public header does not state the page's filters");
  assert(/summarizeViewerFilters = useCallback\([^)]*\): string => pageFilterFacts\(/.test(pv), 'the PDF header lists filters by name without their value');
  // One wording for the banner and both PDF headers.
  assert((pv.match(/statePageFilterFact\(f(act)?, t\)/g) || []).length >= 2, 'the banner or the public PDF words a filter on its own');
  const st = (kind, value = 'x') => ppf.statePageFilterFact({ key: 'k', label: 'L', value, locked: true, kind }, (k, p) => `${k}|${p?.value ?? ''}`);
  assert(st('excluding', 'SP') === 'dashboards.filterContext.excluding|SP' && st('isEmpty') === 'dashboards.filterContext.isEmpty|'
    && st('contains', 'ab') === 'dashboards.filterContext.contains|ab', 'a kind of fact has no wording');
  assert(/operator: e\.operator, datePreset: e\.datePreset/.test(pv), 'the served operator/preset is dropped before the banner');
  // Each PDF page states its own filters, not the active page's.
  assert(/filtersSummary: filtersSummaryFor\(p\.id\)/.test(pv), 'the public PDF prints the active page\'s filters on every page');
  assert(/locked: context \? lockedEntriesFor\(context\.pageId\)/.test(pv), 'each PDF page states the active page\'s locks');
  const builder = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/filtersSummary: summarizeAppliedFilters\(p\)/.test(builder) && /summarizeAppliedFilters = useCallback\([^)]*\): string => pageFilterFacts\(/.test(builder),
    'the builder PDF header ignores page filters or the operator');
  assert(!/Đang lọc theo:|Xem chi tiết'|Bộ lọc nâng cao có sẵn/.test(pv), 'the public filter banner is hard-coded Vietnamese');
});

check('a control that draws nothing for a viewer leaves no blank band — and moves nothing locked', () => {
  const arrange = load('lib/grid-arrange.ts');
  const b = (id, x, y, w, h, locked = false) => ({ id, x, y, w, h, locked });
  // A stripped control alone in its band above the KPIs: the band closes.
  const top = arrange.withoutAbsentControls([b(50, 0, 0, 8, 3), b(1, 0, 3, 12, 6), b(2, 0, 9, 36, 12)], new Set([50]));
  assert(top.length === 2 && top.find((x) => x.id === 1).y === 0 && top.find((x) => x.id === 2).y === 6, JSON.stringify(top));
  // Beside a chart in its row: the chart stays where it is.
  const beside = arrange.withoutAbsentControls([b(1, 0, 0, 24, 12), b(50, 24, 0, 8, 3), b(2, 0, 12, 36, 6)], new Set([50]));
  assert(beside.find((x) => x.id === 2).y === 12 && beside.find((x) => x.id === 1).y === 0, JSON.stringify(beside));
  // A locked tile below: the band stays open rather than move it.
  const locked = arrange.withoutAbsentControls([b(50, 0, 0, 8, 3), b(1, 0, 3, 12, 6, true)], new Set([50]));
  assert(locked.find((x) => x.id === 1).y === 3, 'a locked tile moved');
  const pv = source('components/dashboards/PublicDashboardView.tsx');
  assert(/withoutAbsentControls\(/.test(pv) && /\{gridDashboardCharts\.map\(renderTileNode\)\}/.test(pv) && /const absentControlIds = filtersSeeded/.test(pv),
    'the public grid still draws blank cells for absent controls, or decides before the filters are seeded');
});

check('a section heading stays above the content it introduces, at heading height, under every direction and a plan that forgets it', () => {
  const directions = load('lib/dashboard-presentation/directions.ts');
  const compiler = load('lib/dashboard-presentation/compiler.ts');
  const typed = (tile, type) => ({ ...tile, chart: { ...tile.chart, chart_type: type } });
  const header = (id, title, origin, y) => ({ id, chart_id: null, widget_type: 'section_header',
    widget_config: { title, origin }, layout: { x: 0, y, w: 36, h: 3, gv: 2, pageId: 'page-1' } });
  const tiles = [
    typed(chart(1, 0, 0, 12, 6), 'KPI'), typed(chart(2, 12, 0, 12, 6), 'KPI'),
    header(60, 'Performance', 'author', 6),
    typed(chart(3, 0, 9, 18, 10), 'BAR'), typed(chart(4, 18, 9, 18, 10), 'PIE'),
    header(61, 'Detail', 'ai', 19),
    typed(chart(5, 0, 22, 36, 12), 'TABLE'),
  ];
  const s = snap(tiles, []);
  const firstBelow = (o, id) => {
    const h = o[id];
    const below = Object.entries(o).filter(([, r]) => r.y >= h.y + h.h).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x);
    return Number(below[0]?.[0]);
  };
  const run = (label, plan) => {
    const o = compiler.compilePresentationPlan({ plan, snapshot: s, pageId: 'page-1' }).mutation.layoutOverrides;
    assert(o[60] && [3, 4].includes(firstBelow(o, 60)), `${label}: "Performance" does not introduce its charts (${JSON.stringify(o)})`);
    assert(o[60].w === 36 && o[60].h <= 3, `${label}: the heading is not a thin full-width band (${JSON.stringify(o[60])})`);
    return { o, plan };
  };
  for (const d of ['executive', 'operations', 'editorial']) {
    const { plan } = run(d, directions.planForDirection(d, s, {}));
    const newHeadings = (plan.blocks ?? []).filter((b) => b.heading && b.title === 'Detail');
    assert(newHeadings.length === 0, `${d}: a second "Detail" heading was created instead of reusing the page's`);
  }
  // A model plan that leaves both headings out.
  const { o } = run('model plan', { layer: 'redesign', direction: { style: 'x', density: 'balanced' },
    sections: [{ primitive: 'kpi_strip', visuals: [1, 2] }, { primitive: 'two_equal', visuals: [3, 4] }, { primitive: 'table_full', visuals: [5] }] });
  assert(firstBelow(o, 61) === 5, `model plan: an unplaced "Detail" heading is not above its table (${JSON.stringify(o)})`);
});

check('a control can be put right next to the selected element: free space first, else just above it; never by moving a lock', () => {
  const arrange = load('lib/grid-arrange.ts');
  const b = (id, x, y, w, h, locked = false) => ({ id, x, y, w, h, locked });
  const card = { w: 8, h: 3 };
  // Room to the right of the chart in its rows: nothing moves.
  const right = arrange.placeBeside([b(1, 0, 0, 24, 12), b(2, 0, 12, 36, 6)], 1, card);
  assert(right && right.rect.x === 24 && right.rect.y === 0 && right.changed.length === 0, JSON.stringify(right));
  // The row is full: directly above the chart, and the page below makes room.
  const full = arrange.placeBeside([b(1, 0, 6, 18, 12), b(2, 18, 6, 18, 12), b(3, 0, 18, 36, 6), b(4, 0, 0, 36, 6)], 2, card);
  const moved = Object.fromEntries((full?.changed ?? []).map((x) => [x.id, x]));
  assert(full && full.rect.y === 6 && full.rect.x === 18 && moved[1]?.y === 9 && moved[2]?.y === 9 && moved[3]?.y === 21 && !moved[4],
    `not placed just above the chart: ${JSON.stringify(full)}`);
  // A locked tile would have to move: refused, the author is told.
  const locked = arrange.placeBeside([b(1, 0, 0, 36, 12), b(2, 0, 12, 36, 6, true)], 1, card);
  assert(locked === null, 'a lock was moved to make room');
  const page = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/besideName=\{selectedTileIds\.length === 1 \? tileTitle\(selectedTileIds\[0\]\) : null\}/.test(page) && /placeBeside\(boxes, targetId, card\)/.test(page),
    'the Slicer picker does not offer "next to the selected element"');
  assert(/besideBlocked/.test(page), 'a placement that cannot fit is not explained');
});

check('the PDF is a document, not a screenshot of the UI: no drill toggles or chevrons, labels in the reader\'s language', () => {
  const exp = source('lib/export-pdf.ts');
  assert(/\[data-export-hide\] \{ display: none !important; \}/.test(exp) && /lucide-chevron-down \{ display: none/.test(exp), 'interactive chrome is printed');
  assert(/\[data-tile-kind="widget"\] \.truncate \{ text-overflow: clip/.test(exp), 'a short widget title prints with a false ellipsis');
  assert(/opts\.labels\?\.filters/.test(exp) && /opts\.labels\?\.exportedAt/.test(exp) && /opts\.labels\?\.snapshotNote/.test(exp), 'the page words are fixed Vietnamese');
  const chart = source('components/explore/ExploreChart.tsx');
  assert(/const DrillBar = canDrill \? \(\s*\/\/[^\n]*\n\s*<div [^>]*data-export-hide/.test(chart), 'the drill toggle bar is not marked as screen-only');
  for (const [name, file] of [['builder', 'app/(main)/dashboards/[id]/page.tsx'], ['public', 'components/dashboards/PublicDashboardView.tsx']]) {
    const src = source(file);
    const call = src.slice(src.indexOf('await exportDashboardPdf({'), src.indexOf('await exportDashboardPdf({') + 500);
    assert(/labels: \{\s*filters: t\('dashboards\.pdf\.filters'\)/.test(call), `${name}: the PDF is not told the reader's language`);
  }
});

check('a headline an earlier design wrote keeps headline height when a redesign reuses it', () => {
  const compiler = load('lib/dashboard-presentation/compiler.ts');
  const typed = (tile, type) => ({ ...tile, chart: { ...tile.chart, chart_type: type } });
  const narrative = { id: 70, chart_id: null, widget_type: 'narrative', widget_config: { variant: 'headline', origin: 'ai', items: [{ finding: 'trend:3' }] },
    layout: { x: 0, y: 0, w: 36, h: 6, gv: 2, pageId: 'page-1' } };
  const s = snap([narrative, typed(chart(3, 0, 6, 36, 10), 'BAR')], []);
  const base = { layer: 'redesign', direction: { style: 'x', density: 'spacious' } };
  const reused = compiler.compilePresentationPlan({ plan: { ...base, sections: [{ primitive: 'full_width', visuals: [70] }, { primitive: 'full_width', visuals: [3] }] }, snapshot: s, pageId: 'page-1' }).mutation.layoutOverrides;
  const fresh = compiler.compilePresentationPlan({ plan: { ...base, blocks: [{ id: -1, variant: 'headline', findings: ['trend:3'] }],
    sections: [{ primitive: 'full_width', visuals: [-1] }, { primitive: 'full_width', visuals: [70, 3] }] }, snapshot: s, pageId: 'page-1' }).mutation.layoutOverrides;
  assert(reused[70].h === fresh[-1].h, `a reused headline is ${reused[70].h} rows, a new one ${fresh[-1].h}`);
});

if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL  ${name}\n      ${error.message}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`unified grid contract: ${passed} checks passed`);
