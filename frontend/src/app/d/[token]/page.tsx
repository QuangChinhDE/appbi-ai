'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  AlertTriangle,
  Loader2,
  Lock,
  RefreshCw,
  Eye,
  EyeOff,
} from 'lucide-react';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import { ReadonlyChartTile } from '@/components/dashboards/ReadonlyChartTile';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
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
} from '@/lib/dashboard-pages';
import { getColumnKey, getFilterDisplayLabel, getFilterKey, type BaseFilter, type ColumnInfo } from '@/lib/filters';
import { usePublicFilterDistinctValues } from '@/hooks/use-public-filter-distinct-values';
import { buildPublicLinkTheme } from '@/lib/public-link-appearance';
import { buildPublicDashboardFilterRuntime } from '@/lib/public-dashboard-runtime';
import type { ChartDataResponse, Dashboard, DashboardChart } from '@/types/api';

const ResponsiveGridLayout = WidthProvider(Responsive);

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

function PasswordGate({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.16),transparent_34%),linear-gradient(180deg,rgba(248,250,252,0.96),rgba(241,245,249,0.98))] px-4 py-8 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md overflow-hidden rounded-[28px] border border-white/80 bg-white/92 shadow-[0_40px_110px_-48px_rgba(15,23,42,0.55)]">
        <div className="relative overflow-hidden border-b border-slate-200/70 bg-[linear-gradient(135deg,rgba(240,249,255,0.95),rgba(236,253,245,0.92))] px-6 py-6 text-center text-slate-900">
          <div className="absolute inset-x-10 top-0 h-20 rounded-full bg-sky-200/30 blur-3xl" />
          <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-900/15">
            <Lock className="h-6 w-6" />
          </div>
          <p className="relative text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Protected shared report
          </p>
          <h1 className="relative mt-2 text-xl font-semibold tracking-tight text-slate-950">
            {isReauth ? 'Session expired' : 'Password protected'}
          </h1>
          <p className="relative mt-2 text-sm leading-6 text-slate-600">
            {isReauth
              ? 'Your 2-hour session ended. Enter the password again to continue.'
              : 'This shared dashboard requires a password to view.'}
          </p>
        </div>

        <div className="px-6 py-6">
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Password</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && value) {
                  onSubmit(value);
                }
              }}
              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 pr-11 text-sm text-slate-700 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-4 focus:ring-sky-100"
              placeholder="Enter password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShow((current) => !current)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="mt-3 flex items-center gap-1 text-xs text-rose-600">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </p>
          )}

          <button
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {submitting ? 'Verifying...' : isReauth ? 'Continue viewing' : 'Unlock dashboard'}
          </button>

          <p className="mt-4 text-center text-[11px] text-slate-400">
            Sessions last 2 hours and keep the report read-only.
          </p>
        </div>
      </div>
    </div>
  );
}

function SessionExpiredOverlay({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/18 px-4 pb-8 backdrop-blur-[3px] sm:items-center sm:pb-0">
      <div className="mx-4 w-full max-w-md rounded-[28px] border border-white/80 bg-white/92 px-6 py-6 text-center shadow-[0_36px_100px_-46px_rgba(15,23,42,0.55)]">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100">
          <RefreshCw className="h-5 w-5 text-amber-600" />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Authentication needed</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">Session expired</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Your 2-hour viewing session ended. Re-enter the password to continue.
        </p>
        <button
          onClick={onReauth}
          className="mt-5 w-full rounded-2xl bg-slate-950 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          Re-enter password
        </button>
      </div>
    </div>
  );
}

function getErrorMessage(error: any): string {
  return error?.response?.data?.detail ?? error?.message ?? 'Failed to load chart data.';
}

export default function PublicDashboardPage() {
  const params = useParams();
  const token = params.token as string;

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
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRequestIdRef = useRef(0);
  const skipNextPageLoadRef = useRef<string | null>(null);
  const skipCrossFilterRefreshRef = useRef<string | null>(null);
  const appliedFilterSignatureRef = useRef(JSON.stringify([] as BaseFilter[]));

  const clearSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, []);

  const scheduleSessionExpiry = useCallback((linkToken: string) => {
    clearSessionTimer();
    const remaining = publicSessionRemainingSeconds(linkToken);
    if (remaining <= 0) return;
    sessionTimerRef.current = setTimeout(() => {
      clearPublicSession(linkToken);
      setPageState('reauth');
    }, remaining * 1000);
  }, [clearSessionTimer]);

  useEffect(() => () => clearSessionTimer(), [clearSessionTimer]);

  const loadDashboard = useCallback(async (sessionToken?: string) => {
    setPageState('loading');
    setLoading(true);
    setError(null);

    try {
      const nextDashboard = await publicDashboardApi.get(token, sessionToken);
      setDashboard(nextDashboard);
      setPageState('loaded');
      if (sessionToken) {
        scheduleSessionExpiry(token);
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
  }, [scheduleSessionExpiry, token]);

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
  ) => {
    if (!dashboard) return false;

    const requestId = ++chartRequestIdRef.current;
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, pageId);

    setChartsLoading(true);
    setChartLoadError(null);

    if (!targetCharts.length) {
      setChartsLoading(false);
      setIsApplyingFilters(false);
      return true;
    }

    try {
      const entries = await Promise.all(
        targetCharts.map(async (dashboardChart) => {
          const requestFilters = pageCrossFilterState?.sourceChartId === dashboardChart.chart_id
            ? appliedViewerFilters
            : pageCrossFilterState
              ? [...appliedViewerFilters, pageCrossFilterState.filter]
              : appliedViewerFilters;
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
        }),
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
        setChartLoadError('Some charts could not be loaded in this shared view.');
      }
      if (sessionToken) {
        scheduleSessionExpiry(token);
      }
      return true;
    } finally {
      if (requestId === chartRequestIdRef.current) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
    }
  }, [appliedViewerFilters, crossFilterState, dashboard, scheduleSessionExpiry, token]);

  useEffect(() => {
    if (!dashboard || pageState !== 'loaded') return;
    if (skipNextPageLoadRef.current === activePageId) {
      skipNextPageLoadRef.current = null;
      return;
    }
    if (!crossFilterState && skipCrossFilterRefreshRef.current === activePageId) {
      skipCrossFilterRefreshRef.current = null;
      return;
    }
    const storedSession = getPublicSession(token);
    fetchChartsForPage(activePageId, storedSession ?? undefined, crossFilterState);
  }, [activePageId, crossFilterState, dashboard, fetchChartsForPage, pageState, token]);

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
        setAuthError('Incorrect password. Please try again.');
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
    ?? 'Shared dashboard';
  const viewerFiltersEnabled = appearance.allow_viewer_filters;
  const showPageTabs = appearance.show_page_tabs && dashboardPages.length > 1;
  const showFilterControls = viewerFiltersEnabled && (availableFilterColumns.length > 0 || draftViewerFilters.length > 0);
  const showLiveState = Boolean(pendingPageId || crossFilterState || chartLoadError || (chartsLoading && !isApplyingFilters));

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
      <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#f8fafc_0%,#eef6ff_45%,#ffffff_100%)] px-4">
        <div className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/85 px-6 py-10 text-center shadow-[0_40px_100px_-52px_rgba(15,23,42,0.55)] backdrop-blur">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-950">Preparing shared dashboard</h1>
          <p className="mt-2 text-sm text-slate-500">
            Loading charts, pages, and viewer filters for the published report.
          </p>
        </div>
      </div>
    );
  }

  if (pageState === 'password_gate') {
    return (
      <PasswordGate
        onSubmit={handlePasswordSubmit}
        error={authError}
        submitting={authSubmitting}
        isReauth={false}
      />
    );
  }

  if (pageState === 'error' || !dashboard) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#f8fafc_0%,#eef6ff_45%,#ffffff_100%)] px-4">
        <div className="max-w-md rounded-[28px] border border-white/80 bg-white/90 px-8 py-10 text-center shadow-[0_40px_100px_-52px_rgba(15,23,42,0.55)] backdrop-blur">
          <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-amber-500" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Shared link unavailable</p>
          <h1 className="mt-2 text-xl font-semibold text-slate-950">Dashboard not available</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            {error ?? 'This shared link may have expired or been revoked.'}
          </p>
        </div>
      </div>
    );
  }

  const layouts: Layout[] = visibleDashboardCharts.map((dashboardChart) => {
    const layout = dashboardChart.layout;
    return {
      i: dashboardChart.id.toString(),
      x: layout.x || 0,
      y: layout.y || 0,
      w: layout.w || 4,
      h: layout.h || 4,
    };
  });

  return (
    <div className="min-h-screen text-slate-900" style={publicTheme.pageStyle}>
      {pageState === 'reauth' && (
        <SessionExpiredOverlay onReauth={handleReauth} />
      )}

      <main className={`flex w-full flex-col ${publicTheme.density.listGapClass} px-3 py-4 sm:px-4 lg:px-6 lg:py-5`}>
        <section
          className="overflow-visible rounded-[28px] border px-3 py-3 sm:px-4 sm:py-4"
          style={publicTheme.panelStyle}
        >
          <h1 className="text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">
            {presentationTitle}
          </h1>

          {(showPageTabs || showFilterControls || showLiveState) && (
            <div className="mt-3 space-y-3">
              {showPageTabs && (
                <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
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
                      className="inline-flex whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-medium transition"
                      style={isActive ? publicTheme.pageTabActiveStyle : isPending ? publicTheme.accentPillStyle : publicTheme.pageTabInactiveStyle}
                      disabled={isPending}
                    >
                      {isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                      {page.name}
                    </button>
                    );
                  })}
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
                  />
                </div>
              )}

              {showLiveState && (
                <div className="flex flex-col gap-3">
                  {pendingPageId && (
                    <div className="rounded-[20px] border px-4 py-3 text-sm" style={publicTheme.neutralPillStyle}>
                      Opening next page...
                    </div>
                  )}

                  {crossFilterState && (
                    <div className="rounded-[20px] border px-4 py-3 text-sm" style={publicTheme.accentPillStyle}>
                      <p className="font-medium">
                        Cross-filter from {visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
                          ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
                          ?? `Chart ${crossFilterState.sourceChartId}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="break-words">
                          {getFilterDisplayLabel(crossFilterState.filter)} = {formatFilterValue(crossFilterState.filter.value)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setCrossFilterState(null)}
                          className="rounded-full border px-3 py-1 text-xs font-medium"
                          style={publicTheme.neutralPillStyle}
                        >
                          Clear selection
                        </button>
                      </div>
                    </div>
                  )}

                  {chartLoadError && (
                    <div className="rounded-[20px] border border-amber-200 bg-amber-50/85 px-4 py-3 text-sm text-amber-900">
                      {chartLoadError}
                    </div>
                  )}

                  {chartsLoading && !isApplyingFilters && (
                    <div className="rounded-[20px] border px-4 py-3 text-sm text-slate-500" style={publicTheme.neutralPillStyle}>
                      Refreshing charts...
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section
          className={`w-full rounded-[28px] border p-3 transition-opacity duration-200 sm:p-4 ${pendingPageId ? 'opacity-70' : 'opacity-100'}`}
          style={publicTheme.canvasFrameStyle}
        >
          {visibleDashboardCharts.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-[28px] border-2 border-dashed border-slate-200 bg-slate-50/80">
              <p className="text-sm text-slate-500">No charts on this page yet.</p>
            </div>
          ) : (
            <div
              className={`rounded-[28px] ${publicTheme.density.canvasPaddingClass}`}
              style={publicTheme.canvasInnerStyle}
            >
              <ResponsiveGridLayout
                className="layout"
                layouts={{ lg: layouts }}
                breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
                cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
                rowHeight={80}
                isDraggable={false}
                isResizable={false}
                compactType="vertical"
              >
                {visibleDashboardCharts.map((dashboardChart: DashboardChart) => {
                  const chart = dashboardChart.chart;
                  const payload = chartData[dashboardChart.chart_id];
                  const chartError = chartErrors[dashboardChart.chart_id];
                  const title = dashboardChart.layout.custom_title ?? chart?.name ?? '';

                  return (
                    <div key={dashboardChart.id.toString()} className="h-full">
                      <ChartErrorBoundary chartId={dashboardChart.chart_id}>
                        <ReadonlyChartTile
                          chart={chart}
                          chartData={payload}
                          error={chartError}
                          title={title}
                          layout={dashboardChart.layout}
                          compact={publicTheme.density.compact}
                          showChartTypeLabel={false}
                          onSelectCrossFilter={(filter) => handleCrossFilterChange(dashboardChart.chart_id, filter)}
                          isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                        />
                      </ChartErrorBoundary>
                    </div>
                  );
                })}
              </ResponsiveGridLayout>
            </div>
          )}
        </section>
      </main>

    </div>
  );
}
