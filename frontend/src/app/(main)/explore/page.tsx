/**
 * Explore - list of saved charts.
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, BarChart3, Clock, Layers, Search, Share2 } from 'lucide-react';
import { useCharts, useDeleteChart } from '@/hooks/use-charts';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { PageListLayout } from '@/components/common/PageListLayout';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag, filterTagBaseClass } from '@/components/ui/FilterTag';
import { useI18n } from '@/providers/LanguageProvider';
import { toast } from '@/lib/toast';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartType } from '@/types/api';
import type { Chart } from '@/types/api';
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

function buildChartSourceLabel(chart: Chart): string | null {
  const parts = [chart.dataset_name, chart.dataset_table_name]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

const EXPLORE_STATIC_TAG_TONES = {
  neutral: 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary',
  brand: 'border-brand/20 bg-brand/10 text-brand',
} as const;

function ExploreStaticTag({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: keyof typeof EXPLORE_STATIC_TAG_TONES;
}) {
  return <span className={`${filterTagBaseClass} ${EXPLORE_STATIC_TAG_TONES[tone]}`}>{children}</span>;
}

export default function ExplorePage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'explore_charts', 'edit');
  const deleteChart = useDeleteChart();

  const [searchText, setSearchText] = useState('');
  const [listFilters, setListFilters] = useState<{ type?: string; scope?: string; owner?: string }>({});
  const [chartToDelete, setChartToDelete] = useState<Chart | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingChart, setIsDeletingChart] = useState(false);
  const [shareChart, setShareChart] = useState<Chart | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  const { data: allCharts = [], isLoading } = useCharts({ limit: 500, sort: 'updated_desc' });

  const chartTypesUsed = new Set(allCharts.map((chart) => chart.chart_type)).size;
  const updatedThisWeek = allCharts.filter((chart) => {
    const updatedAt = new Date(chart.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;

  const toggleListFilter = (key: 'type' | 'scope' | 'owner', value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

  const filteredCharts = allCharts.filter((chart) => {
    const needle = searchText.trim().toLowerCase();
    const sourceLabel = buildChartSourceLabel(chart)?.toLowerCase() ?? '';
    const config = chart.config as any;
    const activeRoleConfig = getActiveChartRoleConfig(config);
    const scopeValue = chart.is_owned_by_current_user ? 'mine' : 'shared';
    const matchesSearch =
      needle.length === 0 ||
      chart.name.toLowerCase().includes(needle) ||
      (chart.description ?? '').toLowerCase().includes(needle) ||
      sourceLabel.includes(needle) ||
      (activeRoleConfig?.dimension ?? '').toLowerCase().includes(needle) ||
      (chart.owner_email ?? '').toLowerCase().includes(needle) ||
      (CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type).toLowerCase().includes(needle);

    return (
      matchesSearch &&
      (!listFilters.type || chart.chart_type === listFilters.type) &&
      (!listFilters.scope || scopeValue === listFilters.scope) &&
      (!listFilters.owner || chart.owner_email === listFilters.owner)
    );
  });

  const description = searchText.trim().length > 0 || activeListFilterCount > 0
    ? `Showing ${filteredCharts.length} of ${allCharts.length} saved charts`
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
      toast.success(`Đã xoá biểu đồ "${chartToDelete.name}"`);
      setChartToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Không thể xoá: ${detail || error.message}`);
        setChartToDelete(null);
      }
    } finally {
      setIsDeletingChart(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: number[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      if (allSelected) return new Set();
      return new Set(ids);
    });
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size === 0) return;
    setIsBulkDeleteOpen(true);
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkDeleteOpen(false);
    setIsBulkDeleting(true);
    let successCount = 0;
    let failCount = 0;
    for (const id of selectedIds) {
      try {
        await deleteChart.mutateAsync(id);
        successCount++;
      } catch {
        failCount++;
      }
    }
    setSelectedIds(new Set());
    setIsBulkDeleting(false);
    if (successCount > 0) toast.success(`Deleted ${successCount} chart(s)`);
    if (failCount > 0) toast.error(`Failed to delete ${failCount} chart(s)`);
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
              { label: t('overview.explore.saved'), value: allCharts.length, helper: t('overview.explore.savedHelper') },
              { label: t('overview.explore.types'), value: chartTypesUsed, helper: t('overview.explore.typesHelper') },
              { label: t('overview.explore.updated'), value: updatedThisWeek, helper: t('overview.explore.updatedHelper') },
            ]}
          />
        )}
        action={canEdit ? (
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => router.push('/explore/new')}
          >
            {t('action.newChart')}
          </Button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder="Search by name, dataset, metric, tag..."
        searchValue={searchText}
        onSearchValueChange={setSearchText}
        defaultView="list"
        activeFilters={activeListFilterCount > 0 ? (
          <>
            {listFilters.type && (
              <FilterTag tone="brand" active onClick={() => toggleListFilter('type', listFilters.type!)}>
                {CHART_TYPE_LABELS[listFilters.type] ?? listFilters.type}
              </FilterTag>
            )}
            {listFilters.scope && (
              <FilterTag
                tone={listFilters.scope === 'mine' ? 'info' : 'brand'}
                active
                onClick={() => toggleListFilter('scope', listFilters.scope!)}
              >
                {listFilters.scope === 'mine' ? 'Mine' : 'Shared'}
              </FilterTag>
            )}
            {listFilters.owner && (
              <FilterTag active onClick={() => toggleListFilter('owner', listFilters.owner!)}>
                Owner: {listFilters.owner.split('@')[0]}
              </FilterTag>
            )}
            <Button variant="ghost" size="xs" onClick={clearListFilters}>
              Clear filters
            </Button>
          </>
        ) : null}
      >
        {({ viewMode }) => {
          if (!allCharts.length && !isLoading) {
            return (
              <EmptyState
                icon={<BarChart3 />}
                title="No saved charts yet"
                description="Create your first chart from a dataset table."
                action={canEdit ? (
                  <Button
                    variant="primary"
                    size="sm"
                    leadingIcon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => router.push('/explore/new')}
                  >
                    New Chart
                  </Button>
                ) : undefined}
              />
            );
          }

          return (
            <PaginatedCollection
              items={filteredCharts}
              viewMode={viewMode}
              resetKey={JSON.stringify({ searchText, viewMode, listFilters })}
            >
              {({ pageItems, pagination }) => (
                <div className="space-y-6">
                  {filteredCharts.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">No charts match the current search or tag filters.</p>
                    </div>
                  ) : viewMode === 'list' ? (
                    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
                  <div className="app-list-table-wrap">
                  <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                    <thead className="bg-surface-2">
                      <tr>
                        {canEdit && (
                          <th className="w-10 px-3 py-3">
                            <input
                              type="checkbox"
                              checked={pageItems.length > 0 && pageItems.every((c) => selectedIds.has(c.id))}
                              ref={(el) => { if (el) el.indeterminate = pageItems.some((c) => selectedIds.has(c.id)) && !pageItems.every((c) => selectedIds.has(c.id)); }}
                              onChange={() => toggleSelectAll(pageItems.map((c) => c.id))}
                              className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                            />
                          </th>
                        )}
                        <th className="app-list-header w-[34%]">
                          Chart
                        </th>
                        <th className="app-list-header w-[20%]">
                          Tags
                        </th>
                        <th className="app-list-header w-[16%]">
                          Owner
                        </th>
                        <th className="app-list-header w-[14%]">
                          Updated
                        </th>
                        <th className="app-list-header w-[96px] text-right">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                    {pageItems.map((chart) => {
                      const config = chart.config as any;
                      const activeRoleConfig = getActiveChartRoleConfig(config);
                      const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                      const updatedAt = new Date(chart.updated_at).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
                      const itemPerms = getResourcePermissions(chart.user_permission);
                      const sourceLabel = buildChartSourceLabel(chart);
                      const scopeValue = chart.is_owned_by_current_user ? 'mine' : 'shared';

                      return (
                        <tr
                          key={chart.id}
                          className="hover:bg-surface-2"
                        >
                          {canEdit && (
                            <td className="w-10 px-3 py-4">
                              <input
                                type="checkbox"
                                checked={selectedIds.has(chart.id)}
                                onChange={() => toggleSelect(chart.id)}
                                className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                              />
                            </td>
                          )}
                          <td className="app-list-cell">
                            <button
                              onClick={() => router.push(`/explore/${chart.id}`)}
                              className="text-left min-w-0 w-full"
                            >
                              <div className="flex items-start gap-3">
                                <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                                  <BarChart3 className="h-3.5 w-3.5" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="app-list-text-main text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{chart.name}</div>
                                  {sourceLabel && (
                                    <div className="app-list-text-sub mt-0.5 text-tiny font-emphasis text-text-secondary">{sourceLabel}</div>
                                  )}
                                  {chart.description ? (
                                    <div className="app-list-text-sub mt-0.5 text-tiny text-text-tertiary">{chart.description}</div>
                                  ) : activeRoleConfig?.dimension ? (
                                    <div className="app-list-text-sub mt-0.5 flex items-center gap-1 text-tiny text-text-tertiary">
                                      <Layers className="h-3 w-3 flex-shrink-0" />
                                      {activeRoleConfig.dimension}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          </td>
                          <td className="app-list-cell">
                            <div className="flex flex-wrap gap-1.5">
                              <FilterTag
                                tone="brand"
                                active={listFilters.type === chart.chart_type}
                                onClick={() => toggleListFilter('type', chart.chart_type)}
                              >
                                {typeLabel}
                              </FilterTag>
                              <FilterTag
                                tone={scopeValue === 'mine' ? 'info' : 'brand'}
                                active={listFilters.scope === scopeValue}
                                onClick={() => toggleListFilter('scope', scopeValue)}
                              >
                                {scopeValue === 'mine' ? 'Mine' : 'Shared'}
                              </FilterTag>
                              {chart.is_shared && (
                                <ExploreStaticTag tone="brand">Shared link</ExploreStaticTag>
                              )}
                            </div>
                          </td>
                          <td className="app-list-cell">
                            <OwnerBadge
                              email={chart.owner_email}
                              active={listFilters.owner === chart.owner_email}
                              onClick={chart.owner_email ? () => toggleListFilter('owner', chart.owner_email!) : undefined}
                            />
                          </td>
                          <td className="app-list-cell text-caption text-text-tertiary">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {updatedAt}
                            </span>
                          </td>
                          <td className="app-list-cell-tight text-right">
                            <div className="flex items-center justify-end gap-0.5">
                              {itemPerms.canShare && (
                                <IconButton
                                  aria-label="Share"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => setShareChart(chart)}
                                >
                                  <Share2 className="h-3.5 w-3.5" />
                                </IconButton>
                              )}
                              {itemPerms.canDelete && (
                                <IconButton
                                  aria-label="Delete"
                                  variant="ghost"
                                  size="xs"
                                  className="hover:text-danger hover:bg-danger/10"
                                  onClick={() => handleDeleteChart(chart)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </IconButton>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
              </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {pageItems.map((chart) => {
                    const config = chart.config as any;
                    const activeRoleConfig = getActiveChartRoleConfig(config);
                    const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                    const createdAt = new Date(chart.created_at).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
                    const itemPerms = getResourcePermissions(chart.user_permission);
                    const sourceLabel = buildChartSourceLabel(chart);

                    return (
                      <div
                        key={chart.id}
                        className="group flex cursor-pointer flex-col gap-2.5 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
                        onClick={() => router.push(`/explore/${chart.id}`)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                            <BarChart3 className="h-4 w-4" />
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 transition-all group-hover:opacity-100">
                            {itemPerms.canShare && (
                              <IconButton
                                aria-label="Share"
                                variant="ghost"
                                size="xs"
                                onClick={(event) => { event.stopPropagation(); setShareChart(chart); }}
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                            {itemPerms.canDelete && (
                              <IconButton
                                aria-label="Delete"
                                variant="ghost"
                                size="xs"
                                className="hover:text-danger hover:bg-danger/10"
                                onClick={(event) => { event.stopPropagation(); handleDeleteChart(chart); }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                          </div>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="truncate text-caption font-strong text-text-primary">{chart.name}</h3>
                            {chart.is_shared && <ExploreStaticTag tone="brand">Shared</ExploreStaticTag>}
                          </div>
                          <div className="mt-1">
                            <OwnerBadge email={chart.owner_email} />
                          </div>
                          {sourceLabel && (
                            <p className="mt-1.5 line-clamp-2 text-tiny font-emphasis text-text-secondary">{sourceLabel}</p>
                          )}
                          {chart.description ? (
                            <p className="mt-0.5 line-clamp-2 text-tiny text-text-tertiary">{chart.description}</p>
                          ) : activeRoleConfig?.dimension ? (
                            <p className="mt-0.5 flex items-center gap-1 truncate text-tiny text-text-tertiary">
                              <Layers className="h-3 w-3 flex-shrink-0" />
                              {activeRoleConfig.dimension}
                            </p>
                          ) : null}
                        </div>

                        <div className="flex items-center justify-between text-tiny text-text-quaternary">
                          <ExploreStaticTag>{typeLabel}</ExploreStaticTag>
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

                  {pagination}
                </div>
              )}
            </PaginatedCollection>
          );
        }}
      </PageListLayout>

      {chartToDelete && (
        <DeleteConstraintModal
          itemName={chartToDelete.name}
          itemTypeLabel="biểu đồ"
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

      {canEdit && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          onDelete={handleBulkDeleteClick}
          onClear={() => setSelectedIds(new Set())}
          isDeleting={isBulkDeleting}
        />
      )}

      <ConfirmDialog
        isOpen={isBulkDeleteOpen}
        onClose={() => setIsBulkDeleteOpen(false)}
        onConfirm={handleBulkDelete}
        title={`Xoá ${selectedIds.size} biểu đồ?`}
        description="Hành động này không thể hoàn tác. Tất cả biểu đồ đã chọn sẽ bị xoá vĩnh viễn."
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        variant="danger"
      />
    </>
  );
}
