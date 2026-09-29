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
 * refused and names it. Pure; the page commits the result like a drag (one
 * undo step, a draft change).
 */
import { resolveDrop, type ArrangeResult, type GridBox } from './grid-arrange';

export type LayoutPattern = 'equalRow' | 'kpiStrip' | 'leadSupport';
export const LAYOUT_PATTERNS: LayoutPattern[] = ['equalRow', 'kpiStrip', 'leadSupport'];

const MIN_W = 3;
const MIN_H = 3;

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
  // in its own span: it takes the page width.
  if (span < selected.length * MIN_W * (pattern === 'leadSupport' ? 1.5 : 1)) { x0 = 0; span = cols; }

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
  const moved = [
    ...placed.map((b) => ({ ...b, y: b.y + shift })),
    ...drop.changed.filter((b) => b.id !== GROUP),
  ].filter((b) => {
    const was = byId.get(b.id)!;
    return was.x !== b.x || was.y !== b.y || was.w !== b.w || was.h !== b.h;
  });
  if (moved.length === 0) return { status: 'noop', skippedLocked: 0 };
  return { status: 'ok', moved, skippedLocked: 0 };
}
