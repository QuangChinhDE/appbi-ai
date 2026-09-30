/**
 * Where the grid DRAWS a stored layout.
 *
 * react-grid-layout never lets tiles overlap unless told to: a stored layout
 * whose cells overlap (an old 12-column tile beside a newer one, a layout made
 * before cells were checked) is settled on render — each tile, in the order
 * given, moves down below the first earlier tile it collides with. That is what
 * the public report and the embed show.
 *
 * The builder lets a tile be carried over others while it is being dragged
 * (allowOverlap), which also switched that settling off: the same report then
 * drew overlapping tiles for the author and settled ones for its viewers. The
 * builder settles the stored layout here, with the library's own functions, so
 * both draw the same page, and the drop rules (lib/grid-arrange) work on what
 * the author sees.
 */
import * as RGL from 'react-grid-layout';

interface Cell { i: string; x: number; y: number; w: number; h: number; static?: boolean }
interface RglUtils {
  correctBounds: (layout: Cell[], bounds: { cols: number }) => Cell[];
  compact: (layout: Cell[], compactType: null, cols: number, allowOverlap: boolean) => Cell[];
}
const utils = (RGL as unknown as { utils: RglUtils }).utils;

export function settleStoredLayout<T extends Cell>(items: T[], cols: number): T[] {
  if (items.length < 2) return items;
  const settled = utils.compact(utils.correctBounds(items.map((l) => ({ ...l })), { cols }), null, cols, false);
  let changed = false;
  const out = items.map((l, idx) => {
    const s = settled[idx];
    if (!s || (s.x === l.x && s.y === l.y && s.w === l.w && s.h === l.h)) return l;
    changed = true;
    return { ...l, x: s.x, y: s.y, w: s.w, h: s.h };
  });
  return changed ? out : items;
}
