'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  AlertTriangle,
  BarChart3,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-50/90 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-sm overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
        <div className="bg-gradient-to-br from-blue-600 to-purple-600 px-6 py-5 text-center text-white">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="text-base font-semibold">
            {isReauth ? 'Session expired' : 'Password protected'}
          </h1>
          <p className="mt-1 text-xs text-blue-100">
            {isReauth
              ? 'Your 2-hour session ended. Enter the password again to continue.'
              : 'This shared dashboard requires a password to view.'}
          </p>
        </div>

        <div className="px-6 py-5">
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Password</label>
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
              className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
              placeholder="Enter password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShow((current) => !current)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </p>
          )}

          <button
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {submitting ? 'Verifying...' : isReauth ? 'Continue viewing' : 'Unlock dashboard'}
          </button>

          <p className="mt-3 text-center text-[11px] text-gray-400">
            Sessions last 2 hours
          </p>
        </div>
      </div>
    </div>
  );
}

function SessionExpiredOverlay({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 pb-12 backdrop-blur-[2px] sm:items-center sm:pb-0">
      <div className="mx-4 w-full max-w-sm rounded-2xl border border-gray-200 bg-white px-6 py-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-100">
          <RefreshCw className="h-5 w-5 text-amber-600" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">Session expired</h2>
        <p className="mt-1 text-xs text-gray-500">
          Your 2-hour viewing session ended. Re-enter the password to continue.
        </p>
        <button
          onClick={onReauth}
          className="mt-4 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
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

  const loadVisibleCharts = useCallback(async (sessionToken?: string) => {
    if (!dashboard) return;

    const requestId = ++chartRequestIdRef.current;
    const targetCharts = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId);
    const targetChartIds = new Set(targetCharts.map((chart) => chart.chart_id));

    setChartsLoading(true);
    setChartLoadError(null);
    setChartErrors((current) => Object.fromEntries(
      Object.entries(current).filter(([chartId]) => targetChartIds.has(Number(chartId))),
    ));
    setChartData((current) => Object.fromEntries(
      Object.entries(current).filter(([chartId]) => targetChartIds.has(Number(chartId))),
    ));

    if (!targetCharts.length) {
      setChartsLoading(false);
      setIsApplyingFilters(false);
      return;
    }

    try {
      const entries = await Promise.all(
        targetCharts.map(async (dashboardChart) => {
          const requestFilters = crossFilterState?.sourceChartId === dashboardChart.chart_id
            ? appliedViewerFilters
            : crossFilterState
              ? [...appliedViewerFilters, crossFilterState.filter]
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
        return;
      }

      const unauthorized = entries.find((entry) => (entry as any).status === 401);
      if (unauthorized) {
        clearPublicSession(token);
        setPageState('reauth');
        return;
      }

      const nextData: Record<number, ChartDataResponse> = {};
      const nextErrors: Record<number, string> = {};

      for (const entry of entries) {
        if (entry.data) {
          nextData[entry.chartId] = entry.data;
        } else if (entry.error) {
          nextErrors[entry.chartId] = entry.error;
        }
      }

      setChartData(nextData);
      setChartErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        setChartLoadError('Some charts could not be loaded in this shared view.');
      }
      if (sessionToken) {
        scheduleSessionExpiry(token);
      }
    } finally {
      if (requestId === chartRequestIdRef.current) {
        setChartsLoading(false);
        setIsApplyingFilters(false);
      }
    }
  }, [activePageId, appliedViewerFilters, crossFilterState, dashboard, scheduleSessionExpiry, token]);

  useEffect(() => {
    if (!dashboard || pageState !== 'loaded') return;
    const storedSession = getPublicSession(token);
    loadVisibleCharts(storedSession ?? undefined);
  }, [dashboard, loadVisibleCharts, pageState, token]);

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

  const handleApplyFilters = useCallback(() => {
    setIsApplyingFilters(true);
    setAppliedViewerFilters(draftViewerFilters);
  }, [draftViewerFilters]);

  const handleResetFilters = useCallback(() => {
    setDraftViewerFilters(appliedViewerFilters);
  }, [appliedViewerFilters]);

  if (!mounted || pageState === 'unknown' || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-3 text-sm text-gray-600">Loading dashboard...</span>
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
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center">
          <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-amber-500" />
          <h1 className="text-lg font-semibold text-gray-900">Dashboard not available</h1>
          <p className="mt-2 text-sm text-gray-500">
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
    <div className="min-h-screen bg-gray-50">
      {pageState === 'reauth' && (
        <SessionExpiredOverlay onReauth={handleReauth} />
      )}

      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-purple-600">
              <BarChart3 className="h-4 w-4 text-white" />
            </div>
            <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-base font-bold text-transparent">
              AppBI
            </span>
          </div>
          <div className="min-w-0 text-right">
            <h1 className="truncate text-sm font-semibold text-gray-900">{dashboard.name}</h1>
            {dashboard.description && (
              <p className="truncate text-xs text-gray-500">{dashboard.description}</p>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-xl px-4 py-6">
        {dashboardPages.length > 1 && (
          <div className="mb-4 flex gap-2 overflow-x-auto">
            {dashboardPages.map((page) => (
              <button
                key={page.id}
                type="button"
                onClick={() => setCurrentPageId(page.id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  page.id === activePageId
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-100'
                }`}
              >
                {page.name}
              </button>
            ))}
          </div>
        )}

        {(availableFilterColumns.length > 0 || draftViewerFilters.length > 0) && (
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
          />
        )}

        {crossFilterState && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-medium">
              Cross-filter from {visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
                ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
                ?? `Chart ${crossFilterState.sourceChartId}`}:
            </span>
            <span className="truncate">
              {getFilterDisplayLabel(crossFilterState.filter)} = {formatFilterValue(crossFilterState.filter.value)}
            </span>
            <button
              type="button"
              onClick={() => setCrossFilterState(null)}
              className="ml-auto rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Clear
            </button>
          </div>
        )}

        {chartLoadError && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {chartLoadError}
          </div>
        )}

        {chartsLoading && !isApplyingFilters && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
            Refreshing charts...
          </div>
        )}

        {visibleDashboardCharts.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white">
            <p className="text-sm text-gray-500">No charts on this page yet.</p>
          </div>
        ) : (
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
                      onSelectCrossFilter={(filter) => handleCrossFilterChange(dashboardChart.chart_id, filter)}
                      isCrossFilterSource={crossFilterState?.sourceChartId === dashboardChart.chart_id}
                    />
                  </ChartErrorBoundary>
                </div>
              );
            })}
          </ResponsiveGridLayout>
        )}
      </main>

      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400">
        Powered by AppBI · Read-only shared view
      </footer>
    </div>
  );
}
