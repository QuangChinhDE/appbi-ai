/**
 * Data Sources Management Page — List + Query Runner
 */
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Database, Edit, TestTube, Trash2, Clock, Search, Share2, ChevronDown } from 'lucide-react';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { CrossModuleFilterControls } from '@/components/common/CrossModuleFilterControls';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PageListLayout } from '@/components/common/PageListLayout';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { FilterTag } from '@/components/ui/FilterTag';
import { useI18n } from '@/providers/LanguageProvider';
import { toast } from '@/lib/toast';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { useCharts } from '@/hooks/use-charts';
import { useDashboards } from '@/hooks/use-dashboards';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import {
  useDataSources,
  useDeleteDataSource,
  useTestDataSource,
  useExecuteQuery,
} from '@/hooks/use-datasources';
import { useDatasets } from '@/hooks/use-datasets';
import DataSourceList from '@/components/datasources/DataSourceList';
import QueryRunner from '@/components/datasources/QueryRunner';
import {
  buildCatalogRelationIndex,
  getRelatedFilterLabel,
  matchesRelatedFilters,
} from '@/lib/module-relations';
import type { DataSource, QueryExecuteResponse } from '@/types/api';

const DS_TYPE_LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL', mysql: 'MySQL', bigquery: 'BigQuery',
  google_sheets: 'Google Sheets', manual: 'Manual Table',
};

type View = 'list' | 'query';

type DataSourceListFilters = {
  type?: string;
  access?: string;
  owner?: string;
  dashboard?: string;
  dataset?: string;
  chart?: string;
};

function extractQueryErrorMessage(error: any, fallback = 'Failed to run query'): string {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail?.message) return detail.message;
  return error?.message || fallback;
}

export default function DataSourcesPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [currentView, setCurrentView] = useState<View>('list');
  const [listFilters, setListFilters] = useState<DataSourceListFilters>({});
  const [sourceToDelete, setSourceToDelete] = useState<DataSource | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingSource, setIsDeletingSource] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryExecuteResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [shareSource, setShareSource] = useState<DataSource | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'data_sources', 'edit');
  const canShare = hasPermission(permData?.permissions, 'data_sources', 'full');

  const { data: dataSources = [], isLoading } = useDataSources();
  const { data: dashboards = [] } = useDashboards();
  const { data: charts = [] } = useCharts({ limit: 500, sort: 'updated_desc' });
  const { data: datasets = [] } = useDatasets();
  const deleteMutation = useDeleteDataSource();
  const testMutation = useTestDataSource();
  const executeMutation = useExecuteQuery();
  const relationIndex = useMemo(
    () => buildCatalogRelationIndex({
      dashboards,
      charts,
      datasets,
      datasources: dataSources,
    }),
    [dashboards, charts, datasets, dataSources],
  );
  const distinctSourceTypes = new Set(dataSources.map((source) => source.type)).size;
  const googleSheetsSources = dataSources.filter((source) => source.type === 'google_sheets').length;
  const manualSources = dataSources.filter((source) => source.type === 'manual').length;
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;

  const setListFilter = (key: keyof DataSourceListFilters, value?: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: value || undefined,
    }));
  };

  const toggleListFilter = (key: keyof DataSourceListFilters, value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

  const handleDelete = (id: number) => {
    const source = dataSources.find((s) => s.id === id);
    if (source) { setSourceToDelete(source); setDeleteConstraints(null); }
  };

  const confirmDeleteSource = async () => {
    if (!sourceToDelete) return;
    setIsDeletingSource(true);
    try {
      await deleteMutation.mutateAsync(sourceToDelete.id);
      setSourceToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Không thể xóa: ${detail || error.message}`);
        setSourceToDelete(null);
      }
    } finally {
      setIsDeletingSource(false);
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

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(`Delete ${selectedIds.size} data source(s)? This action cannot be undone.`);
    if (!confirmed) return;
    setIsBulkDeleting(true);
    let successCount = 0;
    let failCount = 0;
    for (const id of selectedIds) {
      try {
        await deleteMutation.mutateAsync(id);
        successCount++;
      } catch {
        failCount++;
      }
    }
    setSelectedIds(new Set());
    setIsBulkDeleting(false);
    if (successCount > 0) toast.success(`Deleted ${successCount} data source(s)`);
    if (failCount > 0) toast.error(`Failed to delete ${failCount} data source(s)`);
  };

  const handleEdit = (dataSource: DataSource) => {
    router.push(`/datasources/${dataSource.id}/edit`);
  };

  const handleTest = async (dataSource: DataSource) => {
    try {
      const result = await testMutation.mutateAsync({
        type: dataSource.type,
        config: dataSource.config,
        data_source_id: dataSource.id,
      });
      if (result.success) {
        toast.success(`Connection successful: ${result.message}`);
      } else {
        toast.error(`Connection failed: ${result.message}`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.detail || error.message);
    }
  };

  const handleExecuteQuery = async (params: {
    data_source_id: number;
    sql_query: string;
    limit: number;
    timeout_seconds: number;
  }) => {
    setQueryError(null);
    setQueryResult(null);
    try {
      const result = await executeMutation.mutateAsync(params);
      setQueryResult(result);
    } catch (error: any) {
      setQueryError(extractQueryErrorMessage(error));
    }
  };

  // Query sub-view
  if (currentView === 'query') {
    return (
      <div className="p-8">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => { setCurrentView('list'); setQueryResult(null); setQueryError(null); }}
            className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            All Data Sources
          </button>
          <span className="text-text-quaternary">/</span>
          <h1 className="text-small font-strong text-text-primary">Query Runner</h1>
        </div>
        <QueryRunner
          dataSources={dataSources}
          onExecute={handleExecuteQuery}
          result={queryResult}
          isExecuting={executeMutation.isPending}
          error={queryError}
        />
      </div>
    );
  }

  // List view via standard template
  return (
    <>
      <PageListLayout
        title={t('module.datasources.title')}
        description={`${dataSources.length} connection${dataSources.length !== 1 ? 's' : ''} configured`}
        overview={(
          <ModuleOverview
            icon={Database}
            title={t('overview.datasources.title')}
            description={t('overview.datasources.description')}
            badges={[t('overview.datasources.badge1'), t('overview.datasources.badge2'), t('overview.datasources.badge3')]}
            stats={[
              {
                label: t('overview.datasources.connections'),
                value: dataSources.length,
                helper: t('overview.datasources.connectionsHelper'),
              },
              {
                label: t('overview.datasources.types'),
                value: distinctSourceTypes,
                helper: t('overview.datasources.typesHelper'),
              },
              {
                label: t('overview.datasources.sheetsManual'),
                value: `${googleSheetsSources} / ${manualSources}`,
                helper: t('overview.datasources.sheetsManualHelper'),
              },
            ]}
          />
        )}
        action={canEdit ? (
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Plus className="w-4 h-4" />}
            onClick={() => router.push('/datasources/new')}
          >
            {t('action.newDataSource')}
          </Button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="list"
        toolbarExtra={(
          <div className="relative">
            <select
              value={listFilters.type ?? ''}
              onChange={(e) => setListFilter('type', e.target.value || undefined)}
              className={`h-8 appearance-none rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 pl-2.5 pr-8 text-caption focus:outline-none focus:shadow-focus-brand ${listFilters.type ? 'text-text-primary' : 'text-text-tertiary'}`}
            >
              <option value="">All source types</option>
              {Array.from(new Set(dataSources.map((s) => s.type)))
                .sort()
                .map((tp) => (
                  <option key={tp} value={tp}>
                    {DS_TYPE_LABEL[tp] ?? tp}
                  </option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
        )}
        activeFilters={activeListFilterCount > 0 ? (
          <>
            {listFilters.type && (
              <FilterTag tone="brand" active onClick={() => toggleListFilter('type', listFilters.type!)}>
                {DS_TYPE_LABEL[listFilters.type] ?? listFilters.type}
              </FilterTag>
            )}
            {listFilters.access && (
              <FilterTag tone="info" active onClick={() => toggleListFilter('access', listFilters.access!)}>
                {listFilters.access === 'full'
                  ? 'Full access'
                  : listFilters.access === 'edit'
                    ? 'Editable'
                    : listFilters.access === 'view'
                      ? 'View only'
                      : 'Restricted'}
              </FilterTag>
            )}
            {listFilters.owner && (
              <FilterTag active onClick={() => toggleListFilter('owner', listFilters.owner!)}>
                Owner: {listFilters.owner.split('@')[0]}
              </FilterTag>
            )}
            {listFilters.dashboard && (
              <FilterTag tone="brand" active onClick={() => setListFilter('dashboard')}>
                Dashboard: {getRelatedFilterLabel(relationIndex, 'dashboard', listFilters.dashboard)}
              </FilterTag>
            )}
            {listFilters.dataset && (
              <FilterTag tone="brand" active onClick={() => setListFilter('dataset')}>
                Dataset: {getRelatedFilterLabel(relationIndex, 'dataset', listFilters.dataset)}
              </FilterTag>
            )}
            {listFilters.chart && (
              <FilterTag tone="brand" active onClick={() => setListFilter('chart')}>
                Chart: {getRelatedFilterLabel(relationIndex, 'chart', listFilters.chart)}
              </FilterTag>
            )}
            <Button variant="ghost" size="xs" onClick={clearListFilters}>
              Clear filters
            </Button>
          </>
        ) : null}
      >
        {({ viewMode, filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const filtered = dataSources.filter((source) => {
            const relations = relationIndex.sourceRelationsById.get(source.id);
            const matchesSearch =
              needle.length === 0 ||
              source.name.toLowerCase().includes(needle) ||
              (source.description ?? '').toLowerCase().includes(needle) ||
              (source.owner_email ?? '').toLowerCase().includes(needle) ||
              (DS_TYPE_LABEL[source.type] ?? source.type).toLowerCase().includes(needle);

            return (
              matchesSearch &&
              (!listFilters.type || source.type === listFilters.type) &&
              (!listFilters.access || (source.user_permission ?? 'none') === listFilters.access) &&
              (!listFilters.owner || source.owner_email === listFilters.owner) &&
              matchesRelatedFilters(relations, {
                dashboard: listFilters.dashboard,
                dataset: listFilters.dataset,
                chart: listFilters.chart,
              })
            );
          });

          if (dataSources.length === 0) {
            return (
              <DataSourceList
                dataSources={[]}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onTest={handleTest}
              />
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-6 h-6 text-text-quaternary mb-2" />
                <p className="text-caption text-text-tertiary">
                  No data sources matching &quot;<strong className="text-text-primary">{filterText}</strong>&quot;
                </p>
              </div>
            );
          }

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters, currentView })}
            >
              {({ pageItems, pagination }) => (
                <div className="space-y-3">
                  {viewMode === 'list' ? (
                    <DataSourceList
                      dataSources={pageItems}
                      onEdit={canEdit ? handleEdit : undefined}
                      onDelete={canEdit ? handleDelete : undefined}
                      onTest={handleTest}
                      onShare={canShare ? (ds) => setShareSource(ds) : undefined}
                      isDeleting={deleteMutation.isPending ? deleteMutation.variables : null}
                      activeFilters={listFilters}
                      onFilterClick={(key, value) => toggleListFilter(key as keyof DataSourceListFilters, value)}
                      selectedIds={canEdit ? selectedIds : undefined}
                      onToggleSelect={canEdit ? toggleSelect : undefined}
                      onToggleSelectAll={canEdit ? toggleSelectAll : undefined}
                    />
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {pageItems.map(ds => {
                        const typeLabel = DS_TYPE_LABEL[ds.type] ?? ds.type;
                        const createdAt = new Date(ds.created_at).toLocaleDateString('vi-VN', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                        });
                        const itemPerms = getResourcePermissions(ds.user_permission);
                        return (
                          <div
                            key={ds.id}
                            className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 hover:shadow-linear transition-all"
                          >
                            <div className="flex items-start gap-3 mb-3">
                              <div className="w-10 h-10 rounded-lg bg-brand/10 text-brand flex items-center justify-center flex-shrink-0">
                                <Database className="w-5 h-5" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-strong text-text-primary text-caption truncate">{ds.name}</h3>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <OwnerBadge email={ds.owner_email} />
                                  <Badge variant="neutral" size="sm">{typeLabel}</Badge>
                                </div>
                              </div>
                            </div>
                            {ds.description && (
                              <p className="text-tiny text-text-tertiary mb-3 line-clamp-2">{ds.description}</p>
                            )}
                            <div className="text-tiny text-text-quaternary mb-4 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {createdAt}
                            </div>
                            <div className="flex items-center gap-1 pt-3 border-t border-[rgb(var(--border-line))]">
                              {itemPerms.canEdit && (
                                <button
                                  onClick={() => handleEdit(ds)}
                                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-tiny text-text-secondary hover:text-brand hover:bg-brand/10 rounded-md transition-colors"
                                >
                                  <Edit className="w-3.5 h-3.5" /> Edit
                                </button>
                              )}
                              <button
                                onClick={() => handleTest(ds)}
                                disabled={testMutation.isPending}
                                className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-tiny text-text-secondary hover:text-success hover:bg-success/10 rounded-md transition-colors disabled:opacity-50"
                              >
                                <TestTube className="w-3.5 h-3.5" /> Test
                              </button>
                              {itemPerms.canShare && (
                                <button
                                  onClick={() => setShareSource(ds)}
                                  className="inline-flex items-center justify-center p-1.5 text-text-quaternary hover:text-brand hover:bg-brand/10 rounded-md transition-colors"
                                  title="Share"
                                >
                                  <Share2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {itemPerms.canDelete && (
                                <button
                                  onClick={() => handleDelete(ds.id)}
                                  className="inline-flex items-center justify-center p-1.5 text-text-quaternary hover:text-danger hover:bg-danger/10 rounded-md transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
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

      {canEdit && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          onDelete={handleBulkDelete}
          onClear={() => setSelectedIds(new Set())}
          isDeleting={isBulkDeleting}
        />
      )}

      {sourceToDelete && (
        <DeleteConstraintModal
          itemName={sourceToDelete.name}
          itemTypeLabel="data source"
          constraints={deleteConstraints}
          isDeleting={isDeletingSource}
          onConfirm={confirmDeleteSource}
          onClose={() => { setSourceToDelete(null); setDeleteConstraints(null); }}
        />
      )}
      {shareSource && (
        <ShareDialog
          resourceType="datasource"
          resourceId={shareSource.id}
          resourceName={shareSource.name}
          onClose={() => setShareSource(null)}
        />
      )}
    </>
  );
}
