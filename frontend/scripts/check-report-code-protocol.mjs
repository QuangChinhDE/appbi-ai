#!/usr/bin/env node
/**
 * Report-as-Code sandbox protocol contract — runs the exact parser the host frame
 * uses (src/lib/report-code/protocol.ts), transpiled, against hostile input, and
 * checks the host frame and public view keep their security shape:
 *   - the frame is sandboxed with allow-scripts ONLY (no same-origin, forms, popups,
 *     top navigation), the channel is a transferred MessagePort, and a second load
 *     tears the frame down;
 *   - the public report view never imports the signed-in API client.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const read = (rel) => readFileSync(resolve(SRC, rel), 'utf8');
function load(rel) {
  const out = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, () => ({}));
  return mod.exports;
}
const P = load('lib/report-code/protocol.ts');

let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}`);
}

const F = [{ key: 'f1', label: 'Bang', kind: 'category' }, { key: 'f2', label: 'Ngày', kind: 'date' }];
const parse = (m) => P.parseSandboxMessage(m, F);

check('unknown message types are dropped', parse({ type: 'fetch', url: 'https://x' }) === null);
check('non-objects are dropped', parse('ready') === null && parse(null) === null);
check('ready parses', parse({ type: 'ready' })?.type === 'ready');
check('a filter key the report does not declare is refused', parse({ type: 'setFilter', key: 'f9', value: ['a'] }) === null);
check('a category value must be a list of primitives', parse({ type: 'setFilter', key: 'f1', value: [{ $ne: 1 }] }) === null);
check('a category list over the cap is refused', parse({ type: 'setFilter', key: 'f1', value: Array(201).fill('a') }) === null);
check('a category value is normalised to strings', JSON.stringify(parse({ type: 'setFilter', key: 'f1', value: ['SP', 3] }).value) === '["SP","3"]');
check('an empty category list clears the filter', parse({ type: 'setFilter', key: 'f1', value: [] }).value === null);
check('a date range needs ISO dates', parse({ type: 'setFilter', key: 'f2', value: ['2017-01-01', "1;DROP"] }) === null);
check('a date range parses', JSON.stringify(parse({ type: 'setFilter', key: 'f2', value: ['2017-01-01', ''] }).value) === '["2017-01-01",null]');
check('a values request for an undeclared filter is refused', parse({ type: 'values', reqId: 'v1', key: 'zz' }) === null);
check('an over-long region id is refused', parse({ type: 'region', region: 'x'.repeat(81) }) === null);
check('error text is bounded', parse({ type: 'error', message: 'e'.repeat(5000) }).message.length <= 500);
check('applyFilter removes a cleared key', JSON.stringify(P.applyFilter({ f1: ['a'] }, 'f1', null)) === '{}');

const frame = read('components/report-code/ReportFrame.tsx');
const APP = 'http://localhost:3000';
check('opaque document: allow-scripts only', P.frameSandbox('/api/v1/public/report-docs/t', false, APP) === 'allow-scripts');
check('isolated document on the report origin: allow-scripts allow-same-origin', P.frameSandbox('http://127.0.0.1:3000/api/v1/x', true, APP) === 'allow-scripts allow-same-origin');
check('isolated document on the APP origin is refused (sandbox escape)', P.frameSandbox('http://localhost:3000/api/v1/x', true, APP) === null && P.frameSandbox('/api/v1/x', true, APP) === null);
check('frame never grants forms, popups or top navigation', !/allow-top-navigation|allow-popups|allow-forms|allow-modals/.test(frame + read('lib/report-code/protocol.ts')));
check('frame uses the computed sandbox', /sandbox=\{sandbox\}/.test(frame) && /report-frame-refused/.test(frame));
check('frame hands over a MessagePort, not window messaging', /new MessageChannel\(\)/.test(frame) && /\[channel\.port2\]/.test(frame));
check('frame tears down on a second load (self-navigation)', /loadsRef\.current > 1/.test(frame) && /setBlocked\(true\)/.test(frame));
check('frame imports no API client', !/api-client|@\/lib\/api\//.test(frame));

for (const rel of ['components/report-code/PublicReportView.tsx', 'app/d/r/[token]/page.tsx', 'app/embed/r/[token]/page.tsx']) {
  check(`${rel} uses the public client only`, !/api-client|lib\/api\/report-code/.test(read(rel)));
}

if (failed) {
  console.log(`\n${failed} report-code protocol check(s) failed`);
  process.exit(1);
}
console.log('all report-code protocol checks passed');
