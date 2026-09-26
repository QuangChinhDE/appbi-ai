/**
 * The gate.
 *
 * Nothing reaches a preview, let alone a draft, without passing through here.
 * Two kinds of finding, and the difference matters:
 *
 *   - a GEOMETRY problem (a tile hanging off the right edge, two tiles on top
 *     of each other) is the compiler's business to repair. Rejecting the whole
 *     redesign because one rectangle is 2 columns too wide would be theatre.
 *   - a SEMANTIC problem (a chart missing, a bar that became a line, a tile
 *     that moved to another page, a style key that is really a row limit) is
 *     never repaired. The plan is refused. A redesign that quietly changed what
 *     a number means is worse than no redesign, because the user has no reason
 *     to look for it.
 *
 * Permission findings are semantic too. A style-only change that moved a tile,
 * a change that moved a locked tile, or a selection-scoped change that touched
 * a visual outside the selection is not a layout the compiler got slightly
 * wrong — it is the design copilot taking something the user did not give it.
 */
import { DASHBOARD_GRID_COLS } from '@/lib/dashboard-pages';
import {
  AI_ALLOWED_SLICER_DOCKS,
  AI_ALLOWED_SLICER_STYLES,
  AI_ALLOWED_SLICER_VARIANTS,
  MAX_TILE_H,
  MIN_TILE_H,
  MIN_TILE_W,
  SLICER_SEMANTIC_KEYS,
  colorwayIds,
  isAllowedChartStyleKey,
  isAllowedThemeKey,
  isAllowedFont,
  isValidStyleValue,
  templateIds,
} from './capabilities';
import { clampLayer } from './intent';
import { coercePlanBlocks, resolveSectionRef } from './blocks';
import {
  COMPOSITION_STYLES,
  DESIGN_LAYERS,
  LAYOUT_PRIMITIVES,
  PRESENTATION_DENSITIES,
  PRESENTATION_EMPHASES,
  PRESENTATION_ROLES,
  STRUCTURE_OPS,
  STRUCTURE_SIZES,
} from './types';
import type {
  DesignLayer,
  PresentationFingerprint,
  PresentationMutation,
  PresentationPlan,
  VisualId,
} from './types';

export type ViolationSeverity = 'semantic' | 'capability' | 'geometry';

export interface Violation {
  severity: ViolationSeverity;
  code: string;
  message: string;
  visualId?: VisualId;
}

export interface ValidationResult {
  ok: boolean;
  /** True when every finding is geometry the compiler can repair. */
  repairable: boolean;
  violations: Violation[];
}

const COLS = DASHBOARD_GRID_COLS;

/** Not tokens — the record of which template/colorway a theme IS. The theme
 *  modal writes these too; `executor.resolveThemePatch` emits them so a redesign
 *  can be re-opened with its template selected. Allowed in a theme patch even
 *  though they are outside the token allow-list. */
const THEME_IDENTITY_KEYS: ReadonlySet<string> = new Set(['templateId', 'colorwayId', 'presetId']);

/** Theme keys that move things rather than paint them. A style-only change may
 *  not write them: `filterDock` relocates the filter cluster and reflows the
 *  grid beside it. (`slicerVariant` changes how a slicer draws, not where it
 *  sits, so it stays a style key.) */
export const STRUCTURAL_THEME_KEYS: ReadonlySet<string> = new Set(['filterDock']);

function fail(list: Violation[]): ValidationResult {
  const hasHardFailure = list.some((v) => v.severity !== 'geometry');
  return {
    ok: list.length === 0,
    repairable: list.length > 0 && !hasHardFailure,
    violations: list,
  };
}

// ── The transport boundary ──────────────────────────────────────────────────

/**
 * Composition style → the template that dresses it.
 *
 * The capability schema hands the model two vocabularies that describe the same
 * intuition — `direction.style` ("saas", "executive") and `themeIntent.template`
 * ("console", "brief") — and a model that reads both will sometimes answer the
 * second with a word from the first. That is our ambiguity, not the model's
 * mistake, so it is translated rather than punished.
 */
const STYLE_TO_TEMPLATE: Record<string, string> = {
  saas: 'console',
  executive: 'brief',
  finance: 'brief',
  operations: 'ops',
  editorial: 'editorial',
  presentation: 'stage',
  minimal: 'brief',
};

export interface CoercedPlan {
  plan: PresentationPlan;
  /** Approximations made at the boundary, surfaced in the diff. */
  notes: string[];
}

export interface CoerceOptions {
  /** The permission the user's words granted. The plan is clamped to it. */
  grantedLayer: DesignLayer;
  /** The visuals the user selected. Empty/undefined means the whole page. */
  targets?: VisualId[] | null;
  /** Tiles on this page — what a block's finding reference may point at. */
  knownTileIds?: VisualId[];
}

/**
 * Coerce a model's reply into the plan shape before anything looks at it.
 *
 * This is not leniency about what a plan may contain — the validator that runs
 * next is as strict as ever. It is about the difference between a plan that is
 * WRONG and a plan that is merely typed the way JSON types things (`"visuals":
 * ["1","2"]`).
 *
 * Two things are IMPOSED rather than read: the layer, which can only go down
 * from what the user's words granted, and the targets, which are whatever the
 * user selected. A model that decides for itself to rebuild the page because
 * the prompt mentioned "modern" is exactly the blast radius this prevents.
 *
 * A style value outside its renderer's domain (`palette: "emerald"`) is dropped
 * here with a note, so a restyle can never report a change that does not paint.
 */
export function coerceModelPlan(raw: unknown, options: CoerceOptions): CoercedPlan {
  const source = (raw ?? {}) as Record<string, any>;
  const notes: string[] = [];
  const toId = (value: unknown): number => Number(value);
  const targets = (options.targets ?? []).filter((id) => Number.isFinite(id));
  const targetSet = new Set(targets);

  const requested = DESIGN_LAYERS.includes(source.layer) ? (source.layer as DesignLayer) : undefined;
  const layer = clampLayer(requested ?? options.grantedLayer, options.grantedLayer);
  if (requested && requested !== layer) {
    notes.push(layer === 'style'
      ? 'Kept your layout exactly as it is — ask to rearrange if you want visuals moved.'
      : 'Kept the change to the visuals you named rather than rebuilding the page.');
  }

  // Blocks first, so sections can place them by the id the model used ("b1").
  const coercedBlocks = coercePlanBlocks(
    layer === 'redesign' ? source.blocks : undefined,
    new Set(options.knownTileIds ?? []),
  );
  notes.push(...coercedBlocks.notes);
  if (layer !== 'redesign' && Array.isArray(source.blocks) && source.blocks.length > 0) {
    notes.push("New text blocks come with a redesign; this change kept the page's content as it is.");
  }

  let sections = Array.isArray(source.sections)
    ? source.sections.map((section: any) => ({
        // `section_break` used to exist and placed its visuals full width; its
        // heading was never rendered, so it is read as what it actually did.
        primitive: section?.primitive === 'section_break' ? 'full_width' : section?.primitive,
        visuals: Array.isArray(section?.visuals)
          ? section.visuals.map((ref: unknown) => resolveSectionRef(ref, coercedBlocks.idMap)).filter((id: number | null): id is number => id !== null && Number.isFinite(id))
          : [],
      }))
    : [];

  const visualPreferences: Record<string, any> = {};
  for (const [key, value] of Object.entries(source.visualPreferences ?? {})) {
    const id = toId(key);
    if (!Number.isFinite(id) || !value || typeof value !== 'object') continue;
    const pref: Record<string, any> = {};
    if ((value as any).role != null) pref.role = (value as any).role;
    if ((value as any).emphasis != null) pref.emphasis = (value as any).emphasis;
    visualPreferences[String(id)] = pref;
  }

  let operations: any[] = Array.isArray(source.structure?.operations)
    ? source.structure.operations.map((operation: any) => ({
        op: operation?.op,
        visuals: Array.isArray(operation?.visuals) ? operation.visuals.map(toId).filter(Number.isFinite) : [],
        ...(operation?.size != null ? { size: operation.size } : {}),
      }))
    : [];

  // Layer enforcement at the boundary: what the layer may not use is removed,
  // with one honest note, so the rest of the plan still applies.
  if (layer !== 'redesign' && sections.length > 0) {
    sections = [];
    if (layer === 'structure') notes.push('Rearranged only the visuals the request named; the rest stayed put.');
  }
  if (layer === 'style' && operations.length > 0) {
    operations = [];
  }
  if (targets.length > 0) {
    const before = operations.length;
    operations = operations
      .map((operation) => ({ ...operation, visuals: operation.visuals.filter((id: number) => targetSet.has(id)) }))
      .filter((operation) => operation.visuals.length > 0);
    if (operations.length < before) notes.push('Only the selected visuals were rearranged.');
  }

  const tileStyles: Record<string, any> = {};
  let droppedStyleValues = 0;
  let droppedOutsideSelection = 0;
  for (const [key, value] of Object.entries(source.tileStyles ?? {})) {
    const id = toId(key);
    if (!Number.isFinite(id) || !value || typeof value !== 'object') continue;
    if (targets.length > 0 && !targetSet.has(id)) { droppedOutsideSelection += 1; continue; }
    const clean: Record<string, any> = {};
    for (const [styleKey, styleValue] of Object.entries(value as Record<string, unknown>)) {
      // Unknown KEYS stay, so the validator can refuse them loudly (a key the
      // allow-list does not know may be a semantic key in disguise). Known keys
      // with a value no renderer draws are dropped quietly-with-a-note.
      if (isAllowedChartStyleKey(styleKey) && !isValidStyleValue(styleKey, styleValue)) {
        droppedStyleValues += 1;
        continue;
      }
      clean[styleKey] = styleValue;
    }
    if (Object.keys(clean).length > 0) tileStyles[String(id)] = clean;
  }
  if (droppedStyleValues > 0) {
    notes.push(`${droppedStyleValues} style value(s) AppBI cannot render were left unchanged.`);
  }
  if (droppedOutsideSelection > 0) {
    notes.push('Styling was kept to the selected visuals.');
  }

  // Cosmetic ids are normalised here rather than judged later.
  let themeIntent: Record<string, any> | undefined;
  if (source.themeIntent && typeof source.themeIntent === 'object') {
    const intent: Record<string, any> = { ...source.themeIntent };
    const template = String(intent.template ?? '');
    if (template && !templateIds().includes(template)) {
      const mapped = STYLE_TO_TEMPLATE[template.toLowerCase()];
      if (mapped) {
        notes.push(`Read "${template}" as the ${mapped} template.`);
        intent.template = mapped;
      } else {
        notes.push(`"${template}" is not a template AppBI has; the current one was kept.`);
        delete intent.template;
      }
    }
    const colorway = String(intent.colorway ?? '');
    if (colorway && !colorwayIds().includes(colorway)) {
      notes.push(`"${colorway}" is not a palette AppBI has; the current one was kept.`);
      delete intent.colorway;
    }
    if (intent.mode && intent.mode !== 'light' && intent.mode !== 'dark') delete intent.mode;
    if (intent.density != null && !PRESENTATION_DENSITIES.includes(intent.density)) delete intent.density;
    const treatments = ['clean', 'soft', 'tinted', 'elevated', 'glass', 'outline', 'frameless'];
    if (intent.cardTreatment != null && !treatments.includes(intent.cardTreatment)) delete intent.cardTreatment;
    if (intent.accent != null && !/^#[0-9a-fA-F]{6}$/.test(String(intent.accent))) {
      notes.push(`"${String(intent.accent)}" is not a #RRGGBB colour; the palette accent was kept.`);
      delete intent.accent;
    }
    if (intent.dataColors != null) {
      const hexes = Array.isArray(intent.dataColors)
        ? intent.dataColors.filter((c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
        : [];
      if (hexes.length > 0) intent.dataColors = hexes;
      else delete intent.dataColors;
    }
    if (intent.fontFamily != null && !isAllowedFont(String(intent.fontFamily))) {
      notes.push(`Font "${String(intent.fontFamily)}" isn't one AppBI ships, so the font was left unchanged.`);
      delete intent.fontFamily;
    }
    themeIntent = Object.keys(intent).length > 0 ? intent : undefined;
  }
  // The theme is report-level by storage. A request scoped to selected visuals
  // must not repaint every other visual, so a selection drops it.
  if (themeIntent && targets.length > 0) {
    notes.push('The report theme was left alone because the request was about the selected visuals.');
    themeIntent = undefined;
  }

  let slicerPresentation: Record<string, any> | undefined;
  if (source.slicerPresentation && typeof source.slicerPresentation === 'object') {
    const slicer: Record<string, any> = { ...source.slicerPresentation };
    if (layer === 'style' && slicer.dock != null) delete slicer.dock;
    slicerPresentation = slicer;
    if (targets.length > 0) slicerPresentation = undefined;
    if (slicerPresentation && Object.keys(slicerPresentation).length === 0) slicerPresentation = undefined;
  }

  const suggestions = Array.isArray(source.suggestions)
    ? source.suggestions
        .filter((s: any) => s && typeof s.text === 'string' && s.text.trim())
        .slice(0, 5)
        .map((s: any) => ({
          text: String(s.text).trim().slice(0, 240),
          ...(Number.isFinite(Number(s.visual)) ? { visual: Number(s.visual) } : {}),
        }))
    : [];


  // The retired `decorativeElements` key still creates nothing — say so, and
  // point at what does (a block in a redesign).
  if (Array.isArray(source.decorativeElements) && source.decorativeElements.length > 0) {
    notes.push('Section headers are added as text blocks in a redesign; the requested decorative elements were not created.');
  }

  const plan: PresentationPlan = {
    layer,
    direction: {
      style: source.direction?.style ?? 'saas',
      density: source.direction?.density ?? 'balanced',
    },
    sections,
    visualPreferences: layer === 'redesign' ? visualPreferences : {},
    ...(operations.length ? { structure: { operations } } : {}),
    ...(slicerPresentation ? { slicerPresentation } : {}),
    ...(themeIntent ? { themeIntent: themeIntent as PresentationPlan['themeIntent'] } : {}),
    ...(Object.keys(tileStyles).length ? { tileStyles } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    ...(typeof source.rationale === 'string' ? { rationale: source.rationale } : {}),
    ...(coercedBlocks.blocks.length ? { blocks: coercedBlocks.blocks } : {}),
  };

  return { plan, notes };
}

// ── Plan shape ──────────────────────────────────────────────────────────────

/**
 * Validate a plan against the capability vocabulary BEFORE compiling it. A plan
 * naming a visual that does not exist, or a primitive that was never defined,
 * is a plan built on a hallucinated dashboard.
 */
export function validatePresentationPlan(
  plan: PresentationPlan,
  knownVisualIds: Iterable<VisualId>,
): ValidationResult {
  const violations: Violation[] = [];
  const known = new Set<VisualId>(knownVisualIds);

  if (!plan || typeof plan !== 'object') {
    return fail([{ severity: 'capability', code: 'plan.malformed', message: 'The plan is not an object.' }]);
  }
  if (!DESIGN_LAYERS.includes(plan.layer)) {
    violations.push({ severity: 'capability', code: 'plan.layer', message: `Unknown layer "${String(plan.layer)}".` });
  }
  // `direction` only drives a recomposition. On a style or structure plan it is
  // never read, so a stray value there must not sink a legitimate restyle.
  if (plan.layer === 'redesign') {
    const style = plan.direction?.style;
    if (style && !COMPOSITION_STYLES.includes(style)) {
      violations.push({ severity: 'capability', code: 'plan.style', message: `Unknown composition style "${style}".` });
    }
    const density = plan.direction?.density;
    if (density && !PRESENTATION_DENSITIES.includes(density)) {
      violations.push({ severity: 'capability', code: 'plan.density', message: `Unknown density "${density}".` });
    }
  }

  if (plan.layer !== 'redesign' && (plan.sections ?? []).length > 0) {
    violations.push({
      severity: 'semantic', code: 'layer.sections',
      message: `A ${plan.layer} change may not recompose the page.`,
    });
  }
  if (plan.layer === 'style' && (plan.structure?.operations ?? []).length > 0) {
    violations.push({
      severity: 'semantic', code: 'layer.operations',
      message: 'A style-only change may not rearrange visuals.',
    });
  }

  for (const [index, section] of (plan.sections ?? []).entries()) {
    if (!LAYOUT_PRIMITIVES.includes(section.primitive)) {
      violations.push({
        severity: 'capability', code: 'plan.primitive',
        message: `Section ${index} uses unknown primitive "${String(section.primitive)}".`,
      });
    }
    for (const id of section.visuals ?? []) {
      if (!known.has(id)) {
        violations.push({
          severity: 'semantic', code: 'plan.unknownVisual', visualId: id,
          message: `Section ${index} references visual ${id}, which is not on this page.`,
        });
      }
    }
  }

  for (const [index, operation] of (plan.structure?.operations ?? []).entries()) {
    if (!STRUCTURE_OPS.includes(operation.op)) {
      violations.push({
        severity: 'capability', code: 'plan.structureOp',
        message: `Operation ${index} is not an arrangement AppBI knows ("${String(operation.op)}").`,
      });
    }
    if (operation.op === 'resize' && operation.size != null && !STRUCTURE_SIZES.includes(operation.size)) {
      violations.push({
        severity: 'capability', code: 'plan.structureSize',
        message: `Operation ${index} asks for an unknown size "${String(operation.size)}".`,
      });
    }
    for (const id of operation.visuals ?? []) {
      if (!known.has(id)) {
        violations.push({
          severity: 'semantic', code: 'plan.unknownVisual', visualId: id,
          message: `Operation ${index} references visual ${id}, which is not on this page.`,
        });
      }
    }
  }

  for (const [rawId, pref] of Object.entries(plan.visualPreferences ?? {})) {
    const id = Number(rawId);
    if (!known.has(id)) {
      violations.push({
        severity: 'semantic', code: 'plan.unknownVisual', visualId: id,
        message: `visualPreferences references visual ${rawId}, which is not on this page.`,
      });
      continue;
    }
    if (pref?.role && !PRESENTATION_ROLES.includes(pref.role)) {
      violations.push({ severity: 'capability', code: 'plan.role', visualId: id, message: `Unknown role "${pref.role}".` });
    }
    if (pref?.emphasis && !PRESENTATION_EMPHASES.includes(pref.emphasis)) {
      violations.push({ severity: 'capability', code: 'plan.emphasis', visualId: id, message: `Unknown emphasis "${pref.emphasis}".` });
    }
  }

  const theme = plan.themeIntent;
  if (theme?.template && !templateIds().includes(theme.template)) {
    violations.push({ severity: 'capability', code: 'plan.template', message: `Unknown template "${theme.template}".` });
  }
  if (theme?.colorway && !colorwayIds().includes(theme.colorway)) {
    violations.push({ severity: 'capability', code: 'plan.colorway', message: `Unknown colorway "${theme.colorway}".` });
  }
  if (theme?.mode && theme.mode !== 'light' && theme.mode !== 'dark') {
    violations.push({ severity: 'capability', code: 'plan.mode', message: `Unknown mode "${theme.mode}".` });
  }
  if (theme?.accent != null && !/^#[0-9a-fA-F]{6}$/.test(String(theme.accent))) {
    violations.push({ severity: 'capability', code: 'plan.accent', message: `Accent "${String(theme.accent)}" is not a #RRGGBB hex.` });
  }
  if (theme?.fontFamily != null && !isAllowedFont(String(theme.fontFamily))) {
    violations.push({ severity: 'capability', code: 'plan.font', message: `Font "${String(theme.fontFamily)}" is not a shipped face.` });
  }
  if (theme?.dataColors != null) {
    const bad = !Array.isArray(theme.dataColors)
      || theme.dataColors.some((c: unknown) => typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c));
    if (bad) {
      violations.push({ severity: 'capability', code: 'plan.dataColors', message: 'dataColors must be an array of #RRGGBB hexes.' });
    }
  }

  const slicer = plan.slicerPresentation;
  if (slicer) {
    if (slicer.dock && !(AI_ALLOWED_SLICER_DOCKS as readonly string[]).includes(slicer.dock)) {
      violations.push({ severity: 'capability', code: 'plan.slicerDock', message: `Unknown slicer dock "${slicer.dock}".` });
    }
    if (slicer.dock && plan.layer === 'style') {
      violations.push({ severity: 'semantic', code: 'layer.slicerDock', message: 'A style-only change may not move the filters.' });
    }
    if (slicer.variant && !(AI_ALLOWED_SLICER_VARIANTS as readonly string[]).includes(slicer.variant)) {
      violations.push({ severity: 'capability', code: 'plan.slicerVariant', message: `Unknown slicer variant "${slicer.variant}".` });
    }
    if (slicer.style && !(AI_ALLOWED_SLICER_STYLES as readonly string[]).includes(slicer.style)) {
      violations.push({ severity: 'capability', code: 'plan.slicerStyle', message: `Unknown slicer style "${slicer.style}".` });
    }
    for (const key of Object.keys(slicer as Record<string, unknown>)) {
      if ((SLICER_SEMANTIC_KEYS as readonly string[]).includes(key)) {
        violations.push({
          severity: 'semantic', code: 'plan.slicerSemantic',
          message: `Slicer presentation may not set "${key}" — that changes what the filter filters.`,
        });
      }
    }
  }

  for (const [rawId, styleIntent] of Object.entries(plan.tileStyles ?? {})) {
    const id = Number(rawId);
    if (!known.has(id)) {
      violations.push({
        severity: 'semantic', code: 'plan.unknownVisual', visualId: id,
        message: `tileStyles references visual ${rawId}, which is not on this page.`,
      });
      continue;
    }
    for (const [key, value] of Object.entries(styleIntent ?? {})) {
      if (!isAllowedChartStyleKey(key)) {
        violations.push({
          severity: 'capability', code: 'plan.styleKey', visualId: id,
          message: `"${key}" is not a presentation style key.`,
        });
      } else if (!isValidStyleValue(key, value)) {
        violations.push({
          severity: 'capability', code: 'plan.styleValue', visualId: id,
          message: `"${String(value)}" is not a value AppBI renders for "${key}".`,
        });
      }
    }
  }

  return fail(violations);
}

/**
 * A caption is allowed to say "Revenue" and not allowed to say "Revenue grew
 * 24% this quarter". Kept as the guard for any copy a plan might ever produce
 * (suggestions are display-only, but they are still words about the data).
 */
export function looksLikeAFabricatedFinding(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/\d\s*%/.test(value)) return true;
  if (/\b(grew|fell|rose|dropped|increased|decreased|up|down|beat|missed|outperform\w*|declin\w*|surg\w*)\b/i.test(value)
      && /\d/.test(value)) {
    return true;
  }
  if (/\b(tăng|giảm|vượt|sụt|cao nhất|thấp nhất)\b/i.test(value) && /\d/.test(value)) return true;
  if (/\b(best|worst|highest|lowest|strongest|weakest)\b/i.test(value)) return true;
  return false;
}

// ── The mutation, against the baseline it was built from ────────────────────

export interface Rect4 { x: number; y: number; w: number; h: number }

export interface MutationValidationInput {
  before: PresentationFingerprint;
  after: PresentationFingerprint;
  mutation: PresentationMutation;
  /** The page the change was scoped to. */
  pageId: string;
  /** Every tile on the page as the user saw it before the change. Required for
   *  the permission checks: geometry drift is measured against it. */
  beforeRects?: Record<string, Rect4>;
  /** Tiles the user locked. */
  lockedIds?: Iterable<VisualId>;
  /** The selection. Empty means the whole page. */
  targetIds?: Iterable<VisualId>;
}

function geometryOf(before: Rect4 | undefined, override: Record<string, any> | undefined): Rect4 | undefined {
  if (!before) return undefined;
  return {
    x: override?.x != null ? Number(override.x) : before.x,
    y: override?.y != null ? Number(override.y) : before.y,
    w: override?.w != null ? Number(override.w) : before.w,
    h: override?.h != null ? Number(override.h) : before.h,
  };
}

function sameRect(a: Rect4 | undefined, b: Rect4 | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * The identity, semantics and permission check. `before` and `after` are
 * fingerprints of the SAME tiles taken either side of the transformation, so
 * this answers two questions: is this still the same report, and did the change
 * stay inside what the user allowed?
 */
export function validatePresentationMutation(input: MutationValidationInput): ValidationResult {
  const { before, after, mutation, pageId } = input;
  const violations: Violation[] = [];
  const layer: DesignLayer = mutation.layer ?? 'redesign';
  const locked = new Set<VisualId>(input.lockedIds ?? []);
  const targets = new Set<VisualId>(input.targetIds ?? []);

  const beforeIds = Object.keys(before);
  const afterIds = new Set(Object.keys(after));

  for (const id of beforeIds) {
    if (!afterIds.has(id)) {
      violations.push({
        severity: 'semantic', code: 'identity.missing', visualId: Number(id),
        message: `Visual ${id} disappeared. A redesign may never remove a chart.`,
      });
      continue;
    }
    const a = before[id];
    const b = after[id];
    if (a.chartType !== b.chartType) {
      violations.push({
        severity: 'semantic', code: 'identity.chartType', visualId: Number(id),
        message: `Visual ${id} changed from ${a.chartType} to ${b.chartType}. Chart type is not presentation.`,
      });
    }
    if (a.chartId !== b.chartId) {
      violations.push({
        severity: 'semantic', code: 'identity.chartRef', visualId: Number(id),
        message: `Visual ${id} now points at a different chart.`,
      });
    }
    if (a.widgetType !== b.widgetType) {
      violations.push({
        severity: 'semantic', code: 'identity.widgetType', visualId: Number(id),
        message: `Visual ${id} changed widget type.`,
      });
    }
    if (a.pageId !== b.pageId) {
      violations.push({
        severity: 'semantic', code: 'identity.page', visualId: Number(id),
        message: `Visual ${id} moved from page ${a.pageId} to ${b.pageId}.`,
      });
    }
    if (a.semanticHash !== b.semanticHash) {
      violations.push({
        severity: 'semantic', code: 'identity.semantics', visualId: Number(id),
        message: `Visual ${id} had its data semantics changed (query, filters, limit, sort or benchmark).`,
      });
    }
  }

  for (const id of afterIds) {
    if (!(id in before)) {
      violations.push({
        severity: 'semantic', code: 'identity.added', visualId: Number(id),
        message: `Visual ${id} appeared from nowhere.`,
      });
    }
  }

  // Every layout the mutation writes must stay on the scoped page and inside
  // the grid.
  for (const [rawId, layout] of Object.entries(mutation.layoutOverrides ?? {})) {
    const id = Number(rawId);
    if (layout.pageId != null && String(layout.pageId) !== pageId) {
      violations.push({
        severity: 'semantic', code: 'grid.pageEscape', visualId: id,
        message: `Visual ${id} was assigned to page ${String(layout.pageId)} but the change is scoped to ${pageId}.`,
      });
    }
    // Lock state is the author's, never the copilot's.
    if ('locked' in (layout as Record<string, unknown>)) {
      violations.push({
        severity: 'semantic', code: 'lock.write', visualId: id,
        message: `Visual ${id}'s lock was changed. Only the author locks and unlocks.`,
      });
    }
    const writesGeometry =
      layout.x != null || layout.y != null || layout.w != null || layout.h != null;
    if (writesGeometry) {
      const x = Number(layout.x);
      const y = Number(layout.y);
      const w = Number(layout.w);
      const h = Number(layout.h);
      if (!Number.isFinite(x) || x < 0) {
        violations.push({ severity: 'geometry', code: 'grid.x', visualId: id, message: `Visual ${id} has x=${layout.x}.` });
      }
      if (!Number.isFinite(y) || y < 0) {
        violations.push({ severity: 'geometry', code: 'grid.y', visualId: id, message: `Visual ${id} has y=${layout.y}.` });
      }
      if (!Number.isFinite(w) || w < MIN_TILE_W) {
        violations.push({ severity: 'geometry', code: 'grid.wMin', visualId: id, message: `Visual ${id} is ${layout.w} columns wide (min ${MIN_TILE_W}).` });
      }
      if (Number.isFinite(x) && Number.isFinite(w) && x + w > COLS) {
        violations.push({ severity: 'geometry', code: 'grid.overflow', visualId: id, message: `Visual ${id} ends at column ${x + w} (grid is ${COLS}).` });
      }
      if (!Number.isFinite(h) || h < MIN_TILE_H || h > MAX_TILE_H) {
        violations.push({ severity: 'geometry', code: 'grid.h', visualId: id, message: `Visual ${id} has height ${layout.h}.` });
      }
    }
  }

  // Permission: measured on the rectangle each tile ENDS UP with, against the
  // one it had — so an override that rewrites a coordinate to its own value is
  // not a move, and one that changes it is, whatever the plan claimed.
  if (input.beforeRects) {
    const finalRects: Record<string, Rect4> = {};
    for (const [rawId, rect] of Object.entries(input.beforeRects)) {
      const override = (mutation.layoutOverrides as Record<string, any>)[rawId];
      const next = geometryOf(rect, override)!;
      finalRects[rawId] = next;
      const id = Number(rawId);
      const moved = !sameRect(rect, next);
      if (moved && layer === 'style') {
        violations.push({
          severity: 'semantic', code: 'layer.styleGeometry', visualId: id,
          message: `Visual ${id} was moved or resized by a style-only change.`,
        });
      }
      if (moved && locked.has(id)) {
        violations.push({
          severity: 'semantic', code: 'lock.geometry', visualId: id,
          message: `Visual ${id} is locked and may not be moved or resized.`,
        });
      }
      if (targets.size > 0 && !targets.has(id) && override && Object.keys(override).length > 0) {
        const onlyNoOp = !moved && override.styleConfigOverride === undefined;
        if (!onlyNoOp) {
          violations.push({
            severity: 'semantic', code: 'scope.outside', visualId: id,
            message: `Visual ${id} is outside the selection and was changed.`,
          });
        }
      }
    }
    for (const overlap of findOverlaps(finalRects)) {
      violations.push({
        severity: 'geometry', code: 'grid.overlap', visualId: overlap[0],
        message: `Visuals ${overlap[0]} and ${overlap[1]} overlap.`,
      });
    }
  } else {
    for (const overlap of findOverlaps(mutation.layoutOverrides ?? {})) {
      violations.push({
        severity: 'geometry', code: 'grid.overlap', visualId: overlap[0],
        message: `Visuals ${overlap[0]} and ${overlap[1]} overlap.`,
      });
    }
  }

  for (const [key, value] of Object.entries(mutation.themePatch ?? {})) {
    if (targets.size > 0 && value !== undefined) {
      violations.push({ severity: 'semantic', code: 'scope.theme', message: `"${key}" repaints the whole report, but the change was scoped to a selection.` });
      continue;
    }
    if (layer === 'style' && STRUCTURAL_THEME_KEYS.has(key) && value !== undefined) {
      violations.push({ severity: 'semantic', code: 'layer.themeStructure', message: `"${key}" moves the filters, which a style-only change may not do.` });
      continue;
    }
    if (value === undefined || THEME_IDENTITY_KEYS.has(key) || isAllowedThemeKey(key)) continue;
    violations.push({ severity: 'capability', code: 'theme.key', message: `"${key}" is not a theme key a redesign may set.` });
  }

  for (const [key, value] of Object.entries(mutation.slicerClusterPatch ?? {})) {
    if ((SLICER_SEMANTIC_KEYS as readonly string[]).includes(key)) {
      violations.push({
        severity: 'semantic', code: 'slicer.semantic',
        message: `Slicer patch sets "${key}", which changes what the filter filters.`,
      });
    }
    if (key === 'position' && value !== undefined && layer === 'style') {
      violations.push({ severity: 'semantic', code: 'layer.slicerDock', message: 'A style-only change may not move the filters.' });
    }
  }

  return fail(violations);
}

/** Pairs of overlapping rectangles. */
export function findOverlaps(
  layouts: Record<string | number, { x?: number; y?: number; w?: number; h?: number }>,
): Array<[VisualId, VisualId]> {
  const rects = Object.entries(layouts)
    .filter(([, l]) => l.x != null || l.y != null || l.w != null || l.h != null)
    .map(([id, l]) => ({
      id: Number(id),
      x: Number(l.x) || 0,
      y: Number(l.y) || 0,
      w: Number(l.w) || 0,
      h: Number(l.h) || 0,
    }));
  const hits: Array<[VisualId, VisualId]> = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const separated = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      if (!separated) hits.push([a.id, b.id]);
    }
  }
  return hits;
}
