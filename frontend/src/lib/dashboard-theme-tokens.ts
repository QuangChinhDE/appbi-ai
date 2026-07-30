import type { DashboardThemeConfig } from '@/types/api';

/**
 * The dashboard design system, expressed as tokens.
 *
 * Why this file exists: "Modern" used to be a closed look — a `skin` flag plus a
 * block of hard-coded CSS. You could pick it or not pick it, and the moment you
 * wanted your brand's accent with a flatter card you were back to the classic
 * flat style. Here every trait of a skin (accent bar, tint, shadow, gridlines,
 * type scale, table banding, slicer shape…) is a NAMED TOKEN with a small set of
 * designed values.
 *
 * Two consequences worth stating, because they drive the whole design:
 *
 *  1. **Customisation is bounded.** A user picks `cardTreatment: 'glass'`, not a
 *     blur radius and an alpha. Every option here was designed to look right
 *     with every other option, which is what keeps a heavily customised report
 *     from turning ugly — the failure mode of a free-form CSS box.
 *  2. **Coverage is free.** The tokens resolve to CSS variables + data
 *     attributes on ONE wrapper element, so a table, a slicer, a widget and a
 *     chart all pick up the same theme without each component growing its own
 *     theming code. Adding a surface later means adding CSS, not plumbing.
 */

// ── Style vocabularies ───────────────────────────────────────────────────────

export type SkinId = 'modern' | 'classic';
export type CardTreatment = 'clean' | 'soft' | 'tinted' | 'elevated' | 'glass' | 'outline' | 'frameless';
export type ChartChrome = 'clean' | 'minimal' | 'executive' | 'editorial' | 'vibrant';
export type KpiStyle = 'minimal' | 'accent' | 'tinted' | 'gradient' | 'benchmark' | 'icon' | 'status';
export type TableStyle = 'clean' | 'compact' | 'financial' | 'zebra' | 'executive';
export type SlicerStyle = 'card' | 'pill' | 'compact' | 'glass' | 'minimal';
export type AccentBarPosition = 'top' | 'bottom' | 'left' | 'right' | 'none';

export const CARD_TREATMENTS: CardTreatment[] = ['clean', 'soft', 'tinted', 'elevated', 'glass', 'outline', 'frameless'];
export const CHART_CHROMES: ChartChrome[] = ['clean', 'minimal', 'executive', 'editorial', 'vibrant'];
export const KPI_STYLES: KpiStyle[] = ['minimal', 'accent', 'tinted', 'gradient', 'benchmark', 'icon', 'status'];
export const TABLE_STYLES: TableStyle[] = ['clean', 'compact', 'financial', 'zebra', 'executive'];
export const SLICER_STYLES: SlicerStyle[] = ['card', 'pill', 'compact', 'glass', 'minimal'];

/** Card traits each treatment implies. Numbers are the DEFAULTS a treatment
 *  starts from; Advanced mode may override any of them individually. */
export const CARD_TREATMENT_TOKENS: Record<CardTreatment, {
  accentBar: AccentBarPosition;
  accentSize: number;   // px
  tint: number;         // 0..100, % of accent mixed into the card head
  shadow: 'none' | 'sm' | 'md' | 'lg';
  border: 'none' | 'hairline' | 'strong';
  blur: number;         // px backdrop blur (glass)
  opacity: number;      // 0..1 card background opacity
}> = {
  clean:      { accentBar: 'none',  accentSize: 0, tint: 0,  shadow: 'sm',   border: 'hairline', blur: 0,  opacity: 1 },
  soft:       { accentBar: 'top',   accentSize: 3, tint: 7,  shadow: 'md',   border: 'hairline', blur: 0,  opacity: 1 },
  tinted:     { accentBar: 'left',  accentSize: 4, tint: 12, shadow: 'sm',   border: 'hairline', blur: 0,  opacity: 1 },
  elevated:   { accentBar: 'top',   accentSize: 3, tint: 5,  shadow: 'lg',   border: 'none',     blur: 0,  opacity: 1 },
  glass:      { accentBar: 'top',   accentSize: 2, tint: 10, shadow: 'md',   border: 'hairline', blur: 14, opacity: 0.86 },
  outline:    { accentBar: 'none',  accentSize: 0, tint: 0,  shadow: 'none', border: 'strong',   blur: 0,  opacity: 1 },
  frameless:  { accentBar: 'none',  accentSize: 0, tint: 0,  shadow: 'none', border: 'none',     blur: 0,  opacity: 1 },
};

export const SHADOW_TOKENS: Record<'none' | 'sm' | 'md' | 'lg', string> = {
  none: 'none',
  sm: '0 1px 2px rgba(20, 26, 42, .05)',
  md: '0 1px 2px rgba(20, 26, 42, .05), 0 10px 26px -14px rgba(20, 26, 42, .28)',
  lg: '0 2px 4px rgba(20, 26, 42, .06), 0 28px 64px -40px rgba(15, 23, 42, .52)',
};

/** Chart chrome traits. Charts read these through the theme context. */
export const CHART_CHROME_TOKENS: Record<ChartChrome, {
  gridlines: 'none' | 'light' | 'solid' | 'dashed';
  axisLine: boolean;
  barRadius: number;      // px
  lineWidth: number;      // px
  areaOpacity: number;    // 0..1
  legend: 'default' | 'compact' | 'hidden';
  plotBackground: 'none' | 'tint';
  dataLabels: 'off' | 'auto' | 'always';
}> = {
  clean:     { gridlines: 'light',  axisLine: false, barRadius: 6, lineWidth: 2,   areaOpacity: 0.18, legend: 'default', plotBackground: 'none', dataLabels: 'auto' },
  minimal:   { gridlines: 'none',   axisLine: false, barRadius: 8, lineWidth: 2,   areaOpacity: 0.12, legend: 'compact', plotBackground: 'none', dataLabels: 'off' },
  executive: { gridlines: 'light',  axisLine: true,  barRadius: 2, lineWidth: 2.5, areaOpacity: 0.10, legend: 'default', plotBackground: 'none', dataLabels: 'always' },
  editorial: { gridlines: 'dashed', axisLine: false, barRadius: 4, lineWidth: 3,   areaOpacity: 0.22, legend: 'compact', plotBackground: 'tint', dataLabels: 'auto' },
  vibrant:   { gridlines: 'solid',  axisLine: true,  barRadius: 10, lineWidth: 3.5, areaOpacity: 0.32, legend: 'default', plotBackground: 'tint', dataLabels: 'always' },
};

/**
 * Typography ROLES. One shared font size for a dozen different things is why a
 * report reads flat — an axis tick and a dashboard title have no business being
 * the same size. Each role carries a multiplier off the base size so changing
 * one number rescales the whole report proportionally.
 */
export const TYPOGRAPHY_ROLES = [
  { key: 'dashboardTitle', scale: 1.45, weight: 700 },
  { key: 'pageTitle',      scale: 1.20, weight: 600 },
  { key: 'sectionTitle',   scale: 1.05, weight: 600 },
  { key: 'chartTitle',     scale: 1.00, weight: 600 },
  { key: 'chartSubtitle',  scale: 0.86, weight: 400 },
  { key: 'kpiValue',       scale: 2.60, weight: 700 },
  { key: 'kpiLabel',       scale: 0.86, weight: 500 },
  { key: 'axisLabel',      scale: 0.82, weight: 400 },
  { key: 'legend',         scale: 0.82, weight: 400 },
  { key: 'dataLabel',      scale: 0.78, weight: 500 },
  { key: 'tableHeader',    scale: 0.84, weight: 600 },
  { key: 'tableBody',      scale: 0.86, weight: 400 },
  { key: 'filterLabel',    scale: 0.78, weight: 500 },
] as const;

export type TypographyRole = (typeof TYPOGRAPHY_ROLES)[number]['key'];

/** Base font size (px) the role scale multiplies. */
export const TYPO_BASE_DEFAULT = 14;

// ── Skin defaults ────────────────────────────────────────────────────────────

/** What each skin means when the user hasn't overridden anything. Modern's
 *  values are exactly what the hand-written Modern CSS used to hard-code, so
 *  turning the skin into tokens changed nothing visually. */
export const SKIN_DEFAULTS: Record<SkinId, {
  cardTreatment: CardTreatment;
  chartChrome: ChartChrome;
  kpiStyle: KpiStyle;
  tableStyle: TableStyle;
  slicerStyle: SlicerStyle;
  radius: number;
}> = {
  modern:  { cardTreatment: 'soft',  chartChrome: 'clean',     kpiStyle: 'accent',  tableStyle: 'clean', slicerStyle: 'card',    radius: 16 },
  classic: { cardTreatment: 'clean', chartChrome: 'executive', kpiStyle: 'minimal', tableStyle: 'zebra', slicerStyle: 'compact', radius: 8 },
};

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedStyleTokens {
  skin: SkinId;
  cardTreatment: CardTreatment;
  chartChrome: ChartChrome;
  kpiStyle: KpiStyle;
  tableStyle: TableStyle;
  slicerStyle: SlicerStyle;
  accentBar: AccentBarPosition;
  accentSize: number;
  tint: number;
  shadow: string;
  border: 'none' | 'hairline' | 'strong';
  blur: number;
  cardOpacity: number;
  typoBase: number;
  chart: (typeof CHART_CHROME_TOKENS)[ChartChrome];
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Resolve a stored theme into the full token set.
 *
 * Layering, in order of increasing authority: skin default → the style the user
 * picked (card/chart/KPI/table/slicer) → an individual Advanced-mode override.
 * A missing value at any level falls through to the one below, which is what
 * makes "change one thing, keep the look" work.
 */
export function resolveStyleTokens(theme?: DashboardThemeConfig | null): ResolvedStyleTokens {
  const raw = (theme ?? {}) as Record<string, unknown>;
  const skin: SkinId = raw.skin === 'modern' ? 'modern' : 'classic';
  const d = SKIN_DEFAULTS[skin];

  const cardTreatment = pick<CardTreatment>(raw.cardTreatment, CARD_TREATMENTS, d.cardTreatment);
  const chartChrome = pick<ChartChrome>(raw.chartChrome, CHART_CHROMES, d.chartChrome);
  const kpiStyle = pick<KpiStyle>(raw.kpiStyle, KPI_STYLES, d.kpiStyle);
  const tableStyle = pick<TableStyle>(raw.tableStyle, TABLE_STYLES, d.tableStyle);
  const slicerStyle = pick<SlicerStyle>(raw.slicerStyle, SLICER_STYLES, d.slicerStyle);

  const base = CARD_TREATMENT_TOKENS[cardTreatment];
  const chartBase = CHART_CHROME_TOKENS[chartChrome];

  return {
    skin,
    cardTreatment,
    chartChrome,
    kpiStyle,
    tableStyle,
    slicerStyle,
    accentBar: pick<AccentBarPosition>(raw.accentBar, ['top', 'bottom', 'left', 'right', 'none'], base.accentBar),
    accentSize: num(raw.accentSize, base.accentSize),
    tint: Math.max(0, Math.min(40, num(raw.cardTint, base.tint))),
    shadow: typeof raw.cardShadow === 'string' && raw.cardShadow.trim()
      ? raw.cardShadow.trim()
      : SHADOW_TOKENS[pick(raw.cardShadowLevel, ['none', 'sm', 'md', 'lg'] as const, base.shadow)],
    border: pick(raw.cardBorderStyle, ['none', 'hairline', 'strong'] as const, base.border),
    blur: num(raw.cardBlur, base.blur),
    cardOpacity: Math.max(0.3, Math.min(1, num(raw.cardOpacity, base.opacity))),
    typoBase: Math.max(10, Math.min(22, num(raw.typoBase, TYPO_BASE_DEFAULT))),
    chart: {
      ...chartBase,
      gridlines: pick(raw.gridlines, ['none', 'light', 'solid', 'dashed'] as const, chartBase.gridlines),
      axisLine: raw.axisLine == null ? chartBase.axisLine : raw.axisLine === true || raw.axisLine === 'true',
      barRadius: num(raw.barRadius, chartBase.barRadius),
      lineWidth: num(raw.lineWidth, chartBase.lineWidth),
      areaOpacity: Math.max(0, Math.min(1, num(raw.areaOpacity, chartBase.areaOpacity))),
      legend: pick(raw.legendStyle, ['default', 'compact', 'hidden'] as const, chartBase.legend),
      plotBackground: pick(raw.plotBackground, ['none', 'tint'] as const, chartBase.plotBackground),
      dataLabels: pick(raw.dataLabelStyle, ['off', 'auto', 'always'] as const, chartBase.dataLabels),
    },
  };
}

/** CSS custom properties for the wrapper element. Every themed surface (card,
 *  table, slicer, widget, tooltip, empty state) reads these — see the
 *  `[data-dashboard-*]` block in globals.css. */
export function styleTokensToCssVars(t: ResolvedStyleTokens): Record<string, string> {
  const vars: Record<string, string> = {
    '--dash-accent-size': `${t.accentSize}px`,
    '--dash-card-tint': `${t.tint}%`,
    '--dash-card-shadow': t.shadow,
    '--dash-card-blur': t.blur ? `blur(${t.blur}px) saturate(1.2)` : 'none',
    '--dash-card-opacity': String(t.cardOpacity),
    '--dash-typo-base': `${t.typoBase}px`,
    '--dash-bar-radius': `${t.chart.barRadius}px`,
  };
  for (const role of TYPOGRAPHY_ROLES) {
    vars[`--dash-font-${role.key}`] = `${Math.round(t.typoBase * role.scale * 100) / 100}px`;
    vars[`--dash-weight-${role.key}`] = String(role.weight);
  }
  return vars;
}

/** Per-role font size, for components that style text in JS rather than CSS. */
export function roleFontSize(t: ResolvedStyleTokens, role: TypographyRole): number {
  const def = TYPOGRAPHY_ROLES.find((r) => r.key === role);
  return Math.round(t.typoBase * (def?.scale ?? 1) * 100) / 100;
}

// ── Accessibility ────────────────────────────────────────────────────────────

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  const chan = [0, 2, 4].map((i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

/** WCAG contrast ratio, or null when either colour isn't a plain hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Derive a coherent categorical palette from one brand colour.
 *
 * Rotating the hue by the golden angle keeps neighbouring series far apart
 * (adjacent bars stay distinguishable) while the fixed saturation/lightness band
 * keeps them looking like one family instead of a bag of random colours.
 */
export function paletteFromBrandColor(hex: string, count = 8): string[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [];
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const dv = max - min;
  const s = dv === 0 ? 0 : dv / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (dv !== 0) {
    if (max === r) h = 60 * (((g - b) / dv) % 6);
    else if (max === g) h = 60 * ((b - r) / dv + 2);
    else h = 60 * ((r - g) / dv + 4);
  }
  if (h < 0) h += 360;

  const hslToHex = (hh: number, ss: number, ll: number): string => {
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const mm = ll - c / 2;
    const [rr, gg, bb] =
      hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x]
      : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    const to = (n: number) => Math.round((n + mm) * 255).toString(16).padStart(2, '0');
    return `#${to(rr)}${to(gg)}${to(bb)}`;
  };

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (h + i * 137.508) % 360;               // golden angle
    const sat = Math.min(0.78, Math.max(0.42, s || 0.6));
    const lig = i % 2 === 0 ? Math.min(0.62, Math.max(0.42, l || 0.52)) : Math.min(0.72, Math.max(0.52, (l || 0.52) + 0.1));
    out.push(hslToHex(hue, sat, lig));
  }
  return out;
}
