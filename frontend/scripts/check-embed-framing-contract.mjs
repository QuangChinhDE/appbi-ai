#!/usr/bin/env node
/**
 * Embed framing contract — runs the exact decision code the middleware runs
 * (src/lib/embed-framing.ts), transpiled, against every policy state.
 *
 * Locks the fix for the fail-open guard: a failed policy lookup used to return
 * `[]`, read as "unrestricted", so an origin-restricted `emb_` link became
 * frameable anywhere whenever the backend was slow, down or rate-limited; an
 * unknown/expired/revoked grant answered the same `[]`; and `/d/emb_…` skipped
 * the per-grant check altogether.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
function load(rel) {
  const out = ts.transpileModule(readFileSync(resolve(HERE, '..', 'src', 'lib', rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, () => ({}));
  return mod.exports;
}
const F = load('embed-framing.ts');

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const GRANT = 'emb_' + 'a'.repeat(64);
const STABLE = 'Zx3k9pQ_stable-public-token';
const restricted = (originAllowed = null) => ({ state: 'restricted', allowedOrigins: ['https://app.base.vn', 'https://*.base.vn'], originAllowed });
const decide = (o) => F.decideEmbedFraming({ surface: 'embed', token: GRANT, dest: 'iframe', origin: 'https://app.base.vn', policy: restricted(true), floor: '', ...o });

console.log('embed framing contract');

// fail closed
let d = decide({ policy: null });
check('lookup failure with no known-good policy refuses an emb_ grant', d.kind === 'refuse' && d.reason === 'unavailable' && d.status === 503, d);
check('…and forbids framing of the refusal page', d.csp.includes("frame-ancestors 'none';"), d);
d = decide({ policy: { state: 'invalid', allowedOrigins: [], originAllowed: false } });
check('an invalid (unknown/expired/revoked) grant is refused, never unrestricted', d.kind === 'refuse' && d.reason === 'invalid', d);

// restricted
d = decide({});
check('restricted grant framed by an allowed origin is served', d.kind === 'serve', d);
check('…with its allowlist as frame-ancestors', d.csp[0] === 'frame-ancestors https://app.base.vn https://*.base.vn;', d);
d = decide({ origin: 'https://evil.example', policy: restricted(false) });
check('restricted grant framed by a disallowed origin is refused', d.kind === 'refuse' && d.reason === 'origin', d);
d = decide({ dest: 'document' });
check('restricted grant opened directly (Sec-Fetch-Dest: document) is refused', d.kind === 'refuse' && d.reason === 'not-framed', d);
d = decide({ origin: null, policy: restricted(null) });
check('no Referer → served but bound by frame-ancestors', d.kind === 'serve' && d.csp[0].startsWith('frame-ancestors https://'), d);

// surface
d = decide({ surface: 'd' });
check('an emb_ grant on /d is refused (per-grant policy lives on /embed only)', d.kind === 'refuse' && d.reason === 'wrong-surface', d);
d = decide({ surface: 'd', policy: null });
check('…even with no policy at hand', d.kind === 'refuse' && d.reason === 'wrong-surface', d);

// floor
d = decide({ floor: 'https://portal.example' });
check('deployment floor is emitted ALONGSIDE a grant allowlist (intersection)',
  d.csp.length === 2 && d.csp[1] === "frame-ancestors 'self' https://portal.example;", d);
d = F.decideEmbedFraming({ surface: 'd', token: STABLE, dest: 'iframe', origin: null, policy: null, floor: 'https://portal.example' });
check('stable link gets the deployment floor', d.kind === 'serve' && d.csp[0] === "frame-ancestors 'self' https://portal.example;", d);
d = F.decideEmbedFraming({ surface: 'embed', token: STABLE, dest: 'iframe', origin: null, policy: null, floor: '' });
check('stable link without a floor is served without a frame restriction', d.kind === 'serve' && d.csp.length === 0, d);
d = decide({ policy: { state: 'unrestricted', allowedOrigins: [], originAllowed: true }, floor: 'https://portal.example' });
check('unrestricted grant still gets the floor', d.kind === 'serve' && d.csp[0] === "frame-ancestors 'self' https://portal.example;", d);
d = decide({ policy: { state: 'invalid', allowedOrigins: [], originAllowed: false }, floor: 'https://portal.example' });
check('refusal page of an invalid grant keeps the floor', d.csp[0] === "frame-ancestors 'self' https://portal.example;", d);

// response parsing: anything untrustworthy is null
check('malformed policy body → null', F.parsePolicyResponse({ allowed_origins: [] }) === null);
check('legacy array-only body (no state) → null', F.parsePolicyResponse({ allowed_origins: ['https://a.b'], enforced: true }) === null);
check('restricted with no origins is contradictory → null', F.parsePolicyResponse({ state: 'restricted', allowed_origins: [] }) === null);
check('null body → null', F.parsePolicyResponse(null) === null);
const p = F.parsePolicyResponse({ state: 'restricted', allowed_origins: ['https://a.b'], origin_allowed: false });
check('restricted body parses', p && p.state === 'restricted' && p.originAllowed === false, p);

// cache
const now = 10_000_000;
const good = { policy: restricted(true), at: now - 5 * 60_000 };
check('fresh answer wins over cache', F.choosePolicy(restricted(false), good, now).originAllowed === false);
const fromCache = F.choosePolicy(null, good, now);
check('failed lookup uses a known-good cached policy (≤ 1h)', fromCache && fromCache.state === 'restricted', fromCache);
check('…without reusing a per-origin verdict (frame-ancestors decides)', fromCache && fromCache.originAllowed === null, fromCache);
check('failed lookup with a cache older than a grant can live → null', F.choosePolicy(null, { policy: restricted(true), at: now - 61 * 60_000 }, now) === null);
check('failed lookup with no cache → null', F.choosePolicy(null, undefined, now) === null);

// referer origin
check('originOf reduces a URL to its origin', F.originOf('https://App.Base.vn:8443/x?y#z') === 'https://app.base.vn:8443');
check('originOf rejects non-http(s)', F.originOf('javascript:alert(1)') === null);

// the middleware really uses the decision (static wiring)
const mw = readFileSync(resolve(HERE, '..', 'src', 'middleware.ts'), 'utf8');
check('middleware calls decideEmbedFraming', mw.includes('decideEmbedFraming({'));
check('middleware no longer treats a failed lookup as []', !/catch\s*\{[^}]*return \[\];/s.test(mw));
check('middleware has no second origin matcher', !mw.includes('function originAllowed('));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall embed framing checks passed');
