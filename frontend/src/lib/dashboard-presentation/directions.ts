/**
 * Design directions — different READING EXPERIENCES of the same report.
 *
 * A direction is not a palette. Each one answers a different question a reader
 * brings to the page, and that answer decides the hierarchy, the blocks, the
 * density, the frames and where the filters go:
 *
 *  - executive  "Are we on track, and why?"   A verdict first (headline from the
 *               lead finding), flush headline numbers, the argument chart as a
 *               hero with a "what moved" summary beside it, detail last. Light,
 *               spacious, calm.
 *  - operations "What needs attention right now?"  Status first: the latest
 *               period of every series as takeaway cards, then the exception
 *               tables high on the page, then a dense three-across wall. Dark,
 *               compact, contained cards, filters docked in a rail.
 *  - editorial  "Walk me through what happened."  A headline, then one chapter
 *               per chart: a heading and the finding sentences, then the chart
 *               full width and frameless. Serif, spacious, filters in a drawer.
 *
 * Directions are GRAMMARS, not layouts: they read the page's own visuals — their
 * roles, meanings and the findings each can support — so the same direction on a
 * different report produces a different, fitting composition, and a report
 * without a time series simply gets no time-based headline. The output is an
 * ordinary PresentationPlan: the same validator, compiler and apply path as a
 * chat redesign or a template (one engine, not two).
 *
 * Existing narrative blocks the AI made earlier are REUSED in their slot rather
 * than duplicated; an author's own blocks are placed, never replaced.
 */
import type {
  BlockVariant,
  CompositionStyle,
  DashboardPresentationSnapshot,
  PlanBlock,
  PresentationPlan,
  PresentationSection,
  SnapshotVisual,
  VisualId,
} from './types';

export type DirectionId = 'executive' | 'operations' | 'editorial';
export const DIRECTION_IDS: DirectionId[] = ['executive', 'operations', 'editorial'];

/** Words a direction puts on the page (headings it owns), in the user's language. */
export interface DirectionLabels {
  whatMoved: string;
  latestStatus: string;
  detail: string;
}

const DEFAULT_LABELS: DirectionLabels = { whatMoved: 'What moved', latestStatus: 'Latest period', detail: 'Detail' };

interface Pools {
  kpis: SnapshotVisual[];
  temporal: SnapshotVisual[];
  breakdowns: SnapshotVisual[];
  tables: SnapshotVisual[];
  others: SnapshotVisual[];
  headers: SnapshotVisual[];
  blocks: SnapshotVisual[];
}

function readingOrder(a: SnapshotVisual, b: SnapshotVisual) {
  return a.readingOrder - b.readingOrder;
}

function poolsOf(visuals: SnapshotVisual[]): Pools {
  const p: Pools = { kpis: [], temporal: [], breakdowns: [], tables: [], others: [], headers: [], blocks: [] };
  for (const v of [...visuals].sort(readingOrder)) {
    if (v.widgetType === 'narrative') { p.blocks.push(v); continue; }
    if (v.isWidget) { p.headers.push(v); continue; }
    const kinds = new Set(v.findingKinds ?? []);
    if (v.displayRoleHint === 'kpi' || v.displayRoleHint === 'headline') p.kpis.push(v);
    else if (v.displayRoleHint === 'table') p.tables.push(v);
    else if (kinds.has('trend') || v.meaning.temporal) p.temporal.push(v);
    else if (kinds.has('top_item')) p.breakdowns.push(v);
    else p.others.push(v);
  }
  // The lead series: an additive measure over time says "how much" — the thing
  // an executive verdict is about. Prefer it over an average-over-time.
  p.temporal.sort((a, b) => {
    const ak = (a.findingKinds ?? []).includes('period_comparison') ? 0 : 1;
    const bk = (b.findingKinds ?? []).includes('period_comparison') ? 0 : 1;
    return ak - bk || readingOrder(a, b);
  });
  return p;
}

const key = (kind: string, v: SnapshotVisual | undefined) =>
  v && (v.findingKinds ?? []).includes(kind) ? `${kind}:${v.dashboardChartId}` : null;

const keys = (...ks: (string | null)[]) => ks.filter((k): k is string => !!k);

class PlanBuilder {
  sections: PresentationSection[] = [];
  blocks: PlanBlock[] = [];
  prefs: PresentationPlan['visualPreferences'] = {};
  tileStyles: NonNullable<PresentationPlan['tileStyles']> = {};
  private reusable: SnapshotVisual[];
  private used = new Set<VisualId>();

  constructor(existingBlocks: SnapshotVisual[]) {
    this.reusable = existingBlocks;
  }

  /** A block slot: an existing AI block of this variant if there is one, else a new block. */
  block(variant: BlockVariant, findings: string[], extra: { title?: string; eyebrow?: string; frameless?: boolean } = {}): VisualId | null {
    const reuse = this.reusable.find((b) => !this.used.has(b.dashboardChartId) && b.block?.origin === 'ai' && b.block.variant === variant
      && JSON.stringify(b.block.findings) === JSON.stringify(findings));
    if (reuse) { this.used.add(reuse.dashboardChartId); return reuse.dashboardChartId; }
    if (findings.length === 0 && !extra.title) return null;
    const id = -(this.blocks.length + 1);
    this.blocks.push({ id, variant, findings, ...extra });
    return id;
  }

  push(primitive: PresentationSection['primitive'], ids: (VisualId | null | undefined)[]) {
    const list = ids.filter((x): x is VisualId => x !== null && x !== undefined);
    if (list.length) this.sections.push({ primitive, visuals: list });
  }

  pairs(list: SnapshotVisual[], primitive: PresentationSection['primitive'] = 'two_equal') {
    for (let i = 0; i < list.length; i += 2) {
      const slice = list.slice(i, i + 2);
      this.push(slice.length === 2 ? primitive : 'full_width', slice.map((v) => v.dashboardChartId));
    }
  }

  prefer(v: SnapshotVisual, role: PresentationPlan['visualPreferences'][string]['role'], emphasis: 'low' | 'normal' | 'high') {
    this.prefs[String(v.dashboardChartId)] = { role, emphasis };
  }

  style(v: SnapshotVisual, style: Record<string, unknown>) {
    this.tileStyles[String(v.dashboardChartId)] = { ...(this.tileStyles[String(v.dashboardChartId)] ?? {}), ...style } as any;
  }

  /** Author blocks and existing AI blocks not reused keep a place (never dropped). */
  leftovers(p: Pools) {
    const rest = p.blocks.filter((b) => !this.used.has(b.dashboardChartId));
    for (const b of rest) this.push('full_width', [b.dashboardChartId]);
  }
}

function executive(s: DashboardPresentationSnapshot, labels: DirectionLabels): PresentationPlan {
  const p = poolsOf(s.visuals);
  const b = new PlanBuilder(p.blocks);
  const lead = p.temporal[0];
  const firstBreakdown = p.breakdowns[0];

  // Verdict: the comparable-period change of the lead series, else its trend.
  const verdict = keys(key('period_comparison', lead) ?? key('trend', lead), key('peak', lead));
  b.push('full_width', [...p.headers.filter((h) => h.widgetType === 'hero_strip').map((h) => h.dashboardChartId),
    b.block('headline', verdict, { eyebrow: s.dashboard.name || undefined })]);
  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'flush', kpiValueFontSize: 34 });

  const moved = keys(
    key('trend', lead),
    key('latest', lead),
    key('top_item', firstBreakdown),
    key('concentration', firstBreakdown),
    ...p.temporal.slice(1, 3).map((v) => key('trend', v)),
  ).slice(0, 4);
  if (lead) {
    b.prefer(lead, 'primary', 'high');
    b.style(lead, { tileFrame: 'subtle', showGrid: false, lineWidth: 3 });
    const summary = b.block('summary', moved, { title: labels.whatMoved, frameless: true });
    b.push(summary !== null ? 'analysis_with_sidebar' : 'full_width', [lead.dashboardChartId, summary]);
  }
  // Supporting evidence in pairs, compositions before other series.
  const support = [...p.breakdowns, ...p.temporal.slice(1), ...p.others];
  for (const v of support) b.style(v, { tileFrame: 'subtle' });
  b.pairs(support);
  for (const t of p.tables) { b.prefer(t, 'table', 'low'); b.push('table_full', [t.dashboardChartId]); }
  b.pairs(p.headers.filter((h) => h.widgetType !== 'hero_strip'));
  b.leftovers(p);

  return {
    layer: 'redesign',
    direction: { style: 'executive' as CompositionStyle, density: 'spacious' },
    sections: b.sections,
    blocks: b.blocks,
    visualPreferences: b.prefs,
    tileStyles: b.tileStyles,
    themeIntent: { template: 'brief', colorway: 'slate', mode: 'light', density: 'spacious', fontFamily: 'dm-sans', cardTreatment: 'clean' } as any,
    slicerPresentation: { dock: 'top', variant: 'dropdown', style: 'pill', density: 'balanced' },
    rationale: 'Executive brief: the verdict first, headline numbers, the lead series with what moved beside it, detail last.',
  };
}

function operations(s: DashboardPresentationSnapshot, labels: DirectionLabels): PresentationPlan {
  const p = poolsOf(s.visuals);
  const b = new PlanBuilder(p.blocks);

  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'card', kpiValueFontSize: 26 });

  // Status band: the latest complete period of each series, one card each.
  const status = p.temporal.slice(0, 3)
    .map((v) => b.block('takeaway', keys(key('latest', v)), { eyebrow: labels.latestStatus, title: v.title || undefined }))
    .filter((id): id is VisualId => id !== null);
  if (status.length) b.push(status.length === 3 ? 'three_equal' : status.length === 2 ? 'two_equal' : 'full_width', status);

  // Exceptions and detail high on the page — an operator reads the list.
  for (const t of p.tables) { b.prefer(t, 'table', 'high'); b.push('table_full', [t.dashboardChartId]); }

  // Everything else dense, three across, series first.
  const wall = [...p.temporal, ...p.breakdowns, ...p.others];
  for (const v of wall) b.style(v, { tileFrame: 'card', showGrid: true, showDataLabels: false });
  for (let i = 0; i < wall.length; i += 3) {
    const slice = wall.slice(i, i + 3);
    b.push(slice.length === 3 ? 'three_equal' : slice.length === 2 ? 'two_equal' : 'full_width', slice.map((v) => v.dashboardChartId));
  }
  b.pairs(p.headers);
  b.leftovers(p);

  return {
    layer: 'redesign',
    direction: { style: 'operations', density: 'compact' },
    sections: b.sections,
    blocks: b.blocks,
    visualPreferences: b.prefs,
    tileStyles: b.tileStyles,
    themeIntent: { template: 'ops', colorway: 'graphite', mode: 'dark', density: 'compact', fontFamily: 'inter', cardTreatment: 'outline' } as any,
    slicerPresentation: { dock: 'left', variant: 'compact', style: 'compact', density: 'compact' },
    rationale: 'Operations board: the latest period of every series as status cards, exceptions next, then a dense wall.',
  };
}

function editorial(s: DashboardPresentationSnapshot): PresentationPlan {
  const p = poolsOf(s.visuals);
  const b = new PlanBuilder(p.blocks);
  const lead = p.temporal[0];

  b.push('full_width', [b.block('headline', keys(key('trend', lead) ?? key('period_comparison', lead), key('peak', lead)),
    { eyebrow: s.dashboard.name || undefined, frameless: true })]);
  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'flush' });

  // One chapter per chart: a heading and what the chart shows, then the chart.
  const story = [...p.temporal, ...p.breakdowns, ...p.others];
  for (const v of story) {
    const findings = keys(key('trend', v), key('peak', v), key('partial_periods', v), key('top_item', v), key('concentration', v)).slice(0, 3);
    const chapter = b.block('chapter', findings, { title: v.title || undefined, frameless: true });
    b.style(v, { tileFrame: 'flush', showGrid: false });
    if (v.renderAspect === 'square') {
      // A pie beside its words reads better than a pie alone across the page.
      b.push('two_equal', [chapter, v.dashboardChartId]);
    } else {
      b.push('full_width', [chapter]);
      b.push('full_width', [v.dashboardChartId]);
    }
    b.prefer(v, v === lead ? 'primary' : 'secondary', v === lead ? 'high' : 'normal');
  }
  for (const t of p.tables) { b.prefer(t, 'table', 'low'); b.push('table_full', [t.dashboardChartId]); }
  b.pairs(p.headers);
  b.leftovers(p);

  return {
    layer: 'redesign',
    direction: { style: 'editorial', density: 'spacious' },
    sections: b.sections,
    blocks: b.blocks,
    visualPreferences: b.prefs,
    tileStyles: b.tileStyles,
    themeIntent: { template: 'editorial', colorway: 'indigo', mode: 'light', density: 'spacious', fontFamily: 'serif', cardTreatment: 'frameless' } as any,
    slicerPresentation: { dock: 'drawer', variant: 'dropdown', style: 'minimal', density: 'spacious' },
    rationale: 'Editorial story: a headline, then each chart introduced by what it shows, frameless and full width.',
  };
}

/** The plan for a direction on this page. Deterministic: same page → same plan. */
export function planForDirection(
  direction: DirectionId,
  snapshot: DashboardPresentationSnapshot,
  labels: Partial<DirectionLabels> = {},
): PresentationPlan {
  const l = { ...DEFAULT_LABELS, ...labels };
  if (direction === 'operations') return operations(snapshot, l);
  if (direction === 'editorial') return editorial(snapshot);
  return executive(snapshot, l);
}
