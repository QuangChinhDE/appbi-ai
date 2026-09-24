/**
 * The V1 starter may only grant tools that exist and are not gated.
 *
 * WHY THIS IS A CHECK AND NOT A CODE REVIEW
 * -----------------------------------------
 * `starterFlow()` writes a list of tool names into every flow a pilot author
 * creates. Nothing else in the frontend validates that list: the builder shows
 * whatever the body says, and the backend silently offers a step only the tools
 * it recognises. So two failures ship green.
 *
 *   A tool is RENAMED in the registry. The starter keeps granting the old name.
 *   Every starter flow created afterwards has a dead grant, the assistant quietly
 *   loses that capability, and the first symptom is a reader being told the
 *   report cannot answer something it can.
 *
 *   A tool is added to the starter from a GATED pack — `external` requires
 *   `web_search_enabled` on the link. The grant is legal and the picker even
 *   offers it, so nothing refuses the change; what happens is that the product's
 *   recommended first flow now reaches outside AppBI by default, which is a
 *   decision nobody made.
 *
 * Both are a property of two files that must agree, which is what a contract
 * check is for. `check-node-topology.mjs` reads the same two halves for the same
 * reason and this follows its approach: read both as TEXT, because there is no
 * frontend test runner here and a Python value is not reachable from node.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not judge WHICH tools belong in the
 * starter — that is a product call, argued in `starterFlow`'s comment. It checks
 * only that each one is real, ungated, and that the answering step holds none.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FE = join(ROOT, 'frontend', 'src', 'lib', 'agentFlows.ts');
const PACKS = join(ROOT, 'backend', 'app', 'services', 'agent_flows', 'tools', 'packs');

const failures = [];
const fail = (m) => failures.push(m);

// ── what the starter grants ──────────────────────────────────────────────────
const fe = readFileSync(FE, 'utf8');

const listAt = (pattern) => {
  const at = fe.search(pattern);
  if (at < 0) return null;
  // The `[` of the VALUE, not the one in the `string[]` annotation — anchoring on
  // `= [` is the difference between reading ten tool names and reading zero and
  // reporting it as a missing declaration.
  const assign = fe.indexOf('= [', at);
  if (assign < 0) return null;
  const close = fe.indexOf(']', assign);
  if (close < 0) return null;
  return [...fe.slice(assign, close).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
};

const granted = listAt(/const STARTER_TOOLS\s*:/);
if (!granted || !granted.length) {
  fail('STARTER_TOOLS could not be read from lib/agentFlows.ts — either it was '
     + 'renamed, or the starter no longer declares its grants in one place.');
}

// ── what the registry actually has ───────────────────────────────────────────
// A pack file declares `key="…"`, optionally `requires_setting="…"`, and its
// tools as the first positional string of each `local(` / `remote(` entry.
const real = new Set();
const gated = new Map(); // tool name -> the setting its pack requires

let packFiles = [];
try {
  packFiles = readdirSync(PACKS).filter((f) => f.endsWith('.py') && !f.startsWith('_'));
} catch (e) {
  fail(`could not read the tool packs at ${PACKS}: ${e.message}`);
}

for (const file of packFiles) {
  const src = readFileSync(join(PACKS, file), 'utf8');
  // Only files that DECLARE a pack; `_source.py` and helpers do not.
  if (!/^PACK\s*=\s*ToolPack\(/m.test(src)) continue;
  const requires = /requires_setting\s*=\s*"([^"]+)"/.exec(src);
  // Each entry opens with the tool's own name as the first argument. The
  // constructor is not one fixed word - `spec`, `local` and `remote` are all in
  // use - so the SHAPE is matched rather than the name. Naming two of the three
  // explicitly is what made the first version of this read six tools out of
  // forty and report the other four as invented by the starter.
  for (const m of src.matchAll(/^\s+[a-z_]+\(\s*\n\s*"([a-z0-9_]+)",/gm)) {
    real.add(m[1]);
    if (requires) gated.set(m[1], requires[1]);
  }
}

// A FLOOR, NOT A ZERO CHECK. A parser that reads SOME of the registry is the
// dangerous state: it passes, and reports every tool it failed to read as one the
// starter invented. That is exactly what happened while this was being written.
const FLOOR = 30;
if (real.size < FLOOR) {
  fail(`only ${real.size} tool names were read from the registry packs, below the `
     + `floor of ${FLOOR}. The parser and the pack files have drifted, so every `
     + 'unread tool would be reported as a dead grant.');
}

for (const tool of granted ?? []) {
  if (!real.has(tool)) {
    fail(`the starter grants '${tool}', which no pack declares. A flow created `
       + 'from the starter would carry a dead grant and silently lose that '
       + 'capability.');
  } else if (gated.has(tool)) {
    fail(`the starter grants '${tool}', whose pack requires '${gated.get(tool)}'. `
       + 'The recommended first flow must not depend on a per-link setting, and '
       + 'must never reach outside AppBI by default.');
  }
}

// ── the answering step holds no tools ────────────────────────────────────────
// The product's own review raises a note when the step that writes the answer can
// still fetch figures. Shipping the recommended starting shape with a standing
// review note is how authors learn that notes are noise.
const starter = fe.slice(fe.search(/export function starterFlow/));
const answerBlock = starter.slice(starter.indexOf('const answer'), starter.indexOf('return {'));
if (!answerBlock) {
  fail('starterFlow no longer has an `answer` node declaration this check can read.');
} else if (!/tools:\s*\[\s*\]/.test(answerBlock)) {
  fail('the starter\'s answering step grants tools. A step that writes the answer '
     + 'and can still fetch figures may quote a number that passed through no '
     + 'step where it could be checked — which is what the contract warns about.');
}

if (failures.length) {
  console.error('starter-grants contract FAILED:\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(
  `starter-grants ok — ${granted.length} granted tools all exist and none is gated `
  + `(${real.size} tools in the registry)`,
);
