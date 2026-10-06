/**
 * Arrange tools for the report grid: align, match size, distribute, nudge.
 *
 * The grid is free-form (compactType null + preventCollision): a tile stays
 * where it is put and never shoves a neighbour. These tools keep that promise.
 * An arrangement either fits — no moved tile overlaps another tile — or it is
 * refused and says which tile is in the way. Nothing that is not selected
 * moves, and a locked tile never moves (it is an obstacle like any other).
 * Pure: the page commits the result through the same layout-override path as
 * a drag, so Save, Discard, Undo and Redo cover it.
 */
import { DASHBOARD_GRID_COLS } from './dashboard-pages';

export interface GridBox {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  locked?: boolean;
}

export type ArrangeOp =
  | 'alignLeft'
  | 'alignRight'
  | 'alignTop'
  | 'alignBottom'
  | 'matchWidth'
  | 'matchHeight'
  | 'distribute';

export const ARRANGE_OPS: ArrangeOp[] = [
  'alignLeft', 'alignRight', 'alignTop', 'alignBottom', 'matchWidth', 'matchHeight', 'distribute',
];

export type ArrangeResult =
  | { status: 'ok'; moved: GridBox[]; skippedLocked: number }
  | { status: 'blocked'; blockedBy: number }
  | { status: 'noop'; skippedLocked: number };

function overlaps(a: GridBox, b: GridBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The first tile any of `moved` would overlap, among the rest of the page. */
function firstCollision(moved: GridBox[], page: GridBox[]): number | null {
  const movedIds = new Set(moved.map((b) => b.id));
  const still = page.filter((b) => !movedIds.has(b.id));
  for (let i = 0; i < moved.length; i += 1) {
    for (const other of still) if (overlaps(moved[i], other)) return other.id;
    for (let j = i + 1; j < moved.length; j += 1) if (overlaps(moved[i], moved[j])) return moved[j].id;
  }
  return null;
}

const clampX = (x: number, w: number, cols: number) => Math.max(0, Math.min(cols - w, x));

/**
 * Arrange the selected tiles. `page` is every tile on the page (selected or
 * not), `selectedIds` in the order they were selected — the first one is the
 * reference for "same width / same height", as in presentation tools.
 */
export function arrangeTiles(
  op: ArrangeOp,
  page: GridBox[],
  selectedIds: number[],
  cols: number = DASHBOARD_GRID_COLS,
): ArrangeResult {
  const byId = new Map(page.map((b) => [b.id, b]));
  const selected = selectedIds.map((id) => byId.get(id)).filter((b): b is GridBox => Boolean(b));
  const movable = selected.filter((b) => !b.locked);
  const skippedLocked = selected.length - movable.length;
  if (selected.length < 2 || movable.length === 0) return { status: 'noop', skippedLocked };

  let next: GridBox[];
  switch (op) {
    case 'alignLeft': {
      const x = Math.min(...selected.map((b) => b.x));
      next = movable.map((b) => ({ ...b, x }));
      break;
    }
    case 'alignRight': {
      const right = Math.max(...selected.map((b) => b.x + b.w));
      next = movable.map((b) => ({ ...b, x: clampX(right - b.w, b.w, cols) }));
      break;
    }
    case 'alignTop': {
      const y = Math.min(...selected.map((b) => b.y));
      next = movable.map((b) => ({ ...b, y }));
      break;
    }
    case 'alignBottom': {
      const bottom = Math.max(...selected.map((b) => b.y + b.h));
      next = movable.map((b) => ({ ...b, y: Math.max(0, bottom - b.h) }));
      break;
    }
    case 'matchWidth': {
      const w = selected[0].w;
      next = movable.map((b) => {
        const width = Math.min(w, cols);
        return { ...b, w: width, x: clampX(b.x, width, cols) };
      });
      break;
    }
    case 'matchHeight': {
      const h = selected[0].h;
      next = movable.map((b) => ({ ...b, h }));
      break;
    }
    case 'distribute': {
      // Equal gaps between the selected tiles, left to right, inside the span
      // they already cover. The outermost two stay put.
      if (selected.length < 3) return { status: 'noop', skippedLocked };
      const ordered = [...selected].sort((a, b) => a.x - b.x || a.y - b.y);
      const start = ordered[0].x;
      const end = ordered[ordered.length - 1].x + ordered[ordered.length - 1].w;
      const totalW = ordered.reduce((s, b) => s + b.w, 0);
      const gap = (end - start - totalW) / (ordered.length - 1);
      if (gap < 0) return { status: 'noop', skippedLocked };
      let cursor = start;
      const target = new Map<number, number>();
      ordered.forEach((b) => { target.set(b.id, Math.round(cursor)); cursor += b.w + gap; });
      next = movable.map((b) => ({ ...b, x: clampX(target.get(b.id) ?? b.x, b.w, cols) }));
      break;
    }
    default:
      return { status: 'noop', skippedLocked };
  }

  const changed = next.filter((b) => {
    const was = byId.get(b.id)!;
    return b.x !== was.x || b.y !== was.y || b.w !== was.w || b.h !== was.h;
  });
  if (changed.length === 0) return { status: 'noop', skippedLocked };
  const blockedBy = firstCollision(changed, page);
  if (blockedBy != null) return { status: 'blocked', blockedBy };
  return { status: 'ok', moved: changed, skippedLocked };
}

/** Move the selected, unlocked tiles by whole cells. All or nothing. */
export function nudgeTiles(
  page: GridBox[],
  selectedIds: number[],
  delta: { dx: number; dy: number },
  cols: number = DASHBOARD_GRID_COLS,
): ArrangeResult {
  const selected = page.filter((b) => selectedIds.includes(b.id));
  const movable = selected.filter((b) => !b.locked);
  const skippedLocked = selected.length - movable.length;
  if (movable.length === 0) return { status: 'noop', skippedLocked };
  const next = movable.map((b) => ({
    ...b,
    x: clampX(b.x + delta.dx, b.w, cols),
    y: Math.max(0, b.y + delta.dy),
  }));
  const changed = next.filter((b, i) => b.x !== movable[i].x || b.y !== movable[i].y);
  if (changed.length === 0) return { status: 'noop', skippedLocked };
  const blockedBy = firstCollision(changed, page);
  if (blockedBy != null) return { status: 'blocked', blockedBy };
  return { status: 'ok', moved: changed, skippedLocked };
}

// ── Drop and resize on the grid ────────────────────────────────────────────

export interface DropResult {
  status: 'ok' | 'refused';
  /** Every tile whose cell changed, the moved one included. */
  changed: GridBox[];
  /** The tile that stopped it (refused). */
  blockedBy?: number;
  /** Why: a locked tile would have had to move, or a tile reaches into the spot. */
  reason?: 'locked' | 'occupied';
  /** Rows a vacated filter band gave back. */
  closedRows?: number;
}

/**
 * A tile resized IN PLACE on a device layout: only what it now covers moves
 * down — to just below it — and, in turn, only what those then cover. A tile
 * beside it (another column) never moves, unlike a band-opening drop. A locked
 * tile in the way refuses the resize. Never overlaps.
 */
export function growInPlace(
  page: GridBox[],
  id: number,
  rect: { x: number; y: number; w: number; h: number },
): DropResult {
  const boxes = page.map((b) => ({ ...b }));
  const self = boxes.find((b) => b.id === id);
  if (!self) return { status: 'refused', changed: [] };
  Object.assign(self, rect);
  const queue: GridBox[] = [self];
  for (let guard = 0; queue.length > 0 && guard < 10_000; guard += 1) {
    const pusher = queue.shift()!;
    for (const b of boxes) {
      if (b === pusher || b === self || !overlaps(pusher, b)) continue;
      if (b.locked) return { status: 'refused', changed: [], blockedBy: b.id, reason: 'locked' };
      b.y = pusher.y + pusher.h;
      // Pushed into the resized tile itself: below it instead.
      if (overlaps(self, b)) b.y = self.y + self.h;
      queue.push(b);
    }
  }
  const before = new Map(page.map((b) => [b.id, b]));
  const changed = boxes.filter((b) => {
    const was = before.get(b.id)!;
    return was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h;
  });
  return { status: 'ok', changed };
}

/**
 * Where a moved or resized tile lands, and what makes room for it.
 *
 * The grid never overlaps and never re-packs on its own. What it does:
 *   1. a band that exists only to hold filter controls (`band` rows the moved
 *      tile came from) closes when the last element leaves it — the page
 *      below moves up by its height, the drop target with it. Whitespace an
 *      author left anywhere else is never touched;
 *   2. a tile dropped (or grown) onto others OPENS room where it lands: every
 *      tile from the insertion row down moves down by the room needed. The
 *      insertion row is the top of whatever the tile would cover, so a control
 *      dropped on a chart row goes above that row, never into its middle.
 * A locked tile is never moved: an arrangement that would need to move one is
 * refused and names it.
 */
export function resolveDrop(
  page: GridBox[],
  movedId: number,
  rect: { x: number; y: number; w: number; h: number },
  opts: { from?: { y: number; h: number }; closeVacatedBand?: boolean } = {},
): DropResult {
  const others = page.filter((b) => b.id !== movedId).map((b) => ({ ...b }));
  const moved = page.find((b) => b.id === movedId);
  if (!moved) return { status: 'refused', changed: [] };
  let target = { ...rect };
  let closedRows = 0;

  // 1 · close the band the tile left, if it is now empty across the page.
  if (opts.closeVacatedBand && opts.from) {
    const { y: fy, h: fh } = opts.from;
    const stillThere = others.some((b) => b.y < fy + fh && b.y + b.h > fy);
    const landedInside = target.y < fy + fh && target.y + target.h > fy;
    if (!stillThere && !landedInside && fh > 0) {
      const below = others.filter((b) => b.y >= fy + fh);
      if (!below.some((b) => b.locked)) {
        for (const b of below) b.y -= fh;
        if (target.y >= fy + fh) target = { ...target, y: target.y - fh };
        closedRows = fh;
      }
    }
  }

  // 2 · open room where it lands.
  const overlapsTarget = (b: GridBox) => b.x < target.x + target.w && target.x < b.x + b.w
    && b.y < target.y + target.h && target.y < b.y + b.h;
  let hits = others.filter(overlapsTarget);
  if (hits.length > 0) {
    // The insertion row: the top of what the tile would cover (and of what it
    // then covers once moved up there), so it never lands inside a tile.
    let insertY = Math.min(target.y, ...hits.map((b) => b.y));
    for (let guard = 0; guard < 50; guard += 1) {
      const probe = { ...target, y: insertY };
      const higher = others.filter((b) => b.x < probe.x + probe.w && probe.x < b.x + b.w
        && b.y < probe.y + probe.h && probe.y < b.y + b.h && b.y < insertY);
      if (higher.length === 0) break;
      insertY = Math.min(...higher.map((b) => b.y));
    }
    target = { ...target, y: insertY };
    const pushed = others.filter((b) => b.y >= insertY);
    const locked = pushed.find((b) => b.locked);
    if (locked) return { status: 'refused', changed: [], blockedBy: locked.id, reason: 'locked' };
    for (const b of pushed) b.y += target.h;
    hits = others.filter(overlapsTarget);
    if (hits.length > 0) {
      // A tile starting above the insertion row still reaches into it (a tall
      // chart beside the drop point): the tile cannot go here.
      return { status: 'refused', changed: [], blockedBy: hits[0].id, reason: 'occupied' };
    }
  }

  const before = new Map(page.map((b) => [b.id, b]));
  const after = [...others, { ...moved, ...target }];
  const changed = after.filter((b) => {
    const was = before.get(b.id)!;
    return was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h;
  });
  return { status: 'ok', changed, ...(closedRows ? { closedRows } : {}) };
}

/**
 * The page a VIEWER sees when some filter controls draw nothing for them (a
 * field the link locks or hides, a slicer whose scope does not show it on this
 * page). Those cells are taken out and each band left empty closes — the same
 * rule as removing the control in the builder — so no blank strip remains.
 * A PROJECTION for rendering: the saved layout is never changed, and a band
 * above a locked tile stays open (a locked tile never moves).
 */
export function withoutAbsentControls(page: GridBox[], absentIds: ReadonlySet<number>): GridBox[] {
  let boxes = page.map((b) => ({ ...b }));
  const order = boxes.filter((b) => absentIds.has(b.id)).sort((a, b) => b.y - a.y);
  for (const gone of order) {
    const moved = new Map(closeVacatedBand(boxes, gone.id).map((b) => [b.id, b]));
    boxes = boxes.filter((b) => b.id !== gone.id).map((b) => moved.get(b.id) ?? b);
  }
  return boxes;
}

/**
 * Where a new element of `size` goes to sit WITH `targetId` (a control by the
 * chart it is read with):
 *   1. free space in the target's rows — right of it, then left of it — so
 *      nothing moves at all;
 *   2. otherwise directly above the target: the rows from there down move by
 *      its height, the same insert as dropping a tile there (resolveDrop).
 * null when that would move a locked tile. Pure; `changed` are the tiles that
 * moved, `rect` is the new element's cell.
 */
export function placeBeside(
  page: GridBox[],
  targetId: number,
  size: { w: number; h: number },
  cols: number = DASHBOARD_GRID_COLS,
): { rect: { x: number; y: number; w: number; h: number }; changed: GridBox[] } | null {
  const target = page.find((b) => b.id === targetId);
  if (!target) return null;
  const w = Math.min(size.w, cols);
  const free = (x: number) => {
    const r = { id: -1, x, y: target.y, w, h: size.h };
    return x >= 0 && x + w <= cols && !page.some((b) => overlaps(r, b));
  };
  for (let x = target.x + target.w; x + w <= cols; x += 1) if (free(x)) return { rect: { x, y: target.y, w, h: size.h }, changed: [] };
  for (let x = target.x - w; x >= 0; x -= 1) if (free(x)) return { rect: { x, y: target.y, w, h: size.h }, changed: [] };
  const NEW = -999_999;
  const bottom = page.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const drop = resolveDrop([...page, { id: NEW, x: 0, y: bottom, w, h: size.h }], NEW,
    { x: Math.min(target.x, cols - w), y: target.y, w, h: size.h });
  if (drop.status !== 'ok') return null;
  const placed = drop.changed.find((b) => b.id === NEW);
  if (!placed) return null;
  return { rect: { x: placed.x, y: placed.y, w, h: size.h }, changed: drop.changed.filter((b) => b.id !== NEW) };
}

/** Removing a tile from a filter band closes the band when it is now empty. */
export function closeVacatedBand(page: GridBox[], removedId: number): GridBox[] {
  const removed = page.find((b) => b.id === removedId);
  if (!removed) return [];
  const others = page.filter((b) => b.id !== removedId);
  const { y, h } = removed;
  if (others.some((b) => b.y < y + h && b.y + b.h > y)) return [];
  const below = others.filter((b) => b.y >= y + h);
  if (below.some((b) => b.locked)) return [];
  return below.map((b) => ({ ...b, y: b.y - h }));
}
