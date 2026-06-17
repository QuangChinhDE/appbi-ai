import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import { DEJAVU_SANS_REGULAR_B64, DEJAVU_SANS_BOLD_B64 } from './pdf-fonts';

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

export interface PdfProgress {
  phase: 'prepare' | 'page' | 'capture' | 'finalize' | 'done';
  /** 0..1 overall progress. */
  ratio: number;
  /** Human message for the UI (Vietnamese). */
  message: string;
}

export interface PdfExportOptions {
  filename: string;
  title: string;
  orientation: PdfOrientation;
  format: PdfPageSize;
  /** One entry per dashboard page to include, in order. */
  pages: PdfPageSource[];
  /** Progress reporter so the UI can show what's happening + how far along. */
  onProgress?: (p: PdfProgress) => void;
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

/** Title shown above a tile block (custom title / chart name). Prefers the
 *  explicit [data-pdf-tile-title] hook present on both the build (ChartTile)
 *  and public/embed (ReadonlyChartTile) tiles, falling back to any heading. */
function tileTitle(tile: HTMLElement): string {
  const h = tile.querySelector('[data-pdf-tile-title], h3, h2, .dashboard-tile-title') as HTMLElement | null;
  return h?.innerText.trim() || '';
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
  const colW = g.usableW / ncols;
  const fontSize = ncols > 8 ? 6.5 : ncols > 5 ? 7.5 : 8.5;
  const lineH = fontSize * 0.42; // mm per line
  const padX = 1.2;
  const padY = 1.2;
  let y = startY;
  let pageNo = ctx.pageNo;

  const measureRow = (cells: { text: string }[]): { lines: string[][]; h: number } => {
    pdf.setFontSize(fontSize);
    const lines = cells.map((c) => pdf.splitTextToSize(c.text || '', colW - padX * 2) as string[]);
    const maxLines = Math.max(1, ...lines.map((l) => l.length));
    return { lines, h: maxLines * lineH + padY * 2 };
  };

  const drawRow = (cells: Cell[], rowH: number, lines: string[][], opts2: { header?: boolean }) => {
    if (opts2.header) {
      pdf.setFillColor(241, 245, 249);
      pdf.rect(MARGIN, y, g.usableW, rowH, 'F');
      pdf.setFont(FONT, 'bold');
    } else {
      pdf.setFont(FONT, 'normal');
    }
    pdf.setFontSize(fontSize);
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.1);
    for (let c = 0; c < cells.length; c++) {
      const x = MARGIN + c * colW;
      const cell = cells[c];
      pdf.rect(x, y, colW, rowH); // cell border
      const tx = cell.align === 'right' ? x + colW - padX : cell.align === 'center' ? x + colW / 2 : x + padX;
      const ty = y + padY + lineH * 0.8;
      if (cell.bold) pdf.setFont(FONT, 'bold');
      if (cell.href) pdf.setTextColor(37, 99, 235);
      else pdf.setTextColor(opts2.header ? 51 : 30, opts2.header ? 65 : 41, opts2.header ? 85 : 59);
      pdf.text(lines[c] || [''], tx, ty, { align: cell.align, maxWidth: colW - padX * 2 });
      if (cell.href) {
        pdf.link(x, y, colW, rowH, { url: cell.href });
        pdf.setTextColor(30, 41, 59);
      }
      if (cell.bold && !opts2.header) pdf.setFont(FONT, 'normal');
    }
    y += rowH;
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
    drawRow(model.footer, m.h, m.lines, {});
  }
  return { y: y + 2, pageNo };
}

/**
 * Capture a tile to an image and place it (with its heading) atomically, so the
 * heading never orphans on the previous page. Paginates as a unit.
 */
async function drawImageTile(
  pdf: jsPDF,
  tile: HTMLElement,
  title: string,
  startY: number,
  opts: PdfExportOptions,
  page: PdfPageSource,
  ctx: { pageNo: number; total: number },
): Promise<{ y: number; pageNo: number }> {
  const g = geom(pdf);
  const contentH = g.bottom - startContentY();
  // ~0.42 so a heading + image + gap leaves room for a SECOND tile on the page
  // (a tile block ≈ heading 7 + image + 2; two of those + GAP must fit contentH).
  const maxTileH = contentH * 0.42;
  const headH = title ? 7 : 0;

  // Resilient capture: a single chart that html2canvas can't render (e.g. a map
  // tile with a tainted cross-origin image) must NOT abort the whole export.
  let dataUrl: string | null = null;
  let aspect = 0.6; // h/w fallback for the placeholder box
  try {
    // scale 1.35 + JPEG: legible but far smaller/faster than scale-2 PNG (keeps
    // the file light so it downloads fast and opens in every viewer, and speeds
    // up capture on chart-heavy dashboards).
    const canvas = await html2canvas(tile, { scale: 1.35, useCORS: true, logging: false, backgroundColor: '#ffffff' });
    aspect = canvas.height / canvas.width;
    dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    dataUrl = null;
  }

  let drawW = g.usableW;
  let drawH = aspect * drawW;
  if (drawH > maxTileH) { drawH = maxTileH; drawW = drawH / aspect; }
  let y = startY;
  let pageNo = ctx.pageNo;
  // Break BEFORE the heading when the heading + image won't fit together, so a
  // chart's title is never stranded alone at the bottom of a page.
  if (y + headH + drawH > g.bottom) {
    pdf.addPage(opts.format, opts.orientation);
    pageNo++;
    drawPageHeader(pdf, opts, page, pageNo, ctx.total);
    y = startContentY();
  }
  if (title) y = drawTileHeading(pdf, title, y);
  if (dataUrl) {
    pdf.addImage(dataUrl, 'JPEG', MARGIN, y, drawW, drawH);
  } else {
    // Placeholder so the layout + the rest of the report stay intact.
    pdf.setDrawColor(226, 232, 240); pdf.setLineWidth(0.2);
    pdf.rect(MARGIN, y, drawW, Math.min(drawH, 24));
    pdf.setFont(FONT, 'normal'); pdf.setFontSize(8); pdf.setTextColor(148, 163, 184);
    pdf.text('(không hiển thị được biểu đồ này)', MARGIN + 3, y + 8);
    pdf.setTextColor(15, 23, 42);
    drawH = Math.min(drawH, 24);
  }
  return { y: y + drawH + 2, pageNo };
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function exportDashboardPdf(opts: PdfExportOptions): Promise<void> {
  if (opts.pages.length === 0) return;
  const report = opts.onProgress ?? (() => {});
  // compress: true → deflate content streams. Without it jsPDF writes the whole
  // document (every table cell's text operators) UNCOMPRESSED → a 16MB file that
  // downloads slowly and chokes simple PDF viewers. With it the same report is
  // a few MB and opens everywhere.
  const pdf = new jsPDF({ orientation: opts.orientation, unit: 'mm', format: opts.format, compress: true });
  registerFonts(pdf);
  const total = opts.pages.length;
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

    // Tiles in visual order (top→bottom, then left→right).
    const tiles = [...root.querySelectorAll<HTMLElement>('.react-grid-item')]
      .filter((t) => t.offsetParent !== null)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
      });
    if (tiles.length === 0) continue;

    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
      const title = tileTitle(tile);
      report({
        phase: 'capture',
        ratio: 0.05 + 0.9 * (pageBase + (1 / total) * (ti / tiles.length)),
        message: `Trang ${i + 1}/${total}: đang xử lý biểu đồ ${ti + 1}/${tiles.length}${title ? ` — ${title}` : ''}…`,
      });
      const table = tile.querySelector('table') as HTMLTableElement | null;
      const g = geom(pdf);
      if (table && table.querySelectorAll('tbody tr').length > 0) {
        // Tables: break before the heading if near the bottom (the table's own
        // header row + first data row are small, so they won't orphan).
        if (y + 16 > g.bottom) { pdf.addPage(opts.format, opts.orientation); pageNo++; drawPageHeader(pdf, opts, page, pageNo, total); y = startContentY(); }
        y = drawTileHeading(pdf, title, y);
        const model = extractTableModel(table);
        const res = drawTable(pdf, model, y, opts, page, { pageNo, total });
        y = res.y; pageNo = res.pageNo;
      } else {
        // Images: heading + image break together (handled inside drawImageTile).
        const res = await drawImageTile(pdf, tile, title, y, opts, page, { pageNo, total });
        y = res.y; pageNo = res.pageNo;
      }
      y += GAP;
    }
  }

  report({ phase: 'finalize', ratio: 0.96, message: 'Đang tạo file PDF…' });
  stampFooters(pdf, opts.title);
  await downloadPdf(pdf, opts.filename);
  report({ phase: 'done', ratio: 1, message: 'Hoàn tất — đang tải xuống.' });
}

/**
 * Trigger the download ourselves with a DATA: url (not blob:).
 *
 * Why data: — a `blob:` download only carries a UUID in its URL, so anything
 * that intercepts the download and can't read the anchor's `download` attribute
 * (download-manager extensions like IDM/FDM, and some Chrome/Edge setups) names
 * the saved file after that UUID with NO `.pdf` extension → the user gets an
 * unopenable file like "6e4e0e0e-…" (exactly the bug reported). A `data:` URL
 * embeds the bytes inline, so the `download="<name>.pdf"` filename sticks across
 * browsers and isn't hijacked. The anchor is appended to <body> before click
 * (Edge/Firefox ignore `download` on a detached anchor). Falls back to blob:
 * only for unusually large files (data: URLs balloon ~33% in base64).
 */
async function downloadPdf(pdf: jsPDF, filename: string) {
  const name = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
  const blob: Blob = pdf.output('blob');

  let href: string;
  let isBlob = false;
  if (blob.size > 12 * 1024 * 1024) {
    // very large → a data: URL would be ~16MB+ string; use blob and hope the
    // environment honors the download attr.
    href = URL.createObjectURL(blob);
    isBlob = true;
  } else {
    href = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result)); // "data:application/pdf;base64,…"
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    if (isBlob) setTimeout(() => URL.revokeObjectURL(href), 5000);
  }
}
