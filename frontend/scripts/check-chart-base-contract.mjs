/**
 * Chart Builder base-lifecycle + failure-classification contracts — checked on
 * the real modules (lib/chart-base-lifecycle.ts, lib/chart-failure.ts).
 *
 *   node scripts/check-chart-base-contract.mjs
 *
 * The user report: a new chart "nhảy về bảng default". Auto-seeded fields (TABLE
 * default columns, a fallback dimension) were read as the user's first pick and
 * committed the model's FIRST view as the base. The rules locked here:
 *  - only a field the USER added derives a base; a seed never does;
 *  - a date-hierarchy view anchors to its parent table;
 *  - a base change keeps every binding the new base reaches and names the rest;
 *  - measures from another fact are reported (the planner computes there);
 *  - a refusal is classified from the structured body / header, never by prose;
 *    a 5xx is a source error, a 403 a permission problem.
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
const B = load('chart-base-lifecycle.ts');
const F = load('chart-failure.ts');

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const views = [
  { name: 'v_activity', dataset_table_id: 1 },
  { name: 'v_pfm', dataset_table_id: 2 },
  { name: 'v_owner', dataset_table_id: 3 },
  { name: 'v_date', dataset_table_id: 4 },
  { name: 'v_pfm__pfm_date__date_dim', dataset_table_id: null, view_role: 'calendar_role' },
];

// ── H1: auto-seed never derives a base ────────────────────────────────────────
const seeded = { metrics: [], selectedColumns: ['v_activity.channel', 'v_activity.calls'] };
check('H1: no user intent → no base, whatever was seeded', B.deriveBaseTableId(views, null) === null);
const userAdded = { ...seeded, selectedColumns: [...seeded.selectedColumns, 'v_pfm.revenue'] };
const intent = B.firstAddedQualifiedField(seeded, userAdded);
check('H1: the field the USER added is the intent (not the first seeded column)', intent === 'v_pfm.revenue', intent);
check('H1: base derives from that field\'s table', B.deriveBaseTableId(views, intent) === 2);
check('H1: a bulk change (implicit-all TABLE → explicit list on one uncheck) is not a pick',
  B.firstAddedQualifiedField({ metrics: [] }, { metrics: [], selectedColumns: ['v_activity.id', 'v_activity.channel', 'v_pfm.revenue'] }) === null);
check('bare refs never derive a base', B.firstAddedQualifiedField({ metrics: [] }, { metrics: [{ field: 'revenue' }] }) === null);
check('date-hierarchy field anchors to its parent table',
  B.deriveBaseTableId(views, 'v_pfm__pfm_date__date_dim.year') === 2);
check('role order: dimension before metric', B.listRoleFieldRefs({ metrics: [{ field: 'v_pfm.revenue' }], dimension: 'v_owner.name' })[0] === 'v_owner.name');

// ── D: base change keeps what the new base reaches ────────────────────────────
const rc = { dimension: 'v_owner.owner_name', metrics: [{ field: 'v_activity.calls' }], selectedColumns: ['region'] };
const filters = [{ field: 'v_owner.owner_name' }, { field: 'v_activity.channel' }, { field: 'region' }];
const reach = new Set(['v_pfm', 'v_owner', 'v_date']);
const dropped = B.bindingsOutsideBase(rc, filters, reach);
check('D: only bindings outside the new base are dropped',
  JSON.stringify(dropped) === JSON.stringify({ fields: ['v_activity.calls'], filters: ['v_activity.channel'] }),
  JSON.stringify(dropped));
const kept = B.keepFiltersInBase(filters, reach).map((f) => f.field);
check('D: reachable + bare filters are kept', JSON.stringify(kept) === JSON.stringify(['v_owner.owner_name', 'region']), JSON.stringify(kept));

// ── B: measure grain outside the base is surfaced ─────────────────────────────
check('B: measures from another fact are reported',
  JSON.stringify(B.measureViewsOutsideBase({ metrics: [{ field: 'v_pfm.revenue' }], dimension: 'v_date.month' }, 'v_activity')) === '["v_pfm"]');
check('B: base measures are not', B.measureViewsOutsideBase({ metrics: [{ field: 'v_activity.calls' }] }, 'v_activity').length === 0);

// ── C: failure classification ─────────────────────────────────────────────────
const amb = F.describeChartFailure({ response: { status: 400, headers: { 'x-appbi-refusal': 'AMBIGUOUS_ROUTE' },
  data: { detail: 'Có 2 đường join…', refusal: { category: 'AMBIGUOUS_ROUTE', target: 'Date', routes: ['bc_pfm → Date', 'bc_pfm → bc_owner → Date'] } } } });
check('C: AMBIGUOUS_ROUTE body → ambiguous_route with target + routes',
  amb.kind === 'ambiguous_route' && amb.target === 'Date' && amb.routes.length === 2 && amb.technical.startsWith('Có 2'), JSON.stringify(amb));
const hdrOnly = F.describeChartFailure({ response: { status: 400, headers: { 'x-appbi-refusal': 'FANOUT_RISK' }, data: { detail: 'x' } } });
check('C: header-only refusal still classified', hdrOnly.kind === 'semantic_refusal' && hdrOnly.category === 'FANOUT_RISK');
check('C: batch item category classified', F.describeChartFailure({ status: 400, error: 'x', category: 'AMBIGUOUS_ROUTE' }).kind === 'ambiguous_route');
check('C: plain 400 → invalid_config', F.describeChartFailure({ response: { status: 400, data: { detail: 'missing dimension' } } }).kind === 'invalid_config');
check('C: 403 → permission', F.describeChartFailure({ response: { status: 403, data: { detail: 'no' } } }).kind === 'permission');
check('C: 500 → source_error', F.describeChartFailure({ response: { status: 500, data: { detail: 'ref abc' } } }).kind === 'source_error');
check('C: HTML body is not shown as text', F.describeChartFailure({ response: { status: 502, data: '<html>bad gateway</html>' }, message: 'Request failed' }).technical === 'Request failed');

console.log(failed ? `\n${failed} chart-base contract(s) FAILED` : '\nall chart-base contracts hold');
process.exit(failed ? 1 : 0);
