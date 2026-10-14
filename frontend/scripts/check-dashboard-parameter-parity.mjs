#!/usr/bin/env node
/**
 * Builder ↔ public parameter parity, FRONTEND half.
 *
 * Runs src/lib/chart-instance-parameters.ts (what every Builder tile applies)
 * against the shared vectors in backend/tests/fixtures/instance_parameter_vectors.json.
 * The backend half (test_dashboard_parameter_parity.py) runs its twin —
 * app/services/dashboard_parameters.instance_parameter_filters, what every
 * public surface applies — against the SAME file. Either half drifting breaks
 * its own gate.
 *
 * Also asserts the public view no longer withholds parameters: it seeds every
 * switcher like the Builder and sends field-bound values as filters and
 * what-if values as per-tile overrides.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
function load(rel) {
  const out = ts.transpileModule(readFileSync(resolve(ROOT, 'src', 'lib', rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, () => ({}));
  return mod.exports;
}
const lib = load('chart-instance-parameters.ts');
const vectors = JSON.parse(readFileSync(resolve(ROOT, '..', 'backend', 'tests', 'fixtures', 'instance_parameter_vectors.json'), 'utf8')).vectors;

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('dashboard parameter parity (frontend half)');
for (const v of vectors) {
  const got = lib.buildInstanceParameterFilters(v.params, v.values);
  check(v.name, same(got, v.expected), { got, expected: v.expected });
}

const src = (rel) => readFileSync(resolve(ROOT, 'src', rel), 'utf8');
const tile = src('components/dashboards/ChartTile.tsx');
const modal = src('components/dashboards/ChartDetailModal.tsx');
check('Builder tile uses the shared implementation', tile.includes('buildInstanceParameterFilters(chart?.parameters, instanceParameters)'));
check('…and no longer carries its own copy', !tile.includes('function coerceParameterAtom('));
check('chart detail modal uses the shared implementation', modal.includes('buildInstanceParameterFilters(chartParameters, instanceParameters)') && !modal.includes('function coerceParameterAtom('));

const pdv = src('components/dashboards/PublicDashboardView.tsx');
check('public view seeds every switcher like the Builder', pdv.includes('seedParamValues(publicParamDefs'));
check('public view no longer skips field-bound / what-if switchers', !pdv.includes('if (def.field || whatIfBound.has(def.paramName)'));
check('public view sends field-bound parameters as filters', pdv.includes('paramsToFilters(publicParamDefs'));
check('public view sends what-if values as per-tile overrides', pdv.includes('tileRoleOverrides(') && pdv.includes('...(overrides ? { overrides } : {})'));
check('public batch identifies the tile', pdv.includes('tile_id: dashboardChart.id'));
check('a tile opted out of highlighting receives no selection on public (as in the Builder)',
  /const receivesSelection = pageCrossFilterState[\s\S]{0,160}highlightEnabled !== false/.test(pdv));
check('public switcher is interactive', /DashboardWidget[^>]*onParamChange=\{handlePublicParamChange\}/.test(pdv));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall parameter parity checks passed');
