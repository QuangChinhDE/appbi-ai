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
import { GRID_VERSION, scaleGridLayoutForRender } from '@/lib/dashboard-pages';
import { compilePresentationPlan } from './compiler';
import { isAllowedChartStyleKey, isAllowedThemeKey, isAllowedFont, isValidStyleValue, KPI_ONLY_STYLE_KEYS } from './capabilities';
import { buildPresentationFingerprint } from './snapshot';
import { applyStructureOperations, avoidFixed } from './structure';
import type { Rect } from './structure';
import { STRUCTURAL_THEME_KEYS, validatePresentationMutation, validatePresentationPlan } from './validator';
import type { ValidationResult } from './validator';
import type {
  DashboardPresentationSnapshot,
  DesignLayer,
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
  /** The visuals the user selected. When non-empty, nothing outside them may
   *  change — not their geometry, not their style, not the report theme. */
  targets?: VisualId[] | null;
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

  // A second brand colour lives in the chart palette: `accent` drives KPIs/bars,
  // `dataColors` the chart series, so "deep blue + electric orange" shows both.
  if (Array.isArray(intent.dataColors)) {
    const hexes = intent.dataColors.filter(
      (colour): colour is string => typeof colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(colour),
    );
    if (hexes.length > 0) patch.dataColors = hexes;
  }

  // A curated report font — the provider ships only these faces, so an unknown
  // name is dropped rather than left to fall back to nothing.
  if (typeof intent.fontFamily === 'string' && isAllowedFont(intent.fontFamily)) {
    patch.fontFamily = intent.fontFamily.toLowerCase();
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
      if (!isValidStyleValue(key, value)) continue;
      if (!isKpi && KPI_ONLY_STYLE_KEYS.has(key)) continue;
      safe[key] = value;
    }
    if (Object.keys(safe).length > 0) out[id] = safe;
  }
  return out;
}

/** Where each tile is drawn right now, in finer-grid coordinates. */
export function rectsOf(tiles: DashboardChart[]): Map<VisualId, Rect> {
  const out = new Map<VisualId, Rect>();
  for (const tile of tiles) {
    const layout = (scaleGridLayoutForRender(tile.layout as any) ?? {}) as Record<string, any>;
    out.set(tile.id, {
      x: Number(layout.x) || 0,
      y: Number(layout.y) || 0,
      w: Number(layout.w) || 0,
      h: Number(layout.h) || 0,
    });
  }
  return out;
}

export function lockedIdsOf(tiles: DashboardChart[]): Set<VisualId> {
  return new Set(tiles.filter((t) => (t.layout as any)?.locked === true).map((t) => t.id));
}

/**
 * Plan → validated mutation. The single entry point; nothing else in the app
 * should call the compiler directly.
 *
 * The layer on the plan decides how much of the page may be rewritten, and it
 * is enforced twice: here, by construction (a style plan has no code path that
 * writes a coordinate), and in the validator, by comparison (every tile's final
 * rectangle against the one it had). Locked tiles and — under a selection —
 * unselected tiles are FIXED: no branch writes them, and a mutation that did
 * would be refused.
 */
export function buildPresentationMutation(input: BuildMutationInput): BuildMutationResult {
  const { plan, snapshot, tiles, pageId, currentTheme, gridGapPx } = input;
  const layer: DesignLayer = plan.layer ?? 'style';
  const targets = (input.targets ?? []).filter((id) => tiles.some((t) => t.id === id));
  const targetSet = new Set(targets);
  const locked = lockedIdsOf(tiles);
  const fixed = new Set<VisualId>(locked);
  if (targets.length > 0) {
    for (const tile of tiles) if (!targetSet.has(tile.id)) fixed.add(tile.id);
  }
  const beforeRects = rectsOf(tiles);

  const emptyMutation: PresentationMutation = {
    layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, notes: [], layer,
  };

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

  // ── Geometry, by layer ───────────────────────────────────────────────────
  const mutation: PresentationMutation = { ...emptyMutation, layoutOverrides: {}, notes: [] };
  let orphanIds: VisualId[] = [];
  const writeRects = (next: Map<VisualId, Rect>) => {
    for (const [id, rect] of next) {
      const prev = beforeRects.get(id);
      if (prev && prev.x === rect.x && prev.y === rect.y && prev.w === rect.w && prev.h === rect.h) continue;
      if (fixed.has(id)) continue; // belt: a fixed tile is never written
      mutation.layoutOverrides[id] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, gv: GRID_VERSION, pageId };
    }
  };

  if (layer === 'structure') {
    const result = applyStructureOperations(beforeRects, plan.structure?.operations ?? [], fixed);
    writeRects(result.rects);
    mutation.notes.push(...result.notes);
  } else if (layer === 'redesign' && (plan.sections ?? []).length === 0) {
    // A redesign with no composition (an echoed prompt, a model that answered
    // with theme only) is NOT an instruction to re-pack the page. Appending
    // every visual two-per-row is what the old compiler did with it, and that
    // rearranged a whole dashboard for "make it prettier".
    if ((plan.structure?.operations ?? []).length > 0) {
      const result = applyStructureOperations(beforeRects, plan.structure!.operations, fixed);
      writeRects(result.rects);
      mutation.notes.push(...result.notes);
    }
  } else if (layer === 'redesign') {
    const compiled = compilePresentationPlan({ plan, snapshot, pageId, gridGapPx, fixed });
    orphanIds = compiled.orphanIds;
    mutation.notes.push(...compiled.mutation.notes);
    const next = new Map(beforeRects);
    for (const [rawId, layout] of Object.entries(compiled.mutation.layoutOverrides)) {
      const id = Number(rawId);
      next.set(id, { x: Number(layout.x), y: Number(layout.y), w: Number(layout.w), h: Number(layout.h) });
    }
    if (fixed.size > 0) {
      const routed = avoidFixed(next, fixed);
      writeRects(routed);
      if (locked.size > 0) mutation.notes.push(`${locked.size} locked visual(s) kept their place.`);
    } else {
      writeRects(next);
    }
  }
  // layer === 'style': no branch writes a coordinate.

  // ── Per-tile style ───────────────────────────────────────────────────────
  // Rides on the same layout write, because that is where `styleConfigOverride`
  // already lives — one field, one save, one undo.
  const tileStyles = resolveTileStyles(plan, tiles);
  const existingById = new Map(tiles.map((t) => [t.id, t]));

  // Theme authority: a report theme change makes the report the source of truth
  // for COLOUR, so stale per-tile colour exceptions are reset (non-colour
  // styles — lineWidth, a Top-N — are kept). Theme is report-level by storage;
  // a request scoped to selected visuals never carries one (see coerce).
  const themeRequested = !!plan.themeIntent && Object.keys(plan.themeIntent).length > 0 && targets.length === 0;
  const resolvedThemePatch: Record<string, unknown> = themeRequested
    ? { ...(resolveThemePatch(plan.themeIntent, currentTheme) as Record<string, unknown>) }
    : {};
  // A template carries a default filter dock. Choosing a LOOK must not move the
  // filters, so under style the dock stays whatever it is.
  if (layer === 'style') {
    for (const key of STRUCTURAL_THEME_KEYS) delete resolvedThemePatch[key];
  }
  const themeAccent = themeRequested ? (resolvedThemePatch.accent as string | undefined) : undefined;
  const clearColour = (prev: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...prev };
    for (const key of THEME_RESET_COLOUR_KEYS) delete next[key];
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
    if (targets.length > 0 && !targetSet.has(id)) continue;
    const layout = mutation.layoutOverrides[id] ?? {};
    let previous = ((existingById.get(id)?.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
    if (themeRequested) previous = clearColour(previous);
    mutation.layoutOverrides[id] = {
      ...layout,
      styleConfigOverride: { ...previous, ...style },
    } as Partial<DashboardChartLayout>;
  }

  if (themeRequested) {
    const styledByPlan = new Set(Object.keys(tileStyles).map(Number));
    for (const tile of tiles) {
      if (styledByPlan.has(tile.id)) continue;
      const prev = ((tile.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
      if (!THEME_OVERRIDABLE_COLOUR_KEYS.some((key) => key in prev)) continue;
      mutation.layoutOverrides[tile.id] = {
        ...(mutation.layoutOverrides[tile.id] ?? {}),
        styleConfigOverride: clearColour(prev),
      } as Partial<DashboardChartLayout>;
    }
  }

  const slicer = resolveSlicerPatch(targets.length > 0 ? undefined : plan.slicerPresentation);
  mutation.slicerClusterPatch = layer === 'style' ? {} : slicer.cluster;
  const slicerTheme = { ...slicer.theme };
  if (layer === 'style') for (const key of STRUCTURAL_THEME_KEYS) delete slicerTheme[key];

  mutation.themePatch = {
    ...(resolvedThemePatch as Partial<DashboardThemeConfig>),
    ...(slicerTheme as Partial<DashboardThemeConfig>),
  };

  const before = buildPresentationFingerprint(tiles);
  const after = buildPresentationFingerprint(applyMutationToTiles(tiles, mutation));
  const beforeRecord: Record<string, Rect> = {};
  for (const [id, rect] of beforeRects) beforeRecord[String(id)] = rect;
  const mutationValidation = validatePresentationMutation({
    before, after, mutation, pageId,
    beforeRects: beforeRecord,
    lockedIds: locked,
    targetIds: targets,
  });

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

/**
 * Stack a follow-up change on top of a preview that has not been applied.
 *
 * "Now make it darker" is planned against the preview on screen, so its
 * mutation is relative to that preview. Applying it alone would silently drop
 * the first change; applying the two composed is what the user is looking at.
 * Style overrides merge per key, geometry and theme take the later value, and
 * the layer is the wider of the two — the composite is then re-validated
 * against the real baseline, never trusted because its halves passed.
 */
export function composeMutations(first: PresentationMutation, second: PresentationMutation): PresentationMutation {
  const layoutOverrides: PresentationMutation['layoutOverrides'] = { ...first.layoutOverrides };
  for (const [rawId, next] of Object.entries(second.layoutOverrides)) {
    const id = Number(rawId);
    const prev = (layoutOverrides[id] ?? {}) as Record<string, any>;
    const merged: Record<string, any> = { ...prev, ...(next as Record<string, any>) };
    if ((prev as any).styleConfigOverride || (next as any).styleConfigOverride) {
      merged.styleConfigOverride = { ...((prev as any).styleConfigOverride ?? {}), ...((next as any).styleConfigOverride ?? {}) };
    }
    layoutOverrides[id] = merged as Partial<DashboardChartLayout>;
  }
  const rank: Record<DesignLayer, number> = { style: 0, structure: 1, redesign: 2 };
  return {
    layoutOverrides,
    themePatch: { ...first.themePatch, ...second.themePatch },
    slicerClusterPatch: { ...first.slicerClusterPatch, ...second.slicerClusterPatch },
    notes: [...second.notes],
    layer: rank[second.layer] >= rank[first.layer] ? second.layer : first.layer,
  };
}

/** Re-run the identity, semantics and permission gate for a mutation against
 *  the tiles it will actually be applied to. */
export function validateMutationAgainst(input: {
  tiles: DashboardChart[];
  mutation: PresentationMutation;
  pageId: string;
  targets?: VisualId[] | null;
}): ValidationResult {
  const beforeRects: Record<string, Rect> = {};
  for (const [id, rect] of rectsOf(input.tiles)) beforeRects[String(id)] = rect;
  return validatePresentationMutation({
    before: buildPresentationFingerprint(input.tiles),
    after: buildPresentationFingerprint(applyMutationToTiles(input.tiles, input.mutation)),
    mutation: input.mutation,
    pageId: input.pageId,
    beforeRects,
    lockedIds: lockedIdsOf(input.tiles),
    targetIds: input.targets ?? [],
  });
}
