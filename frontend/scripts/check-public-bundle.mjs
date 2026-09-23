/**
 * The authed client must not be REACHABLE from the public dashboard page.
 *
 * `public_client_only` guards files under `app/d/**` and `app/embed/**`. It is
 * file-scoped, so it says nothing about what those files import. `app/d/[token]`
 * renders `PublicDashboardView`, which renders `DashboardAiBot` — and a VALUE
 * import from a module that imports `apiClient` puts the authed client in the
 * public bundle without touching a single guarded file. That happened: a helper
 * was added to `lib/agentFlows.ts` (which imports apiClient) and imported by name
 * into `DashboardAiBot`. The existing import from that module was `import type`,
 * erased at compile time, so nothing complained.
 *
 * This walks the import graph from the public entry points and fails if a VALUE
 * import reaches `api-client`. Type-only imports are erased and do not count.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ENTRIES = ['app/d/[token]/page.tsx', 'app/embed/[token]/page.tsx'];
const BANNED = /(^|\/)api-client$/;

const read = (p) => {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const f = resolve(SRC, p + ext);
    if (existsSync(f) && !f.endsWith('/')) {
      try { return { file: f, text: readFileSync(f, 'utf8') }; } catch { /* dir */ }
    }
  }
  return null;
};

/** Value imports only — `import type` is erased and cannot ship anything. */
function valueImports(text) {
  const out = [];
  const re = /import\s+(type\s+)?([^'"]*?)from\s+'(@\/[^']+|\.[^']+)'/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) continue;                                  // `import type { … }`
    const clause = m[2] || '';
    if (/^\s*\{\s*(type\s+[^,}]+,?\s*)+\}\s*$/.test(clause)) continue;  // all-inline-type
    out.push(m[3]);
  }
  return out;
}

const failures = [];
for (const entry of ENTRIES) {
  const start = read(entry);
  if (!start) continue;
  const seen = new Set();
  const stack = [[entry, [entry]]];
  while (stack.length) {
    const [spec, path] = stack.pop();
    if (seen.has(spec)) continue;
    seen.add(spec);
    const mod = read(spec);
    if (!mod) continue;
    for (const dep of valueImports(mod.text)) {
      const resolved = dep.startsWith('@/')
        ? dep.slice(2)
        : resolve(dirname(resolve(SRC, spec)), dep).slice(SRC.length + 1).replace(/\\/g, '/');
      if (BANNED.test(resolved)) {
        failures.push(`${path.join(' -> ')} -> ${resolved}`);
        continue;
      }
      stack.push([resolved, [...path, resolved]]);
    }
  }
}

/**
 * Chains that already existed when this check was written. NAMED, not ignored:
 * a new one fails the build, these are reported on every run so they cannot
 * quietly become permanent. Owned by the dashboards/public-link area.
 *
 * Static reachability is not proof of an authed CALL from a public page — that
 * is what `public_client_only` checks on the guarded files themselves. It does
 * mean the authed client ships in the public bundle, which is what this guards.
 */
const KNOWN = [
  'hooks/use-public-filter-distinct-values -> hooks/use-dataset-model -> lib/api-client',
];

const isKnown = (chain) => KNOWN.some((k) => chain.endsWith(k));
const fresh = failures.filter((f) => !isKnown(f));
const known = failures.filter(isKnown);

for (const f of known) {
  console.warn('public-bundle KNOWN (pre-existing, not from this change):');
  console.warn('  - ' + f);
}
if (fresh.length) {
  console.error('public bundle FAILED - the authed client BECAME reachable from a public page:');
  for (const f of fresh) console.error('  - ' + f);
  console.error('  Move the shared code into a module that imports no client.');
  process.exit(1);
}
console.log('public-bundle ok - no NEW path from a public entry to apiClient ('
  + known.length + ' known chain(s) still open)');
