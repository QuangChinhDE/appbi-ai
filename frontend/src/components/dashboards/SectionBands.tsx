'use client';

import React from 'react';
import type { Layout } from 'react-grid-layout';

/**
 * The surface behind a group of tiles — shared by the builder grid and the
 * published report.
 *
 * A report with only ONE surface depth — page under card — reads as a bag of
 * loose tiles however well each tile is styled, because grouping is a surface,
 * not a border on each member. A `section_header` widget opens a band, the band
 * runs until the next header, and every tile in between sits on it. Combined
 * with flush/subtle tile frames this is how a section reads as one panel
 * instead of a row of cards.
 *
 * This used to live only inside the builder grid, so the published report never
 * drew it: the same dashboard grouped visually while editing and fell apart when
 * shared. One component, rendered by both.
 *
 * Drawn as a backdrop layer rather than as a real container because
 * react-grid-layout positions children absolutely from the layout array — a
 * wrapper element would have to become a grid item. The geometry is the
 * library's own:
 *
 *   colWidth = (W - mx*(cols+1)) / cols
 *   x_px     = colWidth*x + (x+1)*mx        w_px = w*colWidth + (w-1)*mx
 *   y_px     = rowH*y     + (y+1)*my        h_px = h*rowH     + (h-1)*my
 */
export function SectionBands({
  layouts, dashboardCharts, cols, rowH, margin, width,
}: {
  layouts: Array<Pick<Layout, 'i' | 'x' | 'y' | 'w' | 'h'>>;
  dashboardCharts: Array<{ id: number; widget_type?: string | null }>;
  cols: number;
  rowH: number;
  margin: [number, number];
  width: number;
}) {
  const bands = React.useMemo(() => {
    if (!width || cols <= 1) return [];
    const [mx, my] = margin;
    const typeById = new Map<string, string>(
      dashboardCharts.map((dc) => [String(dc.id), String(dc.widget_type ?? 'chart')]),
    );
    const sorted = [...layouts].sort((a, b) => a.y - b.y || a.x - b.x);
    const headers = sorted.filter((l) => typeById.get(l.i) === 'section_header');
    if (!headers.length) return [];

    const colWidth = (width - mx * (cols + 1)) / cols;
    const out: { key: string; left: number; top: number; width: number; height: number }[] = [];

    headers.forEach((header, idx) => {
      const next = headers[idx + 1];
      const members = sorted.filter((l) => l.y >= header.y && (next ? l.y < next.y : true));
      if (members.length < 2) return; // a header with nothing under it is not a group

      const minX = Math.min(...members.map((l) => l.x));
      const maxX = Math.max(...members.map((l) => l.x + l.w));
      const minY = Math.min(...members.map((l) => l.y));
      const maxY = Math.max(...members.map((l) => l.y + l.h));

      const left = colWidth * minX + (minX + 1) * mx;
      const right = colWidth * maxX + maxX * mx;
      const top = rowH * minY + (minY + 1) * my;
      const bottom = rowH * maxY + maxY * my;
      out.push({
        key: header.i,
        left: left - mx / 2,
        top: top - my / 2,
        width: (right - left) + mx,
        height: (bottom - top) + my,
      });
    });
    return out;
  }, [layouts, dashboardCharts, cols, rowH, margin, width]);

  if (!bands.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true" data-section-bands>
      {bands.map((b) => (
        <div
          key={b.key}
          className="dashboard-section-band absolute"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
        />
      ))}
    </div>
  );
}
