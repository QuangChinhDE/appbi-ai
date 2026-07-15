/**
 * Workboards list page — laid out the same way as the dashboards / datasets
 * pages so the catalog feels consistent. Adds a ModuleOverview header,
 * grid+list view toggle (defaults to list), pagination, bulk delete, and
 * search/filter chips.
 */
'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ClipboardList,
  Clock,
  Database,
  Eye,
  Plus,
  Search,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';

import { toast } from '@/lib/toast';
import { hasPermission, usePermissions } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import {
  useCreateWorkboard,
  useDeleteWorkboard,
  useWorkboards,
} from '@/hooks/use-workboards';
import { useDatasets } from '@/hooks/use-datasets';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { PageListLayout } from '@/components/common/PageListLayout';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { ShareDialog } from '@/components/common/ShareDialog';
import { Button, IconButton } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { FieldGroup, Input, Textarea } from '@/components/ui/Input';
import { WorkboardList } from '@/components/workboards/WorkboardList';
import { WorkboardPublishToggle } from '@/components/workboards/WorkboardPublishToggle';
import WorkboardImportModal from '@/components/workboards/WorkboardImportModal';
import { DefaultOwnerCredentialsDialog } from '@/components/workboards/DefaultOwnerCredentialsDialog';
import type { Workboard } from '@/lib/api/workboards';
import { storeWorkboardDefaultOwnerNotice } from '@/lib/workboard-default-owner-notice';
import { useI18n } from '@/providers/LanguageProvider';

type WorkboardListFilters = {
  state?: string;        // 'published' | 'draft'
  access?: string;       // 'full' | 'edit' | 'view' | 'none'
  owner?: string;
  dataset?: string;      // dataset_id as string
};

type ApiErrorDetail = {
  response?: {
    data?: {
      detail?: unknown;
    };
  };
};

function getApiErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as ApiErrorDetail)?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

export default function WorkboardsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'workboards', 'edit');

  const { data: workboards, isLoading } = useWorkboards();
  const { data: datasets = [] } = useDatasets();
  const createMutation = useCreateWorkboard();
  const deleteMutation = useDeleteWorkboard();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<Workboard | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Workboard | null>(null);
  const [listFilters, setListFilters] = useState<WorkboardListFilters>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  // After creating a workboard with default owner credentials we hold them
  // here and surface a blocking modal — the toast was too easy to miss and
  // the PIN cannot be recovered later.
  const [pendingCredentials, setPendingCredentials] = useState<{
    workboardId: number;
    workboardName: string;
    username: string;
    pin: string;
  } | null>(null);

  // Create-form state — only name + description + dataset are required.
  // Primary table is auto-picked by the backend (first physical table in
  // the dataset); each screen in the builder picks its own table per screen.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [datasetId, setDatasetId] = useState<number | null>(null);

  const items = useMemo(() => workboards ?? [], [workboards]);

  // ── Stats for the overview header ──────────────────────────────────
  const totalScreens = items.reduce((sum, wb) => {
    const layout = wb.layout_json as { screens?: unknown[] } | null;
    const screens = Array.isArray(layout?.screens) ? layout.screens : [];
    return sum + screens.length;
  }, 0);
  const publishedCount = items.filter((wb) => wb.is_published).length;

  const datasetById = useMemo(() => {
    const map = new Map<number, string>();
    for (const d of datasets) map.set(d.id, d.name);
    return map;
  }, [datasets]);

  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;

  const setListFilter = (key: keyof WorkboardListFilters, value?: string) => {
    setListFilters((current) => ({ ...current, [key]: value || undefined }));
  };
  const toggleListFilter = (key: keyof WorkboardListFilters, value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };
  const clearListFilters = () => setListFilters({});

  const resetForm = () => {
    setName('');
    setDescription('');
    setDatasetId(null);
  };

  const handleCreate = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (!name.trim()) {
      toast.error(t('workboards.toast.nameRequired'));
      return;
    }
    if (!datasetId) {
      toast.error(t('workboards.toast.datasetRequired'));
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        dataset_id: datasetId,
        // Backend auto-picks the first physical table of this dataset and
        // generates a mini-app skeleton (empty screens[] — admin adds them
        // in the Builder).
        layout_json: {
          screens: [],
          mini_app_nav: { mobile_kind: 'bottom_nav', desktop_kind: 'sidebar', items: [] },
          branding: { primary_color: '#2563eb' },
          audit: {},
        },
      });
      setIsCreateOpen(false);
      resetForm();
      if (created.default_owner_credentials) {
        // Stash in sessionStorage as a fallback (e.g. if user navigates away
        // before confirming), and show the blocking dialog.
        storeWorkboardDefaultOwnerNotice({
          workboardId: created.id,
          ...created.default_owner_credentials,
        });
        setPendingCredentials({
          workboardId: created.id,
          workboardName: created.name,
          username: created.default_owner_credentials.username,
          pin: created.default_owner_credentials.pin,
        });
      } else {
        toast.success(t('workboards.toast.created', { name: created.name }));
        router.push(`/workboards/${created.id}`);
      }
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.toast.createFailed')));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteMutation.mutateAsync(pendingDelete.id);
      toast.success(t('workboards.toast.deleted', { name: pendingDelete.name }));
      setPendingDelete(null);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('workboards.toast.deleteFailed')));
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
      return allSelected ? new Set() : new Set(ids);
    });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setShowBulkConfirm(false);
    setIsBulkDeleting(true);
    let ok = 0;
    let fail = 0;
    for (const id of selectedIds) {
      try {
        await deleteMutation.mutateAsync(id);
        ok++;
      } catch {
        fail++;
      }
    }
    setSelectedIds(new Set());
    setIsBulkDeleting(false);
    if (ok > 0) toast.success(t('workboards.toast.bulkDeleted', { count: ok }));
    if (fail > 0) toast.error(t('workboards.toast.bulkDeleteFailed', { count: fail }));
  };

  const action = canEdit ? (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<Upload className="h-3.5 w-3.5" />}
        onClick={() => setIsImportOpen(true)}
        title={t('workboards.action.importTitle')}
      >
        {t('workboards.action.import')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        leadingIcon={<Plus className="h-3.5 w-3.5" />}
        onClick={() => setIsCreateOpen(true)}
      >
        {t('workboards.action.new')}
      </Button>
    </div>
  ) : undefined;

  // ── Filter dropdowns rendered into toolbarExtra ─────────────────────
  // Mirrors the dropdown style used by the dashboards module.
  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const wb of items) if (wb.owner_email) set.add(wb.owner_email);
    return Array.from(set).sort();
  }, [items]);

  const filterDropdowns = (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown
        label={t('workboards.filter.status')}
        value={listFilters.state}
        options={[
          { label: t('workboards.filter.all'), value: '' },
          { label: t('workboards.filter.published'), value: 'published' },
          { label: t('workboards.filter.draft'), value: 'draft' },
        ]}
        onChange={(v) => setListFilter('state', v)}
      />
      <FilterDropdown
        label={t('workboards.filter.access')}
        value={listFilters.access}
        options={[
          { label: t('workboards.filter.all'), value: '' },
          { label: t('workboards.filter.fullAccess'), value: 'full' },
          { label: t('workboards.filter.editable'), value: 'edit' },
          { label: t('workboards.filter.viewOnly'), value: 'view' },
        ]}
        onChange={(v) => setListFilter('access', v)}
      />
      <FilterDropdown
        label={t('workboards.filter.dataset')}
        value={listFilters.dataset}
        options={[
          { label: t('workboards.filter.all'), value: '' },
          ...datasets.map((d) => ({ label: d.name, value: String(d.id) })),
        ]}
        onChange={(v) => setListFilter('dataset', v)}
      />
      {owners.length > 0 && (
        <FilterDropdown
          label={t('workboards.filter.owner')}
          value={listFilters.owner}
          options={[
            { label: t('workboards.filter.all'), value: '' },
            ...owners.map((o) => ({ label: o.split('@')[0], value: o })),
          ]}
          onChange={(v) => setListFilter('owner', v)}
        />
      )}
    </div>
  );

  return (
    <>
      <PageListLayout
        title={t('workboards.page.title')}
        description={t(items.length === 1 ? 'workboards.page.countOne' : 'workboards.page.countMany', { count: items.length })}
        overview={(
          <ModuleOverview
            icon={ClipboardList}
            title={t('workboards.overview.title')}
            description={t('workboards.overview.description')}
            badges={[
              t('workboards.overview.badgeBuilder'),
              t('workboards.overview.badgeViews'),
              t('workboards.overview.badgeRls'),
            ]}
            stats={[
              {
                label: t('workboards.overview.statWorkboards'),
                value: items.length,
                helper: t('workboards.overview.statWorkboardsHelper'),
              },
              {
                label: t('workboards.overview.statScreens'),
                value: totalScreens,
                helper: t('workboards.overview.statScreensHelper'),
              },
              {
                label: t('workboards.overview.statPublished'),
                value: publishedCount,
                helper: t('workboards.overview.statPublishedHelper'),
              },
            ]}
          />
        )}
        action={action}
        isLoading={isLoading}
        loadingText={t('workboards.loading')}
        searchPlaceholder={t('workboards.searchPlaceholder')}
        defaultView="list"
        toolbarExtra={filterDropdowns}
        activeFilters={
          activeListFilterCount > 0 ? (
            <>
              {listFilters.state && (
                <FilterTag
                  tone={listFilters.state === 'published' ? 'success' : 'warning'}
                  active
                  onClick={() => toggleListFilter('state', listFilters.state!)}
                >
                  {listFilters.state === 'published' ? t('workboards.filter.published') : t('workboards.filter.draft')}
                </FilterTag>
              )}
              {listFilters.access && (
                <FilterTag
                  tone="info"
                  active
                  onClick={() => toggleListFilter('access', listFilters.access!)}
                >
                  {listFilters.access === 'full'
                    ? t('workboards.filter.fullAccess')
                    : listFilters.access === 'edit'
                      ? t('workboards.filter.editable')
                      : listFilters.access === 'view'
                        ? t('workboards.filter.viewOnly')
                        : t('workboards.filter.restricted')}
                </FilterTag>
              )}
              {listFilters.owner && (
                <FilterTag
                  active
                  onClick={() => toggleListFilter('owner', listFilters.owner!)}
                >
                  {t('workboards.filter.ownerChip', { owner: listFilters.owner.split('@')[0] })}
                </FilterTag>
              )}
              {listFilters.dataset && (
                <FilterTag
                  tone="brand"
                  active
                  onClick={() => setListFilter('dataset')}
                >
                  {t('workboards.filter.datasetChip', { dataset: datasetById.get(Number(listFilters.dataset)) || `#${listFilters.dataset}` })}
                </FilterTag>
              )}
              <Button variant="ghost" size="xs" onClick={clearListFilters}>
                {t('workboards.filter.clear')}
              </Button>
            </>
          ) : null
        }
      >
        {({ viewMode, filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const filtered = items.filter((wb) => {
            const stateValue = wb.is_published ? 'published' : 'draft';
            const accessValue = wb.user_permission ?? 'none';
            const matchesSearch =
              needle.length === 0 ||
              wb.name.toLowerCase().includes(needle) ||
              (wb.description ?? '').toLowerCase().includes(needle) ||
              (wb.owner_email ?? '').toLowerCase().includes(needle);
            return (
              matchesSearch &&
              (!listFilters.state || stateValue === listFilters.state) &&
              (!listFilters.access || accessValue === listFilters.access) &&
              (!listFilters.owner || wb.owner_email === listFilters.owner) &&
              (!listFilters.dataset || String(wb.dataset_id) === listFilters.dataset)
            );
          });

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters })}
            >
              {({ pageItems, pagination, hasFooter }) => (
                <div className={viewMode === 'grid' ? 'space-y-3' : undefined}>
                  {items.length === 0 ? (
                    <WorkboardList workboards={[]} />
                  ) : filtered.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">
                        {t('workboards.empty.noMatches', { query: filterText })}
                      </p>
                    </div>
                  ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {pageItems.map((wb) => (
                        <WorkboardGridCard
                          key={wb.id}
                          workboard={wb}
                          datasetName={datasetById.get(wb.dataset_id)}
                          onOpen={() => router.push(`/workboards/${wb.id}`)}
                          onShare={() => setShareTarget(wb)}
                          onDelete={() => setPendingDelete(wb)}
                          selected={selectedIds.has(wb.id)}
                          onToggleSelect={canEdit ? () => toggleSelect(wb.id) : undefined}
                        />
                      ))}
                    </div>
                  ) : (
                    <WorkboardList
                      workboards={pageItems}
                      onDelete={canEdit ? (wb) => setPendingDelete(wb) : undefined}
                      onShare={(wb) => setShareTarget(wb)}
                      deletingId={
                        deleteMutation.isPending ? pendingDelete?.id : undefined
                      }
                      activeFilters={listFilters}
                      onFilterClick={(key, value) =>
                        toggleListFilter(key as keyof WorkboardListFilters, value)
                      }
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
        title={t('workboards.confirm.bulkDeleteTitle', { count: selectedIds.size })}
        description={t('workboards.confirm.cannotUndo')}
        confirmLabel={t('common.delete')}
        variant="danger"
      />

      {/* Create modal */}
      {isCreateOpen && (
        <Modal
          isOpen={isCreateOpen}
          onClose={() => {
            setIsCreateOpen(false);
            resetForm();
          }}
          title={t('workboards.create.title')}
          size="md"
          footer={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsCreateOpen(false);
                  resetForm();
                }}
                disabled={createMutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleCreate()}
                disabled={
                  createMutation.isPending ||
                  !name.trim() ||
                  datasets.length === 0 ||
                  !datasetId
                }
                loading={createMutation.isPending}
                title={
                  datasets.length === 0
                    ? t('workboards.create.datasetNeededTitle')
                    : !datasetId
                      ? t('workboards.toast.datasetRequired')
                      : undefined
                }
              >
                {t('workboards.create.create')}
              </Button>
            </>
          }
        >
          <form onSubmit={handleCreate} className="space-y-3">
            <FieldGroup label={t('workboards.create.nameLabel')} required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('workboards.create.namePlaceholder')}
                autoFocus
              />
            </FieldGroup>
            <FieldGroup label={t('workboards.create.descriptionLabel')}>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder={t('workboards.create.descriptionPlaceholder')}
              />
            </FieldGroup>
            <FieldGroup
              label={t('workboards.filter.dataset')}
              required
              description={t('workboards.create.datasetDescription')}
            >
              {datasets.length === 0 ? (
                <div className="rounded-md border border-dashed border-warning/40 bg-warning/5 p-3">
                  <div className="flex items-start gap-2">
                    <Database className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <div className="flex-1 text-tiny text-text-secondary">
                      <p className="font-emphasis text-text-primary">
                        {t('workboards.create.noDatasetTitle')}
                      </p>
                      <p className="mt-0.5">
                        {t('workboards.create.noDatasetBody')}
                      </p>
                      <Button
                        variant="primary"
                        size="xs"
                        className="mt-2"
                        leadingIcon={<Database className="h-3 w-3" />}
                        onClick={() => {
                          setIsCreateOpen(false);
                          resetForm();
                          router.push('/datasets');
                        }}
                      >
                        {t('workboards.create.goDatasets')}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <select
                  className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                  value={datasetId ?? ''}
                  onChange={(e) =>
                    setDatasetId(e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">{t('workboards.create.datasetPlaceholder')}</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
            </FieldGroup>
          </form>
        </Modal>
      )}

      {pendingCredentials && (
        <DefaultOwnerCredentialsDialog
          isOpen
          workboardName={pendingCredentials.workboardName}
          username={pendingCredentials.username}
          pin={pendingCredentials.pin}
          onConfirm={() => {
            const target = pendingCredentials.workboardId;
            setPendingCredentials(null);
            router.push(`/workboards/${target}`);
          }}
        />
      )}

      {shareTarget && (
        <ShareDialog
          resourceType="workboard"
          resourceId={shareTarget.id}
          resourceName={shareTarget.name}
          onClose={() => setShareTarget(null)}
        />
      )}

      {pendingDelete && (
        <Modal
          isOpen={!!pendingDelete}
          onClose={() => setPendingDelete(null)}
          title={t('workboards.delete.title', { name: pendingDelete.name })}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={confirmDelete}
                disabled={deleteMutation.isPending}
                loading={deleteMutation.isPending}
              >
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            {t('workboards.delete.description')}
          </p>
        </Modal>
      )}

      {isImportOpen && (
        <WorkboardImportModal onClose={() => setIsImportOpen(false)} />
      )}
    </>
  );
}


// ── Inline filter dropdown — mirrors the dashboards-module styling ────

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: Array<{ label: string; value: string }>;
  onChange: (v: string) => void;
}) {
  const isActive = Boolean(value);
  return (
    <label className="flex items-center gap-1.5 text-tiny">
      <span className="text-text-tertiary">{label}:</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-md border px-2 py-1 text-tiny transition-colors ${
          isActive
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))]'
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}


// ── Grid view card (used when viewMode === 'grid') ─────────────────────

function WorkboardGridCard({
  workboard,
  datasetName,
  onOpen,
  onShare,
  onDelete,
  selected,
  onToggleSelect,
}: {
  workboard: Workboard;
  datasetName?: string;
  onOpen: () => void;
  onShare: () => void;
  onDelete: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { t, locale } = useI18n();
  const perms = getResourcePermissions(workboard.user_permission ?? undefined);
  const created = new Date(workboard.updated_at).toLocaleDateString(locale);
  return (
    <div className="group flex flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear">
      <div className="flex-1 p-4">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            {onToggleSelect && (
              <input
                type="checkbox"
                aria-label={t('workboards.grid.selectAria', { name: workboard.name })}
                checked={!!selected}
                onChange={onToggleSelect}
                className="h-3.5 w-3.5 cursor-pointer rounded accent-[rgb(var(--brand))]"
              />
            )}
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <ClipboardList className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <WorkboardPublishToggle
              workboard={workboard}
              variant="icon"
              canEdit={perms.canEdit}
            />
            {perms.canDelete && (
              <IconButton
                aria-label={t('common.delete')}
                variant="ghost"
                size="xs"
                onClick={onDelete}
                className="text-text-tertiary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="text-left"
        >
          <h3 className="mb-1 truncate text-caption font-strong text-text-primary transition-colors hover:text-brand">
            {workboard.name}
          </h3>
        </button>
        <OwnerBadge email={workboard.owner_email ?? null} />
        {workboard.description && (
          <p className="mt-1.5 line-clamp-2 text-caption text-text-tertiary">
            {workboard.description}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between text-tiny text-text-quaternary">
          <span className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            {datasetName || t('workboards.list.datasetFallback', { id: workboard.dataset_id })}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {created}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between rounded-b-xl border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-2.5">
        <div className="flex items-center gap-3">
          {perms.canShare && (
            <button
              onClick={onShare}
              className="flex items-center gap-1 text-tiny text-text-tertiary transition-colors hover:text-brand"
              title={t('common.share')}
            >
              <Share2 className="h-3 w-3" />
              {t('common.share')}
            </button>
          )}
        </div>
        <button
          onClick={onOpen}
          className="ml-auto flex items-center gap-1 text-tiny font-emphasis text-brand transition-colors hover:text-brand-hover"
        >
          <Eye className="h-3 w-3" />
          {t('common.open')}
        </button>
      </div>
    </div>
  );
}
