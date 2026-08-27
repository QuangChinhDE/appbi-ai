/**
 * The one door.
 *
 * Both the template button and the chat box come through `buildPresentation
 * Mutation`, and what comes out the other side is a patch expressed in the
 * fields manual editing already writes — layout overrides, a theme merge, a
 * slicer-cluster merge. No `ai_layout`, no `ai_theme`, no second draft. A
 * redesigned dashboard and a hand-dragged one are the same rows in the same
 * columns, which is the only way the renderer, the public view, the embed and
 * the PDF can stay in agreement without anyone maintaining four code paths.
 *
 * Two rules are enforced here rather than left to the caller, because a caller
 * that forgets either one produces a bug nobody sees until a customer does:
 *   - a page-scoped redesign never writes a theme key (§18), since theme_config
 *     is dashboard-global and would silently repaint the other four pages;
 *   - the baseline is whatever the user is looking at right now, unsaved drags
 *     included (§24) — never the server's copy.
 */
import type { Dashboard, DashboardChart, DashboardChartLayout, DashboardThemeConfig } from '@/types/api';
import { COLORWAYS, COLORWAY_KEYS, TEMPLATES, TEMPLATE_KEYS } from '@/lib/dashboard-theme-catalog';
import { compilePresentationPlan } from './compiler';
import { isAllowedChartStyleKey, isAllowedThemeKey, KPI_ONLY_STYLE_KEYS } from './capabilities';
import { buildPresentationFingerprint } from './snapshot';
import { validatePresentationMutation, validatePresentationPlan } from './validator';
import type { ValidationResult } from './validator';
import type {
  DashboardPresentationSnapshot,
  PresentationMutation,
  PresentationPlan,
  VisualId,
} from './types';

/** Keys a template owns that are applied inline and therefore outrank the token
 *  layer. The theme modal clears these when switching template; a redesign must
 *  clear them for the same reason — left behind, the previous look silently
 *  defeats the new one. */
const LEGACY_LOOK_KEYS = [
  'cardShadow', 'titleFontSize', 'kpiFontSize', 'labelFontSize', 'radius', 'cardBorderWidth',
] as const;

/** Per-tile styleConfigOverride colour/surface keys a report-scoped theme change
 *  overrides so the new theme actually shows. Two behaviours:
 *   - REPOINT: a literal colour a KPI/icon carried is re-pointed to the new theme
 *     accent (the number follows the theme, it does not fall back to plain text).
 *   - RESET: a mode/surface/palette choice is cleared so it inherits the theme.
 *  Non-colour styles (lineWidth, showGrid, dataLabels, a Top-N) are never touched. */
const THEME_REPOINT_COLOUR_KEYS = ['kpiAccentColor', 'kpiIconColor'] as const;
const THEME_RESET_COLOUR_KEYS = [
  'kpiBackgroundMode', 'kpiGradientBg', 'kpiAccentBorder', 'chartSurface', 'palette',
] as const;
const THEME_OVERRIDABLE_COLOUR_KEYS = [
  ...THEME_REPOINT_COLOUR_KEYS, ...THEME_RESET_COLOUR_KEYS,
] as const;

export interface BuildMutationInput {
  plan: PresentationPlan;
  snapshot: DashboardPresentationSnapshot;
  /** The tiles as the user currently sees them, unsaved moves included. */
  tiles: DashboardChart[];
  pageId: string;
  /** Current theme, used so a template switch clears what it should. */
  currentTheme: DashboardThemeConfig | null | undefined;
  /** The theme's inter-tile gap. It sets the grid's row pitch, so the compiler
   *  needs it to turn a height in pixels into a number of rows. */
  gridGapPx?: number;
  /** When set, ONE chart is being restyled: skip the layout compile entirely and
   *  emit only that tile's style override, so nothing else moves or changes. */
  focusedChartId?: number | null;
}

export interface BuildMutationResult {
  ok: boolean;
  mutation: PresentationMutation;
  planValidation: ValidationResult;
  mutationValidation: ValidationResult;
  orphanIds: VisualId[];
}

/** Turn a theme intent into the exact keys the catalog would write. The intent
 *  never carries tokens; this is where high-level becomes low-level (§32). */
export function resolveThemePatch(
  intent: PresentationPlan['themeIntent'],
  currentTheme: DashboardThemeConfig | null | undefined,
): Partial<DashboardThemeConfig> {
  if (!intent) return {};
  const patch: Record<string, any> = {};

  if (intent.template) {
    const tpl = TEMPLATES.find((t) => t.id === intent.template);
    if (tpl) {
      for (const key of TEMPLATE_KEYS) patch[key] = undefined;
      for (const key of LEGACY_LOOK_KEYS) patch[key] = undefined;
      Object.assign(patch, tpl.value);
      patch.skin = tpl.value.skin === 'modern' ? 'modern' : 'classic';
      patch.templateId = tpl.id;
      patch.presetId = `${tpl.id}-${(currentTheme as any)?.colorwayId ?? 'indigo'}`;
    }
  }

  if (intent.colorway) {
    const cw = COLORWAYS.find((c) => c.id === intent.colorway);
    if (cw) {
      for (const key of COLORWAY_KEYS) patch[key] = undefined;
      Object.assign(patch, cw.value);
      patch.colorwayId = cw.id;
      patch.presetId = `${patch.templateId ?? (currentTheme as any)?.templateId ?? 'console'}-${cw.id}`;
    }
  }

  // A mode or density asked for on its own, without a colorway/template behind
  // it, still has to land somewhere.
  if (intent.mode) patch.mode = intent.mode;
  if (intent.density) patch.density = intent.density === 'balanced' ? 'normal' : intent.density;
  if (intent.cardTreatment) patch.cardTreatment = intent.cardTreatment;

  // A named colorway is only ever an approximation of a colour the user spelled
  // out. When they gave an exact accent, honour it — applied AFTER the colorway
  // so it overrides that colorway's own accent while the colorway still supplies
  // the data palette and surface. The validator guarantees it is a real hex.
  if (typeof intent.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(intent.accent)) {
    patch.accent = intent.accent;
  }

  // `templateId`, `colorwayId` and `presetId` are identity, not tokens — they
  // are not in the allow-list and must not be stripped by it.
  const identityKeys = new Set(['templateId', 'colorwayId', 'presetId']);
  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (identityKeys.has(key) || isAllowedThemeKey(key) || (LEGACY_LOOK_KEYS as readonly string[]).includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered as Partial<DashboardThemeConfig>;
}

/** Slicer presentation → the fields the renderer actually reads. `slicer_cluster
 *  _layout.position` outranks the theme's `filterDock`, so a dock change has to
 *  write the cluster field or it looks like it did nothing. */
export function resolveSlicerPatch(
  intent: PresentationPlan['slicerPresentation'],
): { cluster: Record<string, unknown>; theme: Record<string, unknown> } {
  if (!intent) return { cluster: {}, theme: {} };
  const cluster: Record<string, unknown> = {};
  const theme: Record<string, unknown> = {};
  if (intent.dock) {
    cluster.position = intent.dock;
    theme.filterDock = intent.dock;
  }
  if (intent.variant) theme.slicerVariant = intent.variant;
  if (intent.style) theme.slicerStyle = intent.style;
  return { cluster, theme };
}

/** Per-tile style, filtered to the allow-list. Filtering here as well as in the
 *  validator is deliberate: the validator rejects a bad plan, and this makes
 *  sure a plan that was already accepted cannot widen through a later edit. */
function resolveTileStyles(
  plan: PresentationPlan,
  tiles: DashboardChart[],
): Record<VisualId, Record<string, unknown>> {
  const out: Record<VisualId, Record<string, unknown>> = {};
  const byId = new Map(tiles.map((t) => [t.id, t]));
  for (const [rawId, intent] of Object.entries(plan.tileStyles ?? {})) {
    const id = Number(rawId);
    const tile = byId.get(id);
    if (!tile) continue;
    // KPI background/accent keys are inert on a chart — a model that reaches for
    // `kpiBackgroundMode` to "darken a line chart" would otherwise produce a
    // no-op reported as a change. Drop them off a KPI; the cross-type way to
    // reskin a chart is `chartSurface`.
    const isKpi = String((tile.chart as any)?.chart_type ?? '').toUpperCase() === 'KPI';
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(intent ?? {})) {
      if (!isAllowedChartStyleKey(key)) continue;
      if (!isKpi && KPI_ONLY_STYLE_KEYS.has(key)) continue;
      safe[key] = value;
    }
    if (Object.keys(safe).length > 0) out[id] = safe;
  }
  return out;
}

/**
 * Plan → validated mutation. The single entry point; nothing else in the app
 * should call the compiler directly.
 */
export function buildPresentationMutation(input: BuildMutationInput): BuildMutationResult {
  const { plan, snapshot, tiles, pageId, currentTheme, gridGapPx } = input;

  const emptyMutation: PresentationMutation = {
    layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
  };

  // ── Focused single-chart restyle ──────────────────────────────────────────
  // The user clicked one tile: change ONLY its appearance. There is no compile
  // (nothing moves), no theme, no slicer — just that tile's styleConfigOverride,
  // merged over what it already carries so a hand-set Top-N survives. The same
  // fingerprint check runs, so the restyle still cannot touch what the chart
  // shows, and every OTHER tile is provably identical.
  //
  // Runs BEFORE the whole-plan gate on purpose: `resolveTileStyles` already
  // drops any key outside the allow-list, and the fingerprint proves no data
  // moved, so a focused restyle is safe by construction. A model that also
  // filled in `direction`/`sections` (which we never apply here) must not sink
  // the one tile the user asked to restyle — so those parts of the plan are not
  // validated in this path. The pass is the focused tileStyle + the fingerprint.
  if (input.focusedChartId != null) {
    const id = input.focusedChartId;
    const target = tiles.find((t) => t.id === id);
    const style = resolveTileStyles(plan, tiles)[id] ?? {};
    if (!target || Object.keys(style).length === 0) {
      // Nothing survived the allow-list (or the tile is gone): a no-op, not a
      // refusal. Returning ok with an empty mutation lets the caller's
      // empty-diff path render it as "already matches / nothing to do".
      return {
        ok: true,
        mutation: emptyMutation,
        planValidation: { ok: true, repairable: false, violations: [] },
        mutationValidation: { ok: true, repairable: false, violations: [] },
        orphanIds: [],
      };
    }
    const previous = ((target.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
    const mutation: PresentationMutation = {
      layoutOverrides: {
        [id]: { styleConfigOverride: { ...previous, ...style } } as Partial<DashboardChartLayout>,
      },
      themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
    };
    const before = buildPresentationFingerprint(tiles);
    const after = buildPresentationFingerprint(applyMutationToTiles(tiles, mutation));
    const mutationValidation = validatePresentationMutation({ before, after, mutation, pageId });
    return {
      ok: mutationValidation.ok,
      mutation,
      planValidation: { ok: true, repairable: false, violations: [] },
      mutationValidation,
      orphanIds: [],
    };
  }

  const planValidation = validatePresentationPlan(plan, tiles.map((t) => t.id));
  if (!planValidation.ok && !planValidation.repairable) {
    return {
      ok: false,
      mutation: emptyMutation,
      planValidation,
      mutationValidation: { ok: false, repairable: false, violations: [] },
      orphanIds: [],
    };
  }

  const { mutation, orphanIds } = compilePresentationPlan({ plan, snapshot, pageId, gridGapPx });

  // Per-tile style rides along on the same layout write, because that is where
  // `styleConfigOverride` already lives — one field, one save, one undo.
  const tileStyles = resolveTileStyles(plan, tiles);
  const existingById = new Map(tiles.map((t) => [t.id, t]));

  // Theme authority: a report-scoped theme change makes the report the source of
  // truth for COLOUR. Per-tile colour exceptions left by an earlier design
  // (kpiAccentColor, chartSurface, palette, …) would otherwise mask the new
  // theme — "change the report to deep blue" would leave the KPIs their old
  // colours. So those keys are reset here; non-colour per-tile styles (lineWidth,
  // showDataLabels, a hand-set Top-N) are kept. A focused restyle after this
  // still layers a per-tile exception on top — render-time specificity is
  // unchanged; this only clears STALE exceptions at the moment the theme is
  // deliberately reset.
  const themeAuthoritative = plan.scope === 'report'
    && !!plan.themeIntent && Object.keys(plan.themeIntent).length > 0;
  // The colour the report is being set to (custom hex, else the colorway's own
  // accent). Per-tile colour keys are re-pointed to it, not blanked — clearing
  // `kpiAccentColor` alone would drop the number back to plain text, not the new
  // theme colour, so the change would still look like it did nothing.
  const resolvedThemePatch = plan.scope === 'report'
    ? resolveThemePatch(plan.themeIntent, currentTheme)
    : {};
  const themeAccent = themeAuthoritative
    ? ((resolvedThemePatch as Record<string, unknown>).accent as string | undefined)
    : undefined;
  const clearColour = (prev: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...prev };
    // Mode/surface/palette keys fall back to the theme.
    for (const key of THEME_RESET_COLOUR_KEYS) delete next[key];
    // A direct colour a KPI/icon carried follows the new theme colour instead of
    // vanishing to plain text — so "make the report deep blue" turns the numbers
    // deep blue, not black.
    if (themeAccent) {
      for (const key of THEME_REPOINT_COLOUR_KEYS) {
        if (key in next) next[key] = themeAccent;
      }
    } else {
      for (const key of THEME_REPOINT_COLOUR_KEYS) delete next[key];
    }
    return next;
  };

  for (const [rawId, style] of Object.entries(tileStyles)) {
    const id = Number(rawId);
    const layout = mutation.layoutOverrides[id] ?? {};
    let previous = ((existingById.get(id)?.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
    if (themeAuthoritative) previous = clearColour(previous);
    // Merge over what the tile already carries: a redesign that set
    // `legendPosition` must not wipe a Top-N the author configured by hand.
    mutation.layoutOverrides[id] = {
      ...layout,
      styleConfigOverride: { ...previous, ...style },
    } as Partial<DashboardChartLayout>;
  }

  // Tiles the plan gave no explicit style still need their stale colour cleared
  // when the theme is now authoritative — including tiles the compiler only
  // MOVED (they have a geometry override but no styleConfigOverride yet).
  // Otherwise a KPI with a leftover accent keeps it and the theme change looks
  // like it did nothing. Geometry already written is preserved.
  if (themeAuthoritative) {
    const styledByPlan = new Set(Object.keys(tileStyles).map(Number));
    for (const tile of tiles) {
      if (styledByPlan.has(tile.id)) continue; // already cleared + merged above
      const prev = ((tile.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
      if (!THEME_OVERRIDABLE_COLOUR_KEYS.some((key) => key in prev)) continue;
      mutation.layoutOverrides[tile.id] = {
        ...(mutation.layoutOverrides[tile.id] ?? {}),
        styleConfigOverride: clearColour(prev),
      } as Partial<DashboardChartLayout>;
    }
  }

  const slicer = resolveSlicerPatch(plan.slicerPresentation);
  mutation.slicerClusterPatch = slicer.cluster;

  if (plan.scope === 'report') {
    mutation.themePatch = {
      ...(resolvedThemePatch as Partial<DashboardThemeConfig>),
      ...(slicer.theme as Partial<DashboardThemeConfig>),
    };
  } else if (plan.themeIntent && Object.keys(plan.themeIntent).length > 0) {
    // Refused rather than silently dropped: the user asked for a look and is
    // entitled to know why the page did not change colour.
    mutation.notes.push(
      'Theme is shared by every page of this report, so it was left alone. Switch the scope to "Entire report" to change it.',
    );
  }

  const before = buildPresentationFingerprint(tiles);
  const after = buildPresentationFingerprint(applyMutationToTiles(tiles, mutation));
  const mutationValidation = validatePresentationMutation({ before, after, mutation, pageId });

  return {
    ok: mutationValidation.ok && (planValidation.ok || planValidation.repairable),
    mutation,
    planValidation,
    mutationValidation,
    orphanIds,
  };
}

/** Apply a mutation to a tile list. Used to fingerprint the result and to drive
 *  the preview; the real write goes through the page's own draft state. */
export function applyMutationToTiles(
  tiles: DashboardChart[],
  mutation: PresentationMutation,
): DashboardChart[] {
  return tiles.map((tile) => {
    const override = mutation.layoutOverrides[tile.id];
    if (!override) return tile;
    return { ...tile, layout: { ...(tile.layout as any), ...override } } as DashboardChart;
  });
}

/**
 * The mutation as a `localLayoutOverrides` patch — the exact shape a drag
 * produces, so Apply is indistinguishable from having moved everything by hand
 * and the existing Save Draft / Publish path needs no changes at all (§25).
 */
export function toLocalLayoutOverrides(
  mutation: PresentationMutation,
  previous: Record<number, Record<string, any>>,
): Record<number, Record<string, any>> {
  const next: Record<number, Record<string, any>> = { ...previous };
  for (const [rawId, layout] of Object.entries(mutation.layoutOverrides)) {
    const id = Number(rawId);
    next[id] = { ...(previous[id] ?? {}), ...layout };
  }
  return next;
}

/** The tiles a page shows, with the user's unsaved moves already merged — the
 *  baseline a redesign must start from (§24). */
export function tilesWithLocalEdits(
  dashboard: Dashboard | null | undefined,
  localOverrides: Record<number, Record<string, any>>,
  pageTiles: DashboardChart[],
): DashboardChart[] {
  void dashboard;
  return pageTiles.map((tile) => {
    const override = localOverrides?.[tile.id];
    return override ? ({ ...tile, layout: { ...(tile.layout as any), ...override } } as DashboardChart) : tile;
  });
}
