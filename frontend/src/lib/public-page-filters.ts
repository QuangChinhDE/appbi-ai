import type { BaseFilter } from './filters';
import type { DashboardPageConfig } from '@/types/api';

/**
 * Public-link filter resolution FOR A GIVEN PAGE — extracted as a pure function
 * so it has exactly ONE implementation.
 *
 * Why this exists (bug it fixes): the resolution used to live only inside
 * PublicDashboardView's "slicer seed" effect, which recomputes on `activePageId`
 * and publishes the result to state/refs. PDF export switches pages
 * programmatically and fetches data in the SAME tick, before React re-renders —
 * so the fetch read page A's `pageHiddenFilters` while asking for page B's
 * charts. Page B then exported with page A's page-scope filters: wrong numbers,
 * and a scope leak (a page-scope filter is a hard bound, see
 * docs/filter-semantics.md). Any caller that needs a page's filters WITHOUT
 * being on that page must use this function instead of reading the live state.
 *
 * Taxonomy (PBI parity):
 *   • controlSeed   — what the viewer SEES and can change: report-level slicers
 *     (`slicers_config`, scope-visible on this page) + `filters_config` entries
 *     with publicMode='visible' + legacy `public_filters_config` + this page's
 *     own slicers (`pages_config[i].slicers`).
 *   • hiddenFilters — silent WHERE for this page: "Filters on this page"
 *     (`pages_config[i].filters`, publicMode='visible' only — locked/hidden ones
 *     are enforced server-side from the link config) + report slicers whose
 *     custom page-scope says "filter here but don't show a control here".
 */
export interface PublicPageFilterContext {
  controlSeed: BaseFilter[];
  hiddenFilters: BaseFilter[];
}

type PageLike = DashboardPageConfig & { slicers?: unknown; filters?: unknown };

/** A report-level slicer with `scope='custom'` only shows a control on the pages
 *  its pageScope marks visible; 'all'/unset shows everywhere. */
function slicerVisibleOnPage(slicer: unknown, pageId: string): boolean {
  const scope = (slicer as { scope?: string } | null)?.scope || 'all';
  if (scope === 'custom') {
    return Boolean((slicer as { pageScope?: Record<string, { visible?: boolean }> })?.pageScope?.[pageId]?.visible);
  }
  return true;
}

/** Same slicer, but "does it constrain this page's data" (can be true while the
 *  control is hidden → the value applies silently). */
function slicerFiltersOnPage(slicer: unknown, pageId: string): boolean {
  const scope = (slicer as { scope?: string } | null)?.scope || 'all';
  if (scope === 'custom') {
    return Boolean((slicer as { pageScope?: Record<string, { filter?: boolean }> })?.pageScope?.[pageId]?.filter);
  }
  return true;
}

function asFilterArray(value: unknown): BaseFilter[] {
  return Array.isArray(value) ? (value as BaseFilter[]) : [];
}

function publicVisibleOnly(entries: BaseFilter[]): BaseFilter[] {
  return entries.filter((f) => ((f as { publicMode?: string }).publicMode ?? 'visible') === 'visible');
}

export function resolvePublicPageFilterContext(
  dashboard: Record<string, unknown> | null | undefined,
  pages: DashboardPageConfig[],
  pageId: string | null | undefined,
): PublicPageFilterContext {
  if (!dashboard) return { controlSeed: [], hiddenFilters: [] };
  const pid = pageId ?? '';

  const allConfigSlicers = asFilterArray(dashboard.slicers_config);
  const slicersFromConfig = allConfigSlicers.filter((s) => slicerVisibleOnPage(s, pid));
  const silentScopedSlicers = allConfigSlicers.filter(
    (s) => !slicerVisibleOnPage(s, pid) && slicerFiltersOnPage(s, pid),
  );

  const filtersAsSlicers = publicVisibleOnly(asFilterArray(dashboard.filters_config));

  // Legacy links (pre slicers_config) only ship public_filters_config.
  const legacyPublicConfig =
    slicersFromConfig.length === 0 && filtersAsSlicers.length === 0
      ? asFilterArray(dashboard.public_filters_config)
      : [];

  const page = pages.find((p) => p.id === pid) as PageLike | undefined;
  const rawPageSlicers = asFilterArray(page?.slicers);
  const rawPageFilters = publicVisibleOnly(asFilterArray(page?.filters));

  return {
    controlSeed: [...slicersFromConfig, ...filtersAsSlicers, ...legacyPublicConfig, ...rawPageSlicers],
    hiddenFilters: [...rawPageFilters, ...silentScopedSlicers],
  };
}

/**
 * Merge a page's control seed with the viewer's current selections, keyed by
 * fieldKey — the same rule the live seed effect uses when the viewer switches
 * pages (their edits win for fields the new page still offers). Used by export
 * to reconstruct "what page B would show right now" without touching state.
 */
export function mergeSeedWithViewerSelections(
  controlSeed: BaseFilter[],
  viewerApplied: BaseFilter[],
): BaseFilter[] {
  const seedByKey = new Map<string, BaseFilter>();
  for (const f of controlSeed) seedByKey.set(f.fieldKey ?? f.field, f);
  const existingByKey = new Map<string, BaseFilter>();
  for (const f of viewerApplied) existingByKey.set(f.fieldKey ?? f.field, f);
  const merged: BaseFilter[] = [];
  for (const [key, seedFilter] of seedByKey.entries()) {
    merged.push(existingByKey.get(key) ?? seedFilter);
  }
  return merged;
}
