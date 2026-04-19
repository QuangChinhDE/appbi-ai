/**
 * Dataset Datasets List Page
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Database,
  Calendar,
  ChevronRight,
  Trash2,
  Search,
  Share2,
  AlertTriangle,
} from 'lucide-react';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ShareDialog } from '@/components/common/ShareDialog';
import { Modal } from '@/components/common/Modal';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { PageListLayout } from '@/components/common/PageListLayout';
import { BulkActionBar } from '@/components/common/BulkActionBar';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { useI18n } from '@/providers/LanguageProvider';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Input, Textarea, Label, FieldGroup } from '@/components/ui/Input';
import {
  useDatasets,
  useCreateDataset,
  useDeleteDataset,
  type CreateDatasetInput,
} from '@/hooks/use-datasets';

export default function DatasetsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [listFilters, setListFilters] = useState<{ docs?: string; access?: string; owner?: string }>({});

  const { data: datasets, isLoading, error } = useDatasets();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'datasets', 'edit');
  const createMutation = useCreateDataset();
  const deleteMutation = useDeleteDataset();
  const datasetItems = datasets ?? [];
  const documentedDatasets = datasetItems.filter((dataset) => Boolean(dataset.description?.trim())).length;
  const updatedThisWeek = datasetItems.filter((dataset) => {
    const updatedAt = new Date(dataset.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const [datasetToDelete, setDatasetToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingDataset, setIsDeletingDataset] = useState(false);
  const [shareDataset, setShareDataset] = useState<{ id: number; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;

  const toggleListFilter = (key: 'docs' | 'access' | 'owner', value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

  const handleCreateDataset = async (input: CreateDatasetInput) => {
    try {
      const dataset = await createMutation.mutateAsync(input);
      setIsCreateModalOpen(false);
      toast.success('Dataset created', {
        description: input.name,
      });
      router.push(`/datasets/${dataset.id}`);
    } catch (error) {
      console.error('Failed to create dataset:', error);
      toast.error('Failed to create dataset. Please try again.');
    }
  };

  const handleDeleteDataset = (id: number, name: string) => {
    setDatasetToDelete({ id, name });
    setDeleteConstraints(null);
  };

  const confirmDeleteDataset = async () => {
    if (!datasetToDelete) return;
    setIsDeletingDataset(true);
    try {
      await deleteMutation.mutateAsync(datasetToDelete.id);
      toast.success('Dataset deleted', {
        description: datasetToDelete.name,
      });
      setDatasetToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        toast.error(`Failed to delete dataset: ${detail || error.message}`);
        setDatasetToDelete(null);
      }
    } finally {
      setIsDeletingDataset(false);
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
    const confirmed = window.confirm(`Delete ${selectedIds.size} dataset(s)? This action cannot be undone.`);
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
    if (successCount > 0) toast.success(`Deleted ${successCount} dataset(s)`);
    if (failCount > 0) toast.error(`Failed to delete ${failCount} dataset(s)`);
  };

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-small font-strong text-text-primary mb-2">Failed to load datasets</h2>
          <p className="text-caption text-text-tertiary">
            {error instanceof Error ? error.message : 'An unexpected error occurred'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageListLayout
        title={t('module.datasets.title')}
        description="Table-based datasets for exploring and analyzing data from your datasources"
        overview={(
          <ModuleOverview
            icon={Database}
            title={t('overview.datasets.title')}
            description={t('overview.datasets.description')}
            badges={[t('overview.datasets.badge1'), t('overview.datasets.badge2'), t('overview.datasets.badge3')]}
            stats={[
              {
                label: t('overview.datasets.count'),
                value: datasetItems.length,
                helper: t('overview.datasets.countHelper'),
              },
              {
                label: t('overview.datasets.documented'),
                value: documentedDatasets,
                helper: t('overview.datasets.documentedHelper'),
              },
              {
                label: t('overview.datasets.updated'),
                value: updatedThisWeek,
                helper: t('overview.datasets.updatedHelper'),
              },
            ]}
          />
        )}
        action={canEdit ? (
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setIsCreateModalOpen(true)}>
            {t('action.newDataset')}
          </Button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="list"
        activeFilters={activeListFilterCount > 0 ? (
          <>
            {listFilters.docs && (
              <FilterTag
                tone={listFilters.docs === 'documented' ? 'success' : 'warning'}
                active
                onClick={() => toggleListFilter('docs', listFilters.docs!)}
              >
                {listFilters.docs === 'documented' ? 'Documented' : 'Needs notes'}
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
            <Button variant="ghost" size="xs" onClick={clearListFilters}>
              Clear filters
            </Button>
          </>
        ) : null}
      >
        {({ viewMode, filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const filtered = (datasets ?? []).filter((dataset: any) => {
            const docState = dataset.description?.trim() ? 'documented' : 'undocumented';
            const matchesSearch =
              needle.length === 0 ||
              dataset.name.toLowerCase().includes(needle) ||
              (dataset.description ?? '').toLowerCase().includes(needle) ||
              (dataset.owner_email ?? '').toLowerCase().includes(needle);

            return (
              matchesSearch &&
              (!listFilters.docs || docState === listFilters.docs) &&
              (!listFilters.access || (dataset.user_permission ?? 'none') === listFilters.access) &&
              (!listFilters.owner || dataset.owner_email === listFilters.owner)
            );
          });

          if (!datasets || datasets.length === 0) {
            return (
              <div className="text-center py-16">
                <Database className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
                <h2 className="text-small font-strong text-text-primary mb-2">No datasets yet</h2>
                <p className="text-caption text-text-tertiary mb-6">
                  Create your first dataset to start exploring tables from your datasources
                </p>
                {canEdit && (
                  <Button
                    variant="primary"
                    size="lg"
                    leadingIcon={<Plus className="h-4 w-4" />}
                    onClick={() => setIsCreateModalOpen(true)}
                  >
                    Create Dataset
                  </Button>
                )}
              </div>
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-text-quaternary mb-2" />
                <p className="text-caption text-text-tertiary">
                  No datasets matching "<strong className="text-text-secondary">{filterText}</strong>"
                </p>
              </div>
            );
          }

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters })}
            >
              {({ pageItems, pagination }) => (
                <div className="space-y-3">
                  {viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {pageItems.map((dataset: any) => (
                  <div
                    key={dataset.id}
                    className="group rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 transition-[box-shadow,border-color] hover:border-[rgb(var(--border-strong))] hover:shadow-linear"
                  >
                    <button
                      onClick={() => router.push(`/datasets/${dataset.id}`)}
                      className="w-full p-5 text-left"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                            <Database className="h-4 w-4" />
                          </div>
                          <h3 className="text-small font-strong text-text-primary truncate group-hover:text-brand transition-colors">
                            {dataset.name}
                          </h3>
                          <OwnerBadge email={dataset.owner_email} />
                        </div>
                        <ChevronRight className="h-4 w-4 text-text-quaternary group-hover:text-brand transition-colors" />
                      </div>
                      {dataset.description && (
                        <p className="text-caption text-text-secondary mb-4 line-clamp-2">{dataset.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-tiny text-text-quaternary">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          <span>{new Date(dataset.updated_at).toLocaleDateString(locale)}</span>
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center justify-end gap-1 border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-2">
                      {getResourcePermissions(dataset.user_permission).canShare && (
                        <IconButton
                          aria-label="Share dataset"
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShareDataset({ id: dataset.id, name: dataset.name });
                          }}
                          title="Share dataset"
                        >
                          <Share2 className="h-4 w-4" />
                        </IconButton>
                      )}
                      {getResourcePermissions(dataset.user_permission).canDelete && (
                        <IconButton
                          aria-label="Delete dataset"
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteDataset(dataset.id, dataset.name);
                          }}
                          disabled={deleteMutation.isPending}
                          className="hover:text-danger"
                          title="Delete dataset"
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                      ))}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
                      <div className="app-list-table-wrap">
                      <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                        <thead className="bg-surface-2">
                          <tr>
                            {canEdit && (
                              <th className="w-10 px-3 py-3">
                                <input
                                  type="checkbox"
                                  checked={pageItems.length > 0 && pageItems.every((d: any) => selectedIds.has(d.id))}
                                  ref={(el) => { if (el) el.indeterminate = pageItems.some((d: any) => selectedIds.has(d.id)) && !pageItems.every((d: any) => selectedIds.has(d.id)); }}
                                  onChange={() => toggleSelectAll(pageItems.map((d: any) => d.id))}
                                  className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                                />
                              </th>
                            )}
                            <th className="app-list-header w-[36%]">
                              Dataset
                            </th>
                            <th className="app-list-header w-[22%]">
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
                          {pageItems.map((dataset: any) => {
                    const docState = dataset.description?.trim() ? 'documented' : 'undocumented';
                    const accessState = dataset.user_permission ?? 'none';

                    return (
                      <tr key={dataset.id} className="hover:bg-surface-2">
                        {canEdit && (
                          <td className="w-10 px-3 py-3.5">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(dataset.id)}
                              onChange={() => toggleSelect(dataset.id)}
                              className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))] cursor-pointer"
                            />
                          </td>
                        )}
                        <td className="app-list-cell">
                          <button
                            onClick={() => router.push(`/datasets/${dataset.id}`)}
                            className="flex w-full items-start gap-3 text-left"
                          >
                            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                              <Database className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">
                                {dataset.name}
                              </span>
                              <p className="app-list-text-sub mt-0.5 text-tiny text-text-tertiary">
                                {dataset.description || 'No dataset notes yet'}
                              </p>
                            </div>
                          </button>
                        </td>
                        <td className="app-list-cell">
                          <div className="flex flex-wrap gap-1.5">
                            <FilterTag
                              tone={docState === 'documented' ? 'success' : 'warning'}
                              active={listFilters.docs === docState}
                              onClick={() => toggleListFilter('docs', docState)}
                            >
                              {docState === 'documented' ? 'Documented' : 'Needs notes'}
                            </FilterTag>
                            <FilterTag
                              tone={accessState === 'full' ? 'brand' : accessState === 'edit' ? 'info' : 'neutral'}
                              active={listFilters.access === accessState}
                              onClick={() => toggleListFilter('access', accessState)}
                            >
                              {accessState === 'full'
                                ? 'Full access'
                                : accessState === 'edit'
                                  ? 'Editable'
                                  : accessState === 'view'
                                    ? 'View only'
                                    : 'Restricted'}
                            </FilterTag>
                          </div>
                        </td>
                        <td className="app-list-cell">
                          {dataset.owner_email ? (
                            <OwnerBadge
                              email={dataset.owner_email}
                              active={listFilters.owner === dataset.owner_email}
                              onClick={() => toggleListFilter('owner', dataset.owner_email)}
                            />
                          ) : (
                            <span className="text-tiny text-text-quaternary">—</span>
                          )}
                        </td>
                        <td className="app-list-cell text-caption text-text-tertiary">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(dataset.updated_at).toLocaleDateString(locale)}
                          </span>
                        </td>
                        <td className="app-list-cell-tight text-right">
                          <div className="flex items-center justify-end gap-1">
                            {getResourcePermissions(dataset.user_permission).canShare && (
                              <IconButton
                                aria-label="Share dataset"
                                variant="ghost"
                                size="xs"
                                onClick={() => setShareDataset({ id: dataset.id, name: dataset.name })}
                                title="Share dataset"
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                            {getResourcePermissions(dataset.user_permission).canDelete && (
                              <IconButton
                                aria-label="Delete dataset"
                                variant="ghost"
                                size="xs"
                                onClick={() => handleDeleteDataset(dataset.id, dataset.name)}
                                disabled={deleteMutation.isPending}
                                className="hover:text-danger"
                                title="Delete dataset"
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
                  )}

                  {pagination}
                </div>
              )}
            </PaginatedCollection>
          );
        }}
      </PageListLayout>

      {isCreateModalOpen && (
        <CreateDatasetModal
          onClose={() => setIsCreateModalOpen(false)}
          onCreate={handleCreateDataset}
          isLoading={createMutation.isPending}
        />
      )}

      {datasetToDelete && (
        <DeleteConstraintModal
          itemName={datasetToDelete.name}
          itemTypeLabel="dataset"
          constraints={deleteConstraints}
          isDeleting={isDeletingDataset}
          onConfirm={confirmDeleteDataset}
          onClose={() => { setDatasetToDelete(null); setDeleteConstraints(null); }}
        />
      )}

      {shareDataset && (
        <ShareDialog
          resourceType="dataset"
          resourceId={shareDataset.id}
          resourceName={shareDataset.name}
          onClose={() => setShareDataset(null)}
        />
      )}

      {canEdit && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          onDelete={handleBulkDelete}
          onClear={() => setSelectedIds(new Set())}
          isDeleting={isBulkDeleting}
        />
      )}
    </>
  );
}

// Create Dataset Modal Component
interface CreateDatasetModalProps {
  onClose: () => void;
  onCreate: (input: CreateDatasetInput) => void;
  isLoading: boolean;
}

function CreateDatasetModal({ onClose, onCreate, isLoading }: CreateDatasetModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
      });
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Create Dataset"
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const evt = { preventDefault: () => {} } as React.FormEvent;
              handleSubmit(evt);
            }}
            disabled={!name.trim() || isLoading}
            loading={isLoading}
          >
            {isLoading ? 'Creating…' : 'Create Dataset'}
          </Button>
        </>
      )}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-caption text-text-tertiary -mt-1">
          Create a new dataset to organize your tables
        </p>

        <FieldGroup>
          <Label htmlFor="name">
            Name <span className="text-danger">*</span>
          </Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Dataset"
            required
            autoFocus
            disabled={isLoading}
          />
        </FieldGroup>

        <FieldGroup>
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description..."
            rows={3}
            disabled={isLoading}
          />
        </FieldGroup>

        {/* Hidden submit to keep enter-key behavior */}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Modal>
  );
}
