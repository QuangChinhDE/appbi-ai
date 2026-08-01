import type { PdfOrientation, PdfPageSize } from './export-pdf';

/**
 * "Arrange it yourself" export layout.
 *
 * A plan describes SHEETS of paper and where each chart sits on them. It exists
 * only to drive an export: nothing here is ever written back to
 * `dashboard_charts.layout` or `pages_config`, so rearranging a report for a
 * meeting handout cannot disturb the dashboard everyone else is looking at. That
 * separation is the whole point of the feature, which is why the plan lives in
 * its own module with its own types rather than reusing the dashboard's layout
 * shape.
 *
 * Coordinates are a 12-column grid, like the dashboard, so the numbers are
 * familiar and snapping is trivial. Rows are sized so that a full sheet is
 * exactly `sheetRows(format, orientation)` rows tall — that is what makes "what
 * you arranged" equal "what gets printed".
 */

export const SHEET_COLS = 12;

export interface PlanTile {
  chartId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanSheet {
  id: string;
  title?: string;
  tiles: PlanTile[];
}

export interface ExportLayoutPlan {
  format: PdfPageSize;
  orientation: PdfOrientation;
  sheets: PlanSheet[];
}

/** A chart that can be placed, as shown in the tray. */
export interface PlanCandidate {
  chartId: number;
  title: string;
  chartType?: string;
  pageId?: string;
  pageName?: string;
  /** Where it sits on the dashboard, in the dashboard's own grid units. Used to
   *  seed the arranger with the layout people already know. */
  layout?: { x: number; y: number; w: number; h: number };
  /** Small PNG of the tile as it looks on the report (see captureTileThumbnails). */
  thumbnail?: string;
}

/** Paper aspect (width / height) for the grid geometry. */
export function paperAspect(format: PdfPageSize, orientation: PdfOrientation): number {
  const sizes: Record<PdfPageSize, [number, number]> = {
    a4: [297, 210],
    a3: [420, 297],
    letter: [279, 216],
  };
  const [long, short] = sizes[format] ?? sizes.a4;
  return orientation === 'portrait' ? short / long : long / short;
}

/**
 * How many grid rows make one sheet.
 *
 * Derived from the paper aspect so a 12-column grid stays roughly square-celled:
 * a cell that is much taller than it is wide makes every chart look squashed on
 * paper even though the arranger looked fine.
 */
export function sheetRows(format: PdfPageSize, orientation: PdfOrientation): number {
  const aspect = paperAspect(format, orientation);
  return Math.max(4, Math.round(SHEET_COLS / aspect));
}

/** Minimum size a chart type needs to stay readable on paper. */
export function minTileSize(chartType?: string): { w: number; h: number } {
  const t = String(chartType || '').toUpperCase();
  if (t === 'KPI' || t === 'CARD') return { w: 2, h: 1 };
  if (t === 'TABLE' || t === 'MATRIX') return { w: 6, h: 3 };
  if (t === 'PIE' || t === 'DONUT' || t === 'GAUGE') return { w: 3, h: 3 };
  return { w: 4, h: 3 };
}

let sheetSeq = 0;
export function newSheetId(): string {
  sheetSeq += 1;
  return `sheet-${sheetSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * First-fit arrangement: two charts per row, KPI-ish tiles four per row, filling
 * sheets in order. Used for the initial state and for the "Tidy up" button, so a
 * user who drags things into a mess always has one click back to something
 * printable.
 */
export function autoArrange(
  candidates: PlanCandidate[],
  format: PdfPageSize,
  orientation: PdfOrientation,
): PlanSheet[] {
  const rows = sheetRows(format, orientation);
  const sheets: PlanSheet[] = [];
  let sheet: PlanSheet = { id: newSheetId(), tiles: [] };
  let x = 0;
  let y = 0;
  let rowH = 0;

  const pushSheet = () => {
    sheets.push(sheet);
    sheet = { id: newSheetId(), tiles: [] };
    x = 0; y = 0; rowH = 0;
  };

  for (const c of candidates) {
    const isKpi = /KPI|CARD/i.test(c.chartType || '');
    const w = isKpi ? 3 : 6;
    const h = isKpi ? 2 : 4;
    if (x + w > SHEET_COLS) { x = 0; y += rowH; rowH = 0; }
    if (y + h > rows) { pushSheet(); }
    sheet.tiles.push({ chartId: c.chartId, x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  if (sheet.tiles.length || sheets.length === 0) sheets.push(sheet);
  return sheets;
}

/**
 * Seed the arranger with the dashboard as it actually looks: one sheet per
 * dashboard page, each chart where the author put it.
 *
 * This matters more than it sounds. An "optimal" first-fit arrangement forces
 * the user to rebuild a layout they had already designed, on a screen where they
 * can only see titles; starting from their own report means the common case —
 * "print what I have, just move these two things" — is two drags instead of
 * twenty. The dashboard grid is finer than the sheet grid (36 vs 12 columns), so
 * coordinates are scaled down, and each page is scaled vertically to fit its
 * sheet: relative composition survives, the sheet never overflows.
 */
export function planFromDashboard(
  candidates: PlanCandidate[],
  pages: Array<{ id: string; name?: string }>,
  dashboardCols: number,
  format: PdfPageSize,
  orientation: PdfOrientation,
): PlanSheet[] {
  const rows = sheetRows(format, orientation);
  const colScale = SHEET_COLS / Math.max(1, dashboardCols);
  const sheets: PlanSheet[] = [];

  for (const page of pages) {
    const onPage = candidates.filter((c) => c.pageId === page.id && c.layout);
    if (!onPage.length) continue;
    const pageBottom = Math.max(1, ...onPage.map((c) => (c.layout!.y + c.layout!.h)));
    // Scale the page's vertical extent onto the sheet; never magnify, so a short
    // page keeps its proportions instead of being stretched to fill the paper.
    const rowScale = Math.min(1, rows / pageBottom);
    const tiles: PlanTile[] = onPage.map((c) => {
      const l = c.layout!;
      // Never seed a tile below its readable size: scaling a 36-column dashboard
      // onto a 12-column sheet shrinks small tiles into "too small to read"
      // warnings, so the arranger opened covered in orange the first time.
      const min = minTileSize(c.chartType);
      const x = Math.max(0, Math.min(SHEET_COLS - 1, Math.round(l.x * colScale)));
      const w = Math.max(min.w, Math.min(SHEET_COLS - x, Math.round(l.w * colScale)));
      const y = Math.max(0, Math.round(l.y * rowScale));
      const h = Math.max(min.h, Math.min(rows, Math.round(l.h * rowScale)));
      return { chartId: c.chartId, x: Math.min(x, SHEET_COLS - w), y, w, h };
    });
    // Re-flow in READING ORDER with a cursor. Keeping the original coordinates
    // cannot work once tiles are grown to their readable minimum: two tiles that
    // shared a row on a 36-column dashboard no longer fit one on a 12-column
    // sheet, and the leftovers hang off the bottom of the paper (which is exactly
    // what blocked the export with "tràn ra ngoài tờ 1"). Packing preserves the
    // order and the relative sizes — the arrangement still reads like the
    // dashboard — and it can never overflow, which is the property that matters
    // when the next thing the user does is press Export.
    const ordered = [...tiles].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let bucket: PlanTile[] = [];
    let cx = 0;
    let cy = 0;
    let rowH = 0;
    let part = 0;
    const flush = () => {
      if (!bucket.length) return;
      part += 1;
      sheets.push({
        id: newSheetId(),
        title: part === 1 ? page.name : `${page.name || ''} (${part})`.trim(),
        tiles: bucket,
      });
      bucket = [];
      cx = 0; cy = 0; rowH = 0;
    };
    for (const tile of ordered) {
      const w = Math.min(SHEET_COLS, tile.w);
      const h = Math.min(rows, tile.h);
      if (cx + w > SHEET_COLS) { cx = 0; cy += rowH; rowH = 0; }
      if (cy + h > rows) flush();
      bucket.push({ ...tile, x: cx, y: cy, w, h });
      cx += w;
      rowH = Math.max(rowH, h);
    }
    flush();
  }

  return sheets.length ? sheets : [{ id: newSheetId(), tiles: [] }];
}

/** Problems worth blocking or warning on before the export runs. */
export interface PlanIssue {
  level: 'warn' | 'error';
  message: string;
}

export function validatePlan(
  plan: ExportLayoutPlan,
  candidates: PlanCandidate[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byId = new Map(candidates.map((c) => [c.chartId, c]));
  const rows = sheetRows(plan.format, plan.orientation);
  const placed = new Set<number>();

  plan.sheets.forEach((sheet, i) => {
    if (!sheet.tiles.length) {
      issues.push({ level: 'warn', message: `Tờ ${i + 1} đang trống — sẽ in ra một trang trắng.` });
    }
    for (const t of sheet.tiles) {
      placed.add(t.chartId);
      const c = byId.get(t.chartId);
      const min = minTileSize(c?.chartType);
      if (t.w < min.w || t.h < min.h) {
        issues.push({
          level: 'warn',
          message: `"${c?.title || `Biểu đồ #${t.chartId}`}" đang nhỏ hơn kích thước dễ đọc (${min.w}×${min.h} ô) — chữ trên giấy sẽ khó đọc.`,
        });
      }
      if (t.y + t.h > rows || t.x + t.w > SHEET_COLS) {
        issues.push({
          level: 'error',
          message: `"${c?.title || `Biểu đồ #${t.chartId}`}" đang tràn ra ngoài tờ ${i + 1}.`,
        });
      }
    }
  });

  // Charts left in the tray are NORMAL here: the arranger offers every chart of
  // the report so you can pull one in from another page, so most of them are
  // expected to stay unplaced. State it as a fact, not as a problem.
  const missing = candidates.filter((c) => !placed.has(c.chartId));
  if (missing.length) {
    issues.push({
      level: 'warn',
      message: `${missing.length} biểu đồ đang ở khay, sẽ không có trong file này.`,
    });
  }
  return issues;
}

/** Millimetre box of a tile on its sheet, given the printable area. */
export function tileBoxMm(
  tile: PlanTile,
  plan: ExportLayoutPlan,
  usableWmm: number,
  usableHmm: number,
  gapMm = 3,
): { x: number; y: number; w: number; h: number } {
  const rows = sheetRows(plan.format, plan.orientation);
  const colW = usableWmm / SHEET_COLS;
  const rowH = usableHmm / rows;
  return {
    x: tile.x * colW + gapMm / 2,
    y: tile.y * rowH + gapMm / 2,
    w: tile.w * colW - gapMm,
    h: tile.h * rowH - gapMm,
  };
}
