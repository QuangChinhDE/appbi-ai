'use client';

import React, { useRef, useState } from 'react';
import { X, Plus, Trash2, LayoutTemplate, Palette as PaletteIcon, Type, Square, BarChart3, ImageIcon, Upload, Check } from 'lucide-react';
import type { DashboardThemeConfig } from '@/types/api';
import { useI18n } from '@/providers/LanguageProvider';

type Props = {
  initial: DashboardThemeConfig | null | undefined;
  onClose: () => void;
  onSave: (theme: DashboardThemeConfig) => Promise<void> | void;
};

/** Full-theme presets — one click sets a coherent, scientifically-grounded look
 *  (Power BI "report theme"). Each carries the WHOLE look: page background,
 *  accent, categorical data palette, status colors, card style + mode. The
 *  palettes are grounded in recognized sources (Tableau 10, Okabe–Ito CB-safe,
 *  IBM Carbon, ColorBrewer, viridis) so a user can pick a finished look without
 *  any manual setup. `id` lets the editor highlight the active one. */
type ThemePreset = { id: string; label: string; hint: string; value: DashboardThemeConfig };
const PRESETS: ThemePreset[] = [
  // ── Modern / SaaS skin — the "vibe-code" look: tinted cards + accent bar +
  //    soft shadow + clean chart chrome. `skin:'modern'` drives the ambient CSS
  //    + clean-chrome; the rest is a cohesive, restrained palette (accent-led,
  //    not rainbow) so color lives around the chart, not inside every mark.
  {
    id: 'modern-indigo', label: 'dashboards.themeModal.presetModernIndigo', hint: 'dashboards.themeModal.presetModernIndigoHint',
    value: {
      mode: 'light', skin: 'modern', cardStyle: 'soft', density: 'normal', cardRadius: 16,
      background: 'linear-gradient(180deg, #f7f8fb 0%, #f2f3f9 100%)', accent: '#5b5bd6',
      dataColors: ['#5b5bd6', '#22b8cf', '#12b886', '#fab005', '#fa5252', '#be4bdb', '#4dabf7', '#748ffc'],
      goodColor: '#12b886', neutralColor: '#868e96', badColor: '#fa5252',
      cardBorderColor: 'rgba(20,26,42,0.08)',
      cardShadow: '0 1px 2px rgba(20,26,42,.05), 0 10px 26px -14px rgba(20,26,42,.28)',
      gridlineColor: 'rgba(20,26,42,0.06)', titleFontSize: 15,
    },
  },
  {
    id: 'modern-emerald', label: 'dashboards.themeModal.presetModernEmerald', hint: 'dashboards.themeModal.presetModernEmeraldHint',
    value: {
      mode: 'light', skin: 'modern', cardStyle: 'soft', density: 'normal', cardRadius: 16,
      background: 'linear-gradient(180deg, #f5faf7 0%, #eff7f2 100%)', accent: '#0e9f6e',
      dataColors: ['#0e9f6e', '#2cc98d', '#0ca5e9', '#fab005', '#fa7066', '#7c7ce6', '#12b8a6', '#868e96'],
      goodColor: '#0e9f6e', neutralColor: '#868e96', badColor: '#fa5252',
      cardBorderColor: 'rgba(20,26,42,0.08)',
      cardShadow: '0 1px 2px rgba(20,26,42,.05), 0 10px 26px -14px rgba(20,26,42,.28)',
      gridlineColor: 'rgba(20,26,42,0.06)', titleFontSize: 15,
    },
  },
  {
    id: 'modern-coral', label: 'dashboards.themeModal.presetModernCoral', hint: 'dashboards.themeModal.presetModernCoralHint',
    value: {
      mode: 'light', skin: 'modern', cardStyle: 'soft', density: 'normal', cardRadius: 16,
      background: 'linear-gradient(180deg, #fdf6f4 0%, #fbf0ed 100%)', accent: '#e5604d',
      dataColors: ['#e5604d', '#f0836f', '#fab005', '#12b886', '#5b5bd6', '#0ca5e9', '#be4bdb', '#868e96'],
      goodColor: '#12b886', neutralColor: '#868e96', badColor: '#e5604d',
      cardBorderColor: 'rgba(20,26,42,0.08)',
      cardShadow: '0 1px 2px rgba(20,26,42,.05), 0 10px 26px -14px rgba(20,26,42,.28)',
      gridlineColor: 'rgba(20,26,42,0.06)', titleFontSize: 15,
    },
  },
  {
    id: 'clean-light', label: 'dashboards.themeModal.presetCleanLight', hint: 'dashboards.themeModal.presetCleanLightHint',
    value: {
      mode: 'light', cardStyle: 'soft', density: 'normal', background: '#f8fafc', accent: '#2563eb',
      dataColors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#9c755f'],
      goodColor: '#59a14f', neutralColor: '#79706e', badColor: '#e15759',
    },
  },
  {
    id: 'neutral-slate', label: 'dashboards.themeModal.presetNeutralSlate', hint: 'dashboards.themeModal.presetNeutralSlateHint',
    value: {
      mode: 'light', cardStyle: 'flat', density: 'normal', background: '#eef2f6', accent: '#475569',
      dataColors: ['#5b7c99', '#8aa399', '#c4a35a', '#a3766b', '#7d8597', '#b0a6c0'],
      goodColor: '#4d8b6f', neutralColor: '#7b8794', badColor: '#b4654a',
    },
  },
  {
    id: 'cb-safe', label: 'dashboards.themeModal.presetCbSafe', hint: 'dashboards.themeModal.presetCbSafeHint',
    value: {
      mode: 'light', cardStyle: 'soft', density: 'normal', background: '#ffffff', accent: '#0072b2',
      dataColors: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442'],
      goodColor: '#009e73', neutralColor: '#999999', badColor: '#d55e00',
    },
  },
  {
    id: 'high-contrast', label: 'dashboards.themeModal.presetHighContrast', hint: 'dashboards.themeModal.presetHighContrastHint',
    value: {
      mode: 'light', cardStyle: 'sharp', density: 'normal', background: '#ffffff', accent: '#0f172a',
      dataColors: ['#1192e8', '#fa4d56', '#198038', '#9f1853', '#fff1f1', '#6929c4', '#b28600', '#009d9a'],
      goodColor: '#198038', neutralColor: '#525252', badColor: '#da1e28',
      cardBorderWidth: '1px', cardBorderColor: '#0f172a',
    },
  },
  {
    id: 'ocean', label: 'dashboards.themeModal.presetOcean', hint: 'dashboards.themeModal.presetOceanHint',
    value: {
      mode: 'light', cardStyle: 'soft', density: 'normal',
      background: 'linear-gradient(180deg, #ecfeff 0%, #f0fdfa 100%)', accent: '#0e7490',
      dataColors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725', '#2a788e'],
      goodColor: '#21918c', neutralColor: '#64748b', badColor: '#b4334a',
    },
  },
  {
    id: 'warm-sunset', label: 'dashboards.themeModal.presetWarmSunset', hint: 'dashboards.themeModal.presetWarmSunsetHint',
    value: {
      mode: 'light', cardStyle: 'soft', density: 'normal',
      background: 'linear-gradient(180deg, #fff7ed 0%, #fffbeb 100%)', accent: '#ea580c',
      dataColors: ['#d73027', '#fc8d59', '#fee090', '#91bfdb', '#4575b4', '#f46d43'],
      goodColor: '#1a9850', neutralColor: '#8c8c8c', badColor: '#d73027',
    },
  },
  {
    id: 'midnight', label: 'dashboards.themeModal.presetMidnight', hint: 'dashboards.themeModal.presetMidnightHint',
    value: {
      mode: 'dark', cardStyle: 'soft', density: 'normal', background: '#0f172a', accent: '#38bdf8',
      dataColors: ['#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#a3e635'],
      goodColor: '#34d399', neutralColor: '#94a3b8', badColor: '#fb7185',
    },
  },
  {
    id: 'graphite', label: 'dashboards.themeModal.presetGraphite', hint: 'dashboards.themeModal.presetGraphiteHint',
    value: {
      mode: 'dark', cardStyle: 'flat', density: 'normal', background: '#101114', accent: '#a78bfa',
      dataColors: ['#8a3ffc', '#33b1ff', '#007d79', '#ff7eb6', '#fa4d56', '#42be65', '#d4bbff', '#ffb000'],
      goodColor: '#42be65', neutralColor: '#8d8d8d', badColor: '#fa4d56',
    },
  },
];

/** Data-color (series) palettes — the report-wide chart palette, like PBI. */
const PALETTE_PRESETS: Array<{ label: string; colors: string[] }> = [
  { label: 'dashboards.themeModal.paletteDefault', colors: ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#7c3aed', '#06b6d4', '#ec4899', '#84cc16'] },
  { label: 'dashboards.themeModal.paletteEnterprise', colors: ['#1e3a5f', '#2e6da4', '#5b9bd5', '#a5c8e1', '#c9a227', '#8c8c8c'] },
  { label: 'dashboards.themeModal.paletteVibrant', colors: ['#ff6b6b', '#feca57', '#1dd1a1', '#5f27cd', '#54a0ff', '#ff9ff3'] },
  { label: 'dashboards.themeModal.paletteSoft', colors: ['#7c93d8', '#6ec79a', '#e6b566', '#e88aa6', '#a07ad8', '#5fc2bb'] },
];

const SECTIONS = [
  { key: 'mau', label: 'dashboards.themeModal.sectionTemplates', icon: LayoutTemplate },
  { key: 'color', label: 'dashboards.themeModal.sectionColors', icon: PaletteIcon },
  { key: 'text', label: 'dashboards.themeModal.sectionText', icon: Type },
  { key: 'card', label: 'dashboards.themeModal.sectionCards', icon: Square },
  { key: 'chart', label: 'dashboards.themeModal.sectionCharts', icon: BarChart3 },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];

function pxNum(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

const INPUT_CLS = 'rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-sm';
const SWATCH_CLS = 'h-8 w-10 shrink-0 rounded border border-[rgb(var(--border-line))]';

/** Color row (swatch + hex text + reset). Hoisted to module scope so it is a
 *  stable component — defining it inside the modal would remount it every
 *  render and steal input focus after each keystroke. */
function ColorRow({ label, value, onChange, fallback, placeholder }: {
  label: string; value?: string; onChange: (v: string) => void; fallback: string; placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 text-text-tertiary">{label}</span>
      <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} className={SWATCH_CLS} />
      <input type="text" value={value || ''} placeholder={placeholder ?? t('dashboards.themeModal.defaultPlaceholder')} onChange={(e) => onChange(e.target.value)} className={`flex-1 ${INPUT_CLS}`} />
      {value ? (
        <button type="button" onClick={() => onChange('')} className="text-xs text-text-quaternary hover:text-text-secondary">{t('dashboards.themeModal.reset')}</button>
      ) : null}
    </label>
  );
}

/** Slider row in px. Module-scoped for the same focus-stability reason. */
function SliderRow({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (px: string) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 text-text-tertiary">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(`${e.target.value}px`)} className="flex-1 accent-[rgb(var(--brand))]" />
      <span className="w-12 text-right tabular-nums text-text-secondary">{value}px</span>
    </label>
  );
}

const RADIUS_BY_STYLE: Record<string, number> = { soft: 10, elevated: 12, flat: 6, sharp: 2 };

/** Phase-B16 — a MINI dashboard mockup that previews exactly what a preset does:
 *  its page background, two cards (in the preset's card style + accent), and the
 *  data-color palette rendered as little bars. So a user sees the look, not just
 *  a name. Module-scoped (stable component). */
function ThemePresetCard({ preset, active, onApply }: {
  preset: ThemePreset; active: boolean; onApply: () => void;
}) {
  const { t } = useI18n();
  const v = preset.value;
  const dark = v.mode === 'dark';
  const cardFill = dark ? '#1e293b' : '#ffffff';
  const cardBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)';
  const textColor = dark ? '#e2e8f0' : '#0f172a';
  const subText = dark ? '#94a3b8' : '#64748b';
  const radius = RADIUS_BY_STYLE[v.cardStyle || 'soft'] ?? 8;
  const palette = (v.dataColors && v.dataColors.length ? v.dataColors : [v.accent || '#2563eb']).slice(0, 6);
  const accent = v.accent || palette[0];
  return (
    <button
      type="button"
      onClick={onApply}
      title={t(preset.label)}
      className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition ${
        active ? 'border-brand ring-2 ring-brand/40' : 'border-[rgb(var(--border-line))] hover:border-brand/50'
      }`}
    >
      {active && (
        <span className="absolute right-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      {/* mini dashboard mockup */}
      <div className="p-2" style={{ background: v.background || (dark ? '#0f172a' : '#f8fafc') }}>
        {/* mini KPI strip */}
        <div className="mb-1.5 flex gap-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="flex-1 rounded px-1.5 py-1" style={{ background: cardFill, border: `1px solid ${cardBorder}`, borderRadius: radius }}>
              <div className="h-1 w-5 rounded-full" style={{ background: subText, opacity: 0.5 }} />
              <div className="mt-1 text-[9px] font-bold leading-none" style={{ color: i === 0 ? accent : textColor }}>
                {i === 0 ? '89%' : '2.4K'}
              </div>
            </div>
          ))}
        </div>
        {/* mini bar chart card */}
        <div className="rounded px-1.5 pb-1 pt-1.5" style={{ background: cardFill, border: `1px solid ${cardBorder}`, borderRadius: radius }}>
          <div className="flex h-9 items-end gap-1">
            {palette.map((c, i) => (
              <div key={i} className="flex-1 rounded-sm" style={{ background: c, height: `${38 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        </div>
      </div>
      {/* label + palette dots */}
      <div className="flex items-center justify-between gap-1 border-t border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-text-primary">{t(preset.label)}</div>
          <div className="truncate text-[10px] text-text-quaternary">{t(preset.hint)}</div>
        </div>
        <div className="flex shrink-0 gap-0.5">
          {palette.slice(0, 4).map((c, i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
      </div>
    </button>
  );
}

/** Phase-B16 — read a user image file, downscale via an offscreen canvas (cap
 *  longest edge so the base64 stays small), return a JPEG/PNG data-URL. Keeps
 *  the theme_config row light (the app stores images base64-in-JSON, no asset
 *  store). Rejects results above the hard cap. */
const BG_MAX_EDGE = 1600;
const BG_HARD_CAP_BYTES = 1_600_000; // ~1.6MB data-URL ceiling
async function downscaleImageToDataUrl(file: File): Promise<string> {
  const rawUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('decode failed'));
    im.src = rawUrl;
  });
  const scale = Math.min(1, BG_MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return rawUrl;
  ctx.drawImage(img, 0, 0, w, h);
  // PNG keeps transparency; otherwise JPEG is far smaller.
  const isPng = /image\/png/i.test(file.type);
  const out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82);
  if (out.length > BG_HARD_CAP_BYTES && !isPng) {
    // try harder compression once
    const out2 = canvas.toDataURL('image/jpeg', 0.6);
    return out2;
  }
  return out;
}

export function DashboardThemeModal({ initial, onClose, onSave }: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SectionKey>('mau');
  const [theme, setTheme] = useState<DashboardThemeConfig>({
    mode: initial?.mode ?? 'light',
    accent: initial?.accent ?? '',
    fontFamily: initial?.fontFamily ?? initial?.font ?? '',
    cardStyle: initial?.cardStyle ?? 'soft',
    background: initial?.background ?? initial?.backgroundColor ?? '',
    density: initial?.density ?? 'normal',
    cardRadius: initial?.cardRadius ?? '',
    cardBorderWidth: initial?.cardBorderWidth ?? '',
    cardBorderColor: initial?.cardBorderColor ?? '',
    cardShadow: initial?.cardShadow ?? undefined,
    hoverAnimation: initial?.hoverAnimation ?? 'none',
    // Phase-B15
    dataColors: Array.isArray(initial?.dataColors) ? [...initial!.dataColors!] : undefined,
    goodColor: initial?.goodColor ?? '',
    neutralColor: initial?.neutralColor ?? '',
    badColor: initial?.badColor ?? '',
    titleFontSize: initial?.titleFontSize ?? '',
    titleColor: initial?.titleColor ?? '',
    labelFontSize: initial?.labelFontSize ?? '',
    kpiFontSize: initial?.kpiFontSize ?? '',
    gridlineColor: initial?.gridlineColor ?? '',
    axisLabelColor: initial?.axisLabelColor ?? '',
    displayUnits: (initial?.displayUnits ?? '') as any,
    // Phase-B16
    backgroundImage: initial?.backgroundImage ?? '',
    backgroundSize: initial?.backgroundSize ?? '',
    backgroundPosition: initial?.backgroundPosition ?? '',
    bgOverlay: typeof initial?.bgOverlay === 'number' ? initial.bgOverlay : undefined,
    glassCards: initial?.glassCards ?? false,
    presetId: initial?.presetId ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [bgError, setBgError] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof DashboardThemeConfig>(k: K, v: DashboardThemeConfig[K]) => {
    setTheme((t) => ({ ...t, [k]: v }));
  };

  // Data-color palette helpers.
  const dataColors: string[] = Array.isArray(theme.dataColors) ? theme.dataColors : [];
  const setColorAt = (i: number, v: string) =>
    setTheme((t) => {
      const arr = Array.isArray(t.dataColors) ? [...t.dataColors] : [];
      arr[i] = v;
      return { ...t, dataColors: arr };
    });
  const removeColorAt = (i: number) =>
    setTheme((t) => {
      const arr = (Array.isArray(t.dataColors) ? [...t.dataColors] : []).filter((_, j) => j !== i);
      return { ...t, dataColors: arr.length ? arr : undefined };
    });
  const addColor = () =>
    setTheme((t) => ({ ...t, dataColors: [...(Array.isArray(t.dataColors) ? t.dataColors : []), '#2563eb'] }));

  // Apply a full-theme preset — replaces look-defining keys, preserves any
  // uploaded background image + glass setting so a chosen image survives.
  const applyPreset = (p: ThemePreset) =>
    // `skin` set EXPLICITLY (not just spread) so switching from a Modern preset
    // to a classic one clears it back to undefined instead of sticking.
    setTheme((t) => ({ ...t, ...p.value, skin: p.value.skin, presetId: p.id, glassCards: t.glassCards, backgroundImage: t.backgroundImage }));

  // Background image upload (downscaled base64 stored in theme_config).
  const onPickImage = async (file: File | null | undefined) => {
    setBgError('');
    if (!file) return;
    try {
      const dataUrl = await downscaleImageToDataUrl(file);
      if (dataUrl.length > BG_HARD_CAP_BYTES) {
        setBgError(t('dashboards.themeModal.bgErrorTooLarge'));
        return;
      }
      setTheme((t) => ({
        ...t,
        backgroundImage: dataUrl,
        glassCards: t.glassCards === false ? true : t.glassCards,
        // gentle default scrim so a busy photo doesn't fight the content
        bgOverlay: typeof t.bgOverlay === 'number' && t.bgOverlay > 0 ? t.bgOverlay : 0.15,
      }));
    } catch {
      setBgError(t('dashboards.themeModal.bgErrorRead'));
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const num = (v: unknown) => (v !== '' && v != null ? v : undefined);
      const cleaned: DashboardThemeConfig = {
        mode: theme.mode,
        cardStyle: theme.cardStyle,
        density: theme.density,
        ...(str(theme.accent) ? { accent: str(theme.accent) } : {}),
        ...(str(theme.fontFamily) ? { fontFamily: str(theme.fontFamily) } : {}),
        ...(str(theme.background) ? { background: str(theme.background) } : {}),
        ...(num(theme.cardRadius) != null ? { cardRadius: theme.cardRadius } : {}),
        ...(num(theme.cardBorderWidth) != null ? { cardBorderWidth: theme.cardBorderWidth } : {}),
        ...(str(theme.cardBorderColor) ? { cardBorderColor: str(theme.cardBorderColor) } : {}),
        ...(theme.cardShadow ? { cardShadow: theme.cardShadow } : {}),
        ...(theme.hoverAnimation && theme.hoverAnimation !== 'none' ? { hoverAnimation: theme.hoverAnimation } : {}),
        // Phase-B15
        ...(dataColors.length ? { dataColors } : {}),
        ...(str(theme.goodColor) ? { goodColor: str(theme.goodColor) } : {}),
        ...(str(theme.neutralColor) ? { neutralColor: str(theme.neutralColor) } : {}),
        ...(str(theme.badColor) ? { badColor: str(theme.badColor) } : {}),
        ...(num(theme.titleFontSize) != null ? { titleFontSize: theme.titleFontSize } : {}),
        ...(str(theme.titleColor) ? { titleColor: str(theme.titleColor) } : {}),
        ...(num(theme.labelFontSize) != null ? { labelFontSize: theme.labelFontSize } : {}),
        ...(num(theme.kpiFontSize) != null ? { kpiFontSize: theme.kpiFontSize } : {}),
        ...(str(theme.gridlineColor) ? { gridlineColor: str(theme.gridlineColor) } : {}),
        ...(str(theme.axisLabelColor) ? { axisLabelColor: str(theme.axisLabelColor) } : {}),
        ...(str(theme.displayUnits) ? { displayUnits: theme.displayUnits as DashboardThemeConfig['displayUnits'] } : {}),
        // Phase-B16 — background image + readability + applied preset id.
        ...(str(theme.backgroundImage) ? { backgroundImage: str(theme.backgroundImage) } : {}),
        ...(str(theme.backgroundSize) ? { backgroundSize: str(theme.backgroundSize) } : {}),
        ...(str(theme.backgroundPosition) ? { backgroundPosition: str(theme.backgroundPosition) } : {}),
        ...(typeof theme.bgOverlay === 'number' && theme.bgOverlay > 0 ? { bgOverlay: theme.bgOverlay } : {}),
        ...(theme.glassCards ? { glassCards: true } : {}),
        ...(str(theme.presetId) ? { presetId: str(theme.presetId) } : {}),
        ...(theme.skin === 'modern' ? { skin: 'modern' as const } : {}),
      };
      await onSave(cleaned);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const radiusNum = pxNum(theme.cardRadius, 8);
  const borderNum = pxNum(theme.cardBorderWidth, 1);
  const titleSizeNum = pxNum(theme.titleFontSize, 14);
  const labelSizeNum = pxNum(theme.labelFontSize, 12);
  const kpiSizeNum = pxNum(theme.kpiFontSize, 40);

  const inputCls = INPUT_CLS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* Fixed height (not just max-height) so switching tabs never resizes the
          modal — the body scrolls internally instead of the frame stretching. */}
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg" style={{ height: 'min(660px, 90vh)' }}>
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('dashboards.themeModal.title')}</h2>
            <p className="text-xs text-text-tertiary">{t('dashboards.themeModal.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Section tabs */}
        <div className="flex gap-1 border-b border-[rgb(var(--border-line))] px-3 pt-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium transition ${
                  active
                    ? 'border-b-2 border-brand text-text-primary'
                    : 'border-b-2 border-transparent text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t(s.label)}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* ── MẪU ─────────────────────────────────────────────── */}
          {section === 'mau' && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.presetsHeading')}</div>
                <p className="mb-2.5 text-xs text-text-quaternary">{t('dashboards.themeModal.presetsHint')}</p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {PRESETS.map((p) => (
                    <ThemePresetCard key={p.id} preset={p} active={theme.presetId === p.id} onApply={() => applyPreset(p)} />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.modeLabel')}</span>
                  <select value={theme.mode} onChange={(e) => update('mode', e.target.value as 'light' | 'dark')} className={inputCls}>
                    <option value="light">{t('dashboards.themeModal.modeLight')}</option>
                    <option value="dark">{t('dashboards.themeModal.modeDark')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.pageBgLabel')}</span>
                  <input type="text" value={theme.background || ''} placeholder={t('dashboards.themeModal.pageBgPlaceholder')} onChange={(e) => update('background', e.target.value)} className={inputCls} />
                </label>
              </div>

              {/* Background IMAGE */}
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  <ImageIcon className="h-3.5 w-3.5" /> {t('dashboards.themeModal.bgImageHeading')}
                </div>
                <p className="mb-2.5 text-xs text-text-quaternary">{t('dashboards.themeModal.bgImageHint')}</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { onPickImage(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = ''; }}
                />
                {theme.backgroundImage ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-16 w-28 shrink-0 rounded-md border border-[rgb(var(--border-line))] bg-cover bg-center"
                        style={{ backgroundImage: `url("${theme.backgroundImage}")` }}
                      />
                      <div className="flex flex-col gap-1.5">
                        <button type="button" onClick={() => fileRef.current?.click()} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-xs hover:bg-surface-3">
                          {t('dashboards.themeModal.changeImage')}
                        </button>
                        <button type="button" onClick={() => update('backgroundImage', '')} className="flex items-center gap-1 text-xs text-text-quaternary hover:text-danger">
                          <Trash2 className="h-3.5 w-3.5" /> {t('dashboards.themeModal.removeImage')}
                        </button>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!theme.glassCards} onChange={(e) => update('glassCards', e.target.checked)} className="accent-[rgb(var(--brand))]" />
                      <span className="text-text-secondary">{t('dashboards.themeModal.glassCards')}</span>
                    </label>
                    <label className="flex items-center gap-3 text-sm">
                      <span className="w-28 shrink-0 text-text-tertiary">{t('dashboards.themeModal.overlayLabel')}</span>
                      <input type="range" min={0} max={70} step={5}
                        value={Math.round((typeof theme.bgOverlay === 'number' ? theme.bgOverlay : 0) * 100)}
                        onChange={(e) => update('bgOverlay', Number(e.target.value) / 100)}
                        className="flex-1 accent-[rgb(var(--brand))]" />
                      <span className="w-12 text-right tabular-nums text-text-secondary">{Math.round((typeof theme.bgOverlay === 'number' ? theme.bgOverlay : 0) * 100)}%</span>
                    </label>
                  </div>
                ) : (
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-3 py-4 text-sm text-text-tertiary hover:border-brand/50 hover:text-text-primary">
                    <Upload className="h-4 w-4" /> {t('dashboards.themeModal.pickImage')}
                  </button>
                )}
                {bgError && <p className="mt-2 text-xs text-danger">{bgError}</p>}
              </div>
            </div>
          )}

          {/* ── MÀU ─────────────────────────────────────────────── */}
          {section === 'color' && (
            <div className="space-y-5">
              <div className="space-y-3">
                <ColorRow label={t('dashboards.themeModal.accentColor')} value={theme.accent} fallback="#2563eb" placeholder="#2563eb" onChange={(v) => update('accent', v)} />
              </div>

              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.dataPaletteHeading')}</div>
                  <div className="flex gap-1">
                    {PALETTE_PRESETS.map((p) => (
                      <button key={p.label} type="button" onClick={() => update('dataColors', [...p.colors])}
                        className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs hover:bg-surface-3" title={t(p.label)}>
                        <span className="flex items-center gap-0.5">
                          {p.colors.slice(0, 5).map((c, i) => (
                            <span key={i} className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: c }} />
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mb-2 text-xs text-text-quaternary">{t('dashboards.themeModal.dataPaletteHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {dataColors.map((c, i) => (
                    <div key={i} className="group relative">
                      <input type="color" value={/^#([0-9a-f]{6})$/i.test(c) ? c : '#2563eb'} onChange={(e) => setColorAt(i, e.target.value)}
                        className="h-9 w-9 rounded-md border border-[rgb(var(--border-line))]" />
                      <button type="button" onClick={() => removeColorAt(i)}
                        className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-danger text-white group-hover:flex">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={addColor}
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-[rgb(var(--border-line))] text-text-tertiary hover:text-text-primary">
                    <Plus className="h-4 w-4" />
                  </button>
                  {dataColors.length > 0 && (
                    <button type="button" onClick={() => update('dataColors', undefined)}
                      className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-text-quaternary hover:text-text-secondary">
                      <Trash2 className="h-3.5 w-3.5" /> {t('dashboards.themeModal.clearAll')}
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.statusColorsHeading')}</div>
                <p className="mb-2 text-xs text-text-quaternary">{t('dashboards.themeModal.statusColorsHint')}</p>
                <div className="space-y-2.5">
                  <ColorRow label={t('dashboards.themeModal.statusGood')} value={theme.goodColor} fallback="#16a34a" onChange={(v) => update('goodColor', v)} />
                  <ColorRow label={t('dashboards.themeModal.statusNeutral')} value={theme.neutralColor} fallback="#6b7280" onChange={(v) => update('neutralColor', v)} />
                  <ColorRow label={t('dashboards.themeModal.statusBad')} value={theme.badColor} fallback="#dc2626" onChange={(v) => update('badColor', v)} />
                </div>
              </div>
            </div>
          )}

          {/* ── CHỮ ─────────────────────────────────────────────── */}
          {section === 'text' && (
            <div className="space-y-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-text-tertiary">{t('dashboards.themeModal.fontFamily')}</span>
                <input type="text" value={theme.fontFamily || ''} placeholder={t('dashboards.themeModal.fontFamilyPlaceholder')}
                  onChange={(e) => update('fontFamily', e.target.value)} className={inputCls} />
              </label>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.fontSizeHeading')}</div>
                <div className="space-y-3">
                  <SliderRow label={t('dashboards.themeModal.chartTitleSize')} value={titleSizeNum} min={10} max={28} onChange={(px) => update('titleFontSize', px)} />
                  <SliderRow label={t('dashboards.themeModal.axisLabelSize')} value={labelSizeNum} min={8} max={18} onChange={(px) => update('labelFontSize', px)} />
                  <SliderRow label={t('dashboards.themeModal.kpiSize')} value={kpiSizeNum} min={20} max={72} onChange={(px) => update('kpiFontSize', px)} />
                </div>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3 space-y-2.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.textColorHeading')}</div>
                <ColorRow label={t('dashboards.themeModal.titleColor')} value={theme.titleColor} fallback="#0f172a" onChange={(v) => update('titleColor', v)} />
              </div>
            </div>
          )}

          {/* ── THẺ ─────────────────────────────────────────────── */}
          {section === 'card' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.cardStyleLabel')}</span>
                  <select value={theme.cardStyle} onChange={(e) => update('cardStyle', e.target.value as 'soft' | 'sharp' | 'flat' | 'elevated')} className={inputCls}>
                    <option value="soft">{t('dashboards.themeModal.cardStyleSoft')}</option>
                    <option value="elevated">{t('dashboards.themeModal.cardStyleElevated')}</option>
                    <option value="sharp">{t('dashboards.themeModal.cardStyleSharp')}</option>
                    <option value="flat">{t('dashboards.themeModal.cardStyleFlat')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.densityLabel')}</span>
                  <select value={theme.density ?? 'normal'} onChange={(e) => update('density', e.target.value as 'compact' | 'normal' | 'spacious')} className={inputCls}>
                    <option value="compact">{t('dashboards.themeModal.densityCompact')}</option>
                    <option value="normal">{t('dashboards.themeModal.densityNormal')}</option>
                    <option value="spacious">{t('dashboards.themeModal.densitySpacious')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.shadowLabel')}</span>
                  <select value={theme.cardShadow ? 'on' : 'off'} onChange={(e) => update('cardShadow', e.target.value === 'on' ? '0 10px 30px -18px rgba(15,23,42,0.45)' : undefined as any)} className={inputCls}>
                    <option value="off">{t('dashboards.themeModal.shadowOff')}</option>
                    <option value="on">{t('dashboards.themeModal.shadowOn')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-tertiary">{t('dashboards.themeModal.hoverLabel')}</span>
                  <select value={theme.hoverAnimation ?? 'none'} onChange={(e) => update('hoverAnimation', e.target.value)} className={inputCls}>
                    <option value="none">{t('dashboards.themeModal.hoverNone')}</option>
                    <option value="lift">{t('dashboards.themeModal.hoverLift')}</option>
                    <option value="scale">{t('dashboards.themeModal.hoverScale')}</option>
                    <option value="glow">{t('dashboards.themeModal.hoverGlow')}</option>
                  </select>
                </label>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.borderRadiusHeading')}</div>
                <div className="space-y-3">
                  <SliderRow label={t('dashboards.themeModal.cornerRadius')} value={radiusNum} min={0} max={24} onChange={(px) => update('cardRadius', px)} />
                  <SliderRow label={t('dashboards.themeModal.borderWidth')} value={borderNum} min={0} max={4} onChange={(px) => update('cardBorderWidth', px)} />
                  <ColorRow label={t('dashboards.themeModal.borderColor')} value={theme.cardBorderColor} fallback="#e2e8f0" onChange={(v) => update('cardBorderColor', v)} />
                </div>
              </div>
            </div>
          )}

          {/* ── BIỂU ĐỒ ─────────────────────────────────────────── */}
          {section === 'chart' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3 space-y-2.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.gridAxisHeading')}</div>
                <p className="text-xs text-text-quaternary">{t('dashboards.themeModal.gridAxisHint')}</p>
                <ColorRow label={t('dashboards.themeModal.gridlineColor')} value={theme.gridlineColor} fallback="#e2e8f0" onChange={(v) => update('gridlineColor', v)} />
                <ColorRow label={t('dashboards.themeModal.axisLabelColor')} value={theme.axisLabelColor} fallback="#64748b" onChange={(v) => update('axisLabelColor', v)} />
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3 space-y-2.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.displayUnitsLabel')}</div>
                <p className="text-xs text-text-quaternary">{t('dashboards.themeModal.displayUnitsHint')}</p>
                <select
                  value={(theme.displayUnits as string) ?? ''}
                  onChange={(e) => update('displayUnits', (e.target.value || '') as DashboardThemeConfig['displayUnits'])}
                  className={inputCls}
                >
                  <option value="">{t('dashboards.themeModal.duInherit')}</option>
                  <option value="auto">{t('dashboards.themeModal.duAuto')}</option>
                  <option value="none">{t('dashboards.themeModal.duNone')}</option>
                  <option value="thousands">{t('dashboards.themeModal.duThousands')}</option>
                  <option value="millions">{t('dashboards.themeModal.duMillions')}</option>
                  <option value="billions">{t('dashboards.themeModal.duBillions')}</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-5 py-3">
          <button onClick={onClose} className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-sm hover:bg-surface-3">
            {t('common.cancel')}
          </button>
          <button onClick={submit} disabled={saving} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {saving ? t('dashboards.themeModal.saving') : t('dashboards.themeModal.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
