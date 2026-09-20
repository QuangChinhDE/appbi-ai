#!/usr/bin/env node
/**
 * Every module page in the sidebar must be mapped in `lib/moduleRoutes.ts`.
 *
 * WHY THIS CHECK EXISTS
 * ---------------------
 * `moduleForPath()` fails OPEN for an unmapped route — deliberately, because the
 * server is the boundary and guessing wrong would lock people out of pages nobody
 * meant to gate. The cost of that choice is that FORGETTING a route is silent.
 *
 * It was forgotten for AI Chat. A user holding `agent_flows: none` who typed
 * /chat got the whole module shell — heading, counters, search box — over an empty
 * list captioned "an assistant appears here once it is shared with you". It never
 * would: they had no access at all. Every one of the module's seven endpoints
 * correctly answered 403, so nothing leaked; the page simply lied about why it was
 * empty, which is the exact failure `ModuleAccessGuard` was built to end.
 *
 * The check derives its expectations from the SIDEBAR rather than a list kept
 * here, because the sidebar is where a new module actually appears first. A list
 * in this file would be a third copy of the same fact, and would drift the same
 * way the second one did.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');

const sidebar = read('src/components/layout/Sidebar.tsx');
const routes = read('src/lib/moduleRoutes.ts');

/** `{ ... href: '/chat', ... module: 'agent_flows' }` — nav entries that claim a module. */
const navEntries = [...sidebar.matchAll(
  /href:\s*'([^']+)'[\s\S]{0,240}?module:\s*'([a-z_]+)'/g,
)].map(([, href, module]) => ({ href, module }));

if (navEntries.length === 0) {
  console.error('✗ module-routes: parsed 0 nav entries from Sidebar.tsx — the check '
    + 'cannot pass vacuously. Did the nav shape change?');
  process.exit(1);
}

/** `['/chat', 'agent_flows'],` inside ROUTE_MODULES. */
const mapped = new Map([...routes.matchAll(/\[\s*'([^']+)'\s*,\s*'([a-z_]+)'\s*\]/g)]
  .map(([, prefix, module]) => [prefix, module]));

const problems = [];
for (const { href, module } of navEntries) {
  const hit = [...mapped.keys()]
    .filter((p) => href === p || href.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) {
    problems.push(`${href} (nav says module '${module}') is not in ROUTE_MODULES — `
      + 'a user without that module will see the page shell instead of the access notice');
  } else if (mapped.get(hit) !== module) {
    problems.push(`${href} is nav-gated on '${module}' but ROUTE_MODULES maps it to `
      + `'${mapped.get(hit)}' via '${hit}' — the nav and the guard disagree`);
  }
}

/* ONE NAV ENTRY, ONE MODULE KEY.
 *
 * The admin matrix renders one row per module, so two nav entries sharing a key
 * are two screens the matrix cannot tell apart — granting one silently grants the
 * other, and there is no way to offer the lighter of the two on its own.
 *
 * AI Chat was that case for months: it rode on `agent_flows`, so the only way to
 * let somebody ASK an assistant a question was to also let them into the flow
 * builder, and the Settings row said "Agent Flows" while opening two things.
 *
 * If a future module genuinely wants two entries under one key, add the pair here
 * on purpose — the same way the backend's route walk declares its identity-scoped
 * exemptions — rather than letting it pass silently. */
const SHARED_KEY_BY_DESIGN = new Set([
  // '/some-route|some_module',
]);

const byModule = new Map();
for (const { href, module } of navEntries) {
  if (SHARED_KEY_BY_DESIGN.has(`${href}|${module}`)) continue;
  if (!byModule.has(module)) byModule.set(module, []);
  byModule.get(module).push(href);
}
for (const [module, hrefs] of byModule) {
  if (hrefs.length > 1) {
    problems.push(`module '${module}' is claimed by ${hrefs.length} nav entries `
      + `(${hrefs.join(', ')}) — the Settings matrix has one row per module, so `
      + 'granting it opens all of them and neither can be offered alone. Give the '
      + 'second screen its own key, or declare the pair in SHARED_KEY_BY_DESIGN');
  }
}

if (problems.length) {
  console.error('✗ module-routes: sidebar and moduleRoutes.ts disagree\n');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('\n  Fix: add the route to ROUTE_MODULES in src/lib/moduleRoutes.ts, '
    + 'or give the screen its own module key.');
  process.exit(1);
}

console.log(`✓ module-routes: ${navEntries.length} nav entries, all mapped, `
  + `agreeing, and one key each (${byModule.size} modules)`);
