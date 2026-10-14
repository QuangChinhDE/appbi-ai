/**
 * THE responsive layout authority. Every surface that draws a report — the
 * Builder canvas (and its device modes), the Studio preview, the public page
 * /d, the stable /embed and the integration emb_ — asks this one pure function
 * which geometry to draw for a page at the width its report container measures.
 * No surface derives a tablet or phone layout on its own.
 *
 *   Desktop (lg, width >= 1024)  the authored layout (DashboardChart.layout).
 *   Tablet  (md, 640–1023)       AUTO: derived from desktop (deriveTabletLayout +
 *   Phone   (xs, < 640)                grow/stack content fit), never stored;
 *                                CUSTOM: the page's authored layout, stored
 *                                complete in dashboards.responsive_layouts —
 *                                drawn as stored, never re-fitted or re-flowed.
 *
 * A CUSTOM layout meets a changed tile set deterministically (reconcile):
 * a tile no longer on the page is dropped (the gap stays — nothing reflows); a
 * published tile the layout does not place is never omitted: the breakpoint's
 * generator places the missing tiles, in reading order, BELOW the layout. The
 * layout records the desktop it was frozen from (baseFingerprint); when desktop
 * moves on, the layout is reported `stale` and stays exactly as it is.
 *
 * Pure: no DOM, no network, no React state. Same inputs → byte-identical output.
 * docs/responsive-dashboard-layouts.md.
 */
import {
  DASHBOARD_GRID_COLS,
  REPORT_RESPONSIVE_COLS,
  REPORT_STACK_BREAKPOINT,
  REPORT_TABLET_BREAKPOINT,
  computeReportRowHeight,
  deriveStackedLayout,
  deriveTabletLayout,
  reportBreakpointFor,
  type ResponsiveTileKind,
} from '@/lib/dashboard-pages';
import { fitLayoutToContent } from '@/lib/responsive-fit';
import { readingOrder, toStructTiles } from '@/lib/report-structure';
import { tileKindOf } from '@/lib/dashboard-presentation/tile-frame';
import { withoutAbsentControls } from '@/lib/grid-arrange';
import type { CustomProfile, DeviceBreakpoint, GridCell, PageProfiles, ProfileDraft, ResponsiveLayoutsDoc } from '@/types/responsive-layout';

export type { CustomProfile, DeviceBreakpoint, GridCell, PageProfiles, ProfileDraft, ResponsiveLayoutsDoc };

export type ReportBreakpoint = 'lg' | 'md' | 'xs';
export const DEVICE_BREAKPOINTS: DeviceBreakpoint[] = ['md', 'xs'];

/** Version of the stored document's SHAPE. */
export const RESPONSIVE_DOC_VERSION = 1;
/**
 * Version of the AUTO generators below. A CUSTOM layout records the version it
 * was frozen with; its stored coordinates are never reinterpreted when the
 * generators change — only AUTO output follows the current version.
 */
export const RESPONSIVE_GENERATOR_VERSION = 1;
/** CUSTOM layouts are stored in the authoring grid, tablet and phone alike. */
export const CUSTOM_COLS = DASHBOARD_GRID_COLS;

export interface GridItem extends GridCell { i: string }

/** A tile as the resolver needs it (a DashboardChart of the page, grid-normalised). */
export interface ResolverTile {
  id: number;
  widget_type?: string | null;
  widget_config?: any;
  chart?: { chart_type?: string | null } | null;
  layout: any;
}

export interface ResolveInput {
  /** The page's tiles as this surface serves them. */
  tiles: ResolverTile[];
  /** Controls that draw nothing for this viewer (public only): their band closes. */
  absentIds?: ReadonlySet<number>;
  /** The page's CUSTOM layouts, if any (absent / null = AUTO). */
  profiles?: PageProfiles | null;
  /** The ONE measured report-container width (px). */
  containerWidth: number | null | undefined;
  /** Vertical grid gap (px). */
  gap: number;
  /** Content-decided heights in rows (AUTO only; ignored for CUSTOM). */
  measuredRows?: Record<string, number>;
  /** The Builder's desktop authoring canvas draws desktop at any width >= 640. */
  forceBreakpoint?: ReportBreakpoint;
}

export interface ResolvedLayout {
  breakpoint: ReportBreakpoint;
  cols: number;
  layout: GridItem[];
  source: 'desktop' | 'auto' | 'custom';
  /** Tiles a CUSTOM layout did not place, placed below it (in reading order). */
  orphans: string[];
  /** Tiles a CUSTOM layout placed that are not on the page any more. */
  dropped: string[];
  /** The CUSTOM layout was frozen from a different desktop than the current one. */
  stale: boolean;
  /** Fingerprint of the current desktop page (what a freeze records). */
  desktopFingerprint: string;
  /** Whether content measurement feeds this layout (AUTO tablet/phone only). */
  fitsContent: boolean;
}

// ── desktop preparation (the inputs every breakpoint is built from) ─────────

interface PreparedDesktop {
  layouts: GridItem[];
  kinds: Map<string, ResponsiveTileKind>;
  order: string[];
  fingerprint: string;
}

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : fallback;
};

function prepareDesktop(tiles: ResolverTile[], absent: ReadonlySet<number>): PreparedDesktop {
  // The public report's rule for a control that draws nothing for this viewer:
  // its band closes (grid-arrange withoutAbsentControls). Size defaults are the
  // public report's (4×4) — the published behaviour is the contract.
  const boxes = withoutAbsentControls(tiles.map((t) => ({
    id: t.id,
    x: Number(t.layout?.x) || 0,
    y: Number(t.layout?.y) || 0,
    w: num(t.layout?.w, 4),
    h: num(t.layout?.h, 4),
    locked: Boolean(t.layout?.locked),
  })), absent);
  const layouts: GridItem[] = boxes.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h }));
  const geometry = new Map(layouts.map((l) => [l.i, l]));
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const order = readingOrder(toStructTiles(tiles, (id) => ({
    ...(byId.get(id)?.layout ?? {}),
    ...geometry.get(String(id)),
  }))).map(String);
  const kinds = new Map(tiles.map((t) => [String(t.id), tileKindOf(t.chart?.chart_type, t.widget_type) as ResponsiveTileKind]));
  return { layouts, kinds, order, fingerprint: desktopFingerprint(tiles) };
}

/**
 * Fingerprint of a page's desktop: its tiles and their authored cells. A CUSTOM
 * layout stores the fingerprint it was frozen from; a different one means the
 * desktop changed since (`stale`). FNV-1a 64-bit — identity, not security.
 */
export function desktopFingerprint(tiles: ResolverTile[]): string {
  const text = [...tiles]
    .map((t) => `${t.id}:${Number(t.layout?.x) || 0},${Number(t.layout?.y) || 0},${num(t.layout?.w, 4)},${num(t.layout?.h, 4)}`)
    .sort()
    .join('|');
  let hi = 0xcbf29ce4 >>> 0;
  let lo = 0x84222325 >>> 0;
  for (let k = 0; k < text.length; k += 1) {
    lo = (lo ^ text.charCodeAt(k)) >>> 0;
    // ×(2^40 + 0x1b3) in 64-bit, as two 32-bit halves.
    const loMul = lo * 0x1b3;
    const carry = Math.floor(loMul / 0x100000000);
    const nextLo = loMul >>> 0;
    hi = (hi * 0x1b3 + (lo << 8) + carry) >>> 0;
    lo = nextLo;
  }
  return `fnv1a64:${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
}

// ── AUTO generators (the published behaviour before authored layouts) ───────

function autoGenerate(bp: DeviceBreakpoint, prep: Pick<PreparedDesktop, 'layouts' | 'kinds' | 'order'>, width: number, gap: number): GridItem[] {
  const kindOf = (item: GridItem) => prep.kinds.get(item.i) ?? 'chart';
  if (bp === 'md') {
    const ref = width >= REPORT_STACK_BREAKPOINT && width < REPORT_TABLET_BREAKPOINT ? width : 820;
    return deriveTabletLayout(prep.layouts, { kindOf, referenceWidthPx: ref });
  }
  const pitch = computeReportRowHeight(REPORT_STACK_BREAKPOINT - 1, gap) + gap;
  return deriveStackedLayout(prep.layouts, { kindOf, rowPitchPx: pitch, cols: REPORT_RESPONSIVE_COLS.xs, order: prep.order });
}

/** AUTO layout cells in the 36-column CUSTOM grid (the phone stack is 2-column). */
function toCustomGrid(bp: DeviceBreakpoint, items: GridItem[]): GridItem[] {
  const scale = CUSTOM_COLS / REPORT_RESPONSIVE_COLS[bp];
  if (scale === 1) return items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
  return items.map(({ i, x, y, w, h }) => ({ i, x: x * scale, y, w: w * scale, h }));
}

// ── the resolver ──────────────────────────────────────────────────────────

export function resolveReportLayout(input: ResolveInput): ResolvedLayout {
  const absent = input.absentIds ?? new Set<number>();
  const prep = prepareDesktop(input.tiles, absent);
  const width = Number(input.containerWidth) || 0;
  const breakpoint = input.forceBreakpoint ?? reportBreakpointFor(width);
  const base = { orphans: [] as string[], dropped: [] as string[], stale: false, desktopFingerprint: prep.fingerprint };
  if (breakpoint === 'lg') {
    return { ...base, breakpoint, cols: DASHBOARD_GRID_COLS, layout: prep.layouts, source: 'desktop', fitsContent: false };
  }
  const profile = input.profiles?.[breakpoint];
  if (profile && profile.mode === 'custom' && profile.items && typeof profile.items === 'object') {
    return resolveCustom(breakpoint, profile, input.tiles, absent, prep, width, input.gap);
  }
  const generated = autoGenerate(breakpoint, prep, width, input.gap);
  const fitted = fitLayoutToContent(generated, input.measuredRows, breakpoint === 'xs' ? 'stack' : 'grow');
  return { ...base, breakpoint, cols: REPORT_RESPONSIVE_COLS[breakpoint], layout: fitted, source: 'auto', fitsContent: true };
}

function resolveCustom(
  bp: DeviceBreakpoint,
  profile: CustomProfile,
  tiles: ResolverTile[],
  absent: ReadonlySet<number>,
  prep: PreparedDesktop,
  width: number,
  gap: number,
): ResolvedLayout {
  const onPage = new Set(tiles.map((t) => String(t.id)));
  const dropped = Object.keys(profile.items).filter((id) => !onPage.has(id)).sort((a, b) => Number(a) - Number(b));
  // The stored cells of the tiles still on the page (a control absent for this
  // viewer closes its band, as on desktop).
  const placedBoxes = withoutAbsentControls(
    tiles.filter((t) => profile.items[String(t.id)]).map((t) => {
      const c = profile.items[String(t.id)];
      return { id: t.id, x: c.x, y: c.y, w: c.w, h: c.h, locked: true };
    }),
    absent,
  );
  const placed: GridItem[] = placedBoxes.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h }));
  const placedIds = new Set(placed.map((p) => p.i));
  // Every served tile is drawn: the ones the layout does not place go below it,
  // laid out by this breakpoint's generator in reading order.
  const served = prep.layouts.filter((l) => !placedIds.has(l.i) && !profile.items[l.i]);
  const orphans = served.map((l) => l.i);
  let layout = placed;
  if (served.length) {
    const below = toCustomGrid(bp, autoGenerate(bp, { layouts: served, kinds: prep.kinds, order: prep.order }, width, gap));
    const bottom = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    layout = [...placed, ...below.map((b) => ({ ...b, y: b.y + bottom }))];
  }
  return {
    breakpoint: bp,
    cols: CUSTOM_COLS,
    layout,
    source: 'custom',
    orphans,
    dropped,
    stale: profile.baseFingerprint !== prep.fingerprint,
    desktopFingerprint: prep.fingerprint,
    fitsContent: false,
  };
}

// ── authoring helpers (Builder device mode) ─────────────────────────────────

/**
 * Freeze what a device currently shows into a complete CUSTOM layout: every
 * cell of `resolved` (an AUTO resolution, content fit included — or a CUSTOM one
 * with its orphans placed) in the 36-column grid. Clicking Customize therefore
 * moves nothing.
 */
export function freezeLayout(
  resolved: ResolvedLayout,
  opts: { source: CustomProfile['source']; rev?: number },
): CustomProfile {
  if (resolved.breakpoint === 'lg') throw new Error('desktop is not a device layout');
  const bp = resolved.breakpoint;
  const cells = resolved.source === 'auto' ? toCustomGrid(bp, resolved.layout) : resolved.layout;
  const items: Record<string, GridCell> = {};
  for (const c of [...cells].sort((a, b) => Number(a.i) - Number(b.i))) items[c.i] = { x: c.x, y: c.y, w: c.w, h: c.h };
  return {
    mode: 'custom',
    cols: CUSTOM_COLS,
    ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
    generatorVersion: RESPONSIVE_GENERATOR_VERSION,
    baseFingerprint: resolved.desktopFingerprint,
    source: opts.source,
    items,
  };
}

/** A CUSTOM layout with new cells (an author's drag/resize), same provenance. */
export function withCells(profile: CustomProfile, cells: GridItem[]): CustomProfile {
  const items: Record<string, GridCell> = { ...profile.items };
  for (const c of cells) items[c.i] = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
  return { ...profile, items };
}

/**
 * Problems the server would refuse (same rules as
 * backend/app/services/responsive_layouts.py): cells outside the 36-column grid,
 * non-integer or non-positive sizes, overlapping cells.
 */
export function customLayoutProblems(profile: CustomProfile): string[] {
  const problems: string[] = [];
  const cells = Object.entries(profile.items).map(([i, c]) => ({ i, ...c }));
  for (const c of cells) {
    if (![c.x, c.y, c.w, c.h].every(Number.isInteger)) problems.push(`tile ${c.i}: non-integer cell`);
    else if (c.x < 0 || c.y < 0 || c.w < 1 || c.h < 1 || c.x + c.w > CUSTOM_COLS) problems.push(`tile ${c.i}: outside the grid`);
  }
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let a = 0; a < sorted.length; a += 1) {
    for (let b = a + 1; b < sorted.length && sorted[b].y < sorted[a].y + sorted[a].h; b += 1) {
      const p = sorted[a]; const q = sorted[b];
      if (p.x < q.x + q.w && q.x < p.x + p.w) problems.push(`tiles ${p.i} and ${q.i} overlap`);
    }
  }
  return problems;
}

/** The page's profiles with a draft layered over the published ones. */
export function overlayProfiles(published: PageProfiles | null | undefined, draft: Partial<Record<DeviceBreakpoint, ProfileDraft>> | null | undefined): PageProfiles {
  const out: PageProfiles = { ...(published ?? {}) };
  for (const bp of DEVICE_BREAKPOINTS) {
    const d = draft?.[bp];
    if (!d) continue;
    out[bp] = d.mode === 'custom' ? d : null;
  }
  return out;
}
