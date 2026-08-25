/**
 * The presentation contract.
 *
 * A dashboard is two things wearing one shape. Underneath is content a person
 * built and trusts — which chart, over which dataset, aggregated how, filtered
 * by what. On top is presentation — where each visual sits, how big it is, what
 * it is wearing. Everything in this folder exists to let the second be rewritten
 * (by a template, or by a model reading a sentence) while the first is provably
 * untouched.
 *
 * The types here are deliberately NOT the dashboard's storage shape. A plan
 * speaks in roles and spans ("this is the headline, make it large"); the grid
 * coordinates are derived from it by `compiler.ts`. That separation is the whole
 * point: a language model is good at deciding what matters and bad at packing
 * rectangles without overlapping, so it is only ever asked the first question.
 */
import type { DashboardChartLayout, DashboardThemeConfig } from '@/types/api';

/** A `DashboardChart.id` — the tile, not the chart it points at. */
export type VisualId = number;

/** What a visual is FOR in the composition. Presentation only: a role is never
 *  written back into the chart's own config, because "this is the headline" is
 *  a fact about this page, not about the metric. */
export type PresentationRole =
  | 'headline'    // the one number the page is about
  | 'kpi'         // a number in the strip
  | 'primary'     // the visual carrying the argument
  | 'secondary'   // supports the primary
  | 'breakdown'   // composition — donut, pie, share-of
  | 'table'       // the detail people ask for
  | 'supporting'; // everything else

export const PRESENTATION_ROLES: PresentationRole[] = [
  'headline', 'kpi', 'primary', 'secondary', 'breakdown', 'table', 'supporting',
];

export type PresentationSpan = 'small' | 'medium' | 'large' | 'full';
export const PRESENTATION_SPANS: PresentationSpan[] = ['small', 'medium', 'large', 'full'];

export type PresentationEmphasis = 'low' | 'normal' | 'high';
export const PRESENTATION_EMPHASES: PresentationEmphasis[] = ['low', 'normal', 'high'];

/** The layout primitives (§9). A composition is a sequence of these, and every
 *  one resolves to column spans that sum to the grid width — which is why a
 *  compiled plan cannot produce a row that overflows. */
export type LayoutPrimitive =
  | 'kpi_strip'
  | 'hero_metric'
  | 'full_width'
  | 'two_equal'
  | 'two_one'
  | 'one_two'
  | 'three_equal'
  | 'bento_primary'
  | 'bento_secondary'
  | 'table_full'
  | 'analysis_with_sidebar'
  | 'section_break';

export const LAYOUT_PRIMITIVES: LayoutPrimitive[] = [
  'kpi_strip', 'hero_metric', 'full_width', 'two_equal', 'two_one', 'one_two',
  'three_equal', 'bento_primary', 'bento_secondary', 'table_full',
  'analysis_with_sidebar', 'section_break',
];

export type CompositionStyle =
  | 'executive' | 'saas' | 'editorial' | 'operations'
  | 'finance' | 'minimal' | 'presentation';

export const COMPOSITION_STYLES: CompositionStyle[] = [
  'executive', 'saas', 'editorial', 'operations', 'finance', 'minimal', 'presentation',
];

export type PresentationDensity = 'compact' | 'balanced' | 'spacious';
export const PRESENTATION_DENSITIES: PresentationDensity[] = ['compact', 'balanced', 'spacious'];

export type PresentationScope = 'page' | 'report';

/** One band of the page. `visuals` is an ordered list of visual ids; the
 *  primitive decides how they share the row. */
export interface PresentationSection {
  primitive: LayoutPrimitive;
  visuals: VisualId[];
  /** Only for `section_break` — the heading a decorative widget will carry. */
  title?: string;
}

export interface VisualPreference {
  role: PresentationRole;
  span: PresentationSpan;
  emphasis: PresentationEmphasis;
}

/** Slicer PRESENTATION. Nothing here can change what a slicer filters — the
 *  field, operator, value and scope are not expressible in this shape at all,
 *  which is a stronger guarantee than validating them afterwards. */
export interface SlicerPresentationIntent {
  dock?: 'top' | 'bottom' | 'left' | 'right' | 'drawer';
  variant?: 'auto' | 'segmented' | 'dropdown' | 'compact';
  style?: 'card' | 'pill' | 'compact' | 'glass' | 'minimal';
  density?: PresentationDensity;
}

/** Theme INTENT, not tokens (§32). The user says "clean executive report"; the
 *  resolver decides that means radius 8 and no accent bar. A plan carrying raw
 *  tokens would put the design system in the model's hands. */
export interface ThemeIntent {
  /** One of the catalog template ids — the composition's clothing. */
  template?: string;
  /** One of the catalog colorway ids. */
  colorway?: string;
  mode?: 'light' | 'dark';
  density?: PresentationDensity;
  cardTreatment?: 'clean' | 'soft' | 'tinted' | 'elevated' | 'glass' | 'outline' | 'frameless';
}

export type DecorativeWidgetType = 'section_header' | 'callout' | 'hero_strip';
export const DECORATIVE_WIDGET_TYPES: DecorativeWidgetType[] = [
  'section_header', 'callout', 'hero_strip',
];

export interface DecorativeElement {
  widgetType: DecorativeWidgetType;
  /** Structural copy only. A callout may not assert something about the data —
   *  see `validator.ts`. */
  text?: string;
  /** Index into `sections`; the element is placed immediately before it. */
  beforeSection?: number;
}

/** Per-tile presentation, restricted to the allow-list in `capabilities.ts`.
 *  Typed as a bag because the allow-list is the authority — a key not in it is
 *  rejected regardless of what this type permits. */
export type TileStyleIntent = Record<string, unknown>;

/**
 * What the planner returns. Everything a model is allowed to decide, and
 * nothing else — there is no field here for a coordinate, a CSS rule, a chart
 * type, a dataset or a filter, so none of those can be smuggled in.
 */
export interface PresentationPlan {
  scope: PresentationScope;
  direction: {
    style: CompositionStyle;
    density: PresentationDensity;
  };
  sections: PresentationSection[];
  visualPreferences: Record<string, VisualPreference>;
  slicerPresentation?: SlicerPresentationIntent;
  themeIntent?: ThemeIntent;
  decorativeElements?: DecorativeElement[];
  tileStyles?: Record<string, TileStyleIntent>;
  /** The model's own one-line account of what it did, shown in the diff. */
  rationale?: string;
}

// ── Snapshot: what the planner is allowed to SEE ────────────────────────────

/** A visual described without a single field that could identify a data
 *  source. No SQL, no dataset id, no column names, no rows. */
export interface SnapshotVisual {
  dashboardChartId: VisualId;
  chartType: string;
  title: string;
  currentLayout: { x: number; y: number; w: number; h: number };
  displayRoleHint: PresentationRole;
  isWidget: boolean;
  widgetType: string;
  /** Which allow-listed style keys this visual's renderer actually honours. */
  styleCapabilities: string[];
}

export interface SnapshotSlicer {
  id: string;
  displayLabel: string;
  presentationType: string;
  currentPosition: string;
}

export interface DashboardPresentationSnapshot {
  dashboard: { name: string; currentPageId: string; pageCount: number };
  currentPage: { id: string; name: string };
  visuals: SnapshotVisual[];
  slicers: SnapshotSlicer[];
  theme: {
    template?: string;
    colorway?: string;
    mode?: string;
    density?: string;
    cardTreatment?: string;
  };
  capabilities: unknown;
}

// ── The mutation the compiler produces ──────────────────────────────────────

/** The compiler's output: a patch against presentation state, expressed in the
 *  same fields manual editing already writes. There is no new store here — that
 *  is the point (§7). */
export interface PresentationMutation {
  /** Per-tile layout overrides, keyed by DashboardChart id. Merges into
   *  `localLayoutOverrides` exactly as a drag would. */
  layoutOverrides: Record<VisualId, Partial<DashboardChartLayout>>;
  /** Theme keys to merge into `theme_config`. Empty when scope is 'page'. */
  themePatch: Partial<DashboardThemeConfig>;
  /** `slicer_cluster_layout` keys to merge. */
  slicerClusterPatch: Record<string, unknown>;
  /** Decorative widgets to create, each already stamped `createdBy`. */
  createdWidgets: Array<{
    widgetType: DecorativeWidgetType;
    widgetConfig: Record<string, unknown>;
    layout: Partial<DashboardChartLayout>;
  }>;
  /** Non-fatal notes: things the plan asked for that were approximated. */
  notes: string[];
}

/** A tile as the validator sees it — enough to prove identity and semantics
 *  survived, and nothing more. */
export interface PresentationFingerprintEntry {
  dashboardChartId: VisualId;
  chartId: number | null;
  chartType: string;
  widgetType: string;
  pageId: string | null;
  /** Stable hash of everything about this tile that is NOT presentation. */
  semanticHash: string;
}

export type PresentationFingerprint = Record<string, PresentationFingerprintEntry>;
