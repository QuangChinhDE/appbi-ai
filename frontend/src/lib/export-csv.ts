/**
 * Client-side CSV export for chart data (public / embed "Export data").
 *
 * Deliberately dependency-free and 100% client-side: it serializes rows the
 * browser ALREADY holds (the chart's rendered result, already permission- and
 * filter-scoped server-side) — so exporting cannot expose anything beyond what
 * the chart displays, and it never touches the live report (read-only, no
 * re-query). A UTF-8 BOM is prepended so Excel opens Vietnamese diacritics
 * correctly.
 */

/** Serialize one cell. Quotes when needed and neutralizes CSV-injection: a
 *  value that would be interpreted as a spreadsheet formula (leading = + - @
 *  tab or CR) is prefixed with an apostrophe so opening the file can't execute
 *  exported data. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Ordered union of column keys across rows — first row sets the order, later
 *  rows contribute any extra keys (rows can be sparse). */
export function collectRowColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); cols.push(key); }
    }
  }
  return cols;
}

/** Build a CSV string. `headerLabel` maps a raw column key → friendly header
 *  (so the file matches the labels the viewer sees). CRLF line endings for
 *  broad spreadsheet compatibility. */
export function rowsToCsv(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  headerLabel?: (col: string) => string,
): string {
  const header = columns.map((c) => csvCell(headerLabel ? headerLabel(c) : c)).join(',');
  const body = rows
    .map((row) => columns.map((c) => csvCell(row?.[c])).join(','))
    .join('\r\n');
  return body ? `${header}\r\n${body}` : header;
}

/** Turn a chart title into a safe .csv filename (keeps Vietnamese letters, drops
 *  filesystem-illegal characters). */
export function csvFilename(name: string | null | undefined, fallback = 'chart-data'): string {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${(base || fallback).slice(0, 120)}.csv`;
}

/** Trigger a browser download of a CSV string (UTF-8 BOM for Excel). */
export function downloadCsv(filename: string, csv: string): void {
  const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM → Excel reads UTF-8 (Vietnamese OK)
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
