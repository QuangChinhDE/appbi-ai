'use client';

import React from 'react';
import type { DashboardThemeConfig } from '@/types/api';
import { expandThemeIdentity } from '@/lib/dashboard-theme-catalog';
import {
  resolveStyleTokens,
  styleTokensToCssVars,
  type ResolvedStyleTokens,
} from '@/lib/dashboard-theme-tokens';

type Props = {
  theme?: DashboardThemeConfig | null;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

export type DashboardDensity = 'compact' | 'normal' | 'spacious';
export type DashboardCardStyle = 'soft' | 'sharp' | 'flat' | 'elevated';

const FONT_PRESETS: Record<string, string> = {
  inter: 'var(--font-inter), Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'dm-sans': 'var(--font-dm-sans), "DM Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  'dm sans': 'var(--font-dm-sans), "DM Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  roboto: 'var(--font-roboto), Roboto, var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  'be-vietnam': 'var(--font-be-vietnam), "Be Vietnam Pro", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  'be vietnam pro': 'var(--font-be-vietnam), "Be Vietnam Pro", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  jakarta: 'var(--font-jakarta), "Plus Jakarta Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  'plus jakarta sans': 'var(--font-jakarta), "Plus Jakarta Sans", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  grotesk: 'var(--font-grotesk), "Space Grotesk", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  'space grotesk': 'var(--font-grotesk), "Space Grotesk", var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif',
  serif: 'var(--font-serif), "Source Serif 4", Georgia, Cambria, "Times New Roman", serif',
  'source serif': 'var(--font-serif), "Source Serif 4", Georgia, Cambria, "Times New Roman", serif',
  mono: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
};

const NAMED_ACCENTS: Record<string, string> = {
  blue: '#2563eb',
  green: '#10b981',
  emerald: '#10b981',
  amber: '#f59e0b',
  orange: '#f97316',
  red: '#ef4444',
  rose: '#e11d48',
  purple: '#7c3aed',
  slate: '#475569',
};

const CARD_RADIUS: Record<DashboardCardStyle, string> = {
  soft: '24px',
  elevated: '24px',
  sharp: '6px',
  flat: '8px',
};

const DENSITY_TOKENS: Record<DashboardDensity, { padding: string; gap: number }> = {
  compact: { padding: '12px', gap: 8 },
  normal: { padding: '16px', gap: 16 },
  spacious: { padding: '20px', gap: 24 },
};

function normalizeAccent(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return NAMED_ACCENTS[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeFont(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return FONT_PRESETS[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeDensity(value: unknown): DashboardDensity {
  if (typeof value !== 'string') return 'normal';
  const density = value.trim().toLowerCase();
  if (density === 'comfortable') return 'normal';
  if (density === 'compact' || density === 'normal' || density === 'spacious') return density;
  return 'normal';
}

function normalizeCardStyle(value: unknown): DashboardCardStyle {
  if (typeof value !== 'string') return 'soft';
  const cardStyle = value.trim().toLowerCase();
  if (cardStyle === 'soft' || cardStyle === 'sharp' || cardStyle === 'flat' || cardStyle === 'elevated') {
    return cardStyle;
  }
  return 'soft';
}

function hexToRgbTriplet(value: string): string | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export function normalizeDashboardTheme(theme?: DashboardThemeConfig | null) {
  // Same expansion as resolveStyleTokens: this side owns accent / background /
  // dataColors, so without it an identity-only theme would get its layout but
  // none of its paint.
  const raw = expandThemeIdentity(theme) ?? {};
  const density = normalizeDensity(raw.density);
  const cardStyle = normalizeCardStyle(raw.cardStyle);
  const accent = normalizeAccent(raw.accent);
  const radius = raw.cardRadius ?? raw.radius;
  const cardRadius = typeof radius === 'number'
    ? `${radius}px`
    : typeof radius === 'string' && radius.trim()
      ? (/^\d+(\.\d+)?$/.test(radius.trim()) ? `${radius.trim()}px` : radius.trim())
      : CARD_RADIUS[cardStyle];
  const background = typeof raw.background === 'string' && raw.background.trim()
    ? raw.background.trim()
    : typeof raw.backgroundColor === 'string' && raw.backgroundColor.trim()
      ? raw.backgroundColor.trim()
      : undefined;
  const cardShadow = typeof raw.cardShadow === 'string' && raw.cardShadow.trim()
    ? raw.cardShadow.trim()
    : cardStyle === 'elevated'
      ? '0 28px 64px -40px rgba(15, 23, 42, 0.52)'
      : undefined;
  // Phase-B14 — card border width + color (theme-configurable). Undefined →
  // tiles keep their CSS default (1px hairline, --border-line).
  const bw = raw.cardBorderWidth;
  const cardBorderWidth = typeof bw === 'number'
    ? `${bw}px`
    : typeof bw === 'string' && bw.trim()
      ? (/^\d+(\.\d+)?$/.test(bw.trim()) ? `${bw.trim()}px` : bw.trim())
      : undefined;
  const cardBorderColor = typeof raw.cardBorderColor === 'string' && raw.cardBorderColor.trim()
    ? raw.cardBorderColor.trim()
    : undefined;

  // Phase-B15 — PBI-style personalization tokens.
  const toPx = (v: unknown): string | undefined => {
    if (typeof v === 'number') return `${v}px`;
    if (typeof v === 'string' && v.trim()) return /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim();
    return undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const dataColors = Array.isArray(raw.dataColors)
    ? raw.dataColors.filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim())
    : undefined;
  // Phase-B16 — background image + readability.
  const backgroundImage = str(raw.backgroundImage);
  const bgOverlayRaw = typeof raw.bgOverlay === 'number' ? raw.bgOverlay : Number(raw.bgOverlay);
  const bgOverlay = Number.isFinite(bgOverlayRaw) ? Math.min(Math.max(bgOverlayRaw, 0), 0.9) : undefined;
  const glassCards = raw.glassCards === true || String(raw.glassCards) === 'true';
  // Report "skin": 'modern' = Modern/SaaS ambient + clean-chrome look. Anything
  // else (incl. undefined) is the classic flat look → fully opt-in, no breakage.
  const skin = raw.skin === 'modern' ? 'modern' as const : undefined;
  // #4 — dashboard-wide "Display units" (PBI parity). Applies to value axes +
  // KPI values so a report reads in one consistent magnitude (tỷ/triệu/nghìn).
  const DU = new Set(['auto', 'none', 'thousands', 'millions', 'billions']);
  const duRaw = typeof raw.displayUnits === 'string' ? raw.displayUnits.trim().toLowerCase() : '';
  const displayUnits = DU.has(duRaw) ? (duRaw as 'auto' | 'none' | 'thousands' | 'millions' | 'billions') : undefined;

  return {
    mode: raw.mode ?? 'light',
    displayUnits,
    accent,
    fontFamily: normalizeFont(raw.fontFamily ?? raw.font),
    background,
    cardStyle,
    density,
    cardRadius,
    cardBorderWidth,
    cardBorderColor,
    cardPadding: DENSITY_TOKENS[density].padding,
    gridGap: DENSITY_TOKENS[density].gap,
    cardShadow,
    hoverAnimation: raw.hoverAnimation ?? raw.hoverEffect ?? undefined,
    dataColors: dataColors && dataColors.length > 0 ? dataColors : undefined,
    goodColor: str(raw.goodColor),
    neutralColor: str(raw.neutralColor),
    badColor: str(raw.badColor),
    titleFontSize: toPx(raw.titleFontSize),
    titleColor: str(raw.titleColor),
    labelFontSize: toPx(raw.labelFontSize),
    kpiFontSize: toPx(raw.kpiFontSize),
    gridlineColor: str(raw.gridlineColor),
    axisLabelColor: str(raw.axisLabelColor),
    backgroundImage,
    backgroundSize: str(raw.backgroundSize) ?? 'cover',
    backgroundPosition: str(raw.backgroundPosition) ?? 'center',
    bgOverlay,
    glassCards,
    skin,
  };
}

/** Phase-B15 — chart-facing theme tokens that can't be expressed as CSS vars
 *  (color arrays, Recharts stroke props). Charts read this via useDashboardChartTheme. */
export type DashboardChartTheme = {
  dataColors?: string[];
  goodColor?: string;
  neutralColor?: string;
  badColor?: string;
  gridlineColor?: string;
  axisLabelColor?: string;
  labelFontSize?: string;
  kpiFontSize?: string;
  titleFontSize?: string;
  titleColor?: string;
  /** Phase-B16 — glass tiles over a background image. */
  cardBg?: string;
  cardBackdrop?: string;
  /** Phase-B16 — theme accent so KPI values can follow it (PBI cohesion). */
  accent?: string;
  /** #4 — dashboard-wide display units for value axes + KPI values. */
  displayUnits?: 'auto' | 'none' | 'thousands' | 'millions' | 'billions';
  /** Modern/SaaS skin flag — charts read this to switch to clean chrome. */
  skin?: 'modern';
  /** Full token set (card treatment, chart chrome, typography scale, styles).
   *  Charts read `tokens.chart` for gridlines/bar radius/line width/etc. so the
   *  chrome follows the theme instead of being hard-coded per chart type. */
  tokens?: ResolvedStyleTokens;
};

export const DashboardThemeContext = React.createContext<DashboardChartTheme>({});
export function useDashboardChartTheme(): DashboardChartTheme {
  return React.useContext(DashboardThemeContext);
}

export function getDashboardGridMargin(theme?: DashboardThemeConfig | null): [number, number] {
  const normalized = normalizeDashboardTheme(theme);
  return [normalized.gridGap, normalized.gridGap];
}

/**
 * Wraps a dashboard view with theme tokens (mode, accent, font, card style,
 * background) applied as CSS variables and data attributes on the wrapper.
 *
 * Defaults preserve the pre-theme look — if `theme` is null/empty, no styles
 * change. Charts inherit through CSS custom properties so existing palettes
 * keep working.
 */
export function DashboardThemeProvider({ theme, children, className, style: baseStyle }: Props) {
  // PERF — memoize the normalized theme, wrapper style, and chart-theme context
  // value, all keyed on the (stable, react-query-cached) `theme` prop. Before
  // this, every one of these objects was rebuilt on EVERY render of the provider,
  // so the context value changed identity on any unrelated parent re-render
  // (focus a tile, drag, edit a filter, a presence tick…). That forced every
  // chart (`useDashboardChartTheme`) and every `ChartTile` (also a context
  // consumer) to re-render on each build interaction — the "lag" the user felt.
  // Now the value is referentially stable unless the theme itself changes.
  const t = React.useMemo(() => normalizeDashboardTheme(theme), [theme]);
  const tokens = React.useMemo(() => resolveStyleTokens(theme), [theme]);

  const style = React.useMemo<React.CSSProperties>(() => {
    const accentRgb = t.accent ? hexToRgbTriplet(t.accent) : undefined;
    const s: React.CSSProperties = { ...(baseStyle ?? {}) };
    if (t.accent) (s as any)['--dashboard-accent'] = t.accent;
    if (accentRgb) (s as any)['--brand'] = accentRgb;
    if (t.fontFamily) s.fontFamily = t.fontFamily;
    // Phase-B16 — a background IMAGE takes over the page background; otherwise the
    // plain color/gradient applies. Mutually exclusive so the CSS `background`
    // shorthand never wipes the image layer. A scrim is baked in for legibility.
    if (t.backgroundImage) {
      const url = `url("${t.backgroundImage}")`;
      if (t.bgOverlay && t.bgOverlay > 0) {
        const scrim = t.mode === 'dark'
          ? `rgba(15, 23, 42, ${t.bgOverlay})`
          : `rgba(255, 255, 255, ${t.bgOverlay})`;
        s.backgroundImage = `linear-gradient(${scrim}, ${scrim}), ${url}`;
      } else {
        s.backgroundImage = url;
      }
      s.backgroundSize = t.backgroundSize || 'cover';
      s.backgroundPosition = t.backgroundPosition || 'center';
      s.backgroundRepeat = 'no-repeat';
      s.backgroundAttachment = 'local';
      if (t.background && !/gradient|url\(/i.test(t.background)) {
        s.backgroundColor = t.background; // plain color fallback under the image
      }
    } else if (t.background) {
      s.background = t.background;
    }
    (s as any)['--dashboard-card-radius'] = t.cardRadius;
    (s as any)['--dashboard-card-padding'] = t.cardPadding;
    (s as any)['--dashboard-grid-gap'] = `${t.gridGap}px`;
    if (t.cardBorderWidth) (s as any)['--dashboard-card-border-width'] = t.cardBorderWidth;
    if (t.cardBorderColor) (s as any)['--dashboard-card-border-color'] = t.cardBorderColor;
    if (t.cardShadow) (s as any)['--dashboard-card-shadow'] = t.cardShadow;
    // Phase-B15 — text + structural vars (consumed by tiles / chart CSS).
    if (t.titleFontSize) (s as any)['--dashboard-title-size'] = t.titleFontSize;
    if (t.titleColor) (s as any)['--dashboard-title-color'] = t.titleColor;
    if (t.labelFontSize) (s as any)['--dashboard-label-size'] = t.labelFontSize;
    if (t.kpiFontSize) (s as any)['--dashboard-kpi-size'] = t.kpiFontSize;
    if (t.gridlineColor) (s as any)['--dashboard-gridline-color'] = t.gridlineColor;
    if (t.axisLabelColor) (s as any)['--dashboard-axis-label-color'] = t.axisLabelColor;
    // Design-system tokens (card treatment, typography roles, chart chrome).
    // One assignment here themes every surface that reads them in CSS: tiles,
    // tables, slicers, widgets, tooltips, empty/error states.
    for (const [k, v] of Object.entries(styleTokensToCssVars(tokens))) {
      (s as any)[k] = v;
    }
    return s;
  }, [t, baseStyle, tokens]);

  const chartTheme = React.useMemo<DashboardChartTheme>(() => ({
    dataColors: t.dataColors,
    goodColor: t.goodColor,
    neutralColor: t.neutralColor,
    badColor: t.badColor,
    gridlineColor: t.gridlineColor,
    axisLabelColor: t.axisLabelColor,
    labelFontSize: t.labelFontSize,
    kpiFontSize: t.kpiFontSize,
    titleFontSize: t.titleFontSize,
    titleColor: t.titleColor,
    accent: t.accent,
    displayUnits: t.displayUnits,
    skin: t.skin,
    tokens,
    // Phase-B16 — translucent "glass" tiles so a background image shows through.
    ...(t.glassCards
      ? {
          cardBg: t.mode === 'dark' ? 'rgba(15, 23, 42, 0.84)' : 'rgba(255, 255, 255, 0.86)',
          cardBackdrop: 'blur(14px) saturate(1.2)',
        }
      : {}),
  }), [t, tokens]);

  return (
    <DashboardThemeContext.Provider value={chartTheme}>
      <div
        className={className}
        data-dashboard-theme={t.mode}
        data-dashboard-card={t.cardStyle}
        data-dashboard-density={t.density}
        data-dashboard-skin={t.skin ?? 'classic'}
        data-dashboard-cardtreatment={tokens.cardTreatment}
        data-dashboard-accentbar={tokens.accentBar}
        data-dashboard-chartchrome={tokens.chartChrome}
        data-dashboard-kpistyle={tokens.kpiStyle}
        data-dashboard-tablestyle={tokens.tableStyle}
        data-dashboard-slicerstyle={tokens.slicerStyle}
        data-dashboard-slicervariant={tokens.slicerVariant}
        data-dashboard-filterdock={tokens.filterDock}
        data-dashboard-labelstyle={tokens.labelStyle}
        data-dashboard-numericfont={tokens.numericFont}
        data-dashboard-sectionsurface={tokens.sectionSurface}
        data-dashboard-markfill={tokens.chart.markFill}
        data-dashboard-hover={t.hoverAnimation ?? 'none'}
        style={style}
      >
        {children}
      </div>
    </DashboardThemeContext.Provider>
  );
}

/** Resolved theme defaults for code paths that need accent / mode at runtime. */
export function resolveTheme(theme?: DashboardThemeConfig | null) {
  const normalized = normalizeDashboardTheme(theme);
  return {
    mode: normalized.mode,
    accent: normalized.accent ?? '#2563eb',
    fontFamily: normalized.fontFamily,
    background: normalized.background,
    cardStyle: normalized.cardStyle,
    density: normalized.density,
  };
}
