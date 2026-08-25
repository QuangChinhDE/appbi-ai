/**
 * Templates, expressed as plans.
 *
 * The one-click template picker and the chat box must not become two layout
 * engines (§19). They do not here: a template is a `PresentationPlan` built by
 * code instead of by a model, and it goes through the same compiler, the same
 * validator and the same apply path. When the compiler learns a better way to
 * lay out five KPIs, both get it.
 *
 * The composition below is also what makes a redesign look designed rather than
 * auto-packed. Sorting tiles and pushing them upward produces a tidy wall of
 * equal rectangles with no hierarchy at all — the exact thing §30 says is not
 * the goal. So the composer reads the roles, puts the numbers on top, gives the
 * argument the width it needs, and sends the detail to the bottom.
 */
import type {
  CompositionStyle,
  DashboardPresentationSnapshot,
  PresentationDensity,
  PresentationPlan,
  PresentationRole,
  PresentationSection,
  SlicerPresentationIntent,
  SnapshotVisual,
  VisualId,
} from './types';

/** A template's presentation intent — the high-level description §20 asks for,
 *  with the token-level detail left to the theme catalog. */
export interface TemplateIntent {
  /** The catalog template id this corresponds to, so the theme half still
   *  comes from the existing one-click definition rather than a copy. */
  themeTemplate: string;
  composition: CompositionStyle;
  density: PresentationDensity;
  slicer: SlicerPresentationIntent;
}

export const TEMPLATE_INTENTS: Record<string, TemplateIntent> = {
  console: {
    themeTemplate: 'console',
    composition: 'saas',
    density: 'balanced',
    slicer: { dock: 'top', variant: 'auto', style: 'card', density: 'balanced' },
  },
  brief: {
    themeTemplate: 'brief',
    composition: 'finance',
    density: 'balanced',
    slicer: { dock: 'left', variant: 'dropdown', style: 'card', density: 'balanced' },
  },
  ops: {
    themeTemplate: 'ops',
    composition: 'operations',
    density: 'compact',
    slicer: { dock: 'left', variant: 'compact', style: 'compact', density: 'compact' },
  },
  editorial: {
    themeTemplate: 'editorial',
    composition: 'editorial',
    density: 'spacious',
    slicer: { dock: 'drawer', variant: 'dropdown', style: 'minimal', density: 'spacious' },
  },
  stage: {
    themeTemplate: 'stage',
    composition: 'presentation',
    density: 'spacious',
    slicer: { dock: 'top', variant: 'segmented', style: 'pill', density: 'spacious' },
  },
};

interface Buckets {
  headline: SnapshotVisual[];
  kpi: SnapshotVisual[];
  primary: SnapshotVisual[];
  secondary: SnapshotVisual[];
  breakdown: SnapshotVisual[];
  table: SnapshotVisual[];
  supporting: SnapshotVisual[];
  decorative: SnapshotVisual[];
}

/** Sort visuals into role buckets, keeping the author's reading order inside
 *  each one. Order is information: two KPIs the author put side by side stay
 *  side by side, in that order. */
function bucketize(visuals: SnapshotVisual[]): Buckets {
  const ordered = [...visuals].sort((a, b) => {
    const ay = a.currentLayout.y;
    const by = b.currentLayout.y;
    return ay !== by ? ay - by : a.currentLayout.x - b.currentLayout.x;
  });
  const buckets: Buckets = {
    headline: [], kpi: [], primary: [], secondary: [],
    breakdown: [], table: [], supporting: [], decorative: [],
  };
  for (const visual of ordered) {
    if (visual.isWidget) { buckets.decorative.push(visual); continue; }
    const role: PresentationRole = visual.displayRoleHint;
    buckets[role].push(visual);
  }
  return buckets;
}

const ids = (list: SnapshotVisual[]): VisualId[] => list.map((v) => v.dashboardChartId);

/**
 * Build the section list for a composition style.
 *
 * Each style is a different answer to "what does the reader do with this page":
 * an executive scans numbers then reads one argument; an operations board wants
 * as much on screen as possible; an editorial page wants one thing at a time.
 * They differ in COMPOSITION, not in colour — which is the complaint the whole
 * exercise started from.
 */
export function composeSections(
  style: CompositionStyle,
  visuals: SnapshotVisual[],
): PresentationSection[] {
  const b = bucketize(visuals);
  const sections: PresentationSection[] = [];

  const push = (primitive: PresentationSection['primitive'], list: VisualId[]) => {
    if (list.length > 0) sections.push({ primitive, visuals: list });
  };

  // A decorative widget the author already placed keeps its place at the top —
  // it is usually a header, and a redesign that buries it is wrong.
  push('full_width', ids(b.decorative.filter((v) => v.widgetType === 'hero_strip')));

  push('hero_metric', ids(b.headline));
  push('kpi_strip', ids(b.kpi));

  const primaries = [...b.primary];
  const breakdowns = [...b.breakdown];
  const secondaries = [...b.secondary];

  switch (style) {
    case 'operations': {
      // Dense: three across, everything visible, nothing precious.
      const wall = [...primaries, ...secondaries, ...breakdowns];
      for (let i = 0; i < wall.length; i += 3) {
        push('three_equal', ids(wall.slice(i, i + 3)));
      }
      break;
    }

    case 'editorial':
    case 'presentation': {
      // One thing at a time, full width. The reader is being walked through it.
      for (const visual of [...primaries, ...secondaries, ...breakdowns]) {
        push('full_width', [visual.dashboardChartId]);
      }
      break;
    }

    case 'finance': {
      // The argument, then its composition beside it, then the rest full width.
      const lead = primaries.shift();
      const partner = breakdowns.shift();
      if (lead && partner) push('two_one', [lead.dashboardChartId, partner.dashboardChartId]);
      else if (lead) push('full_width', [lead.dashboardChartId]);
      else if (partner) push('full_width', [partner.dashboardChartId]);
      for (const visual of [...primaries, ...secondaries, ...breakdowns]) {
        push('full_width', [visual.dashboardChartId]);
      }
      break;
    }

    case 'minimal': {
      const pairs = [...primaries, ...secondaries, ...breakdowns];
      for (let i = 0; i < pairs.length; i += 2) {
        push('two_equal', ids(pairs.slice(i, i + 2)));
      }
      break;
    }

    case 'executive':
    case 'saas':
    default: {
      // The shape people recognise: the argument large with its breakdown
      // beside it, then supporting pairs.
      const lead = primaries.shift();
      const partner = breakdowns.shift();
      if (lead && partner) push('two_one', [lead.dashboardChartId, partner.dashboardChartId]);
      else if (lead) push('full_width', [lead.dashboardChartId]);
      else if (partner) push('two_equal', [partner.dashboardChartId]);

      const rest = [...primaries, ...secondaries, ...breakdowns];
      for (let i = 0; i < rest.length; i += 2) {
        const slice = rest.slice(i, i + 2);
        push(slice.length === 2 ? 'two_equal' : 'full_width', ids(slice));
      }
      break;
    }
  }

  // Detail last, always. Nobody opens a report to read the table first.
  for (const table of b.table) push('table_full', [table.dashboardChartId]);

  // Remaining decorative widgets and anything unclassified, two across.
  const leftovers = [
    ...b.supporting,
    ...b.decorative.filter((v) => v.widgetType !== 'hero_strip'),
  ];
  for (let i = 0; i < leftovers.length; i += 2) {
    const slice = leftovers.slice(i, i + 2);
    push(slice.length === 2 ? 'two_equal' : 'full_width', ids(slice));
  }

  return sections;
}

const SPAN_FOR_ROLE: Record<PresentationRole, 'small' | 'medium' | 'large' | 'full'> = {
  headline: 'full',
  kpi: 'small',
  primary: 'large',
  secondary: 'medium',
  breakdown: 'small',
  table: 'full',
  supporting: 'medium',
};

const EMPHASIS_FOR_ROLE: Record<PresentationRole, 'low' | 'normal' | 'high'> = {
  headline: 'high',
  kpi: 'normal',
  primary: 'high',
  secondary: 'normal',
  breakdown: 'normal',
  table: 'low',
  supporting: 'low',
};

/**
 * A template as a plan. This is the function the "Re-arrange layout" button
 * calls, and it returns exactly the shape the AI planner returns — which is how
 * the two stay one engine rather than two.
 */
export function planFromTemplate(
  templateId: string,
  snapshot: DashboardPresentationSnapshot,
  scope: 'page' | 'report' = 'page',
): PresentationPlan {
  const intent = TEMPLATE_INTENTS[templateId] ?? TEMPLATE_INTENTS.console;
  const sections = composeSections(intent.composition, snapshot.visuals);

  const visualPreferences: PresentationPlan['visualPreferences'] = {};
  for (const visual of snapshot.visuals) {
    const role = visual.displayRoleHint;
    visualPreferences[String(visual.dashboardChartId)] = {
      role,
      span: SPAN_FOR_ROLE[role],
      emphasis: EMPHASIS_FOR_ROLE[role],
    };
  }

  return {
    scope,
    direction: { style: intent.composition, density: intent.density },
    sections,
    visualPreferences,
    slicerPresentation: intent.slicer,
    // The theme half stays the catalog's job — a template that redefined its
    // own tokens here would be the second source of truth all over again.
    themeIntent: { template: intent.themeTemplate, density: intent.density },
    rationale: `Applied the ${templateId} template composition.`,
  };
}

export function templateIntentIds(): string[] {
  return Object.keys(TEMPLATE_INTENTS);
}
