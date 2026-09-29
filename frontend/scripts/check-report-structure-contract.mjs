/**
 * Report structure & manual layout: the contract, checked on the real modules.
 *
 *   node scripts/check-report-structure-contract.mjs
 *
 * What it holds the code to (each check names the failure it prevents):
 *  - section membership is stored, not guessed: an explicit sectionId wins over
 *    position, `null` means no section, and only an unstated one (a legacy
 *    report) is inferred from where the tile sits;
 *  - moving a section header moves its whole section; a locked tile in the way
 *    refuses the move instead of being shoved;
 *  - an element added "after" the selection lands directly under it, joins its
 *    section, and the rows below move down, never an overlap;
 *  - the reading order used by phone, tablet and PDF keeps a heading with what
 *    it introduces, whatever the coordinates;
 *  - what a reader would find broken (an empty section, a member above its
 *    heading, an insight about another section's charts) is detected, and a
 *    clean page reports nothing;
 *  - layout patterns (equal row, KPI strip, lead + supporting) never overlap
 *    tiles, never move a locked one, and fill the span they claim;
 *  - emphasis is a closed vocabulary read the same way everywhere;
 *  - the builder and the public report consume the same structure, and every
 *    Inspector string exists in both languages.
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

const structure = load('lib/report-structure.ts');
const patterns = load('lib/report-patterns.ts');
const emphasis = load('lib/tile-emphasis.tsx');
const printBands = load('lib/print-bands.ts');
const exportLayout = load('lib/export-layout.ts');
const executor = load('lib/dashboard-presentation/executor.ts');
const snapshotMod = load('lib/dashboard-presentation/snapshot.ts');

const tile = (id, widget_type, x, y, w, h, layout = {}, widget_config = null) => ({ id, widget_type, widget_config, layout: { x, y, w, h, ...layout } });
const S = (tiles) => structure.toStructTiles(tiles);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function apply(page, changed) {
  const byId = new Map(page.map((b) => [b.id, { ...b }]));
  for (const c of changed) byId.set(c.id, { ...byId.get(c.id), ...c });
  return [...byId.values()];
}
function noOverlap(boxes) {
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    if (overlaps(boxes[i], boxes[j])) return `${boxes[i].id} overlaps ${boxes[j].id}`;
  }
  return null;
}

// A report: header, preamble KPI, section A (two charts), section B (one chart).
const REPORT = [
  tile(1, 'hero_strip', 0, 0, 36, 6),
  tile(2, 'chart', 0, 6, 12, 6),
  tile(10, 'section_header', 0, 12, 36, 3),
  tile(11, 'chart', 0, 15, 18, 8),
  tile(12, 'chart', 18, 15, 18, 8),
  tile(20, 'section_header', 0, 23, 36, 3),
  tile(21, 'chart', 0, 26, 36, 8),
];

check('legacy membership is inferred by position; the header and preamble belong to none', () => {
  const s = structure.resolveStructure(S(REPORT));
  assert(same(s.sections.map((x) => [x.headerId, x.members]), [[10, [11, 12]], [20, [21]]]), JSON.stringify(s.sections));
  assert(s.sectionOf.get(1) === null && s.sectionOf.get(2) === null, 'header / preamble joined a section');
});

check('a stated sectionId wins over position, and null means no section', () => {
  const tiles = REPORT.map((t) => (t.id === 21 ? { ...t, layout: { ...t.layout, sectionId: 10 } }
    : t.id === 12 ? { ...t, layout: { ...t.layout, sectionId: null } } : t));
  const s = structure.resolveStructure(S(tiles));
  assert(s.sectionOf.get(21) === 10, 'the stated section was overridden by position');
  assert(s.sectionOf.get(12) === null, 'an explicit "no section" was re-inferred');
  // A dangling reference (the header was deleted) falls back to position, never to a ghost.
  const dangling = structure.resolveStructure(S(REPORT.map((t) => (t.id === 11 ? { ...t, layout: { ...t.layout, sectionId: 999 } } : t))));
  assert(dangling.sectionOf.get(11) === 10, 'a dangling sectionId was kept');
});

check('moving a section header moves its members with it; nothing overlaps', () => {
  const tiles = S(REPORT);
  const moved = structure.moveSection(tiles, 20, { x: 0, y: 6 });
  assert(Array.isArray(moved) && moved.length > 0, 'the section did not move');
  const after = apply(tiles, moved);
  const byId = new Map(after.map((b) => [b.id, b]));
  assert(byId.get(20).y === 6 && byId.get(21).y === 9, `members did not follow: ${byId.get(20).y}/${byId.get(21).y}`);
  assert(byId.get(10).y >= 12 && byId.get(11).y > byId.get(10).y, 'the section it was dropped on was not pushed down whole');
  const bad = noOverlap(after);
  assert(!bad, bad);
  // Reading order still keeps each heading with its own members.
  const order = structure.readingOrder(after);
  assert(order.indexOf(21) === order.indexOf(20) + 1, 'a member left its heading in reading order');
});

check('a locked tile in the way refuses a section move instead of being shoved', () => {
  const tiles = S(REPORT.map((t) => (t.id === 2 ? { ...t, layout: { ...t.layout, locked: true } } : t)));
  const moved = structure.moveSection(tiles, 20, { x: 0, y: 6 });
  assert(moved === null, 'a locked tile would have been moved');
});

check('an element added after the selection lands under it, joins its section, pushes rows down', () => {
  const tiles = S(REPORT);
  const spot = structure.insertionFor(tiles, 11, { w: 18, h: 6 });
  assert(spot && spot.rect.y === 23 && spot.rect.x === 0, `not directly under the selection: ${JSON.stringify(spot?.rect)}`);
  assert(spot.sectionId === 10, `joined ${spot.sectionId}, not the selection's section`);
  const after = apply(tiles, spot.changed).concat([{ id: -1, ...spot.rect }]);
  const bad = noOverlap(after);
  assert(!bad, bad);
  assert(after.find((b) => b.id === 20).y >= 29, 'the next section was not pushed below the insert');
  const end = structure.insertionFor(tiles, null, { w: 12, h: 4 });
  assert(end.rect.y === 34 && end.sectionId === null && end.changed.length === 0, 'without a selection it is not the end of the page');
  const underHeader = structure.insertionFor(tiles, 20, { w: 12, h: 4 });
  assert(underHeader.sectionId === 20 && underHeader.rect.y === 26, 'under a heading it is not the start of that section');
});

check('reading order keeps a heading with its members whatever the coordinates', () => {
  // Section B's member is stated into A although it sits lower.
  const tiles = S(REPORT.map((t) => (t.id === 21 ? { ...t, layout: { ...t.layout, sectionId: 10 } } : t)));
  const order = structure.readingOrder(tiles);
  const a = order.indexOf(10);
  assert(order.slice(a, a + 4).join(',') === '10,11,12,21', `section A not contiguous: ${order}`);
  assert(order.indexOf(1) === 0 && order.indexOf(2) === 1, 'the header and preamble do not lead');
});

check('what a reader would find broken is detected; a clean page reports nothing', () => {
  assert(structure.structureIssues(S(REPORT)).length === 0, 'a clean report reported issues');
  const empty = S([...REPORT.filter((t) => t.id !== 21)]);
  assert(structure.structureIssues(empty).some((i) => i.kind === 'empty_section' && i.headerId === 20), 'empty section missed');
  const above = S(REPORT.map((t) => (t.id === 2 ? { ...t, layout: { ...t.layout, sectionId: 20 } } : t)));
  assert(structure.structureIssues(above).some((i) => i.kind === 'member_above_heading' && i.tileId === 2), 'member above heading missed');
  const narrative = tile(30, 'narrative', 0, 34, 18, 6, { sectionId: 20 }, { items: [{ finding: 'trend:11' }, { finding: 'top:12' }] });
  const detached = structure.structureIssues(S([...REPORT, narrative]));
  assert(detached.some((i) => i.kind === 'narrative_detached' && i.tileId === 30 && i.citedSection === 10), 'detached insight missed');
  const attached = structure.structureIssues(S([...REPORT, { ...narrative, layout: { ...narrative.layout, sectionId: 10, y: 23 } }]));
  assert(!attached.some((i) => i.kind === 'narrative_detached'), 'an insight in the section of its own charts was flagged');
});

const PAGE = [
  { id: 1, x: 0, y: 0, w: 10, h: 6 },
  { id: 2, x: 12, y: 0, w: 8, h: 8 },
  { id: 3, x: 22, y: 2, w: 14, h: 5 },
  { id: 4, x: 0, y: 10, w: 36, h: 6 },
];

check('equal row: equal widths across the span, one height, nothing overlaps', () => {
  const r = patterns.applyLayoutPattern('equalRow', PAGE, [1, 2, 3]);
  assert(r.status === 'ok', `status ${r.status}`);
  const after = apply(PAGE, r.moved);
  const row = after.filter((b) => [1, 2, 3].includes(b.id)).sort((a, b) => a.x - b.x);
  assert(row.every((b) => b.y === 0 && b.h === 8), `not one row of the tallest height: ${JSON.stringify(row)}`);
  assert(row[0].x === 0 && row[2].x + row[2].w === 36, 'the span was not kept');
  assert(Math.max(...row.map((b) => b.w)) - Math.min(...row.map((b) => b.w)) <= 1, 'widths are not equal');
  const bad = noOverlap(after);
  assert(!bad, bad);
});

check('KPI strip takes the shortest height; lead + supporting is two thirds and a stacked column', () => {
  const k = patterns.applyLayoutPattern('kpiStrip', PAGE, [1, 2, 3]);
  const strip = apply(PAGE, k.moved).filter((b) => [1, 2, 3].includes(b.id));
  assert(strip.every((b) => b.h === 5), `not the shortest height: ${strip.map((b) => b.h)}`);
  const l = patterns.applyLayoutPattern('leadSupport', PAGE, [1, 2, 3], { leadId: 2 });
  assert(l.status === 'ok', `status ${l.status}`);
  const after = apply(PAGE, l.moved);
  const lead = after.find((b) => b.id === 2);
  const side = after.filter((b) => b.id === 1 || b.id === 3).sort((a, b) => a.y - b.y);
  assert(lead.x === 0 && lead.w === 24, `lead is not two thirds: ${JSON.stringify(lead)}`);
  assert(side.every((b) => b.x === 24 && b.w === 12), 'supporting tiles are not in one column beside the lead');
  assert(side[0].y + side[0].h === side[1].y && side[1].y + side[1].h === lead.y + lead.h, 'the column does not match the lead height');
  const bad = noOverlap(after);
  assert(!bad, bad);
  const pushed = after.find((b) => b.id === 4);
  assert(pushed.y >= lead.y + lead.h, 'the row below was not moved down to make room');
});

check('a pattern never moves a locked tile, and moves nothing unselected except down to make room', () => {
  const locked = PAGE.map((b) => (b.id === 3 ? { ...b, locked: true } : b));
  const r = patterns.applyLayoutPattern('equalRow', locked, [1, 2, 3]);
  assert(r.status === 'blocked' && r.blockedBy === 3, 'a locked selected tile was moved');
  const lockedBelow = PAGE.map((b) => (b.id === 4 ? { ...b, locked: true } : b));
  const tall = patterns.applyLayoutPattern('leadSupport', lockedBelow, [1, 2, 3], { leadId: 1 });
  assert(tall.status === 'blocked' ? tall.blockedBy === 4 : !tall.moved.some((b) => b.id === 4), 'a locked unselected tile was pushed');
  const r3 = patterns.applyLayoutPattern('equalRow', PAGE, [1, 2]);
  assert(r3.status === 'ok', `status ${r3.status}`);
  for (const b of r3.moved.filter((m) => ![1, 2].includes(m.id))) {
    const was = PAGE.find((p) => p.id === b.id);
    assert(b.x === was.x && b.w === was.w && b.h === was.h && b.y > was.y, `an unselected tile changed other than moving down: ${b.id}`);
  }
  assert(patterns.applyLayoutPattern('equalRow', PAGE, [1]).status === 'noop', 'one tile is not a pattern');
});

check('paper keeps an arrangement whole: a hero with a rail is one band, a heading stays with its section', () => {
  const tiles = [
    { id: 1, x: 0, y: 0, w: 36, h: 3, kind: 'section_header' },
    { id: 2, x: 0, y: 3, w: 24, h: 14, kind: 'chart' },
    { id: 3, x: 24, y: 3, w: 12, h: 7, kind: 'chart' },
    { id: 4, x: 24, y: 10, w: 12, h: 7, kind: 'chart' },
    { id: 5, x: 6, y: 17, w: 12, h: 6, kind: 'chart' },
  ];
  const bands = printBands.groupIntoPrintBands(tiles);
  assert(same(bands.map((b) => b.tiles.map((t) => t.id)), [[1], [2, 3, 4], [5]]), `bands: ${JSON.stringify(bands.map((b) => b.tiles.map((t) => t.id)))}`);
  assert(bands[1].rows === 14 && bands[1].top === 3, 'the rail band does not span the lead');
  assert(bands[0].keepWithNext && !bands[1].keepWithNext, 'a heading is not kept with its section');
  const src = source('components/dashboards/PublicDashboardView.tsx');
  assert(/groupIntoPrintBands\(/.test(src) && !/function groupTilesIntoRows/.test(src), 'print mode still cuts rows by identical y');
  assert(/left: `calc\(\$\{\(tile\.x \/ DASHBOARD_GRID_COLS\)/.test(src), 'a printed tile loses its column');
});

check('an arranged PDF includes the report elements, never the interactive controls', () => {
  assert(exportLayout.planKeyForElement(42) === -42 && exportLayout.planKeyForElement(-42) === -42, 'element keys can collide with chart ids');
  for (const k of ['hero_strip', 'section_header', 'text', 'callout', 'narrative']) assert(exportLayout.PRINTABLE_ELEMENT_TYPES.has(k), `${k} is not printable`);
  for (const k of ['slicer', 'parameter_switcher']) assert(!exportLayout.PRINTABLE_ELEMENT_TYPES.has(k), `${k} would print`);
  const pdf = source('lib/export-pdf.ts');
  assert(/planKeyForElement\(Number\(el\.getAttribute\('data-tile-id'\)\)\)/.test(pdf), 'the exporter does not find report elements on the page');
  assert(/PRINTABLE_ELEMENT_TYPES\.has/.test(source('components/dashboards/PublicDashboardView.tsx')), 'the arranger is offered charts only');
});

check('an AI redesign states the membership of what it moves, including under a heading it creates', () => {
  const spec = [[101, 'KPI'], [102, 'KPI'], [103, 'KPI'], [107, 'BAR'], [108, 'TABLE']];
  const tiles = spec.map(([id, type], i) => ({
    id, chart_id: 900 + i, widget_type: 'chart', parameters: null,
    // 107 was stated into a section that no longer exists by an earlier manual edit.
    layout: { x: (i % 3) * 12, y: Math.floor(i / 3) * 6, w: 12, h: 6, gv: 2, pageId: 'page-1', ...(id === 107 ? { sectionId: 999 } : {}) },
    chart: { id: 900 + i, name: `T${id}`, chart_type: type, dataset_id: 1, config: { dimensions: ['d'], measures: ['m'], agg: 'SUM' } },
  }));
  const snapshot = snapshotMod.buildPresentationSnapshot({
    dashboard: { name: 'F', theme_config: {}, dashboard_charts: tiles }, tiles, pageId: 'page-1', pageName: 'P', pageCount: 1, slicers: [], slicerDock: 'top',
  });
  assert(snapshot.visuals.find((v) => v.dashboardChartId === 107).sectionId === 999, 'the snapshot hides stated membership from the planner');
  const built = executor.buildPresentationMutation({
    plan: {
      layer: 'redesign', direction: { style: 'executive', density: 'balanced' },
      blocks: [{ id: -1, variant: 'chapter', heading: true, title: 'Detail', findings: [] }],
      sections: [{ primitive: 'kpi_strip', visuals: [101, 102, 103] }, { primitive: 'full_width', visuals: [-1] }, { primitive: 'two_equal', visuals: [107, 108] }],
    },
    snapshot, tiles, pageId: 'page-1', currentTheme: {}, targets: [],
  });
  assert(built.ok, `refused: ${JSON.stringify(built.mutationValidation?.violations ?? built.planValidation?.violations)}`);
  const heading = (built.mutation.createdBlocks ?? []).find((b) => b.tempId === -1);
  assert(heading && heading.widgetType === 'section_header', 'the heading block was not created as a section header');
  const o = built.mutation.layoutOverrides;
  assert(o[107]?.sectionId === -1 && o[108]?.sectionId === -1, `charts under the new heading: ${o[107]?.sectionId}/${o[108]?.sectionId}`);
  assert([101, 102, 103].every((id) => o[id] == null || o[id].sectionId === undefined || o[id].sectionId === null), 'the preamble joined a section');
  const src = source('app/(main)/dashboards/[id]/page.tsx');
  assert(/realIdOf\.set\(block\.tempId, fresh\.id\)/.test(src) && /sectionId: swap\(s\)/.test(src), 'a created heading is never swapped for its real id');
});

check('a pattern never leaves a hole where the selection came from; a narrow stack takes the page width', () => {
  const stack = [
    { id: 1, x: 0, y: 0, w: 12, h: 6 }, { id: 2, x: 0, y: 6, w: 12, h: 6 }, { id: 3, x: 0, y: 12, w: 12, h: 6 },
    { id: 4, x: 0, y: 18, w: 36, h: 6 },
  ];
  const r = patterns.applyLayoutPattern('equalRow', stack, [1, 2, 3]);
  assert(r.status === 'ok', `status ${r.status}`);
  const after = apply(stack, r.moved);
  const row = after.filter((b) => b.id <= 3);
  assert(row.every((b) => b.y === 0 && b.w === 12), `the stack did not become a page-wide row: ${JSON.stringify(row)}`);
  assert(after.find((b) => b.id === 4).y === 6, `the rows the stack left are still empty: tile 4 at ${after.find((b) => b.id === 4).y}`);
  const bad = noOverlap(after);
  assert(!bad, bad);
  // A locked tile below keeps the hole open rather than move.
  const locked = stack.map((b) => (b.id === 4 ? { ...b, locked: true } : b));
  const kept = apply(locked, patterns.applyLayoutPattern('equalRow', locked, [1, 2, 3]).moved);
  assert(kept.find((b) => b.id === 4).y === 18, 'a locked tile was moved to close a gap');
});

check('the PDF prints in the reader language: no Vietnamese literal outside the exporter text table', () => {
  const src = source('lib/export-pdf.ts').replace(/\r\n/g, '\n');
  const start = src.indexOf('const PDF_TEXT = {');
  const end = src.indexOf('type PdfText = typeof PDF_TEXT.vi;');
  assert(start > 0 && end > start, 'the exporter has no text table');
  const outside = (src.slice(0, start) + src.slice(end))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const literals = [...outside.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
  const vietnamese = literals.filter((s) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s));
  assert(vietnamese.length === 0, `hardcoded: ${vietnamese.slice(0, 3).join(' | ')}`);
  const table = src.slice(start, end);
  assert(/\n  en: \{/.test(table) && /pDoneSaved/.test(table.split('\n  en: {')[1] ?? ''), 'no English text for the exporter');
  for (const f of ['app/(main)/dashboards/[id]/page.tsx', 'components/dashboards/PublicDashboardView.tsx']) {
    assert(/exportDashboardPdf\(\{[\s\S]{0,200}locale,/.test(source(f)), `${f} does not pass the reader locale`);
  }
});

check('emphasis is a closed vocabulary', () => {
  assert(emphasis.emphasisOf({ emphasis: 'lead' }) === 'lead' && emphasis.emphasisOf({ emphasis: 'quiet' }) === 'quiet', 'known values lost');
  assert(emphasis.emphasisOf({ emphasis: 'LOUD' }) === 'normal' && emphasis.emphasisOf(null) === 'normal', 'an unknown value was kept');
  assert(emphasis.EMPHASIS_SCALE.lead > 1 && emphasis.EMPHASIS_SCALE.quiet < 1 && emphasis.EMPHASIS_SCALE.normal === 1, 'scale is not ordered');
});

check('builder, public and bands consume the same structure; emphasis reaches both tile renderers', () => {
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  const grid = source('components/dashboards/DashboardGrid.tsx');
  const bands = source('components/dashboards/SectionBands.tsx');
  assert(/readingOrder\(/.test(pub) && /readingOrder\(/.test(grid), 'a narrow projection sorts by coordinates, not structure');
  assert(/resolveStructure\(/.test(bands), 'section bands infer their own membership');
  assert(/ReportMetaProvider/.test(pub) && /ReportMetaProvider/.test(source('app/(main)/dashboards/[id]/page.tsx')),
    'the report header would state different context on builder and public');
  for (const f of ['components/dashboards/ChartTile.tsx', 'components/dashboards/ReadonlyChartTile.tsx']) {
    const s = source(f);
    assert(/emphasisOf\(/.test(s) && /TileEmphasisProvider/.test(s) && /data-emphasis=/.test(s), `${f} ignores emphasis`);
  }
  assert(/useTileEmphasis\(\)/.test(source('components/visualizations/KpiCard.tsx')), 'the KPI figure ignores emphasis');
});

check('every Inspector and Add-palette string exists in English and Vietnamese', () => {
  const cat = source('i18n/catalog/dashboards-detail.ts').replace(/\r\n/g, '\n');
  const [en, vi] = cat.split(/\n  vi: \{/);
  const keys = (block) => new Set([...block.matchAll(/'(dashboards\.(?:inspector|addElement)\.[^']+)'/g)].map((m) => m[1]));
  const e = keys(en); const v = keys(vi);
  const missing = [...e].filter((k) => !v.has(k)).concat([...v].filter((k) => !e.has(k)));
  assert(e.size > 20 && missing.length === 0, `missing: ${missing.join(', ')}`);
  const used = new Set([...source('components/dashboards/ReportInspector.tsx').matchAll(/t\('(dashboards\.inspector\.[^']+)'/g)].map((m) => m[1]));
  const undefinedKeys = [...used].filter((k) => !e.has(k));
  assert(used.size > 10 && undefinedKeys.length === 0, `used but not defined: ${undefinedKeys.join(', ')}`);
});

if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL  ${name}\n      ${error.message}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`report structure contract: ${passed} checks passed`);
