import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import { DEJAVU_SANS_REGULAR_B64, DEJAVU_SANS_BOLD_B64 } from './pdf-fonts';
import { planKeyForElement, tileBoxMm, type ExportLayoutPlan } from './export-layout';
import { waitForRenderReady } from './render-ready';
import { planSnapshotSheets } from './pdf-sheet-plan';

/**
 * The capture engine draws a `text-overflow: ellipsis` span from its own width
 * measurement, and a filter control's short value ("All", "SP") came out as a
 * bare "…" in every PDF. In the CLONE it captures (never on screen), a control's
 * text is drawn in full; its card still clips anything too long.
 */
const EXPORT_LEGIBLE_CSS = [
  '.dashboard-slicer .truncate, .dashboard-slicer [class*="truncate"] { text-overflow: clip !important; overflow: visible !important; }',
  // A short widget title ("Performance") came out as "Performan…" the same way.
  '[data-tile-kind="widget"] .truncate { text-overflow: clip !important; }',
  // Paper is not interactive: no drill toggles ("Group by Y Q M W D"), no
  // dropdown chevrons. A control prints as its label and value.
  '[data-export-hide] { display: none !important; }',
  '.dashboard-slicer .lucide-chevron-down { display: none !important; }',
  // Figures printed with gaps ("41 .4K", "R$1 25.8"): with a non-zero letter
  // spacing html2canvas draws text glyph by glyph and mis-advances tabular
  // numerals. Paper keeps the face and weight, at normal spacing.
  '.dashboard-kpi-value, .dashboard-kpi-value *, .dashboard-narrative__figure, .dashboard-kpi-delta,'
    + ' .dashboard-kpi-window-value, .tabular-nums { letter-spacing: normal !important;'
    + ' font-variant-numeric: normal !important; font-feature-settings: normal !important; }',
  // A section band is a frame behind several rows; a sheet break sliced it and
  // left its side edges on the next sheet. On paper the heading marks the
  // section.
  '[data-section-bands] { display: none !important; }',
  // html2canvas captures a CLONE of the page, and in the clone every CSS
  // animation starts again from its first frame. The charts' 220ms fade-in
  // (opacity 0 -> 1) was therefore captured part-way: every chart and KPI printed
  // washed out (grey figures, pale bars) while headings, outside the fade, were
  // black. Paper has no motion.
  '*, *::before, *::after { animation: none !important; transition: none !important; }',
].join('\n');

/** A grid item that is a section heading: it belongs with what follows it. */
function isHeadingItem(el: Element): boolean {
  return !!el.querySelector('[data-widget-type="section_header"]');
}
function legibleClone(doc: Document) {
  const style = doc.createElement('style');
  style.textContent = EXPORT_LEGIBLE_CSS;
  doc.head.appendChild(style);
}

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
 *   • 'snapshot' — THE DEFAULT. One dashboard page becomes exactly one sheet: the
 *     page is captured ONCE and scaled to fit. Tables print the rows they show on
 *     screen, nothing expands, and there is one capture per page instead of one
 *     per tile — which is the entire point, since a chart-heavy report spent most
 *     of its export time rasterising tiles one at a time.
 *   • 'tiled'  — full data. Keeps the dashboard's own arrangement: tiles that sit
 *     side by side on screen stay side by side on the page, scaled to the page
 *     width, and tables are drawn as real text with every row.
 *   • 'single' — full data, one tile per block at full page width, top to bottom.
 *     For a reader who wants every chart as big as possible.
 *   • 'custom' — the arrangement the user made in the export-layout dialog: each
 *     sheet is drawn from an explicit plan (see lib/export-layout). The plan
 *     drives ONLY the export; the dashboard's own layout is never touched.
 * ('single' used to be the only mode, and it is why a row of six KPI cards came
 * out as six near-empty pages.)
 */
export type PdfLayoutMode = 'snapshot' | 'tiled' | 'single' | 'custom';

/** Layouts that paginate to fit ALL the data (tables expand to every row). */
export const FULL_DATA_LAYOUTS: PdfLayoutMode[] = ['tiled', 'single'];

export interface PdfProgress {
  phase: 'prepare' | 'page' | 'capture' | 'finalize' | 'done';
  /** 0..1 overall progress. */
  ratio: number;
  /** Human message for the UI, in the export's locale. */
  message: string;
}

/** A chart the exporter could not include (data never loaded). Listed at the end
 *  of the PDF so the reader knows the report is partial instead of silently
 *  seeing a gap. */
export interface PdfExportWarning {
  page: string;
  chart: string;
  reason: string;
  /** `incomplete` = a chart or page is missing from the file (the default);
   *  `note` = everything is there, but the reader should know something about
   *  how it was laid out. Only `incomplete` may say the report lacks data. */
  kind?: 'incomplete' | 'note';
}

export interface PdfExportOptions {
  filename: string;
  title: string;
  /** The reader's language for the words the exporter prints ('en' / 'vi'). */
  locale?: string;
  /** What the report is for — stated under the title on every sheet. */
  description?: string | null;
  orientation: PdfOrientation;
  format: PdfPageSize;
  /** Tile placement — see PdfLayoutMode. Defaults to 'snapshot'. */
  layout?: PdfLayoutMode;
  /** One entry per dashboard page to include, in order. */
  pages: PdfPageSource[];
  /** Snapshot freshness ("data as of") shown in the page header. */
  dataAsOf?: string | null;
  /** Charts that failed to load — rendered as a warning section at the end. */
  warnings?: PdfExportWarning[];
  /** Required when `layout: 'custom'` — the sheets the user arranged. */
  plan?: ExportLayoutPlan;
  /** Progress reporter so the UI can show what's happening + how far along. */
  onProgress?: (p: PdfProgress) => void;
  /** The words printed on every page, in the reader's language. Each defaults
   *  to the previous Vietnamese text. */
  labels?: { filters?: string; exportedAt?: string; dataAsOf?: string; snapshotNote?: string };
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

// Below this fit factor a snapshot sheet stops being comfortable to read, so we
// flag it in the report's warning section instead of quietly shipping a page
// nobody can use.
const SNAPSHOT_SMALL_SCALE = 0.62;
/** The snapshot is captured at this device scale; its canvas pixels are not
 *  screen pixels. Readability is judged on screen size, i.e. fit × this. */
const SNAPSHOT_CAPTURE_SCALE = 1.6;

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
  // Line 2: what the report is for, then the page. One line, never wrapped
  // into the filter line below it.
  const second = [String(opts.description ?? '').replace(/\s+/g, ' ').trim(), page.name ?? ''].filter(Boolean).join('  ·  ');
  if (second) {
    const fit = pdf.splitTextToSize(second, g.usableW - 60) as string[];
    pdf.text(fit.length > 1 ? `${fit[0].replace(/.{1}$/, '')}…` : fit[0], MARGIN, MARGIN + 9);
  }
  if (page.filtersSummary) {
    const lines = pdf.splitTextToSize(`${opts.labels?.filters ?? TX.filters}: ${page.filtersSummary}`, g.usableW - 50);
    pdf.text(lines.slice(0, 1), MARGIN, MARGIN + 13.5);
  }
  // Right rail: provenance. A report screenshot with no "as of" is unusable in a
  // meeting — the reader can't tell whether it's today's numbers or last week's.
  pdf.setFontSize(8);
  pdf.setTextColor(148, 163, 184);
  const exportedAt = `${opts.labels?.exportedAt ?? TX.exportedAt} ${formatStamp(new Date())}`;
  pdf.text(exportedAt, g.pw - MARGIN, MARGIN + 4, { align: 'right' });
  if (opts.dataAsOf) {
    const asOf = new Date(opts.dataAsOf);
    const asOfText = Number.isNaN(asOf.getTime()) ? String(opts.dataAsOf) : formatStamp(asOf);
    pdf.text(`${opts.labels?.dataAsOf ?? TX.dataAsOf} ${asOfText}`, g.pw - MARGIN, MARGIN + 9, { align: 'right' });
  }
  pdf.setDrawColor(226, 232, 240);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN, MARGIN + HEADER_H, g.pw - MARGIN, MARGIN + HEADER_H);
  // Footers are stamped in a final pass (stampFooters) once the true physical
  // page total is known — the page count isn't knowable up-front because tables
  // paginate dynamically.
}

/** Final pass: stamp "title … N / total" on every physical page. */
function stampFooters(pdf: jsPDF, title: string, note?: string) {
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    const g = geom(pdf);
    pdf.setFont(FONT, 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(148, 163, 184);
    const left = note ? `${title} · ${note}` : title;
    if (left) pdf.text(left, MARGIN, g.ph - MARGIN - 2, { maxWidth: g.usableW - 30 });
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
/**
 * Every word the exporter itself prints on paper, in the reader's language.
 * Vietnamese stays the default so an older caller prints what it always did;
 * `labels` still overrides the three header words.
 */
const PDF_TEXT = {
  vi: {
    filters: 'Bộ lọc', exportedAt: 'Xuất lúc', dataAsOf: 'Dữ liệu tính đến',
    warnIncompleteTitle: 'Cảnh báo: báo cáo xuất thiếu dữ liệu',
    warnIncompleteSummary: (n: number) => `${n} biểu đồ/trang không có đủ dữ liệu tại thời điểm xuất file. Số liệu trong báo cáo này chưa đầy đủ.`,
    notesTitle: 'Ghi chú khi xuất file',
    notesSummary: 'Báo cáo đầy đủ dữ liệu; các ghi chú dưới đây chỉ về cách trình bày trên giấy.',
    unknownReason: 'Không rõ nguyên nhân',
    tileUnrenderable: '(không hiển thị được)',
    pageUncaptured: '(không chụp được trang này)',
    sheet: (n: number) => `Tờ ${n}`,
    chartN: (id: number | string) => `Biểu đồ #${id}`,
    chart: 'Biểu đồ',
    notFoundOnReport: 'Không tìm thấy biểu đồ này trên báo cáo khi xuất.',
    captureRefused: 'Không chụp được hình biểu đồ này (trình duyệt từ chối render).',
    arrangedNote: 'Bố cục tự sắp',
    wholePage: '(toàn trang)',
    pageNotReady: (s: number) => `Trang chưa vẽ xong sau ${s}s — một số ô có thể bị thiếu.`,
    pageNotCaptured: 'Không chụp được trang này.',
    pageScaled: (pct: number) => `Trang bị thu nhỏ còn ${pct}% để vừa một tờ — chọn khổ A3 hoặc hướng ngang để dễ đọc hơn.`,
    snapshotNote: 'Ảnh trang — bảng in theo dữ liệu đang hiển thị',
    pPreparing: 'Đang chuẩn bị…',
    pSheetTile: (s: number, S: number, i: number, n: number) => `Tờ ${s}/${S}: đang xử lý ô ${i}/${n}…`,
    pLoadingPage: (i: number, n: number, name?: string) => `Đang tải trang ${i}/${n}${name ? ` — ${name}` : ''}…`,
    pWaitingPage: (i: number, n: number, s: number) => `Đang chờ trang ${i}/${n} vẽ xong (${s}s)…`,
    pCapturingPage: (i: number, n: number, name?: string) => `Đang chụp trang ${i}/${n}${name ? ` — ${name}` : ''}…`,
    pPageTile: (p: number, P: number, i: number, n: number, label?: string) => `Trang ${p}/${P}: đang xử lý ô ${i}/${n}${label ? ` — ${label}` : ''}…`,
    pMaking: 'Đang tạo file PDF…',
    pDoneSaved: 'Hoàn tất — đã tải PDF về máy.',
    pDoneOpened: 'Hoàn tất — đã mở PDF ở tab mới + tải về máy.',
  },
  en: {
    filters: 'Filters', exportedAt: 'Exported', dataAsOf: 'Data as of',
    warnIncompleteTitle: 'Warning: this export is missing data',
    warnIncompleteSummary: (n: number) => `${n} chart(s) or page(s) had no complete data when the file was made. The figures in this report are incomplete.`,
    notesTitle: 'Notes on this export',
    notesSummary: 'The report is complete; the notes below are only about how it is laid out on paper.',
    unknownReason: 'Unknown reason',
    tileUnrenderable: '(could not be drawn)',
    pageUncaptured: '(this page could not be captured)',
    sheet: (n: number) => `Sheet ${n}`,
    chartN: (id: number | string) => `Chart #${id}`,
    chart: 'Chart',
    notFoundOnReport: 'This chart was not found on the report at export time.',
    captureRefused: 'This chart could not be captured (the browser refused to render it).',
    arrangedNote: 'Custom layout',
    wholePage: '(whole page)',
    pageNotReady: (s: number) => `The page had not finished drawing after ${s}s; some tiles may be missing.`,
    pageNotCaptured: 'This page could not be captured.',
    pageScaled: (pct: number) => `The page was scaled to ${pct}% to fit one sheet; choose A3 or landscape for easier reading.`,
    snapshotNote: 'Page image: tables print the rows on screen',
    pPreparing: 'Preparing…',
    pSheetTile: (s: number, S: number, i: number, n: number) => `Sheet ${s}/${S}: tile ${i}/${n}…`,
    pLoadingPage: (i: number, n: number, name?: string) => `Loading page ${i}/${n}${name ? ` — ${name}` : ''}…`,
    pWaitingPage: (i: number, n: number, s: number) => `Waiting for page ${i}/${n} to finish drawing (${s}s)…`,
    pCapturingPage: (i: number, n: number, name?: string) => `Capturing page ${i}/${n}${name ? ` — ${name}` : ''}…`,
    pPageTile: (p: number, P: number, i: number, n: number, label?: string) => `Page ${p}/${P}: tile ${i}/${n}${label ? ` — ${label}` : ''}…`,
    pMaking: 'Making the PDF…',
    pDoneSaved: 'Done: the PDF was downloaded.',
    pDoneOpened: 'Done: the PDF opened in a new tab and was downloaded.',
  },
};
type PdfText = typeof PDF_TEXT.vi;
let TX: PdfText = PDF_TEXT.vi;

/**
 * The warnings page's headline. Only what is really missing may be announced
 * as missing: a layout note (a page printed small) is not data the report lacks.
 */
export function exportWarningHeadline(warnings: PdfExportWarning[], locale?: string): { title: string; summary: string; incomplete: number } | null {
  if (!warnings.length) return null;
  const tx = locale ? (locale.startsWith('en') ? PDF_TEXT.en : PDF_TEXT.vi) : TX;
  const incomplete = warnings.filter((w) => (w.kind ?? 'incomplete') === 'incomplete').length;
  return incomplete > 0
    ? {
        incomplete,
        title: tx.warnIncompleteTitle,
        summary: tx.warnIncompleteSummary(incomplete),
      }
    : {
        incomplete: 0,
        title: tx.notesTitle,
        summary: tx.notesSummary,
      };
}

function drawWarnings(pdf: jsPDF, opts: PdfExportOptions, warnings: PdfExportWarning[]) {
  if (!warnings.length) return;
  pdf.addPage(opts.format, opts.orientation);
  const g = geom(pdf);
  pdf.setFont(FONT, 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(180, 83, 9);
  const headline = exportWarningHeadline(warnings)!;
  pdf.text(headline.title, MARGIN, MARGIN + 8);
  pdf.setFont(FONT, 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text(headline.summary, MARGIN, MARGIN + 14, { maxWidth: g.usableW });
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
    const reason = pdf.splitTextToSize(w.reason || TX.unknownReason, g.usableW - 4) as string[];
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
        onclone: legibleClone,
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
      pdf.text(TX.tileUnrenderable, x + 2, y + 6, { maxWidth: w - 4 });
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

/** A tile (as the tiled flow collects them) that is a section heading. */
function isHeadingItemTile(tile: HTMLElement): boolean {
  return tile.matches('[data-widget-type="section_header"]') || isHeadingItem(tile);
}

/** The height a row will take on the sheet, by drawTileRow's own rule. */
function estimateRowMm(row: HTMLElement[], g: ReturnType<typeof geom>, fit: number): number {
  const rects = row.map((t) => t.getBoundingClientRect());
  const totalPxW = rects.reduce((a, r) => a + r.width, 0);
  if (totalPxW <= 0) return 0;
  const availW = g.usableW - TILE_GAP_X * (row.length - 1);
  let mmPerPx = (availW / totalPxW) * (fit ?? 1);
  const maxPxH = Math.max(...rects.map((r) => r.height));
  const contentH = g.bottom - startContentY();
  if (maxPxH * mmPerPx > contentH) mmPerPx = contentH / maxPxH;
  return maxPxH * mmPerPx;
}
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

/**
 * Draw one dashboard page as a single scaled picture on one sheet.
 *
 * Why one capture instead of per-tile captures: html2canvas cost is dominated by
 * the number of invocations (each one clones + re-lays-out its subtree), so a
 * 20-tile page goes from 20 layout passes to 1. The trade is that everything on
 * the sheet is an image — no selectable table text — which is exactly the deal
 * the "snapshot" option offers, and why the full-data layouts stay available.
 *
 * The capture is scaled to FIT (never cropped, never enlarged past 1:1) and
 * centred, so the sheet reads like a photo of the report. Returns the scale used
 * so the caller can warn when the result got small enough to hurt.
 */
async function drawPageSnapshot(
  pdf: jsPDF,
  root: HTMLElement,
  opts: PdfExportOptions,
  page: PdfPageSource,
  ctx: { pageNo: number; total: number },
): Promise<{ scale: number; failed: boolean }> {
  const g = geom(pdf);
  const availW = g.usableW;
  const availH = g.bottom - startContentY();
  let dataUrl: string | null = null;
  let snapshotCanvas: HTMLCanvasElement | null = null;
  let cw = 0;
  let ch = 0;
  try {
    // scale 1.6 keeps chart labels legible after the fit-shrink below without
    // making a multi-MB page; JPEG for the same reason the tiled path uses it.
    const canvas = await html2canvas(root, {
      scale: SNAPSHOT_CAPTURE_SCALE,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      onclone: legibleClone,
      // The clone window must be as wide as the REAL page. With the element's
      // own width, a grid beside a slicer rail re-lays out narrower in the
      // clone while its tiles keep their pixel positions, and the snapshot
      // cropped the right half of every row. The element is still what is
      // captured; only the layout context matches the screen.
      windowWidth: Math.max(document.documentElement.clientWidth, window.innerWidth, root.getBoundingClientRect().right),
      windowHeight: Math.max(document.documentElement.clientHeight, root.scrollHeight),
    });
    cw = canvas.width;
    ch = canvas.height;
    snapshotCanvas = canvas;
    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    dataUrl = null;
  }
  if (!dataUrl || !cw || !ch) {
    pdf.setFont(FONT, 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(148, 163, 184);
    pdf.text(TX.pageUncaptured, MARGIN + 3, startContentY() + 10);
    pdf.setTextColor(15, 23, 42);
    return { scale: 0, failed: true };
  }
  const fit = Math.min(1, availW / (cw / 3.7795), availH / (ch / 3.7795));
  const widthFit = Math.min(1, availW / (cw / 3.7795));
  // A long report squeezed onto ONE sheet came out too small to read (charts
  // the size of a stamp). When one sheet would push it below the readable
  // scale, keep the width-fit scale and continue on further sheets, breaking
  // at the bottom edge of a grid row so no chart is cut in two.
  // Judged on SCREEN size: a canvas captured at 1.6x and drawn at 47% of its
  // pixels prints at ~75% of what the reader saw — readable. The old check
  // compared canvas pixels and warned "shrunk to 47%" on a legible page.
  if (snapshotCanvas && fit * SNAPSHOT_CAPTURE_SCALE < SNAPSHOT_SMALL_SCALE && widthFit > fit) {
    const rootTop = root.getBoundingClientRect().top;
    const pxPerCss = ch / Math.max(1, root.scrollHeight);
    // A sheet ends at the bottom of a row — never right under a section
    // heading (it would sit alone at the foot of the sheet, its content on the
    // next): the heading's top is the cut instead, so it opens the next sheet.
    const items = Array.from(root.querySelectorAll<HTMLElement>('.react-grid-item'));
    const headingTops = items.filter(isHeadingItem)
      .map((el) => Math.round((el.getBoundingClientRect().top - rootTop) * pxPerCss));
    const cuts = [
      ...items.filter((el) => !isHeadingItem(el))
        .map((el) => Math.round((el.getBoundingClientRect().bottom - rootTop) * pxPerCss)),
      ...headingTops,
    ]
      .filter((y) => y > 0 && y < ch)
      .sort((a, b) => a - b);
    const plan = planSnapshotSheets(
      ch, cuts, (s) => Math.floor((availH / s) * 3.7795), widthFit,
      SNAPSHOT_SMALL_SCALE / SNAPSHOT_CAPTURE_SCALE,
    );
    const drawScale = plan.scale;
    const drawW = (cw / 3.7795) * drawScale;
    const x = MARGIN + Math.max(0, (availW - drawW) / 2);
    let sheet = 0;
    for (const [from, to] of plan.sheets) {
      const slice = document.createElement('canvas');
      slice.width = cw;
      slice.height = to - from;
      slice.getContext('2d')?.drawImage(snapshotCanvas, 0, from, cw, to - from, 0, 0, cw, to - from);
      if (sheet > 0) {
        pdf.addPage(opts.format, opts.orientation);
        drawPageHeader(pdf, opts, page, ctx.pageNo, ctx.total);
      }
      pdf.addImage(slice.toDataURL('image/jpeg', 0.85), 'JPEG', x, startContentY(), drawW, ((to - from) / 3.7795) * drawScale);
      sheet += 1;
    }
    return { scale: drawScale * SNAPSHOT_CAPTURE_SCALE, failed: false };
  }
  const drawW = (cw / 3.7795) * fit;
  const drawH = (ch / 3.7795) * fit;
  const x = MARGIN + Math.max(0, (availW - drawW) / 2);
  pdf.addImage(dataUrl, 'JPEG', x, startContentY(), drawW, drawH);
  return { scale: fit * SNAPSHOT_CAPTURE_SCALE, failed: false };
}

/**
 * Draw the sheets the user arranged.
 *
 * Every tile is captured at whatever size it happens to have on screen and then
 * placed into its box on the sheet **preserving aspect ratio** (letterboxed, not
 * stretched). Re-sizing each tile to its target box before capturing would fill
 * the box exactly, but it means a layout pass plus a settle wait per tile — the
 * kind of cost that made the old per-tile exporter slow. Aspect-correct and fast
 * beats pixel-perfect and slow here; a distorted chart is a worse outcome than a
 * little white space.
 *
 * Tiles are found by `data-chart-id`, which every dashboard surface already sets,
 * so this works on the builder, the public report and the embed alike.
 */
async function drawArrangedSheets(
  pdf: jsPDF,
  opts: PdfExportOptions,
  tilesByChartId: Map<number, HTMLElement>,
  report: (p: PdfProgress) => void,
  warnings: PdfExportWarning[],
): Promise<void> {
  const plan = opts.plan!;
  const g = geom(pdf);
  const usableW = g.usableW;
  const usableH = g.bottom - startContentY();
  let placed = 0;
  const totalTiles = Math.max(1, plan.sheets.reduce((n, sh) => n + sh.tiles.length, 0));

  for (let si = 0; si < plan.sheets.length; si++) {
    const sheet = plan.sheets[si];
    if (si > 0) pdf.addPage(opts.format, opts.orientation);
    drawPageHeader(
      pdf,
      opts,
      { name: sheet.title || TX.sheet(si + 1), getRoot: async () => null },
      si + 1,
      plan.sheets.length,
    );

    for (const tile of sheet.tiles) {
      const el = tilesByChartId.get(tile.chartId);
      const box = tileBoxMm(tile, plan, usableW, usableH);
      const x0 = MARGIN + box.x;
      const y0 = startContentY() + box.y;
      placed += 1;
      report({
        phase: 'capture',
        ratio: 0.05 + 0.9 * (placed / totalTiles),
        message: TX.pSheetTile(si + 1, plan.sheets.length, placed, totalTiles),
      });

      if (!el) {
        warnings.push({
          page: sheet.title || TX.sheet(si + 1),
          chart: TX.chartN(tile.chartId),
          reason: TX.notFoundOnReport,
        });
        continue;
      }
      try {
        const canvas = await html2canvas(el, { scale: 1.5, useCORS: true, logging: false, backgroundColor: '#ffffff', onclone: legibleClone });
        const aspect = canvas.height / canvas.width;
        // Letterbox: fit inside the box, keep the shape, centre what is left.
        let w = box.w;
        let h = w * aspect;
        if (h > box.h) { h = box.h; w = h / aspect; }
        pdf.addImage(
          canvas.toDataURL('image/jpeg', 0.85),
          'JPEG',
          x0 + (box.w - w) / 2,
          y0 + (box.h - h) / 2,
          w,
          h,
        );
      } catch {
        warnings.push({
          page: sheet.title || TX.sheet(si + 1),
          chart: tileTitle(el) || TX.chartN(tile.chartId),
          reason: TX.captureRefused,
        });
      }
    }
  }
}

/**
 * Small pictures of each tile, for the export arranger.
 *
 * Arranging by chart NAME alone means guessing what you are moving, so the
 * arranger shows the real thing. Capture is deliberately cheap (≈240px wide,
 * JPEG) and one-off: it walks the pages the caller offers, waits for the same
 * readiness signal the exporter uses, and snapshots whatever tiles are there.
 * A tile that fails to capture simply has no thumbnail — the arranger falls back
 * to its name + type rather than blocking.
 */
export async function captureTileThumbnails(
  pages: PdfPageSource[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i, pages.length);
    const root = await pages[i].getRoot();
    if (!root) continue;
    await waitForRenderReady(root, { timeoutMs: 12000 });
    const tiles = [...root.querySelectorAll<HTMLElement>('[data-chart-id]')];
    for (const el of tiles) {
      const id = Number(el.getAttribute('data-chart-id'));
      if (!Number.isFinite(id) || out.has(id)) continue;
      const box = (el.closest('.react-grid-item') as HTMLElement) || el;
      try {
        const w = box.getBoundingClientRect().width || 400;
        const canvas = await html2canvas(box, {
          scale: Math.min(0.5, 240 / Math.max(1, w)),
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
          onclone: legibleClone,
        });
        out.set(id, canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        /* no thumbnail for this tile — the arranger shows its name instead */
      }
    }
  }
  onProgress?.(pages.length, pages.length);
  return out;
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function exportDashboardPdf(opts: PdfExportOptions): Promise<'opened' | 'saved'> {
  if (opts.pages.length === 0) return 'saved';
  TX = String(opts.locale ?? '').startsWith('en') ? PDF_TEXT.en : PDF_TEXT.vi;
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
  report({ phase: 'prepare', ratio: 0.02, message: TX.pPreparing });

  // 'custom' walks every selected page ONCE to collect the tile elements the plan
  // refers to (a plan may mix charts from several pages onto one sheet), then
  // draws the sheets. It deliberately does not use the per-page pagination below.
  if (opts.layout === 'custom' && opts.plan) {
    const tilesByChartId = new Map<number, HTMLElement>();
    for (let i = 0; i < opts.pages.length; i++) {
      const page = opts.pages[i];
      report({
        phase: 'page',
        ratio: 0.02 + 0.03 * (i / Math.max(1, opts.pages.length)),
        message: TX.pLoadingPage(i + 1, opts.pages.length, page.name),
      });
      const root = await page.getRoot();
      if (!root) continue;
      await waitForRenderReady(root);
      root.querySelectorAll<HTMLElement>('[data-chart-id]').forEach((el) => {
        const id = Number(el.getAttribute('data-chart-id'));
        const tile = (el.closest('.react-grid-item') as HTMLElement) || el;
        if (Number.isFinite(id) && !tilesByChartId.has(id)) tilesByChartId.set(id, tile);
      });
      // Report elements (header, headings, text, insights) are placed under
      // their plan key — they used to be missing from an arranged export.
      root.querySelectorAll<HTMLElement>('[data-tile-kind="widget"][data-tile-id]').forEach((el) => {
        const key = planKeyForElement(Number(el.getAttribute('data-tile-id')));
        const tile = (el.closest('.react-grid-item') as HTMLElement) || el;
        if (Number.isFinite(key) && key !== 0 && !tilesByChartId.has(key)) tilesByChartId.set(key, tile);
      });
    }
    await drawArrangedSheets(pdf, opts, tilesByChartId, report, warnings);
    report({ phase: 'finalize', ratio: 0.96, message: TX.pMaking });
    drawWarnings(pdf, opts, warnings);
    stampFooters(pdf, opts.title, TX.arrangedNote);
    const done = downloadPdf(pdf, opts.filename, opts.previewWindow);
    report({ phase: 'done', ratio: 1, message: TX.pDoneSaved });
    return done;
  }

  let minPrintScale = Infinity;
  for (let i = 0; i < opts.pages.length; i++) {
    const page = opts.pages[i];
    if (i > 0) pdf.addPage(opts.format, opts.orientation);
    let pageNo = i + 1;
    drawPageHeader(pdf, opts, page, pageNo, total);
    let y = startContentY();

    const pageBase = i / total;
    report({ phase: 'page', ratio: 0.05 + 0.9 * pageBase, message: TX.pLoadingPage(i + 1, total, page.name) });
    const root = await page.getRoot();
    if (!root) continue;

    // Readiness protocol — never capture on a timer. See waitForRenderReady.
    const ready = await waitForRenderReady(root, {
      onWait: (elapsed) => {
        if (elapsed > 1200) {
          report({
            phase: 'page',
            ratio: 0.05 + 0.9 * pageBase,
            message: TX.pWaitingPage(i + 1, total, Math.round(elapsed / 1000)),
          });
        }
      },
    });
    if (!ready.ready) {
      // Not fatal: capture what's there, but tell the reader the page may be
      // incomplete rather than pretending everything rendered.
      warnings.push({
        page: page.name || `Trang ${i + 1}`,
        chart: TX.wholePage,
        reason: TX.pageNotReady(Math.round(ready.waitedMs / 1000)),
      });
    }

    // SNAPSHOT (default): the whole page as one picture on one sheet. No tile
    // walk, no table extraction — that is where the time went.
    if ((opts.layout ?? 'snapshot') === 'snapshot') {
      report({
        phase: 'capture',
        ratio: 0.05 + 0.9 * (pageBase + 0.5 / total),
        message: TX.pCapturingPage(i + 1, total, page.name),
      });
      const shot = await drawPageSnapshot(pdf, root, opts, page, { pageNo, total });
      minPrintScale = Math.min(minPrintScale, shot.failed ? 0 : shot.scale);
      if (shot.failed) {
        warnings.push({
          page: page.name || `Trang ${i + 1}`,
          chart: TX.wholePage,
          reason: TX.pageNotCaptured,
        });
      } else if (shot.scale > 0 && shot.scale < SNAPSHOT_SMALL_SCALE) {
        // Say it rather than shipping a sheet nobody can read.
        warnings.push({
          page: page.name || `Trang ${i + 1}`,
          chart: TX.wholePage,
          kind: 'note',
          reason: TX.pageScaled(Math.round(shot.scale * 100)),
        });
      }
      continue;
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

    const layout: PdfLayoutMode = opts.layout ?? 'snapshot';
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
        message: TX.pPageTile(i + 1, total, Math.min(doneTiles + 1, tiles.length), tiles.length, label),
      });
    };

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      // Keep a section heading with what it introduces: if the heading and (even
      // squeezed) the row after it cannot share this sheet, start the heading on
      // the next one instead of leaving it alone at the foot of this one.
      const next = rows[ri + 1];
      if (next && row.length > 0 && row.every(isHeadingItemTile) && y > startContentY() + 1) {
        const g = geom(pdf);
        const need = estimateRowMm(row, g, fit) + ROW_GAP_Y + estimateRowMm(next, g, fit) * SQUEEZE_MIN;
        if (y + need > g.bottom && estimateRowMm(next, g, fit) <= g.bottom - startContentY()) {
          pdf.addPage(opts.format, opts.orientation);
          pageNo++;
          drawPageHeader(pdf, opts, page, pageNo, total);
          y = startContentY();
        }
      }
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
            chart: tileTitle(t) || TX.chart,
            reason: TX.captureRefused,
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

  report({ phase: 'finalize', ratio: 0.96, message: TX.pMaking });
  // What the file IS, for the e2e gate (as __APPBI_RENDER_AUDIT__ is for
  // the page): sheets, the smallest print scale (screen size = 1), warnings.
  try {
    (window as any).__APPBI_LAST_EXPORT__ = {
      pages: pdf.getNumberOfPages(),
      minPrintScale: Number.isFinite(minPrintScale) ? minPrintScale : null,
      warnings: warnings.map((w) => ({ kind: w.kind ?? 'incomplete', chart: w.chart, reason: w.reason })),
    };
  } catch { /* no window (tests) */ }
  drawWarnings(pdf, opts, warnings);
  stampFooters(
    pdf,
    opts.title,
    // A snapshot prints what the report shows, so a long table is truncated by
    // design. Stamping it means the reader can tell without asking.
    (opts.layout ?? 'snapshot') === 'snapshot' ? (opts.labels?.snapshotNote ?? TX.snapshotNote) : undefined,
  );
  const result = downloadPdf(pdf, opts.filename, opts.previewWindow);
  report({
    phase: 'done',
    ratio: 1,
    message: result === 'opened' ? TX.pDoneOpened : TX.pDoneSaved,
  });
  return result;
}

/**
 * Deliver the finished PDF: save it to disk, and — only when the caller handed
 * us a pre-opened tab — also show it there.
 *
 * Returns 'opened' when the PDF is showing in a tab, 'saved' when it was only
 * downloaded. The download always happens, so the user ends up with a real file
 * either way.
 *
 * The preview tab is OFF by default (`PDF_PREVIEW_TAB_ENABLED`): a reader who
 * clicks Export wants a file, and the extra tab only ever showed a
 * `blob:…uuid` address that looks like a broken link. We therefore never call
 * `window.open` from here on our own initiative — with the switch off,
 * `previewWindow` is null and this is a pure download.
 *
 * Why a `blob:` URL: it carries the bytes verbatim, so the anchor `download`
 * saves the complete file with the right `.pdf` name. (A multi-MB `data:` URL
 * silently fails or truncates in Chrome, which is what made big full-table
 * dashboards download an unopenable file.)
 */
function downloadPdf(pdf: jsPDF, filename: string, previewWindow?: Window | null): 'opened' | 'saved' {
  const name = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
  const blob: Blob = pdf.output('blob');
  const url = URL.createObjectURL(blob);

  // 1) Optional: show it in the tab the caller opened inside the click. Never
  //    open one from here — that is what produced the surprise blob: tab.
  let opened = false;
  try {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.location.href = url;
      opened = true;
    }
  } catch {
    opened = false;
  }

  // 2) Save it to disk with the correct filename — the primary delivery. The
  //    anchor is appended to <body> before click (Edge/Firefox ignore
  //    `download` on a detached anchor).
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
    /* nothing else we can do — the caller reports the failure */
  }

  // Revoke late — a preview tab (when enabled) needs the URL to finish rendering.
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return opened ? 'opened' : 'saved';
}
