#!/usr/bin/env node
/**
 * Theme-menu gate. Run: `node scripts/check-theme-presets.mjs`
 *
 * The menu is two INDEPENDENT choices — a layout template and a colorway — and
 * most of what this checks is that they stay independent. It also guards the
 * three defects that made the whole token layer inert, each of which shipped
 * silently for months because nothing checked them:
 *
 *  1. **The token layer never persisted.** `submit()` built its payload from a
 *     hand-written allow-list with no token keys in it, so the Styles gallery
 *     wrote `cardTreatment` etc. into state, the preview honoured them, and
 *     save dropped every one. A DB sweep found 0 of 33 dashboards carrying a
 *     single token key.
 *  2. **Presets didn't set the tokens at all**, so each fell through to
 *     `SKIN_DEFAULTS` — many menu entries, two actual looks.
 *  3. **Switching entry left the old look behind**, and the survivors
 *     (`cardShadow`, `titleFontSize`) outrank the token layer.
 *
 * Colour checks here are the ones computable exactly. Full CVD separation is
 * validated during authoring with the dataviz validator; this script prints
 * each palette so that run is a copy-paste away.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Line endings are normalised on read. Git's autocrlf rewrites these files to
// CRLF on Windows, and every structural regex below anchors on a bare LF, so a
// silent CRLF conversion made the parser return ZERO templates while the gate
// still reported most of its checks as passing — worse than having no gate.
const readSrc = (rel) => readFileSync(join(root, rel), 'utf8').split('\r\n').join('\n');
const SRC = readSrc('src/components/dashboards/DashboardThemeModal.tsx');
// The catalog lives in lib now, so the resolvers can expand a stored identity
// without importing a React component.
const CATALOG = readSrc('src/lib/dashboard-theme-catalog.ts');
const I18N = readSrc('src/i18n/catalog/dashboards-theme.ts');
const RESOLVER = readSrc('src/lib/dashboard-theme-tokens.ts');

const STRUCTURAL = ['cardTreatment', 'chartChrome', 'kpiStyle', 'tableStyle', 'slicerStyle'];
const LAYOUT_ONLY = STRUCTURAL.concat(['filterDock', 'slicerVariant', 'typoBase', 'density', 'cardRadius']);
const COLOUR_ONLY = ['accent', 'background', 'dataColors', 'goodColor', 'neutralColor', 'badColor'];
const LIGHT_BAND = [0.43, 0.77];
const DARK_BAND = [0.48, 0.67];
const CHROMA_FLOOR = 0.1;

let failures = 0;
const fail = (m) => { failures++; console.error(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);

// ── colour maths ────────────────────────────────────────────────────────────
const lin = (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return m ? [0, 2, 4].map((i) => lin(parseInt(m[1].slice(i, i + 2), 16) / 255)) : null;
};
function oklch(hex) {
  const c = rgb(hex); if (!c) return null;
  const [r, g, b] = c;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, C: Math.hypot(A, B) };
}
const contrast = (a, b) => {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return null;
  const la = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
  const lb = 0.2126 * y[0] + 0.7152 * y[1] + 0.0722 * y[2];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// ── parse the catalog ───────────────────────────────────────────────────────
const between = (a, b) => CATALOG.slice(CATALOG.indexOf(a), b ? CATALOG.indexOf(b) : undefined);
const tplBlock = between('export const TEMPLATES: LayoutTemplate[] = [', 'export const COLORWAYS: Colorway[] = [');
const cwBlock = between('export const COLORWAYS: Colorway[] = [', 'export const LEGACY_PRESET_MAP');
const legacyBlock = between('export const LEGACY_PRESET_MAP');

const entries = (blk) => blk.split(/\n  \{\n/).slice(1);
const parse = (chunk) => {
  const str = (k) => (new RegExp(`\\b${k}: '([^']+)'`).exec(chunk) || [])[1];
  const num = (k) => { const m = new RegExp(`\\b${k}: (\\d+)`).exec(chunk); return m ? Number(m[1]) : undefined; };
  const cols = (/dataColors: \[([^\]]+)\]/.exec(chunk) || [])[1];
  return {
    raw: chunk,
    id: str('id'), labelKey: str('label'), hintKey: str('hint'),
    mode: str('mode'), background: str('background'), accent: str('accent'),
    filterDock: str('filterDock'), slicerVariant: str('slicerVariant'),
    typoBase: num('typoBase'), density: str('density'),
    tokens: Object.fromEntries(STRUCTURAL.map((k) => [k, str(k)])),
    dataColors: cols ? cols.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean) : [],
  };
};
const templates = entries(tplBlock).map(parse);
const colorways = entries(cwBlock).map(parse);

console.log(`\nTheme menu gate — ${templates.length} layouts × ${colorways.length} colorways = ${templates.length * colorways.length} looks\n`);

// ── 0. the two axes stay independent ────────────────────────────────────────
console.log('[separation] a layout carries no paint; a colour carries no layout');
for (const t of templates) {
  const leaks = COLOUR_ONLY.filter((k) => new RegExp(`\\b${k}:`).test(t.raw));
  if (leaks.length) fail(`layout "${t.id}" carries colour keys (${leaks.join(', ')}) — picking it would repaint the report`);
}
for (const c of colorways) {
  const leaks = LAYOUT_ONLY.filter((k) => new RegExp(`\\b${k}:`).test(c.raw));
  if (leaks.length) fail(`colorway "${c.id}" carries layout keys (${leaks.join(', ')}) — repainting would move things`);
}
if (!failures) pass('the two axes do not bleed into each other');

// ── 1. each layout is a distinct composition ────────────────────────────────
console.log('\n[layouts] each template is a different composition, not a recolour');
for (const t of templates) {
  const missing = STRUCTURAL.filter((k) => !t.tokens[k]);
  if (missing.length) fail(`${t.id}: missing ${missing.join(', ')}`);
  if (!t.filterDock || !t.slicerVariant) fail(`${t.id}: no filter composition`);
}
const comps = new Set(templates.map((t) => `${t.filterDock}/${t.slicerVariant}`));
if (comps.size !== templates.length) {
  fail(`${comps.size} distinct filter compositions across ${templates.length} layouts — two entries are the same layout in different paint`);
} else {
  pass(`${templates.length} layouts, all distinct: ${[...comps].join('  ')}`);
}
const scales = new Set(templates.map((t) => `${t.typoBase}/${t.density}`));
if (scales.size < 3) fail(`only ${scales.size} type/density combinations — the layouts differ too little to feel different`);
else pass(`${scales.size} distinct type-scale + density combinations`);

// ── 2. saved dashboards still open on something ─────────────────────────────
console.log('\n[migration] every pre-rework preset maps onto a layout + colour that exist');
const mapped = [...legacyBlock.matchAll(/'([\w-]+)':\s*\{ template: '(\w+)',\s*colorway: '(\w+)' \}/g)];
if (!mapped.length) fail('LEGACY_PRESET_MAP is empty — saved dashboards would open with nothing selected');
else {
  const bad = mapped.filter(([, , tp, cw]) =>
    !templates.some((t) => t.id === tp) || !colorways.some((c) => c.id === cw));
  if (bad.length) fail(`legacy map points at entries that do not exist: ${bad.map((m) => m[1]).join(', ')}`);
  else pass(`${mapped.length} legacy presets migrate cleanly`);
}

// ── 3. the save path carries every token the resolver reads ─────────────────
console.log('\n[persistence] the resolver reads it, so save must write it');
const tokenKeys = (/const TOKEN_KEYS = \[([\s\S]*?)\] as const;/.exec(SRC) || [])[1];
const keyList = tokenKeys ? [...tokenKeys.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]) : [];
if (!keyList.length) fail('TOKEN_KEYS not found');
else pass(`TOKEN_KEYS lists ${keyList.length} keys`);
const HANDLED_ELSEWHERE = new Set(['skin', 'cardShadow']);
const read = [...new Set([...RESOLVER.matchAll(/raw\.([A-Za-z]+)/g)].map((m) => m[1]))];
const unpersisted = read.filter((k) => !keyList.includes(k) && !HANDLED_ELSEWHERE.has(k));
if (unpersisted.length) fail(`resolveStyleTokens reads but submit() never saves: ${unpersisted.join(', ')}`);
else pass('every key resolveStyleTokens reads is persisted');
if (SRC.includes('pickTokenKeys(initial as any)') && SRC.includes('pickTokenKeys(theme as any)')) {
  pass('seed and submit both derive from TOKEN_KEYS');
} else fail('seed and submit must both derive from TOKEN_KEYS');

// ── 4. switching an entry clears the previous one ───────────────────────────
console.log('\n[switching] the previous choice must not survive the new one');
const applyTpl = SRC.slice(SRC.indexOf('const applyTemplate'), SRC.indexOf('const applyColorway'));
const applyCw = SRC.slice(SRC.indexOf('const applyColorway'), SRC.indexOf('const setSkin'));
if (!applyTpl.includes('for (const k of TEMPLATE_KEYS) cleared[k] = undefined')) {
  fail('applyTemplate does not clear TEMPLATE_KEYS — the previous layout sticks');
} else pass('applyTemplate clears TEMPLATE_KEYS');
if (!applyCw.includes('for (const k of COLORWAY_KEYS) cleared[k] = undefined')) {
  fail('applyColorway does not clear COLORWAY_KEYS — the previous palette sticks');
} else pass('applyColorway clears COLORWAY_KEYS');
// A colour must not touch layout keys even by accident.
if (LAYOUT_ONLY.some((k) => new RegExp(`\\b${k}:`).test(applyCw))) {
  fail('applyColorway writes layout keys — repainting would move the report');
} else pass('applyColorway touches paint only');

// ── 5. labels exist in both locales ─────────────────────────────────────────
console.log('\n[labels] every entry is named in EN and VI');
const enBlock = I18N.slice(I18N.indexOf('en: {'), I18N.indexOf('vi: {'));
const viBlock = I18N.slice(I18N.indexOf('vi: {'));
const needed = [...templates, ...colorways].flatMap((x) => [x.labelKey, x.hintKey]).filter(Boolean);
for (const [name, blk] of [['en', enBlock], ['vi', viBlock]]) {
  const missing = needed.filter((k) => !blk.includes(`'${k}'`));
  if (missing.length) fail(`${name} missing ${missing.length}: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`);
}
if (needed.every((k) => enBlock.includes(`'${k}'`) && viBlock.includes(`'${k}'`))) {
  pass(`${needed.length} labels present in both EN and VI`);
}

// ── 6. palette floors ───────────────────────────────────────────────────────
console.log('\n[palettes] lightness band · chroma floor · visibility on their own ground');
for (const c of colorways) {
  const dark = c.mode === 'dark';
  const [lo, hi] = dark ? DARK_BAND : LIGHT_BAND;
  // A gradient background: take the last stop, the colour most of the page shows.
  const bg = (c.background || '').match(/#[0-9a-f]{6}/gi)?.pop() || (dark ? '#111111' : '#ffffff');
  if (!c.dataColors.length) { fail(`${c.id}: no dataColors`); continue; }
  const offBand = c.dataColors.filter((x) => { const o = oklch(x); return !o || o.L < lo || o.L > hi; });
  const grey = c.dataColors.filter((x) => { const o = oklch(x); return !o || o.C < CHROMA_FLOOR; });
  // 1.5:1 is the "cannot see it at all" line — a preset once shipped #fff1f1 at 1.07.
  const invisible = c.dataColors.filter((x) => (contrast(x, bg) ?? 0) < 1.5);
  if (offBand.length) fail(`${c.id}: outside the ${dark ? 'dark' : 'light'} lightness band → ${offBand.join(' ')}`);
  if (grey.length) fail(`${c.id}: reads grey (chroma < ${CHROMA_FLOOR}) → ${grey.join(' ')}`);
  if (invisible.length) fail(`${c.id}: invisible on its own background → ${invisible.join(' ')}`);
}
if (colorways.every((c) => c.dataColors.length)) {
  const worst = colorways.map((c) => {
    const bg = (c.background || '').match(/#[0-9a-f]{6}/gi)?.pop() || (c.mode === 'dark' ? '#111111' : '#ffffff');
    return Math.min(...c.dataColors.map((x) => contrast(x, bg) ?? 99));
  });
  pass(`all ${colorways.length} palettes inside band + above chroma floor; lowest contrast ${Math.min(...worst).toFixed(2)}:1`);
}

// ── 7. correctness guards ───────────────────────────────────────────────────
// Every one of these caught a real regression during the rework, and not one of
// them is visible to a type-check.
console.log('\n[correctness] regressions type-checking cannot see');
const GRID = readSrc('src/components/dashboards/DashboardGrid.tsx');
const CLUSTER = readSrc('src/components/dashboards/SlicerCluster.tsx');

// (a) Hooks must precede every early return. Three of them once sat BELOW the
//     empty-state guard, so a dashboard gaining its first chart changed the
//     hook count between renders and threw React #300.
const earlyReturn = GRID.indexOf('if (dashboardCharts.length === 0) {');
const gridHook = GRID.indexOf('const gridWrapRef');
if (earlyReturn < 0 || gridHook < 0) fail('DashboardGrid: cannot locate the early return / grid hooks');
else if (gridHook > earlyReturn) fail('DashboardGrid: hooks declared AFTER the empty-state early return — React #300 the moment a dashboard gains its first chart');
else pass('DashboardGrid hooks run before every early return');

// (b) A template must wipe the pre-token look keys, which outrank the tokens.
if (!applyTpl.includes('for (const k of LEGACY_LOOK_KEYS) cleared[k] = undefined')) {
  fail('applyTemplate does not clear LEGACY_LOOK_KEYS — a stale cardShadow / titleFontSize outranks the template just picked');
} else pass('applyTemplate clears legacy look overrides');

// (c) Dock direction must read the AUTHOR value, not the DEFAULT_LAYOUT-merged
//     one, or a theme-supplied rail lays its slicers out in a row.
// A rail's direction is implied, never stored: DEFAULT_LAYOUT writes
// `direction: 'horizontal'` into every draft, so any stored value is
// indistinguishable from a choice and contradicts the dock.
if (/direction:\s*baseLayout\.direction/.test(CLUSTER)
    || /direction:\s*layout\?\.direction\s*\?\?/.test(CLUSTER)) {
  fail('SlicerCluster takes a rail direction from stored layout — a 280px column would lay its slicers out in a row');
} else if (!/const isVertical = isRail \|\| dock === 'drawer'/.test(CLUSTER)
  || !/direction: isVertical/.test(CLUSTER)) {
  fail('rail/drawer direction is not derived from the dock');
} else pass('rail + drawer direction derives from the dock, never from a stored default');

if (!/stackVertical=\{isVertical\}/.test(CLUSTER)) {
  fail('drawer declares vertical direction but its slicer cards are still rendered as a row');
} else if (!/verticalPopoverPlacement=\{dock === 'left' \? 'right' : 'left'\}/.test(CLUSTER)) {
  fail('right rail/drawer popovers can open outside the viewport');
} else pass('rails + drawer stack vertically and open popovers toward the report');

// (d) A data prop called `children` shadows React's own.
if (/^\s*children: any\[\];/m.test(CLUSTER)) {
  fail('SlicerCluster takes a `children` data prop — shadows React children');
} else pass('SlicerCluster takes `items`, not `children`');

// (e) Both identities persist, not just the legacy single id.
const missingIds = ['templateId', 'colorwayId'].filter((k) => !keyList.includes(k));
if (missingIds.length) fail(`${missingIds.join(' + ')} not in TOKEN_KEYS — the menu would forget which layout/colour is active`);
else pass('templateId + colorwayId both persist');

// (f) A theme saved as nothing but an identity must expand into real tokens,
//     or a dashboard stored as `{templateId:'ops'}` renders top-dock /
//     executive / 14px — stock Classic, i.e. not Ops at all.
if (!CATALOG.includes('export function expandThemeIdentity')) {
  fail('no expandThemeIdentity — a theme saved as templateId/colorwayId resolves to the classic defaults');
} else if (!RESOLVER.includes('expandThemeIdentity(theme)')) {
  fail('resolveStyleTokens does not expand the theme identity');
} else pass('a stored template/colorway identity expands into real tokens');

// (g) Applying a template must release a stored filter dock. `DEFAULT_LAYOUT`
//     writes `position: 'top'` into every draft save, so a dashboard that has
//     merely been EDITED holds a stored dock indistinguishable from a
//     deliberate placement — and it outranks the template's own dock. Measured
//     on dash 67: theme resolved `filterDock: left`, draft held `'top'`, the
//     rail never moved. Same shape as the DEFAULT_STYLE_CONFIG trap.
const PAGE = readSrc('src/app/(main)/dashboards/[id]/page.tsx');
if (!PAGE.includes('releaseDock')) {
  fail('theme save never releases slicer_cluster_layout.position — a stored default outranks every template dock');
} else if (!PAGE.includes('releaseDock: Boolean((theme as any)?.templateId)')) {
  fail('the dock is released unconditionally — only picking a TEMPLATE should reset an author placement');
} else if (!PAGE.includes('position: undefined, direction: undefined')) {
  fail('template switch releases the dock but leaves a stale direction behind');
} else pass('picking a template releases a stale stored dock and direction');

// ── The import layout engine ────────────────────────────────────────────────
//
// A template is a COMPOSITION, and the composition is decided on the server
// while the menu that names it lives here. The two halves have drifted before,
// silently: the importer emitted `presentation`, the catalog offered `stage`,
// and every report imported as that family fell back to the classic look with
// no error anywhere. These checks make that drift loud.
const IMPORTER = readSrc('../backend/app/services/dashboard_html_import_service.py');
const SANITIZER = readSrc('../backend/app/services/html_fragment_sanitizer.py');
const EXTRACTOR = readSrc('src/lib/dashboard-html-import.ts');
const WIDGET = readSrc('src/components/dashboards/DashboardWidget.tsx');

const familyMatch = IMPORTER.match(/IMPORT_TEMPLATE_FAMILIES = \(([^)]*)\)/);
const beFamilies = familyMatch
  ? [...familyMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
  : [];
const feTemplateIds = templates.map((t) => t.id).sort();
if (beFamilies.length === 0) {
  fail('could not parse IMPORT_TEMPLATE_FAMILIES from the importer');
} else if (beFamilies.join(',') !== feTemplateIds.join(',')) {
  fail(`template ids out of sync — importer has [${beFamilies}], catalog has [${feTemplateIds}]`);
} else pass(`importer and catalog name the same ${beFamilies.length} templates`);

// Every family needs a recipe. A missing one silently falls back to `console`,
// so the template is selectable, saveable, and does nothing.
const recipeIds = [...IMPORTER.matchAll(/^    "([a-z_]+)": \{\n        "filter_dock"/gm)].map((m) => m[1]).sort();
if (recipeIds.join(',') !== beFamilies.join(',')) {
  fail(`every family needs a layout recipe — have [${recipeIds}], need [${beFamilies}]`);
} else pass('every template family has its own layout recipe');

// Recipes must differ in SHAPE, not only in name. Two families whose bands and
// per-kind shapes are identical are one family with two labels — which is the
// state the whole two-axis rework existed to get out of.
const recipeBodies = [...IMPORTER.matchAll(/^    "([a-z_]+)": \{\n        "filter_dock": "([a-z]+)",\n([\s\S]*?)\n    \},/gm)];
const shapes = new Map();
for (const [, id, dock, body] of recipeBodies) {
  const bands = [...body.matchAll(/"name": "([a-z_]+)", "kinds": \[([^\]]*)\], "cols": (\d+), "h": (\d+)/g)]
    .map((m) => `${m[1]}(${m[3]}x${m[4]})`).join('+');
  const flow = [...body.matchAll(/"([a-z_]+)": \{"cols": (\d+), "h": (\d+)(, "full": True)?\}/g)]
    .map((m) => `${m[1]}:${m[2]}x${m[3]}${m[4] ? 'F' : ''}`).join('|');
  shapes.set(id, `${dock}/${bands}/${flow}`);
}
const duplicates = [...shapes.entries()].filter(([id, sig], i, all) =>
  all.some(([otherId, otherSig]) => otherId !== id && otherSig === sig));
const unparsed = [...shapes.entries()].filter(([, sig]) => sig.endsWith('//') || sig.split('/')[2] === '');
if (recipeBodies.length !== beFamilies.length) {
  fail(`could not parse all recipe bodies — parsed ${recipeBodies.length} of ${beFamilies.length}`);
} else if (unparsed.length) {
  fail(`recipe bodies parsed but carry no shapes: ${unparsed.map(([id]) => id).join(', ')}`);
} else if (duplicates.length) {
  fail(`recipes are not distinct compositions: ${duplicates.map(([id]) => id).join(', ')} share a shape`);
} else pass(`all ${recipeBodies.length} recipes are distinct compositions, not relabelled copies`);

// Recipe heights are in 12-column units, and the runtime grid is 36 columns
// (GRID_FINER = 3), so one unit of `h` buys three runtime rows. MEASURED on a
// live grid: rendered height = 96 * h - 16 px. Written as if `h` meant a single
// 80px row, the recipes produced tiles 2.5x too tall and a four-chart report
// came out five thousand pixels tall, mostly white.
//
// The constant is measured rather than recomputed here on purpose: it depends
// on the runtime grid margin, and a formula that drifts from what the browser
// actually does is worse than a number with a note on it.
const H_UNIT_PX = 96;
const H_MAX_PX = 700; // a tile taller than this is a scroll, not a layout
if (!/GRID_FINER = 3/.test(readSrc('src/lib/dashboard-pages.ts'))) {
  fail('GRID_FINER changed — the recipe heights are calibrated against x3 and must be re-measured');
} else {
  const tall = [];
  let heightCount = 0;
  for (const [, id, , body] of recipeBodies) {
    for (const m of body.matchAll(/"([a-z_]+)": \{"cols": \d+, "h": (\d+)/g)) {
      heightCount += 1;
      const px = Number(m[2]) * H_UNIT_PX - 16;
      if (px > H_MAX_PX) tall.push(`${id}.${m[1]}=${px}px`);
    }
  }
  if (tall.length) {
    fail(`recipe tiles are taller than a viewport: ${tall.slice(0, 5).join(', ')}`);
  } else pass(`all ${heightCount} recipe tile heights fit a viewport (one h unit = ${H_UNIT_PX}px)`);
}

// The template owns shape; the DOCUMENT owns order. A recipe that sorts blocks
// into a band per kind stacks a report's section headers on top of one another
// at the very top, introducing nothing.
if (!/"flow": \{/.test(IMPORTER)) {
  fail('recipes have no per-kind flow shapes — blocks are being sorted into bands by kind');
} else if (/def _order_by_regions/.test(IMPORTER)) {
  fail('the region re-sorter is back — it detaches a section header from the tiles it introduces');
} else pass('the template supplies shape, the source supplies order');

// Charts and widgets must be packed by ONE call. Packing them separately is
// what left every widget at (0,0), stacking each section header on top of the
// first chart. The old per-tile packer must not be reachable from import.
if (/_assign_layouts\(finalized_plans\)/.test(IMPORTER)) {
  fail('import still calls the size-hint packer — widgets will arrive with no coordinates');
} else if (!/def compose_import_layout\(/.test(IMPORTER)) {
  fail('no compose_import_layout — charts and widgets are not packed together');
} else pass('charts and widgets go through one layout pipeline');

if (!IMPORTER.includes('_place_generated_layouts_around_authored(declared, free)')) {
  fail('partially-authored imports can place generated tiles on declared coordinates');
} else pass('generated tiles avoid coordinates authored by the source');

if (/for block in candidates\[:\d+\]/.test(IMPORTER)) {
  fail('composition prompt only sees chart candidates, not headings/notes/controls');
} else pass('composition prompt sees structural blocks, not charts alone');

// A widget type the backend can emit but the renderer cannot draw shows up as
// "Unknown widget" in the middle of a report.
const emitted = [...IMPORTER.matchAll(/widget_type = "([a-z_]+)"/g)].map((m) => m[1]);
const rendered = [...WIDGET.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
const orphans = [...new Set(emitted)].filter((w) => !rendered.includes(w));
if (orphans.length) {
  fail(`importer emits widget types the renderer has no case for: ${orphans.join(', ')}`);
} else pass(`every emitted widget type has a renderer (${[...new Set(emitted)].join(', ')})`);

// The build path has its own allow-list, and a kind missing from it is
// rewritten to "chart" with no chart behind it -- the tile then renders "Failed
// to load chart" while its correct widget_config sits unused in the row. Three
// section headers shipped that way. Emit, allow, render: all three must agree.
const allowMatch = IMPORTER.match(/IMPORT_WIDGET_TYPES = \{([^}]*)\}/);
const allowed = allowMatch ? [...allowMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
if (allowed.length === 0) {
  fail('could not parse IMPORT_WIDGET_TYPES from the importer');
} else {
  const notAllowed = [...new Set(emitted)].filter((w) => !allowed.includes(w));
  const notRendered = allowed.filter((w) => w !== 'chart' && !rendered.includes(w));
  if (notAllowed.length) {
    fail(`the importer emits widget types the build path rewrites to "chart": ${notAllowed.join(', ')}`);
  } else if (notRendered.length) {
    fail(`the build path persists widget types the renderer cannot draw: ${notRendered.join(', ')}`);
  } else pass(`emit, persist and render agree on all ${allowed.length} widget kinds`);
}

// The fragment sanitizer is a security boundary, and it has to sit at the
// point content is STORED. Sanitizing only during analysis says nothing about
// what arrives: the analyze response round-trips through the browser first.
const SERVICE = readSrc('../backend/app/services/dashboard_service.py');
if (!SERVICE.includes('sanitize_html_fragment')) {
  fail('html_fragment is not sanitized where it is persisted — stored XSS');
} else pass('preserved fragments are sanitized at the persistence boundary');

// Appearance capture only means anything against a RENDERED document.
if (!EXTRACTOR.includes('withRenderedSource')) {
  fail('no offscreen stage — fragment capture reads an inert document and freezes empty styles');
} else if (!/const view = element\.ownerDocument\?\.defaultView/.test(EXTRACTOR)) {
  fail("captureFragment reads the app's window instead of the staged document's");
} else pass('fragment capture measures a rendered document, through its own window');

// ── The declarative import path ─────────────────────────────────────────────
//
// Two ways in: the document declares its plan, or the importer infers one.
// Inferring was measured across four runs of one fixture producing three
// different layout families and, once, an invented column that failed all ten
// charts at once. The declared path exists to remove that, and these checks
// keep it wired up.
const SKILL = readSrc('../backend/app/services/dashboard_import_skill.py');
const DATASETS_API = readSrc('../backend/app/api/datasets.py');
const IMPORT_MODAL = readSrc('src/components/dashboards/DashboardHtmlImportModal.tsx');

if (!/def build_import_skill\(/.test(SKILL)) {
  fail('no skill generator — nothing tells an author which columns exist');
} else if (!/import-skill/.test(DATASETS_API)) {
  fail('the skill generator has no endpoint, so nobody can get the file');
} else if (!/downloadImportSkill/.test(IMPORT_MODAL)) {
  fail('the endpoint has no button in the import dialog');
} else pass('a dataset can be turned into a skill, and the dialog offers it');

// The contract is a lock, not a hint. Comparing table NAMES only let a file
// written for another dataset import cleanly and have every column re-guessed.
if (!/expected_columns/.test(SKILL)) {
  fail('the source contract does not record which columns the file uses');
} else if (!/schema_fingerprint/.test(SKILL)) {
  fail('no schema fingerprint — a drifted dataset cannot be told from a wrong one');
} else if (!/raise SourceContractMismatch/.test(IMPORTER)) {
  fail('a contract mismatch is warned about, not refused');
} else pass('a file written for other data is refused, naming the columns');

// A declared plan owns its tiles. Falling through to inference alongside it
// produced every heading twice, and the derived copies landed on the charts.
if (!/def widgets_from_plan\(/.test(IMPORTER)) {
  fail('declared widgets are ignored — headings and notes get re-derived from markup');
} else if (!/_declared_widgets or widgets_from_blocks/.test(IMPORTER)) {
  fail('inference still runs alongside a declared plan');
} else pass('a declared plan owns its widgets');

// Declared-ness belongs to a tile, not to charts: the rule was chart-only, so a
// declared section header at y=2 was repacked onto the first KPI at y=0.
if (!/everything = list\(chart_plans\) \+ list\(widgets\)/.test(IMPORTER)) {
  fail('declared layouts are protected for charts only — widget positions get overwritten');
} else pass('a declared layout survives for every kind of tile');

// Before Build, a person needs to see the arrangement, not just a pass/fail
// list per chart. Those are different questions.
if (!/ImportLayoutPreview/.test(IMPORT_MODAL)) {
  fail('the preview step shows validation only — no way to check the layout before building');
} else pass('the preview shows where every tile will land');

// A widget's config keys are a contract between two files, and it has now been
// broken three times: section_header, callout and hero_strip each shipped
// rendering blank because the server normalized to one key name and the
// renderer read another. The text sat in the database the whole time.
//
// Checked by slicing rather than matching: a regex here would be one more thing
// that can silently match nothing and report success.
const SERVICE_SRC = readSrc('../backend/app/services/dashboard_service.py');
const WIDGET_KEY_CONTRACT = [
  { type: 'section_header', component: 'SectionHeaderWidget', keys: ['title', 'subtitle'] },
  { type: 'callout', component: 'CalloutWidget', keys: ['text', 'tone'] },
  { type: 'hero_strip', component: 'HeroStripWidget', keys: ['headline', 'subhead'] },
  { type: 'html_fragment', component: 'HtmlFragmentWidget', keys: ['html'] },
];
const sliceBetween = (source, start, ends) => {
  const from = source.indexOf(start);
  if (from < 0) return null;
  let to = source.length;
  for (const end of ends) {
    const at = source.indexOf(end, from + start.length);
    if (at >= 0 && at < to) to = at;
  }
  return source.slice(from, to);
};
const keyMismatches = [];
let keysChecked = 0;
for (const { type, component, keys } of WIDGET_KEY_CONTRACT) {
  const normalizer = sliceBetween(SERVICE_SRC, `wt == "${type}"`, ['elif wt ==', '\n    return config']);
  const renderer = sliceBetween(WIDGET, `function ${component}(`, ['\nfunction ']);
  if (!normalizer || !renderer) {
    keyMismatches.push(`${type}: no normalizer branch or no ${component}`);
    continue;
  }
  for (const key of keys) {
    keysChecked += 1;
    const stored = normalizer.includes(`"${key}"`);
    const read = renderer.includes(`config.${key}`);
    if (stored && !read) keyMismatches.push(`${type}.${key} is stored but never read`);
    if (!stored && read) keyMismatches.push(`${type}.${key} is read but never stored`);
  }
}
if (keyMismatches.length) {
  fail(`widget config keys disagree: ${keyMismatches.slice(0, 4).join('; ')}`);
} else pass(`server and renderer agree on all ${keysChecked} widget config keys`);

console.log('\nFor the CVD gate, run each palette through the dataviz validator:');
for (const c of colorways) console.log(`  ${c.id.padEnd(10)} ${c.dataColors.join(',')}`);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll theme-menu checks passed.\n');
process.exit(failures ? 1 : 0);
