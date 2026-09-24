/**
 * The reader's thumb and the operator's run must never disagree.
 *
 * The public AI bot toggled a thumb OFF when the reader clicked it again. The
 * snapshot was then saved without a rating, but the server only ever writes a
 * verdict onto `agent_flow_runs.rating`, so the run kept "up" while the reader's
 * page showed nothing. The V1 contract (lib/readerRating.ts) is one current
 * verdict, never cleared. This proves every transition, the failed-save undo,
 * and that the component still routes through the contract rather than its own
 * toggle. Deterministic: no browser, no model.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { nextReaderRating, applyReaderRating, revertReaderRating } =
  await import(new URL('../src/lib/readerRating.ts', import.meta.url).href);

const failures = [];
const expect = (label, got, want) => {
  if (got !== want) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

for (const [current, clicked, want] of [
  [undefined, 'up', 'up'], [undefined, 'down', 'down'],
  ['up', 'down', 'down'], ['down', 'up', 'up'],
  ['up', 'up', 'up'], ['down', 'down', 'down'],
]) {
  expect(`${current ?? 'none'} + ${clicked}`, nextReaderRating(current, clicked), want);
}

// Repeating the same click any number of times converges on one verdict.
let msgs = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
for (let i = 0; i < 5; i++) msgs = applyReaderRating(msgs, 1, 'up');
expect('five clicks on up', msgs[1].rating, 'up');
expect('the question is never rated', msgs[0].rating, undefined);

// A failed save undoes itself, but never a later click.
expect('failed save reverts', revertReaderRating(msgs, 1, 'up', undefined)[1].rating, undefined);
const later = applyReaderRating(msgs, 1, 'down');
expect('a later click survives an earlier failure', revertReaderRating(later, 1, 'up', undefined)[1].rating, 'down');

// The component must use the contract, and must not grow its own toggle back.
const bot = readFileSync(resolve(ROOT, 'src/components/dashboards/DashboardAiBot.tsx'), 'utf8');
const start = bot.indexOf('const handleRateMessage');
const handler = bot.slice(start, bot.indexOf('}, [', start));
if (start < 0) failures.push('handleRateMessage not found in DashboardAiBot.tsx');
if (!handler.includes('applyReaderRating(')) failures.push('handleRateMessage does not apply the rating through lib/readerRating');
if (/\?\s*undefined\s*:\s*rating/.test(handler)) failures.push('handleRateMessage toggles a rating back to undefined — the run cannot be un-rated');
if (!handler.includes('revertReaderRating(')) failures.push('a failed rating save is not undone — the thumb would claim a verdict the run never received');

if (failures.length) {
  console.error('✗ reader rating contract:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('✓ reader rating: 6 transitions, idempotent repeat, failed-save undo, component wired');
