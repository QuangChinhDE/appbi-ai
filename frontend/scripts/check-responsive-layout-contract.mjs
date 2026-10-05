#!/usr/bin/env node
/**
 * Responsive layout contract — the ONE resolver (lib/responsive-layout/resolve.ts)
 * every report surface draws with.
 *
 *  - AUTO = the published behaviour before authored device layouts: the resolver
 *    reproduces the golden vectors captured from the old public pipeline
 *    (scripts/fixtures/responsive-auto-vectors.json) at 1440/1024/1023/820/640/
 *    639/390, with and without measured content.
 *  - CUSTOM is drawn exactly as stored (36 columns), never content-fitted;
 *    a changed tile set reconciles deterministically (dropped / orphans below);
 *    a changed desktop marks it stale without touching it.
 *  - Breakpoints are decided by the measured container width: 639|640, 1023|1024.
 *  - Surfaces draw through the resolver and measure ONE width.
 *
 *   node scripts/check-responsive-layout-contract.mjs
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
const source = (relative) => readFileSync(resolve(SRC, relative), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const R = load('lib/responsive-layout/resolve.ts');
const pages = load('lib/dashboard-pages.ts');
const golden = JSON.parse(readFileSync(resolve(HERE, 'fixtures', 'responsive-auto-vectors.json'), 'utf8'));

const normalise = (tiles) => pages.normalizeDashboardGridForRender({ dashboard_charts: tiles }).dashboard_charts;
const cells = (layout) => layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function noOverlap(layout) {
  for (let a = 0; a < layout.length; a += 1) for (let b = a + 1; b < layout.length; b += 1) {
    assert(!overlaps(layout[a], layout[b]), `tiles ${layout[a].i} and ${layout[b].i} overlap`);
  }
}
const resolveAt = (tiles, width, extra = {}) => R.resolveReportLayout({ tiles: normalise(tiles), containerWidth: width, gap: 16, ...extra });

// ── AUTO: byte-for-byte the published behaviour ──────────────────────────────

check('AUTO reproduces every golden vector of the old public pipeline (desktop, tablet, phone; fit and no fit)', () => {
  const bad = [];
  for (const v of golden.vectors) {
    const got = R.resolveReportLayout({
      tiles: normalise(golden.fixtures[v.fixture]),
      containerWidth: v.width,
      gap: v.gap,
      measuredRows: golden.measures[v.measured],
    });
    const actual = { breakpoint: got.breakpoint, cols: got.cols, layout: cells(got.layout) };
    if (!same(actual, v.expected)) bad.push(`${v.fixture}@${v.width} gap ${v.gap} ${v.measured}`);
  }
  assert(golden.vectors.length >= 140, `only ${golden.vectors.length} vectors`);
  assert(bad.length === 0, `AUTO differs from the published layout for ${bad.length} vectors: ${bad.slice(0, 6).join('; ')}`);
});

check('breakpoints are decided by the container width: 639→phone 640→tablet 1023→tablet 1024→desktop', () => {
  const tiles = golden.fixtures.presentation;
  const at = (w) => resolveAt(tiles, w).breakpoint;
  assert(at(639) === 'xs' && at(640) === 'md' && at(1023) === 'md' && at(1024) === 'lg' && at(390) === 'xs' && at(1440) === 'lg',
    `edges: 639=${at(639)} 640=${at(640)} 1023=${at(1023)} 1024=${at(1024)}`);
  assert(resolveAt(tiles, 0).breakpoint === 'lg' && resolveAt(tiles, null).breakpoint === 'lg', 'an unmeasured width is desktop');
});

// ── CUSTOM: drawn as stored ─────────────────────────────────────────────────

const fixture = golden.fixtures.presentation;
const tabletAuto = resolveAt(fixture, 820);
const phoneAuto = resolveAt(fixture, 390);

check('Customize freezes exactly what the device shows: the custom layout resolves to the same cells (no jump)', () => {
  const md = R.freezeLayout(tabletAuto, { source: 'auto-freeze' });
  const gotMd = resolveAt(fixture, 820, { profiles: { md } });
  assert(gotMd.source === 'custom' && gotMd.cols === 36, 'tablet custom is drawn in 36 columns');
  assert(same(cells(gotMd.layout).sort((a, b) => a.i.localeCompare(b.i)), cells(tabletAuto.layout).sort((a, b) => a.i.localeCompare(b.i))), 'tablet freeze moved tiles');
  const xs = R.freezeLayout(phoneAuto, { source: 'auto-freeze' });
  const gotXs = resolveAt(fixture, 390, { profiles: { xs } });
  const scaled = phoneAuto.layout.map((c) => ({ i: c.i, x: c.x * 18, y: c.y, w: c.w * 18, h: c.h })).sort((a, b) => a.i.localeCompare(b.i));
  assert(same(cells(gotXs.layout).sort((a, b) => a.i.localeCompare(b.i)), scaled), 'phone freeze is the 2-column stack ×18, exactly');
  assert(gotXs.orphans.length === 0 && gotXs.dropped.length === 0 && !gotXs.stale, 'a fresh freeze is complete and current');
  assert(Object.keys(md.items).length === fixture.length, 'a freeze places every tile of the page');
});

const moved = (() => {
  const md = R.freezeLayout(tabletAuto, { source: 'auto-freeze' });
  return R.withCells(md, [{ i: '6', x: 0, y: 200, w: 10, h: 9 }, { i: '7', x: 10, y: 200, w: 26, h: 9 }]);
})();

check('a CUSTOM layout is drawn exactly as stored, never content-fitted', () => {
  const plain = resolveAt(fixture, 820, { profiles: { md: moved } });
  const measured = resolveAt(fixture, 820, { profiles: { md: moved }, measuredRows: { 2: 30, 3: 30, 1: 25, 6: 40 } });
  assert(same(cells(plain.layout), cells(measured.layout)), 'measured content changed a custom layout');
  assert(!plain.fitsContent && plain.source === 'custom', 'custom must not feed content measurement');
  const six = plain.layout.find((c) => c.i === '6');
  assert(six && six.x === 0 && six.y === 200 && six.w === 10 && six.h === 9, 'stored cell not drawn as stored');
});

check('Desktop ignores device layouts', () => {
  const d = resolveAt(fixture, 1440, { profiles: { md: moved, xs: R.freezeLayout(phoneAuto, { source: 'auto-freeze' }) } });
  assert(d.source === 'desktop' && same(d, resolveAt(fixture, 1440)), 'a device layout touched desktop');
});

check('a tablet layout never affects the phone and vice versa', () => {
  const phoneWithTablet = resolveAt(fixture, 390, { profiles: { md: moved } });
  assert(same(phoneWithTablet, phoneAuto), 'a tablet custom changed the phone');
  const xs = R.freezeLayout(phoneAuto, { source: 'auto-freeze' });
  const tabletWithPhone = resolveAt(fixture, 820, { profiles: { xs } });
  assert(same(tabletWithPhone, tabletAuto), 'a phone custom changed the tablet');
});

check('a changed desktop marks the CUSTOM layout stale and leaves it exactly as it is', () => {
  const desktopMoved = fixture.map((t) => (t.id === 6 ? { ...t, layout: { ...t.layout, w: 20 } } : t));
  const before = resolveAt(fixture, 820, { profiles: { md: moved } });
  const after = resolveAt(desktopMoved, 820, { profiles: { md: moved } });
  assert(after.stale && !before.stale, 'staleness not reported');
  assert(same(cells(after.layout), cells(before.layout)), 'desktop geometry leaked into a custom layout');
  // AUTO follows desktop.
  const autoAfter = resolveAt(desktopMoved, 820).layout.find((c) => c.i === '6');
  assert(autoAfter && autoAfter.w === 20, `AUTO did not follow the desktop change (w=${autoAfter?.w})`);
});

check('a new tile is never omitted: placed below the custom layout, in reading order, overlapping nothing; existing cells unchanged', () => {
  const extra = [...fixture,
    { id: 90, chart_id: 2000, widget_type: 'chart', chart: { chart_type: 'BAR' }, layout: { x: 0, y: 60, w: 18, h: 10, gv: 2 } },
    { id: 91, chart_id: 2000, widget_type: 'chart', chart: { chart_type: 'BAR' }, layout: { x: 18, y: 60, w: 18, h: 10, gv: 2 } }];
  const got = resolveAt(extra, 820, { profiles: { md: moved } });
  assert(same(got.orphans, ['90', '91']), `orphans: ${got.orphans}`);
  const bottom = Math.max(...Object.values(moved.items).map((c) => c.y + c.h));
  for (const id of ['90', '91']) {
    const c = got.layout.find((x) => x.i === id);
    assert(c && c.y >= bottom, `orphan ${id} not below the custom layout`);
  }
  for (const [id, c] of Object.entries(moved.items)) {
    const drawn = got.layout.find((x) => x.i === id);
    assert(drawn && drawn.x === c.x && drawn.y === c.y && drawn.w === c.w && drawn.h === c.h, `existing tile ${id} moved`);
  }
  noOverlap(got.layout);
  assert(got.layout.length === extra.length, 'a tile is missing');
  // Same placement on the phone grid (2-column generator ×18).
  const xs = R.freezeLayout(phoneAuto, { source: 'auto-freeze' });
  const gotXs = resolveAt(extra, 390, { profiles: { xs } });
  assert(same(gotXs.orphans, ['90', '91']) && gotXs.layout.every((c) => c.x + c.w <= 36), 'phone orphans not placed in the 36-column grid');
  noOverlap(gotXs.layout);
});

check('a removed tile is dropped: reported, nothing else moves, no ghost', () => {
  const fewer = fixture.filter((t) => t.id !== 7);
  const got = resolveAt(fewer, 820, { profiles: { md: moved } });
  assert(same(got.dropped, ['7']) && !got.layout.some((c) => c.i === '7'), 'removed tile still drawn');
  for (const c of got.layout) {
    const stored = moved.items[c.i];
    assert(stored && stored.y === c.y && stored.x === c.x, `tile ${c.i} reflowed after a removal`);
  }
});

check('the same chart twice is two tiles: layouts are keyed by tile id, never chart id', () => {
  // Tiles 8 and 9 both show chart 1100.
  const md = R.freezeLayout(tabletAuto, { source: 'auto-freeze' });
  assert(md.items['8'] && md.items['9'] && !same(md.items['8'], md.items['9']), 'twin tiles collapsed');
  const swapped = R.withCells(md, [{ i: '8', x: 18, y: 0, w: 18, h: 12 }]);
  const got = resolveAt(fixture, 820, { profiles: { md: swapped } });
  const eight = got.layout.find((c) => c.i === '8');
  const nine = got.layout.find((c) => c.i === '9');
  assert(eight.x === 18 && nine && nine.x === md.items['9'].x, 'moving one twin moved the other');
});

check('a control absent for this viewer closes its band in a custom layout too (no blank card)', () => {
  const tiles = golden.fixtures.slicers_and_text;
  const md = R.freezeLayout(resolveAt(tiles, 820), { source: 'auto-freeze' });
  const withAbsent = resolveAt(tiles, 820, { profiles: { md }, absentIds: new Set([30, 31, 32]) });
  assert(!withAbsent.layout.some((c) => ['30', '31', '32'].includes(c.i)), 'absent control drawn');
  assert(withAbsent.orphans.length === 0, 'an absent control is not an orphan');
  noOverlap(withAbsent.layout);
});

check('pages are independent: overlayProfiles layers one page/breakpoint, reset returns it to AUTO', () => {
  const md = R.freezeLayout(tabletAuto, { source: 'auto-freeze' });
  const published = { md, xs: null };
  assert(R.overlayProfiles(published, { md: { mode: 'auto' } }).md === null, 'reset marker must clear the custom layout');
  assert(R.overlayProfiles(published, { xs: md }).md === md, 'a phone draft touched the tablet');
});

check('the server rules: overlap, out-of-grid, non-integer cells are reported', () => {
  const md = R.freezeLayout(tabletAuto, { source: 'auto-freeze' });
  assert(R.customLayoutProblems(md).length === 0, `a fresh freeze has problems: ${R.customLayoutProblems(md)}`);
  const bad = R.withCells(md, [{ i: '2', x: 30, y: 0, w: 10, h: 5 }]);
  assert(R.customLayoutProblems(bad).some((p) => /outside the grid|overlap/.test(p)), 'out-of-grid not reported');
  const ov = { ...md, items: { ...md.items, 3: { ...md.items['2'] } } };
  assert(R.customLayoutProblems(ov).some((p) => /overlap/.test(p)), 'overlap not reported');
});

check('deterministic: the same inputs give byte-identical output', () => {
  const a = JSON.stringify(resolveAt(fixture, 820, { profiles: { md: moved }, measuredRows: { 2: 9 } }));
  const b = JSON.stringify(resolveAt(fixture, 820, { profiles: { md: moved }, measuredRows: { 2: 9 } }));
  assert(a === b, 'non-deterministic output');
  assert(R.desktopFingerprint(normalise(fixture)) === R.desktopFingerprint(normalise([...fixture].reverse())), 'fingerprint depends on tile order');
});

// ── surfaces draw through the resolver and measure one width ────────────────

check('PublicDashboardView draws the resolver output with ONE width (no responsive grid deriving its own breakpoint)', () => {
  const src = source('components/dashboards/PublicDashboardView.tsx');
  assert(/resolveReportLayout\(/.test(src), 'public view does not use the resolver');
  assert(!/buildResponsiveReportLayouts|deriveTabletLayout|deriveStackedLayout|fitLayoutToContent\(/.test(src), 'public view derives a device layout itself');
  assert(!/WidthProvider\(Responsive\)/.test(src), 'a responsive grid measures its own width and picks its own breakpoint');
});

check('DashboardGrid (Builder + Studio) draws the resolver output', () => {
  const src = source('components/dashboards/DashboardGrid.tsx');
  assert(/resolveReportLayout\(/.test(src), 'builder grid does not use the resolver');
  assert(!/deriveTabletLayout\(|deriveStackedLayout\(|fitLayoutToContent\(/.test(src), 'builder grid derives a device layout itself');
});

check('a hidden container (width 0) never unmounts the grid or reads as a phone', () => {
  for (const file of ['components/dashboards/DashboardGrid.tsx', 'components/dashboards/PublicDashboardView.tsx']) {
    const src = source(file);
    const observer = src.slice(src.indexOf('new ResizeObserver('), src.indexOf('.observe(', src.indexOf('new ResizeObserver(')));
    assert(/if \(w <= 0\) return;|contentWidth > 0/.test(observer), `${file}: a 0 width replaces the last real width`);
  }
});

check('content measurement takes the width it is given (no second width read)', () => {
  const src = source('lib/responsive-fit.ts');
  assert(!/clientWidth/.test(src), 'useMeasuredContentRows reads its own width');
});

check('PDF / print draws the DESKTOP layout, whatever the worker viewport or the device layouts', () => {
  const src = source('components/dashboards/PublicDashboardView.tsx');
  const print = src.slice(src.indexOf('const printBands = printMode'), src.indexOf('if (printMode) {'));
  assert(/groupIntoPrintBands\(visibleDashboardCharts\.map\(/.test(print) && /dc\.layout\?\.x/.test(print),
    'print bands are not built from the authored desktop layout');
  assert(!/resolvedLayout|resolveReportLayout/.test(print), 'print bands read the responsive resolution');
});

check('a CUSTOM device layout measures nothing on either surface (no content fit runs)', () => {
  const grid = source('components/dashboards/DashboardGrid.tsx');
  const pub = source('components/dashboards/PublicDashboardView.tsx');
  assert(/enabled: gridWidth > 0 && expectedBreakpoint !== 'lg' && !expectedCustom/.test(grid), 'the builder measures content for a custom layout');
  assert(/fitBreakpoint !== 'lg' && !fitIsCustom/.test(pub), 'the public report measures content for a custom layout');
});

check('the Studio preview refuses every write at the API client', () => {
  const api = source('lib/api-client.ts');
  assert(/export function isStudioPreviewWrite\(/.test(api) && /if \(isStudioPreviewWrite\(config\.method, config\.url\)\)/.test(api),
    'the Studio preview write guard is not installed on the API client');
  const preview = isStudioPreviewWriteUnderTest();
  assert(preview('put', '/dashboards/1/draft-layout') && preview('post', '/dashboards/1/publish') && preview('delete', '/charts/1'),
    'a Studio preview write was let through');
  assert(!preview('get', '/dashboards/1') && !preview('post', '/charts/preview-data'), 'a Studio preview read was refused');
});

check('the device mode is never part of chart query or cache identity', () => {
  for (const f of ['hooks/use-charts.ts', 'lib/api/charts.ts']) {
    assert(!/deviceMode|breakpoint|responsive/i.test(source(f)), `${f} keys chart data by device`);
  }
});

function isStudioPreviewWriteUnderTest() {
  // Evaluate the real function with a window in preview mode.
  const saved = globalThis.window;
  globalThis.window = { location: { search: '?studio=preview' } };
  try {
    const api = loadModule(resolve(SRC, 'lib/api-client.ts'));
    return (m, u) => { globalThis.window = { location: { search: '?studio=preview' } }; try { return api.isStudioPreviewWrite(m, u); } finally { globalThis.window = saved; } };
  } finally {
    globalThis.window = saved;
  }
}

// ── scale (reported; a pathological result fails) ──────────────────────────

check('resolver scales: 50 / 200 / 500 tiles', () => {
  const report = [];
  for (const n of [50, 200, 500]) {
    const tiles = Array.from({ length: n }, (_, k) => ({
      id: k + 1, chart_id: 5000 + (k % 7), widget_type: k % 9 === 0 ? 'text' : 'chart',
      chart: { chart_type: ['KPI', 'BAR', 'TABLE', 'LINE'][k % 4] },
      layout: { x: (k % 4) * 9, y: Math.floor(k / 4) * 6, w: 9, h: 6, gv: 2 },
    }));
    const md = R.freezeLayout(resolveAt(tiles, 820), { source: 'auto-freeze' });
    const plusOrphans = [...tiles, ...Array.from({ length: Math.ceil(n / 10) }, (_, k) => ({ id: 100000 + k, widget_type: 'chart', chart: { chart_type: 'BAR' }, layout: { x: 0, y: 9999 + k, w: 18, h: 8, gv: 2 } }))];
    const runs = 5;
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < runs; r += 1) { resolveAt(tiles, 820); resolveAt(tiles, 390); resolveAt(plusOrphans, 820, { profiles: { md } }); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
    report.push(`${n} tiles: ${ms.toFixed(1)} ms (tablet auto + phone auto + tablet custom w/ ${Math.ceil(n / 10)} orphans)`);
    assert(ms < 2000, `pathological: ${n} tiles took ${ms.toFixed(0)} ms`);
  }
  console.log(`  benchmark — ${report.join(' · ')}`);
});

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.error.message}`);
  console.error(`${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`responsive layout contract: ${passed} checks passed`);
