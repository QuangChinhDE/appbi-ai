#!/usr/bin/env node
/**
 * PowerPoint export + filter-diagnostic contract (no browser).
 *
 * The browser journeys are e2e/tests/dashboard-pptx-export.spec.ts; this checks
 * the pure rules they rely on and the wiring that keeps them in place:
 *  - the export-only projection closes ONLY bands that controls alone took;
 *  - controls are recognised by their canonical widget type, never by label;
 *  - every backend drop reason maps to a product-language kind, and an author
 *    reads filter LABELS, never ids;
 *  - viewers never render the diagnostic; both tile renderers publish their
 *    export state; the capture hides `[data-export-hide]`; an undrawn chart
 *    fails the export instead of shipping as an empty card.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
// Browser-only modules the checked functions never call.
const STUBS = { 'html2canvas-pro': { __esModule: true, default: () => { throw new Error('no canvas in node'); } } };
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
    if (STUBS[specifier]) return STUBS[specifier];
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
function assert(cond, message) { if (!cond) throw new Error(message); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const pptx = load('lib/export-pptx.ts');
const diag = load('lib/filter-diagnostic.ts');

check('A · a filter band across the top closes: the content below moves up, nothing else changes', () => {
  const controls = [{ x: 0, y: 0, w: 300, h: 60 }, { x: 316, y: 0, w: 300, h: 60 }];
  const content = [
    { id: 'kpi', x: 0, y: 76, w: 300, h: 140 }, { id: 'kpi2', x: 316, y: 76, w: 300, h: 140 },
    { id: 'chart', x: 0, y: 232, w: 616, h: 300 },
  ];
  const out = pptx.closeControlBands(content, controls);
  assert(out[0].y === 0 && out[1].y === 0 && out[2].y === 156, JSON.stringify(out));
  assert(out[2].y - out[0].y === content[2].y - content[0].y, 'relative geometry changed');
});

check('B · a filter BESIDE a chart: the chart stays exactly where it is, nothing overlaps', () => {
  const controls = [{ x: 0, y: 0, w: 200, h: 60 }];
  const content = [{ id: 'chart', x: 216, y: 0, w: 400, h: 300 }, { id: 'below', x: 0, y: 316, w: 616, h: 200 }];
  const out = pptx.closeControlBands(content, controls);
  assert(same(out, content), `moved: ${JSON.stringify(out)}`);
});

check('C · whitespace the author left (no control in it) stays', () => {
  const content = [{ id: 'a', x: 0, y: 0, w: 600, h: 100 }, { id: 'b', x: 0, y: 400, w: 600, h: 100 }];
  assert(same(pptx.closeControlBands(content, []), content), 'whitespace closed with no control');
  const out = pptx.closeControlBands(content, [{ x: 0, y: 600, w: 200, h: 50 }]);
  assert(same(out, content), `a trailing control moved content: ${JSON.stringify(out)}`);
});

check('D · two stacked control bands close once each, never past the content', () => {
  const controls = [{ x: 0, y: 0, w: 300, h: 60 }, { x: 0, y: 76, w: 300, h: 60 }];
  const content = [{ id: 'kpi', x: 0, y: 152, w: 300, h: 140 }];
  const out = pptx.closeControlBands(content, controls);
  assert(out[0].y === 0, JSON.stringify(out));
});

check('controls are recognised by widget type (slicer, parameter switcher) — never by label', () => {
  assert(pptx.isExportControl({ widgetType: 'slicer' }), 'slicer');
  assert(pptx.isExportControl({ widgetType: 'parameter_switcher' }), 'parameter switcher');
  for (const kept of [null, 'chart', 'text', 'section_header', 'callout', 'hero_strip', 'image', 'narrative']) {
    assert(!pptx.isExportControl({ widgetType: kept }), `${kept} dropped from the deck`);
  }
});

check('every backend drop reason maps to a product-language kind', () => {
  const expected = {
    no_field: 'no_field', unknown_field: 'no_field', dataset_mismatch: 'no_field', binding_unsupported: 'no_field',
    unreachable_view: 'not_linked', no_join_path: 'not_linked', wrong_direction: 'not_linked', ambiguous_path: 'not_linked',
    no_primary_key: 'not_linked', multi_role_pick_required: 'not_linked',
    unsupported_operator: 'operator', empty_value: 'no_value', not_in_public_whitelist: 'link_only', link_hidden: 'link_only',
  };
  for (const [reason, kind] of Object.entries(expected)) {
    assert(diag.diagnosticKind(reason) === kind, `${reason} → ${diag.diagnosticKind(reason)}`);
  }
  assert(diag.diagnosticKind('something_new') === 'other', 'unknown reason');
  // Every kind has author copy in both languages.
  const catalog = source('i18n/catalog/dashboards.ts');
  for (const kind of new Set([...Object.values(expected), 'other'])) {
    const n = (catalog.match(new RegExp(`'dashboards\\.filterDiagnostic\\.reason\\.${kind}'`, 'g')) || []).length;
    assert(n === 2, `reason.${kind} copy in ${n} languages`);
  }
});

check('an author reads the filter LABEL, never an id; one line per filter', () => {
  const filters = [{ id: 'slicer-region', field: 'region', label: 'Region', semanticField: 'closure_sales_v.region', fieldKey: 'closure_sales_v.region', operator: 'in', value: ['North'] }];
  const items = diag.buildFilterDiagnostics({
    skipped: [],
    dropped: [
      { field: 'region', semantic_field: 'closure_sales_v.region', reason: 'dataset_mismatch', detail: 'filter dataset 7 != chart dataset 8' },
      { field: 'region', semantic_field: 'closure_sales_v.region', reason: 'unreachable_view' },
      { field: 'dataset_table_12.customer_tier', reason: 'no_join_path' },
    ],
    filters,
    unknownLabel: 'a filter',
  });
  assert(items.length === 2, `deduped: ${JSON.stringify(items)}`);
  assert(items[0].label === 'Region' && items[0].kind === 'no_field', JSON.stringify(items[0]));
  assert(!/dataset_table_|\d{2,}|\./.test(items[1].label), `an id reached the label: ${items[1].label}`);
  assert(/dataset 7/.test(items[0].technical), 'the engine wording is kept only as technical detail');
});

check('viewers never render the filter diagnostic; the Builder does, through one component', () => {
  const ro = source('components/dashboards/ReadonlyChartTile.tsx');
  assert(!/dropped_filters|droppedBadge|droppedByBackend|FilterDiagnostic/.test(ro.replace(/\/\/.*$/gm, '')), 'the viewer tile renders the diagnostic');
  const ct = source('components/dashboards/ChartTile.tsx');
  assert(/<FilterDiagnostic items=\{filterDiagnostics\}/.test(ct), 'the Builder tile lost its diagnostic');
  assert(!/skippedBadge|bị bỏ qua/.test(ct), 'the ambiguous "N skipped" wording is back');
  const fd = source('components/dashboards/FilterDiagnostic.tsx');
  assert(/data-export-hide=""/.test(fd), 'the diagnostic can reach an export');
  assert(/data-export-hide=""/.test(source('components/dashboards/CachedLiveBadge.tsx')), 'the "as of" badge can reach an export');
});

check('both tile renderers publish their export state; the capture hides export-hidden chrome', () => {
  for (const file of ['components/dashboards/ChartTile.tsx', 'components/dashboards/ReadonlyChartTile.tsx']) {
    const src = source(file);
    assert(/data-export-state=\{exportState\}/.test(src), `${file} root has no export state`);
    assert(/data-export-state="loading"/.test(src), `${file} placeholder is not "loading"`);
  }
  const ex = source('lib/export-pptx.ts');
  assert(/\[data-export-hide\]/.test(ex), 'the PowerPoint capture shows export-hidden chrome');
  assert(/throw new PptxIncompleteError\(failed\)/.test(ex), 'an undrawn chart no longer fails the export');
  assert(/plotInk\(canvas\) < MIN_PLOT_INK/.test(ex), 'a blank capture is accepted');
  const rr = source('lib/render-ready.ts');
  assert(/loading > 0/.test(rr) && /tileReadiness\(t\)/.test(rr), 'page readiness no longer waits for every tile');
});

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.error.message}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`pptx export contract: ${passed} checks passed`);
