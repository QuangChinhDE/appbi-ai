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

  return {
    mode: raw.mode ?? 'light',
    accent,
    fontFamily: normalizeFont(raw.fontFamily ?? raw.font),
    background,
    cardStyle,
    density,
    cardRadius,
    cardPadding: DENSITY_TOKENS[density].padding,
    gridGap: DENSITY_TOKENS[density].gap,
    cardShadow,
    hoverAnimation: raw.hoverAnimation ?? raw.hoverEffect ?? undefined,
  };
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
  if (t.background) {
    style.background = t.background;
  }
  (style as any)['--dashboard-card-radius'] = t.cardRadius;
  (style as any)['--dashboard-card-padding'] = t.cardPadding;
  (style as any)['--dashboard-grid-gap'] = `${t.gridGap}px`;
  if (t.cardShadow) {
    (style as any)['--dashboard-card-shadow'] = t.cardShadow;
  }

  return (
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
