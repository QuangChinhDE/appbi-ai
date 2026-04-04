/**
 * Dataset Datasets List Page
 */
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Database, Loader2, Calendar, ChevronRight, Trash2, Search } from 'lucide-react';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { useI18n } from '@/providers/LanguageProvider';
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

  const handleCreateDataset = async (input: CreateDatasetInput) => {
    try {
      const dataset = await createMutation.mutateAsync(input);
      setIsCreateModalOpen(false);
      router.push(`/datasets/${dataset.id}`);
    } catch (error) {
      console.error('Failed to create dataset:', error);
      alert('Failed to create dataset. Please try again.');
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
      setDatasetToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        alert(`Failed to delete dataset: ${detail || error.message}`);
        setDatasetToDelete(null);
      }
    } finally {
      setIsDeletingDataset(false);
    }
  };

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-red-600 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Failed to load datasets</h2>
          <p className="text-gray-600">
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
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('action.newDataset')}
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = (datasets ?? []).filter((w: any) =>
            w.name.toLowerCase().includes(filterText.toLowerCase())
          );

          if (!datasets || datasets.length === 0) {
            return (
              <div className="text-center py-12">
                <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-900 mb-2">No datasets yet</h2>
                <p className="text-gray-600 mb-6">
                  Create your first dataset dataset to start exploring tables from your datasources
                </p>
                <button
                  onClick={() => setIsCreateModalOpen(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  <Plus className="w-5 h-5" />
                  Create Dataset
                </button>
              </div>
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No datasets matching "<strong>{filterText}</strong>"</p>
              </div>
            );
          }

          if (viewMode === 'grid') {
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filtered.map((dataset: any) => (
                  <div
                    key={dataset.id}
                    className="bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all group"
                  >
                    <button
                      onClick={() => router.push(`/datasets/${dataset.id}`)}
                      className="w-full p-6 text-left"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-blue-50 rounded-lg">
                            <Database className="w-5 h-5 text-blue-600" />
                          </div>
                          <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                            {dataset.name}
                          </h3>
                          <OwnerBadge email={dataset.owner_email} />
                        </div>
                        <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
                      </div>
                      {dataset.description && (
                        <p className="text-sm text-gray-600 mb-4 line-clamp-2">{dataset.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>{new Date(dataset.updated_at).toLocaleDateString(locale)}</span>
                        </div>
                      </div>
                    </button>
                    <div className="px-6 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
                      {getResourcePermissions(dataset.user_permission).canDelete && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteDataset(dataset.id, dataset.name); }}
                        disabled={deleteMutation.isPending}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                        title="Delete dataset"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          }

          // List view
          return (
            <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
              {filtered.map((dataset: any) => (
                <div key={dataset.id} className="flex items-center px-5 py-4 hover:bg-gray-50 group">
                  <div className="p-2 bg-blue-50 rounded-lg mr-3 flex-shrink-0">
                    <Database className="w-4 h-4 text-blue-600" />
                  </div>
                  <button
                    onClick={() => router.push(`/datasets/${dataset.id}`)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 hover:text-blue-600 transition-colors">
                        {dataset.name}
                      </span>
                      <OwnerBadge email={dataset.owner_email} />
                    </div>
                    {dataset.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{dataset.description}</p>
                    )}
                  </button>
                  <span className="text-xs text-gray-400 mr-4 flex-shrink-0 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(dataset.updated_at).toLocaleDateString()}
                  </span>
                  {getResourcePermissions(dataset.user_permission).canDelete && (
                  <button
                    onClick={() => handleDeleteDataset(dataset.id, dataset.name)}
                    disabled={deleteMutation.isPending}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all disabled:opacity-50"
                    title="Delete dataset"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  )}
                </div>
              ))}
            </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="px-6 py-4 border-b">
            <h2 className="text-xl font-semibold text-gray-900">Create Dataset</h2>
            <p className="text-sm text-gray-500 mt-1">
              Create a new dataset dataset to organize your tables
            </p>
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Dataset Dataset"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                autoFocus
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-2">
                Description
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description..."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isLoading}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Dataset'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
