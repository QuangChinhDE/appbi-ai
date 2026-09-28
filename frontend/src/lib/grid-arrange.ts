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
