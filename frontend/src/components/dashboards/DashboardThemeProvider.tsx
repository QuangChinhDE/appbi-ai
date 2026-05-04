'use client';

import React from 'react';
import type { DashboardThemeConfig } from '@/types/api';

type Props = {
  theme?: DashboardThemeConfig | null;
  children: React.ReactNode;
  className?: string;
};

/**
 * Wraps a dashboard view with theme tokens (mode, accent, font, card style,
 * background) applied as CSS variables and data attributes on the wrapper.
 *
 * Defaults preserve the pre-theme look — if `theme` is null/empty, no styles
 * change. Charts inherit through CSS custom properties so existing palettes
 * keep working.
 */
export function DashboardThemeProvider({ theme, children, className }: Props) {
  const t = theme ?? {};
  const mode = t.mode ?? 'light';
  const accent = t.accent;
  const fontFamily = t.fontFamily;
  const background = t.background;
  const cardStyle = t.cardStyle ?? 'soft';

  const style: React.CSSProperties = {};
  if (accent) {
    (style as any)['--dashboard-accent'] = accent;
  }
  if (fontFamily) {
    style.fontFamily = fontFamily;
  }
  if (background) {
    style.background = background;
  }

  return (
    <div
      className={className}
      data-dashboard-theme={mode}
      data-dashboard-card={cardStyle}
      style={style}
    >
      {children}
    </div>
  );
}

/** Resolved theme defaults for code paths that need accent / mode at runtime. */
export function resolveTheme(theme?: DashboardThemeConfig | null) {
  return {
    mode: theme?.mode ?? 'light',
    accent: theme?.accent ?? '#2563eb',
    fontFamily: theme?.fontFamily,
    background: theme?.background,
    cardStyle: theme?.cardStyle ?? 'soft',
  };
}
