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
import type { ExperienceResolved } from '@/lib/api/workspace';

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

type ExperienceOverride = NonNullable<ExperienceResolved['overrides']>;

const EXPERIENCE_DEFAULTS: ExperienceResolved = {
  schema_version: 1,
  preset: null,
  theme: {
    primary: '#2563eb',
    success: '#16a34a',
    warning: '#f59e0b',
    danger: '#ef4444',
    info: '#3b82f6',
    neutral: '#6b7280',
    background: '#f8fafc',
    surface: '#ffffff',
    border: '#e5e7eb',
    text: '#111827',
    font_family: 'system',
    heading_weight: 'semibold',
    body_weight: 'regular',
    type_scale: 100,
    density: 'cozy',
    radius: 'small',
    elevation: 'small',
    motion: 'standard',
    mode: 'auto',
    app_background: null,
  },
  shell: {
    sticky_header: true,
    show_search: false,
    show_logo: true,
    content_width: 'full_bleed',
    content_width_px: null,
    page_padding: 'cozy',
    footer_enabled: false,
    background: 'gray',
  },
  navigation: {
    desktop_kind: 'sidebar',
    mobile_kind: 'bottom_nav',
    sidebar_width: 224,
    default_collapsed: false,
    show_icons: true,
    show_labels: true,
    active_style: 'pill',
    breadcrumbs: false,
  },
  feedback: {
    loading: 'spinner',
    empty_style: 'message',
    success: 'inline',
    confirmation: 'modal',
    error_retry: true,
    motion_ms: 160,
  },
  explicit: false,
  overrides: {},
};

/** Resolve an unsaved Experience Studio draft in the browser. This mirrors the
 * backend resolver closely enough for the preview bridge while preserving the
 * legacy branding/nav values as the inheritance layer. */
export function resolveDraftExperience(
  legacyTheme: WbTheme | null | undefined,
  legacyNav: { desktop_kind?: 'sidebar' | 'top_tabs'; mobile_kind?: 'bottom_nav' | 'drawer' } | null | undefined,
  override: ExperienceOverride | null | undefined,
): ExperienceResolved {
  const legacy = legacyTheme || {};
  const raw = override || {};
  return {
    ...EXPERIENCE_DEFAULTS,
    schema_version: raw.schema_version || 1,
    preset: raw.preset ?? null,
    theme: {
      ...EXPERIENCE_DEFAULTS.theme,
      ...(legacy.primary_color ? { primary: legacy.primary_color } : {}),
      ...(legacy.accent_color ? { info: legacy.accent_color } : {}),
      ...(legacy.theme ? { mode: legacy.theme } : {}),
      ...(legacy.font_family ? { font_family: legacy.font_family } : {}),
      ...(raw.theme || {}),
    },
    shell: { ...EXPERIENCE_DEFAULTS.shell, ...(raw.shell || {}) },
    navigation: {
      ...EXPERIENCE_DEFAULTS.navigation,
      ...(legacyNav?.desktop_kind ? { desktop_kind: legacyNav.desktop_kind } : {}),
      ...(legacyNav?.mobile_kind ? { mobile_kind: legacyNav.mobile_kind } : {}),
      ...(raw.navigation || {}),
    },
    feedback: { ...EXPERIENCE_DEFAULTS.feedback, ...(raw.feedback || {}) },
    explicit: Boolean(override),
    overrides: raw,
  };
}

const EXPERIENCE_RADII: Record<ExperienceResolved['theme']['radius'], string> = {
  none: '0px',
  small: '6px',
  medium: '10px',
  large: '16px',
  full: '9999px',
};

const EXPERIENCE_SHADOWS: Record<ExperienceResolved['theme']['elevation'], string> = {
  none: 'none',
  // Layered, soft shadows read as a premium product surface rather than a flat
  // single-offset box.
  small: '0 1px 2px rgb(15 23 42 / 0.05), 0 1px 3px rgb(15 23 42 / 0.05)',
  medium: '0 1px 2px rgb(15 23 42 / 0.04), 0 6px 16px -4px rgb(15 23 42 / 0.10)',
  large: '0 4px 8px -2px rgb(15 23 42 / 0.06), 0 20px 40px -8px rgb(15 23 42 / 0.16)',
};

/** CSS variables for an explicit experience contract. Unset color/shape fields
 * keep the legacy theme variables, which is what makes partial adoption and
 * dark-mode inheritance safe. */
export function experienceThemeVars(
  experience: ExperienceResolved | null | undefined,
  legacyTheme: WbTheme | null | undefined,
  mode: 'light' | 'dark',
): CSSProperties {
  const base = themeVars(legacyTheme, mode) as Record<string, string>;
  if (!experience?.explicit) return base as CSSProperties;

  const rawTheme = experience.overrides?.theme || {};
  const dark = mode === 'dark';
  const statusDefaults = dark
    ? {
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#f87171',
        info: '#60a5fa',
        neutral: '#94a3b8',
      }
    : {
        success: '#16a34a',
        warning: '#d97706',
        danger: '#dc2626',
        info: '#2563eb',
        neutral: '#64748b',
      };
  const font = FONT_STACKS[rawTheme.font_family || experience.theme.font_family] || base['--wb-font'];
  const rawFeedback = experience.overrides?.feedback || {};
  const motionMs =
    rawFeedback.motion_ms !== undefined
      ? experience.feedback.motion_ms
      : rawTheme.motion === 'instant'
        ? 0
        : rawTheme.motion === 'expressive'
          ? 280
          : rawTheme.motion === 'standard'
            ? 160
            : experience.feedback.motion_ms;

  return {
    ...base,
    ['--wb-primary' as string]: experience.theme.primary,
    ['--wb-accent' as string]: experience.theme.primary,
    ['--wb-success' as string]: rawTheme.success || statusDefaults.success,
    ['--wb-warning' as string]: rawTheme.warning || statusDefaults.warning,
    ['--wb-danger' as string]: rawTheme.danger || statusDefaults.danger,
    ['--wb-info' as string]: rawTheme.info || statusDefaults.info,
    ['--wb-neutral' as string]: rawTheme.neutral || statusDefaults.neutral,
    ['--wb-bg' as string]: rawTheme.background || base['--wb-bg'],
    ['--wb-surface' as string]: rawTheme.surface || base['--wb-surface'],
    ['--wb-surface-2' as string]:
      rawTheme.background || base['--wb-surface-2'],
    ['--wb-text' as string]: rawTheme.text || base['--wb-text'],
    ['--wb-text-muted' as string]: rawTheme.neutral || base['--wb-text-muted'],
    ['--wb-border' as string]: rawTheme.border || base['--wb-border'],
    ['--wb-radius' as string]:
      rawTheme.radius ? EXPERIENCE_RADII[experience.theme.radius] : base['--wb-radius'],
    ['--wb-shadow' as string]:
      rawTheme.elevation
        ? EXPERIENCE_SHADOWS[experience.theme.elevation]
        : base['--wb-shadow'],
    ['--wb-font' as string]: font,
    ['--wb-motion-ms' as string]: `${motionMs}ms`,
    fontFamily: font,
    color: rawTheme.text || base['--wb-text'],
  } as CSSProperties;
}

/**
 * Semantic compatibility sweep for the public runtime. It is deliberately
 * scoped to explicit v1 boards: legacy boards continue through darkModeCss()
 * untouched, while v1 boards get immediate behavior from every color/shape/
 * density knob without a risky mechanical rewrite of the 9k-line renderer.
 */
export function experienceCss(): string {
  const s = '.wb-app[data-experience="v1"]';
  // Attribute selectors ([class~=] exact token + [class*="…/"] opacity variants)
  // so EVERY Tailwind opacity shade (bg-slate-50/70, bg-white/95, …) is remapped
  // — an enumerated list silently missed variants, leaving light bands on dark
  // themes. gray-* aliases cover renderers that emit gray instead of slate.
  return `
${s}{background-color:var(--wb-bg)!important;color:var(--wb-text);}
${s}[data-theme="dark"]{color-scheme:dark;}
${s}[data-theme="light"]{color-scheme:light;}
${s} [class~="bg-white"],${s} [class*="bg-white/"]{background-color:var(--wb-surface)!important;}
${s} [class~="bg-slate-50"],${s} [class*="bg-slate-50/"],${s} [class~="bg-slate-100"],${s} [class*="bg-slate-100/"],
${s} [class~="bg-gray-50"],${s} [class*="bg-gray-50/"],${s} [class~="bg-gray-100"],${s} [class*="bg-gray-100/"]{background-color:var(--wb-surface-2)!important;}
${s} [class~="text-slate-950"],${s} [class~="text-slate-900"],${s} [class~="text-slate-800"],${s} [class~="text-slate-700"],
${s} [class~="text-gray-900"],${s} [class~="text-gray-800"],${s} [class~="text-gray-700"]{color:var(--wb-text)!important;}
${s} [class~="text-slate-600"],${s} [class~="text-slate-500"],${s} [class~="text-slate-400"],${s} [class~="text-slate-300"],
${s} [class~="text-gray-600"],${s} [class~="text-gray-500"],${s} [class~="text-gray-400"]{color:var(--wb-text-muted)!important;}
${s} [class~="border-slate-100"],${s} [class*="border-slate-100/"],${s} [class~="border-slate-200"],${s} [class*="border-slate-200/"],
${s} [class~="border-slate-300"],${s} [class~="border-slate-400"],${s} [class~="border-gray-100"],${s} [class~="border-gray-200"],${s} [class~="border-gray-300"]{border-color:var(--wb-border)!important;}
${s} .bg-emerald-50,${s} .bg-green-50{background-color:color-mix(in srgb,var(--wb-success) 12%,var(--wb-surface))!important;}
${s} .text-emerald-600,${s} .text-emerald-700,${s} .text-emerald-800,${s} .text-green-600,${s} .text-green-700{color:var(--wb-success)!important;}
${s} .border-emerald-200,${s} .border-green-200{border-color:color-mix(in srgb,var(--wb-success) 35%,var(--wb-border))!important;}
${s} .bg-amber-50,${s} .bg-orange-50{background-color:color-mix(in srgb,var(--wb-warning) 12%,var(--wb-surface))!important;}
${s} .text-amber-600,${s} .text-amber-700,${s} .text-amber-800,${s} .text-orange-600,${s} .text-orange-700{color:var(--wb-warning)!important;}
${s} .border-amber-200,${s} .border-orange-200{border-color:color-mix(in srgb,var(--wb-warning) 35%,var(--wb-border))!important;}
${s} .bg-rose-50,${s} .bg-red-50{background-color:color-mix(in srgb,var(--wb-danger) 12%,var(--wb-surface))!important;}
${s} .text-rose-600,${s} .text-rose-700,${s} .text-red-600,${s} .text-red-700{color:var(--wb-danger)!important;}
${s} .border-rose-200,${s} .border-red-200{border-color:color-mix(in srgb,var(--wb-danger) 35%,var(--wb-border))!important;}
${s} .text-blue-600,${s} .text-blue-700,${s} .text-indigo-600,${s} .text-indigo-700{color:var(--wb-info)!important;}
${s} .bg-blue-50,${s} .bg-indigo-50{background-color:color-mix(in srgb,var(--wb-info) 10%,var(--wb-surface))!important;}
${s} input,${s} select,${s} textarea{background-color:var(--wb-surface);color:var(--wb-text);border-color:var(--wb-border);transition-duration:var(--wb-motion-ms);}
${s} .hover\\:bg-slate-50:hover,${s} .hover\\:bg-slate-100:hover{background-color:var(--wb-surface-2)!important;}
${s} .rounded-md,${s} .rounded-lg{border-radius:var(--wb-radius)!important;}
${s} .rounded-xl,${s} .rounded-2xl{border-radius:calc(var(--wb-radius) + 4px)!important;}
${s} .shadow-sm,${s} .shadow-md{box-shadow:var(--wb-shadow)!important;}
${s} button,${s} input,${s} select,${s} textarea,${s} [class*="transition"]{transition-duration:var(--wb-motion-ms)!important;}
${s}[data-density="compact"] input,${s}[data-density="compact"] select,${s}[data-density="compact"] textarea{min-height:2rem;padding-top:.3rem;padding-bottom:.3rem;}
${s}[data-density="compact"] th,${s}[data-density="compact"] td{padding-top:.35rem!important;padding-bottom:.35rem!important;}
${s}[data-density="comfortable"] input,${s}[data-density="comfortable"] select,${s}[data-density="comfortable"] textarea{min-height:2.75rem;padding-top:.7rem;padding-bottom:.7rem;}
${s}[data-density="comfortable"] th,${s}[data-density="comfortable"] td{padding-top:.75rem!important;padding-bottom:.75rem!important;}
.wb-app .wb-screen[data-content-width] > *{max-width:100%!important;}
.wb-app .wb-screen[data-card-radius="custom"] .rounded-md,
.wb-app .wb-screen[data-card-radius="custom"] .rounded-lg,
.wb-app .wb-screen[data-card-radius="custom"] .rounded-xl,
.wb-app .wb-screen[data-card-radius="custom"] .rounded-2xl{border-radius:var(--wb-screen-radius)!important;}
.wb-app .wb-screen[data-shadow="none"] > *{box-shadow:none!important;}
.wb-app .wb-screen[data-shadow="small"] > *{box-shadow:0 1px 2px rgb(15 23 42 / .08)!important;}
.wb-app .wb-screen[data-shadow="medium"] > *{box-shadow:0 8px 24px rgb(15 23 42 / .12)!important;}
.wb-app .wb-screen[data-shadow="large"] > *{box-shadow:0 20px 48px rgb(15 23 42 / .18)!important;}
.wb-app .wb-screen[data-density="compact"] input,
.wb-app .wb-screen[data-density="compact"] select,
.wb-app .wb-screen[data-density="compact"] textarea{min-height:2rem;padding-top:.3rem;padding-bottom:.3rem;}
.wb-app .wb-screen[data-density="compact"] th,
.wb-app .wb-screen[data-density="compact"] td{padding-top:.35rem!important;padding-bottom:.35rem!important;}
.wb-app .wb-screen[data-density="comfortable"] input,
.wb-app .wb-screen[data-density="comfortable"] select,
.wb-app .wb-screen[data-density="comfortable"] textarea{min-height:2.75rem;padding-top:.7rem;padding-bottom:.7rem;}
.wb-app .wb-screen[data-density="comfortable"] th,
.wb-app .wb-screen[data-density="comfortable"] td{padding-top:.75rem!important;padding-bottom:.75rem!important;}
.wb-app .wb-screen[data-motion="instant"] button,
.wb-app .wb-screen[data-motion="instant"] input,
.wb-app .wb-screen[data-motion="instant"] select,
.wb-app .wb-screen[data-motion="instant"] textarea{transition-duration:0ms!important;}
.wb-app .wb-screen[data-motion="standard"] button,
.wb-app .wb-screen[data-motion="standard"] input,
.wb-app .wb-screen[data-motion="standard"] select,
.wb-app .wb-screen[data-motion="standard"] textarea{transition-duration:160ms!important;}
.wb-app .wb-screen[data-motion="expressive"] button,
.wb-app .wb-screen[data-motion="expressive"] input,
.wb-app .wb-screen[data-motion="expressive"] select,
.wb-app .wb-screen[data-motion="expressive"] textarea{transition-duration:280ms!important;}

/* ── Packaged "real-app" polish (v1 boards) ──────────────────────────────
   A cohesive interaction/typography layer on top of the token remaps above so
   inputs, buttons, tables and cards read like a production SaaS app. Uses the
   theme tokens (--wb-primary/border/surface/text) so it re-skins with the theme. */
${s}{--wb-ring:color-mix(in srgb, var(--wb-primary) 16%, transparent);}
/* Inputs */
${s} input:not([type=checkbox]):not([type=radio]):not([type=file]),
${s} select,${s} textarea{padding:.55rem .8rem;font-size:.875rem;box-shadow:inset 0 1px 1.5px rgb(15 23 42 / .025);}
${s} input:not(:disabled):hover:not(:focus),${s} select:not(:disabled):hover:not(:focus),${s} textarea:not(:disabled):hover:not(:focus){border-color:color-mix(in srgb, var(--wb-primary) 26%, var(--wb-border));}
${s} input:focus,${s} select:focus,${s} textarea:focus{outline:none;border-color:var(--wb-primary)!important;box-shadow:0 0 0 3px var(--wb-ring)!important;}
${s} input::placeholder,${s} textarea::placeholder{color:color-mix(in srgb, var(--wb-text-muted) 62%, transparent);}
/* Native select chevron so it doesn't look like a bare box after appearance:none */
${s} select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--wb-text-muted) 50%),linear-gradient(135deg,var(--wb-text-muted) 50%,transparent 50%);background-position:calc(100% - 18px) 52%,calc(100% - 13px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:2rem;}
/* Buttons: depth + motion; primary buttons carry an inline bg + white text */
${s} button{transition:filter .15s ease, box-shadow .15s ease, transform .07s ease, background-color .15s ease;}
${s} button:not(:disabled):active{transform:translateY(.5px);}
${s} button:focus-visible{outline:2px solid color-mix(in srgb, var(--wb-primary) 55%, transparent);outline-offset:2px;}
${s} button[style*="background"]{box-shadow:0 1px 2px rgb(15 23 42 / .10), 0 2px 5px -1px rgb(15 23 42 / .10);font-weight:600;letter-spacing:.01em;}
${s} button[style*="background"]:not(:disabled):hover{filter:brightness(1.07) saturate(1.02);box-shadow:0 3px 9px -1px rgb(15 23 42 / .18);}
/* Tables: crisp header + zebra + row hover */
${s} table thead th{background:color-mix(in srgb, var(--wb-surface-2) 55%, var(--wb-surface));border-bottom:1px solid var(--wb-border);}
${s} table tbody tr{transition:background-color .12s ease;}
${s} table tbody tr:nth-child(even){background:color-mix(in srgb, var(--wb-surface-2) 40%, transparent);}
${s} table tbody tr:hover{background:color-mix(in srgb, var(--wb-primary) 5%, var(--wb-surface))!important;}
${s} table tbody td{border-bottom:1px solid color-mix(in srgb, var(--wb-border) 55%, transparent);}
/* Scrollbars */
${s} *{scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--wb-text-muted) 33%, transparent) transparent;}
${s} ::-webkit-scrollbar{height:10px;width:10px;}
${s} ::-webkit-scrollbar-track{background:transparent;}
${s} ::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--wb-text-muted) 30%, transparent);border-radius:99px;border:2px solid transparent;background-clip:content-box;}
${s} ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb, var(--wb-text-muted) 52%, transparent);background-clip:content-box;}
/* Selection + hairline card ring for crispness */
${s} ::selection{background:color-mix(in srgb, var(--wb-primary) 22%, transparent);}
${s} [class~="shadow-sm"],${s} [class~="shadow-md"]{box-shadow:var(--wb-shadow), 0 0 0 1px rgb(15 23 42 / .03)!important;}
`.trim();
}
