/**
 * A click handler must not be a function whose first parameter is a value.
 *
 * `onClick={onSend}` hands React's MouseEvent to the first parameter. The AI
 * bot's `handleSend(override?: string)` took it as `override` and called
 * `override.trim()`, so the send BUTTON threw on every click and no message was
 * sent. It shipped in `ceca97c` and survived four months because the prop was
 * typed `onSend: () => void` — the annotation erased the parameter, so tsc
 * compared `() => void` against `() => void` and saw nothing wrong.
 * `handleSend()` from the Enter path takes no argument, which is why only the
 * button was dead.
 *
 * Types could not catch this. A structural check can: a bare `onClick={ident}`
 * whose `ident` is declared in the same file WITH a value parameter.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FILES = [
  'components/dashboards/DashboardAiBot.tsx',
  'components/agent-flows/TestChat.tsx',
  'components/chat/ConversationView.tsx',
];

/** A handler that genuinely wants the event is correct. */
const WANTS_EVENT = /^(e|ev|evt|event|_e)\b/;

const failures = [];

for (const rel of FILES) {
  let text;
  try {
    text = readFileSync(resolve(SRC, rel), 'utf8');
  } catch {
    continue;
  }

  // Bare `onClick={name}` / `onSubmit={name}`. A wrapped arrow is always fine.
  const bare = [...text.matchAll(/on(?:Click|Submit)=\{([A-Za-z_$][\w$]*)\}/g)];

  for (const [, bound] of bare) {
    // FOLLOW THE PROP ONE HOP. The offending identifier was `onSend`, a PROP —
    // the real function is `handleSend`, supplied by the parent in the same file
    // as `onSend={handleSend}`. Resolving only local declarations left this
    // check blind to the exact defect it was written for.
    let name = bound;
    const hop = new RegExp(bound.replace(/[$]/g, '\\$&') + '=\\{([A-Za-z_$][\\w$]*)\\}').exec(text);
    if (hop && hop[1] !== bound) name = hop[1];

    const esc = name.replace(/[$]/g, '\\$&');
    const arrow = new RegExp(
      'const\\s+' + esc + '\\s*=\\s*(?:useCallback\\(\\s*)?(?:async\\s+)?\\(([^)]*)\\)\\s*(?::[^=]*)?=>',
    ).exec(text);
    const fn = new RegExp('function\\s+' + esc + '\\s*\\(([^)]*)\\)').exec(text);
    const params = ((arrow && arrow[1]) || (fn && fn[1]) || '').trim();
    if (!params) continue;

    const first = params.split(',')[0].trim();
    if (WANTS_EVENT.test(first)) continue;
    if (/React\.(Mouse|Form|Pointer)Event/.test(first)) continue;

    failures.push(
      rel + ': onClick={' + bound + '} resolves to ' + name + '(' + first + '), so '
      + 'React passes it the MouseEvent. Wrap it: onClick={() => ' + bound + '()}.',
    );
  }
}

if (failures.length) {
  console.error('handler-arity FAILED:\n');
  for (const f of failures) console.error('  - ' + f + '\n');
  process.exit(1);
}
console.log('handler-arity ok - ' + FILES.length + ' interactive surfaces checked');
