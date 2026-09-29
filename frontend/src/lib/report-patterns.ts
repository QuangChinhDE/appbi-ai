/**
 * Layout patterns an author applies to a selection in one step — the rows a
 * report is actually built from:
 *
 *   equalRow     side by side, equal widths, one height (the tallest)
 *   kpiStrip     side by side, equal widths, one compact height (the shortest)
 *   leadSupport  the lead takes two thirds, the rest stack beside it
 *
 * The selection keeps the columns it spans and the row it starts on. It is
 * placed as one block with the grid's single placement rule (resolveDrop): what
 * the block would cover moves down to make room, whitespace elsewhere is left
 * alone, and a locked tile is never moved — a pattern that needs to move one is
 * refused and names it. Rows the selection itself leaves empty (it came from
 * further down the page) close up, so a pattern never leaves a hole behind.
 * Pure; the page commits the result like a drag (one undo step, a draft change).
 */
import { resolveDrop, type ArrangeResult, type GridBox } from './grid-arrange';

export type LayoutPattern = 'equalRow' | 'kpiStrip' | 'leadSupport';
export const LAYOUT_PATTERNS: LayoutPattern[] = ['equalRow', 'kpiStrip', 'leadSupport'];

const MIN_W = 3;
const MIN_H = 3;
// The narrowest a tile in a pattern reads well at (a KPI card, a small chart).
const READABLE_W = 8;

/**
 * Close every row a selected tile covered before that nothing covers now: the
 * tiles below move up. A row stays open when a locked tile would have to move.
 */
function closeVacatedRows(after: Map<number, GridBox>, selectedBefore: GridBox[]): void {
  const covered = (row: number) => [...after.values()].some((b) => b.y <= row && row < b.y + b.h);
  const rows = new Set<number>();
  for (const b of selectedBefore) for (let r = b.y; r < b.y + b.h; r += 1) rows.add(r);
  // Bottom-up, one row at a time, each measured on the page as it now is.
  for (const row of [...rows].sort((a, b) => b - a)) {
    if (covered(row)) continue;
    const below = [...after.values()].filter((b) => b.y > row);
    if (below.length === 0 || below.some((b) => b.locked)) continue;
    for (const b of below) after.set(b.id, { ...b, y: b.y - 1 });
  }
}

function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * @param leadId the tile that leads in `leadSupport` (the one the author marked
 *               lead, else the first selected); ignored by the row patterns.
 */
export function applyLayoutPattern(
  pattern: LayoutPattern,
  page: GridBox[],
  selectedIds: number[],
  opts: { leadId?: number | null; cols?: number } = {},
): ArrangeResult {
  const cols = opts.cols ?? 36;
  const byId = new Map(page.map((b) => [b.id, b]));
  const selected = selectedIds.map((id) => byId.get(id)).filter((b): b is GridBox => Boolean(b));
  if (selected.length < 2) return { status: 'noop', skippedLocked: 0 };
  const locked = selected.find((b) => b.locked);
  if (locked) return { status: 'blocked', blockedBy: locked.id };

  const ordered = [...selected].sort((a, b) => a.y - b.y || a.x - b.x);
  const y0 = ordered[0].y;
  let x0 = Math.min(...selected.map((b) => b.x));
  let span = Math.max(...selected.map((b) => b.x + b.w)) - x0;
  // A selection stacked in one narrow column has no room to sit side by side
  // in its own span, and a selection alone in its rows (nothing else sits
  // beside it) is a row of the page: both take the page width. A selection
  // sharing its rows with other elements keeps its columns.
  const top = y0;
  const bottom = Math.max(...selected.map((b) => b.y + b.h));
  const ids0 = new Set(selected.map((b) => b.id));
  const aloneInRows = !page.some((b) => !ids0.has(b.id) && b.y < bottom && b.y + b.h > top);
  if (span < selected.length * READABLE_W || aloneInRows) { x0 = 0; span = cols; }

  let placed: GridBox[];
  let blockH: number;
  if (pattern === 'leadSupport') {
    const lead = (opts.leadId != null ? selected.find((b) => b.id === opts.leadId) : undefined) ?? ordered[0];
    const rest = ordered.filter((b) => b.id !== lead.id);
    const leadW = Math.max(MIN_W, Math.round((span * 2) / 3));
    const sideW = span - leadW;
    blockH = Math.max(lead.h, rest.length * MIN_H);
    const hs = split(blockH, rest.length);
    let y = y0;
    placed = [
      { ...lead, x: x0, y: y0, w: leadW, h: blockH },
      ...rest.map((b, i) => { const box = { ...b, x: x0 + leadW, y, w: sideW, h: hs[i] }; y += hs[i]; return box; }),
    ];
  } else {
    const row = [...selected].sort((a, b) => a.x - b.x || a.y - b.y);
    const ws = split(span, row.length);
    blockH = Math.max(MIN_H, pattern === 'kpiStrip' ? Math.min(...row.map((b) => b.h)) : Math.max(...row.map((b) => b.h)));
    let x = x0;
    placed = row.map((b, i) => { const box = { ...b, x, y: y0, w: ws[i], h: blockH }; x += ws[i]; return box; });
  }

  const GROUP = -515_151;
  const ids = new Set(selected.map((b) => b.id));
  const rest = page.filter((b) => !ids.has(b.id));
  const drop = resolveDrop([...rest, { id: GROUP, x: x0, y: y0, w: span, h: blockH }], GROUP, { x: x0, y: y0, w: span, h: blockH });
  if (drop.status !== 'ok') return { status: 'blocked', blockedBy: drop.blockedBy ?? selected[0].id };
  const landed = drop.changed.find((b) => b.id === GROUP);
  const shift = landed ? landed.y - y0 : 0;
  const after = new Map<number, GridBox>(rest.map((b) => [b.id, { ...b }]));
  for (const b of drop.changed.filter((c) => c.id !== GROUP)) after.set(b.id, { ...b });
  for (const b of placed) after.set(b.id, { ...b, y: b.y + shift });
  closeVacatedRows(after, selected);
  const moved = [...after.values()].filter((b) => {
    const was = byId.get(b.id)!;
    return was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h;
  });
  if (moved.length === 0) return { status: 'noop', skippedLocked: 0 };
  return { status: 'ok', moved, skippedLocked: 0 };
}
