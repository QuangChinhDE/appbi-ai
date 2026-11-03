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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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
    busyKey: exportingId !== undefined ? `manual-${exportingId}` : duplicatingId !== undefined ? `manual-${duplicatingId}` : undefined,
    onDelete: (row) => (row.kind === 'vibe' ? setVibeToDelete(row) : handleDelete(row.id)),
    onPublicLinks: (row) => (row.kind === 'vibe' ? openVibePublic(row) : setPublicShareDash(row.dashboard)),
    onShare: (row) => { if (row.kind === 'manual') setShareDash(row.dashboard); },
    onDuplicate: canEdit ? (row) => { if (row.kind === 'manual') void handleDuplicate(row.dashboard); } : undefined,
    onExport: (row) => { if (row.kind === 'manual') void handleExport(row.dashboard); },
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
    setIsBulkDeleting(false);
    // Nothing deleted: an error the confirm dialog shows (it stays open), not a toast after it closed.
    if (successCount === 0 && failCount > 0) throw new Error(`Failed to delete ${failCount} dashboard(s)`);
    setSelectedIds(new Set());
    if (successCount > 0) toast.success(`Deleted ${successCount} dashboard(s)`);
    if (failCount > 0) toast.error(`Failed to delete ${failCount} dashboard(s)`);
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
          <>
          <div className="flex items-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5" role="tablist" aria-label={t('reportList.type')} data-testid="report-type-filter">
            {([
              ['all', t('reportList.type.all'), allRows.length],
              ['manual', t('reportList.kind.manual'), dashboardItems.length],
              ['vibe', t('reportList.kind.vibe'), vibeCount],
            ] as const).map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={typeFilter === key} onClick={() => setTypeFilter(key)}
                data-testid={`report-type-${key}`}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-caption font-emphasis transition-colors ${typeFilter === key ? 'bg-surface-1 text-brand shadow-sm' : 'text-text-tertiary hover:text-text-primary'}`}>
                {key === 'vibe' ? <Wand2 className="h-3.5 w-3.5" /> : key === 'manual' ? <LayoutDashboard className="h-3.5 w-3.5" /> : null}
                {label}<span className="text-tiny text-text-quaternary">{count}</span>
              </button>
            ))}
          </div>
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
          </>
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
            if (row.kind === 'vibe') {
              // chart / source relations and the chart-state tag are dashboard-tile facts
              return !listFilters.state && !listFilters.chart && !listFilters.source
                && (!listFilters.dataset || row.datasetIds.includes(Number(listFilters.dataset)));
            }
            const chartState = row.content.count > 0 ? 'linked' : 'empty';
            return (!listFilters.state || chartState === listFilters.state)
              && matchesRelatedFilters(relationIndex.dashboardRelationsById.get(row.id), {
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
                          selected={selectedIds.has(row.id)} onToggleSelect={canEdit ? toggleSelect : undefined} />
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
          selectedCount={selectedIds.size}
          onDelete={() => setShowBulkConfirm(true)}
          onClear={() => setSelectedIds(new Set())}
          isDeleting={isBulkDeleting}
        />
      )}

      <ConfirmDialog
        isOpen={showBulkConfirm}
        onClose={() => setShowBulkConfirm(false)}
        onConfirm={handleBulkDelete}
        title={t('common.bulkDelete.dashboards', { count: selectedIds.size })}
        description={t('common.cannotUndo')}
        details={<ConfirmTargets names={(dashboards ?? []).filter((d) => selectedIds.has(d.id)).map((d) => d.name)} />}
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
