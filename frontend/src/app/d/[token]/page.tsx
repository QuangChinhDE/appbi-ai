'use client';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { BarChart3, Loader2, AlertTriangle, Lock, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import {
  publicDashboardApi,
  savePublicSession,
  getPublicSession,
  clearPublicSession,
  publicSessionRemainingSeconds,
} from '@/lib/api/public';
import type { Dashboard, DashboardChart, ChartDataResponse } from '@/types/api';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import { applyFiltersToRows, inferColumnTypeFromData } from '@/lib/filters';

const ResponsiveGridLayout = WidthProvider(Responsive);

// ── Password gate component ────────────────────────────────────────────────
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
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-blue-600 to-purple-600 px-6 py-5 text-white text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="text-base font-semibold">
            {isReauth ? 'Session expired' : 'Password protected'}
          </h1>
          <p className="mt-1 text-xs text-blue-100">
            {isReauth
              ? 'Your 2-hour session has ended. Please re-enter the password to continue.'
              : 'This dashboard requires a password to view.'}
          </p>
        </div>

        {/* Form */}
        <div className="px-6 py-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && value) onSubmit(value); }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
              placeholder="Enter password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShow(s => !s)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="mt-2 text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </p>
          )}

          <button
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {submitting ? 'Verifying…' : isReauth ? 'Continue viewing' : 'Unlock dashboard'}
          </button>

          <p className="mt-3 text-center text-[11px] text-gray-400">
            Sessions last 2 hours · Powered by AppBI
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Session expired overlay ────────────────────────────────────────────────
function SessionExpiredOverlay({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-[2px] pb-12 sm:items-center sm:pb-0">
      <div className="mx-4 w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-200 px-6 py-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-100">
          <RefreshCw className="h-5 w-5 text-amber-600" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">Session expired</h2>
        <p className="mt-1 text-xs text-gray-500">
          Your 2-hour viewing session has ended. Re-enter the password to continue.
        </p>
        <button
          onClick={onReauth}
          className="mt-4 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          Re-enter password
        </button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function PublicDashboardPage() {
  const params = useParams();
  const token = params.token as string;

  const [mounted, setMounted] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<number, ChartDataResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [globalFilters, setGlobalFilters] = useState<BaseFilter[]>([]);
  const [availableColumns, setAvailableColumns] = useState<ColumnInfo[]>([]);
  const filtersInitializedRef = useRef(false);

  // ── Auth state ──────────────────────────────────────────────────────
  // 'unknown'       → haven't attempted load yet
  // 'loading'       → loading dashboard/charts
  // 'password_gate' → 401 received, show password form
  // 'reauth'        → session expired, user needs to re-enter password
  // 'loaded'        → dashboard loaded successfully
  // 'error'         → non-auth error
  type PageState = 'unknown' | 'loading' | 'password_gate' | 'reauth' | 'loaded' | 'error';
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSessionTimer = () => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  };

  /** Set a timer that fires when the current session token expires. */
  const scheduleSessionExpiry = useCallback((linkToken: string) => {
    clearSessionTimer();
    const remaining = publicSessionRemainingSeconds(linkToken);
    if (remaining <= 0) return;
    sessionTimerRef.current = setTimeout(() => {
      clearPublicSession(linkToken);
      setPageState('reauth');
    }, remaining * 1000);
  }, []);

  useEffect(() => () => clearSessionTimer(), []);

  // ── Load dashboard (with optional session token) ────────────────────
  const loadDashboard = useCallback(
    async (sessionToken?: string) => {
      setPageState('loading');
      setLoading(true);
      setError(null);
      let cancelled = false;

      try {
        const dash = await publicDashboardApi.get(token, sessionToken);
        if (cancelled) return;
        setDashboard(dash);

        if (!filtersInitializedRef.current) {
          filtersInitializedRef.current = true;
          if (Array.isArray(dash.public_filters_config) && dash.public_filters_config.length > 0) {
            setGlobalFilters(dash.public_filters_config as BaseFilter[]);
          }
        }

        const entries = await Promise.allSettled(
          dash.dashboard_charts.map(async (dc: DashboardChart) => {
            const data = await publicDashboardApi.getChartData(token, dc.chart_id, sessionToken);
            return { chartId: dc.chart_id, data };
          }),
        );
        if (cancelled) return;

        const map: Record<number, ChartDataResponse> = {};
        entries.forEach((result) => {
          if (result.status === 'fulfilled') map[result.value.chartId] = result.value.data;
        });
        setChartData(map);
        setPageState('loaded');

        // If a session token was used, schedule expiry reminder
        if (sessionToken) scheduleSessionExpiry(token);
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        if (status === 401) {
          // Backend says password required
          setPageState('password_gate');
        } else {
          setError(err?.response?.data?.detail ?? err?.message ?? 'Failed to load dashboard.');
          setPageState('error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }

      return () => { cancelled = true; };
    },
    [token, scheduleSessionExpiry],
  );

  // ── Initial load ────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    setMounted(true);
    const stored = getPublicSession(token);
    loadDashboard(stored ?? undefined);
  }, [token, loadDashboard]);

  // ── Password submit handler ─────────────────────────────────────────
  const handlePasswordSubmit = useCallback(
    async (password: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const { session_token, expires_in } = await publicDashboardApi.auth(token, password);
        savePublicSession(token, session_token, expires_in);
        setAuthError(null);
        await loadDashboard(session_token);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 403) {
          setAuthError('Incorrect password. Please try again.');
        } else if (status === 410) {
          setAuthError('This shared link has expired.');
        } else {
          setAuthError(err?.response?.data?.detail ?? 'Authentication failed.');
        }
        setPageState('password_gate');
      } finally {
        setAuthSubmitting(false);
      }
    },
    [token, loadDashboard],
  );

  const handleReauth = useCallback(() => {
    setPageState('password_gate');
    setAuthError(null);
  }, []);

  // ── Column inference ────────────────────────────────────────────────
  const columnChartCount = useMemo(() => {
    const tracker = new Map<string, Set<number>>();
    Object.entries(chartData).forEach(([chartIdRaw, payload]) => {
      const chartId = Number(chartIdRaw);
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (!rows.length) return;
      const roleConfig = (payload.chart?.config as any)?.roleConfig ?? {};
      const dimensionFields = [roleConfig.dimension, roleConfig.breakdown, roleConfig.timeField]
        .filter((field): field is string => Boolean(field) && field in rows[0]);
      const fields = dimensionFields.length > 0 ? dimensionFields : Object.keys(rows[0]);
      fields.forEach((field) => {
        if (!tracker.has(field)) tracker.set(field, new Set());
        tracker.get(field)!.add(chartId);
      });
    });
    return new Map(Array.from(tracker.entries()).map(([key, ids]) => [key, ids.size]));
  }, [chartData]);

  useEffect(() => {
    const columns = new Map<string, ColumnInfo>();
    Object.values(chartData).forEach((payload) => {
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      if (!rows.length) return;
      const roleConfig = (payload.chart?.config as any)?.roleConfig ?? {};
      const dimensionFields = [roleConfig.dimension, roleConfig.breakdown, roleConfig.timeField]
        .filter((field): field is string => Boolean(field) && field in rows[0]);
      const fields = dimensionFields.length > 0 ? dimensionFields : Object.keys(rows[0]);
      fields.forEach((field) => {
        if (!columns.has(field)) {
          columns.set(field, { name: field, type: inferColumnTypeFromData(field, rows) });
        }
      });
    });
    setAvailableColumns(Array.from(columns.values()).sort((left, right) => left.name.localeCompare(right.name)));
  }, [chartData]);

  // ── Render ──────────────────────────────────────────────────────────
  if (!mounted || pageState === 'unknown') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-3 text-sm text-gray-600">Loading dashboard…</span>
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

  if (pageState === 'error' || (pageState !== 'loading' && pageState !== 'loaded' && pageState !== 'reauth')) {
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

  if (pageState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-3 text-sm text-gray-600">Loading dashboard…</span>
      </div>
    );
  }

  if (!dashboard) return null;

  const layouts: Layout[] = dashboard.dashboard_charts.map((dc) => {
    const l = dc.layout;
    return { i: dc.id.toString(), x: l.x || 0, y: l.y || 0, w: l.w || 4, h: l.h || 4 };
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Session-expired overlay (blurs the content underneath) */}
      {pageState === 'reauth' && (
        <SessionExpiredOverlay onReauth={handleReauth} />
      )}

      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-screen-xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-purple-600">
              <BarChart3 className="h-4 w-4 text-white" />
            </div>
            <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-base font-bold text-transparent">
              AppBI
            </span>
          </div>
          <div className="text-right">
            <h1 className="text-sm font-semibold text-gray-900">{dashboard.name}</h1>
            {dashboard.description && (
              <p className="text-xs text-gray-500">{dashboard.description}</p>
            )}
          </div>
        </div>
      </header>

      {/* Dashboard grid */}
      <main className="mx-auto max-w-screen-xl px-4 py-6">
        {globalFilters.length > 0 && (
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
            <div className="mb-2 text-sm font-medium text-blue-900">Applied public filters</div>
            <div className="flex flex-wrap gap-2">
              {globalFilters.map((filter) => (
                <span key={filter.id} className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs text-blue-800">
                  {filter.label ?? filter.field}: {Array.isArray(filter.value) ? filter.value.join(' – ') : String(filter.value ?? '')}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs text-blue-700">These filters are enforced by the shared link and cannot be removed to reveal broader data.</p>
          </div>
        )}
        {dashboard.dashboard_charts.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white">
            <p className="text-sm text-gray-500">No charts in this dashboard yet.</p>
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
            {dashboard.dashboard_charts.map((dc) => {
              const cd = chartData[dc.chart_id];
              const chart = dc.chart;
              if (!chart) {
                return (
                  <div key={dc.id.toString()} className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
                    <div className="flex h-full min-h-[240px] items-center justify-center text-center">
                      <div>
                        <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-500" />
                        <p className="text-sm font-medium text-amber-700">Chart metadata unavailable</p>
                        <p className="mt-1 text-xs text-amber-600">This shared dashboard contains a chart reference that could not be loaded.</p>
                      </div>
                    </div>
                  </div>
                );
              }
              const customTitle = dc.layout.custom_title;
              const title = customTitle ?? chart?.name ?? '';
              const roleConfig = (chart?.config as any)?.roleConfig;
              const filteredRows = Array.isArray(cd?.data)
                ? applyFiltersToRows(
                    cd.data,
                    globalFilters
                      .map((filter) => {
                        if (!cd.data.length) return null;
                        const candidates = [filter.field, ...((filter as any).linkedFields ?? [])];
                        const match = candidates.find(c => c in cd.data[0]);
                        if (!match) return null;
                        return match !== filter.field ? { ...filter, field: match } : filter;
                      })
                      .filter((f): f is BaseFilter => f !== null),
                  )
                : [];

              return (
                <div key={dc.id.toString()} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <ChartErrorBoundary chartId={dc.chart_id}>
                    {title && (
                      <p className="mb-2 text-sm font-semibold text-gray-800 truncate">{title}</p>
                    )}
                    {!cd ? (
                      <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                      </div>
                    ) : roleConfig ? (
                      <div className="h-[320px]">
                        <ExploreChart
                          type={chart.chart_type}
                          data={filteredRows}
                          roleConfig={roleConfig}
                          preAggregated={cd.pre_aggregated ?? false}
                        />
                      </div>
                    ) : (
                      <ChartPreview
                        chartType={chart.chart_type}
                        data={filteredRows}
                        config={(chart.config as any) ?? {}}
                      />
                    )}
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

