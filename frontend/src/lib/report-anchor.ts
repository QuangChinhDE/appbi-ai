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

/** Begin a new logical report read: stamp one instant all its tiles will share. */
export function stampReportAnchor(): string {
  anchor = new Date().toISOString();
  return anchor;
}

/** The current report read's anchor (ISO-8601, UTC), or null if none is active. */
export function reportAnchor(): string | null {
  return anchor;
}

/** Header object to spread onto a tile request, empty when no read is active. */
export function reportAnchorHeader(): Record<string, string> {
  return anchor ? { 'X-AppBI-As-Of': anchor } : {};
}
