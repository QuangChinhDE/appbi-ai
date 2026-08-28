/**
 * The deterministic half.
 *
 * A plan says "these four are the KPI strip, this trend is primary, the table
 * goes full width". This turns that into coordinates on the 36-column grid, and
 * it is the only thing in the system allowed to decide a number. The planner
 * never emits x/y/w/h — not because it could not, but because it would
 * occasionally emit two tiles that overlap, and an overlap is not a style
 * disagreement you can review, it is a broken page.
 *
 * Same input, same output, every time. That property is what makes the preview
 * honest: what the diff showed is exactly what Apply writes.
 */
import { DASHBOARD_GRID_COLS, GRID_VERSION, dashboardRowHeight } from '@/lib/dashboard-pages';
import { MIN_TILE_H, MIN_TILE_W, MAX_TILE_H } from './capabilities';
import type {
  DashboardPresentationSnapshot,
  LayoutPrimitive,
  PresentationDensity,
  PresentationMutation,
  PresentationPlan,
  PresentationSection,
  PresentationSpan,
  SnapshotVisual,
  VisualId,
} from './types';

const COLS = DASHBOARD_GRID_COLS; // 36

/**
 * How tall each role wants to be, in PIXELS.
 *
 * Rows would be the obvious unit and are the wrong one. The finer grid's row
 * pitch is `(80 − 2·gap)/3` — about 21px at the default gap — because it was
 * derived to keep a ×3-migrated tile pixel-identical, not to be a comfortable
 * authoring unit. A first version of this file used row counts borrowed from
 * the importer's 12-column recipes (kpi 2, chart 4) and shipped a redesign
 * where KPI cards were 51px tall and charts 109px: the numbers were clipped and
 * the axes unreadable. The heights are stated in the unit a person actually
 * judges — pixels — and converted with the same arithmetic the renderer uses,
 * so they stay right when the theme's density changes the gap.
 */
const TARGET_HEIGHT_PX: Record<string, number> = {
  headline: 120,   // one big number — still compact; a KPI strip stays one band
  kpi: 104,        // the strip: value + label, compact — a number is not a chart
  primary: 380,    // the argument — an axis you can read
  secondary: 320,
  breakdown: 320,  // a donut needs to be round, not a letterbox
  table: 430,      // ~8 rows plus a header
  supporting: 260,
  section_header: 64,
  hero_strip: 200,
  callout: 140,
};

const DENSITY_HEIGHT_SCALE: Record<PresentationDensity, number> = {
  compact: 0.85,
  balanced: 1,
  spacious: 1.25,
};

/**
 * Floors, in pixels, below which a tile stops being readable.
 *
 * These exist because the arithmetic above has too many ways to arrive at a bad
 * number: a role's target, a density scale and an emphasis weight all multiply,
 * and `compact` applied to a gauge produced a 109px tile on a page where
 * everything else was 300px. Rather than audit every combination, the result is
 * clamped. A model may ask for a denser page; it may not ask for a chart nobody
 * can read.
 */
const MIN_DATA_VISUAL_PX = 150;
const MIN_DECORATIVE_PX = 56;
/** A KPI is a number and a label, not an axis — it reads fine well below the
 *  chart floor, and holding it to the chart floor left a strip of tall cards
 *  with a lot of empty space under each number (§ KPI-too-tall). */
const MIN_KPI_PX = 95;
const KPI_ROLES: ReadonlySet<string> = new Set(['kpi', 'headline']);

/**
 * Chart types that need REAL height regardless of the role they were given.
 *
 * A gauge is a semicircle, a funnel is a stack, a donut is a ring — squeeze any
 * of them into a KPI-strip band and it renders as a broken sliver (the on-time
 * gauge came out as a 91.9 with a smear behind it). The role decides prominence;
 * the chart type decides the floor below which the mark stops being itself. This
 * floor is applied on TOP of the role floor, so a gauge the model called a "kpi"
 * still gets the height a gauge needs.
 */
const CHART_TYPE_MIN_PX: Record<string, number> = {
  GAUGE: 220, FUNNEL: 240, PIE: 210, DONUT: 210, RADAR: 240,
  WATERFALL: 240, SANKEY: 260, TREEMAP: 210, RADIAL_BAR: 220, PODIUM: 210,
};

/** How a primitive divides a row. `null` means "share equally between however
 *  many visuals the section holds", which is what the KPI strip needs. */
const PRIMITIVE_SPANS: Record<LayoutPrimitive, number[] | null> = {
  kpi_strip: null,
  hero_metric: [COLS],
  full_width: [COLS],
  two_equal: [18, 18],
  two_one: [24, 12],
  one_two: [12, 24],
  three_equal: [12, 12, 12],
  bento_primary: [24, 12],
  bento_secondary: [12, 12, 12],
  table_full: [COLS],
  analysis_with_sidebar: [27, 9],
  // Self-sizing, like the KPI strip: the hero and the rail do not share a row,
  // so a single span table cannot describe them. `placeRail` owns the geometry.
  hero_with_rail: null,
  section_break: [COLS],
};

/** The hero/rail split, in columns. A rail tile at 12 of 36 sits exactly on the
 *  `CHART_MAX_PER_ROW` floor — a third of the width — which is the narrowest a
 *  chart with an axis stays readable at. Narrower and the rail becomes a column
 *  of unreadable slivers, which is the failure this whole file exists to avoid. */
const HERO_RAIL_HERO_COLS = 24;
const HERO_RAIL_RAIL_COLS = COLS - HERO_RAIL_HERO_COLS; // 12

/** At most three charts stacked in the rail. A fourth makes each one too short
 *  to read once the section is clamped to the grid's max height. */
const RAIL_MAX_TILES = 3;

/** The rail's charts are secondary by definition, so they are sized a little
 *  under their standalone height — a rail of full-height charts would tower over
 *  the hero it is meant to support. */
const RAIL_HEIGHT_SCALE = 0.85;

/**
 * How many KPIs to put on one row.
 *
 * The obvious answer -- all of them -- is wrong past four. Six across on this
 * report gave each card 6 of 36 columns and every title truncated to "GMV (...",
 * "Doanh ...", "Số đơn...". A headline number whose label you cannot read is not
 * a headline. So the strip wraps instead, and the divisor is chosen to avoid an
 * orphan: five KPIs go 3 + 2, not 4 + 1.
 */
const KPI_MAX_PER_ROW = 4;

/**
 * The same argument for charts, one size up.
 *
 * A KPI is a number and a label; a chart is an axis. Four charts across gave
 * each one 9 of 36 columns -- about 270px -- and the line chart's month labels
 * collapsed into an unreadable smear while the treemap showed "health_",
 * "watche", "furnitur". Three across is the floor for anything with an axis.
 */
const CHART_MAX_PER_ROW = 3;

function bestDivisor(count: number, max: number): number {
  if (count <= max) return count;
  const candidates = [];
  for (let d = max; d >= 2; d -= 1) candidates.push(d);
  const exact = candidates.find((d) => count % d === 0);
  if (exact) return exact;
  // No clean split. Prefer the one whose leftover row is not a single lonely
  // card stretched across the page.
  return candidates
    .map((d) => ({ d, remainder: count % d }))
    .sort((a, b) => b.remainder - a.remainder)[0].d;
}

function kpiPerRow(count: number): number {
  return bestDivisor(count, KPI_MAX_PER_ROW);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** The declared shape of a primitive, for tests and for the template layer.
 *  Exposed so the span tables can be asserted at the source: `placeRow` clamps
 *  a too-wide span to the remaining width, which keeps a bad table from
 *  breaking the page but also hides it — the clamp is a seatbelt, not a reason
 *  to skip checking the arithmetic. */
export function primitiveSpans(primitive: LayoutPrimitive): number[] | null {
  const declared = PRIMITIVE_SPANS[primitive];
  return declared ? [...declared] : null;
}

export const GRID_COLUMNS = COLS;

/** Split a row into `count` spans that sum to exactly COLS. Remainders go to
 *  the leftmost tiles, so any unevenness reads as deliberate emphasis rather
 *  than a ragged right edge. */
export function splitRow(count: number, total: number = COLS): number[] {
  const n = Math.max(1, count);
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Widths for one section. */
function spansForSection(section: PresentationSection): number[] {
  const count = section.visuals.length;
  if (count === 0) return [];

  if (section.primitive === 'kpi_strip') {
    return splitRow(kpiPerRow(count));
  }

  const declared = PRIMITIVE_SPANS[section.primitive];
  if (!declared) return splitRow(count);

  // The primitive declares a shape for N tiles; the section may hold a
  // different number. Rather than dropping the extras (which would lose a
  // visual) or overflowing the row, fall back to an even split.
  if (declared.length !== count) return splitRow(count);
  return declared;
}

const SPAN_WEIGHT: Record<PresentationSpan, number> = {
  small: 0.6, medium: 1, large: 1.4, full: 2,
};

export interface CompileInput {
  plan: PresentationPlan;
  snapshot: DashboardPresentationSnapshot;
  /** The page every compiled tile stays on. The compiler cannot move a tile
   *  between pages because it only ever writes this one value. */
  pageId: string;
  /** The theme's inter-tile gap in px. It sets the row pitch, so a height in
   *  pixels cannot be turned into rows without it. Defaults to the grid's own
   *  default rather than being required, so a caller that does not care still
   *  gets sensible sizes. */
  gridGapPx?: number;
}

const DEFAULT_GRID_GAP_PX = 8;

/** Rows needed to render `targetPx` tall, by the renderer's own arithmetic:
 *  a tile of h rows measures `h·rowHeight + (h−1)·gap`. */
export function rowsForHeight(targetPx: number, gridGapPx: number = DEFAULT_GRID_GAP_PX): number {
  const rowHeight = dashboardRowHeight(gridGapPx);
  const pitch = rowHeight + gridGapPx;
  return Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, Math.round((targetPx + gridGapPx) / pitch)));
}

/** Rows guaranteed to render AT LEAST `minPx` tall.
 *
 *  `rowsForHeight` rounds to nearest, which is right for a target and wrong for
 *  a floor: a 150px floor came back as 5 rows = 139px, so the floor silently
 *  was not one. A minimum rounds up. */
export function rowsAtLeast(minPx: number, gridGapPx: number = DEFAULT_GRID_GAP_PX): number {
  const rowHeight = dashboardRowHeight(gridGapPx);
  const pitch = rowHeight + gridGapPx;
  return Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, Math.ceil((minPx + gridGapPx) / pitch)));
}

export interface CompileResult {
  mutation: PresentationMutation;
  /** Visuals the plan never mentioned. They are appended, never dropped. */
  orphanIds: VisualId[];
}

/**
 * Compile a plan into grid geometry.
 *
 * Two invariants are structural rather than checked afterwards:
 *   - every visual in the snapshot appears exactly once in the output, because
 *     the section walk consumes a de-duplicated set and whatever is left over
 *     is appended;
 *   - no row can overflow, because widths come from `splitRow`, which sums to
 *     the grid width by construction.
 */
/**
 * Fix the composition mistakes a planner reliably makes, before compiling.
 *
 * Observed on the real report: asked for a "modern SaaS look", the model put
 * four KPIs into `two_equal` sections — each headline number given half the page
 * and two rows of height, so the public view showed six near-empty cards with a
 * label and a lot of white. It is a defensible reading of the schema and a bad
 * report.
 *
 * The fix belongs here rather than in the prompt. §8 draws the line at "the
 * model decides what matters, code decides the geometry", and how wide a KPI
 * should be is geometry. Telling the model more firmly would work most of the
 * time; doing it deterministically works every time.
 */
function normalizeSections(
  sections: PresentationSection[],
  roleOf: (id: VisualId) => string,
): { sections: PresentationSection[]; notes: string[] } {
  const notes: string[] = [];
  const out: PresentationSection[] = [];
  let merged = 0;

  for (const section of sections) {
    const ids = section.visuals ?? [];
    const allKpis = ids.length > 0 && ids.every((id) => roleOf(id) === 'kpi');
    if (allKpis && section.primitive !== 'kpi_strip') {
      // Fold consecutive all-KPI sections into ONE strip, so four KPIs split
      // across two sections still end up on a single row.
      const previous = out[out.length - 1];
      if (previous && previous.primitive === 'kpi_strip') {
        previous.visuals = [...previous.visuals, ...ids];
      } else {
        out.push({ primitive: 'kpi_strip', visuals: [...ids] });
      }
      merged += 1;
      continue;
    }
    out.push({ ...section, visuals: [...ids] });
  }

  if (merged > 0) {
    notes.push('Grouped the headline numbers into one row — a KPI reads better in a strip than at half-page width.');
  }
  return { sections: out, notes };
}

export function compilePresentationPlan(input: CompileInput): CompileResult {
  const { plan, snapshot, pageId } = input;
  const notes: string[] = [];
  const byId = new Map<VisualId, SnapshotVisual>();
  for (const visual of snapshot.visuals) byId.set(visual.dashboardChartId, visual);

  const density = plan.direction?.density ?? 'balanced';
  const heightScale = DENSITY_HEIGHT_SCALE[density] ?? 1;
  const gapPx = input.gridGapPx ?? DEFAULT_GRID_GAP_PX;

  const layoutOverrides: PresentationMutation['layoutOverrides'] = {};
  const placed = new Set<VisualId>();
  let cursorY = 0;

  const placeRow = (ids: VisualId[], spans: number[]) => {
    // Every tile in a row gets the SAME height. Sizing each one to its own role
    // left rows with a ragged bottom edge -- the published report had a row of
    // 109px / 109px / 51px, which reads as a rendering fault rather than a
    // design. A row is a band; the tallest thing in it sets the band.
    const heights = ids.map((id) => {
      const visual = byId.get(id);
      const pref = plan.visualPreferences?.[String(id)];
      const role = pref?.role ?? visual?.displayRoleHint ?? 'supporting';
      const weight = SPAN_WEIGHT[pref?.span ?? 'medium'] ?? 1;
      const scaled = (TARGET_HEIGHT_PX[role] ?? TARGET_HEIGHT_PX.supporting)
        * heightScale
        // An emphasised visual earns a little more height, so "make this one
        // bigger" reads as bigger and not merely wider.
        * (weight > 1 ? 1.12 : 1);
      // A section header is meant to be a thin band; a chart is not. Only a
      // real widget gets the low floor — an unknown tile is treated as a chart,
      // because being too tall is a nuisance and being too short hides data.
      const roleFloorPx = visual?.isWidget
        ? MIN_DECORATIVE_PX
        : (KPI_ROLES.has(role) ? MIN_KPI_PX : MIN_DATA_VISUAL_PX);
      // A gauge/funnel/donut keeps the height its shape needs even when the role
      // would make it a compact card.
      const chartFloorPx = CHART_TYPE_MIN_PX[String(visual?.chartType ?? '').toUpperCase()] ?? 0;
      const floorPx = Math.max(roleFloorPx, chartFloorPx);
      return Math.max(rowsForHeight(scaled, gapPx), rowsAtLeast(floorPx, gapPx));
    });
    const rowH = heights.length > 0 ? Math.max(...heights) : MIN_TILE_H;

    let x = 0;
    ids.forEach((id, index) => {
      const span = clamp(spans[index] ?? MIN_TILE_W, MIN_TILE_W, COLS - x);
      layoutOverrides[id] = { x, y: cursorY, w: span, h: rowH, gv: GRID_VERSION, pageId };
      placed.add(id);
      x += span;
    });
    cursorY += rowH;
  };

  // The height one tile wants, in rows, by the same arithmetic `placeRow` uses.
  // Broken out because the rail needs a per-tile height and `placeRow`
  // deliberately gives every tile in its row the SAME height — the rail is the
  // one place tiles that are NOT in a shared row get sized individually.
  const rowsForRole = (id: VisualId, extraScale: number): number => {
    const visual = byId.get(id);
    const pref = plan.visualPreferences?.[String(id)];
    const role = pref?.role ?? visual?.displayRoleHint ?? 'supporting';
    const weight = SPAN_WEIGHT[pref?.span ?? 'medium'] ?? 1;
    const scaled = (TARGET_HEIGHT_PX[role] ?? TARGET_HEIGHT_PX.supporting)
      * heightScale * extraScale * (weight > 1 ? 1.12 : 1);
    const floorPx = visual?.isWidget ? MIN_DECORATIVE_PX : MIN_DATA_VISUAL_PX;
    return Math.max(rowsForHeight(scaled, gapPx), rowsAtLeast(floorPx, gapPx));
  };

  /**
   * A hero on the left, a vertical rail of stacked charts on the right.
   *
   * The grid's row model is what makes this align to the pixel: a tile spanning
   * H rows occupies exactly the vertical extent of consecutive tiles whose row
   * counts sum to H (the inter-tile gaps land in the same places either way). So
   * the hero is given `sectionRows` and the rail tiles are sized to sum to it,
   * and their bottoms meet the hero's with no fudge factor.
   *
   * Every height is clamped so the section fits `MAX_TILE_H`; without that a
   * three-chart rail could ask for a hero taller than a tile may be, which the
   * mutation validator would reject as geometry and turn the whole redesign into
   * a refusal the user cannot act on.
   */
  const placeRail = (heroId: VisualId, railIds: VisualId[]) => {
    const railCount = Math.max(1, railIds.length);
    // Split the max height between the rail tiles so their sum can never exceed
    // one tile's ceiling — then the hero, sized to that sum, cannot either.
    const perRailCap = Math.max(MIN_TILE_H, Math.floor(MAX_TILE_H / railCount));
    const railRows = railIds.map((id) => clamp(rowsForRole(id, RAIL_HEIGHT_SCALE), MIN_TILE_H, perRailCap));
    const railTotal = railRows.reduce((sum, h) => sum + h, 0);
    const heroOwn = clamp(rowsForRole(heroId, 1), MIN_TILE_H, MAX_TILE_H);
    const sectionRows = clamp(Math.max(heroOwn, railTotal), MIN_TILE_H, MAX_TILE_H);

    layoutOverrides[heroId] = {
      x: 0, y: cursorY, w: HERO_RAIL_HERO_COLS, h: sectionRows, gv: GRID_VERSION, pageId,
    };
    placed.add(heroId);

    let ry = cursorY;
    railIds.forEach((id, index) => {
      // The last tile absorbs the difference between the rail's natural total
      // and the section height, so the rail's bottom always meets the hero's.
      const h = index === railIds.length - 1 ? sectionRows - (ry - cursorY) : railRows[index];
      layoutOverrides[id] = {
        x: HERO_RAIL_HERO_COLS, y: ry, w: HERO_RAIL_RAIL_COLS, h, gv: GRID_VERSION, pageId,
      };
      placed.add(id);
      ry += h;
    });
    cursorY += sectionRows;
  };

  const roleOf = (id: VisualId): string =>
    plan.visualPreferences?.[String(id)]?.role ?? byId.get(id)?.displayRoleHint ?? 'supporting';
  const normalized = normalizeSections(plan.sections ?? [], roleOf);
  notes.push(...normalized.notes);

  for (const section of normalized.sections) {
    // De-duplicate defensively: a plan that lists the same visual in two
    // sections would otherwise place it twice and the second placement would
    // win silently, leaving a hole in the first row.
    const ids = (section.visuals ?? []).filter((id) => {
      if (placed.has(id)) {
        notes.push(`Visual ${id} appeared more than once in the plan; kept the first placement.`);
        return false;
      }
      return byId.has(id);
    });
    if (ids.length === 0) continue;

    if (section.primitive === 'kpi_strip') {
      const perRow = spansForSection({ ...section, visuals: ids }).length;
      for (let i = 0; i < ids.length; i += perRow) {
        const slice = ids.slice(i, i + perRow);
        placeRow(slice, splitRow(slice.length));
      }
      continue;
    }

    if (section.primitive === 'hero_with_rail') {
      // hero + 1–3 rail tiles is the shape. One visual has no rail, so it is a
      // full-width tile; more than four cannot be a legible rail, so it falls
      // back to the even-split wall the oversized case already uses — the
      // primitive degrades to something sane rather than producing slivers.
      if (ids.length >= 2 && ids.length <= 1 + RAIL_MAX_TILES) {
        placeRail(ids[0], ids.slice(1));
      } else if (ids.length === 1) {
        placeRow(ids, [COLS]);
      } else {
        const perRow = bestDivisor(ids.length, CHART_MAX_PER_ROW);
        for (let i = 0; i < ids.length; i += perRow) {
          const slice = ids.slice(i, i + perRow);
          placeRow(slice, splitRow(slice.length));
        }
      }
      continue;
    }

    // A primitive that declares a shape for exactly this many visuals is
    // honoured as authored -- `analysis_with_sidebar` puts a 9-column chart
    // beside a 27-column one on purpose, and that is a composition, not an
    // accident. Only the even-split fallback is capped: it is where a section
    // holding four charts silently became four 9-column slivers.
    const declared = primitiveSpans(section.primitive);
    if (declared && declared.length === ids.length) {
      placeRow(ids, declared);
      continue;
    }

    const perRow = bestDivisor(ids.length, CHART_MAX_PER_ROW);
    for (let i = 0; i < ids.length; i += perRow) {
      const slice = ids.slice(i, i + perRow);
      placeRow(slice, splitRow(slice.length));
    }
  }

  // Anything the plan forgot. Losing a visual is the one failure this feature
  // must never have, so the compiler appends rather than trusting the plan to
  // be exhaustive — and says so, because a silently appended chart is a plan
  // the user should know was incomplete.
  const orphanIds: VisualId[] = [];
  for (const visual of snapshot.visuals) {
    if (placed.has(visual.dashboardChartId)) continue;
    orphanIds.push(visual.dashboardChartId);
  }
  if (orphanIds.length > 0) {
    notes.push(`${orphanIds.length} visual(s) were not placed by the plan and were appended in reading order.`);
    for (let i = 0; i < orphanIds.length; i += 2) {
      placeRow(orphanIds.slice(i, i + 2), splitRow(Math.min(2, orphanIds.length - i)));
    }
  }

  return {
    mutation: {
      layoutOverrides,
      themePatch: {},
      slicerClusterPatch: {},
      createdWidgets: [],
      notes,
    },
    orphanIds,
  };
}
