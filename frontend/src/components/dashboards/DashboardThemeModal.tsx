'use client';

import React, { useRef, useState } from 'react';
import { X, Plus, Trash2, LayoutTemplate, Palette as PaletteIcon, Type, Square, BarChart3, ImageIcon, Upload, Check, Sparkles, Download, Wand2, AlertTriangle } from 'lucide-react';
import type { DashboardThemeConfig } from '@/types/api';
import { useI18n } from '@/providers/LanguageProvider';
import {
  CARD_TREATMENTS, CHART_CHROMES, KPI_STYLES, TABLE_STYLES, SLICER_STYLES,
  LABEL_STYLES, NUMERIC_FONTS, MARK_FILLS, SECTION_SURFACES,
  FILTER_DOCKS, SLICER_VARIANTS,
  TYPOGRAPHY_ROLES, TYPO_BASE_DEFAULT,
  contrastRatio, paletteFromBrandColor, resolveStyleTokens,
  type CardTreatment, type ChartChrome, type KpiStyle, type TableStyle, type SlicerStyle,
} from '@/lib/dashboard-theme-tokens';
import {
  COLORWAYS, COLORWAY_KEYS, LEGACY_PRESET_MAP, TEMPLATES, TEMPLATE_KEYS,
  type Colorway, type LayoutTemplate as LayoutTemplateDef,
} from '@/lib/dashboard-theme-catalog';
import { Button } from '@/components/ui/Button';
import { ThemeLivePreview } from './ThemeLivePreview';

type Props = {
  initial: DashboardThemeConfig | null | undefined;
  onClose: () => void;
  onSave: (theme: DashboardThemeConfig) => Promise<void> | void;
  /**
   * Re-flow the report into the picked template's topology.
   *
   * Optional and explicit. A template is a composition -- a KPI strip over a
   * chart grid, a rail beside one main chart, a dense wall -- but that
   * composition was only ever applied when a report was IMPORTED. Picking a
   * template afterwards repainted it and left every tile where the previous
   * template had put it, which is why five presets read as one layout in five
   * palettes. Offering it as an action rather than doing it on save keeps a
   * hand-arranged report from being rearranged because someone tried a colour.
   */
  onApplyLayout?: (templateId: string) => Promise<void> | void;
};

/**
 * Every key `resolveStyleTokens` reads, in one list.
 *
 * Why this exists: the seed below and `submit()` used to be two hand-written
 * allow-lists, and the token keys were in NEITHER. The Styles gallery wrote
 * `cardTreatment` etc. into state, the live preview honoured them, and `submit()`
 * quietly dropped every one on save — the whole token layer was write-only. A DB
 * sweep found 0 of 33 dashboards carrying a single token key. Both places now
 * derive from this constant, so a new token can't be half-wired again.
 */
const TOKEN_KEYS = [
  // style vocabularies (the Styles gallery)
  'cardTreatment', 'chartChrome', 'kpiStyle', 'tableStyle', 'slicerStyle',
  'labelStyle', 'numericFont', 'sectionSurface', 'markFill',
  // composition — where the filters live and how each control presents
  'filterDock', 'slicerVariant',
  // typography scale
  'typoBase',
  // card detail overrides (Advanced)
  'accentBar', 'accentSize', 'cardTint', 'cardShadowLevel', 'cardBorderStyle',
  'cardBlur', 'cardOpacity',
  // chart chrome overrides (Advanced)
  'gridlines', 'axisLine', 'barRadius', 'lineWidth', 'areaOpacity',
  'legendStyle', 'plotBackground', 'dataLabelStyle',
  // Which layout and which palette the report is on. Both are real state, not
  // derived: without them the menu can only guess from the legacy single
  // `presetId`, and a report whose layout or colour has been fine-tuned since
  // would open with the wrong card ticked — or none at all.
  'templateId', 'colorwayId',
] as const;

/**
 * Pre-token keys that also define the look, so applying a preset has to clear
 * them too.
 *
 * These beat the token layer wherever both are set — `resolveStyleTokens` takes
 * an explicit `cardShadow` string over the treatment's shadow level, and an
 * explicit `titleFontSize` is applied inline and so overrides the `chartTitle`
 * typography role. Left behind by the previous theme they silently defeat the
 * preset you just picked: High contrast is `outline` + no shadow, but arrived
 * carrying the old Modern soft shadow and a pinned 15px title.
 */
const LEGACY_LOOK_KEYS = [
  'cardShadow', 'cardBorderWidth', 'cardBorderColor',
  'titleFontSize', 'titleColor', 'labelFontSize', 'kpiFontSize',
  'gridlineColor', 'axisLabelColor', 'hoverAnimation', 'displayUnits',
] as const;

/** Copy the token keys that carry a real value. `false` is a real value
 *  (`axisLine`), so only undefined/null/'' are treated as "not set". */
function pickTokenKeys(src?: Record<string, any> | null): Record<string, any> {
  const out: Record<string, any> = {};
  if (!src) return out;
  for (const k of TOKEN_KEYS) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** Full-theme presets — one click sets a coherent, validated look (Power BI
 *  "report theme"). Each carries the WHOLE look: the structural tokens
 *  (card / chart chrome / KPI / table / slicer / type scale) AND the colour
 *  layer (background, accent, categorical palette, status colours).
 *
 *  Two rules these presets follow, both learned the hard way:
 *
 *  1. **A preset must set the structural tokens, not just colours.** Before this
 *     rewrite all 11 presets set only `accent`/`dataColors`/`background`, so
 *     every one of them fell through to `SKIN_DEFAULTS` — 3 rendered as Modern,
 *     8 as Classic. Eleven entries, two actual looks, which is exactly what
 *     "changing the preset only changes the colour" felt like.
 *  2. **Every palette is generated in OKLCH and validated**, not hand-picked.
 *     Each one clears the lightness band, the chroma floor, adjacent-pair CVD
 *     separation (protan/deutan/tritan) and the normal-vision floor, and its
 *     first three slots additionally clear those floors on the ALL-pairs list
 *     (the cap for scatter/bubble/choropleth — eight slots cannot clear
 *     all-pairs under any ordering). The palettes they replaced failed: one
 *     shipped `#fff1f1` (contrast 1.07 — invisible) inside a preset named
 *     "high contrast", and two used a sequential/diverging ramp (viridis,
 *     RdYlBu) as a categorical palette. */
/**
 * The theme menu, as two independent choices.
 *
 * It used to be 19 bundles that each fixed a layout AND a palette together, so
 * "Modern Indigo" and "Modern Emerald" were two menu entries for one layout in
 * two colours, while the thing that actually differs between a boardroom report
 * and an ops wall — where the filters live, how dense the grid is, how loud the
 * type is — was buried inside a name that sounded like a colour. Grouping the
 * 19 by their real composition collapsed them to five.
 *
 *   TEMPLATE decides the layout: filter dock, slicer control, card treatment,
 *            chart chrome, KPI/table style, type scale, density.
 *   COLORWAY decides the paint: accent, categorical palette, background, mode.
 *
 * Five templates × eight colorways is forty looks from thirteen menu entries,
 * and — the point — the two choices are independent: repainting a report never
 * moves its filters, and changing its layout never loses its brand colour.
 */


/** Data-color (series) palettes — the report-wide chart palette, like PBI. */
const PALETTE_PRESETS: Array<{ label: string; colors: string[] }> = [
  { label: 'dashboards.themeModal.paletteDefault', colors: ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#7c3aed', '#06b6d4', '#ec4899', '#84cc16'] },
  { label: 'dashboards.themeModal.paletteEnterprise', colors: ['#1e3a5f', '#2e6da4', '#5b9bd5', '#a5c8e1', '#c9a227', '#8c8c8c'] },
  { label: 'dashboards.themeModal.paletteVibrant', colors: ['#ff6b6b', '#feca57', '#1dd1a1', '#5f27cd', '#54a0ff', '#ff9ff3'] },
  { label: 'dashboards.themeModal.paletteSoft', colors: ['#7c93d8', '#6ec79a', '#e6b566', '#e88aa6', '#a07ad8', '#5fc2bb'] },
];

/**
 * Two tabs, not six.
 *
 * Four of the original six — Text, Cards, Charts, Styles — were all the same
 * thing: individual overrides of tokens a template already sets. Splitting them
 * across four tabs made the everyday job (pick a look, pick a colour) look like
 * a six-step configuration, and hid the two choices that matter behind a row of
 * equals. They now live together under Fine-tune, which the Basic/Advanced
 * switch reveals, so Basic mode is a single tab.
 */
const SECTIONS = [
  { key: 'mau', label: 'dashboards.themeModal.sectionTemplates', icon: LayoutTemplate },
  { key: 'tune', label: 'dashboards.themeModal.sectionFineTune', icon: Sparkles },
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

/**
 * A template swatch shows the LAYOUT, not the colours.
 *
 * The old swatch drew a palette, which is exactly why fifteen entries looked
 * interchangeable — the thing that actually differs between these five is where
 * the filters sit, how dense the grid is and how big the type runs, and none of
 * that was visible. This draws the composition in one neutral tone: the filter
 * dock as a solid band, the KPI row, the chart area, at the template's own
 * density. Colour is deliberately absent; it is the other choice.
 */
function TemplateCard({ tpl, active, onApply }: {
  tpl: LayoutTemplateDef; active: boolean; onApply: () => void;
}) {
  const { t } = useI18n();
  const v = tpl.value;
  const dock = String(v.filterDock ?? 'top');
  const gap = v.density === 'compact' ? 2 : v.density === 'spacious' ? 5 : 3.5;
  const radius = Math.min(pxNum(v.cardRadius, 8) / 2.2, 6);
  const ink = 'rgb(var(--text-primary))';

  const block = (o: number, extra?: React.CSSProperties): React.CSSProperties => ({
    background: ink, opacity: o, borderRadius: radius, ...extra,
  });
  /** The filter dock, drawn as the one emphasised element. */
  const filterBar = (
    <div
      style={{
        display: 'flex', gap: 2,
        ...(dock === 'left' || dock === 'right'
          ? { flexDirection: 'column', width: 13, flex: '0 0 auto' }
          : { flexDirection: 'row', height: 7 }),
      }}
    >
      {[0, 1, 2].map((i) => (
        <div key={i} style={block(0.42, dock === 'left' || dock === 'right'
          ? { height: 5, width: '100%' }
          : { width: dock === 'drawer' ? 12 : 22, height: '100%' })} />
      ))}
    </div>
  );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={block(0.13, { flex: 1, height: v.typoBase && v.typoBase >= 16 ? 15 : 12 })} />
        ))}
      </div>
      <div style={{ display: 'flex', gap, flex: 1 }}>
        <div style={block(0.1, { flex: 2 })} />
        <div style={block(0.1, { flex: 1 })} />
      </div>
    </div>
  );

  return (
    <button
      type="button"
      onClick={onApply}
      title={t(tpl.label)}
      className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition ${
        active ? 'border-brand ring-2 ring-brand/40' : 'border-[rgb(var(--border-line))] hover:border-brand/50'
      }`}
    >
      {active && (
        <span className="absolute right-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      <div
        className="bg-surface-2"
        style={{
          padding: gap + 3, height: 104,
          display: 'flex', gap: gap + 1,
          flexDirection: dock === 'left' ? 'row' : dock === 'right' ? 'row-reverse' : dock === 'bottom' ? 'column-reverse' : 'column',
        }}
      >
        {dock !== 'hidden' && filterBar}
        {body}
      </div>
      <div className="border-t border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5">
        <div className="truncate text-xs font-semibold text-text-primary">{t(tpl.label)}</div>
        <div className="truncate text-[10px] text-text-quaternary">{t(tpl.hint)}</div>
      </div>
    </button>
  );
}

/** A colorway swatch shows only paint: the page ground and the series ramp. */
function ColorwayCard({ cw, active, onApply }: {
  cw: Colorway; active: boolean; onApply: () => void;
}) {
  const { t } = useI18n();
  const colors = (cw.value.dataColors ?? []).slice(0, 8);
  return (
    <button
      type="button"
      onClick={onApply}
      title={t(cw.label)}
      className={`relative flex flex-col overflow-hidden rounded-lg border text-left transition ${
        active ? 'border-brand ring-2 ring-brand/40' : 'border-[rgb(var(--border-line))] hover:border-brand/50'
      }`}
    >
      {active && (
        <span className="absolute right-1 top-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand text-white">
          <Check className="h-2.5 w-2.5" />
        </span>
      )}
      <div style={{ background: cw.value.background, padding: 7 }}>
        <div className="flex overflow-hidden rounded" style={{ height: 22 }}>
          {colors.map((c, i) => (
            <span key={i} style={{ background: c, flex: 1 }} />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cw.value.accent }} />
        <span className="truncate text-[11px] font-medium text-text-primary">{t(cw.label)}</span>
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

export function DashboardThemeModal({ initial, onClose, onSave, onApplyLayout }: Props) {
  const [relayoutBusy, setRelayoutBusy] = useState(false);
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
    // The SKIN must round-trip. It used to be missing from this seed, so opening
    // this dialog and pressing Save — without touching anything — dropped
    // `skin:'modern'` on submit and the report silently fell back to the classic
    // look while the Modern preset card still showed as selected.
    skin: initial?.skin === 'modern' ? 'modern' : 'classic',
    // Every token `resolveStyleTokens` reads. Seeded from the SAME list
    // `submit()` writes back, so a saved token always survives a round-trip
    // through this dialog.
    ...pickTokenKeys(initial as any),
  });
  // Basic vs Advanced. Basic is the whole job for most people: pick a look and
  // go. Advanced exposes the individual tokens behind those looks — kept behind
  // a switch so the everyday path is not a wall of sliders.
  const [advanced, setAdvanced] = useState(false);
  const [ioError, setIoError] = useState('');
  const themeFileRef = useRef<HTMLInputElement>(null);
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
  /**
   * Apply a LAYOUT. Clears only the keys a template owns, so the report keeps
   * whatever colour it is currently wearing — changing how a report is laid out
   * must never repaint it.
   */
  const applyTemplate = (tpl: LayoutTemplateDef) =>
    setTheme((t) => {
      const cleared: Record<string, any> = {};
      for (const k of TEMPLATE_KEYS) cleared[k] = undefined;
      // The pre-token look keys have to go too. They OUTRANK the token layer —
      // an explicit `cardShadow` string beats the treatment's shadow level, and
      // `titleFontSize` / `kpiFontSize` / `labelFontSize` are applied inline so
      // they beat the typography roles. Left behind by the previous template
      // they silently defeat the one just picked: Brief (clean, no shadow, 14px
      // roles) would arrive still wearing Console's soft shadow and a pinned
      // 15px title.
      for (const k of LEGACY_LOOK_KEYS) cleared[k] = undefined;
      return {
        ...t, ...cleared, ...tpl.value,
        skin: tpl.value.skin === 'modern' ? 'modern' : 'classic',
        templateId: tpl.id,
        // The legacy single-id field is kept in step so a report saved now still
        // opens correctly on a build that has not shipped this yet.
        presetId: `${tpl.id}-${(t as any).colorwayId ?? 'indigo'}`,
      };
    });

  /**
   * Apply a PALETTE. Clears only colour keys, so repainting never moves a
   * filter or changes the density.
   */
  const applyColorway = (cw: Colorway) =>
    setTheme((t) => {
      const cleared: Record<string, any> = {};
      for (const k of COLORWAY_KEYS) cleared[k] = undefined;
      return {
        ...t, ...cleared, ...cw.value,
        colorwayId: cw.id,
        presetId: `${(t as any).templateId ?? 'console'}-${cw.id}`,
        // A user-uploaded background survives both choices.
        backgroundImage: t.backgroundImage,
        glassCards: t.glassCards,
      };
    });

  // The SKIN is the design language (Modern vs Classic); a preset is just a set
  // of starting values. Keeping them separate is what lets someone take Modern
  // Indigo, repaint it in their brand colour and still have a Modern report —
  // previously the only way to get Modern was to keep a Modern preset untouched.
  const setSkin = (skin: 'modern' | 'classic') =>
    setTheme((t) => ({
      ...t,
      skin,
      // Modern needs a soft, rounded card to read as Modern at all; a sharp
      // 0-radius card with an accent stripe just looks broken. Nudge the card
      // when it is still at the classic default, never overwrite a real choice.
      ...(skin === 'modern' && (!t.cardRadius || pxNum(t.cardRadius, 8) < 10)
        ? { cardStyle: t.cardStyle === 'sharp' ? 'soft' : t.cardStyle, cardRadius: 16 }
        : {}),
    }));

  // Which preset is this theme based on, and has the user moved away from it?
  // Derived by COMPARING against the preset rather than tracking edits: it stays
  // correct no matter how the value got there (preset click, manual edit, reset,
  // or a theme saved by an older build).
  // Which template / colorway is active. A dashboard saved before the rework
  // only has a `presetId`, so fall back through the legacy map rather than
  // opening with nothing selected and making the user guess.
  const legacy = LEGACY_PRESET_MAP[String(theme.presetId ?? '')];
  const activeTemplateId = String((theme as any).templateId ?? legacy?.template ?? '');
  const activeColorwayId = String((theme as any).colorwayId ?? legacy?.colorway ?? '');
  const baseTemplate = TEMPLATES.find((x) => x.id === activeTemplateId);
  const baseColorway = COLORWAYS.find((x) => x.id === activeColorwayId);

  /** Has the user moved away from the chosen layout? Compared by value so it
   *  stays right however the value got there. */
  const isCustomised = React.useMemo(() => {
    if (!baseTemplate) return false;
    const same = (a: unknown, b: unknown) => {
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
      if (a == null || a === '') return b == null || b === '';
      if (typeof a === 'number' || typeof b === 'number') return pxNum(a as any, NaN) === pxNum(b as any, NaN);
      return String(a) === String(b);
    };
    return Object.entries(baseTemplate.value).some(([k, v]) => !same((theme as any)[k], v));
  }, [baseTemplate, theme]);

  // Style galleries. Each entry is a designed bundle of the tokens in
  // lib/dashboard-theme-tokens — the user combines looks, never raw CSS, which
  // is what keeps a heavily customised report from turning ugly.
  const setStyle = (key: string, value: string) => setTheme((t) => ({ ...t, [key]: value }));

  const tokens = React.useMemo(() => resolveStyleTokens(theme), [theme]);

  /** Contrast of the accent against the report background (WCAG). Surfaced
   *  because an on-brand accent is often unreadable on a light card, and nobody
   *  discovers that until a viewer complains. */
  const accentContrast = React.useMemo(() => {
    const bg = /^#?[0-9a-f]{6}$/i.test(String(theme.background ?? '')) ? String(theme.background) : '#ffffff';
    const ratio = contrastRatio(String(theme.accent || '#2563eb'), bg);
    return ratio;
  }, [theme.accent, theme.background]);

  /** Build a full categorical palette from the accent (brand → palette). */
  const generatePalette = () => {
    const colors = paletteFromBrandColor(String(theme.accent || '#2563eb'), 8);
    if (colors.length) setTheme((t) => ({ ...t, dataColors: colors }));
  };

  /** Export the theme as a .json file so it can be reused or version-controlled. */
  const exportTheme = () => {
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'appbi-theme.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const importTheme = async (file: File | null | undefined) => {
    setIoError('');
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      // Merge rather than replace: an exported theme from an older build may not
      // carry every key, and dropping the ones it lacks would silently reset
      // parts of the report the user never intended to change.
      setTheme((t) => ({ ...t, ...parsed }));
    } catch {
      setIoError(t('dashboards.themeModal.importError'));
    }
  };

  /** Back to the preset this theme started from, keeping the uploaded image. */
  const resetToPreset = () => { if (baseTemplate) applyTemplate(baseTemplate); };
  /** Back to what the dashboard had when this dialog opened. */
  const resetToSaved = () =>
    setTheme((t) => ({
      ...t,
      ...(initial ?? {}),
      skin: initial?.skin === 'modern' ? 'modern' : 'classic',
      presetId: initial?.presetId ?? '',
    }));

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
        // Written explicitly in BOTH directions: 'classic' has to be stored, not
        // just omitted, so switching Modern → Classic is a real change instead of
        // "no value" that a later default could re-interpret.
        skin: theme.skin === 'modern' ? 'modern' : 'classic',
        // The design-token layer. This used to be missing entirely: the Styles
        // gallery and the Advanced sliders wrote these into state, the preview
        // honoured them, and every one was dropped here on save. Derived from
        // TOKEN_KEYS so adding a token can never again mean adding it in one
        // place and forgetting the other.
        ...pickTokenKeys(theme as any),
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
      {/* Sized like the Add-chart dialog (max-w-[92rem]): theming is a
          side-by-side job — settings on the left, live preview on the right —
          and a 42rem box left both panes cramped. Fixed height (not just
          max-height) so switching tabs never resizes the frame; the panes
          scroll internally. */}
      <div className="flex w-full max-w-[92rem] flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg" style={{ height: 'min(860px, 92vh)' }}>
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('dashboards.themeModal.title')}</h2>
            <p className="text-xs text-text-tertiary">{t('dashboards.themeModal.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Advanced exposes the individual tokens behind the styles; Basic
                keeps the everyday path to "pick a look and go". */}
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                advanced
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:bg-surface-3'
              }`}
            >
              {t(advanced ? 'dashboards.themeModal.modeAdvanced' : 'dashboards.themeModal.modeBasic')}
            </button>
            <button type="button" onClick={exportTheme} title={t('dashboards.themeModal.exportTheme')}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-1.5 text-text-secondary hover:bg-surface-3">
              <Download className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => themeFileRef.current?.click()} title={t('dashboards.themeModal.importTheme')}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-1.5 text-text-secondary hover:bg-surface-3">
              <Upload className="h-3.5 w-3.5" />
            </button>
            <input ref={themeFileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { void importTheme(e.target.files?.[0]); e.currentTarget.value = ''; }} />
            <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
              <X className="h-4 w-4" />
            </button>
          </div>
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

        <div className="flex min-h-0 flex-1">
        {/* The settings column gets the remaining width but caps its content:
            a 60rem-wide row of two inputs is harder to scan, not easier. */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto w-full max-w-4xl">
          {/* ── STYLES (galleries) ───────────────────────────────── */}
          {section === 'tune' && (
            <div className="space-y-5">
              <p className="text-xs text-text-quaternary">{t('dashboards.themeModal.stylesHint')}</p>
              {([
                { key: 'cardTreatment', label: 'dashboards.themeModal.cardStyleHeading', options: CARD_TREATMENTS, current: tokens.cardTreatment },
                { key: 'chartChrome', label: 'dashboards.themeModal.chartStyleHeading', options: CHART_CHROMES, current: tokens.chartChrome },
                { key: 'kpiStyle', label: 'dashboards.themeModal.kpiStyleHeading', options: KPI_STYLES, current: tokens.kpiStyle },
                { key: 'tableStyle', label: 'dashboards.themeModal.tableStyleHeading', options: TABLE_STYLES, current: tokens.tableStyle },
                { key: 'slicerStyle', label: 'dashboards.themeModal.slicerStyleHeading', options: SLICER_STYLES, current: tokens.slicerStyle },
                { key: 'labelStyle', label: 'dashboards.themeModal.labelStyleHeading', options: LABEL_STYLES, current: tokens.labelStyle },
                { key: 'numericFont', label: 'dashboards.themeModal.numericFontHeading', options: NUMERIC_FONTS, current: tokens.numericFont },
                { key: 'markFill', label: 'dashboards.themeModal.markFillHeading', options: MARK_FILLS, current: tokens.chart.markFill },
                { key: 'sectionSurface', label: 'dashboards.themeModal.sectionSurfaceHeading', options: SECTION_SURFACES, current: tokens.sectionSurface },
                { key: 'filterDock', label: 'dashboards.themeModal.filterDockHeading', options: FILTER_DOCKS, current: tokens.filterDock },
                { key: 'slicerVariant', label: 'dashboards.themeModal.slicerVariantHeading', options: SLICER_VARIANTS, current: tokens.slicerVariant },
              ] as const).map((group) => (
                <div key={group.key}>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t(group.label)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.options.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setStyle(group.key, opt)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition ${
                          group.current === opt
                            ? 'border-brand bg-brand/10 text-brand'
                            : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary hover:bg-surface-3'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {advanced && (
                <div className="space-y-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.advancedHeading')}</div>

                  {/* Card treatment details */}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.accentBar')}</span>
                      <select value={String(theme.accentBar ?? tokens.accentBar)} onChange={(e) => update('accentBar' as any, e.target.value as any)} className={inputCls}>
                        {['top', 'bottom', 'left', 'right', 'none'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.accentSize')}: {tokens.accentSize}px</span>
                      <input type="range" min={0} max={8} value={tokens.accentSize}
                        onChange={(e) => update('accentSize' as any, Number(e.target.value) as any)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.cardTint')}: {tokens.tint}%</span>
                      <input type="range" min={0} max={40} value={tokens.tint}
                        onChange={(e) => update('cardTint' as any, Number(e.target.value) as any)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.cardBlur')}: {tokens.blur}px</span>
                      <input type="range" min={0} max={24} value={tokens.blur}
                        onChange={(e) => update('cardBlur' as any, Number(e.target.value) as any)} />
                    </label>
                  </div>

                  {/* Chart chrome details */}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.gridlines')}</span>
                      <select value={tokens.chart.gridlines} onChange={(e) => update('gridlines' as any, e.target.value as any)} className={inputCls}>
                        {['none', 'light', 'solid', 'dashed'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.legendStyle')}</span>
                      <select value={tokens.chart.legend} onChange={(e) => update('legendStyle' as any, e.target.value as any)} className={inputCls}>
                        {['default', 'compact', 'hidden'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.barRadius')}: {tokens.chart.barRadius}px</span>
                      <input type="range" min={0} max={16} value={tokens.chart.barRadius}
                        onChange={(e) => update('barRadius' as any, Number(e.target.value) as any)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.lineWidth')}: {tokens.chart.lineWidth}px</span>
                      <input type="range" min={1} max={6} step={0.5} value={tokens.chart.lineWidth}
                        onChange={(e) => update('lineWidth' as any, Number(e.target.value) as any)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.areaOpacity')}: {Math.round(tokens.chart.areaOpacity * 100)}%</span>
                      <input type="range" min={0} max={100} value={Math.round(tokens.chart.areaOpacity * 100)}
                        onChange={(e) => update('areaOpacity' as any, (Number(e.target.value) / 100) as any)} />
                    </label>
                    <label className="flex items-center gap-2 pt-5 text-xs">
                      <input type="checkbox" checked={tokens.chart.axisLine}
                        onChange={(e) => update('axisLine' as any, e.target.checked as any)} />
                      <span className="text-text-tertiary">{t('dashboards.themeModal.axisLine')}</span>
                    </label>
                  </div>

                  {/* Typography roles */}
                  <div>
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.typographyHeading')}</div>
                    <label className="mb-2 flex flex-col gap-1 text-xs">
                      <span className="text-text-tertiary">{t('dashboards.themeModal.typoBase')}: {tokens.typoBase}px</span>
                      <input type="range" min={11} max={20} value={tokens.typoBase}
                        onChange={(e) => update('typoBase' as any, Number(e.target.value) as any)} />
                    </label>
                    {/* Roles are shown as the resolved scale, not 13 free inputs:
                        the point is a proportional type system, not 13 chances to
                        make the report inconsistent. */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {TYPOGRAPHY_ROLES.map((r) => (
                        <div key={r.key} className="flex items-baseline justify-between text-[11px]">
                          <span className="text-text-quaternary">{r.key}</span>
                          <span className="tabular-nums text-text-secondary">{Math.round(tokens.typoBase * r.scale * 10) / 10}px</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MẪU ─────────────────────────────────────────────── */}
          {section === 'mau' && (
            <div className="space-y-5">
              {/* The design language used to be a second control here (Modern vs
                  Classic). A template now carries `skin`, so keeping it meant
                  two widgets driving one value that could disagree — pick a
                  layout and the language comes with it. */}

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.presetsHeading')}</div>
                  {baseTemplate && isCustomised && (
                    <div className="flex items-center gap-2">
                      {/* A preset is a starting point: once anything differs, say so
                          instead of leaving the card ticked as if it were pristine. */}
                      <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-text-secondary">
                        {t('dashboards.themeModal.customBasedOn', { preset: t(baseTemplate.label) })}
                      </span>
                      <button type="button" onClick={resetToPreset} className="text-[11px] font-medium text-brand hover:underline">
                        {t('dashboards.themeModal.resetToPreset')}
                      </button>
                    </div>
                  )}
                </div>
                <p className="mb-2.5 text-xs text-text-quaternary">{t('dashboards.themeModal.presetsHint')}</p>

                {/* Two choices, in the order people actually make them: what
                    KIND of report is this, then what colour is it. They are
                    independent — repainting never moves a filter, and changing
                    the layout never loses the brand colour. */}
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {t('dashboards.themeModal.stepLayout')}
                  </h4>
                  <span className="truncate text-[11px] text-text-quaternary">{t('dashboards.themeModal.stepLayoutHint')}</span>
                </div>
                <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                  {TEMPLATES.map((tpl) => (
                    <TemplateCard
                      key={tpl.id}
                      tpl={tpl}
                      active={activeTemplateId === tpl.id && !isCustomised}
                      onApply={() => applyTemplate(tpl)}
                    />
                  ))}
                </div>

                {/* Picking a template repaints and re-docks. Re-flowing the
                    tiles into its topology is the other half, and it is offered
                    rather than done: it moves tiles someone may have placed by
                    hand. Undo covers it either way. */}
                {onApplyLayout && activeTemplateId && (
                  <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-3 py-2">
                    <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-text-tertiary">
                      {t('dashboards.themeModal.relayoutHint')}
                    </p>
                    <Button
                      variant="secondary"
                      size="xs"
                      loading={relayoutBusy}
                      onClick={async () => {
                        setRelayoutBusy(true);
                        try { await onApplyLayout(activeTemplateId); }
                        finally { setRelayoutBusy(false); }
                      }}
                    >
                      {t('dashboards.themeModal.relayoutApply')}
                    </Button>
                  </div>
                )}

                <div className="mb-1.5 flex items-baseline gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {t('dashboards.themeModal.stepColour')}
                  </h4>
                  <span className="truncate text-[11px] text-text-quaternary">{t('dashboards.themeModal.stepColourHint')}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  {COLORWAYS.map((cw) => (
                    <ColorwayCard
                      key={cw.id}
                      cw={cw}
                      active={activeColorwayId === cw.id}
                      onApply={() => applyColorway(cw)}
                    />
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
          {section === 'tune' && (
            <div className="space-y-5">
              <div className="space-y-3">
                <ColorRow label={t('dashboards.themeModal.accentColor')} value={theme.accent} fallback="#2563eb" placeholder="#2563eb" onChange={(v) => update('accent', v)} />
              </div>

              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboards.themeModal.dataPaletteHeading')}</div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={generatePalette}
                      title={t('dashboards.themeModal.generateFromAccentHint')}
                      className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-3"
                    >
                      <Wand2 className="h-3 w-3" />
                      {t('dashboards.themeModal.generateFromAccent')}
                    </button>
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
          {section === 'tune' && (
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
          {section === 'tune' && (
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
          {section === 'tune' && (
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
        </div>

        {/* Live preview — every setting lands here immediately, so the user sees
            the result before committing. Sample data on purpose: it shows every
            surface at once and stays instant. */}
        <div className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-[rgb(var(--border-line))] bg-surface-2/40 p-4 md:block xl:w-[440px]">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            {t('dashboards.themeModal.previewHeading')}
          </div>
          <ThemeLivePreview theme={theme} />
          {ioError && <p className="mt-2 text-[11px] text-danger">{ioError}</p>}
          {accentContrast != null && accentContrast < 3 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t('dashboards.themeModal.contrastWarning', { ratio: String(accentContrast) })}</span>
            </div>
          )}
        </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-5 py-3">
          <button
            type="button"
            onClick={resetToSaved}
            className="mr-auto rounded-md px-2 py-1.5 text-xs text-text-tertiary hover:text-text-primary"
            title={t('dashboards.themeModal.resetAllHint')}
          >
            {t('dashboards.themeModal.resetAll')}
          </button>
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
