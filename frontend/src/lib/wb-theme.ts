/**
 * wb-theme — turns a Workboard BrandingSpec (theme superset) into CSS custom
 * properties, background styles, font stacks, and a dark-mode shim.
 *
 * Design: instead of rewriting every component's Tailwind classes, the app
 * shell / portal wrap their content in a `.wb-app` scope, set CSS variables +
 * `data-theme` on the root, and inject a small `<style>` (see `darkModeCss`)
 * that remaps the handful of hardcoded slate/white utilities to theme vars in
 * dark mode. Backgrounds use `data:` URIs / gradients so they satisfy the
 * `img-src 'self' data:` CSP (external URLs are blocked in production).
 */
import type { CSSProperties } from 'react';

export interface ThemeBackground {
  kind: 'color' | 'gradient' | 'image';
  color?: string | null;
  gradient_preset?: string | null;
  image_data?: string | null;
}

export interface WbTheme {
  primary_color?: string | null;
  accent_color?: string | null;
  theme?: 'light' | 'dark' | 'auto';
  background?: ThemeBackground | null;
  font_family?: 'system' | 'inter' | 'be-vietnam' | 'roboto' | 'serif' | 'mono' | null;
  card_style?: {
    radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | null;
    shadow?: 'none' | 'sm' | 'md' | null;
    border?: boolean | null;
  } | null;
  header_style?: 'fill' | 'line' | 'minimal' | null;
  login?: { background?: ThemeBackground | null; tagline?: string | null } | null;
}

export const GRADIENT_PRESETS: Record<string, string> = {
  ocean: 'linear-gradient(135deg,#2193b0,#6dd5ed)',
  sunset: 'linear-gradient(135deg,#ff9a9e,#fad0c4 60%,#fbc2eb)',
  forest: 'linear-gradient(135deg,#134e5e,#71b280)',
  dusk: 'linear-gradient(135deg,#334155,#0f172a)',
  dawn: 'linear-gradient(135deg,#a1c4fd,#c2e9fb)',
  peach: 'linear-gradient(135deg,#ffecd2,#fcb69f)',
  grape: 'linear-gradient(135deg,#5f2c82,#49a09d)',
  mint: 'linear-gradient(135deg,#c1dfc4,#deecdd)',
};

export const FONT_STACKS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  inter: 'Inter, system-ui, -apple-system, sans-serif',
  'be-vietnam': '"Be Vietnam Pro", system-ui, -apple-system, sans-serif',
  roboto: 'Roboto, system-ui, -apple-system, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  mono: '"JetBrains Mono", "SF Mono", "Courier New", monospace',
};

const RADII: Record<string, string> = {
  none: '0px', sm: '6px', md: '10px', lg: '14px', xl: '22px',
};
const SHADOWS: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px rgba(15,23,42,.08)',
  md: '0 6px 18px rgba(15,23,42,.12)',
};

/** Resolve 'auto' against the OS preference (light on server render). */
export function resolveMode(theme?: string | null): 'light' | 'dark' {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/** Build the CSS-variable style object for the `.wb-app` root. */
export function themeVars(theme: WbTheme | null | undefined, mode: 'light' | 'dark'): CSSProperties {
  const t = theme || {};
  const primary = t.primary_color || '#2563eb';
  const accent = t.accent_color || primary;
  const dark = mode === 'dark';
  const surface = dark ? '#1e293b' : '#ffffff';
  const surface2 = dark ? '#0f172a' : '#f8fafc';
  const bg = dark ? '#0b1220' : '#f1f5f9';
  const text = dark ? '#e2e8f0' : '#0f172a';
  const textMuted = dark ? '#94a3b8' : '#64748b';
  const border = dark ? '#334155' : '#e2e8f0';
  const radius = RADII[t.card_style?.radius || 'lg'];
  const shadow = SHADOWS[t.card_style?.shadow || 'sm'];
  const font = FONT_STACKS[t.font_family || 'system'];
  return {
    // custom props (typed loosely — CSSProperties doesn't know --vars)
    ['--wb-primary' as string]: primary,
    ['--wb-accent' as string]: accent,
    ['--wb-bg' as string]: bg,
    ['--wb-surface' as string]: surface,
    ['--wb-surface-2' as string]: surface2,
    ['--wb-text' as string]: text,
    ['--wb-text-muted' as string]: textMuted,
    ['--wb-border' as string]: border,
    ['--wb-radius' as string]: radius,
    ['--wb-shadow' as string]: shadow,
    ['--wb-font' as string]: font,
    fontFamily: font,
    color: text,
  } as CSSProperties;
}

/** Background CSS for a page/root from a ThemeBackground (with fallback). */
export function backgroundStyle(
  bg: ThemeBackground | null | undefined,
  fallbackVar = 'var(--wb-bg)',
): CSSProperties {
  if (!bg || bg.kind === 'color') {
    return { background: bg?.color || fallbackVar };
  }
  if (bg.kind === 'gradient') {
    return { backgroundImage: GRADIENT_PRESETS[bg.gradient_preset || 'ocean'] };
  }
  if (bg.kind === 'image' && bg.image_data) {
    return {
      backgroundImage: `url(${bg.image_data})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed',
    };
  }
  return { background: fallbackVar };
}

/**
 * Dark-mode shim CSS. Remaps the common hardcoded slate/white Tailwind
 * utilities used across the workboard runtime to theme vars, scoped to
 * `[data-theme="dark"] .wb-app`. Not exhaustive, but covers the shell,
 * cards, tables, and form surfaces so dark mode is usable without touching
 * every component.
 */
export function darkModeCss(): string {
  // `data-theme` and `.wb-app` sit on the SAME root element, so the scope
  // prefix must be `.wb-app[data-theme="dark"]` (no descendant space); the
  // remapped utilities are descendants of that root.
  const s = '.wb-app[data-theme="dark"]';
  return `
${s}{background:var(--wb-bg);color:var(--wb-text);}
${s} .bg-white{background-color:var(--wb-surface)!important;}
${s} .bg-slate-50,${s} .bg-slate-50\\/40,${s} .bg-slate-50\\/60{background-color:var(--wb-surface-2)!important;}
${s} .bg-slate-100,${s} .bg-slate-100\\/80{background-color:var(--wb-surface-2)!important;}
${s} .text-slate-900,${s} .text-slate-800,${s} .text-slate-700{color:var(--wb-text)!important;}
${s} .text-slate-600,${s} .text-slate-500,${s} .text-slate-400{color:var(--wb-text-muted)!important;}
${s} .border-slate-200,${s} .border-slate-100,${s} .border-slate-300{border-color:var(--wb-border)!important;}
${s} input,${s} select,${s} textarea{background-color:var(--wb-surface-2);color:var(--wb-text);border-color:var(--wb-border);}
${s} .hover\\:bg-slate-50:hover,${s} .hover\\:bg-slate-100:hover{background-color:var(--wb-surface-2)!important;}
`.trim();
}

/** Card style helpers derived from theme (radius/shadow/border). */
export function cardClassVars(): CSSProperties {
  return {
    borderRadius: 'var(--wb-radius)',
    boxShadow: 'var(--wb-shadow)',
  } as CSSProperties;
}
