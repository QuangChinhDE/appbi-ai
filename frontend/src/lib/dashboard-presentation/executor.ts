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
import { isAllowedChartStyleKey, isAllowedThemeKey } from './capabilities';
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
  const known = new Set(tiles.map((t) => t.id));
  for (const [rawId, intent] of Object.entries(plan.tileStyles ?? {})) {
    const id = Number(rawId);
    if (!known.has(id)) continue;
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(intent ?? {})) {
      if (isAllowedChartStyleKey(key)) safe[key] = value;
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

  const planValidation = validatePresentationPlan(plan, tiles.map((t) => t.id));
  const emptyMutation: PresentationMutation = {
    layoutOverrides: {}, themePatch: {}, slicerClusterPatch: {}, createdWidgets: [], notes: [],
  };
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
  for (const [rawId, style] of Object.entries(tileStyles)) {
    const id = Number(rawId);
    const layout = mutation.layoutOverrides[id] ?? {};
    const previous = ((existingById.get(id)?.layout as any)?.styleConfigOverride ?? {}) as Record<string, unknown>;
    // Merge over what the tile already carries: a redesign that set
    // `legendPosition` must not wipe a Top-N the author configured by hand.
    mutation.layoutOverrides[id] = {
      ...layout,
      styleConfigOverride: { ...previous, ...style },
    } as Partial<DashboardChartLayout>;
  }

  const slicer = resolveSlicerPatch(plan.slicerPresentation);
  mutation.slicerClusterPatch = slicer.cluster;

  if (plan.scope === 'report') {
    mutation.themePatch = {
      ...resolveThemePatch(plan.themeIntent, currentTheme),
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
