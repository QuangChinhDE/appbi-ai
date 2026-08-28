import type { DashboardThemeConfig } from '@/types/api';

/** Keys a TEMPLATE owns. Applying one replaces exactly these. */
export const TEMPLATE_KEYS = [
  'filterDock', 'slicerVariant',
  'cardTreatment', 'chartChrome', 'kpiStyle', 'tableStyle', 'slicerStyle',
  'labelStyle', 'numericFont', 'markFill', 'sectionSurface',
  'typoBase', 'density', 'cardRadius', 'cardStyle', 'skin',
  'accentBar', 'accentSize', 'cardTint', 'cardBlur', 'cardBorderStyle', 'axisLine',
] as const;

/** Keys a COLORWAY owns. Applying one replaces exactly these. */
export const COLORWAY_KEYS = [
  'mode', 'accent', 'background', 'dataColors',
  'goodColor', 'neutralColor', 'badColor', 'gridlineColor',
  'cardBorderColor',
] as const;

export type LayoutTemplate = { id: string; label: string; hint: string; value: DashboardThemeConfig };
export type Colorway = { id: string; label: string; dark?: boolean; value: DashboardThemeConfig };

/** Five compositions, one per way of reading a report. */
export const TEMPLATES: LayoutTemplate[] = [
  {
    id: 'console', label: 'dashboards.themeModal.tplConsole', hint: 'dashboards.themeModal.tplConsoleHint',
    value: {
      skin: 'modern',
      filterDock: 'top', slicerVariant: 'auto',
      cardTreatment: 'soft', chartChrome: 'clean', kpiStyle: 'accent',
      tableStyle: 'clean', slicerStyle: 'card',
      labelStyle: 'eyebrow', numericFont: 'tabular', markFill: 'gradient', sectionSurface: 'sunken',
      typoBase: 14, density: 'normal', cardRadius: 16, cardStyle: 'soft',
      accentBar: 'top', accentSize: 3, cardTint: 7,
    },
  },
  {
    id: 'brief', label: 'dashboards.themeModal.tplBrief', hint: 'dashboards.themeModal.tplBriefHint',
    value: {
      skin: 'classic',
      filterDock: 'left', slicerVariant: 'dropdown',
      cardTreatment: 'clean', chartChrome: 'executive', kpiStyle: 'benchmark',
      tableStyle: 'executive', slicerStyle: 'card',
      labelStyle: 'caps', numericFont: 'tabular', markFill: 'solid', sectionSurface: 'outline',
      typoBase: 14, density: 'normal', cardRadius: 8, cardStyle: 'soft',
      accentBar: 'none', axisLine: true,
    },
  },
  {
    id: 'ops', label: 'dashboards.themeModal.tplOps', hint: 'dashboards.themeModal.tplOpsHint',
    value: {
      skin: 'classic',
      filterDock: 'left', slicerVariant: 'compact',
      cardTreatment: 'clean', chartChrome: 'minimal', kpiStyle: 'status',
      tableStyle: 'compact', slicerStyle: 'compact',
      labelStyle: 'caps', numericFont: 'mono', markFill: 'solid', sectionSurface: 'none',
      typoBase: 12, density: 'compact', cardRadius: 6, cardStyle: 'flat',
      accentBar: 'none',
    },
  },
  {
    id: 'editorial', label: 'dashboards.themeModal.tplEditorial', hint: 'dashboards.themeModal.tplEditorialHint',
    value: {
      skin: 'classic',
      filterDock: 'drawer', slicerVariant: 'compact',
      cardTreatment: 'frameless', chartChrome: 'editorial', kpiStyle: 'minimal',
      tableStyle: 'clean', slicerStyle: 'minimal',
      labelStyle: 'caps', numericFont: 'inherit', markFill: 'gradient', sectionSurface: 'none',
      typoBase: 16, density: 'spacious', cardRadius: 0, cardStyle: 'flat',
      accentBar: 'none',
    },
  },
  {
    id: 'stage', label: 'dashboards.themeModal.tplStage', hint: 'dashboards.themeModal.tplStageHint',
    value: {
      skin: 'modern',
      filterDock: 'top', slicerVariant: 'segmented',
      cardTreatment: 'elevated', chartChrome: 'vibrant', kpiStyle: 'gradient',
      tableStyle: 'clean', slicerStyle: 'pill',
      labelStyle: 'eyebrow', numericFont: 'tabular', markFill: 'gradient', sectionSurface: 'raised',
      typoBase: 17, density: 'spacious', cardRadius: 20, cardStyle: 'elevated',
      accentBar: 'top', accentSize: 4, cardTint: 6,
    },
  },
];

/**
 * Eight paints. Every categorical palette here was generated in OKLCH and
 * validated: lightness band, chroma floor, adjacent-pair CVD separation
 * (protan/deutan/tritan) and the normal-vision floor, with the first three
 * slots additionally clearing those floors on the all-pairs list. Dark
 * colorways are re-stepped against a dark surface, not flipped.
 */
export const COLORWAYS: Colorway[] = [
  {
    id: 'indigo', label: 'dashboards.themeModal.cwIndigo',
    value: {
      mode: 'light', accent: '#325ac2',
      background: 'linear-gradient(180deg, #f7f8fb 0%, #f2f3f9 100%)',
      dataColors: ['#5886f2', '#925003', '#c360bc', '#6d6600', '#069fa6', '#654abb', '#09a668', '#b02a2d'],
      goodColor: '#09a668', neutralColor: '#6b7280', badColor: '#b02a2d',
      gridlineColor: 'rgba(20,26,42,0.06)', cardBorderColor: 'rgba(20,26,42,0.08)',
    },
  },
  {
    id: 'emerald', label: 'dashboards.themeModal.cwEmerald',
    value: {
      mode: 'light', accent: '#037649',
      background: 'linear-gradient(180deg, #f5faf7 0%, #eff7f2 100%)',
      dataColors: ['#09a668', '#b02a2d', '#5886f2', '#925003', '#c360bc', '#6d6600', '#069fa6', '#654abb'],
      goodColor: '#09a668', neutralColor: '#6b7280', badColor: '#b02a2d',
      gridlineColor: 'rgba(20,26,42,0.06)', cardBorderColor: 'rgba(20,26,42,0.08)',
    },
  },
  {
    id: 'coral', label: 'dashboards.themeModal.cwCoral',
    value: {
      mode: 'light', accent: '#b02a2d',
      background: 'linear-gradient(180deg, #fdf6f4 0%, #fbf0ed 100%)',
      dataColors: ['#b02a2d', '#069fa6', '#7444b4', '#819800', '#0161bd', '#cc7200', '#9e3081', '#03a578'],
      goodColor: '#03a578', neutralColor: '#6b7280', badColor: '#b02a2d',
      gridlineColor: 'rgba(20,26,42,0.06)',
    },
  },
  {
    id: 'ocean', label: 'dashboards.themeModal.cwOcean',
    value: {
      mode: 'light', accent: '#067272',
      background: 'linear-gradient(180deg, #ecfeff 0%, #f0fdfa 100%)',
      dataColors: ['#09a0a0', '#b02a2d', '#9d6fe3', '#5b6c02', '#388cf0', '#925003', '#cd5cac', '#047554'],
      goodColor: '#047554', neutralColor: '#6b7280', badColor: '#b02a2d',
      gridlineColor: 'rgba(20,26,42,0.05)',
    },
  },
  {
    id: 'amber', label: 'dashboards.themeModal.cwAmber',
    value: {
      mode: 'light', accent: '#af2c1f',
      background: 'linear-gradient(180deg, #fff7ed 0%, #fffbeb 100%)',
      dataColors: ['#af2f09', '#099eab', '#7444b4', '#8a9504', '#1f5dc2', '#c07b03', '#9e3081', '#05a480'],
      goodColor: '#05a480', neutralColor: '#6b7280', badColor: '#af2f09',
      gridlineColor: 'rgba(20,26,42,0.06)',
    },
  },
  {
    id: 'slate', label: 'dashboards.themeModal.cwSlate',
    value: {
      mode: 'light', accent: '#1f5587', background: '#eef2f6',
      dataColors: ['#1e8fee', '#8e5300', '#c85eb4', '#676803', '#099eab', '#6d47b8', '#02a671', '#af2c1f'],
      goodColor: '#02a671', neutralColor: '#6b7280', badColor: '#af2c1f',
      gridlineColor: 'rgba(20,26,42,0.07)',
    },
  },
  {
    id: 'midnight', label: 'dashboards.themeModal.cwMidnight', dark: true,
    value: {
      mode: 'dark', accent: '#78a1ff', background: '#0f172a',
      dataColors: ['#5e8cf9', '#a25a02', '#ca66c3', '#797202', '#02a6ad', '#7056c9', '#02ad6d', '#bd3838'],
      goodColor: '#02ad6d', neutralColor: '#94a3b8', badColor: '#bd3838',
      gridlineColor: 'rgba(255,255,255,0.07)',
    },
  },
  {
    id: 'graphite', label: 'dashboards.themeModal.cwGraphite', dark: true,
    value: {
      mode: 'dark', accent: '#a492fb', background: '#101114',
      dataColors: ['#937cf1', '#8c6802', '#df5e97', '#527e03', '#07a1cb', '#9348b1', '#0ca999', '#ad5002'],
      goodColor: '#0ca999', neutralColor: '#8d8d8d', badColor: '#ad5002',
      gridlineColor: 'rgba(255,255,255,0.06)',
    },
  },
];

/**
 * Where the nineteen old bundles land in the new two-axis menu.
 *
 * A dashboard saved before this rework carries a `presetId`; without this it
 * would open with nothing selected and the user would have to guess which of
 * the new entries matched what they were already looking at.
 */
export const LEGACY_PRESET_MAP: Record<string, { template: string; colorway: string }> = {
  'modern-indigo':   { template: 'console',   colorway: 'indigo' },
  'modern-emerald':  { template: 'console',   colorway: 'emerald' },
  'modern-coral':    { template: 'console',   colorway: 'coral' },
  'clean-light':     { template: 'console',   colorway: 'slate' },
  'midnight':        { template: 'console',   colorway: 'midnight' },
  'cb-safe':         { template: 'brief',     colorway: 'indigo' },
  'brief-emerald':   { template: 'brief',     colorway: 'emerald' },
  'neutral-slate':   { template: 'brief',     colorway: 'slate' },
  'high-contrast':   { template: 'brief',     colorway: 'slate' },
  'ops-indigo':      { template: 'ops',       colorway: 'indigo' },
  'graphite':        { template: 'ops',       colorway: 'graphite' },
  'ocean':           { template: 'editorial', colorway: 'ocean' },
  'editorial-slate': { template: 'editorial', colorway: 'slate' },
  'editorial-night': { template: 'editorial', colorway: 'midnight' },
  'mono-warm':       { template: 'editorial', colorway: 'amber' },
  'mono-night':      { template: 'editorial', colorway: 'graphite' },
  'stage-indigo':    { template: 'stage',     colorway: 'indigo' },
  'stage-night':     { template: 'stage',     colorway: 'midnight' },
  'warm-sunset':     { template: 'stage',     colorway: 'amber' },
};

/**
 * Expand a stored theme's IDENTITY into the tokens it stands for.
 *
 * A theme may be saved as nothing more than `{ templateId, colorwayId }` — that
 * is what the theme menu writes, and what an HTML import derives when the
 * source carries no AppBI metadata. Nothing downstream understood those two
 * fields, so such a theme resolved to the classic defaults: a dashboard stored
 * with `templateId: 'ops'` rendered a top filter bar, executive chrome and a
 * 14px scale, i.e. not Ops at all.
 *
 * Precedence, weakest first: colorway → template → whatever the theme states
 * explicitly. An identity is a STARTING POINT; a value the author (or the
 * import) set by hand always wins, which is what keeps "fine-tuned Ops" from
 * being silently reset back to stock Ops on every render.
 */
export function expandThemeIdentity(
  theme?: DashboardThemeConfig | null,
): DashboardThemeConfig | null | undefined {
  if (!theme || typeof theme !== 'object') return theme;
  const raw = theme as Record<string, any>;

  // A pre-rework dashboard carries only `presetId`; map it to the pair.
  const legacy = LEGACY_PRESET_MAP[String(raw.presetId ?? '')];
  const templateId = String(raw.templateId ?? legacy?.template ?? '');
  const colorwayId = String(raw.colorwayId ?? legacy?.colorway ?? '');
  if (!templateId && !colorwayId) return theme;

  const tpl = TEMPLATES.find((t) => t.id === templateId)?.value;
  const cw = COLORWAYS.find((c) => c.id === colorwayId)?.value;
  if (!tpl && !cw) return theme;

  return { ...(cw ?? {}), ...(tpl ?? {}), ...raw };
}
