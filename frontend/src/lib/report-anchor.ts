/**
 * One logical report read = one relative-date anchor.
 *
 * A dashboard/public report loads its tiles as separate requests. If each tile
 * let the server resolve "last 30 days" against its own clock, a load that
 * straddles midnight would mix windows across tiles. So a report view stamps ONE
 * instant when a load begins (mount, manual refresh, a filter change that
 * refetches every tile) and every tile request carries it as `X-AppBI-As-Of`;
 * the backend resolves relative presets against that single anchor
 * (time_contract.current_report_date). Absent a stamp, the backend falls back to
 * now() in the app timezone — so non-report callers are unaffected.
 */
let anchor: string | null = null;
// True while an EXTERNALLY FIXED anchor is active (a PDF export's ?asOf). A fixed
// anchor is immutable for the whole export: filter/page lifecycle re-stamps must
// not "freshen" it — only clearReportAnchor() (leaving the report) ends it.
let fixed = false;

/** Begin a new logical report read: stamp one instant all its tiles will share.
 *  No-op while a fixed export anchor is active. */
export function stampReportAnchor(): string {
  if (fixed && anchor) return anchor;
  anchor = new Date().toISOString();
  return anchor;
}

/** Use a given instant as the anchor (e.g. the PDF worker's per-export as-of, so
 *  every page of one export shares one window) — it is then FIXED until cleared.
 *  Falsy → stamp a fresh (non-fixed) one. */
export function setReportAnchor(iso: string | null | undefined): string {
  if (iso) {
    anchor = String(iso);
    fixed = true;
  } else {
    fixed = false;
    anchor = new Date().toISOString();
  }
  return anchor;
}

/** End the report read: requests made after leaving a report (Explore, Datasets,
 *  Datasources…) must not inherit its relative-date anchor. */
export function clearReportAnchor(): void {
  anchor = null;
  fixed = false;
}

/** The current report read's anchor (ISO-8601, UTC), or null if none is active. */
export function reportAnchor(): string | null {
  return anchor;
}

/** Header object to spread onto a tile request, empty when no read is active. */
export function reportAnchorHeader(): Record<string, string> {
  return anchor ? { 'X-AppBI-As-Of': anchor } : {};
}
