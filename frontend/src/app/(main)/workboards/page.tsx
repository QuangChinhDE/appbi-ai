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
  CheckCircle2,
  ClipboardList,
  Clock,
  Database,
  Eye,
  Loader2,
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
import WorkboardImportModal from '@/components/workboards/WorkboardImportModal';
import type { Workboard } from '@/lib/api/workboards';

type WorkboardListFilters = {
  state?: string;        // 'published' | 'draft'
  access?: string;       // 'full' | 'edit' | 'view' | 'none'
  owner?: string;
  dataset?: string;      // dataset_id as string
};

export default function WorkboardsPage() {
  const router = useRouter();
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

  // Create-form state — only name + description + dataset are required.
  // Primary table is auto-picked by the backend (first physical table in
  // the dataset); each screen in the builder picks its own table per screen.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [datasetId, setDatasetId] = useState<number | null>(null);

  const items = useMemo(() => workboards ?? [], [workboards]);

  // ── Stats for the overview header ──────────────────────────────────
  const totalScreens = items.reduce((sum, wb) => {
    const screens = ((wb.layout_json as any)?.screens as unknown[]) || [];
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
      toast.error('Tên workboard là bắt buộc');
      return;
    }
    if (!datasetId) {
      toast.error('Hãy chọn dataset');
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        dataset_id: datasetId,
        // Backend auto-picks the first physical table of this dataset and
        // generates a v2 mini-app skeleton (empty screens[] — admin adds
        // them in the Builder).
        layout_json: {
          version: 2,
          screens: [],
          mini_app_nav: { mobile_kind: 'bottom_nav', desktop_kind: 'sidebar', items: [] },
          branding: { primary_color: '#2563eb' },
          form: { fields: [] },
          list: { columns: [] },
          doc_views: [],
          rls: { enabled: false },
          audit: {},
        } as any,
      });
      toast.success(`Đã tạo “${created.name}”`);
      setIsCreateOpen(false);
      resetForm();
      router.push(`/workboards/${created.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Tạo workboard thất bại');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteMutation.mutateAsync(pendingDelete.id);
      toast.success(`Deleted “${pendingDelete.name}”`);
      setPendingDelete(null);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Delete failed');
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
    if (
      !window.confirm(
        `Delete ${selectedIds.size} workboard(s)? This action cannot be undone.`,
      )
    ) {
      return;
    }
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
    if (ok > 0) toast.success(`Deleted ${ok} workboard(s)`);
    if (fail > 0) toast.error(`Failed to delete ${fail} workboard(s)`);
  };

  const action = canEdit ? (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<Upload className="h-3.5 w-3.5" />}
        onClick={() => setIsImportOpen(true)}
        title="Import workboard từ file template"
      >
        Import
      </Button>
      <Button
        variant="primary"
        size="sm"
        leadingIcon={<Plus className="h-3.5 w-3.5" />}
        onClick={() => setIsCreateOpen(true)}
      >
        New workboard
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
        label="Trạng thái"
        value={listFilters.state}
        options={[
          { label: 'Tất cả', value: '' },
          { label: 'Đã xuất bản', value: 'published' },
          { label: 'Bản nháp', value: 'draft' },
        ]}
        onChange={(v) => setListFilter('state', v)}
      />
      <FilterDropdown
        label="Quyền"
        value={listFilters.access}
        options={[
          { label: 'Tất cả', value: '' },
          { label: 'Full access', value: 'full' },
          { label: 'Editable', value: 'edit' },
          { label: 'View only', value: 'view' },
        ]}
        onChange={(v) => setListFilter('access', v)}
      />
      <FilterDropdown
        label="Dataset"
        value={listFilters.dataset}
        options={[
          { label: 'Tất cả', value: '' },
          ...datasets.map((d) => ({ label: d.name, value: String(d.id) })),
        ]}
        onChange={(v) => setListFilter('dataset', v)}
      />
      {owners.length > 0 && (
        <FilterDropdown
          label="Người tạo"
          value={listFilters.owner}
          options={[
            { label: 'Tất cả', value: '' },
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
        title="Workboards"
        description={`${items.length} workboard${items.length !== 1 ? 's' : ''}`}
        overview={(
          <ModuleOverview
            icon={ClipboardList}
            title="Workboards"
            description="Mini data-entry apps bound to dataset tables — form, list, and document views in one place. Workers and supervisors fill them through public links."
            badges={['Mini-app builder', 'Form + list + doc', 'Role-based RLS']}
            stats={[
              {
                label: 'Workboards',
                value: items.length,
                helper: 'Total saved',
              },
              {
                label: 'Screens',
                value: totalScreens,
                helper: 'Across all workboards',
              },
              {
                label: 'Published',
                value: publishedCount,
                helper: 'Available via public link',
              },
            ]}
          />
        )}
        action={action}
        isLoading={isLoading}
        loadingText="Loading workboards…"
        searchPlaceholder="Search workboards…"
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
                  {listFilters.state === 'published' ? 'Published' : 'Draft'}
                </FilterTag>
              )}
              {listFilters.access && (
                <FilterTag
                  tone="info"
                  active
                  onClick={() => toggleListFilter('access', listFilters.access!)}
                >
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
                <FilterTag
                  active
                  onClick={() => toggleListFilter('owner', listFilters.owner!)}
                >
                  Owner: {listFilters.owner.split('@')[0]}
                </FilterTag>
              )}
              {listFilters.dataset && (
                <FilterTag
                  tone="brand"
                  active
                  onClick={() => setListFilter('dataset')}
                >
                  Dataset: {datasetById.get(Number(listFilters.dataset)) || `#${listFilters.dataset}`}
                </FilterTag>
              )}
              <Button variant="ghost" size="xs" onClick={clearListFilters}>
                Clear filters
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
              {({ pageItems, pagination }) => (
                <div className="space-y-3">
                  {items.length === 0 ? (
                    <WorkboardList workboards={[]} />
                  ) : filtered.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">
                        No workboards matching &ldquo;
                        <strong className="text-text-primary">{filterText}</strong>&rdquo;
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

      {/* Create modal */}
      {isCreateOpen && (
        <Modal
          isOpen={isCreateOpen}
          onClose={() => {
            setIsCreateOpen(false);
            resetForm();
          }}
          title="New workboard"
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
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleCreate()}
                disabled={createMutation.isPending || !name.trim()}
                loading={createMutation.isPending}
              >
                Create
              </Button>
            </>
          }
        >
          <form onSubmit={handleCreate} className="space-y-3">
            <FieldGroup label="Tên workboard" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: Nhật ký sản xuất"
                autoFocus
              />
            </FieldGroup>
            <FieldGroup label="Mô tả">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Tuỳ chọn"
              />
            </FieldGroup>
            <FieldGroup
              label="Dataset"
              required
              description="Mỗi screen trong Builder sẽ tự chọn bảng từ dataset này."
            >
              <select
                className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-body"
                value={datasetId ?? ''}
                onChange={(e) =>
                  setDatasetId(e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">— Chọn dataset —</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </FieldGroup>
          </form>
        </Modal>
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
          title={`Delete “${pendingDelete.name}”?`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={confirmDelete}
                disabled={deleteMutation.isPending}
                loading={deleteMutation.isPending}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            The workboard configuration will be removed. The underlying data in your database is not touched.
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
}: {
  workboard: Workboard;
  datasetName?: string;
  onOpen: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const perms = getResourcePermissions(workboard.user_permission ?? undefined);
  const created = new Date(workboard.updated_at).toLocaleDateString();
  return (
    <div className="group flex flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear">
      <div className="flex-1 p-4">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <ClipboardList className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-1">
            {workboard.is_published && (
              <span title="Published">
                <CheckCircle2 className="h-4 w-4 text-success" />
              </span>
            )}
            {perms.canDelete && (
              <IconButton
                aria-label="Delete"
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
            {datasetName || `Dataset #${workboard.dataset_id}`}
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
              title="Share"
            >
              <Share2 className="h-3 w-3" />
              Share
            </button>
          )}
        </div>
        <button
          onClick={onOpen}
          className="ml-auto flex items-center gap-1 text-tiny font-emphasis text-brand transition-colors hover:text-brand-hover"
        >
          <Eye className="h-3 w-3" />
          Open
        </button>
      </div>
    </div>
  );
}
