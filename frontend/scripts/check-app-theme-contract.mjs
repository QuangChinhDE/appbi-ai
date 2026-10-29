#!/usr/bin/env node
/**
 * App theme contract (Ocean Blue, light) — the structural rules the contrast
 * check cannot see. No browser; reads source.
 *
 *  A. one source of truth: `.app-chrome` re-asserts EXACTLY the :root values
 *     for every token it carries (a drift there is two brand systems);
 *  B. interaction order: primary hover and pressed are DARKER than the base
 *     (the old theme lightened on hover: white text lost contrast);
 *  C. dashboard theme isolation: the report theme never writes to <html>, and
 *     the AppBI chrome that renders inside the report wrapper (builder toolbar,
 *     modals) carries `.app-chrome`;
 *  D. no dark-era white-alpha classes in the dashboard builder (invisible on
 *     the light theme), and the focus ring follows the brand token.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

const css = read('src/app/globals.css');
const block = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert(at >= 0, `${selector} block missing from globals.css`);
  return css.slice(at, css.indexOf('}', at));
};
const triplets = (text) => Object.fromEntries(
  [...text.matchAll(/--([a-z0-9-]+):\s*(\d+\s+\d+\s+\d+)\s*;/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ')]),
);
const root = triplets(block(':root'));
const chrome = triplets(block('.app-chrome'));

check('A · .app-chrome carries the same values as :root (one brand system, not two)', () => {
  const keys = Object.keys(chrome);
  assert(keys.length >= 10, `.app-chrome re-asserts only ${keys.length} tokens`);
  for (const k of ['brand', 'brand-hover', 'brand-active', 'surface-1', 'text-primary', 'border-line']) {
    assert(k in chrome, `.app-chrome does not re-assert --${k}`);
  }
  const drift = keys.filter((k) => root[k] !== chrome[k]).map((k) => `--${k}: root ${root[k]} vs app-chrome ${chrome[k]}`);
  assert(drift.length === 0, drift.join('; '));
});

const lum = (t) => {
  const [r, g, b] = t.split(' ').map(Number).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

check('B · primary hover and pressed are darker than the base, in that order', () => {
  assert(lum(root['brand-hover']) < lum(root.brand), `--brand-hover (${root['brand-hover']}) is not darker than --brand (${root.brand})`);
  assert(lum(root['brand-active']) < lum(root['brand-hover']), '--brand-active is not darker than --brand-hover');
  const button = read('src/components/ui/Button.tsx');
  assert(/primary:\s*\n?\s*'bg-brand text-text-inverse hover:bg-brand-hover active:bg-brand-active/.test(button),
    'Button primary no longer maps hover/pressed to the brand-hover/brand-active tokens');
  assert(/tonal:\s*\n?\s*'bg-brand-container text-brand-on-container hover:bg-brand-container-hover/.test(button),
    'Button tonal variant missing or not on the brand-container tokens');
});

check('C · the report theme never writes to <html>; app chrome inside it re-asserts the app tokens', () => {
  const provider = read('src/components/dashboards/DashboardThemeProvider.tsx');
  assert(!/document\.documentElement\.style|documentElement\.setAttribute/.test(provider),
    'DashboardThemeProvider writes to <html> — a report theme would recolour the whole app');
  const builder = read('src/app/(main)/dashboards/[id]/page.tsx');
  assert(/className=\{`app-chrome sticky top-0/.test(builder), 'the dashboard builder toolbar lost `.app-chrome`');
  assert(/className="app-chrome fixed inset-0/.test(read('src/components/common/Modal.tsx')), 'Modal lost `.app-chrome`');
  assert(/className="app-chrome fixed inset-0/.test(read('src/components/common/AppModalShell.tsx')), 'AppModalShell lost `.app-chrome`');
});

check('D · no dark-era white-alpha classes in the builder; focus ring follows the brand token', () => {
  const builder = read('src/app/(main)/dashboards/[id]/page.tsx');
  const hits = builder.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /rgba\(255,\s*255,\s*255,\s*0?\.\d+\)/.test(l));
  assert(hits.length === 0, `white-alpha colours (invisible on light) at dashboards/[id]/page.tsx:${hits.map(([n]) => n).join(',')}`);
  const tw = read('tailwind.config.js');
  assert(/'focus-brand':\s*'0 0 0 3px rgb\(var\(--brand\)/.test(tw), 'shadow-focus-brand is a literal colour again, not the brand token');
});

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n      ${f.error.message}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`app theme contract: ${passed} checks passed`);
