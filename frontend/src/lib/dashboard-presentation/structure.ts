/**
 * Targeted arrangement on the layout the author already built.
 *
 * The recomposing compiler (`compiler.ts`) answers "lay this page out from
 * scratch". Almost nobody asks that. They ask "put the KPIs on top" or "make
 * the trend bigger", and answering those by recomposing is how a request about
 * four tiles rewrites twenty. This module answers them as EDITS: each operation
 * moves only the visuals it names, then the rest of the page is disturbed only
 * as far as it must be — a tile is pushed down only if something now sits on
 * it, and lifted only into space the move just vacated above it.
 *
 * Three sets of tiles, and the difference is the whole contract:
 *   - moving   — named by an operation; given a new rectangle.
 *   - movable  — may step aside (pushed down / lifted) to make that possible.
 *   - fixed    — never touched: locked tiles, and, when the user selected
 *                visuals, everything outside the selection.
 * A moving tile that would land on a fixed one is routed below it instead; if
 * a resize cannot fit around a fixed tile it is shrunk back until it does.
 *
 * Pure and deterministic, like the compiler: same input, same output.
 */
import { DASHBOARD_GRID_COLS } from '@/lib/dashboard-pages';
import { MIN_TILE_H, MIN_TILE_W, MAX_TILE_H } from './capabilities';
import type { StructureOperation, VisualId } from './types';

export interface Rect { x: number; y: number; w: number; h: number }

const COLS = DASHBOARD_GRID_COLS;

export function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function clone(rects: Map<VisualId, Rect>): Map<VisualId, Rect> {
  return new Map(Array.from(rects.entries()).map(([id, r]) => [id, { ...r }]));
}

function byReadingOrder(rects: Map<VisualId, Rect>, ids: Iterable<VisualId>): VisualId[] {
  return Array.from(ids).filter((id) => rects.has(id)).sort((a, b) => {
    const ra = rects.get(a)!;
    const rb = rects.get(b)!;
    return ra.y - rb.y || ra.x - rb.x || a - b;
  });
}

function bottomOf(rects: Iterable<Rect>): number {
  let max = 0;
  for (const r of rects) max = Math.max(max, r.y + r.h);
  return max;
}

/** Lowest y at or below `fromY` where `rect` (at its x/w) clears every rect in
 *  `obstacles`. Terminates: each step jumps to the bottom of a blocker. */
function firstFreeY(rect: Rect, fromY: number, obstacles: Rect[]): number {
  let y = Math.max(0, fromY);
  for (let guard = 0; guard < 500; guard += 1) {
    const probe = { ...rect, y };
    const blocker = obstacles.find((o) => overlaps(probe, o));
    if (!blocker) return y;
    y = blocker.y + blocker.h;
  }
  return y;
}

export interface SettleInput {
  rects: Map<VisualId, Rect>;
  /** Tiles whose new rectangle must be honoured (placed first). */
  moved: Set<VisualId>;
  /** Tiles that may never change. */
  fixed: Set<VisualId>;
  /** Rectangles the moved tiles vacated — the only space others are lifted into. */
  vacated?: Rect[];
}

/**
 * Resolve collisions with the smallest disturbance.
 *
 *   1. fixed tiles keep their rectangles, full stop;
 *   2. a moved tile overlapping a fixed one is routed down below it;
 *   3. every other tile, in reading order, is pushed down only if it now
 *      overlaps something already settled;
 *   4. tiles directly below a vacated rectangle are lifted back up into it, but
 *      never further than the vacated height and never into another tile — so a
 *      move does not leave a hole, and a gap the author left elsewhere survives.
 */
export function settle(input: SettleInput): Map<VisualId, Rect> {
  const out = clone(input.rects);
  const settled: Rect[] = [];
  for (const id of input.fixed) {
    const r = out.get(id);
    if (r) settled.push(r);
  }

  for (const id of byReadingOrder(out, input.moved)) {
    if (input.fixed.has(id)) continue;
    const r = out.get(id)!;
    r.y = firstFreeY(r, r.y, settled);
    settled.push(r);
  }

  const others = byReadingOrder(
    out,
    Array.from(out.keys()).filter((id) => !input.fixed.has(id) && !input.moved.has(id)),
  );
  const originalY = new Map(others.map((id) => [id, out.get(id)!.y]));
  for (const id of others) {
    const r = out.get(id)!;
    r.y = firstFreeY(r, r.y, settled);
    settled.push(r);
  }

  // Lift into vacated space. A tile qualifies only if it sits below a vacated
  // rectangle that shares columns with it; the lift budget is that rectangle's
  // height, so unrelated tiles and intentional gaps are left exactly as they were.
  const vacated = input.vacated ?? [];
  if (vacated.length > 0) {
    for (const id of others) {
      const r = out.get(id)!;
      const budget = vacated
        .filter((v) => v.x < r.x + r.w && r.x < v.x + v.w && v.y + v.h <= (originalY.get(id) ?? r.y) + r.h && v.y < r.y + r.h)
        .reduce((sum, v) => sum + v.h, 0);
      if (budget <= 0) continue;
      const floor = Math.max(0, r.y - budget);
      const rest = Array.from(out.entries()).filter(([other]) => other !== id).map(([, rr]) => rr);
      let y = r.y;
      while (y - 1 >= floor && !rest.some((o) => overlaps({ ...r, y: y - 1 }, o))) y -= 1;
      r.y = y;
    }
  }
  return out;
}

export interface StructureResult {
  rects: Map<VisualId, Rect>;
  /** Operations that could not be carried out, and why, for the diff notes. */
  notes: string[];
}

function clampRect(r: Rect): Rect {
  const w = Math.max(MIN_TILE_W, Math.min(COLS, Math.round(r.w)));
  const x = Math.max(0, Math.min(COLS - w, Math.round(r.x)));
  const h = Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, Math.round(r.h)));
  return { x, y: Math.max(0, Math.round(r.y)), w, h };
}

/** Lay `ids` out left-to-right in rows starting at `y`, keeping each tile's own
 *  size, wrapping at the grid edge. Returns the rows' total height. */
function flowRow(rects: Map<VisualId, Rect>, ids: VisualId[], y: number): number {
  let x = 0;
  let rowY = y;
  let rowH = 0;
  for (const id of ids) {
    const r = rects.get(id)!;
    if (x + r.w > COLS && x > 0) { rowY += rowH; x = 0; rowH = 0; }
    r.x = x;
    r.y = rowY;
    x += r.w;
    rowH = Math.max(rowH, r.h);
  }
  return rowY + rowH - y;
}

/**
 * Apply targeted operations to the current layout.
 *
 * `fixed` must already contain every locked tile (and, under a selection,
 * every unselected tile). An operation naming a fixed tile skips that tile
 * with a note rather than failing the whole request.
 */
export function applyStructureOperations(
  current: Map<VisualId, Rect>,
  operations: StructureOperation[],
  fixed: Set<VisualId>,
): StructureResult {
  let rects = clone(current);
  const notes: string[] = [];

  for (const operation of operations) {
    const named = (operation.visuals ?? []).filter((id) => rects.has(id));
    const blocked = named.filter((id) => fixed.has(id));
    if (blocked.length > 0) {
      notes.push(`Kept ${blocked.length} locked or unselected visual(s) where they are.`);
    }
    const ids = named.filter((id) => !fixed.has(id));
    if (ids.length === 0) continue;

    const before = clone(rects);
    const moved = new Set<VisualId>(ids);
    const vacated = ids.map((id) => ({ ...before.get(id)! }));

    switch (operation.op) {
      case 'move_to_top': {
        const ordered = byReadingOrder(before, ids);
        const band = flowRow(rects, ordered, 0);
        // Everything that is not moving and not fixed shifts down by the band,
        // preserving the author's relative arrangement below it.
        for (const [id, r] of rects) {
          if (moved.has(id) || fixed.has(id)) continue;
          r.y += band;
        }
        rects = settle({ rects, moved, fixed, vacated });
        // A locked visual in the way can make "to the top" impossible — the
        // tile is routed below it and may end up where it started. Say so,
        // rather than report a move that did not happen.
        const blockedIds = ids.filter((id) => rects.get(id)!.y >= before.get(id)!.y);
        if (blockedIds.length > 0) {
          notes.push(`${blockedIds.length} visual(s) could not move above a locked visual, so they stayed below it.`);
        }
        break;
      }
      case 'move_to_bottom': {
        const rest = Array.from(rects.entries()).filter(([id]) => !moved.has(id)).map(([, r]) => r);
        flowRow(rects, byReadingOrder(before, ids), bottomOf(rest));
        rects = settle({ rects, moved, fixed, vacated });
        break;
      }
      case 'resize': {
        for (const id of ids) {
          const r = rects.get(id)!;
          const target = operation.size === 'full_width'
            ? { x: 0, y: r.y, w: COLS, h: Math.round(r.h * 1.1) }
            : operation.size === 'smaller'
              ? { x: r.x, y: r.y, w: r.w * 0.67, h: r.h * 0.8 }
              : { x: r.x, y: r.y, w: r.w * 1.5, h: r.h * 1.25 };
          let next = clampRect(target);
          // A growing tile keeps its left edge unless that would push it off
          // the grid, in which case it grows leftward instead.
          if (next.x + next.w > COLS) next.x = COLS - next.w;
          // Never grow into a fixed tile: shrink the growth back until it clears.
          const fixedRects = Array.from(fixed).map((f) => rects.get(f)).filter(Boolean) as Rect[];
          let guard = 0;
          while (fixedRects.some((f) => overlaps(next, f)) && guard < 40) {
            guard += 1;
            if (next.w > r.w) next = { ...next, w: next.w - 1, x: Math.min(next.x, r.x) };
            else if (next.h > r.h) next = { ...next, h: next.h - 1 };
            else break;
          }
          if (fixedRects.some((f) => overlaps(next, f))) {
            notes.push(`Visual ${id} could not grow without covering a locked visual; its size was kept.`);
            next = { ...r };
          }
          rects.set(id, next);
        }
        rects = settle({ rects, moved, fixed, vacated });
        break;
      }
      case 'swap': {
        if (ids.length !== 2) {
          notes.push('A swap needs exactly two movable visuals; it was skipped.');
          break;
        }
        const [a, b] = ids;
        const ra = { ...before.get(a)! };
        const rb = { ...before.get(b)! };
        rects.set(a, rb);
        rects.set(b, ra);
        rects = settle({ rects, moved, fixed });
        break;
      }
      case 'arrange_row': {
        const ordered = byReadingOrder(before, ids);
        const top = Math.min(...ordered.map((id) => before.get(id)!.y));
        const height = Math.max(...ordered.map((id) => before.get(id)!.h));
        const perRow = Math.min(4, ordered.length);
        const base = Math.floor(COLS / perRow);
        const remainder = COLS - base * perRow;
        ordered.forEach((id, index) => {
          const col = index % perRow;
          const row = Math.floor(index / perRow);
          const w = base + (col < remainder ? 1 : 0);
          const x = col * base + Math.min(col, remainder);
          rects.set(id, { x, y: top + row * height, w, h: height });
        });
        rects = settle({ rects, moved, fixed, vacated });
        break;
      }
      default:
        notes.push(`Unknown arrangement "${String((operation as any).op)}" was skipped.`);
    }
  }
  return { rects, notes };
}

/** Route non-fixed tiles clear of fixed ones after a recomposition, moving the
 *  compiled tiles as little as possible (downward only). */
export function avoidFixed(
  rects: Map<VisualId, Rect>,
  fixed: Set<VisualId>,
): Map<VisualId, Rect> {
  return settle({ rects, moved: new Set(), fixed });
}
