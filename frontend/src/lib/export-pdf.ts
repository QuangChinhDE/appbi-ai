import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import { DEJAVU_SANS_REGULAR_B64, DEJAVU_SANS_BOLD_B64 } from './pdf-fonts';
import { waitForRenderReady } from './render-ready';

export { waitForRenderReady } from './render-ready';

/**
 * Phase-B22 — Hybrid dashboard → PDF export (replaces the old raster-only path).
 *
 * Why hybrid: the previous exporter screenshotted the whole page and SHRANK it
 * into one A4 → values became illegible, tables lost scrolled-out rows, and a
 * flat image can't have clickable links. Here:
 *   • TABLE / MATRIX tiles → drawn as REAL PDF text (selectable), every row,
 *     auto-paginated, with clickable hyperlinks (from the cell <a href>).
 *   • Every other chart → a sharp html2canvas image, scaled to a legible width.
 * Tiles flow top→bottom as a clean linear report (no shrink-to-tiny). Each page
 * gets a header with the dashboard title, page name, applied filters + time.
 *
 * Callers must FIRST put the dashboard in "export mode" (ExportModeContext) so
 * tables render all rows (no 200-cap, no inner scroll) and lazy tiles render.
 */

export type PdfPageSize = 'a4' | 'a3' | 'letter';
export type PdfOrientation = 'portrait' | 'landscape';
/**
 * How tiles are placed on the paper.
 *   • 'tiled'  — DEFAULT. Keeps the dashboard's own arrangement: tiles that sit
 *     side by side on screen stay side by side on the page, scaled to the page
 *     width. This is what makes the export look like the report.
 *   • 'single' — one tile per block, full page width, top to bottom. Useful when
 *     the reader wants every chart as big as possible.
 * ('single' used to be the only mode, and it is why a row of six KPI cards came
 * out as six near-empty pages.)
 */
export type PdfLayoutMode = 'tiled' | 'single';

export interface PdfProgress {
  phase: 'prepare' | 'page' | 'capture' | 'finalize' | 'done';
  /** 0..1 overall progress. */
  ratio: number;
  /** Human message for the UI (Vietnamese). */
  message: string;
}

/** A chart the exporter could not include (data never loaded). Listed at the end
 *  of the PDF so the reader knows the report is partial instead of silently
 *  seeing a gap. */
export interface PdfExportWarning {
  page: string;
  chart: string;
  reason: string;
}

export interface PdfExportOptions {
  filename: string;
  title: string;
  orientation: PdfOrientation;
  format: PdfPageSize;
  /** Tile placement — see PdfLayoutMode. Defaults to 'tiled'. */
  layout?: PdfLayoutMode;
  /** One entry per dashboard page to include, in order. */
  pages: PdfPageSource[];
  /** Snapshot freshness ("data as of") shown in the page header. */
  dataAsOf?: string | null;
  /** Charts that failed to load — rendered as a warning section at the end. */
  warnings?: PdfExportWarning[];
  /** Progress reporter so the UI can show what's happening + how far along. */
  onProgress?: (p: PdfProgress) => void;
  /**
   * A tab the caller opened SYNCHRONOUSLY inside the export click (so it isn't
   * popup-blocked). When given, the finished PDF is shown in this tab. Export
   * runs for several seconds, by which time `window.open` from here would be
   * blocked (transient user activation has lapsed) — hence the caller pre-opens.
   */
  previewWindow?: Window | null;
}

export interface PdfPageSource {
  name: string;
  /** Human-readable summary of the slicers/filters currently applied. */
  filtersSummary?: string;
  /** Switch to this page, force-render its tiles, and return the DOM root to walk. */
  getRoot: () => Promise<HTMLElement | null>;
}

const MARGIN = 10; // mm
const HEADER_H = 16; // mm reserved for the page header
const FOOTER_H = 8; // mm reserved for the footer
const GAP = 6; // mm between tile blocks

// Embedded Unicode font (jsPDF's built-in Helvetica is Latin-1 only and
// garbles Vietnamese — "Bộ lọc", Vietnamese table values/titles, etc.).
const FONT = 'DejaVuSans';

/** Register the embedded Vietnamese-capable font on a fresh jsPDF doc. */
function registerFonts(pdf: jsPDF) {
  pdf.addFileToVFS('DejaVuSans.ttf', DEJAVU_SANS_REGULAR_B64);
  pdf.addFont('DejaVuSans.ttf', FONT, 'normal');
  pdf.addFileToVFS('DejaVuSans-Bold.ttf', DEJAVU_SANS_BOLD_B64);
  pdf.addFont('DejaVuSans-Bold.ttf', FONT, 'bold');
  pdf.setFont(FONT, 'normal');
}

type Cell = { text: string; href?: string; align: 'left' | 'right' | 'center'; bold?: boolean };
type TableModel = { headers: string[]; rows: Cell[][]; footer?: Cell[] };

// ── DOM extraction ───────────────────────────────────────────────────────────

function cellAlign(el: Element): 'left' | 'right' | 'center' {
  const ta = getComputedStyle(el as HTMLElement).textAlign;
  if (ta === 'right' || ta === 'end') return 'right';
  if (ta === 'center') return 'center';
  return 'left';
}

/** Build a table model from a rendered <table> (after export-mode expanded it). */
function extractTableModel(table: HTMLTableElement): TableModel {
  const headers: string[] = [];
  const headRow = table.querySelector('thead tr');
  if (headRow) {
    headRow.querySelectorAll('th,td').forEach((th) => headers.push((th as HTMLElement).innerText.trim()));
  }
  const rows: Cell[][] = [];
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells: Cell[] = [];
    tr.querySelectorAll('td,th').forEach((td) => {
      const a = td.querySelector('a[href]') as HTMLAnchorElement | null;
      cells.push({
        text: (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
        href: a?.href || undefined,
        align: cellAlign(td),
      });
    });
    if (cells.length) rows.push(cells);
  });
  let footer: Cell[] | undefined;
  const footRow = table.querySelector('tfoot tr');
  if (footRow) {
    footer = [];
    footRow.querySelectorAll('td,th').forEach((td) =>
      footer!.push({ text: (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim(), align: cellAlign(td), bold: true }),
    );
  }
  return { headers, rows, footer };
}

/** The tile's title element — the explicit [data-pdf-tile-title] hook present on
 *  both the build (ChartTile) and public/embed (ReadonlyChartTile) tiles,
 *  falling back to any heading. */
function tileTitleEl(tile: HTMLElement): HTMLElement | null {
  return tile.querySelector('[data-pdf-tile-title], h3, h2, .dashboard-tile-title') as HTMLElement | null;
}

/** Title shown above a tile block (custom title / chart name). */
function tileTitle(tile: HTMLElement): string {
  return tileTitleEl(tile)?.innerText.trim() || '';
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

interface PageGeom {
  pw: number; ph: number; usableW: number; bottom: number;
}

function geom(pdf: jsPDF): PageGeom {
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  return { pw, ph, usableW: pw - MARGIN * 2, bottom: ph - MARGIN - FOOTER_H };
}

function drawPageHeader(pdf: jsPDF, opts: PdfExportOptions, page: PdfPageSource, pageNo: number, total: number) {
  const g = geom(pdf);
  pdf.setTextColor(15, 23, 42);
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(13);
  // Keep the title to ONE line — a long title would otherwise wrap and collide
  // with the page-name / "Bộ lọc" lines just below it.
  let titleLine = (opts.title || 'Dashboard').replace(/\s+/g, ' ').trim();
  const titleLines = pdf.splitTextToSize(titleLine, g.usableW - 60) as string[];
  if (titleLines.length > 1) titleLine = titleLines[0].replace(/.{1}$/, '…');
  pdf.text(titleLine, MARGIN, MARGIN + 4);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  if (page.name) pdf.text(page.name, MARGIN, MARGIN + 9);
  if (page.filtersSummary) {
    const lines = pdf.splitTextToSize(`Bộ lọc: ${page.filtersSummary}`, g.usableW - 50);
    pdf.text(lines.slice(0, 1), MARGIN, MARGIN + 13.5);
  }
  // Right rail: provenance. A report screenshot with no "as of" is unusable in a
  // meeting — the reader can't tell whether it's today's numbers or last week's.
  pdf.setFontSize(8);
  pdf.setTextColor(148, 163, 184);
  const exportedAt = `Xuất lúc ${formatStamp(new Date())}`;
  pdf.text(exportedAt, g.pw - MARGIN, MARGIN + 4, { align: 'right' });
  if (opts.dataAsOf) {
    const asOf = new Date(opts.dataAsOf);
    const asOfText = Number.isNaN(asOf.getTime()) ? String(opts.dataAsOf) : formatStamp(asOf);
    pdf.text(`Dữ liệu tính đến ${asOfText}`, g.pw - MARGIN, MARGIN + 9, { align: 'right' });
  }
  pdf.setDrawColor(226, 232, 240);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN, MARGIN + HEADER_H, g.pw - MARGIN, MARGIN + HEADER_H);
  // Footers are stamped in a final pass (stampFooters) once the true physical
  // page total is known — the page count isn't knowable up-front because tables
  // paginate dynamically.
}

/** Final pass: stamp "title … N / total" on every physical page. */
function stampFooters(pdf: jsPDF, title: string) {
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    const g = geom(pdf);
    pdf.setFont(FONT, 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(148, 163, 184);
    if (title) pdf.text(title, MARGIN, g.ph - MARGIN - 2, { maxWidth: g.usableW - 30 });
    pdf.text(`${i} / ${total}`, g.pw - MARGIN, g.ph - MARGIN - 2, { align: 'right' });
    pdf.setTextColor(15, 23, 42);
  }
}

function startContentY(): number {
  return MARGIN + HEADER_H + 5;
}

/** dd/MM/yyyy HH:mm in the viewer's own locale/timezone. */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Closing section listing charts that could not be included. An export that
 * quietly drops a failed tile is worse than one that says so: the reader has no
 * way to know a number is missing rather than zero.
 */
function drawWarnings(pdf: jsPDF, opts: PdfExportOptions, warnings: PdfExportWarning[]) {
  if (!warnings.length) return;
  pdf.addPage(opts.format, opts.orientation);
  const g = geom(pdf);
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(180, 83, 9);
  pdf.text('Cảnh báo: báo cáo xuất thiếu dữ liệu', MARGIN, MARGIN + 8);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text(
    `${warnings.length} biểu đồ không tải được dữ liệu tại thời điểm xuất file. Số liệu trong báo cáo này chưa đầy đủ.`,
    MARGIN,
    MARGIN + 14,
    { maxWidth: g.usableW },
  );
  let y = MARGIN + 22;
  pdf.setFontSize(8.5);
  for (const w of warnings) {
    if (y > g.bottom) { pdf.addPage(opts.format, opts.orientation); y = MARGIN + 10; }
    pdf.setTextColor(30, 41, 59);
    pdf.setFont(FONT, 'bold');
    const head = w.page ? `${w.page} — ${w.chart}` : w.chart;
    pdf.text(head, MARGIN, y, { maxWidth: g.usableW });
    pdf.setFont(FONT, 'normal');
    pdf.setTextColor(148, 163, 184);
    const reason = pdf.splitTextToSize(w.reason || 'Không rõ nguyên nhân', g.usableW - 4) as string[];
    pdf.text(reason.slice(0, 2), MARGIN + 2, y + 4);
    y += 4 + Math.min(2, reason.length) * 4 + 2;
  }
}

/** Draw a tile heading; returns the new y. */
function drawTileHeading(pdf: jsPDF, title: string, y: number): number {
  if (!title) return y;
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(30, 41, 59);
  pdf.text(title, MARGIN, y + 4, { maxWidth: geom(pdf).usableW });
  pdf.setFont(FONT, 'normal');
  pdf.setTextColor(15, 23, 42);
  return y + 7;
}

/**
 * Hand-rolled table renderer: real text, clickable links, auto-pagination,
 * repeating header row. Returns the y after the table.
 */
function drawTable(
  pdf: jsPDF,
  model: TableModel,
  startY: number,
  opts: PdfExportOptions,
  page: PdfPageSource,
  ctx: { pageNo: number; total: number },
): { y: number; pageNo: number } {
  const g = geom(pdf);
  const ncols = Math.max(model.headers.length, model.rows[0]?.length || 1);
  if (ncols === 0) return { y: startY, pageNo: ctx.pageNo };
  const fontSize = ncols > 8 ? 6.5 : ncols > 5 ? 7.5 : 8.5;
  const lineH = fontSize * 0.42; // mm per line
  const padX = 1.4;
  const padY = 1.3;
  const colW = computeColumnWidths(pdf, model, ncols, g.usableW, fontSize, padX);
  const colX: number[] = [];
  {
    let x = MARGIN;
    for (let c = 0; c < ncols; c++) { colX.push(x); x += colW[c]; }
  }
  let y = startY;
  let pageNo = ctx.pageNo;
  let zebra = 0;

  const measureRow = (cells: { text: string }[]): { lines: string[][]; h: number } => {
    pdf.setFontSize(fontSize);
    const lines = cells.map((c, i) => pdf.splitTextToSize(c.text || '', (colW[i] ?? colW[0]) - padX * 2) as string[]);
    const maxLines = Math.max(1, ...lines.map((l) => l.length));
    return { lines, h: maxLines * lineH + padY * 2 };
  };

  const drawRow = (cells: Cell[], rowH: number, lines: string[][], kind: { header?: boolean; footer?: boolean }) => {
    if (kind.header) {
      pdf.setFillColor(241, 245, 249);
      pdf.rect(MARGIN, y, g.usableW, rowH, 'F');
      pdf.setFont(FONT, 'bold');
    } else {
      // Zebra banding instead of a full cell grid — same information, far less
      // ink, and it reads like a report table rather than a spreadsheet dump.
      if (!kind.footer && zebra % 2 === 1) {
        pdf.setFillColor(248, 250, 252);
        pdf.rect(MARGIN, y, g.usableW, rowH, 'F');
      }
      pdf.setFont(FONT, 'normal');
    }
    pdf.setFontSize(fontSize);
    for (let c = 0; c < cells.length; c++) {
      const w = colW[c] ?? colW[colW.length - 1];
      const x = colX[c] ?? MARGIN;
      const cell = cells[c];
      const tx = cell.align === 'right' ? x + w - padX : cell.align === 'center' ? x + w / 2 : x + padX;
      const ty = y + padY + lineH * 0.8;
      if (cell.bold) pdf.setFont(FONT, 'bold');
      if (cell.href) pdf.setTextColor(37, 99, 235);
      else pdf.setTextColor(kind.header ? 51 : 30, kind.header ? 65 : 41, kind.header ? 85 : 59);
      pdf.text(lines[c] || [''], tx, ty, { align: cell.align, maxWidth: w - padX * 2 });
      if (cell.href) {
        pdf.link(x, y, w, rowH, { url: cell.href });
        pdf.setTextColor(30, 41, 59);
      }
      if (cell.bold && !kind.header) pdf.setFont(FONT, 'normal');
    }
    // One hairline under the row (header gets a stronger rule).
    pdf.setDrawColor(kind.header ? 203 : 232, kind.header ? 213 : 237, kind.header ? 225 : 245);
    pdf.setLineWidth(kind.header ? 0.25 : 0.1);
    pdf.line(MARGIN, y + rowH, MARGIN + g.usableW, y + rowH);
    y += rowH;
    if (!kind.header && !kind.footer) zebra++;
  };

  const headerCells: Cell[] = model.headers.map((h) => ({ text: h, align: 'left', bold: true }));
  const headerMeasure = measureRow(headerCells);
  const drawHeaderRow = () => drawRow(headerCells, headerMeasure.h, headerMeasure.lines, { header: true });

  drawHeaderRow();
  for (const row of model.rows) {
    const m = measureRow(row);
    if (y + m.h > g.bottom) {
      pdf.addPage(opts.format, opts.orientation);
      pageNo++;
      drawPageHeader(pdf, opts, page, pageNo, ctx.total);
      y = startContentY();
      drawHeaderRow();
    }
    drawRow(row, m.h, m.lines, {});
  }
  if (model.footer) {
    const m = measureRow(model.footer);
    if (y + m.h > g.bottom) { pdf.addPage(opts.format, opts.orientation); pageNo++; drawPageHeader(pdf, opts, page, pageNo, ctx.total); y = startContentY(); drawHeaderRow(); }
    drawRow(model.footer, m.h, m.lines, { footer: true });
  }
  return { y: y + 2, pageNo };
}

/**
 * Column widths proportional to CONTENT, not `usableW / ncols`.
 *
 * Equal columns are why exported tables looked wrong: a 6-character "Số lượng"
 * column got the same slab as a 60-character product name, so one side was a
 * desert of white space while the other wrapped into 4 lines. Here each column
 * asks for the width its widest sampled value needs (capped so one monster cell
 * can't eat the page), then the leftover space is shared out — or, when the
 * table wants more than the page, everything is scaled down with a floor so no
 * column collapses to nothing.
 */
function computeColumnWidths(
  pdf: jsPDF,
  model: TableModel,
  ncols: number,
  usableW: number,
  fontSize: number,
  padX: number,
): number[] {
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(fontSize);
  const SAMPLE_ROWS = 150;
  const natural = new Array<number>(ncols).fill(0);
  for (let c = 0; c < ncols; c++) {
    pdf.setFont(FONT, 'bold');
    natural[c] = pdf.getTextWidth(model.headers[c] || '');
    pdf.setFont(FONT, 'normal');
  }
  const step = Math.max(1, Math.ceil(model.rows.length / SAMPLE_ROWS));
  for (let r = 0; r < model.rows.length; r += step) {
    const row = model.rows[r];
    for (let c = 0; c < ncols; c++) {
      const t = row[c]?.text || '';
      if (!t) continue;
      const w = pdf.getTextWidth(t);
      if (w > natural[c]) natural[c] = w;
    }
  }
  const MIN_W = Math.min(11, usableW / ncols);
  const MAX_W = usableW * 0.34; // a long text column wraps instead of hogging
  const want = natural.map((w) => Math.min(MAX_W, Math.max(MIN_W, w + padX * 2 + 0.8)));
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= 0) return new Array<number>(ncols).fill(usableW / ncols);
  if (total <= usableW) {
    const slack = usableW - total;
    return want.map((w) => w + (slack * w) / total);
  }
  const scaled = want.map((w) => Math.max(MIN_W, (w * usableW) / total));
  const scaledTotal = scaled.reduce((a, b) => a + b, 0);
  return scaled.map((w) => (w * usableW) / scaledTotal);
}

// ── Tiled layout ─────────────────────────────────────────────────────────────

/** Horizontal gap between two tiles of the same row (mm). */
const TILE_GAP_X = 4;
/** Vertical gap between rows (mm). */
const ROW_GAP_Y = 5;

/** Group tiles into visual rows the way they sit on the dashboard. */
function groupIntoRows(tiles: HTMLElement[]): HTMLElement[][] {
  const rows: HTMLElement[][] = [];
  let current: HTMLElement[] = [];
  let currentTop = Number.NaN;
  for (const tile of tiles) {
    const top = tile.getBoundingClientRect().top;
    if (current.length === 0 || Math.abs(top - currentTop) <= 12) {
      if (current.length === 0) currentTop = top;
      current.push(tile);
    } else {
      rows.push(current);
      current = [tile];
      currentTop = top;
    }
  }
  if (current.length) rows.push(current);
  return rows;
}

/**
 * Capture one dashboard ROW and place it as a row on the page — tiles keep their
 * relative widths and their aspect ratios, the whole row is scaled to the page
 * width, and it is shrunk further if it would be taller than one page.
 *
 * Tiles are captured at a resolution derived from the size they will actually
 * occupy on paper (~150 dpi), so a small KPI card is not upscaled from a blurry
 * thumbnail and a wide chart is not captured at pointless resolution.
 */
async function drawTileRow(
  pdf: jsPDF,
  tiles: HTMLElement[],
  startY: number,
  opts: PdfExportOptions,
  page: PdfPageSource,
  ctx: { pageNo: number; total: number; fit?: number },
): Promise<{ y: number; pageNo: number; failed: HTMLElement[] }> {
  const g = geom(pdf);
  const contentH = g.bottom - startContentY();
  const rects = tiles.map((t) => t.getBoundingClientRect());
  const totalPxW = rects.reduce((a, r) => a + r.width, 0);
  if (totalPxW <= 0) return { y: startY, pageNo: ctx.pageNo, failed: [] };
  const availW = g.usableW - TILE_GAP_X * (tiles.length - 1);
  // `fit` (≤1) is the whole-page shrink factor decided by planPageFit: applying
  // it to every row of a dashboard page lands the entire page on ONE sheet at a
  // consistent scale, instead of pushing each row onto its own near-empty page.
  let mmPerPx = (availW / totalPxW) * (ctx.fit ?? 1);
  const maxPxH = Math.max(...rects.map((r) => r.height));
  // A single row must never exceed one page.
  if (maxPxH * mmPerPx > contentH) mmPerPx = contentH / maxPxH;

  let y = startY;
  let pageNo = ctx.pageNo;
  let rowH = maxPxH * mmPerPx;
  // Squeeze-to-fill: rather than pushing a row that is ALMOST short enough onto
  // a fresh sheet (leaving a KPI strip alone on the previous one), shrink it a
  // little so it joins the current page. Below SQUEEZE_MIN the charts would get
  // too small, so we break instead.
  const available = g.bottom - y;
  if (rowH > available && available >= rowH * SQUEEZE_MIN) {
    mmPerPx *= available / rowH;
    rowH = maxPxH * mmPerPx;
  } else if (rowH > available) {
    pdf.addPage(opts.format, opts.orientation);
    pageNo++;
    drawPageHeader(pdf, opts, page, pageNo, ctx.total);
    y = startContentY();
  }

  // When a tall tile forces the row to shrink, the row no longer fills the page
  // width — centre it instead of leaving it stranded against the left margin
  // (that lopsided look was a big part of "the PDF is ugly").
  const rowW = totalPxW * mmPerPx + TILE_GAP_X * (tiles.length - 1);
  let x = MARGIN + Math.max(0, (g.usableW - rowW) / 2);
  const failed: HTMLElement[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const w = rects[i].width * mmPerPx;
    const h = rects[i].height * mmPerPx;
    // Target ~150 dpi for the drawn size, clamped so we never ask html2canvas
    // for a giant bitmap (memory) or an upscaled blur.
    const targetPx = (w / 25.4) * 150;
    const scale = Math.max(1, Math.min(3, targetPx / Math.max(1, rects[i].width)));
    let dataUrl: string | null = null;
    try {
      const canvas = await html2canvas(tile, {
        scale,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      dataUrl = null;
    }
    if (dataUrl) {
      pdf.addImage(dataUrl, 'JPEG', x, y, w, h);
    } else {
      failed.push(tile);
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.2);
      pdf.rect(x, y, w, Math.min(h, 24));
      pdf.setFont(FONT, 'normal');
      pdf.setFontSize(7.5);
      pdf.setTextColor(148, 163, 184);
      pdf.text('(không hiển thị được)', x + 2, y + 6, { maxWidth: w - 4 });
      pdf.setTextColor(15, 23, 42);
    }
    x += w + TILE_GAP_X;
  }
  return { y: y + rowH + ROW_GAP_Y, pageNo, failed };
}

/**
 * Decide a single shrink factor so an entire dashboard page fits on ONE sheet.
 *
 * Without this, rows flow one after another and a row that doesn't fit the space
 * left over starts a new page — a 6-row dashboard became ~8 sheets, most of them
 * two-thirds empty (the "43 pages of white space" complaint). Here we measure
 * every row first: if the page overflows by a moderate amount we scale all rows
 * down by the same factor (keeping relative sizes intact); if it would have to
 * shrink past `MIN_FIT` the charts would be too small to read, so we fall back
 * to flowing across pages at full size.
 */
const MIN_FIT = 0.55;
/** Shrink a row by at most this much to keep it on the current page. */
const SQUEEZE_MIN = 0.65;

function planPageFit(rows: HTMLElement[][], usableW: number, contentH: number): number {
  let totalH = 0;
  for (const row of rows) {
    const rects = row.map((t) => t.getBoundingClientRect());
    const pxW = rects.reduce((a, r) => a + r.width, 0);
    if (pxW <= 0) continue;
    const availW = usableW - TILE_GAP_X * (row.length - 1);
    const scale = availW / pxW;
    totalH += Math.max(...rects.map((r) => r.height)) * scale + ROW_GAP_Y;
  }
  if (totalH <= 0) return 1;
  if (totalH <= contentH) return 1;
  const fit = contentH / totalH;
  return fit >= MIN_FIT ? fit : 1;
}

/** Does this tile hold a data table we should render as real text? */
function tileTable(tile: HTMLElement): HTMLTableElement | null {
  const table = tile.querySelector('table') as HTMLTableElement | null;
  return table && table.querySelectorAll('tbody tr').length > 0 ? table : null;
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function exportDashboardPdf(opts: PdfExportOptions): Promise<'opened' | 'saved'> {
  if (opts.pages.length === 0) return 'saved';
  const report = opts.onProgress ?? (() => {});
  // compress: true → deflate content streams. Without it jsPDF writes the whole
  // document (every table cell's text operators) UNCOMPRESSED → a 16MB file that
  // downloads slowly and chokes simple PDF viewers. With it the same report is
  // a few MB and opens everywhere.
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'mm', format: opts.format, compress: true });
  registerFonts(pdf);
  const total = opts.pages.length;
  // Caller-supplied failures (charts whose data never loaded) + anything the
  // exporter itself can't render. Both end up in the closing warning section.
  const warnings: PdfExportWarning[] = [...(opts.warnings ?? [])];
  report({ phase: 'prepare', ratio: 0.02, message: 'Đang chuẩn bị…' });

  for (let i = 0; i < opts.pages.length; i++) {
    const page = opts.pages[i];
    if (i > 0) pdf.addPage(opts.format, opts.orientation);
    let pageNo = i + 1;
    drawPageHeader(pdf, opts, page, pageNo, total);
    let y = startContentY();

    const pageBase = i / total;
    report({ phase: 'page', ratio: 0.05 + 0.9 * pageBase, message: `Đang tải trang ${i + 1}/${total}${page.name ? ` — ${page.name}` : ''}…` });
    const root = await page.getRoot();
    if (!root) continue;

    // Readiness protocol — never capture on a timer. See waitForRenderReady.
    const ready = await waitForRenderReady(root, {
      onWait: (elapsed) => {
        if (elapsed > 1200) {
          report({
            phase: 'page',
            ratio: 0.05 + 0.9 * pageBase,
            message: `Đang chờ trang ${i + 1}/${total} vẽ xong (${Math.round(elapsed / 1000)}s)…`,
          });
        }
      },
    });
    if (!ready.ready) {
      // Not fatal: capture what's there, but tell the reader the page may be
      // incomplete rather than pretending everything rendered.
      warnings.push({
        page: page.name || `Trang ${i + 1}`,
        chart: '(toàn trang)',
        reason: `Trang chưa vẽ xong sau ${Math.round(ready.waitedMs / 1000)}s — một số ô có thể bị thiếu.`,
      });
    }

    // Tiles in visual order (top→bottom, then left→right).
    const tiles = [...root.querySelectorAll<HTMLElement>('.react-grid-item')]
      .filter((t) => t.offsetParent !== null)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
      });
    if (tiles.length === 0) continue;

    const layout: PdfLayoutMode = opts.layout ?? 'tiled';
    // Rows of the dashboard grid. In 'single' mode every tile is its own row, so
    // both layouts share one code path.
    const rows = layout === 'tiled' ? groupIntoRows(tiles) : tiles.map((t) => [t]);
    // One dashboard page → one PDF page whenever it can be done legibly.
    const gPage = geom(pdf);
    const fit = layout === 'tiled' && !tiles.some((t) => tileTable(t))
      ? planPageFit(rows, gPage.usableW, gPage.bottom - startContentY())
      : 1;
    let doneTiles = 0;
    const tick = (label: string) => {
      report({
        phase: 'capture',
        ratio: 0.05 + 0.9 * (pageBase + (1 / total) * (doneTiles / Math.max(1, tiles.length))),
        message: `Trang ${i + 1}/${total}: đang xử lý ô ${Math.min(doneTiles + 1, tiles.length)}/${tiles.length}${label ? ` — ${label}` : ''}…`,
      });
    };

    for (const row of rows) {
      // A tile holding a data table is always rendered as REAL text at full
      // width (selectable, all rows, clickable links) — squeezing a table into a
      // narrow grid column would defeat the point of the hybrid engine. The rest
      // of the row is drawn as a scaled image row, keeping the on-screen layout.
      const tableTiles = row.filter((t) => tileTable(t));
      const imageTiles = row.filter((t) => !tileTable(t));

      if (imageTiles.length) {
        tick(tileTitle(imageTiles[0]));
        const res = await drawTileRow(pdf, imageTiles, y, opts, page, { pageNo, total, fit });
        y = res.y; pageNo = res.pageNo;
        for (const t of res.failed) {
          warnings.push({
            page: page.name || `Trang ${i + 1}`,
            chart: tileTitle(t) || 'Biểu đồ',
            reason: 'Không chụp được hình biểu đồ này (trình duyệt từ chối render).',
          });
        }
        doneTiles += imageTiles.length;
      }

      for (const tile of tableTiles) {
        const title = tileTitle(tile);
        tick(title);
        const g = geom(pdf);
        // Break before the heading when we're near the bottom (the table's own
        // header row + first data row are small, so they won't orphan).
        if (y + 16 > g.bottom) {
          pdf.addPage(opts.format, opts.orientation);
          pageNo++;
          drawPageHeader(pdf, opts, page, pageNo, total);
          y = startContentY();
        }
        y = drawTileHeading(pdf, title, y);
        const res = drawTable(pdf, extractTableModel(tileTable(tile)!), y, opts, page, { pageNo, total });
        y = res.y; pageNo = res.pageNo;
        y += GAP;
        doneTiles += 1;
      }
    }
  }

  report({ phase: 'finalize', ratio: 0.96, message: 'Đang tạo file PDF…' });
  drawWarnings(pdf, opts, warnings);
  stampFooters(pdf, opts.title);
  const result = downloadPdf(pdf, opts.filename, opts.previewWindow);
  report({
    phase: 'done',
    ratio: 1,
    message: result === 'opened' ? 'Hoàn tất — đã mở PDF ở tab mới + tải về máy.' : 'Hoàn tất — đã tải PDF về máy.',
  });
  return result;
}

/**
 * Deliver the finished PDF: show it in a browser tab AND save a copy to disk.
 *
 * Returns 'opened' when the PDF is showing in a tab, 'saved' when the tab was
 * blocked and we only managed the download. Always also triggers the download so
 * the user ends up with a real file on disk regardless.
 *
 * Why a `blob:` URL for both: it carries the bytes verbatim — the browser's PDF
 * viewer renders it in the tab, and the anchor `download` saves the complete
 * file with the right `.pdf` name. (A multi-MB `data:` URL silently fails or
 * truncates in Chrome, which is what made big full-table dashboards download an
 * unopenable file.) The tab is the caller's pre-opened `previewWindow` so the
 * popup blocker — which fires once the export's seconds-long capture has spent
 * the user activation — doesn't eat it.
 */
function downloadPdf(pdf: jsPDF, filename: string, previewWindow?: Window | null): 'opened' | 'saved' {
  const name = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
  const blob: Blob = pdf.output('blob');
  const url = URL.createObjectURL(blob);

  // 1) Show it immediately in a tab beside the dashboard.
  let opened = false;
  try {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.location.href = url;
      opened = true;
    } else {
      // No pre-opened tab (or it was blocked): a direct open here usually gets
      // popup-blocked after the long export, but try anyway.
      opened = !!window.open(url, '_blank');
    }
  } catch {
    opened = false;
  }

  // 2) Always save a copy to disk too, with the correct filename. The anchor is
  //    appended to <body> before click (Edge/Firefox ignore `download` on a
  //    detached anchor).
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    /* download is best-effort; the tab above is the primary delivery */
  }

  // Revoke late — the just-opened tab needs the URL to finish rendering.
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return opened ? 'opened' : 'saved';
}
