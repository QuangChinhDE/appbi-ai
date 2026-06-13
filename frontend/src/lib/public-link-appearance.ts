import type { CSSProperties } from 'react';
import type { PublicLinkAppearanceConfig } from '@/types/api';

export type PublicLinkPreset = 'briefing' | 'editorial' | 'minimal';
export type PublicLinkAccentPreset = 'sky' | 'teal' | 'amber' | 'rose' | 'slate';
export type PublicLinkDensity = 'comfortable' | 'compact';
export type PublicLinkCanvasStyle = 'soft' | 'grid' | 'plain';
export type PublicLinkEmbedHeaderMode = 'full' | 'compact' | 'hidden';

export interface NormalizedPublicLinkAppearanceConfig {
  preset: PublicLinkPreset;
  accent_preset: PublicLinkAccentPreset;
  accent_color: string | null;
  density: PublicLinkDensity;
  canvas_style: PublicLinkCanvasStyle;
  embed_header_mode: PublicLinkEmbedHeaderMode;
  hero_label: string | null;
  headline: string | null;
  summary: string | null;
  footer_note: string | null;
  show_summary: boolean;
  show_stats: boolean;
  show_page_tabs: boolean;
  allow_viewer_filters: boolean;
  show_footer: boolean;
  show_chart_type_label: boolean;
}

export interface PublicLinkThemeBundle {
  appearance: NormalizedPublicLinkAppearanceConfig;
  accentHex: string;
  pageStyle: CSSProperties;
  topBarStyle: CSSProperties;
  shellStyle: CSSProperties;
  heroStyle: CSSProperties;
  panelStyle: CSSProperties;
  metricCardStyle: CSSProperties;
  accentBadgeStyle: CSSProperties;
  accentPillStyle: CSSProperties;
  neutralPillStyle: CSSProperties;
  pageTabActiveStyle: CSSProperties;
  pageTabInactiveStyle: CSSProperties;
  canvasFrameStyle: CSSProperties;
  canvasInnerStyle: CSSProperties;
  footerStyle: CSSProperties;
  density: {
    compact: boolean;
    heroPaddingClass: string;
    panelPaddingClass: string;
    canvasPaddingClass: string;
    listGapClass: string;
  };
}

export const PUBLIC_LINK_PRESET_OPTIONS: Array<{
  value: PublicLinkPreset;
  label: string;
  description: string;
}> = [
  {
    value: 'briefing',
    label: 'Briefing',
    description: 'Structured report shell with context blocks and clear metadata.',
  },
  {
    value: 'editorial',
    label: 'Editorial',
    description: 'Softer hero treatment with more narrative emphasis.',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    description: 'Quiet framing that keeps attention on the charts first.',
  },
];

export const PUBLIC_LINK_ACCENT_OPTIONS: Array<{
  value: PublicLinkAccentPreset;
  label: string;
  color: string;
}> = [
  { value: 'sky', label: 'Sky', color: '#0EA5E9' },
  { value: 'teal', label: 'Teal', color: '#0F766E' },
  { value: 'amber', label: 'Amber', color: '#D97706' },
  { value: 'rose', label: 'Rose', color: '#E11D48' },
  { value: 'slate', label: 'Slate', color: '#334155' },
];

export const PUBLIC_LINK_DENSITY_OPTIONS: Array<{
  value: PublicLinkDensity;
  label: string;
  description: string;
}> = [
  {
    value: 'comfortable',
    label: 'Comfortable',
    description: 'More whitespace and stronger section separation.',
  },
  {
    value: 'compact',
    label: 'Compact',
    description: 'Tighter spacing for denser dashboards and embeds.',
  },
];

export const PUBLIC_LINK_CANVAS_OPTIONS: Array<{
  value: PublicLinkCanvasStyle;
  label: string;
  description: string;
}> = [
  {
    value: 'soft',
    label: 'Soft',
    description: 'Subtle tinted canvas with low visual noise.',
  },
  {
    value: 'grid',
    label: 'Grid',
    description: 'Technical background pattern for a report-lab feel.',
  },
  {
    value: 'plain',
    label: 'Plain',
    description: 'Flat white canvas for the most neutral framing.',
  },
];

export const PUBLIC_LINK_EMBED_HEADER_OPTIONS: Array<{
  value: PublicLinkEmbedHeaderMode;
  label: string;
  description: string;
}> = [
  {
    value: 'full',
    label: 'Full header',
    description: 'Keep title, summary, and stats visible inside the embed.',
  },
  {
    value: 'compact',
    label: 'Compact header',
    description: 'Slim title bar with lighter chrome for embeds.',
  },
  {
    value: 'hidden',
    label: 'Hide header',
    description: 'Show the report canvas with minimal outer framing.',
  },
];

const DEFAULT_APPEARANCE: NormalizedPublicLinkAppearanceConfig = {
  preset: 'briefing',
  accent_preset: 'sky',
  accent_color: null,
  density: 'compact',
  canvas_style: 'plain',
  embed_header_mode: 'compact',
  hero_label: null,
  headline: null,
  summary: null,
  footer_note: null,
  show_summary: false,
  show_stats: false,
  show_page_tabs: true,
  allow_viewer_filters: true,
  show_footer: false,
  show_chart_type_label: false,
};

const PRESET_VALUES = new Set<PublicLinkPreset>(['briefing', 'editorial', 'minimal']);
const ACCENT_VALUES = new Set<PublicLinkAccentPreset>(['sky', 'teal', 'amber', 'rose', 'slate']);

const FALLBACK_ACCENT_HEX: Record<PublicLinkAccentPreset, string> = Object.fromEntries(
  PUBLIC_LINK_ACCENT_OPTIONS.map((option) => [option.value, option.color]),
) as Record<PublicLinkAccentPreset, string>;

// Phase-18 — single neutral hairline border shared by every flat surface on
// the public/embed link (Metabase-style "flat & clean" theme). slate-200.
const NEUTRAL_BORDER = 'rgb(226, 232, 240)';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    return `#${normalized.split('').map((char) => `${char}${char}`).join('').toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `#${normalized.toUpperCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const raw = normalized.slice(1);
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

function mixRgb(
  base: [number, number, number],
  target: [number, number, number],
  weight: number,
): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, weight));
  return [
    Math.round(base[0] * (1 - clamped) + target[0] * clamped),
    Math.round(base[1] * (1 - clamped) + target[1] * clamped),
    Math.round(base[2] * (1 - clamped) + target[2] * clamped),
  ];
}

function rgb(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function rgba(color: [number, number, number], alpha: number): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

export function normalizePublicLinkAppearance(
  input?: PublicLinkAppearanceConfig | Record<string, unknown> | null,
): NormalizedPublicLinkAppearanceConfig {
  const source = isObject(input) ? input : {};

  return {
    preset: PRESET_VALUES.has(source.preset as PublicLinkPreset)
      ? (source.preset as PublicLinkPreset)
      : DEFAULT_APPEARANCE.preset,
    accent_preset: ACCENT_VALUES.has(source.accent_preset as PublicLinkAccentPreset)
      ? (source.accent_preset as PublicLinkAccentPreset)
      : DEFAULT_APPEARANCE.accent_preset,
    accent_color: normalizeHexColor(source.accent_color),
    density: DEFAULT_APPEARANCE.density,
    canvas_style: DEFAULT_APPEARANCE.canvas_style,
    embed_header_mode: DEFAULT_APPEARANCE.embed_header_mode,
    hero_label: DEFAULT_APPEARANCE.hero_label,
    headline: cleanText(source.headline),
    summary: DEFAULT_APPEARANCE.summary,
    footer_note: DEFAULT_APPEARANCE.footer_note,
    show_summary: DEFAULT_APPEARANCE.show_summary,
    show_stats: DEFAULT_APPEARANCE.show_stats,
    show_page_tabs: typeof source.show_page_tabs === 'boolean'
      ? source.show_page_tabs
      : DEFAULT_APPEARANCE.show_page_tabs,
    allow_viewer_filters: typeof source.allow_viewer_filters === 'boolean'
      ? source.allow_viewer_filters
      : DEFAULT_APPEARANCE.allow_viewer_filters,
    show_footer: DEFAULT_APPEARANCE.show_footer,
    show_chart_type_label: DEFAULT_APPEARANCE.show_chart_type_label,
  };
}

export function describePublicLinkAppearance(input?: PublicLinkAppearanceConfig | null): {
  presetLabel: string;
  accentLabel: string;
  densityLabel: string;
} {
  const appearance = normalizePublicLinkAppearance(input);
  return {
    presetLabel: PUBLIC_LINK_PRESET_OPTIONS.find((option) => option.value === appearance.preset)?.label ?? 'Briefing',
    accentLabel: appearance.accent_color
      ? 'Custom color'
      : (PUBLIC_LINK_ACCENT_OPTIONS.find((option) => option.value === appearance.accent_preset)?.label ?? 'Sky'),
    densityLabel: PUBLIC_LINK_DENSITY_OPTIONS.find((option) => option.value === appearance.density)?.label ?? 'Comfortable',
  };
}

export function buildPublicLinkTheme(input?: PublicLinkAppearanceConfig | null): PublicLinkThemeBundle {
  const appearance = normalizePublicLinkAppearance(input);
  const accentHex = appearance.accent_color ?? FALLBACK_ACCENT_HEX[appearance.accent_preset];
  const accentRgb = hexToRgb(accentHex) ?? [14, 165, 233];
  const accentStrong = mixRgb(accentRgb, [15, 23, 42], 0.22);
  const accentDeep = mixRgb(accentRgb, [2, 6, 23], 0.42);
  const accentSoft = mixRgb(accentRgb, [255, 255, 255], 0.88);
  const accentSoftAlt = mixRgb(accentRgb, [248, 250, 252], 0.78);
  const accentBorder = mixRgb(accentRgb, [255, 255, 255], 0.58);

  // Phase-18 — gradient/glow tokens removed: the flat theme no longer paints
  // page/hero/panel gradients (see return block). `accentSoft`/`accentSoftAlt`/
  // `accentBorder` survive only for the optional 'soft'/'grid' canvas styles
  // a DA can still pick below.
  let canvasInnerStyle: CSSProperties;
  if (appearance.canvas_style === 'plain') {
    canvasInnerStyle = {
      backgroundColor: 'rgba(255, 255, 255, 0.98)',
    };
  } else if (appearance.canvas_style === 'soft') {
    canvasInnerStyle = {
      backgroundImage: `linear-gradient(180deg, ${rgba(accentSoft, 0.74)} 0%, rgba(255, 255, 255, 0.97) 100%)`,
    };
  } else {
    canvasInnerStyle = {
      backgroundColor: 'rgba(255, 255, 255, 0.97)',
      backgroundImage: `
        linear-gradient(${rgba(accentBorder, 0.22)} 1px, transparent 1px),
        linear-gradient(90deg, ${rgba(accentBorder, 0.22)} 1px, transparent 1px),
        linear-gradient(180deg, ${rgba(accentSoft, 0.48)} 0%, rgba(255, 255, 255, 0.98) 100%)
      `,
      backgroundSize: '22px 22px, 22px 22px, auto',
      backgroundPosition: '0 0, 0 0, 0 0',
    };
  }

  return {
    appearance,
    accentHex,
    // Phase-18 — "flat & clean" (Metabase-style) public surface. BI embedded-
    // design research warns against background gradients + heavy drop shadows
    // distracting from the data, so every surface is now a flat fill with a
    // single thin neutral border and no (or barely-there) shadow. Accent color
    // survives only on the small interactive bits (active page tab, badges,
    // pills) for wayfinding. The gradient/glow tokens above are intentionally
    // left unused so reverting is a one-block change.
    pageStyle: {
      backgroundColor: '#F7F8FA',
    },
    topBarStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      boxShadow: 'none',
    },
    shellStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      boxShadow: 'none',
    },
    heroStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      boxShadow: 'none',
    },
    panelStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      boxShadow: 'none',
    },
    metricCardStyle: {
      backgroundColor: '#FBFCFD',
      borderColor: NEUTRAL_BORDER,
    },
    accentBadgeStyle: {
      backgroundColor: rgba(accentRgb, 0.1),
      borderColor: rgba(accentRgb, 0.18),
      color: rgb(accentStrong),
    },
    accentPillStyle: {
      backgroundColor: rgba(accentRgb, 0.09),
      borderColor: rgba(accentRgb, 0.18),
      color: rgb(accentStrong),
    },
    neutralPillStyle: {
      backgroundColor: 'rgba(255, 255, 255, 0.86)',
      borderColor: rgba(accentBorder, 0.72),
      color: '#475569',
    },
    pageTabActiveStyle: {
      backgroundColor: rgb(accentDeep),
      color: '#FFFFFF',
      borderColor: rgb(accentDeep),
      boxShadow: 'none',
    },
    pageTabInactiveStyle: {
      backgroundColor: '#FFFFFF',
      color: '#475569',
      borderColor: NEUTRAL_BORDER,
    },
    canvasFrameStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      boxShadow: 'none',
    },
    canvasInnerStyle,
    footerStyle: {
      backgroundColor: '#FFFFFF',
      borderColor: NEUTRAL_BORDER,
      color: '#64748B',
    },
    density: appearance.density === 'compact'
      ? {
          compact: true,
          heroPaddingClass: 'p-5',
          panelPaddingClass: 'p-4',
          canvasPaddingClass: 'p-2',
          listGapClass: 'gap-4',
        }
      : {
          compact: false,
          heroPaddingClass: 'p-5 sm:p-6 lg:p-7',
          panelPaddingClass: 'p-4 sm:p-5',
          canvasPaddingClass: 'p-3',
          listGapClass: 'gap-6',
        },
  };
}
