/**
 * The report as paper: horizontal bands that can each move to the next sheet
 * whole.
 *
 * A band is every tile whose rows overlap, transitively — so a tall chart with a
 * column of two tiles beside it (a "hero with rail") is ONE band, printed as it
 * is arranged, instead of being cut into rows by identical `y` (which put the
 * rail's second tile on a row of its own, under the wrong column). Inside a band
 * each tile keeps its column and its offset from the band's top; the band is a
 * normal block, so `break-inside: avoid` holds it together on one sheet.
 *
 * A band that is only a section heading is kept with what follows it
 * (`keepWithNext`), so a heading never ends a sheet with its section on the next.
 */
export interface PrintTile { id: number; x: number; y: number; w: number; h: number; kind?: string }

export interface PrintBand<T extends PrintTile> {
  /** First row of the band (grid rows). */
  top: number;
  /** Height in grid rows. */
  rows: number;
  tiles: T[];
  keepWithNext: boolean;
}

export function groupIntoPrintBands<T extends PrintTile>(tiles: T[]): PrintBand<T>[] {
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands: PrintBand<T>[] = [];
  let current: { top: number; bottom: number; tiles: T[] } | null = null;
  for (const t of sorted) {
    if (current && t.y < current.bottom) {
      current.tiles.push(t);
      current.bottom = Math.max(current.bottom, t.y + t.h);
      continue;
    }
    if (current) bands.push(close(current));
    current = { top: t.y, bottom: t.y + t.h, tiles: [t] };
  }
  if (current) bands.push(close(current));
  return bands;
}

function close<T extends PrintTile>(b: { top: number; bottom: number; tiles: T[] }): PrintBand<T> {
  return {
    top: b.top,
    rows: b.bottom - b.top,
    tiles: [...b.tiles].sort((a, c) => a.y - c.y || a.x - c.x),
    keepWithNext: b.tiles.length > 0 && b.tiles.every((t) => t.kind === 'section_header'),
  };
}
