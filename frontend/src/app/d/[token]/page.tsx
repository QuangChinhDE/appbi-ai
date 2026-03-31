'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { BarChart3, Loader2, AlertTriangle } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import { publicDashboardApi } from '@/lib/api/public';
import type { Dashboard, DashboardChart, ChartDataResponse } from '@/types/api';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import { applyFiltersToRows, inferColumnTypeFromData } from '@/lib/filters';

const ResponsiveGridLayout = WidthProvider(Responsive);

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
  // Track whether filters have been seeded (from URL params or filters_config)
  const filtersInitializedRef = useRef(false);

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

  // Mark as mounted (client-only)
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    async function load() {
      try {
        const dash = await publicDashboardApi.get(token);
        if (cancelled) return;
        setDashboard(dash);

        // Initialize filters once from the server-enforced public share config.
        if (!filtersInitializedRef.current) {
          filtersInitializedRef.current = true;
          if (Array.isArray(dash.public_filters_config) && dash.public_filters_config.length > 0) {
            setGlobalFilters(dash.public_filters_config as BaseFilter[]);
          }
        }

        // Fetch all chart data in parallel
        const entries = await Promise.allSettled(
          dash.dashboard_charts.map(async (dc: DashboardChart) => {
            const data = await publicDashboardApi.getChartData(token, dc.chart_id);
            return { chartId: dc.chart_id, data };
          }),
        );
        if (cancelled) return;

        const map: Record<number, ChartDataResponse> = {};
        entries.forEach((result) => {
          if (result.status === 'fulfilled') {
            map[result.value.chartId] = result.value.data;
          }
        });
        setChartData(map);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.response?.data?.detail ?? err?.message ?? 'Failed to load dashboard.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [token]);

  if (!mounted || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-3 text-sm text-gray-600">Loading dashboard…</span>
      </div>
    );
  }

  if (error || !dashboard) {
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

  const layouts: Layout[] = dashboard.dashboard_charts.map((dc) => {
    const l = dc.layout;
    return { i: dc.id.toString(), x: l.x || 0, y: l.y || 0, w: l.w || 4, h: l.h || 4 };
  });

  return (
    <div className="min-h-screen bg-gray-50">
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
                    globalFilters.filter((filter) => cd.data.length > 0 && filter.field in cd.data[0]),
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
