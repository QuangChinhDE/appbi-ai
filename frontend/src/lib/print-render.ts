import type { BaseFilter } from './filters';

/**
 * Contract between the server-side render worker and the public report page.
 *
 * The worker (headless Chromium, `backend/app/scripts/pdf_worker.py`) opens
 *
 *     /d/<token>?print=1&page=<pageId>&filters=<base64 JSON>
 *
 * once per dashboard page and prints it. Keeping the contract in one tiny module
 * means the query-string shape is defined in exactly one place instead of being
 * re-parsed ad hoc on both sides.
 *
 * Filters travel base64-encoded because a viewer's slicer selection can contain
 * commas, quotes and Vietnamese text; base64 of the UTF-8 JSON survives every
 * proxy and shell in between untouched.
 */
export interface PrintRenderOptions {
  /** Dashboard page to render. Empty → whatever the report opens on. */
  pageId: string | null;
  /** Viewer slicer/filter selections to re-apply before printing. */
  filters: BaseFilter[];
}

function decodeFilters(raw: string | null): BaseFilter[] {
  if (!raw) return [];
  try {
    const json = decodeURIComponent(escape(window.atob(raw.replace(/-/g, '+').replace(/_/g, '/'))));
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as BaseFilter[]) : [];
  } catch {
    // A malformed filter payload must not blank the report: render it unfiltered
    // rather than crashing the worker's page.
    return [];
  }
}

/** Returns null when this is a NORMAL page view (no print rendering requested). */
export function parsePrintRenderOptions(search: string): PrintRenderOptions | null {
  const params = new URLSearchParams(search || '');
  if (params.get('print') !== '1') return null;
  return {
    pageId: params.get('page') || null,
    filters: decodeFilters(params.get('filters')),
  };
}

/** Encode filters for the worker's URL (used by the job creator / tests). */
export function encodePrintFilters(filters: BaseFilter[]): string {
  const json = JSON.stringify(filters ?? []);
  return window.btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
