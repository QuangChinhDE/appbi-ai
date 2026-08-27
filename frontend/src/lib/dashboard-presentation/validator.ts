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
  templateIds,
} from './capabilities';
import {
  COMPOSITION_STYLES,
  DECORATIVE_WIDGET_TYPES,
  LAYOUT_PRIMITIVES,
  PRESENTATION_DENSITIES,
  PRESENTATION_EMPHASES,
  PRESENTATION_ROLES,
  PRESENTATION_SPANS,
} from './types';
import type {
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
 * Coerce a model's reply into the plan shape before anything looks at it.
 *
 * This is not leniency about what a plan may contain — the validator that runs
 * next is as strict as ever. It is about the difference between a plan that is
 * WRONG and a plan that is merely typed the way JSON types things. Models
 * routinely return `"visuals": ["1","2"]` because the ids were object keys a
 * moment earlier, and rejecting that as "visual 1 does not exist" would be a
 * confusing lie: the model chose the right visual and wrote it as a string.
 *
 * Scope is not coerced, it is IMPOSED. The user picked "this page" or "the
 * whole report" in the panel, and a model that decides for itself to redesign
 * the whole report because the prompt mentioned colour is exactly the silent
 * blast radius §6 exists to prevent.
 */
/**
 * Composition style → the template that dresses it.
 *
 * The capability schema hands the model two vocabularies that describe the same
 * intuition — `direction.style` ("saas", "executive") and `themeIntent.template`
 * ("console", "brief") — and a model that reads both will sometimes answer the
 * second with a word from the first. It did, immediately, on the real report:
 * `themeIntent: {template: "saas"}` got a good layout refused over a name.
 *
 * That is our ambiguity, not the model's mistake, so it is translated rather
 * than punished. A style has an obvious nearest template; anything genuinely
 * unrecognised is dropped with a note, because a wrong theme id cannot change
 * what a number means and is not worth losing the whole redesign over.
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

export function coerceModelPlan(
  raw: unknown,
  options: { scope: 'page' | 'report' },
): CoercedPlan {
  const source = (raw ?? {}) as Record<string, any>;
  const notes: string[] = [];
  const toId = (value: unknown): number => Number(value);

  const sections = Array.isArray(source.sections)
    ? source.sections.map((section: any) => ({
        primitive: section?.primitive,
        visuals: Array.isArray(section?.visuals) ? section.visuals.map(toId).filter(Number.isFinite) : [],
        ...(typeof section?.title === 'string' && section.title.trim()
          ? { title: section.title.trim() }
          : {}),
      }))
    : [];

  const visualPreferences: Record<string, any> = {};
  for (const [key, value] of Object.entries(source.visualPreferences ?? {})) {
    const id = toId(key);
    if (Number.isFinite(id)) visualPreferences[String(id)] = value;
  }

  const tileStyles: Record<string, any> = {};
  for (const [key, value] of Object.entries(source.tileStyles ?? {})) {
    const id = toId(key);
    if (Number.isFinite(id)) tileStyles[String(id)] = value;
  }

  // Cosmetic ids are normalised here rather than judged later. The validator
  // stays strict about everything that could change meaning; a theme name is
  // not one of those things.
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
    if (intent.mode && intent.mode !== 'light' && intent.mode !== 'dark') {
      delete intent.mode;
    }
    themeIntent = Object.keys(intent).length > 0 ? intent : undefined;
  }

  const plan: PresentationPlan = {
    scope: options.scope,
    direction: {
      style: source.direction?.style ?? 'saas',
      density: source.direction?.density ?? 'balanced',
    },
    sections,
    visualPreferences,
    ...(source.slicerPresentation ? { slicerPresentation: source.slicerPresentation } : {}),
    ...(themeIntent ? { themeIntent: themeIntent as PresentationPlan['themeIntent'] } : {}),
    ...(Array.isArray(source.decorativeElements) ? { decorativeElements: source.decorativeElements } : {}),
    ...(Object.keys(tileStyles).length ? { tileStyles } : {}),
    ...(typeof source.rationale === 'string' ? { rationale: source.rationale } : {}),
  };

  return { plan, notes };
}

// ── Plan shape ──────────────────────────────────────────────────────────────

/**
 * Validate a plan against the capability vocabulary BEFORE compiling it. A plan
 * naming a visual that does not exist, or a primitive that was never defined,
 * is a plan built on a hallucinated dashboard, and compiling it would produce a
 * confident-looking layout for a report nobody has.
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
  if (plan.scope !== 'page' && plan.scope !== 'report') {
    violations.push({ severity: 'capability', code: 'plan.scope', message: `Unknown scope "${String(plan.scope)}".` });
  }
  const style = plan.direction?.style;
  if (style && !COMPOSITION_STYLES.includes(style)) {
    violations.push({ severity: 'capability', code: 'plan.style', message: `Unknown composition style "${style}".` });
  }
  const density = plan.direction?.density;
  if (density && !PRESENTATION_DENSITIES.includes(density)) {
    violations.push({ severity: 'capability', code: 'plan.density', message: `Unknown density "${density}".` });
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
    if (pref?.span && !PRESENTATION_SPANS.includes(pref.span)) {
      violations.push({ severity: 'capability', code: 'plan.span', visualId: id, message: `Unknown span "${pref.span}".` });
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

  const slicer = plan.slicerPresentation;
  if (slicer) {
    if (slicer.dock && !(AI_ALLOWED_SLICER_DOCKS as readonly string[]).includes(slicer.dock)) {
      violations.push({ severity: 'capability', code: 'plan.slicerDock', message: `Unknown slicer dock "${slicer.dock}".` });
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

  for (const element of plan.decorativeElements ?? []) {
    if (!DECORATIVE_WIDGET_TYPES.includes(element.widgetType)) {
      violations.push({
        severity: 'capability', code: 'plan.decorativeType',
        message: `Unknown decorative widget "${String(element.widgetType)}".`,
      });
    }
    if (typeof element.text === 'string' && looksLikeAFabricatedFinding(element.text)) {
      violations.push({
        severity: 'semantic', code: 'plan.fabricatedCopy',
        message: `Decorative text asserts something about the data ("${element.text.slice(0, 60)}"). Structural headings only.`,
      });
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
    for (const key of Object.keys(styleIntent ?? {})) {
      if (!isAllowedChartStyleKey(key)) {
        violations.push({
          severity: 'capability', code: 'plan.styleKey', visualId: id,
          message: `"${key}" is not a presentation style key.`,
        });
      }
    }
  }

  return fail(violations);
}

/**
 * A decorative caption is allowed to say "Revenue" and not allowed to say
 * "Revenue grew 24% this quarter". The check is deliberately crude — a number
 * next to a movement word, or a superlative — because the cost of a false
 * positive is a rejected heading, and the cost of a false negative is a report
 * that states a finding nobody computed.
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

export interface MutationValidationInput {
  before: PresentationFingerprint;
  after: PresentationFingerprint;
  mutation: PresentationMutation;
  /** The page the redesign was scoped to. */
  pageId: string;
  /** Ids of tiles the mutation is allowed to create (decorative widgets). */
  allowCreatedIds?: Iterable<VisualId>;
}

/**
 * The identity and semantics check (§15). `before` and `after` are fingerprints
 * of the SAME tiles taken either side of the transformation, so this answers
 * one question: is this still the same report?
 */
export function validatePresentationMutation(input: MutationValidationInput): ValidationResult {
  const { before, after, mutation, pageId } = input;
  const violations: Violation[] = [];
  const created = new Set<VisualId>(input.allowCreatedIds ?? []);

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
    if (!(id in before) && !created.has(Number(id))) {
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
        message: `Visual ${id} was assigned to page ${String(layout.pageId)} but the redesign is scoped to ${pageId}.`,
      });
    }
    // A style-only override (focused single-chart restyle) carries no x/y/w/h:
    // nothing moved, so there is no geometry to validate. Only check position
    // when the override actually writes one — otherwise `Number(undefined)` is
    // NaN and a pure restyle would be rejected for a geometry it never touched.
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

  for (const overlap of findOverlaps(mutation.layoutOverrides ?? {})) {
    violations.push({
      severity: 'geometry', code: 'grid.overlap', visualId: overlap[0],
      message: `Visuals ${overlap[0]} and ${overlap[1]} overlap.`,
    });
  }

  for (const [key, value] of Object.entries(mutation.themePatch ?? {})) {
    // Three things are legitimately in a theme patch beyond the token allow-list,
    // and forbidding any of them refused every report-scoped template change:
    //   - IDENTITY (templateId, colorwayId, presetId): not tokens but the record
    //     of WHICH template/colorway is applied, exactly what the theme modal
    //     writes. A plan cannot forge a look with them — the tokens still have to
    //     pass — so they are allowed with a real value.
    //   - a CLEAR (value === undefined): removing an override can never inject a
    //     bad value, so switching a template may clear the inline legacy-look
    //     keys (cardShadow, titleFontSize, …) the modal also clears.
    // Everything else with a real value must be an allow-listed token.
    if (value === undefined || THEME_IDENTITY_KEYS.has(key) || isAllowedThemeKey(key)) continue;
    violations.push({ severity: 'capability', code: 'theme.key', message: `"${key}" is not a theme key a redesign may set.` });
  }

  for (const key of Object.keys(mutation.slicerClusterPatch ?? {})) {
    if ((SLICER_SEMANTIC_KEYS as readonly string[]).includes(key)) {
      violations.push({
        severity: 'semantic', code: 'slicer.semantic',
        message: `Slicer patch sets "${key}", which changes what the filter filters.`,
      });
    }
  }

  for (const widget of mutation.createdWidgets ?? []) {
    if (!DECORATIVE_WIDGET_TYPES.includes(widget.widgetType)) {
      violations.push({
        severity: 'capability', code: 'widget.type',
        message: `Cannot create widget of type "${String(widget.widgetType)}".`,
      });
    }
    const config = (widget.widgetConfig ?? {}) as Record<string, unknown>;
    if (config.createdBy !== 'ai-presentation') {
      violations.push({
        severity: 'capability', code: 'widget.provenance',
        message: 'A generated widget must be stamped createdBy: "ai-presentation" so it can be undone.',
      });
    }
    // Arbitrary markup is the one thing that must never reach a tile from a
    // plan. Anything that looks like a tag is refused outright rather than
    // sanitized, because a decorative heading has no legitimate need for one.
    for (const value of Object.values(config)) {
      if (typeof value === 'string' && /<[a-z/!]/i.test(value)) {
        violations.push({
          severity: 'capability', code: 'widget.markup',
          message: 'A generated widget may not contain markup.',
        });
        break;
      }
    }
  }

  return fail(violations);
}

/** Pairs of overlapping rectangles. */
export function findOverlaps(
  layouts: Record<string | number, { x?: number; y?: number; w?: number; h?: number }>,
): Array<[VisualId, VisualId]> {
  const rects = Object.entries(layouts).map(([id, l]) => ({
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
