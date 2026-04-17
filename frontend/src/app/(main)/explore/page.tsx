/**
 * Explore - list of saved charts.
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, BarChart3, Clock, Layers, Search, Share2, X } from 'lucide-react';
import { useCharts, useDeleteChart } from '@/hooks/use-charts';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { useI18n } from '@/providers/LanguageProvider';
import { toast } from '@/lib/toast';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartType } from '@/types/api';
import type { Chart, ChartListScope } from '@/types/api';
import { getActiveChartRoleConfig } from '@/lib/chart-config';

const CHART_TYPE_LABELS: Record<string, string> = {
  BAR: 'Bar',
  HORIZONTAL_BAR: 'Horizontal Bar',
  LINE: 'Line',
  PIE: 'Pie',
  TIME_SERIES: 'Time Series',
  AREA: 'Area',
  STACKED_BAR: 'Stacked Bar',
  GROUPED_BAR: 'Grouped Bar',
  BAR_LINE: 'Bar + Line',
  SCATTER: 'Scatter',
  KPI: 'KPI',
  TABLE: 'Table',
};

const CHART_TYPE_FILTERS: Array<{ value: 'all' | ChartType; label: string }> = [
  { value: 'all', label: 'All chart types' },
  { value: ChartType.BAR, label: 'Bar' },
  { value: ChartType.HORIZONTAL_BAR, label: 'Horizontal Bar' },
  { value: ChartType.LINE, label: 'Line' },
  { value: ChartType.PIE, label: 'Pie' },
  { value: ChartType.TIME_SERIES, label: 'Time Series' },
  { value: ChartType.AREA, label: 'Area' },
  { value: ChartType.STACKED_BAR, label: 'Stacked Bar' },
  { value: ChartType.GROUPED_BAR, label: 'Grouped Bar' },
  { value: ChartType.BAR_LINE, label: 'Bar + Line' },
  { value: ChartType.SCATTER, label: 'Scatter' },
  { value: ChartType.KPI, label: 'KPI' },
  { value: ChartType.TABLE, label: 'Table' },
];

function buildChartSourceLabel(chart: Chart): string | null {
  const parts = [chart.dataset_name, chart.dataset_table_name]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

export default function ExplorePage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'explore_charts', 'edit');
  const deleteChart = useDeleteChart();

  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ChartType>('all');
  const [scopeFilter, setScopeFilter] = useState<ChartListScope>('all');
  const [chartToDelete, setChartToDelete] = useState<Chart | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingChart, setIsDeletingChart] = useState(false);
  const [shareChart, setShareChart] = useState<Chart | null>(null);

  const debouncedSearchText = useDebouncedValue(searchText.trim(), 250);
  const activeFilterCount = Number(Boolean(searchText.trim())) + Number(typeFilter !== 'all') + Number(scopeFilter !== 'all');

  const { data: allCharts = [] } = useCharts({
    limit: 500,
    sort: 'updated_desc',
  });
  const { data: charts = [], isLoading } = useCharts({
    limit: 500,
    q: debouncedSearchText || undefined,
    chart_type: typeFilter !== 'all' ? typeFilter : undefined,
    scope: scopeFilter,
    sort: debouncedSearchText ? 'relevance' : 'updated_desc',
  });

  const chartTypesUsed = new Set(allCharts.map((chart) => chart.chart_type)).size;
  const updatedThisWeek = allCharts.filter((chart) => {
    const updatedAt = new Date(chart.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;

  const description = activeFilterCount > 0
    ? `Showing ${charts.length} of ${allCharts.length} accessible charts`
    : `${allCharts.length} saved chart${allCharts.length !== 1 ? 's' : ''}`;

  const handleDeleteChart = (chart: Chart) => {
    setChartToDelete(chart);
    setDeleteConstraints(null);
  };

  const confirmDeleteChart = async () => {
    if (!chartToDelete) return;
    setIsDeletingChart(true);
    try {
      await deleteChart.mutateAsync(chartToDelete.id);
      toast.success(`Da xoa bieu do "${chartToDelete.name}"`);
      setChartToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Khong the xoa: ${detail || error.message}`);
        setChartToDelete(null);
      }
    } finally {
      setIsDeletingChart(false);
    }
  };

  const clearFilters = () => {
    setSearchText('');
    setTypeFilter('all');
    setScopeFilter('all');
  };

  return (
    <>
      <PageListLayout
        title={t('module.explore.title')}
        description={description}
        overview={(
          <ModuleOverview
            icon={BarChart3}
            title={t('overview.explore.title')}
            description={t('overview.explore.description')}
            badges={[t('overview.explore.badge1'), t('overview.explore.badge2'), t('overview.explore.badge3')]}
            stats={[
              {
                label: t('overview.explore.saved'),
                value: allCharts.length,
                helper: t('overview.explore.savedHelper'),
              },
              {
                label: t('overview.explore.types'),
                value: chartTypesUsed,
                helper: t('overview.explore.typesHelper'),
              },
              {
                label: t('overview.explore.updated'),
                value: updatedThisWeek,
                helper: t('overview.explore.updatedHelper'),
              },
            ]}
          />
        )}
        action={canEdit ? (
          <button
            onClick={() => router.push('/explore/new')}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t('action.newChart')}
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder="Search by name, dataset, metric, tag..."
        searchValue={searchText}
        onSearchValueChange={setSearchText}
        defaultView="list"
        toolbarExtra={(
          <>
            <label className="flex min-w-[190px] flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Chart type
              </span>
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as 'all' | ChartType)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {CHART_TYPE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex min-w-[170px] flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Ownership
              </span>
              <select
                value={scopeFilter}
                onChange={(event) => setScopeFilter(event.target.value as ChartListScope)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All accessible</option>
                <option value="mine">Mine only</option>
                <option value="shared">Shared only</option>
              </select>
            </label>

            <button
              type="button"
              onClick={clearFilters}
              disabled={activeFilterCount === 0}
              className="mt-6 inline-flex items-center justify-center rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="mr-2 h-4 w-4" />
              Clear filters
            </button>
          </>
        )}
      >
        {({ viewMode }) => {
          if (!allCharts.length && !isLoading) {
            return (
              <div className="flex h-64 flex-col items-center justify-center text-center">
                <BarChart3 className="mb-4 h-14 w-14 text-gray-300" />
                <h3 className="mb-1 text-lg font-medium text-gray-700">No saved charts yet</h3>
                <p className="mb-4 text-sm text-gray-500">Create your first chart from a dataset table</p>
                {canEdit && (
                  <button
                    onClick={() => router.push('/explore/new')}
                    className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
                  >
                    <Plus className="h-4 w-4" />
                    New Chart
                  </button>
                )}
              </div>
            );
          }

          return (
            <div className="space-y-6">
              {charts.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-center">
                  <Search className="mb-2 h-8 w-8 text-gray-300" />
                  <p className="text-sm text-gray-500">No charts match the current search or filters.</p>
                </div>
              ) : viewMode === 'list' ? (
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <div className="flex flex-col divide-y divide-gray-100">
                    {charts.map((chart) => {
                      const config = chart.config as any;
                      const activeRoleConfig = getActiveChartRoleConfig(config);
                      const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                      const createdAt = new Date(chart.created_at).toLocaleDateString(locale, {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                      });
                      const itemPerms = getResourcePermissions(chart.user_permission);
                      const sourceLabel = buildChartSourceLabel(chart);

                      return (
                        <div
                          key={chart.id}
                          className="group flex cursor-pointer gap-4 px-4 py-4 transition-colors hover:bg-gray-50"
                          onClick={() => router.push(`/explore/${chart.id}`)}
                        >
                          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-blue-50">
                            <BarChart3 className="h-4 w-4 text-blue-600" />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold text-gray-900">{chart.name}</p>
                              {chart.is_shared && (
                                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                                  Shared
                                </span>
                              )}
                              <OwnerBadge email={chart.owner_email} />
                            </div>

                            {sourceLabel && (
                              <p className="mt-1 truncate text-xs font-medium text-gray-600">{sourceLabel}</p>
                            )}

                            {chart.description ? (
                              <p className="mt-1 truncate text-xs text-gray-500">{chart.description}</p>
                            ) : activeRoleConfig?.dimension ? (
                              <p className="mt-1 flex items-center gap-1 truncate text-xs text-gray-500">
                                <Layers className="h-3 w-3 flex-shrink-0" />
                                {activeRoleConfig.dimension}
                              </p>
                            ) : null}
                          </div>

                          <div className="flex flex-col items-end gap-2 text-xs">
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                              {typeLabel}
                            </span>
                            <span className="flex items-center gap-1 text-gray-400">
                              <Clock className="h-3 w-3" />
                              {createdAt}
                            </span>
                            <div className="flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100">
                              {itemPerms.canShare && (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setShareChart(chart);
                                  }}
                                  className="rounded p-1 text-gray-400 transition-colors hover:bg-purple-50 hover:text-purple-600"
                                  title="Share"
                                >
                                  <Share2 className="h-4 w-4" />
                                </button>
                              )}
                              {itemPerms.canDelete && (
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteChart(chart);
                                  }}
                                  className="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                  title="Delete"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {charts.map((chart) => {
                    const config = chart.config as any;
                    const activeRoleConfig = getActiveChartRoleConfig(config);
                    const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                    const createdAt = new Date(chart.created_at).toLocaleDateString(locale, {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    });
                    const itemPerms = getResourcePermissions(chart.user_permission);
                    const sourceLabel = buildChartSourceLabel(chart);

                    return (
                      <div
                        key={chart.id}
                        className="group flex cursor-pointer flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md"
                        onClick={() => router.push(`/explore/${chart.id}`)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                            <BarChart3 className="h-5 w-5 text-blue-600" />
                          </div>
                          <div className="flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100">
                            {itemPerms.canShare && (
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setShareChart(chart);
                                }}
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-purple-50 hover:text-purple-600"
                                title="Share"
                              >
                                <Share2 className="h-4 w-4" />
                              </button>
                            )}
                            {itemPerms.canDelete && (
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleDeleteChart(chart);
                                }}
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                title="Delete"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-semibold text-gray-900">{chart.name}</h3>
                            {chart.is_shared && (
                              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                                Shared
                              </span>
                            )}
                          </div>
                          <div className="mt-1">
                            <OwnerBadge email={chart.owner_email} />
                          </div>
                          {sourceLabel && (
                            <p className="mt-2 line-clamp-2 text-xs font-medium text-gray-600">{sourceLabel}</p>
                          )}
                          {chart.description ? (
                            <p className="mt-1 line-clamp-2 text-xs text-gray-500">{chart.description}</p>
                          ) : activeRoleConfig?.dimension ? (
                            <p className="mt-1 flex items-center gap-1 truncate text-xs text-gray-500">
                              <Layers className="h-3 w-3 flex-shrink-0" />
                              {activeRoleConfig.dimension}
                            </p>
                          ) : null}
                        </div>

                        <div className="flex items-center justify-between text-xs text-gray-400">
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                            {typeLabel}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {createdAt}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }}
      </PageListLayout>

      {chartToDelete && (
        <DeleteConstraintModal
          itemName={chartToDelete.name}
          itemTypeLabel="bieu do"
          constraints={deleteConstraints}
          isDeleting={isDeletingChart}
          onConfirm={confirmDeleteChart}
          onClose={() => {
            setChartToDelete(null);
            setDeleteConstraints(null);
          }}
        />
      )}

      {shareChart && (
        <ShareDialog
          resourceType="chart"
          resourceId={shareChart.id}
          resourceName={shareChart.name}
          onClose={() => setShareChart(null)}
        />
      )}
    </>
  );
}
