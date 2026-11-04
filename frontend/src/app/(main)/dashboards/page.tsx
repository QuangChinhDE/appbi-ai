'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Plus, LayoutDashboard, Search, Globe, Wand2 } from 'lucide-react';
import { reportCodeApi, type ReportDetail } from '@/lib/api/report-code';
import { reportLinkTarget } from '@/components/report-code/reportLinkTarget';
import { ReportCard, ReportTable, type ReportActions } from '@/components/dashboards/ReportList';
import { manualRow, vibeRow, type ReportRow, type ReportTypeFilter } from '@/components/dashboards/reportRows';
import { toast } from '@/lib/toast';

import { useDashboards, useCreateDashboard, useDeleteDashboard, useDuplicateDashboard } from '@/hooks/use-dashboards';
import { dashboardApi } from '@/lib/api/dashboards';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { CrossModuleFilterControls } from '@/components/common/CrossModuleFilterControls';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ConfirmDialog, ConfirmTargets } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { PageListLayout } from '@/components/common/PageListLayout';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { Modal } from '@/components/common/Modal';
import { DashboardHtmlImportModal } from '@/components/dashboards/DashboardHtmlImportModal';
import { ReportStarterModal } from '@/components/dashboards/ReportStarterModal';
import { Button } from '@/components/ui/Button';
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
  const [isStarterOpen, setIsStarterOpen] = useState(false);
  const [isManualChooserOpen, setIsManualChooserOpen] = useState(false);
  // Selected reports by row KEY (`manual-12` / `vibe-48`): the two builders' ids overlap.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  // Report type filter (Tất cả | Build Manual | AI Vibe Report), kept in ?type= so a
  // link or a reload lands on the same view.
  const [typeFilter, setTypeFilterState] = useState<ReportTypeFilter>('all');
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get('type');
      if (v === 'manual' || v === 'vibe') setTypeFilterState(v);
    } catch { /* no URL */ }
  }, []);
  const setTypeFilter = (next: ReportTypeFilter) => {
    setTypeFilterState(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'all') url.searchParams.delete('type'); else url.searchParams.set('type', next);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch { /* no URL */ }
  };
  const [vibeToDelete, setVibeToDelete] = useState<ReportRow | null>(null);
  const [vibePublic, setVibePublic] = useState<ReportDetail | null>(null);

  const { data: dashboards, isLoading } = useDashboards();
  const queryClient = useQueryClient();
  // AI Vibe Reports, listed with the dashboards (the backend filters by access).
  const { data: vibeReports, isLoading: vibeLoading } = useQuery({
    queryKey: ['report-artifacts'],
    queryFn: () => reportCodeApi.list(),
  });
  const vibeRelations = (row: ReportRow) => {
    const chartIds = row.kind === 'vibe' ? row.vibe.chart_ids ?? [] : [];
    const datasetIds = new Set<number>(row.datasetIds);
    const sourceIds = new Set<number>();
    for (const id of chartIds) {
      const bag = relationIndex.chartRelationsById.get(id);
      bag?.datasetIds.forEach((d) => datasetIds.add(d));
      bag?.sourceIds.forEach((x) => sourceIds.add(x));
    }
    datasetIds.forEach((d) => relationIndex.datasetRelationsById.get(d)?.sourceIds.forEach((x) => sourceIds.add(x)));
    return { dashboardIds: new Set<number>(), chartIds: new Set<number>(chartIds), datasetIds, sourceIds };
  };
  // ONE list of reports, newest change first, whichever way each was built.
  const allRows = useMemo<ReportRow[]>(() => [
    ...(dashboards ?? []).map(manualRow),
    ...(vibeReports ?? []).map(vibeRow),
  ].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), [dashboards, vibeReports]);
  const vibeCount = vibeReports?.length ?? 0;
  const { data: charts = [] } = useCharts({ limit: 500, sort: 'updated_desc' });
  const { data: datasets = [] } = useDatasets();
  const { data: dataSources = [] } = useDataSources();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'dashboards', 'edit');
  const createMutation = useCreateDashboard();
  const deleteMutation = useDeleteDashboard();
  const duplicateMutation = useDuplicateDashboard();
  const [duplicatingId, setDuplicatingId] = useState<number | undefined>(undefined);
  const [exportingId, setExportingId] = useState<number | undefined>(undefined);
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
  const reportsUpdatedThisWeek = allRows.filter((row) => {
    const updatedAt = new Date(row.updatedAt).getTime();
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
      const created = await createMutation.mutateAsync({
        name: newDashboardName,
        description: newDashboardDescription || undefined,
      });
      setNewDashboardName('');
      setNewDashboardDescription('');
      setIsCreating(false);
      // A new report opens in the builder, on its guided start.
      if ((created as { id?: number } | undefined)?.id) router.push(`/dashboards/${(created as { id: number }).id}`);
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

  const handleDuplicate = async (dashboard: Dashboard) => {
    setDuplicatingId(dashboard.id);
    try {
      const copy = await duplicateMutation.mutateAsync(dashboard.id);
      toast.success(`Duplicated "${dashboard.name}"`);
      router.push(`/dashboards/${copy.id}`);
    } catch (error: any) {
      toast.error(`Could not duplicate: ${error.response?.data?.detail || error.message}`);
    } finally {
      setDuplicatingId(undefined);
    }
  };

  const handleExport = async (dashboard: Dashboard) => {
    setExportingId(dashboard.id);
    try {
      const blob = await dashboardApi.exportHtml(dashboard.id);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const slug = (dashboard.name || 'dashboard').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dashboard';
      anchor.href = url;
      anchor.download = `${slug}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      toast.error(`Could not export: ${error.response?.data?.detail || error.message}`);
    } finally {
      setExportingId(undefined);
    }
  };

  const openVibePublic = async (item: ReportRow) => {
    try {
      setVibePublic(await reportCodeApi.get(item.id));
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || error?.message);
    }
  };

  const [shareVibe, setShareVibe] = useState<ReportRow | null>(null);
  const [vibeBusy, setVibeBusy] = useState<string | undefined>(undefined);
  const duplicateVibe = async (row: ReportRow) => {
    setVibeBusy(row.key);
    try {
      const copy = await reportCodeApi.duplicate(row.id);
      toast.success(`Duplicated "${row.name}"`);
      await queryClient.invalidateQueries({ queryKey: ['report-artifacts'] });
      router.push(`/dashboards/code/${copy.id}`);
    } catch (error: any) {
      toast.error(`Could not duplicate: ${error?.response?.data?.detail || error?.message}`);
    } finally {
      setVibeBusy(undefined);
    }
  };
  const exportVibe = async (row: ReportRow) => {
    setVibeBusy(row.key);
    try {
      const blob = await reportCodeApi.exportHtml(row.id);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(row.name || 'report').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report'}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      toast.error(`Could not export: ${error?.response?.data?.detail || error?.message}`);
    } finally {
      setVibeBusy(undefined);
    }
  };

  const confirmVibeDelete = async () => {
    if (!vibeToDelete) return;
    try {
      await reportCodeApi.remove(vibeToDelete.id);
      toast.success(t('reportList.deleted', { name: vibeToDelete.name }));
      setVibeToDelete(null);
      await queryClient.invalidateQueries({ queryKey: ['report-artifacts'] });
    } catch (error: any) {
      throw new Error(error?.response?.data?.detail || error?.message || 'error');
    }
  };

  // What the list may do with a report; the builder decides only where it differs.
  const actions: ReportActions = {
    busyKey: vibeBusy ?? (exportingId !== undefined ? `manual-${exportingId}` : duplicatingId !== undefined ? `manual-${duplicatingId}` : undefined),
    onDelete: (row) => (row.kind === 'vibe' ? setVibeToDelete(row) : handleDelete(row.id)),
    onPublicLinks: (row) => (row.kind === 'vibe' ? openVibePublic(row) : setPublicShareDash(row.dashboard)),
    onShare: (row) => (row.kind === 'manual' ? setShareDash(row.dashboard) : setShareVibe(row)),
    onDuplicate: canEdit ? (row) => (row.kind === 'manual' ? void handleDuplicate(row.dashboard) : void duplicateVibe(row)) : undefined,
    onExport: (row) => (row.kind === 'manual' ? void handleExport(row.dashboard) : void exportVibe(row)),
  };

  const toggleSelect = (key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = (keys: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = keys.every((k) => prev.has(k));
      if (allSelected) return new Set();
      return new Set(keys);
    });
  };

  // What is selected NOW: rows that still exist and that this caller may delete (a row deleted
  // elsewhere, or whose access changed, silently leaves the selection).
  const selectedRows = useMemo(
    () => allRows.filter((r) => selectedIds.has(r.key) && r.perms.canDelete),
    [allRows, selectedIds],
  );

  // One bulk delete for every report, each through its OWN builder's delete (the backend
  // decides what else may go: a chart or dataset another report uses is kept).
  const handleBulkDelete = async () => {
    if (selectedRows.length === 0) return;
    setIsBulkDeleting(true);
    const failed: { key: string; name: string; reason: string }[] = [];
    let done = 0;
    for (const row of selectedRows) {
      try {
        if (row.kind === 'manual') await deleteMutation.mutateAsync(row.id);
        else await reportCodeApi.remove(row.id);
        done++;
      } catch (error: any) {
        const detail = error?.response?.data?.detail;
        failed.push({ key: row.key, name: row.name, reason: typeof detail === 'string' ? detail : (detail?.message || error?.message || '') });
      }
    }
    setIsBulkDeleting(false);
    await queryClient.invalidateQueries({ queryKey: ['report-artifacts'] });
    // Nothing deleted: an error the confirm dialog shows (it stays open), not a toast after it closed.
    if (done === 0 && failed.length > 0) throw new Error(t('reportList.bulk.none', { reason: failed[0].reason || failed[0].name }));
    // Keep what failed selected, so it can be looked at or retried; drop what is gone.
    setSelectedIds(new Set(failed.map((f) => f.key)));
    if (done > 0) toast.success(t('reportList.bulk.done', { count: done }));
    if (failed.length > 0) toast.error(t('reportList.bulk.failed', { count: failed.length, names: failed.map((f) => f.name).join(', ') }));
  };

  return (
    <>
      <PageListLayout
        title={t('reportList.title')}
        description={t('reportList.count', { n: allRows.length })}
        overview={(
          <ModuleOverview
              icon={LayoutDashboard}
              title={t('reportList.overview.title')}
              description={t('reportList.overview.description')}
              badges={[t('overview.dashboards.badge1'), t('overview.dashboards.badge2'), t('overview.dashboards.badge3')]}
              stats={[
                { label: t('reportList.saved'), value: allRows.length, helper: t('reportList.savedHelper', { manual: dashboardItems.length, vibe: vibeCount }) },
                { label: t('reportList.published'), value: allRows.filter((r) => r.status.label !== 'draft').length, helper: t('reportList.publishedHelper') },
                { label: t('overview.dashboards.charts'), value: totalChartLinks, helper: t('overview.dashboards.chartsHelper') },
                { label: t('overview.dashboards.updated'), value: reportsUpdatedThisWeek, helper: t('overview.dashboards.updatedHelper') },
              ]}
          />
        )}
        action={canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="build-manual-open"
              leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />}
              onClick={() => setIsManualChooserOpen(true)}
            >
              {t('reportCode.create.manual')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="report-code-open"
              leadingIcon={<Wand2 className="h-3.5 w-3.5" />}
              onClick={() => router.push('/dashboards/code/new')}
            >
              {t('reportCode.entry')}
            </Button>
          </div>
        ) : undefined}
        isLoading={isLoading || vibeLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="list"
        toolbarExtra={(
          <div className="flex items-center gap-2">
          <div className="inline-flex h-8 shrink-0 items-center rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-0.5" role="tablist" aria-label={t('reportList.type')} data-testid="report-type-filter">
            {([
              ['all', t('reportList.type.all'), allRows.length],
              ['manual', t('reportList.kind.manual'), dashboardItems.length],
              ['vibe', t('reportList.kind.vibe'), vibeCount],
            ] as const).map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={typeFilter === key} onClick={() => setTypeFilter(key)}
                data-testid={`report-type-${key}`}
                className={`inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-caption font-emphasis transition-colors ${typeFilter === key ? 'bg-surface-3 text-text-primary' : 'text-text-tertiary hover:text-text-primary'}`}>
                {key === 'vibe' ? <Wand2 className="h-3.5 w-3.5" /> : key === 'manual' ? <LayoutDashboard className="h-3.5 w-3.5" /> : null}
                {label}<span className="text-tiny text-text-quaternary">{count}</span>
              </button>
            ))}
          </div>
          {/* compact on this toolbar: three 200px selects pushed past the view toggle */}
          <div className="min-w-0 [&>div]:pb-0 [&>div>div]:min-w-[136px] [&>div>div]:flex-[0_0_148px]" data-testid="report-list-filters">
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
          </div>
          </div>
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
                {listFilters.access === 'manage'
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
          const filtered = allRows.filter((row) => {
            if (typeFilter !== 'all' && row.kind !== typeFilter) return false;
            const matchesSearch = needle.length === 0 || row.name.toLowerCase().includes(needle)
              || (row.description ?? '').toLowerCase().includes(needle) || (row.ownerEmail ?? '').toLowerCase().includes(needle);
            if (!matchesSearch) return false;
            if (listFilters.access && row.access !== listFilters.access) return false;
            if (listFilters.owner && row.ownerEmail !== listFilters.owner) return false;
            const chartState = row.content.count > 0 ? 'linked' : 'empty';
            // A Vibe Report relates to charts / datasets / sources through the saved charts it
            // binds, exactly as a dashboard relates through its tiles: one matcher for both.
            const relations = row.kind === 'vibe' ? vibeRelations(row) : relationIndex.dashboardRelationsById.get(row.id);
            return (!listFilters.state || chartState === listFilters.state)
              && matchesRelatedFilters(relations, {
                dataset: listFilters.dataset, chart: listFilters.chart, source: listFilters.source,
              });
          });

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters, typeFilter })}
            >
              {({ pageItems, pagination, hasFooter }) => (
                <div className={viewMode === 'grid' ? 'space-y-3' : undefined}>
                  {allRows.length === 0 ? (
                    <ReportTable rows={[]} actions={actions} />
                  ) : filtered.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">
                        {filterText ? <>{t('reportList.noMatch')} &ldquo;<strong className="text-text-primary">{filterText}</strong>&rdquo;</> : t('reportList.emptyFiltered')}
                      </p>
                    </div>
                  ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {pageItems.map((row) => (
                        <ReportCard key={row.key} row={row} actions={actions}
                          selected={selectedIds.has(row.key)} onToggleSelect={canEdit ? toggleSelect : undefined} />
                      ))}
                    </div>
                  ) : (
                    <ReportTable
                      rows={pageItems}
                      actions={actions}
                      activeFilters={listFilters}
                      onFilterClick={(key, value) => toggleListFilter(key as keyof DashboardListFilters, value)}
                      selectedIds={canEdit ? selectedIds : undefined}
                      onToggleSelect={canEdit ? toggleSelect : undefined}
                      onToggleSelectAll={canEdit ? toggleSelectAll : undefined}
                      hasFooter={hasFooter}
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
          selectedCount={selectedRows.length}
          onDelete={() => setShowBulkConfirm(true)}
          onClear={() => setSelectedIds(new Set())}
          isDeleting={isBulkDeleting}
        />
      )}

      <ConfirmDialog
        isOpen={showBulkConfirm}
        onClose={() => setShowBulkConfirm(false)}
        onConfirm={handleBulkDelete}
        title={t('reportList.bulk.title', { count: selectedRows.length })}
        description={t('reportList.bulk.desc')}
        details={<ConfirmTargets names={selectedRows.map((r) => `${r.name} · ${t(r.kind === 'vibe' ? 'reportList.kind.vibe' : 'reportList.kind.manual')}`)} />}
        confirmLabel="Delete"
        variant="danger"
      />

      <Modal
        isOpen={isCreating}
        onClose={() => {
          setIsCreating(false);
          setNewDashboardName('');
          setNewDashboardDescription('');
        }}
        title={t('dashboards.create.title')}
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
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              disabled={createMutation.isPending || !newDashboardName}
              loading={createMutation.isPending}
              data-testid="dashboard-create-submit"
            >
              {t('dashboards.create.submit')}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} className="space-y-3">
          <FieldGroup label={t('dashboards.create.name')} required>
            <Input
              data-testid="dashboard-create-name"
              value={newDashboardName}
              onChange={(event) => setNewDashboardName(event.target.value)}
              required
              autoFocus
            />
          </FieldGroup>
          <FieldGroup label={t('dashboards.create.description')} description={t('dashboards.create.descriptionHint')}>
            <Textarea
              data-testid="dashboard-create-description"
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

      {vibePublic && (
        <PublicLinksManager
          dashboardId={vibePublic.id}
          dashboardName={vibePublic.name}
          target={reportLinkTarget(vibePublic)}
          onClose={() => { setVibePublic(null); void queryClient.invalidateQueries({ queryKey: ['report-artifacts'] }); }}
        />
      )}

      <ConfirmDialog
        isOpen={!!vibeToDelete}
        onClose={() => setVibeToDelete(null)}
        onConfirm={confirmVibeDelete}
        title={t('reportList.deleteTitle')}
        description={t('common.cannotUndo')}
        details={vibeToDelete ? <ConfirmTargets names={[vibeToDelete.name]} /> : null}
        confirmLabel="Delete"
        variant="danger"
      />

      {shareVibe && (
        <ShareDialog
          resourceType="report_artifact"
          resourceId={shareVibe.id}
          resourceName={shareVibe.name}
          onClose={() => setShareVibe(null)}
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

      {isStarterOpen && (
        <ReportStarterModal
          datasets={datasets.map((d: any) => ({ id: d.id, name: d.name }))}
          onClose={() => setIsStarterOpen(false)}
          onCreated={(id) => router.push(`/dashboards/${id}`)}
        />
      )}

      {isHtmlImportOpen && (
        <DashboardHtmlImportModal
          isOpen={isHtmlImportOpen}
          onClose={() => setIsHtmlImportOpen(false)}
          targetMode="new_dashboard"
        />
      )}

      {isManualChooserOpen && (
        <Modal isOpen onClose={() => setIsManualChooserOpen(false)} title={t('reportCode.create.manualTitle')} size="lg">
          <div className="grid gap-3 sm:grid-cols-3" data-testid="build-manual-chooser">
            {([
              { key: 'blank', testId: 'build-manual-blank', icon: Plus, title: t('action.newDashboard'), desc: t('reportCode.create.blankDesc'), run: () => setIsCreating(true) },
              { key: 'starter', testId: 'report-starter-open', icon: LayoutDashboard, title: t('report.starter.open'), desc: t('reportCode.create.starterDesc'), run: () => setIsStarterOpen(true) },
              { key: 'html', testId: 'build-manual-html', icon: Globe, title: t('reportCode.create.htmlNative'), desc: t('reportCode.create.htmlNativeDesc'), run: () => setIsHtmlImportOpen(true) },
            ] as const).map(({ key, testId, icon: Icon, title, desc, run }) => (
              <div key={key} className="relative flex flex-col items-start gap-2 rounded-xl border border-stroke-strong bg-surface-1 p-4 transition hover:border-brand/50 hover:bg-brand-container/30">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-container text-brand"><Icon className="h-4 w-4" /></span>
                <button type="button" data-testid={testId} onClick={() => { setIsManualChooserOpen(false); run(); }}
                  className="text-left text-sm font-semibold text-text-primary after:absolute after:inset-0 hover:text-brand">{title}</button>
                <span className="text-xs leading-snug text-text-tertiary">{desc}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
