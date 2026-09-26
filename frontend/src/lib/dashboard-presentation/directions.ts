/**
 * Design directions — different READING EXPERIENCES of the same report.
 *
 * A direction is not a palette. Each one answers a different question a reader
 * brings to the page, and that answer decides the hierarchy, the blocks, the
 * density, the frames and where the filters go:
 *
 *  - executive  "Are we on track, and why?"  What happened (a verdict from the
 *               lead finding) → why it matters (headline numbers, what moved
 *               beside the argument chart) → supporting evidence → detail last.
 *               Light, spacious, calm.
 *  - operations "What needs attention right now?"  Current state (numbers and
 *               the latest period of each series) → what the data flags, said
 *               as what it is (against target, where one exists; observations
 *               such as concentration or incomplete periods, titled neutrally) →
 *               the monitoring series → drill-down (rankings, then tables).
 *               Dark, compact, contained cards, filters docked in a rail. A
 *               target is shown only where one exists; none is invented.
 *  - editorial  "Walk me through what happened."  A thesis, then one chapter per
 *               chart (the chart and the sentences that explain it), then what
 *               to keep in mind — the caveats the evidence carries. Serif,
 *               spacious, filters in a drawer.
 *
 * Every direction says a finding ONCE per page: the builder hands out each
 * finding key to the first block that asks, so a chapter never repeats the
 * headline and "what moved" never repeats the verdict. A block left with
 * nothing new to say is not created.
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
import { CONDITIONAL_FINDING_KINDS } from '@/lib/report-findings';

export type DirectionId = 'executive' | 'operations' | 'editorial';
export const DIRECTION_IDS: DirectionId[] = ['executive', 'operations', 'editorial'];

/** Words a direction puts on the page (headings it owns), in the user's language. */
export interface DirectionLabels {
  whatMoved: string;
  latestStatus: string;
  detail: string;
  /** Neutral observations the data flags (concentration, incomplete periods). */
  worthKnowing: string;
  /** Results against a target — only where the data has one. */
  againstTarget: string;
  keepInMind: string;
}

const DEFAULT_LABELS: DirectionLabels = {
  whatMoved: 'What moved',
  latestStatus: 'Latest period',
  detail: 'Detail',
  worthKnowing: 'Worth knowing',
  againstTarget: 'Against target',
  keepInMind: 'What to keep in mind',
};

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

/** The finding keys the report supports now (empty when not yet known). */
const liveOf = (s: DashboardPresentationSnapshot) => new Set((s.findings ?? []).map((f) => f.key));

/** Keys of one kind across visuals, in order. */
const allOf = (kind: string, vs: SnapshotVisual[]) => keys(...vs.map((v) => key(kind, v)));

class PlanBuilder {
  sections: PresentationSection[] = [];
  blocks: PlanBlock[] = [];
  prefs: PresentationPlan['visualPreferences'] = {};
  tileStyles: NonNullable<PresentationPlan['tileStyles']> = {};
  private reusable: SnapshotVisual[];
  private used = new Set<VisualId>();
  /** Finding keys already said on this page. */
  private said = new Set<string>();
  /** The findings the report supports right now. */
  private live: ReadonlySet<string>;

  constructor(existingBlocks: SnapshotVisual[], live: ReadonlySet<string>) {
    this.reusable = existingBlocks;
    this.live = live;
  }

  /**
   * Findings not yet said on the page, in order, each once. A CONDITIONAL
   * finding (concentration, a target, incomplete periods) is used only when the
   * report supports it now: absent, it is not stated, and a block of nothing
   * but unstated findings is an empty card.
   */
  fresh(findings: string[]): string[] {
    return findings.filter((k, i) => !this.said.has(k) && findings.indexOf(k) === i
      && (!CONDITIONAL_FINDING_KINDS.has(k.split(':')[0]) || this.live.has(k)));
  }

  /**
   * A block slot: an existing AI block of this variant if there is one, else a
   * new block. Findings already said on the page are dropped; a block left with
   * nothing to say is not created — unless it is a section heading, whose job
   * is the title itself.
   */
  block(
    variant: BlockVariant,
    requested: string[],
    extra: { title?: string; eyebrow?: string; frameless?: boolean; heading?: boolean } = {},
  ): VisualId | null {
    const { heading, ...shown } = extra;
    const findings = this.fresh(requested);
    if (findings.length === 0 && !(heading && shown.title)) return null;
    for (const k of findings) this.said.add(k);
    const reuse = this.reusable.find((b) => !this.used.has(b.dashboardChartId) && b.block?.origin === 'ai' && b.block.variant === variant
      && JSON.stringify(b.block.findings) === JSON.stringify(findings));
    if (reuse) { this.used.add(reuse.dashboardChartId); return reuse.dashboardChartId; }
    const id = -(this.blocks.length + 1);
    this.blocks.push({ id, variant, findings, ...shown, ...(heading && findings.length === 0 ? { heading: true } : {}) });
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
  const b = new PlanBuilder(p.blocks, liveOf(s));
  const lead = p.temporal[0];
  const firstBreakdown = p.breakdowns[0];

  // 1 · What happened: the comparable-period change of the lead series, else its trend.
  const verdict = keys(key('period_comparison', lead) ?? key('trend', lead), key('peak', lead));
  b.push('full_width', [...p.headers.filter((h) => h.widgetType === 'hero_strip').map((h) => h.dashboardChartId),
    b.block('headline', verdict, { eyebrow: s.dashboard.name || undefined })]);

  // 2 · Why it matters: the headline numbers, then the argument chart with what
  //     moved beside it — the leader and how concentrated it is, targets met or
  //     missed, the other series.
  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'flush', kpiValueFontSize: 34 });
  const moved = keys(
    key('trend', lead),
    key('latest', lead),
    key('top_item', firstBreakdown),
    key('concentration', firstBreakdown),
    ...allOf('attainment', p.kpis),
    ...p.temporal.slice(1, 3).map((v) => key('trend', v)),
  );
  if (lead) {
    b.prefer(lead, 'primary', 'high');
    b.style(lead, { tileFrame: 'subtle', showGrid: false, lineWidth: 3 });
    const summary = b.block('summary', b.fresh(moved).slice(0, 4), { title: labels.whatMoved, frameless: true });
    b.push(summary !== null ? 'analysis_with_sidebar' : 'full_width', [lead.dashboardChartId, summary]);
  }

  // 3 · Supporting evidence: compositions before the other series, in pairs.
  const support = [...p.breakdowns, ...p.temporal.slice(1), ...p.others];
  for (const v of support) b.style(v, { tileFrame: 'subtle' });
  if (!lead && support[0]) b.prefer(support[0], 'primary', 'high');
  b.pairs(support);

  // 4 · Detail last, under its own heading.
  if (p.tables.length) {
    b.push('full_width', [b.block('chapter', [], { title: labels.detail, frameless: true, heading: true })]);
    for (const t of p.tables) { b.prefer(t, 'table', 'low'); b.push('table_full', [t.dashboardChartId]); }
  }
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
    rationale: 'Executive brief: what happened, why it matters (headline numbers and what moved beside the lead series), supporting evidence, detail last.',
  };
}

function operations(s: DashboardPresentationSnapshot, labels: DirectionLabels): PresentationPlan {
  const p = poolsOf(s.visuals);
  const b = new PlanBuilder(p.blocks, liveOf(s));

  // 1 · Current state: the numbers, then the latest complete period of each series.
  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'card', kpiValueFontSize: 26 });
  const status = p.temporal.slice(0, 3)
    .map((v) => b.block('takeaway', keys(key('latest', v)), { eyebrow: labels.latestStatus, title: v.title || undefined }))
    .filter((id): id is VisualId => id !== null);
  if (status.length) b.push(status.length === 3 ? 'three_equal' : status.length === 2 ? 'two_equal' : 'full_width', status);

  // 2 · What the data itself flags — said as what it is. A result carried by a
  //     few members, or a period not yet complete, is an OBSERVATION, not a
  //     problem: it is titled neutrally. A target met or missed is a separate
  //     block, and only where the data has a target. No threshold is invented,
  //     and nothing is called bad because it fell.
  const targets = b.block('callout', allOf('attainment', p.kpis).slice(0, 4), { title: labels.againstTarget });
  if (targets !== null) b.push('full_width', [targets]);
  const observations = keys(
    ...allOf('concentration', p.breakdowns),
    ...allOf('partial_periods', p.temporal),
  ).slice(0, 5);
  const attention = b.block('callout', observations, { title: labels.worthKnowing });

  // 3 · Monitoring: the series, with gridlines to read values off; the
  //     exception list beside the series it is about.
  const monitoring = p.temporal;
  for (const v of monitoring) b.style(v, { tileFrame: 'card', showGrid: true, showDataLabels: false });
  if (attention !== null && monitoring[0]) {
    b.push('analysis_with_sidebar', [monitoring[0].dashboardChartId, attention]);
    b.pairs(monitoring.slice(1));
  } else {
    if (attention !== null) b.push('full_width', [attention]);
    b.pairs(monitoring);
  }

  // 4 · Drill-down: the rankings, then the tables an operator works from.
  const drill = [...p.breakdowns, ...p.others];
  for (const v of drill) b.style(v, { tileFrame: 'card', showGrid: true, showDataLabels: true });
  if (drill.length || p.tables.length) {
    b.push('full_width', [b.block('chapter', [], { title: labels.detail, frameless: true, heading: true })]);
  }
  for (let i = 0; i < drill.length; i += 3) {
    const slice = drill.slice(i, i + 3);
    b.push(slice.length === 3 ? 'three_equal' : slice.length === 2 ? 'two_equal' : 'full_width', slice.map((v) => v.dashboardChartId));
  }
  for (const t of p.tables) { b.prefer(t, 'table', 'high'); b.push('table_full', [t.dashboardChartId]); }
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
    rationale: 'Operations board: current state, the exceptions the data flags, the monitoring series, then drill-down rankings and tables.',
  };
}

function editorial(s: DashboardPresentationSnapshot, labels: DirectionLabels): PresentationPlan {
  const p = poolsOf(s.visuals);
  const b = new PlanBuilder(p.blocks, liveOf(s));
  const lead = p.temporal[0] ?? p.breakdowns[0];

  // Thesis.
  b.push('full_width', [b.block('headline', keys(key('trend', lead) ?? key('period_comparison', lead), key('peak', lead), key('top_item', lead)),
    { eyebrow: s.dashboard.name || undefined, frameless: true })]);
  b.push('kpi_strip', p.kpis.map((v) => v.dashboardChartId));
  for (const k of p.kpis) b.style(k, { tileFrame: 'flush' });

  // Chapters: each chart with the sentences that explain it — never the ones
  // the thesis already said. Caveats wait for the end, where a reader weighs them.
  const story = [...p.temporal, ...p.breakdowns, ...p.others];
  story.forEach((v, i) => {
    const findings = b.fresh(keys(key('trend', v), key('peak', v), key('latest', v), key('top_item', v), key('period_comparison', v))).slice(0, 3);
    const chapter = b.block('chapter', findings, { title: v.title || undefined, frameless: true });
    b.style(v, { tileFrame: 'flush', showGrid: false });
    b.prefer(v, v === lead ? 'primary' : 'secondary', v === lead ? 'high' : 'normal');
    if (chapter === null) { b.push('full_width', [v.dashboardChartId]); return; }
    if (v === lead) {
      b.push('full_width', [chapter]);
      b.push('full_width', [v.dashboardChartId]);
    } else if (v.renderAspect === 'square') {
      // A pie beside its words; the side alternates so the page reads as a
      // sequence of spreads, not a column of cards.
      b.push('two_equal', i % 2 ? [v.dashboardChartId, chapter] : [chapter, v.dashboardChartId]);
    } else {
      // A supporting chapter: the explanation in a narrow column beside its chart.
      b.push('analysis_with_sidebar', [v.dashboardChartId, chapter]);
    }
  });
  for (const t of p.tables) { b.prefer(t, 'table', 'low'); b.push('table_full', [t.dashboardChartId]); }

  // What to keep in mind: the caveats the evidence carries, said once, last.
  const caveats = keys(...allOf('partial_periods', story), ...allOf('concentration', story), ...allOf('attainment', p.kpis));
  b.push('full_width', [b.block('callout', caveats.slice(0, 4), { title: labels.keepInMind, frameless: true })]);
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
    rationale: 'Editorial story: a thesis, a chapter per chart with what it shows, then the caveats to keep in mind.',
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
  if (direction === 'editorial') return editorial(snapshot, l);
  return executive(snapshot, l);
}
