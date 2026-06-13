'use client';

import React from 'react';
import type { DashboardThemeConfig } from '@/types/api';

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
  const raw = theme ?? {};
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

  return {
    mode: raw.mode ?? 'light',
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
  const t = normalizeDashboardTheme(theme);
  const accentRgb = t.accent ? hexToRgbTriplet(t.accent) : undefined;

  const style: React.CSSProperties = { ...(baseStyle ?? {}) };
  if (t.accent) {
    (style as any)['--dashboard-accent'] = t.accent;
  }
  if (accentRgb) {
    (style as any)['--brand'] = accentRgb;
  }
  if (t.fontFamily) {
    style.fontFamily = t.fontFamily;
  }
  // Phase-B16 — a background IMAGE takes over the page background; otherwise the
  // plain color/gradient applies. Mutually exclusive so the CSS `background`
  // shorthand never wipes the image layer. A scrim is baked in as a gradient
  // layer for legibility, and a plain page color sits underneath as a fallback.
  if (t.backgroundImage) {
    const url = `url("${t.backgroundImage}")`;
    if (t.bgOverlay && t.bgOverlay > 0) {
      const scrim = t.mode === 'dark'
        ? `rgba(15, 23, 42, ${t.bgOverlay})`
        : `rgba(255, 255, 255, ${t.bgOverlay})`;
      style.backgroundImage = `linear-gradient(${scrim}, ${scrim}), ${url}`;
    } else {
      style.backgroundImage = url;
    }
    style.backgroundSize = t.backgroundSize || 'cover';
    style.backgroundPosition = t.backgroundPosition || 'center';
    style.backgroundRepeat = 'no-repeat';
    style.backgroundAttachment = 'local';
    if (t.background && !/gradient|url\(/i.test(t.background)) {
      style.backgroundColor = t.background; // plain color fallback under the image
    }
  } else if (t.background) {
    style.background = t.background;
  }
  (style as any)['--dashboard-card-radius'] = t.cardRadius;
  (style as any)['--dashboard-card-padding'] = t.cardPadding;
  (style as any)['--dashboard-grid-gap'] = `${t.gridGap}px`;
  if (t.cardBorderWidth) {
    (style as any)['--dashboard-card-border-width'] = t.cardBorderWidth;
  }
  if (t.cardBorderColor) {
    (style as any)['--dashboard-card-border-color'] = t.cardBorderColor;
  }
  if (t.cardShadow) {
    (style as any)['--dashboard-card-shadow'] = t.cardShadow;
  }
  // Phase-B15 — text + structural vars (consumed by tiles / chart CSS).
  if (t.titleFontSize) (style as any)['--dashboard-title-size'] = t.titleFontSize;
  if (t.titleColor) (style as any)['--dashboard-title-color'] = t.titleColor;
  if (t.labelFontSize) (style as any)['--dashboard-label-size'] = t.labelFontSize;
  if (t.kpiFontSize) (style as any)['--dashboard-kpi-size'] = t.kpiFontSize;
  if (t.gridlineColor) (style as any)['--dashboard-gridline-color'] = t.gridlineColor;
  if (t.axisLabelColor) (style as any)['--dashboard-axis-label-color'] = t.axisLabelColor;

  const chartTheme: DashboardChartTheme = {
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
    // Phase-B16 — translucent "glass" tiles so a background image shows through.
    // High opacity keeps charts crisp (low opacity reads muddy, esp. dark over a
    // bright image); the blur + the tile shadow give a clean "floating" look.
    ...(t.glassCards
      ? {
          cardBg: t.mode === 'dark' ? 'rgba(15, 23, 42, 0.84)' : 'rgba(255, 255, 255, 0.86)',
          cardBackdrop: 'blur(14px) saturate(1.2)',
        }
      : {}),
  };

  return (
    <DashboardThemeContext.Provider value={chartTheme}>
      <div
        className={className}
        data-dashboard-theme={t.mode}
        data-dashboard-card={t.cardStyle}
        data-dashboard-density={t.density}
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
