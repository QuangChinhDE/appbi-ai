// The frontend middleware must derive the ACCESS-domain signing key exactly as
// backend/app/core/tokens.py does, or every signed-in page bounces to /login.
// This compiles the REAL deriveAccessKey out of src/middleware.ts (not a copy)
// and checks it against the vector the backend test pins
// (backend/tests/test_authz_token_vector.py).
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const ROOT = 'authz-token-vector-root';
const EXPECTED = '3gFG9bdeVV1L10fqsbmYKpgN5n8nN8nFQ-Y-K-Gr6-8=';

const src = readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8');
const start = src.indexOf('export async function deriveAccessKey(');
if (start < 0) throw new Error('deriveAccessKey not found in middleware.ts');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const fnSrc = src.slice(start, end).replace('export ', '');
const js = ts.transpileModule(fnSrc + '\nexport { deriveAccessKey };', {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const got = new TextDecoder().decode(await mod.deriveAccessKey(ROOT));
if (got !== EXPECTED) {
  console.error(`✗ access-token key derivation drifted: got ${got}, backend says ${EXPECTED}`);
  process.exit(1);
}
const mw = src;
for (const needle of ["audience: ACCESS_AUDIENCE", "issuer: TOKEN_ISSUER", "'appbi:access'"]) {
  if (!mw.includes(needle)) { console.error(`✗ middleware no longer verifies ${needle}`); process.exit(1); }
}
console.log('✓ access-token domain: frontend derivation == backend vector; aud/iss verified');
