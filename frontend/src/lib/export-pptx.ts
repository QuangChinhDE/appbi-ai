/**
 * Editable PowerPoint export (user feedback: "chuyển định dạng editable … để
 * khách chủ động chỉnh sửa báo cáo sếp").
 *
 * The browser reads what the reader actually sees on each page — KPI label and
 * formatted value, table cells, text, and a picture of every chart exactly as
 * rendered — and the backend lays it out as one slide per page
 * (services/report_pptx_service.py). Sending the rendered content (not asking
 * the server to re-query) is what guarantees the deck shows the same numbers as
 * the screen, under the same filters.
 *
 * Editable: titles, KPI label/value, text, table cells, every block's position
 * and size. Charts are high-resolution PICTURES (not native PowerPoint charts) —
 * the dialog says so.
 */
import html2canvas from 'html2canvas-pro';

import { waitForRenderReady } from '@/lib/export-pdf';

export interface PptxTilePayload {
  kind: 'kpi' | 'chart' | 'table' | 'text';
  x: number; y: number; w: number; h: number;
  title?: string | null;
  value?: string | null;
  text?: string | null;
  columns?: string[];
  rows?: string[][];
  total_rows?: number;
  image?: string | null;
}

export interface PptxPageSource {
  name: string;
  /** Tiles on this page: the dashboard_chart id, its authored layout, and kind hints. */
  tiles: Array<{
    id: number;
    layout: { x: number; y: number; w: number; h: number };
    chartType?: string | null;
    widgetType?: string | null;
    title?: string | null;
  }>;
  /** Show the page and resolve its rendered root once its tiles are mounted. */
  getRoot: () => Promise<HTMLElement | null>;
}

export interface PptxExportOptions {
  title: string;
  subtitle?: string | null;
  footer?: string | null;
  gridCols: number;
  pages: PptxPageSource[];
  /** POST the payload; resolves with the .pptx blob. */
  send: (payload: unknown) => Promise<Blob>;
  filename: string;
  onProgress?: (ratio: number, message: string) => void;
}

const MAX_TABLE_ROWS = 25;
const TABLE_LIKE = /^(TABLE|PIVOT|MATRIX)/i;
const KPI_LIKE = /KPI|CARD|GAUGE/i;

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function readTable(tile: HTMLElement): Pick<PptxTilePayload, 'columns' | 'rows' | 'total_rows'> | null {
  const table = tile.querySelector('table');
  if (!table) return null;
  const columns = Array.from(table.querySelectorAll('thead th')).map((th) => {
    const label = th.querySelector('span[title]');
    return textOf(label ?? th);
  });
  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  const rows = bodyRows.slice(0, MAX_TABLE_ROWS).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => textOf(td)));
  return { columns, rows, total_rows: bodyRows.length };
}

async function captureChart(tile: HTMLElement): Promise<string | null> {
  try {
    const canvas = await html2canvas(tile, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      // The title is its own editable text box on the slide; hide it (and the
      // hover/status chrome) in the picture so it is not printed twice.
      onclone: (_doc, el) => {
        el.querySelectorAll<HTMLElement>('[data-pdf-tile-title], [data-testid="tile-cached-as-of"], button')
          .forEach((n) => { n.style.visibility = 'hidden'; });
      },
    });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function tileElement(root: HTMLElement, id: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-grid-item-id="${id}"]`);
}

export async function exportDashboardPptx(opts: PptxExportOptions): Promise<void> {
  const pages: Array<{ name: string; width: number; tiles: PptxTilePayload[] }> = [];
  for (let i = 0; i < opts.pages.length; i++) {
    const page = opts.pages[i];
    opts.onProgress?.(0.05 + 0.8 * (i / Math.max(1, opts.pages.length)), page.name);
    const root = await page.getRoot();
    if (!root) { pages.push({ name: page.name, width: 1, tiles: [] }); continue; }
    await waitForRenderReady(root);
    const rootRect = root.getBoundingClientRect();
    const tiles: PptxTilePayload[] = [];
    for (const t of page.tiles) {
      const el = tileElement(root, t.id);
      if (!el) continue;
      // The tile AS RENDERED (px, relative to the page): the slide keeps its
      // shape with one uniform scale, so pictures fill their blocks.
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const geom = { x: r.left - rootRect.left, y: r.top - rootRect.top, w: r.width, h: r.height };
      const title = textOf(el?.querySelector('[data-pdf-tile-title]')) || t.title || null;
      const type = String(t.chartType ?? '');
      if (t.widgetType && t.widgetType !== 'chart') {
        // Report elements (heading, text, insight, header): their words.
        const text = textOf(el);
        if (text) tiles.push({ kind: 'text', ...geom, title: null, text });
        continue;
      }
      if (KPI_LIKE.test(type) && el.querySelector('.dashboard-kpi-value')) {
        tiles.push({ kind: 'kpi', ...geom, title, value: textOf(el.querySelector('.dashboard-kpi-value')) });
        continue;
      }
      if (TABLE_LIKE.test(type)) {
        const table = readTable(el);
        if (table) { tiles.push({ kind: 'table', ...geom, title, ...table }); continue; }
      }
      tiles.push({ kind: 'chart', ...geom, title, image: await captureChart(el) });
    }
    pages.push({ name: page.name, width: Math.max(1, rootRect.width), tiles });
  }
  opts.onProgress?.(0.9, '');
  const blob = await opts.send({
    title: opts.title,
    subtitle: opts.subtitle ?? null,
    footer: opts.footer ?? null,
    pages,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  opts.onProgress?.(1, '');
}
