'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, LayoutDashboard, Clock, Eye, Trash2, Search, Globe, Share2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { useDashboards, useCreateDashboard, useDeleteDashboard } from '@/hooks/use-dashboards';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { DashboardList } from '@/components/dashboards/DashboardList';
import { CrossModuleFilterControls } from '@/components/common/CrossModuleFilterControls';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { PageListLayout } from '@/components/common/PageListLayout';
import { GettingStartedGuide } from '@/components/common/GettingStartedGuide';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { Modal } from '@/components/common/Modal';
import { DashboardHtmlImportModal } from '@/components/dashboards/DashboardHtmlImportModal';
import { Button, IconButton } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Input, Textarea, FieldGroup } from '@/components/ui/Input';
import { useCharts } from '@/hooks/use-charts';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasets } from '@/hooks/use-datasets';
import {
  buildCatalogRelationIndex,
  getRelatedFilterLabel,
  matchesRelatedFilters,
} from '@/lib/module-relations';
import { useI18n } from '@/providers/LanguageProvider';
import type { Dashboard } from '@/types/api';

type DashboardListFilters = {
  state?: string;
  access?: string;
  owner?: string;
  dataset?: string;
  chart?: string;
  source?: string;
};

export default function DashboardsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [isCreating, setIsCreating] = useState(false);
  const [listFilters, setListFilters] = useState<DashboardListFilters>({});
  const [newDashboardName, setNewDashboardName] = useState('');
  const [newDashboardDescription, setNewDashboardDescription] = useState('');
  const [dashboardToDelete, setDashboardToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingDashboard, setIsDeletingDashboard] = useState(false);
  const [publicShareDash, setPublicShareDash] = useState<Dashboard | null>(null);
  const [shareDash, setShareDash] = useState<Dashboard | null>(null);
  const [isHtmlImportOpen, setIsHtmlImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const { data: dashboards, isLoading } = useDashboards();
  const { data: charts = [] } = useCharts({ limit: 500, sort: 'updated_desc' });
  const { data: datasets = [] } = useDatasets();
  const { data: dataSources = [] } = useDataSources();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'dashboards', 'edit');
  const createMutation = useCreateDashboard();
  const deleteMutation = useDeleteDashboard();
  const dashboardItems = dashboards ?? [];
  const relationIndex = useMemo(
    () => buildCatalogRelationIndex({
      dashboards: dashboardItems,
      charts,
      datasets,
      datasources: dataSources,
    }),
    [dashboardItems, charts, datasets, dataSources],
  );
  const totalChartLinks = dashboardItems.reduce(
    (sum, dashboard) => sum + (dashboard.dashboard_charts?.length || 0),
    0,
  );
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;
  const dashboardsUpdatedThisWeek = dashboardItems.filter((dashboard) => {
    const updatedAt = new Date(dashboard.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;

  const setListFilter = (key: keyof DashboardListFilters, value?: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: value || undefined,
    }));
  };

  const toggleListFilter = (key: keyof DashboardListFilters, value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await createMutation.mutateAsync({
        name: newDashboardName,
        description: newDashboardDescription || undefined,
      });
      setNewDashboardName('');
      setNewDashboardDescription('');
      setIsCreating(false);
    } catch (error: any) {
      toast.error(`Could not create dashboard: ${error.message}`);
    }
  };

  const handleDelete = (id: number) => {
    const dashboard = dashboards?.find((item) => item.id === id);
    if (!dashboard) return;
    setDashboardToDelete({ id: dashboard.id, name: dashboard.name });
    setDeleteConstraints(null);
  };

  const confirmDelete = async () => {
    if (!dashboardToDelete) return;
    setIsDeletingDashboard(true);
    try {
      await deleteMutation.mutateAsync(dashboardToDelete.id);
      setDashboardToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Could not delete dashboard: ${detail || error.message}`);
        setDashboardToDelete(null);
      }
    } finally {
      setIsDeletingDashboard(false);
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
    const confirmed = window.confirm(`Delete ${selectedIds.size} dashboard(s)? This action cannot be undone.`);
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
    if (successCount > 0) toast.success(`Deleted ${successCount} dashboard(s)`);
    if (failCount > 0) toast.error(`Failed to delete ${failCount} dashboard(s)`);
  };

  return (
    <>
      <PageListLayout
        title={t('module.dashboards.title')}
        description={`${dashboards?.length ?? 0} dashboard${dashboards?.length !== 1 ? 's' : ''}`}
        overview={(
          <div className="space-y-4">
            <GettingStartedGuide locale={locale} />
            <ModuleOverview
              icon={LayoutDashboard}
              title={t('overview.dashboards.title')}
              description={t('overview.dashboards.description')}
              badges={[t('overview.dashboards.badge1'), t('overview.dashboards.badge2'), t('overview.dashboards.badge3')]}
              stats={[
                { label: t('overview.dashboards.saved'), value: dashboardItems.length, helper: t('overview.dashboards.savedHelper') },
                { label: t('overview.dashboards.charts'), value: totalChartLinks, helper: t('overview.dashboards.chartsHelper') },
                { label: t('overview.dashboards.updated'), value: dashboardsUpdatedThisWeek, helper: t('overview.dashboards.updatedHelper') },
              ]}
            />
          </div>
        )}
        action={canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />}
              onClick={() => setIsHtmlImportOpen(true)}
            >
              Import HTML
            </Button>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setIsCreating(true)}
            >
              {t('action.newDashboard')}
            </Button>
          </div>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="list"
        toolbarExtra={(
          <CrossModuleFilterControls
            index={relationIndex}
            configs={[
              { key: 'dataset', label: 'Dataset', placeholder: 'All datasets' },
              { key: 'chart', label: 'Chart', placeholder: 'All charts' },
              { key: 'source', label: 'Source', placeholder: 'All sources' },
            ]}
            filters={{
              dataset: listFilters.dataset,
              chart: listFilters.chart,
              source: listFilters.source,
            }}
            onChange={(key, value) => setListFilter(key as keyof DashboardListFilters, value)}
          />
        )}
        activeFilters={activeListFilterCount > 0 ? (
          <>
            {listFilters.state && (
              <FilterTag
                tone={listFilters.state === 'linked' ? 'success' : 'warning'}
                active
                onClick={() => toggleListFilter('state', listFilters.state!)}
              >
                {listFilters.state === 'linked' ? 'Linked' : 'Empty'}
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
            {listFilters.source && (
              <FilterTag tone="brand" active onClick={() => setListFilter('source')}>
                Source: {getRelatedFilterLabel(relationIndex, 'source', listFilters.source)}
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
          const filtered = (dashboards ?? []).filter((dashboard) => {
            const chartState = (dashboard.dashboard_charts?.length || 0) > 0 ? 'linked' : 'empty';
            const accessState = dashboard.user_permission ?? 'none';
            const relations = relationIndex.dashboardRelationsById.get(dashboard.id);
            const matchesSearch =
              needle.length === 0 ||
              dashboard.name.toLowerCase().includes(needle) ||
              dashboard.description?.toLowerCase().includes(needle) ||
              (dashboard.owner_email ?? '').toLowerCase().includes(needle);

            return (
              matchesSearch &&
              (!listFilters.state || chartState === listFilters.state) &&
              (!listFilters.access || accessState === listFilters.access) &&
              (!listFilters.owner || dashboard.owner_email === listFilters.owner) &&
              matchesRelatedFilters(relations, {
                dataset: listFilters.dataset,
                chart: listFilters.chart,
                source: listFilters.source,
              })
            );
          });

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters })}
            >
              {({ pageItems, pagination }) => (
                <div className="space-y-3">
                  {(!dashboards || dashboards.length === 0) ? (
                    <DashboardList dashboards={[]} onDelete={handleDelete} />
                  ) : filtered.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">
                        No dashboards matching &ldquo;<strong className="text-text-primary">{filterText}</strong>&rdquo;
                      </p>
                    </div>
                  ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {pageItems.map((dashboard) => {
                    const chartCount = dashboard.dashboard_charts?.length || 0;
                    const createdAt = new Date(dashboard.created_at).toLocaleDateString(locale, {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    });

                    return (
                      <div
                        key={dashboard.id}
                        className="group flex flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
                      >
                        <div className="flex-1 p-4">
                          <div className="mb-3 flex items-start justify-between">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                              <LayoutDashboard className="h-4 w-4" />
                            </div>
                            {getResourcePermissions(dashboard.user_permission).canDelete && (
                              <IconButton
                                aria-label="Delete"
                                variant="ghost"
                                size="xs"
                                onClick={() => handleDelete(dashboard.id)}
                                className="opacity-0 transition-opacity group-hover:opacity-100 text-text-tertiary hover:text-danger"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                          </div>
                          <h3 className="mb-1 truncate text-caption font-strong text-text-primary">{dashboard.name}</h3>
                          <OwnerBadge email={dashboard.owner_email} />
                          {dashboard.description && (
                            <p className="mt-1.5 line-clamp-2 text-caption text-text-tertiary">{dashboard.description}</p>
                          )}
                          <div className="mt-3 flex items-center justify-between text-tiny text-text-quaternary">
                            <span>{chartCount} chart{chartCount !== 1 ? 's' : ''}</span>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {createdAt}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-2.5 rounded-b-xl">
                          <div className="flex items-center gap-3">
                            {getResourcePermissions(dashboard.user_permission).canShare && (
                              <button
                                onClick={() => setShareDash(dashboard)}
                                className="flex items-center gap-1 text-tiny text-text-tertiary transition-colors hover:text-brand"
                                title="Share"
                              >
                                <Share2 className="h-3 w-3" />
                                Share
                              </button>
                            )}
                            {getResourcePermissions(dashboard.user_permission).canEdit && (
                              <button
                                onClick={() => setPublicShareDash(dashboard)}
                                className="flex items-center gap-1 text-tiny text-text-tertiary transition-colors hover:text-brand"
                                title="Public links"
                              >
                                <Globe className="h-3 w-3" />
                                Public links
                              </button>
                            )}
                          </div>
                          <button
                            onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                            className="ml-auto flex items-center gap-1 text-tiny font-emphasis text-brand transition-colors hover:text-brand-hover"
                          >
                            <Eye className="h-3 w-3" />
                            Open
                          </button>
                        </div>
                      </div>
                    );
                      })}
                    </div>
                  ) : (
                    <DashboardList
                      dashboards={pageItems}
                      onDelete={canEdit ? handleDelete : undefined}
                      onShare={(dashboard) => setShareDash(dashboard)}
                      deletingId={isDeletingDashboard ? dashboardToDelete?.id : undefined}
                      activeFilters={listFilters}
                      onFilterClick={(key, value) => toggleListFilter(key as keyof DashboardListFilters, value)}
                      selectedIds={canEdit ? selectedIds : undefined}
                      onToggleSelect={canEdit ? toggleSelect : undefined}
                      onToggleSelectAll={canEdit ? toggleSelectAll : undefined}
                    />
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

      <Modal
        isOpen={isCreating}
        onClose={() => {
          setIsCreating(false);
          setNewDashboardName('');
          setNewDashboardDescription('');
        }}
        title="Create New Dashboard"
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsCreating(false);
                setNewDashboardName('');
                setNewDashboardDescription('');
              }}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              disabled={createMutation.isPending || !newDashboardName}
              loading={createMutation.isPending}
            >
              Create
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} className="space-y-3">
          <FieldGroup label="Dashboard Name" required>
            <Input
              value={newDashboardName}
              onChange={(event) => setNewDashboardName(event.target.value)}
              required
              autoFocus
            />
          </FieldGroup>
          <FieldGroup label="Description">
            <Textarea
              value={newDashboardDescription}
              onChange={(event) => setNewDashboardDescription(event.target.value)}
              rows={3}
            />
          </FieldGroup>
        </form>
      </Modal>

      {dashboardToDelete && (
        <DeleteConstraintModal
          itemName={dashboardToDelete.name}
          itemTypeLabel="dashboard"
          constraints={deleteConstraints}
          isDeleting={isDeletingDashboard}
          onConfirm={confirmDelete}
          onClose={() => {
            setDashboardToDelete(null);
            setDeleteConstraints(null);
          }}
        />
      )}

      {publicShareDash && (
        <PublicLinksManager
          dashboardId={publicShareDash.id}
          dashboardName={publicShareDash.name}
          onClose={() => setPublicShareDash(null)}
        />
      )}

      {shareDash && (
        <ShareDialog
          resourceType="dashboard"
          resourceId={shareDash.id}
          resourceName={shareDash.name}
          onClose={() => setShareDash(null)}
        />
      )}

      {isHtmlImportOpen && (
        <DashboardHtmlImportModal
          isOpen={isHtmlImportOpen}
          onClose={() => setIsHtmlImportOpen(false)}
          targetMode="new_dashboard"
        />
      )}
    </>
  );
}
