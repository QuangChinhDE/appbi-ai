'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  AlertTriangle,
  Download,
  Loader2,
  Lock,
  RefreshCw,
  Eye,
  EyeOff,
} from 'lucide-react';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import { DashboardThemeProvider, getDashboardGridMargin } from '@/components/dashboards/DashboardThemeProvider';
import { ReadonlyChartTile } from '@/components/dashboards/ReadonlyChartTile';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  clearPublicSession,
  getPublicSession,
  publicDashboardApi,
  publicSessionRemainingSeconds,
  savePublicSession,
} from '@/lib/api/public';
import {
  ensureDashboardPageId,
  getDashboardChartsForPage,
  normalizeDashboardPages,
  liftLayoutToTop,
  deriveStackedLayout,
} from '@/lib/dashboard-pages';
import { getColumnKey, getFilterDisplayLabel, getFilterKey, type BaseFilter, type ColumnInfo } from '@/lib/filters';
import { usePublicFilterDistinctValues } from '@/hooks/use-public-filter-distinct-values';
import { buildPublicLinkTheme } from '@/lib/public-link-appearance';
import { buildPublicDashboardFilterRuntime } from '@/lib/public-dashboard-runtime';
import type { ChartDataResponse, Dashboard, DashboardChart } from '@/types/api';

// Phase-B5 — coarse-breakpoint responsive grid (see d/[token]/page.tsx).
// lg ≥768 = 12-col authored layout (desktop resize never reflows); xs <768 =
// 1-col stack for mobile/tablet embeds.
const ResponsiveReportGrid = WidthProvider(Responsive);
const REPORT_BREAKPOINTS = { lg: 768, xs: 0 };
const REPORT_COLS = { lg: 12, xs: 1 };

type PageState = 'unknown' | 'loading' | 'password_gate' | 'reauth' | 'loaded' | 'error';

function areFiltersEquivalent(left: BaseFilter | null, right: BaseFilter | null): boolean {
  if (!left || !right) return false;
  return getFilterKey(left) === getFilterKey(right)
    && left.operator === right.operator
    && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }
  return String(value ?? '');
}

function useEmbedHeight() {
  useEffect(() => {
    const report = () => {
      const height = document.documentElement.scrollHeight;
      try {
        window.parent.postMessage({ type: 'appbi:resize', height }, '*');
      } catch {
        // Cross-origin access can be blocked by the browser.
      }
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
}

function EmbedPasswordGate({
  onSubmit,
  error,
  submitting,
  isReauth = false,
}: {
  onSubmit: (password: string) => void;
  error: string | null;
  submitting: boolean;
  isReauth?: boolean;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear">
        <div className="border-b border-[rgb(var(--border-line))] px-5 py-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Lock className="h-4 w-4" />
          </div>
          <p className="text-tiny font-emphasis uppercase tracking-[0.18em] text-text-quaternary">
            Protected embed
          </p>
          <p className="mt-2 text-small font-strong text-text-primary">
            {isReauth ? 'Session expired - re-enter password' : 'Password required'}
          </p>
        </div>
        <div className="space-y-3 px-5 py-5">
          <Input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value) {
                onSubmit(value);
              }
            }}
            placeholder="Enter password"
            autoFocus
            trailingIcon={
              <button
                type="button"
                onClick={() => setShow((current) => !current)}
                className="pointer-events-auto text-text-tertiary hover:text-text-primary"
              >
                {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            }
          />
          {error && (
            <p className="flex items-center gap-1 text-tiny text-danger">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              {error}
            </p>
          )}
          <Button
            variant="primary"
            fullWidth
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            leadingIcon={
              submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />
            }
          >
            {submitting ? 'Verifying...' : isReauth ? 'Continue' : 'Unlock'}
          </Button>
          <p className="text-center text-tiny text-text-quaternary">Sessions last 2 hours</p>
        </div>
      </div>
    </div>
  );
}

function SessionExpiredBanner({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 px-3 pb-3">
      <div className="mx-auto flex max-w-[960px] items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 shadow-linear">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <p className="text-caption font-emphasis text-text-primary">
            Session expired. Re-enter the password to continue viewing.
          </p>
        </div>
        <Button variant="primary" size="xs" onClick={onReauth}>
          Re-authenticate
        </Button>
      </div>
    </div>
  );
}

function getErrorMessage(error: any): string {
  return error?.response?.data?.detail ?? error?.message ?? 'Failed to load chart data.';
}

// Perf (2026-06-10): raised 4 → 8 — matches the public dashboard page after the
// BE per-tile cost dropped (cache-before-SQL-gen, no duplicate BQ dry-run,
// Sheets result cache). 300 req/min endpoint budget keeps 8 concurrent safe.
const CHART_FETCH_CONCURRENCY = 8;

async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export default function EmbedDashboardPage() {
  const params = useParams();
  const token = params.token as string;

  useEmbedHeight();

  const [mounted, setMounted] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<number, ChartDataResponse>>({});
  const [chartErrors, setChartErrors] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartLoadError, setChartLoadError] = useState<string | null>(null);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);
  const [draftViewerFilters, setDraftViewerFilters] = useState<BaseFilter[]>([]);
  const [appliedViewerFilters, setAppliedViewerFilters] = useState<BaseFilter[]>([]);
  // Perf (Fix #10, 2026-06-10) — gate the first chart fetch until default
  // filters are seeded; see the public dashboard page for the full rationale
  // (avoids a throwaway filters=[] BigQuery query per tile on filtered dashboards).
  const [filtersSeeded, setFiltersSeeded] = useState(false);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [visibleChartIds, setVisibleChartIds] = useState<Set<number>>(() => new Set());
  const [forceVisibleAll, setForceVisibleAll] = useState(false);
  const embedContentRef = useRef<HTMLDivElement>(null);
  const gridSectionRef = useRef<HTMLElement>(null);

  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRequestIdRef = useRef(0);
  const skipNextPageLoadRef = useRef<string | null>(null);
  const skipCrossFilterRefreshRef = useRef<string | null>(null);
  const appliedFilterSignatureRef = useRef(JSON.stringify([] as BaseFilter[]));
  const seededFiltersForTokenRef = useRef<string | null>(null);
  // Phase-15.81 v6 — mirror of appliedViewerFilters for the seed effect
  // (see d/[token]/page.tsx for the rationale).
  const appliedViewerFiltersRef = useRef<BaseFilter[]>([]);
  useEffect(() => {
    appliedViewerFiltersRef.current = appliedViewerFilters;
  }, [appliedViewerFilters]);

  const clearTimer = useCallback(() => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, []);

  const scheduleExpiry = useCallback((linkToken: string) => {
    clearTimer();
    const remaining = publicSessionRemainingSeconds(linkToken);
    if (remaining <= 0) return;
    sessionTimerRef.current = setTimeout(() => {
      clearPublicSession(linkToken);
      setPageState('reauth');
    }, remaining * 1000);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const loadDashboard = useCallback(async (sessionToken?: string) => {
    setPageState('loading');
    setLoading(true);
    setError(null);
    setFiltersSeeded(false);  // Fix #10: re-gate fetch for the (re)loaded dashboard.

    try {
      const nextDashboard = await publicDashboardApi.get(token, sessionToken);
      setDashboard(nextDashboard);
      setPageState('loaded');
      if (sessionToken) {
        scheduleExpiry(token);
      }
    } catch (err: any) {
      if (err?.response?.status === 401) {
        setPageState('password_gate');
      } else {
        setError(getErrorMessage(err));
        setPageState('error');
      }
    } finally {
      setLoading(false);
    }
  }, [scheduleExpiry, token]);

  useEffect(() => {
    if (!token) return;
    setMounted(true);
    const storedSession = getPublicSession(token);
    loadDashboard(storedSession ?? undefined);
  }, [loadDashboard, token]);

  const dashboardPages = useMemo(
    () => normalizeDashboardPages(dashboard?.pages_config),
    [dashboard?.pages_config],
  );
  const activePageId = useMemo(
    () => ensureDashboardPageId(dashboardPages, currentPageId),
    [currentPageId, dashboardPages],
  );
  const visibleDashboardCharts = useMemo(
    () => getDashboardChartsForPage(dashboard?.dashboard_charts, activePageId),
    [activePageId, dashboard?.dashboard_charts],
  );

  useEffect(() => {
    if (currentPageId !== activePageId) {
      setCurrentPageId(activePageId);
    }
  }, [activePageId, currentPageId]);

  useEffect(() => {
    const nextSignature = JSON.stringify(appliedViewerFilters);
    if (appliedFilterSignatureRef.current === nextSignature) {
      return;
    }
    appliedFilterSignatureRef.current = nextSignature;
    setChartData({});
    setChartErrors({});
  }, [appliedViewerFilters]);

  // Phase-15.81 — slicer seed. See d/[token]/page.tsx for the full
  // commentary on the two-mechanism filter taxonomy. Per-page filters
  // from pages_config[i].filters now also merge into the top-bar set
  // and re-seed on page switch (preserving viewer edits).
  useEffect(() => {
    if (!dashboard || !token) return;
    const allPagesSeed = Array.isArray(dashboard.public_filters_config)
      ? (dashboard.public_filters_config as BaseFilter[])
      : [];
    const activePageObj = dashboardPages.find((p) => p.id === activePageId);
    const pageSeed: BaseFilter[] = Array.isArray((activePageObj as any)?.filters)
      ? ((activePageObj as any).filters as BaseFilter[])
      : [];
    const isFirstSeed = seededFiltersForTokenRef.current !== token;
    seededFiltersForTokenRef.current = token;
    const seedByKey = new Map<string, BaseFilter>();
    for (const f of allPagesSeed) seedByKey.set(f.fieldKey ?? f.field, f);
    for (const f of pageSeed) seedByKey.set(f.fieldKey ?? f.field, f);
    const merged: BaseFilter[] = [];
    if (!isFirstSeed) {
      const existingByKey = new Map<string, BaseFilter>();
      // Read from ref (not closure) so page switch right after an edit
      // doesn't drop the just-typed selection.
      for (const f of appliedViewerFiltersRef.current) existingByKey.set(f.fieldKey ?? f.field, f);
      for (const [key, seedFilter] of seedByKey.entries()) {
        const existing = existingByKey.get(key);
        merged.push(existing ?? seedFilter);
      }
    } else {
      for (const f of seedByKey.values()) merged.push(f);
    }
    setDraftViewerFilters(merged);
    setAppliedViewerFilters(merged);
    appliedFilterSignatureRef.current = JSON.stringify(merged);
    setFiltersSeeded(true);  // Fix #10: release the fetch gate.
  }, [dashboard, token, activePageId, dashboardPages]);

  useEffect(() => {
    if (!crossFilterState) return;
    const sourceExists = visibleDashboardCharts.some(
      (dashboardChart) => dashboardChart.chart_id === crossFilterState.sourceChartId,
    );
    if (!sourceExists) {
      setCrossFilterState(null);
    }
  }, [crossFilterState, visibleDashboardCharts]);

  const handleCrossFilterChange = useCallback((sourceChartId: number, filter: BaseFilter | null) => {
    setCrossFilterState((current) => {
      if (!filter) {
        return current?.sourceChartId === sourceChartId ? null : current;
      }

      if (
        current?.sourceChartId === sourceChartId
        && areFiltersEquivalent(current.filter, filter)
      ) {
        return null;
      }

      return {
        sourceChartId,
        filter,
      };
    });
  }, []);

  const fetchChartsForPage = useCallback(async (
    pageId: string,
    sessionToken?: string,
    pageCrossFilterState: typeof crossFilterState = crossFilterState,
    options?: { chartIds?: number[] },
  ) => {
    if (!dashboard) return false;

    const requestId = ++chartRequestIdRef.current;
    const allCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId);
    const targetCharts = options?.chartIds
      ? allCharts.filter((dc) => options.chartIds!.includes(dc.chart_id))
      : allCharts;

    setChartsLoading(true);
    setChartLoadError(null);

    if (!targetCharts.length) {
      setChartsLoading(false);
      setIsApplyingFilters(false);
      return true;
    }

    try {
      // Phase-15.81 v6 — see d/[token]/page.tsx commentary. Embed
      // viewer follows the same model: top-bar set already contains
      // all-pages + active-page filters (handled by the seed effect).
      // Per-visual tileFilters removed; we only add per-link hidden
      // constraints here.
      const linkHiddenFilters: BaseFilter[] = Array.isArray((dashboard as any)?.public_link_hidden_filters)
        ? ((dashboard as any).public_link_hidden_filters as BaseFilter[])
        : [];
      const entries = await runWithConcurrency(
        targetCharts,
        async (dashboardChart) => {
          const baseViewerFilters = pageCrossFilterState?.sourceChartId === dashboardChart.chart_id
            ? appliedViewerFilters
            : pageCrossFilterState
              ? [...appliedViewerFilters, pageCrossFilterState.filter]
              : appliedViewerFilters;
          const requestFilters = [
            ...baseViewerFilters,
            ...linkHiddenFilters,
          ];
          try {
            const data = await publicDashboardApi.getChartData(
              token,
              dashboardChart.chart_id,
              sessionToken,
              requestFilters,
            );
            return { chartId: dashboardChart.chart_id, data, error: null as string | null };
          } catch (err: any) {
            return {
              chartId: dashboardChart.chart_id,
              data: null,
              error: getErrorMessage(err),
              status: err?.response?.status,
            };
          }
        },
        CHART_FETCH_CONCURRENCY,
      );

      if (requestId !== chartRequestIdRef.current) {
        return false;
      }

      const unauthorized = entries.find((entry) => (entry as any).status === 401);
      if (unauthorized) {
        clearPublicSession(token);
        setPageState('reauth');
        return false;
      }

      setChartData((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.data) {
            next[entry.chartId] = entry.data;
          } else {
            delete next[entry.chartId];
          }
        }
        return next;
      });
      setChartErrors((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.error) {
            next[entry.chartId] = entry.error;
          } else {
            delete next[entry.chartId];
          }
        }
        return next;
      });

      if (entries.some((entry) => entry.error)) {
        setChartLoadError('Some embedded charts could not be loaded.');
      }
      if (sessionToken) {
        scheduleExpiry(token);
      }
      return true;
    } finally {
      if (requestId === chartRequestIdRef.current) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
    }
  }, [appliedViewerFilters, crossFilterState, dashboard, dashboardPages, activePageId, scheduleExpiry, token]);

  useEffect(() => {
    if (!dashboard || pageState !== 'loaded') return;
    if (!filtersSeeded) return;  // Fix #10: wait for default filters before first fetch.
    if (skipNextPageLoadRef.current === activePageId) {
      skipNextPageLoadRef.current = null;
      return;
    }
    if (!crossFilterState && skipCrossFilterRefreshRef.current === activePageId) {
      skipCrossFilterRefreshRef.current = null;
      return;
    }
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId);
    const lazyIds = targetCharts
      .map((dc) => dc.chart_id)
      .filter((id) => visibleChartIds.has(id));
    if (lazyIds.length === 0) return;
    const storedSession = getPublicSession(token);
    fetchChartsForPage(activePageId, storedSession ?? undefined, crossFilterState, {
      chartIds: lazyIds,
    });
  }, [activePageId, crossFilterState, dashboard, fetchChartsForPage, filtersSeeded, pageState, token, visibleChartIds]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const { session_token, expires_in } = await publicDashboardApi.auth(token, password);
      savePublicSession(token, session_token, expires_in);
      await loadDashboard(session_token);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        setAuthError('Incorrect password.');
      } else if (status === 410) {
        setAuthError('This shared link has expired.');
      } else {
        setAuthError(getErrorMessage(err));
      }
      setPageState('password_gate');
    } finally {
      setAuthSubmitting(false);
    }
  }, [loadDashboard, token]);

  const handleReauth = useCallback(() => {
    setPageState('password_gate');
    setAuthError(null);
  }, []);

  const handleExportPdf = useCallback(async () => {
    const el = embedContentRef.current;
    if (!el || !dashboard) return;
    setIsExportingPdf(true);
    setForceVisibleAll(true);
    try {
      const safeName = (dashboard.name || 'embedded-dashboard').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
      const storedSession = getPublicSession(token) ?? undefined;

      const ensurePageDataLoaded = async (pageId: string) => {
        const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId);
        const missingIds = targetCharts
          .map((dc) => dc.chart_id)
          .filter((id) => !chartData[id] && !chartErrors[id]);
        if (missingIds.length === 0) return;
        await fetchChartsForPage(pageId, storedSession, null, { chartIds: missingIds });
      };

      if (dashboardPages.length <= 1) {
        await ensurePageDataLoaded(activePageId);
        const { exportElementToPdf } = await import('@/lib/export-pdf');
        await exportElementToPdf(el, `${safeName}.pdf`);
      } else {
        const { captureAndBuildPdf } = await import('@/lib/export-pdf');
        const originalPageId = activePageId;

        await captureAndBuildPdf(dashboardPages.length, async (pageIndex) => {
          const page = dashboardPages[pageIndex];
          setCurrentPageId(page.id);
          await ensurePageDataLoaded(page.id);
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              setTimeout(resolve, 500);
            }));
          });
          return gridSectionRef.current;
        }, `${safeName}.pdf`);

        setCurrentPageId(originalPageId);
      }
    } catch (err) {
      console.error('PDF export failed', err);
    } finally {
      setIsExportingPdf(false);
      setForceVisibleAll(false);
    }
  }, [activePageId, chartData, chartErrors, dashboard, dashboardPages, fetchChartsForPage, token]);

  const filterRuntime = useMemo(
    () => buildPublicDashboardFilterRuntime(visibleDashboardCharts, chartData),
    [chartData, visibleDashboardCharts],
  );
  const activeSessionToken = mounted ? (getPublicSession(token) ?? undefined) : undefined;
  const availableFilterColumns = useMemo<ColumnInfo[]>(
    () => (dashboard?.available_filter_fields?.length
      ? dashboard.available_filter_fields
      : filterRuntime.columns),
    [dashboard?.available_filter_fields, filterRuntime.columns],
  );
  const availableFilterChartCount = useMemo(
    () => (
      dashboard?.available_filter_fields?.length
        ? new Map(
            availableFilterColumns.map((column) => [
              getColumnKey(column),
              column.chartCoverage ?? 0,
            ]),
          )
        : filterRuntime.columnChartCount
    ),
    [availableFilterColumns, dashboard?.available_filter_fields, filterRuntime.columnChartCount],
  );
  const resolvedDistinctValues = usePublicFilterDistinctValues(
    token,
    activeSessionToken,
    availableFilterColumns,
    draftViewerFilters,
    filterRuntime.distinctValues,
  );
  const hasPendingFilterChanges = useMemo(
    () => JSON.stringify(draftViewerFilters) !== JSON.stringify(appliedViewerFilters),
    [appliedViewerFilters, draftViewerFilters],
  );
  const publicTheme = useMemo(
    () => buildPublicLinkTheme(dashboard?.public_link_appearance),
    [dashboard?.public_link_appearance],
  );
  const appearance = publicTheme.appearance;
  const presentationTitle = appearance.headline
    ?? dashboard?.public_link_name
    ?? dashboard?.name
    ?? 'Embedded report';
  const viewerFiltersEnabled = appearance.allow_viewer_filters;
  const showPageTabs = appearance.show_page_tabs && dashboardPages.length > 1;
  const showEmbedHeader = true;
  const showFilterControls = viewerFiltersEnabled && availableFilterColumns.length > 0;
  const showLiveState = Boolean(pendingPageId || crossFilterState || chartLoadError || (chartsLoading && !isApplyingFilters));
  const showControlSurface = true;

  const handleApplyFilters = useCallback(() => {
    setIsApplyingFilters(true);
    setAppliedViewerFilters(draftViewerFilters);
  }, [draftViewerFilters]);

  const handleResetFilters = useCallback(() => {
    setDraftViewerFilters(appliedViewerFilters);
  }, [appliedViewerFilters]);

  const hasSettledPageCache = useCallback((pageId: string) => {
    if (!dashboard) return false;
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId);
    if (targetCharts.length === 0) return true;
    return targetCharts.every((dashboardChart) => (
      Boolean(chartData[dashboardChart.chart_id]) || Boolean(chartErrors[dashboardChart.chart_id])
    ));
  }, [chartData, chartErrors, dashboard]);

  // PDF export now fetches each page's data on-demand inside handleExportPdf,
  // so the embed load path no longer prefetches all pages.

  const allPagesLoaded = useMemo(() => {
    if (!dashboard) return false;
    return hasSettledPageCache(activePageId);
  }, [activePageId, dashboard, hasSettledPageCache]);

  const handlePageSelect = useCallback(async (pageId: string) => {
    if (pageId === activePageId || pendingPageId === pageId) {
      return;
    }

    if (crossFilterState) {
      skipCrossFilterRefreshRef.current = pageId;
    }

    if (hasSettledPageCache(pageId)) {
      skipNextPageLoadRef.current = pageId;
      startTransition(() => setCurrentPageId(pageId));
      return;
    }

    const storedSession = getPublicSession(token) ?? undefined;
    setPendingPageId(pageId);
    const ready = await fetchChartsForPage(pageId, storedSession, null);
    setPendingPageId((current) => (current === pageId ? null : current));
    if (!ready) {
      return;
    }

    skipNextPageLoadRef.current = pageId;
    startTransition(() => setCurrentPageId(pageId));
  }, [activePageId, crossFilterState, fetchChartsForPage, hasSettledPageCache, pendingPageId, token]);

  if (!mounted || pageState === 'unknown' || loading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center bg-surface-0 px-4 py-6">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-6 py-8 text-center shadow-linear-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
          <p className="mt-3 text-caption font-strong text-text-primary">Loading embedded dashboard</p>
          <p className="mt-1 text-tiny text-text-tertiary">Preparing the published report surface.</p>
        </div>
      </div>
    );
  }

  if (pageState === 'password_gate') {
    return (
      <EmbedPasswordGate
        onSubmit={handlePasswordSubmit}
        error={authError}
        submitting={authSubmitting}
        isReauth={false}
      />
    );
  }

  if (pageState === 'error' || !dashboard) {
    return (
      <div className="flex min-h-[240px] items-center justify-center bg-surface-0 px-4 py-6 text-center">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-6 py-8 shadow-linear-sm">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <p className="text-caption font-emphasis text-text-primary">Dashboard unavailable</p>
          <p className="mt-1 text-tiny text-text-tertiary">
            {error ?? 'This link may have expired or been revoked.'}
          </p>
        </div>
      </div>
    );
  }

  const layouts: Layout[] = liftLayoutToTop(
    visibleDashboardCharts.map((dashboardChart) => {
      const layout = dashboardChart.layout;
      return {
        i: dashboardChart.id.toString(),
        x: layout.x || 0,
        y: layout.y || 0,
        w: layout.w || 4,
        h: layout.h || 4,
      };
    }),
  );

  return (
    <DashboardThemeProvider
      theme={dashboard?.theme_config}
      className="bg-surface-0 px-3 py-3 text-text-primary sm:px-4"
      style={{ ...publicTheme.pageStyle, minHeight: '220px' }}
    >
      {pageState === 'reauth' && <SessionExpiredBanner onReauth={handleReauth} />}

      <div
        ref={embedContentRef}
        className={`w-full overflow-visible rounded-xl ${
          dashboard?.theme_config?.backgroundImage
            ? '' /* Phase-B16 — transparent shell so the report background image shows through */
            : 'border border-[rgb(var(--border-line))] bg-surface-1'
        }`}
        style={dashboard?.theme_config?.backgroundImage ? undefined : publicTheme.shellStyle}
      >
        {showControlSurface && (
          <section
            className="border-b border-[rgb(var(--border-line))] px-3 py-2 sm:px-4 sm:py-2.5"
            style={publicTheme.panelStyle}
          >
            {(showEmbedHeader || showPageTabs || showFilterControls) && (
              <div className="flex flex-col gap-2">
                {/* Phase-B1 — title + page tabs on ONE compact row. */}
                {(showEmbedHeader || showPageTabs) && (
                  <div className="flex items-center gap-3">
                    {showEmbedHeader && (
                      <h1 className="shrink-0 max-w-[40%] truncate text-small font-strong text-text-primary">{presentationTitle}</h1>
                    )}
                    {showPageTabs && (
                      <nav className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
                        {dashboardPages.map((page) => {
                          const isActive = page.id === activePageId;
                          const isPending = page.id === pendingPageId;
                          return (
                            <button
                              key={page.id}
                              type="button"
                              onClick={() => {
                                void handlePageSelect(page.id);
                              }}
                              className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-tiny font-emphasis transition-colors ${
                                isActive
                                  ? 'border-transparent bg-text-primary text-text-inverse'
                                  : isPending
                                    ? 'border-brand/20 bg-brand/10 text-brand'
                                    : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                              }`}
                              style={isActive ? publicTheme.pageTabActiveStyle : isPending ? publicTheme.accentPillStyle : publicTheme.pageTabInactiveStyle}
                              disabled={isPending}
                            >
                              {isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                              {page.name}
                            </button>
                          );
                        })}
                      </nav>
                    )}
                  </div>
                )}

                {showFilterControls && (
                  <div className="[&>div]:mb-0">
                    <DashboardFilterBar
                      columns={availableFilterColumns}
                      columnChartCount={availableFilterChartCount}
                      distinctValues={resolvedDistinctValues}
                      filters={draftViewerFilters}
                      onFiltersChange={setDraftViewerFilters}
                      hasPendingChanges={hasPendingFilterChanges}
                      onApply={handleApplyFilters}
                      onReset={handleResetFilters}
                      isApplying={isApplyingFilters}
                      initialExpanded={false}
                      lockSlots
                    />
                  </div>
                )}
              </div>
            )}

            {showLiveState && (
              <div className={showEmbedHeader || showPageTabs || showFilterControls ? 'mt-4 space-y-3' : 'space-y-3'}>
                {pendingPageId && (
                  <div
                    className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-tiny text-text-tertiary"
                    style={publicTheme.neutralPillStyle}
                  >
                    Opening next page...
                  </div>
                )}

                {crossFilterState && (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand/10 px-3 py-2.5 text-tiny text-brand"
                    style={publicTheme.accentPillStyle}
                  >
                    <span className="font-emphasis">
                      Cross-filter from {visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
                        ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
                        ?? `Chart ${crossFilterState.sourceChartId}`}:
                    </span>
                    <span className="truncate text-text-secondary">
                      {getFilterDisplayLabel(crossFilterState.filter)} = {formatFilterValue(crossFilterState.filter.value)}
                    </span>
                    <Button
                      variant="secondary"
                      size="xs"
                      className="ml-auto"
                      onClick={() => setCrossFilterState(null)}
                      style={publicTheme.neutralPillStyle}
                    >
                      Clear
                    </Button>
                  </div>
                )}

                {chartLoadError && (
                  <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-tiny text-warning">
                    {chartLoadError}
                  </div>
                )}

                {chartsLoading && !isApplyingFilters && (
                  <div
                    className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-tiny text-text-tertiary"
                    style={publicTheme.neutralPillStyle}
                  >
                    Refreshing charts...
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        <div className="px-2 py-3 sm:px-3 sm:py-4">
          <section
            ref={gridSectionRef}
            className={`p-1 transition-opacity duration-200 sm:p-1.5 ${pendingPageId ? 'opacity-70' : 'opacity-100'}`}
          >
            {visibleDashboardCharts.length === 0 ? (
              <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-[rgb(var(--border-line))] bg-surface-2">
                <p className="text-tiny text-text-quaternary">No charts on this page yet.</p>
              </div>
            ) : (
              <div className={publicTheme.density.canvasPaddingClass}>
                <ResponsiveReportGrid
                  className="layout"
                  layouts={{ lg: layouts, xs: deriveStackedLayout(layouts) }}
                  breakpoints={REPORT_BREAKPOINTS}
                  cols={REPORT_COLS}
                  rowHeight={80}
                  margin={getDashboardGridMargin(dashboard?.theme_config)}
                  isDraggable={false}
                  isResizable={false}
                  compactType={null}
                  preventCollision={true}
                >
                  {visibleDashboardCharts.map((dashboardChart: DashboardChart) => {
                    const chart = dashboardChart.chart;
                    const payload = chartData[dashboardChart.chart_id];
                    const chartError = chartErrors[dashboardChart.chart_id];
                    // Phase-B11 — no auto chart-name title; only an explicit one.
                    const title = dashboardChart.layout.custom_title ?? '';

                    return (
                      <div key={dashboardChart.id.toString()} className="h-full">
                        <ChartErrorBoundary chartId={dashboardChart.chart_id}>
                          <ReadonlyChartTile
                            chart={chart}
                            chartData={payload}
                            error={chartError}
                            title={title}
                            layout={dashboardChart.layout}
                            compact
                            showChartTypeLabel={false}
                            forceVisible={forceVisibleAll}
                            publicDatasetModels={(dashboard as any)?.public_dataset_models ?? null}
                            onVisible={() => {
                              setVisibleChartIds((current) => {
                                if (current.has(dashboardChart.chart_id)) return current;
                                const next = new Set(current);
                                next.add(dashboardChart.chart_id);
                                return next;
                              });
                            }}
                            onSelectCrossFilter={(filter) => handleCrossFilterChange(dashboardChart.chart_id, filter)}
                            isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                          />
                        </ChartErrorBoundary>
                      </div>
                    );
                  })}
                </ResponsiveReportGrid>
              </div>
            )}
          </section>
        </div>

      </div>

      {/* Floating PDF export — small icon-only on embed */}
      <button
        type="button"
        onClick={handleExportPdf}
        disabled={isExportingPdf || chartsLoading || !allPagesLoaded}
        className="fixed bottom-3 right-3 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[rgb(var(--border-strong))] bg-surface-1/90 text-text-tertiary shadow-linear transition-all hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 print:hidden"
        style={publicTheme.panelStyle}
        title={!allPagesLoaded ? 'Loading chart data…' : 'Export as PDF'}
        data-html2canvas-ignore
      >
        {isExportingPdf || !allPagesLoaded ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </button>
    </DashboardThemeProvider>
  );
}
