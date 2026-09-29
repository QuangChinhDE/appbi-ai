'use client';

/**
 * Content-aware heights for the DERIVED layouts (tablet, phone).
 *
 * Desktop geometry is the author's and is never changed here. But a tablet or
 * phone layout is derived from it, and a height that was right across a wide
 * row is wrong once words re-wrap in a column: a report header's split aside
 * stacks under its title and needs more height (it was cut off), while a KPI
 * authored tall beside a chart becomes a full-width card with a band of empty
 * space under its figure. So on those widths, elements whose height is decided
 * by what they say — text-like widgets and KPI cards — are measured as
 * rendered (fonts, width, theme) and their derived cell is set to that height,
 * in whole rows. Charts and tables keep their derived height: they have no
 * natural height, they fill what they are given.
 *
 * `stack` (phone, one column in reading order): rows are re-laid top to
 *   bottom; items that share a row (a 2-up KPI pair) take the taller.
 * `grow` (tablet): an element only ever grows, pushing everything below it
 *   down by the same amount — no overlap can appear.
 *
 * Never persisted: this is a projection of the saved layout, like the rest of
 * the responsive derivation (lib/dashboard-pages).
 */
import React from 'react';

import { measureNaturalHeight, rowsForHeight } from './fit-content';

export type FitMode = 'stack' | 'grow';

export function fitLayoutToContent<T extends { i: string; x: number; y: number; w: number; h: number }>(
  layout: T[],
  measuredRows: Record<string, number> | undefined,
  mode: FitMode,
): T[] {
  if (!measuredRows || Object.keys(measuredRows).length === 0 || layout.length === 0) return layout;
  const want = (item: T) => {
    const m = measuredRows[item.i];
    return Number.isFinite(m) && m > 0 ? m : item.h;
  };
  if (mode === 'stack') {
    const rows = new Map<number, T[]>();
    for (const item of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const list = rows.get(item.y) ?? [];
      list.push(item);
      rows.set(item.y, list);
    }
    const out: T[] = [];
    let cursor = 0;
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const items = rows.get(y)!;
      const h = Math.max(...items.map(want));
      for (const item of items) out.push({ ...item, y: cursor, h });
      cursor += h;
    }
    return out;
  }
  // grow: top to bottom, each growth pushes everything that starts below the
  // element's (current) bottom down by the growth.
  const items = layout.map((it) => ({ ...it }));
  const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of order) {
    const grow = want(item) - item.h;
    if (grow <= 0) continue;
    const bottom = item.y + item.h;
    for (const other of items) if (other !== item && other.y >= bottom) other.y += grow;
    item.h += grow;
  }
  return items;
}

/** Elements whose height is decided by their content. */
const CONTENT_SELECTOR = [
  '[data-widget-type="hero_strip"]', '[data-widget-type="section_header"]', '[data-widget-type="text"]',
  '[data-widget-type="callout"]', '[data-widget-type="narrative"]', '[data-tile-kind="kpi"]',
].join(', ');

/**
 * Measure the content-decided elements under `root` at the current width, as
 * whole grid rows. Re-measures when `deps` change and shortly after (charts
 * arriving change KPI context lines), and settles: a change of one row or less
 * is ignored, so a measure → relayout → measure cycle cannot oscillate.
 */
export function useMeasuredContentRows(
  root: React.RefObject<HTMLElement | null>,
  opts: { enabled: boolean; rowHeight: number; gapY: number; minRows?: (el: HTMLElement) => number },
  deps: React.DependencyList,
): Record<string, number> {
  const [rows, setRows] = React.useState<Record<string, number>>({});
  const { enabled, rowHeight, gapY, minRows } = opts;
  React.useEffect(() => {
    if (!enabled) { setRows((prev) => (Object.keys(prev).length ? {} : prev)); return; }
    let cancelled = false;
    const measure = () => {
      const el = root.current;
      if (!el || cancelled) return;
      const next: Record<string, number> = {};
      for (const item of Array.from(el.querySelectorAll<HTMLElement>('[data-grid-item-id]'))) {
        const tile = item.querySelector<HTMLElement>(CONTENT_SELECTOR);
        if (!tile) continue;
        const id = item.getAttribute('data-grid-item-id');
        if (!id) continue;
        const px = measureNaturalHeight(tile);
        if (!(px > 0)) continue;
        next[id] = Math.max(minRows ? minRows(tile) : 1, rowsForHeight(px, rowHeight, gapY));
      }
      setRows((prev) => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        let changed = false;
        for (const k of keys) {
          const a = prev[k]; const b = next[k];
          // Growing is always applied (a row short is content cut off); only a
          // shrink of one row is ignored, which is what stops a measure ->
          // relayout -> measure cycle from oscillating.
          if (a === undefined || b === undefined || b > a || a - b > 1) { changed = true; break; }
        }
        return changed ? next : prev;
      });
    };
    let debounce: number | null = null;
    const schedule = () => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(measure, 150);
    };
    const t1 = window.setTimeout(measure, 120);
    const t2 = window.setTimeout(measure, 1200);
    const t3 = window.setTimeout(measure, 3500);
    // Content that changes after the first measure (a header's headline that
    // arrives with the data, a KPI's context line) is measured again. Its
    // BOX does not change (it fills its cell), so a size observer never sees
    // it: the text itself changing is the signal (debounced).
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && root.current) {
      mo = new MutationObserver(schedule);
      for (const item of Array.from(root.current.querySelectorAll<HTMLElement>('[data-grid-item-id]'))) {
        const tile = item.querySelector<HTMLElement>(CONTENT_SELECTOR);
        if (tile) mo.observe(tile, { childList: true, subtree: true, characterData: true });
      }
    }
    return () => {
      cancelled = true;
      window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3);
      if (debounce != null) window.clearTimeout(debounce);
      mo?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rowHeight, gapY, ...deps]);
  return rows;
}
