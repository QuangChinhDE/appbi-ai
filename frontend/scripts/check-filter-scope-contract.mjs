/**
 * Filter scope + report-anchor contracts, client side — checked on the real modules.
 *
 *   node scripts/check-filter-scope-contract.mjs
 *
 * APPBI-VERIFY-007: a bare saved page filter (field + datasetId, no semantic
 * identity) must reach a KPI/trend whose base view has that field even when the
 * visual does not use it as a role — and the fix must not broaden scope:
 *  - a different datasetId never cross-applies;
 *  - a filter QUALIFIED to another semantic view is never re-matched by bare name;
 *  - a field the binding cannot reach is refused (null), not guessed;
 *  - qualified and joined (fieldMap) semantic fields keep resolving.
 * Report anchor: one fixed export anchor is immutable; leaving a report clears it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
function load(rel) {
  const out = ts.transpileModule(readFileSync(resolve(HERE, '..', 'src', 'lib', rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, () => ({}));
  return mod.exports;
}
const { resolveChartFieldForFilter } = load('filters.ts');
const anchor = load('report-anchor.ts');

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const kpi = {
  datasetId: 1, baseViewName: 'v_sales',
  dimensionFields: ['v_sales.region', 'v_sales.day'], measureFields: ['v_sales.amount'],
  fieldMap: { amount: 'v_sales.amount', region_name: 'v_region.name' },
  reachableFields: ['v_region.name'],
};
const r = (f) => resolveChartFieldForFilter(f, kpi);

check('007: bare page filter on a non-role base-view field applies to the KPI', r({ field: 'region', datasetId: 1 }) === 'region', String(r({ field: 'region', datasetId: 1 })));
check('different datasetId never cross-applies', r({ field: 'region', datasetId: 2 }) === null);
check('filter qualified to another view is not re-matched by bare name',
  r({ field: 'region', semanticField: 'v_other.region', datasetId: 1 }) === null,
  String(r({ field: 'region', semanticField: 'v_other.region', datasetId: 1 })));
check('unreachable bare field is refused', r({ field: 'zzz', datasetId: 1 }) === null);
check('qualified base-view field resolves', r({ field: 'region', semanticField: 'v_sales.region', datasetId: 1 }) === 'region');
check('joined reachable field resolves through the binding', r({ field: 'name', semanticField: 'v_region.name', datasetId: 1 }) === 'region_name');

const fixedAt = '2026-03-14T12:00:00.000Z';
anchor.setReportAnchor(fixedAt);
anchor.stampReportAnchor();
check('fixed export anchor survives a lifecycle re-stamp', anchor.reportAnchor() === fixedAt);
anchor.clearReportAnchor();
check('leaving the report clears the anchor', anchor.reportAnchor() === null
  && Object.keys(anchor.reportAnchorHeader()).length === 0);
const a1 = anchor.stampReportAnchor();
check('a normal read stamps a fresh anchor', typeof a1 === 'string' && a1 !== fixedAt);

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nfilter scope + report anchor contract holds');
