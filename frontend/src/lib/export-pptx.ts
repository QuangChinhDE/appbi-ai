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
 *
 * What a deck never contains (product contract 2026-10):
 *  - a chart captured before it was drawn: every chart tile must reach a final
 *    state (lib/render-ready tileReadiness) and its picture must carry ink in the
 *    plot area; one retry, then the export FAILS naming the charts — a deck with
 *    an empty card where a chart belongs is never handed over as a success;
 *  - report CONTROLS (slicers, parameter switchers): a deck is a presentation,
 *    not a form. The filters still shape every number; only the control goes,
 *    and the band it leaves is closed (export-only, nothing is saved);
 *  - editor and status chrome (`data-export-hide`): the author's filter
 *    diagnostic, the "as of" badge, hover actions, drill controls.
 */
import html2canvas from 'html2canvas-pro';

import { tileReadiness, waitForRenderReady, type TileReadiness } from '@/lib/render-ready';
import { isSlicerControl } from '@/lib/slicer-placement';

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
  /** Show the page (its tiles mounted and loading); resolve its rendered root. */
  getRoot: () => Promise<HTMLElement | null>;
}

export interface PptxProgressLabels {
  /** "Đang chuẩn bị trang 1/3…" */
  page: (index: number, total: number) => string;
  /** "Đang dựng biểu đồ 4/8…" */
  chart: (index: number, total: number) => string;
  /** "Đang tạo PowerPoint…" */
  building: string;
}

export interface PptxExportOptions {
  title: string;
  subtitle?: string | null;
  footer?: string | null;
  /** Overrides of the export's time budget (tests); defaults are the exported caps. */
  budget?: { captureMs?: number; sendMs?: number };
  gridCols: number;
  pages: PptxPageSource[];
  /** POST the payload; resolves with the .pptx blob. */
  send: (payload: unknown) => Promise<Blob>;
  filename: string;
  onProgress?: (ratio: number, message: string) => void;
  labels?: PptxProgressLabels;
}

/** Some charts could not be rendered: no deck was made. */
export class PptxIncompleteError extends Error {
  constructor(public readonly charts: string[]) {
    super(`PowerPoint export stopped: ${charts.length} chart(s) could not be rendered — ${charts.join(', ')}`);
    this.name = 'PptxIncompleteError';
  }
}

/** The server did not answer within PPTX_SEND_TIMEOUT_MS: no deck was made. */
export class PptxTimeoutError extends Error {
  constructor(public readonly afterMs: number) {
    super(`PowerPoint export stopped: the deck was not built within ${Math.round(afterMs / 1000)} s`);
    this.name = 'PptxTimeoutError';
  }
}

const MAX_TABLE_ROWS = 25;
const TABLE_LIKE = /^(TABLE|PIVOT|MATRIX)/i;
const KPI_LIKE = /KPI|CARD|GAUGE/i;
/** Widget types that are report CONTROLS, not content (canonical identity). */
const CONTROL_WIDGET_TYPES = new Set(['parameter_switcher']);
/** A healthy page is ready long before this; a stuck one fails loudly after it. */
const PAGE_READY_TIMEOUT_MS = 30_000;
const TILE_RETRY_TIMEOUT_MS = 15_000;
const TILES_MOUNT_TIMEOUT_MS = 15_000;
/** TOTAL wall-clock budget for capturing every page. The per-step timeouts above
 *  are each shrunk to what is left of it, so N pages x M charts can never add
 *  up to an unbounded wait: at the deadline every chart not yet drawn is
 *  reported (PptxIncompleteError) and no deck is made. */
export const PPTX_CAPTURE_BUDGET_MS = 180_000;
/** The server builds the deck; past this the export fails loudly. */
export const PPTX_SEND_TIMEOUT_MS = 60_000;
/** Longest an export can take from click to download or error toast (plus the
 *  html2canvas work of the last captures). e2e/tests/dashboard-pptx-export.spec.ts
 *  mirrors this value; frontend/scripts/check-pptx-export-contract.mjs keeps them equal. */
export const PPTX_EXPORT_MAX_MS = PPTX_CAPTURE_BUDGET_MS + PPTX_SEND_TIMEOUT_MS;
/** Share of plot-area pixels that differ from the card background: a frame,
 *  a hidden title or a hidden badge leave ~0; any drawn mark is far above this. */
export const MIN_PLOT_INK = 0.0008;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isExportControl(tile: { id?: number; widgetType?: string | null }): boolean {
  return isSlicerControl({ id: tile.id ?? 0, widget_type: tile.widgetType ?? null })
    || CONTROL_WIDGET_TYPES.has(String(tile.widgetType ?? ''));
}

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

/** Plot-area ink of a captured chart (see MIN_PLOT_INK). */
export function plotInk(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width < 8 || canvas.height < 8) return 0;
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);
  const at = (x: number, y: number) => (Math.floor(y) * w + Math.floor(x)) * 4;
  const mx = Math.max(6, Math.floor(Math.min(w, h) * 0.04));
  const r0 = at(mx, h * 0.5);
  const ref = [data[r0], data[r0 + 1], data[r0 + 2]];
  const x0 = mx; const x1 = w - mx; const y0 = Math.max(mx, Math.floor(h * 0.2)); const y1 = h - mx;
  let ink = 0; let total = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = at(x, y);
      total += 1;
      if (Math.max(Math.abs(data[i] - ref[0]), Math.abs(data[i + 1] - ref[1]), Math.abs(data[i + 2] - ref[2])) > 40) ink += 1;
    }
  }
  return total ? ink / total : 0;
}

/** Picture of one chart tile with its title (an editable text box on the slide)
 *  and every export-hidden element removed; null when it shows no chart. */
async function captureChart(tile: HTMLElement, state: TileReadiness): Promise<string | null> {
  try {
    const canvas = await html2canvas(tile, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      onclone: (_doc, el) => {
        el.querySelectorAll<HTMLElement>('[data-pdf-tile-title], [data-export-hide], button')
          .forEach((n) => { n.style.visibility = 'hidden'; });
      },
    });
    // A chart that HAS rows must show them; an empty / failed chart shows its
    // own message, which is what the reader sees.
    if (state === 'ready-visual' && plotInk(canvas) < MIN_PLOT_INK) return null;
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

async function waitForTile(tile: HTMLElement, timeoutMs: number): Promise<TileReadiness> {
  const started = Date.now();
  let state = tileReadiness(tile);
  while (state === 'loading' && Date.now() - started < timeoutMs) {
    await sleep(200);
    state = tileReadiness(tile);
  }
  return state;
}

/** Wait until every expected tile of the page is in the DOM (a page switch
 *  mounts them a moment later); returns how many are missing at the deadline. */
async function waitForTilesMounted(root: HTMLElement, ids: number[], timeoutMs: number): Promise<number> {
  const started = Date.now();
  const missing = () => ids.filter((id) => !root.querySelector(`[data-grid-item-id="${id}"]`)).length;
  let n = missing();
  while (n > 0 && Date.now() - started < timeoutMs) {
    await sleep(100);
    n = missing();
  }
  return n;
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * EXPORT-ONLY layout projection: the controls are gone from the slide, so the
 * horizontal band(s) only controls occupied close — content below moves up by
 * the band plus its gap. A control BESIDE content leaves that content where it
 * is (nothing overlaps); whitespace an author left anywhere else stays.
 */
export function closeControlBands<T extends Rect>(content: T[], controls: Rect[]): T[] {
  if (!controls.length || !content.length) return content;
  const bands = controls.map((c) => ({ top: c.y, bottom: c.y + c.h })).sort((a, b) => a.top - b.top);
  const merged: Array<{ top: number; bottom: number }> = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.top <= last.bottom) last.bottom = Math.max(last.bottom, b.bottom);
    else merged.push({ ...b });
  }
  // A band is vacated only if no content shares any of its rows.
  const vacated = merged.filter((b) => !content.some((r) => r.y < b.bottom - 0.5 && r.y + r.h > b.top + 0.5));
  // Consecutive vacated bands with no content starting between them close as one.
  const closures: Array<{ top: number; bottom: number }> = [];
  for (const b of vacated) {
    const last = closures[closures.length - 1];
    if (last && !content.some((r) => r.y >= last.bottom - 0.5 && r.y < b.top - 0.5)) last.bottom = b.bottom;
    else closures.push({ ...b });
  }
  const shifts = closures.map((b) => {
    const below = content.filter((r) => r.y >= b.bottom - 0.5).map((r) => r.y);
    return { at: b.bottom - 0.5, by: below.length ? Math.min(...below) - b.top : 0 };
  }).filter((s) => s.by > 0);
  return content.map((r) => {
    const by = shifts.filter((s) => r.y >= s.at).reduce((sum, s) => sum + s.by, 0);
    return by ? { ...r, y: r.y - by } : r;
  });
}

export async function exportDashboardPptx(opts: PptxExportOptions): Promise<void> {
  const pages: Array<{ name: string; width: number; tiles: PptxTilePayload[] }> = [];
  const failed: string[] = [];
  const totalCharts = opts.pages.reduce((n, p) => n + p.tiles.filter((t) => !isExportControl(t)
    && (!t.widgetType || t.widgetType === 'chart')).length, 0);
  let chartNo = 0;
  const captureBudgetMs = opts.budget?.captureMs ?? PPTX_CAPTURE_BUDGET_MS;
  const sendTimeoutMs = opts.budget?.sendMs ?? PPTX_SEND_TIMEOUT_MS;
  const deadline = Date.now() + captureBudgetMs;
  /** A step's own timeout, never past the export's overall deadline. */
  const within = (stepMs: number) => Math.max(0, Math.min(stepMs, deadline - Date.now()));
  for (let i = 0; i < opts.pages.length; i++) {
    const page = opts.pages[i];
    opts.onProgress?.(0.05 + 0.8 * (i / Math.max(1, opts.pages.length)), opts.labels?.page(i + 1, opts.pages.length) ?? page.name);
    const root = await page.getRoot();
    if (!root) { pages.push({ name: page.name, width: 1, tiles: [] }); continue; }
    const wanted = page.tiles.filter((t) => !isExportControl(t));
    await waitForTilesMounted(root, wanted.map((t) => t.id), within(TILES_MOUNT_TIMEOUT_MS));
    // Every tile in a final state (drawn / empty / failed): the shared protocol,
    // bounded — what is still loading at the deadline is retried, then reported.
    await waitForRenderReady(root, { timeoutMs: within(PAGE_READY_TIMEOUT_MS) });
    const rootRect = root.getBoundingClientRect();
    const content: Array<PptxTilePayload> = [];
    const controls: Rect[] = [];
    for (const t of page.tiles) {
      const el = root.querySelector<HTMLElement>(`[data-grid-item-id="${t.id}"]`);
      if (!el) {
        // A chart that never appeared on its page must not silently vanish from the deck.
        if (!isExportControl(t) && (!t.widgetType || t.widgetType === 'chart')) failed.push(t.title || `#${t.id}`);
        continue;
      }
      // The tile AS RENDERED (px, relative to the page): the slide keeps its
      // shape with one uniform scale, so pictures fill their blocks.
      // Measured against the page box read at the SAME moment: an earlier
      // tile's scroll (loading / capture retry) moves both, so the box read
      // once before the loop would offset every later tile by that scroll.
      const base = root.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const geom = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      if (isExportControl(t)) { controls.push(geom); continue; }
      const title = textOf(el.querySelector('[data-pdf-tile-title]')) || t.title || null;
      const type = String(t.chartType ?? '');
      if (t.widgetType && t.widgetType !== 'chart') {
        // Report elements (heading, text, insight, header): their words.
        const text = textOf(el);
        if (text) content.push({ kind: 'text', ...geom, title: null, text });
        continue;
      }
      chartNo += 1;
      opts.onProgress?.(0.05 + 0.8 * ((i + chartNo / Math.max(1, totalCharts)) / Math.max(1, opts.pages.length)),
        opts.labels?.chart(chartNo, totalCharts) ?? page.name);
      let state = tileReadiness(el);
      if (state === 'loading') {
        el.scrollIntoView({ block: 'center' });
        state = await waitForTile(el, within(TILE_RETRY_TIMEOUT_MS));
      }
      if (KPI_LIKE.test(type) && el.querySelector('.dashboard-kpi-value')) {
        content.push({ kind: 'kpi', ...geom, title, value: textOf(el.querySelector('.dashboard-kpi-value')) });
        continue;
      }
      if (TABLE_LIKE.test(type)) {
        const table = readTable(el);
        if (table) { content.push({ kind: 'table', ...geom, title, ...table }); continue; }
      }
      let image = state === 'loading' ? null : await captureChart(el, state);
      if (!image) {
        // One retry: back in view, renderer ready again, capture again.
        el.scrollIntoView({ block: 'center' });
        state = await waitForTile(el, within(TILE_RETRY_TIMEOUT_MS));
        if (state !== 'loading') image = await captureChart(el, state);
      }
      if (!image) { failed.push(title || `#${t.id}`); continue; }
      content.push({ kind: 'chart', ...geom, title, image });
    }
    pages.push({ name: page.name, width: Math.max(1, rootRect.width), tiles: closeControlBands(content, controls) });
  }
  if (failed.length) throw new PptxIncompleteError(failed);
  opts.onProgress?.(0.9, opts.labels?.building ?? '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blob = await Promise.race([
    opts.send({
      title: opts.title,
      subtitle: opts.subtitle ?? null,
      footer: opts.footer ?? null,
      pages,
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PptxTimeoutError(sendTimeoutMs)), sendTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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

/** The charts a refused export names (the browser's own check, or the server's
 *  422 — whose body is a Blob when the request asked for one). */
export async function incompleteChartsOf(err: unknown): Promise<string[] | null> {
  if (err instanceof PptxIncompleteError) return err.charts;
  let data: unknown = (err as { response?: { data?: unknown } })?.response?.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try { data = JSON.parse(await data.text()); } catch { return null; }
  }
  const detail = (data as { detail?: { code?: string; charts?: string[] } } | null)?.detail;
  if (detail && typeof detail === 'object' && detail.code === 'pptx_chart_missing') return detail.charts ?? [];
  return null;
}
