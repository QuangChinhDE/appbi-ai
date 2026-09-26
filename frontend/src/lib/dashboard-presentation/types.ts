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

export type PresentationEmphasis = 'low' | 'normal' | 'high';
export const PRESENTATION_EMPHASES: PresentationEmphasis[] = ['low', 'normal', 'high'];

/**
 * How much of the page a design action is ALLOWED to rewrite.
 *
 *   style     - appearance only. Not one coordinate moves; enforced by the
 *               validator, not hoped for by compiling and comparing.
 *   structure - targeted arrangement ("KPIs on top", "make this bigger"): the
 *               named visuals move, everything else stays where the author put
 *               it unless it has to step aside.
 *   redesign  - the user handed over the page: recompose it. Locks still hold.
 *
 * The user never picks one. It is inferred from their words (`intent.ts`), and
 * the model can only ever ask for LESS than was granted, never more.
 */
export type DesignLayer = 'style' | 'structure' | 'redesign';
export const DESIGN_LAYERS: DesignLayer[] = ['style', 'structure', 'redesign'];

/** Targeted arrangement, as operations on the CURRENT layout rather than a new
 *  one. Each names the visuals it moves; nothing it does not name is rewritten
 *  except to make room. */
export type StructureOp = 'move_to_top' | 'move_to_bottom' | 'resize' | 'swap' | 'arrange_row';
export const STRUCTURE_OPS: StructureOp[] = ['move_to_top', 'move_to_bottom', 'resize', 'swap', 'arrange_row'];
export type StructureSize = 'larger' | 'smaller' | 'full_width';
export const STRUCTURE_SIZES: StructureSize[] = ['larger', 'smaller', 'full_width'];

export interface StructureOperation {
  op: StructureOp;
  visuals: VisualId[];
  /** Only for `resize`. */
  size?: StructureSize;
}

/** Something the model thinks would help but is not presentation - a chart type
 *  that would read better, a metric worth adding. Shown, never applied. */
export interface DesignSuggestion {
  visual?: VisualId;
  text: string;
}

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
  // A large primary on the left with a VERTICAL rail of 2–3 stacked secondary
  // charts on the right — the shape a modern SaaS analytics report is built on.
  // Unlike every other primitive it is not one row: the hero spans the full
  // height of the rail, so `visuals[0]` is the hero and the rest stack beside
  // it. The compiler special-cases it exactly as it does `kpi_strip` (§9).
  | 'hero_with_rail';

export const LAYOUT_PRIMITIVES: LayoutPrimitive[] = [
  'kpi_strip', 'hero_metric', 'full_width', 'two_equal', 'two_one', 'one_two',
  'three_equal', 'bento_primary', 'bento_secondary', 'table_full',
  'analysis_with_sidebar', 'hero_with_rail',
];

export type CompositionStyle =
  | 'executive' | 'saas' | 'editorial' | 'operations'
  | 'finance' | 'minimal' | 'presentation';

export const COMPOSITION_STYLES: CompositionStyle[] = [
  'executive', 'saas', 'editorial', 'operations', 'finance', 'minimal', 'presentation',
];

export type PresentationDensity = 'compact' | 'balanced' | 'spacious';
export const PRESENTATION_DENSITIES: PresentationDensity[] = ['compact', 'balanced', 'spacious'];

/** One band of the page. `visuals` is an ordered list of visual ids; the
 *  primitive decides how they share the row. */
export interface PresentationSection {
  primitive: LayoutPrimitive;
  visuals: VisualId[];
}

/** `emphasis` is the one sizing lever a plan has over a visual: the compiler
 *  gives a high-emphasis visual more height and a low one less. Widths come
 *  from the primitive (a `span` field used to exist and changed nothing). */
export interface VisualPreference {
  role: PresentationRole;
  emphasis?: PresentationEmphasis;
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
  /** An exact brand accent, `#RRGGBB`. When the user names a specific colour
   *  (e.g. "deep blue #1E3A8A"), the closest named colorway is only an
   *  approximation; this overrides its accent with the exact hue so the report
   *  actually shows the requested colour. The colorway still supplies the rest
   *  (data palette, surface). Validated as a hex; anything else is refused. */
  accent?: string;
  /** The chart series palette as exact `#RRGGBB` hexes — the home for a SECOND
   *  brand colour ("deep blue + electric orange"): `accent` drives KPIs/bars,
   *  `dataColors` colours the chart series. Each entry must be a hex. */
  dataColors?: string[];
  /** A curated report font family id (inter, roboto, dm-sans, jakarta, grotesk,
   *  serif, mono). Not free text — the renderer only ships these faces. */
  fontFamily?: string;
  mode?: 'light' | 'dark';
  density?: PresentationDensity;
  cardTreatment?: 'clean' | 'soft' | 'tinted' | 'elevated' | 'glass' | 'outline' | 'frameless';
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
  /** The layer the plan works at. Clamped to what the user's words granted. */
  layer: DesignLayer;
  direction: {
    style: CompositionStyle;
    density: PresentationDensity;
  };
  /** REDESIGN only - the recomposition. */
  sections: PresentationSection[];
  visualPreferences: Record<string, VisualPreference>;
  /** STRUCTURE only - targeted operations on the current layout. */
  structure?: { operations: StructureOperation[] };
  slicerPresentation?: SlicerPresentationIntent;
  themeIntent?: ThemeIntent;
  tileStyles?: Record<string, TileStyleIntent>;
  /** Non-presentation ideas (a better chart type, ...). Displayed, never applied. */
  suggestions?: DesignSuggestion[];
  /** The model's own one-line account of what it did, shown in the diff. */
  rationale?: string;
  /** Presentation blocks a REDESIGN adds (headline, summary, chapter,
   *  takeaway). Sections place them by their (negative) id like a visual.
   *  They carry finding KEYS, never numbers. */
  blocks?: PlanBlock[];
}

// ── Snapshot: what the planner is allowed to SEE ────────────────────────────

/** A visual described without a single field that could identify a data
 *  source. No SQL, no dataset id, no column names, no rows. */
export type BlockVariant = 'headline' | 'summary' | 'callout' | 'chapter' | 'takeaway';
export const BLOCK_VARIANTS: BlockVariant[] = ['headline', 'summary', 'callout', 'chapter', 'takeaway'];

/** A block in a plan. `id` is negative until the block is created. */
export interface PlanBlock {
  id: VisualId;
  variant: BlockVariant;
  eyebrow?: string;
  title?: string;
  /** Finding keys (`kind:dashboardChartId`) the block states, in order. */
  findings: string[];
  /** Sit on the canvas without a card (editorial prose, a flush summary). */
  frameless?: boolean;
  /** A section heading: its title introduces the tiles below it. It states no
   *  finding, so it is created as a section header, not as a narrative. */
  heading?: boolean;
}

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
  /**
   * The SHAPE this visual renders best in — the model's cue for how to SIZE it,
   * so a gauge is never handed a full-width band. This is deliberately advice,
   * not a constraint the compiler enforces by clamping width: the planner is
   * told what each chart wants and left to compose, which is the whole point of
   * keeping intelligence in the plan and geometry in the compiler.
   *   'square' — gauge, pie, donut, radial: a compact, roughly-square slot
   *   'wide'   — line, area, bar, table, time series: room for an axis
   *   'tall'   — funnel, sankey: vertical space
   *   'flex'   — anything else; no strong preference
   */
  renderAspect: 'square' | 'wide' | 'tall' | 'flex';
  /** 1-based position in the author's reading order (top to bottom, left to right). */
  readingOrder: number;
  /** The author locked this visual's geometry. No layer may move or resize it. */
  locked: boolean;
  /** What the visual SAYS - best available, every field optional. */
  meaning: VisualMeaning;
  /** The allow-listed style keys this tile already carries, so a restyle can
   *  build on the current look instead of guessing it. */
  currentStyle: Record<string, unknown>;
  /** The finding kinds this visual can support, from its shape (a monthly
   *  additive series → trend/peak/latest/period_comparison…). */
  findingKinds?: string[];
  /** For a narrative block already on the page: its role and who made it. */
  block?: { variant: BlockVariant; origin?: 'ai' | 'author'; draftOnly?: boolean; findings: string[] };
}

/**
 * The business meaning of a visual, built from metadata the dashboard already
 * loads - the chart's own role config, the dataset's semantic model and the
 * chart's written description. Labels only: no SQL, no dataset ids, no rows.
 */
export interface VisualMeaning {
  measures: Array<{ label: string; agg?: string; format?: string; description?: string; additive?: boolean }>;
  dimensions: Array<{ label: string; temporal?: boolean }>;
  /** True when the visual is organised over time (a date axis or a time grain). */
  temporal: boolean;
  /** A short statement of what the chart shows, when one exists. */
  description?: string;
  /** The chart's analytical intent, when metadata records one (trend, ranking...). */
  intent?: string;
  /** A benchmark or target is configured - the number is judged against something. */
  hasBenchmark: boolean;
  /** Whether higher is good (`up`) or bad (`down`), when the author said so. */
  goodDirection?: 'up' | 'down';
}

export interface SnapshotSlicer {
  id: string;
  displayLabel: string;
  presentationType: string;
  currentPosition: string;
}

export interface DashboardPresentationSnapshot {
  dashboard: { name: string; currentPageId: string; pageCount: number; description?: string };
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
  /** What the page currently says: findings its tiles support (sentence + key).
   *  Aggregates only; a block references them by key. */
  findings?: { key: string; sentence: string }[];
}

// ── The mutation the compiler produces ──────────────────────────────────────

/** The compiler's output: a patch against presentation state, expressed in the
 *  same fields manual editing already writes. There is no new store here — that
 *  is the point (§7). */
export interface PresentationMutation {
  /** Per-tile layout overrides, keyed by DashboardChart id. Merges into
   *  `localLayoutOverrides` exactly as a drag would. */
  layoutOverrides: Record<VisualId, Partial<DashboardChartLayout>>;
  /** Theme keys to merge into `theme_config` (report-level by storage). */
  themePatch: Partial<DashboardThemeConfig>;
  /** `slicer_cluster_layout` keys to merge. */
  slicerClusterPatch: Record<string, unknown>;
  /** Non-fatal notes: things the plan asked for that were approximated. */
  notes: string[];
  /** The layer this mutation was built at - what the validator holds it to. */
  layer: DesignLayer;
  /** Presentation blocks the plan adds (narrative, section header). Each has a
   *  NEGATIVE temporary id until Apply creates it as a draft-only row; its
   *  geometry is in `layoutOverrides` under that id like any tile. Only a
   *  `redesign` may create blocks. */
  createdBlocks?: CreatedBlock[];
}

/** A block a redesign adds to the canvas. It carries no data of its own: a
 *  narrative references findings by key, a heading carries words. */
export interface CreatedBlock {
  tempId: VisualId;
  widgetType: 'narrative' | 'section_header';
  widgetConfig: Record<string, unknown>;
  layout: Partial<DashboardChartLayout> & { x: number; y: number; w: number; h: number; pageId?: string };
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
