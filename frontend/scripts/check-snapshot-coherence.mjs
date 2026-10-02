/**
 * The dashboard generation contract, client side — checked on the real module.
 *
 *   node scripts/check-snapshot-coherence.mjs
 *
 * One view of a published report must not present two snapshot generations of
 * one dataset under one "data as of" label (a publish can land between two
 * reads of the same view). What it holds src/lib/snapshot-coherence.ts to:
 *  - tiles of one dataset on two generations → not coherent, the OLDER ones
 *    are named (they are re-read), never the newer;
 *  - different datasets on different generations are fine (each its own);
 *  - live / non-snapshot tiles never make a view incoherent;
 *  - the as-of shown is the OLDEST build among the tiles on screen.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = resolve(HERE, '..', 'src', 'lib', 'snapshot-coherence.ts');
const out = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', out)(mod, mod.exports);
const { snapshotCoherence } = mod.exports;

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tile = (ds, gen, asOf) => ({
  debug: { snapshot_dataset_id: ds, snapshot_generation: gen, snapshot_as_of: asOf },
});

let c = snapshotCoherence({ 1: tile(7, 100, '2026-10-01T08:00:00'), 2: tile(7, 100, '2026-10-01T08:00:00') });
check('one dataset, one generation → coherent', c.coherent && c.stale.length === 0, JSON.stringify(c));

c = snapshotCoherence({ 1: tile(7, 100, '2026-10-01T08:00:00'), 2: tile(7, 101, '2026-10-01T09:00:00') });
check('one dataset, two generations → not coherent', !c.coherent, JSON.stringify(c));
check('the OLDER tile is the one re-read', JSON.stringify(c.stale) === '[1]', JSON.stringify(c.stale));
check('as-of is the oldest build on screen', c.asOf === '2026-10-01T08:00:00', c.asOf);

c = snapshotCoherence({ 1: tile(7, 100, '2026-10-01T08:00:00'), 2: tile(8, 555, '2026-10-01T09:00:00') });
check('two datasets on their own generations → coherent', c.coherent, JSON.stringify(c));

c = snapshotCoherence({ 1: { debug: { data_source_mode: 'live' } }, 2: tile(7, 100, null), 3: {} });
check('live / no-debug tiles never break coherence', c.coherent && c.asOf === null, JSON.stringify(c));

c = snapshotCoherence({ 1: tile(7, 100, null), 2: tile(7, 101, null), 3: tile(7, 101, null) }, [2, 3]);
check('restricted to the given tiles', c.coherent, JSON.stringify(c));

// ── the live-data freshness contract (Pair #5) ──────────────────────────────
const { cachedLiveNotice } = mod.exports;
const NOW = Date.parse('2026-10-02T09:10:00Z');
const live = (asOf, cached) => ({ data_source_mode: 'live', result_as_of: asOf, result_cached: cached });

check('a live read served now is current (no notice)', cachedLiveNotice(live('2026-10-02T09:10:00Z', false), NOW) === null);
let n = cachedLiveNotice(live('2026-10-02T09:06:00Z', true), NOW);
check('a CACHED live read 4 min old says as of its read time', n && n.asOf === '2026-10-02T09:06:00Z', JSON.stringify(n));
check('a cached read seconds old reads as current', cachedLiveNotice(live('2026-10-02T09:09:40Z', true), NOW) === null);
n = cachedLiveNotice({ data_source_mode: 'live', result_cached: true }, NOW);
check('a cached read with no stamp is still flagged (time unknown), never current', n && n.asOf === null, JSON.stringify(n));
check('a snapshot tile is labelled by its build, not the cache',
  cachedLiveNotice({ snapshot_as_of: '2026-10-02T08:00:00Z', result_cached: true, result_as_of: '2026-10-02T09:00:00Z' }, NOW) === null);
c = snapshotCoherence({ 1: { debug: live('2026-10-02T09:10:00Z', false) }, 2: { debug: live('2026-10-02T08:30:00Z', true) } });
check('the view as-of is the cached live tile\'s read time', c.asOf === '2026-10-02T08:30:00Z', c.asOf);
c = snapshotCoherence({ 1: { debug: live('2026-10-02T08:30:00Z', true) }, 2: tile(7, 100, '2026-10-02T07:00:00Z') });
check('…or an older snapshot build, whichever is OLDER', c.asOf === '2026-10-02T07:00:00Z', c.asOf);

if (failed) {
  console.error(`snapshot-coherence: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('snapshot-coherence: all checks passed');
