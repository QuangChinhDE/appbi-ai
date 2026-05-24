import type { DashboardChart, DashboardChartLayout, DashboardPageConfig } from '@/types/api';

export const DEFAULT_DASHBOARD_PAGE_ID = 'page-1';
export const DEFAULT_DASHBOARD_PAGE_NAME = 'Page 1';

export function createDashboardPageId(): string {
  return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getDefaultDashboardPage(): DashboardPageConfig {
  return {
    id: DEFAULT_DASHBOARD_PAGE_ID,
    name: DEFAULT_DASHBOARD_PAGE_NAME,
  };
}

export function normalizeDashboardPages(
  pages: DashboardPageConfig[] | null | undefined,
): DashboardPageConfig[] {
  const fallback = getDefaultDashboardPage();
  if (!Array.isArray(pages) || pages.length === 0) {
    return [fallback];
  }

  const normalized: DashboardPageConfig[] = [];
  const seenIds = new Set<string>();
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const id = String(page.id ?? '').trim();
    const name = String(page.name ?? '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    // Preserve every authored field (filters, layout overrides, future
    // additions) — only enforce id + a non-empty name. Stripping unknown
    // fields here was the cause of "Filters on this page" cards
    // disappearing right after save: server refetch returned the
    // filters, normalize() threw them away, derived state lost them.
    normalized.push({
      ...page,
      id,
      name: name || `Page ${normalized.length + 1}`,
    });
  }

  return normalized.length > 0 ? normalized : [fallback];
}

export function getDashboardChartPageId(
  layout: Partial<DashboardChartLayout> | Record<string, any> | null | undefined,
): string {
  const pageId = typeof layout?.pageId === 'string' ? layout.pageId.trim() : '';
  return pageId || DEFAULT_DASHBOARD_PAGE_ID;
}

export function getDashboardChartsForPage(
  charts: DashboardChart[] | null | undefined,
  pageId: string,
): DashboardChart[] {
  return (charts ?? []).filter((chart) => getDashboardChartPageId(chart.layout) === pageId);
}

export function getFirstDashboardPageId(
  pages: DashboardPageConfig[] | null | undefined,
): string {
  return normalizeDashboardPages(pages)[0].id;
}

export function ensureDashboardPageId(
  pages: DashboardPageConfig[] | null | undefined,
  pageId: string | null | undefined,
): string {
  const normalizedPages = normalizeDashboardPages(pages);
  if (pageId && normalizedPages.some((page) => page.id === pageId)) {
    return pageId;
  }
  return normalizedPages[0].id;
}
