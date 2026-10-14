/**
 * The frontend and the backend describe the same tree.
 *
 * A container node keeps its children somewhere — `if` under `paths[].body`,
 * `switch` under `cases[].body` and `fallback`, `coordinate` under
 * `specialists[].body` and `fallback`, `loop` under `body`. Both halves of the
 * product need that map: the backend to walk a flow, the frontend to draw, edit
 * and route inside one.
 *
 * WHAT HAPPENS WHEN THEY DISAGREE
 * -------------------------------
 * `coordinate` was added to the models, the executor and the builder — and not to
 * the backend's `all_nodes()`. A specialist's lane became invisible to every
 * authoring check at once, and asked which product category earned the most, the
 * flow answered "13,591,643.70": the report's grand total, no category named, no
 * notice raised, run `ok`.
 *
 * `backend/tests/test_node_child_slots.py` proves the backend's declaration covers
 * every container in the pydantic models. This proves the frontend's copy says the
 * same thing, so the two cannot drift apart silently.
 *
 * Both literals are read as TEXT rather than imported: there is no frontend test
 * runner here, and a Python value is not reachable from node. A hand-rolled scan
 * beats one big regex — the first version built a pattern across a newline and
 * reported the code was wrong when the parser was.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const failures = [];
const fail = (m) => failures.push(m);

/** The text between `startPattern` and the line that closes its brace. */
function literalAfter(src, startPattern) {
  const at = src.search(startPattern);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * `{ if: Set{'paths'}, … }` from either dialect.
 *
 * `entry` finds `<type>:` and `field` finds each field name after it; everything
 * up to the NEXT entry belongs to the current one.
 */
function parseSlots(block, entry, field) {
  const out = {};
  const starts = [...block.matchAll(entry)];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index + starts[i][0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index : block.length;
    const fields = [...block.slice(from, to).matchAll(field)].map((m) => m[1]);
    if (fields.length) out[starts[i][1]] = new Set(fields);
  }
  return out;
}

// ── the two declarations ────────────────────────────────────────────────────

const fe = readFileSync(resolve(ROOT, 'frontend/src/lib/agentFlows.ts'), 'utf8');
const feBlock = literalAfter(fe, /export const CHILD_SLOTS/);
if (!feBlock) fail('could not find CHILD_SLOTS in frontend/src/lib/agentFlows.ts');

const be = readFileSync(
  resolve(ROOT, 'backend/app/services/agent_flows/contract.py'), 'utf8',
);
const beBlock = literalAfter(be, /^CHILD_SLOTS/m);
if (!beBlock) fail('could not find CHILD_SLOTS in backend contract.py');

//   frontend:  if: [{ field: 'paths', kind: 'groups', token: 'path' }],
//   backend:   "if": (("paths", "groups"),),
const feSlots = feBlock ? parseSlots(feBlock, /(\w+):\s*\[/g, /field:\s*'(\w+)'/g) : {};
const beSlots = beBlock ? parseSlots(beBlock, /"(\w+)":\s*\(/g, /\(\s*"(\w+)"\s*,/g) : {};

// ── they must say the same thing ────────────────────────────────────────────

if (feBlock && beBlock) {
  const feTypes = Object.keys(feSlots).sort();
  const beTypes = Object.keys(beSlots).sort();

  if (!feTypes.length || !beTypes.length) {
    fail(`parsed ${feTypes.length} frontend and ${beTypes.length} backend container `
       + 'types — the parser is wrong, not the code');
  }

  for (const type of beTypes) {
    if (!feSlots[type]) {
      fail(`backend declares container '${type}'; the frontend does not. `
         + 'Its lanes would be invisible to the canvas, the edge generator and '
         + 'every walker in agentFlows.ts.');
      continue;
    }
    const missing = [...beSlots[type]].filter((f) => !feSlots[type].has(f));
    const extra = [...feSlots[type]].filter((f) => !beSlots[type].has(f));
    if (missing.length) {
      fail(`'${type}': the backend keeps children in ${missing.join(', ')} and the `
         + 'frontend does not declare it — that lane is never walked in the builder.');
    }
    if (extra.length) {
      fail(`'${type}': the frontend declares ${extra.join(', ')}, which the backend `
         + 'does not — the builder would write a lane the runtime never runs.');
    }
  }
  for (const type of feTypes) {
    if (!beSlots[type]) {
      fail(`frontend declares container '${type}'; the backend does not. `
         + 'The builder would offer lanes the executor cannot run.');
    }
  }
}

if (failures.length) {
  console.error('node-topology contract FAILED:\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(
  `node-topology ok — ${Object.keys(feSlots).length} container types agree `
  + 'between the builder and the runtime',
);
