'use client';

/**
 * /embed/[token] — iframe-friendly embed route for AppBI dashboards.
 *
 * Security:
 *  - Same JWT session-token auth as /d/[token] (X-Public-Session header)
 *  - nginx for this route sets `frame-ancestors *` / no X-Frame-Options
 *  - Session stored in sessionStorage (tab-scoped, not shared with parent)
 *
 * Embed UX:
 *  - Zero navigation chrome — fits cleanly inside any iframe
 *  - Reports content height via postMessage so parent can resize dynamically
 *  - Compact password gate that works inside an iframe
 */

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Lock, Loader2, AlertTriangle, Eye, EyeOff, RefreshCw } from 'lucide-react';
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
import type { BaseFilter } from '@/lib/filters';
import { applyFiltersToRows } from '@/lib/filters';

const ResponsiveGridLayout = WidthProvider(Responsive);

// ── postMessage height reporter ──────────────────────────────────────────────
// Allows the host page to set iframe height dynamically via:
//   window.addEventListener('message', e => {
//     if (e.data?.type === 'appbi:resize') iframe.style.height = e.data.height + 'px';
//   });
function useEmbedHeight() {
  useEffect(() => {
    const report = () => {
      const height = document.documentElement.scrollHeight;
      try { window.parent.postMessage({ type: 'appbi:resize', height }, '*'); } catch { /* cross-origin blocked */ }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);
}

// ── Compact password gate for embed context ──────────────────────────────────
function EmbedPasswordGate({
  onSubmit,
  error,
  submitting,
  isReauth = false,
}: {
  onSubmit: (pw: string) => void;
  error: string | null;
  submitting: boolean;
  isReauth?: boolean;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-xs rounded-xl bg-white shadow-lg border border-gray-200 overflow-hidden">
        <div className="bg-gradient-to-br from-blue-600 to-purple-600 px-5 py-4 text-white text-center">
          <Lock className="mx-auto mb-2 h-5 w-5" />
          <p className="text-sm font-semibold">
            {isReauth ? 'Session expired — re-enter password' : 'Password required'}
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && value) onSubmit(value); }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-9 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
              placeholder="Enter password"
              autoFocus
            />
            <button type="button" onClick={() => setShow(s => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          {error && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />{error}
            </p>
          )}
          <button
            onClick={() => value && onSubmit(value)}
            disabled={submitting || !value}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
            {submitting ? 'Verifying…' : 'Unlock'}
          </button>
          <p className="text-center text-[10px] text-gray-400">Sessions last 2 hours</p>
        </div>
      </div>
    </div>
  );
}

// ── Session-expired banner (non-blocking) ────────────────────────────────────
function SessionExpiredBanner({ onReauth }: { onReauth: () => void }) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-amber-50 border-t border-amber-200 px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 text-amber-600 flex-shrink-0" />
        <p className="text-xs text-amber-800 font-medium">Session expired. Re-enter password to continue viewing.</p>
      </div>
      <button
        onClick={onReauth}
        className="flex-shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 transition-colors"
      >
        Re-authenticate
      </button>
    </div>
  );
}

// ── Main embed page ──────────────────────────────────────────────────────────
export default function EmbedDashboardPage() {
  const params = useParams();
  const token = params.token as string;

  useEmbedHeight();

  const [mounted, setMounted] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<number, ChartDataResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [globalFilters, setGlobalFilters] = useState<BaseFilter[]>([]);
  const filtersInitializedRef = useRef(false);

  type PageState = 'unknown' | 'loading' | 'password_gate' | 'reauth' | 'loaded' | 'error';
  const [pageState, setPageState] = useState<PageState>('unknown');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (sessionTimerRef.current) { clearTimeout(sessionTimerRef.current); sessionTimerRef.current = null; }
  };

  const scheduleExpiry = useCallback((linkToken: string) => {
    clearTimer();
    const remaining = publicSessionRemainingSeconds(linkToken);
    if (remaining <= 0) return;
    sessionTimerRef.current = setTimeout(() => {
      clearPublicSession(linkToken);
      setPageState('reauth');
    }, remaining * 1000);
  }, []);

  useEffect(() => () => clearTimer(), []);

  const loadDashboard = useCallback(async (sessionToken?: string) => {
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
      entries.forEach(r => { if (r.status === 'fulfilled') map[r.value.chartId] = r.value.data; });
      setChartData(map);
      setPageState('loaded');
      if (sessionToken) scheduleExpiry(token);
    } catch (err: any) {
      if (cancelled) return;
      if (err?.response?.status === 401) {
        setPageState('password_gate');
      } else {
        setError(err?.response?.data?.detail ?? err?.message ?? 'Failed to load dashboard.');
        setPageState('error');
      }
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => { cancelled = true; };
  }, [token, scheduleExpiry]);

  useEffect(() => {
    if (!token) return;
    setMounted(true);
    const stored = getPublicSession(token);
    loadDashboard(stored ?? undefined);
  }, [token, loadDashboard]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const { session_token, expires_in } = await publicDashboardApi.auth(token, password);
      savePublicSession(token, session_token, expires_in);
      await loadDashboard(session_token);
    } catch (err: any) {
      const s = err?.response?.status;
      if (s === 403) setAuthError('Incorrect password.');
      else if (s === 410) setAuthError('This shared link has expired.');
      else setAuthError(err?.response?.data?.detail ?? 'Authentication failed.');
      setPageState('password_gate');
    } finally {
      setAuthSubmitting(false);
    }
  }, [token, loadDashboard]);

  const handleReauth = useCallback(() => { setPageState('password_gate'); setAuthError(null); }, []);

  // ── Render states ────────────────────────────────────────────────────────
  if (!mounted || pageState === 'unknown' || pageState === 'loading') {
    return (
      <div className="flex min-h-[200px] items-center justify-center bg-white">
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
        <span className="ml-2 text-xs text-gray-500">Loading…</span>
      </div>
    );
  }

  if (pageState === 'password_gate') {
    return <EmbedPasswordGate onSubmit={handlePasswordSubmit} error={authError} submitting={authSubmitting} isReauth={false} />;
  }

  if (pageState === 'error' || !dashboard) {
    return (
      <div className="flex min-h-[200px] items-center justify-center bg-white px-4 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-amber-400" />
          <p className="text-sm font-medium text-gray-700">Dashboard unavailable</p>
          <p className="mt-1 text-xs text-gray-400">{error ?? 'This link may have expired or been revoked.'}</p>
        </div>
      </div>
    );
  }

  const layouts: Layout[] = dashboard.dashboard_charts.map((dc) => {
    const l = dc.layout;
    return { i: dc.id.toString(), x: l.x || 0, y: l.y || 0, w: l.w || 4, h: l.h || 4 };
  });

  return (
    <div className="bg-white" style={{ minHeight: '200px' }}>
      {/* Session-expired bottom banner */}
      {pageState === 'reauth' && <SessionExpiredBanner onReauth={handleReauth} />}

      {/* Optional: compact title strip */}
      {dashboard.name && (
        <div className="border-b border-gray-100 px-4 py-2.5">
          <h1 className="text-sm font-semibold text-gray-800 truncate">{dashboard.name}</h1>
          {dashboard.description && (
            <p className="text-xs text-gray-400 truncate">{dashboard.description}</p>
          )}
        </div>
      )}

      {/* Filter badges (server-enforced) */}
      {globalFilters.length > 0 && (
        <div className="px-4 pt-3 pb-1 flex flex-wrap gap-1.5">
          {globalFilters.map((f) => (
            <span key={f.id} className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">
              {f.label ?? f.field}: {Array.isArray(f.value) ? f.value.join(' – ') : String(f.value ?? '')}
            </span>
          ))}
        </div>
      )}

      {/* Charts */}
      <div className="px-2 py-3">
        {dashboard.dashboard_charts.length === 0 ? (
          <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-400">No charts yet.</p>
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
                  <div key={dc.id.toString()} className="rounded-lg border border-amber-100 bg-white p-3 shadow-sm">
                    <div className="flex h-full min-h-[120px] items-center justify-center">
                      <AlertTriangle className="h-5 w-5 text-amber-400" />
                    </div>
                  </div>
                );
              }
              const title = dc.layout.custom_title ?? chart?.name ?? '';
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
                <div key={dc.id.toString()} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                  <ChartErrorBoundary chartId={dc.chart_id}>
                    {title && <p className="mb-1.5 text-xs font-semibold text-gray-700 truncate">{title}</p>}
                    {!cd ? (
                      <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-300" />
                      </div>
                    ) : roleConfig ? (
                      <div className="h-[300px]">
                        <ExploreChart
                          type={chart.chart_type}
                          data={filteredRows}
                          roleConfig={roleConfig}
                          preAggregated={cd.pre_aggregated ?? false}
                        />
                      </div>
                    ) : (
                      <ChartPreview chartType={chart.chart_type} data={filteredRows} config={(chart.config as any) ?? {}} />
                    )}
                  </ChartErrorBoundary>
                </div>
              );
            })}
          </ResponsiveGridLayout>
        )}
      </div>

      {/* Minimal powered-by badge */}
      <div className="px-4 pb-3 text-right">
        <span className="text-[9px] text-gray-300">Powered by AppBI</span>
      </div>
    </div>
  );
}
