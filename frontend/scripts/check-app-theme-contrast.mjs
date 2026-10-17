#!/usr/bin/env node
/**
 * App light-theme contrast contract (WCAG 2.2 AA), measured on the REAL token
 * values in src/app/globals.css (`:root`), after alpha compositing where a
 * component paints a token at partial opacity.
 *
 * Text pairs need 4.5:1; essential non-text UI (control borders, focus ring,
 * selected indicators) needs 3:1. A pair that fails here is a token bug, not a
 * component bug: fix the token, not the class.
 *
 * Usage: node scripts/check-app-theme-contrast.mjs [--matrix]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(process.env.APP_THEME_CSS || resolve(HERE, '..', 'src', 'app', 'globals.css'), 'utf8');

/** The light :root block (the first one — `.dark` comes after it). */
const rootStart = css.indexOf(':root {');
const root = css.slice(rootStart, css.indexOf('}', rootStart));
const tokens = {};
for (const m of root.matchAll(/--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
  tokens[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
}

const tok = (name) => {
  const v = tokens[name];
  if (!v) throw new Error(`token --${name} missing from :root`);
  return v;
};
/** `over` painted at `alpha` on top of `under` (what the eye actually sees). */
const mix = (over, alpha, under) => over.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));
const lum = ([r, g, b]) => {
  const ch = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const page = tok('surface-0');
const panel = tok('surface-1');
const hover = tok('surface-2');

// [label, foreground, background, minimum]
const PAIRS = [
  ['text-primary on page', tok('text-primary'), page, 4.5],
  ['text-primary on panel', tok('text-primary'), panel, 4.5],
  ['text-secondary on panel', tok('text-secondary'), panel, 4.5],
  ['text-secondary on hover (surface-2)', tok('text-secondary'), hover, 4.5],
  ['text-tertiary on panel', tok('text-tertiary'), panel, 4.5],
  ['text-tertiary on page', tok('text-tertiary'), page, 4.5],
  ['text-tertiary on hover (surface-2)', tok('text-tertiary'), hover, 4.5],
  ['text-quaternary on panel', tok('text-quaternary'), panel, 4.5],
  ['text-quaternary on page', tok('text-quaternary'), page, 4.5],
  ['text-quaternary on surface-3', tok('text-quaternary'), tok('surface-3'), 4.5],
  ['on-brand on brand (primary button)', tok('text-on-brand'), tok('brand'), 4.5],
  ['on-brand on brand-hover', tok('text-on-brand'), tok('brand-hover'), 4.5],
  ['on-brand on brand-active (pressed)', tok('text-on-brand'), tok('brand-active'), 4.5],
  ['link (brand) on panel', tok('brand'), panel, 4.5],
  ['link (brand) on page', tok('brand'), page, 4.5],
  ['on-brand-container on brand-container (tonal / selected nav)', tok('on-brand-container'), tok('brand-container'), 4.5],
  ['on-brand-container on brand-container-hover', tok('on-brand-container'), tok('brand-container-hover'), 4.5],
  ['success text on success-bg', tok('success'), tok('success-bg'), 4.5],
  ['warning text on warning-bg', tok('warning'), tok('warning-bg'), 4.5],
  ['danger text on danger-bg', tok('danger'), tok('danger-bg'), 4.5],
  ['info text on info-bg', tok('info'), tok('info-bg'), 4.5],
  ['success text on panel', tok('success'), panel, 4.5],
  ['warning text on panel', tok('warning'), panel, 4.5],
  ['danger text on panel', tok('danger'), panel, 4.5],
  // Badges paint the status colour at /10 on a panel — what the reader sees.
  ['warning text on warning/10 badge', tok('warning'), mix(tok('warning'), 0.10, panel), 4.5],
  ['danger text on danger/10 badge', tok('danger'), mix(tok('danger'), 0.10, panel), 4.5],
  ['success text on success/12 badge', tok('success'), mix(tok('success'), 0.12, panel), 4.5],
  ['brand text on brand/10 badge', tok('brand'), mix(tok('brand'), 0.10, panel), 4.5],
  ['tooltip text on surface-inverse', tok('text-on-brand'), tok('surface-inverse'), 4.5],
  // Non-text (WCAG 1.4.11): what tells a user "this is a control / this is focused".
  ['control border on panel', tok('border-control'), panel, 3],
  ['control border on page', tok('border-control'), page, 3],
  ['focus ring (brand) on panel', tok('brand'), panel, 3],
  ['focus ring (brand) on hover', tok('brand'), hover, 3],
  ['selected indicator (brand) on brand-container', tok('brand'), tok('brand-container'), 3],
];

const rows = PAIRS.map(([label, fg, bg, min]) => ({ label, ratio: ratio(fg, bg), min }));
const fails = rows.filter((r) => r.ratio < r.min);
if (process.argv.includes('--matrix')) {
  for (const r of rows) console.log(`${r.ratio >= r.min ? 'PASS' : 'FAIL'}  ${r.ratio.toFixed(2).padStart(5)}:1  (min ${r.min})  ${r.label}`);
}
if (fails.length) {
  for (const f of fails) console.error(`FAIL  ${f.label}: ${f.ratio.toFixed(2)}:1 < ${f.min}:1`);
  console.error(`\n${fails.length} of ${rows.length} contrast pairs fail WCAG 2.2 AA`);
  process.exit(1);
}
console.log(`app theme contrast: ${rows.length} pairs pass WCAG 2.2 AA`);
