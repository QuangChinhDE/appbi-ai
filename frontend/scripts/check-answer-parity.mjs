/**
 * The answer envelope has ONE renderer, and every surface that shows an answer
 * uses it.
 *
 * WHAT WENT WRONG, MEASURED
 * -------------------------
 * `AnswerBlock` is a union of six variants. Direct Chat and the dashboard bot
 * render all six through `AnswerBlocks`. The Studio's test panel did this
 * instead:
 *
 *     const answer = (env?.answer?.blocks || [])
 *       .map((b) => b.markdown).filter(Boolean).join('\n\n');
 *
 * `metric`, `table`, `chart_ref` and `callout` carry no `.markdown`, so they were
 * filtered out. Asked for a metric block and nothing else, a published flow
 * returned exactly that — and the author, whose job is checking the answer, saw
 * an em-dash while the run reported `ok`. The reader would have seen the metric.
 *
 * This is a structural check, in the style of `check-presentation-contract.mjs`:
 * the repo has no frontend test runner and this is not the change that should
 * introduce one.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. every answer surface imports the shared renderer
 *   2. no surface rebuilds an answer by mapping blocks to `.markdown`
 *   3. the shared renderer still handles every variant the contract declares
 *   4. an unknown variant is not silently dropped
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const read = (p) => readFileSync(resolve(SRC, p), 'utf8');

const failures = [];
const fail = (msg) => failures.push(msg);

const RENDERER = 'components/dashboards/AnswerBlocks.tsx';

/** Every surface that renders a flow's answer to a person. */
const SURFACES = [
  ['components/agent-flows/TestChat.tsx', 'Studio test panel'],
  ['components/chat/ConversationView.tsx', 'Direct Chat'],
  ['components/dashboards/DashboardAiBot.tsx', 'Dashboard / public bot'],
];

// ── 1 + 2. one renderer, no private flatten ─────────────────────────────────

/** `.map(b => b.markdown)` in any spelling — the shape of the bug. */
const FLATTEN = /\.\s*map\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\.\s*markdown\s*\)/;

/**
 * Comments are prose, not code.
 *
 * Without this the check failed on the doc comment that explains the very bug it
 * guards — a file describing `.map(b => b.markdown)` as the thing it no longer
 * does was reported as still doing it. A structural check that cannot be written
 * about is one people delete the comments to satisfy.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments, JSDoc included
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments, sparing `https://`
}

for (const [file, label] of SURFACES) {
  let src;
  try {
    src = read(file);
  } catch {
    fail(`${label}: ${file} not found — if the surface moved, update this check`);
    continue;
  }
  const body = code(src);
  if (!/\bAnswerBlocks\b/.test(body)) {
    fail(`${label} does not use the shared AnswerBlocks renderer (${file}).`
       + ' A second renderer is how the surfaces drifted apart.');
  }
  if (FLATTEN.test(body)) {
    fail(`${label} rebuilds the answer by mapping blocks to .markdown (${file}).`
       + ' Non-text variants carry no markdown and vanish silently.');
  }
}

// ── 3. the renderer covers the contract ─────────────────────────────────────

const contract = read('lib/agentFlows.ts');
// Up to the next top-level `export`, not the first line-ending `;` — the variants
// contain plenty of those and a non-greedy match stopped inside the first one.
const unionMatch = contract.match(/export type AnswerBlock =([\s\S]*?)\nexport /);
if (!unionMatch) {
  fail('could not find the AnswerBlock union in lib/agentFlows.ts');
} else {
  const declared = [...unionMatch[1].matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  if (declared.length < 2) fail(`parsed only ${declared.length} AnswerBlock variants — the parser is wrong, not the code`);
  const renderer = read(RENDERER);
  const handled = new Set([...renderer.matchAll(/case\s+'([a-z_]+)'/g)].map((m) => m[1]));
  const missing = declared.filter((t) => !handled.has(t));
  if (missing.length) {
    fail(`AnswerBlocks handles no case for: ${missing.join(', ')}.`
       + ' A declared variant with no branch renders as nothing on every surface.');
  }
}

// ── 4. the unknown variant is visible, not silent ───────────────────────────

const renderer = read(RENDERER);
if (/default:\s*\n?\s*return null;/.test(renderer)) {
  fail('AnswerBlocks drops an unknown block variant silently (`default: return null`).'
     + ' A seventh variant added to the contract would be invisible on every surface,'
     + ' which is exactly how this class of bug stays unnoticed.');
}

// ── 5. the prose heuristic does not stack on top of blocks ──────────────────
//
// `extractFollowups` ends in a FALLBACK that scrapes trailing question lines out
// of prose. That is right for an answer that is only prose, and wrong for an
// envelope with blocks: the text block is rendered verbatim — correctly — and the
// heuristic then renders the same questions again as chips. Seen in the browser
// against a live model: every follow-up appeared twice, once dead, once clickable.
//
// A surface may keep the legacy path for answers that have no blocks. What it may
// not do is run both at once, so the chip row has to be guarded by the ABSENCE of
// blocks.

for (const [path, label] of SURFACES) {
  const src = code(read(path));
  if (!/extractFollowups/.test(src)) continue;          // no heuristic, nothing to guard
  const row = /\{[^{}]*suggestions[^{}]*&&\s*\(/.exec(src);
  if (!row) continue;                                    // renders no chip row of its own
  if (!/blocks\?\.length|blocks\s*&&|blocks\.length/.test(row[0])) {
    fail(`${label} (${path}) renders follow-up chips scraped from prose without checking`
       + ' for blocks first. With blocks present the questions are already in the text'
       + ' block, so each one is shown twice — once as dead prose and once as a chip.');
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error('answer-parity contract FAILED:\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(`answer-parity ok — ${SURFACES.length} surfaces share one renderer`);
