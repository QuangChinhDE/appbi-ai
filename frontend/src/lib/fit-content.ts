/**
 * Fit an element's height to what it says.
 *
 * A text block, a note, an insight or a report header has a natural height —
 * the height its words take at the tile's current width. Measured on the
 * rendered tile (same fonts, same width, same theme), converted to whole grid
 * rows, and committed like any resize. The measurement lets the tile's own
 * content decide its height for one synchronous layout read, then restores it:
 * nothing is painted in between.
 */

/** Widgets whose height is decided by their content. */
export const FIT_TO_CONTENT_TYPES = new Set(['text', 'callout', 'narrative', 'hero_strip', 'section_header', 'html_fragment']);

export function measureNaturalHeight(tile: HTMLElement): number {
  const prevHeight = tile.style.height;
  const prevOverflow = tile.style.overflow;
  tile.style.height = 'auto';
  tile.style.overflow = 'visible';
  const px = Math.ceil(tile.getBoundingClientRect().height);
  tile.style.height = prevHeight;
  tile.style.overflow = prevOverflow;
  return px;
}

/** Grid rows holding `px` (react-grid-layout: h rows = h·rowHeight + (h−1)·gap). */
export function rowsForHeight(px: number, rowHeight: number, gapY: number, minRows = 1): number {
  return Math.max(minRows, Math.ceil((px + gapY) / (rowHeight + gapY)));
}
