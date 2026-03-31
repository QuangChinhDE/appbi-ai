/**
 * Dataset Workspaces List Page
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
  useWorkspaces, 
  useCreateWorkspace, 
  useDeleteWorkspace,
  type CreateWorkspaceInput,
} from '@/hooks/use-dataset-workspaces';

export default function DatasetWorkspacesPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  
  const { data: workspaces, isLoading, error } = useWorkspaces();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'workspaces', 'edit');
  const createMutation = useCreateWorkspace();
  const deleteMutation = useDeleteWorkspace();
  const workspaceItems = workspaces ?? [];
  const documentedWorkspaces = workspaceItems.filter((workspace) => Boolean(workspace.description?.trim())).length;
  const updatedThisWeek = workspaceItems.filter((workspace) => {
    const updatedAt = new Date(workspace.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const [workspaceToDelete, setWorkspaceToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);

  const handleCreateWorkspace = async (input: CreateWorkspaceInput) => {
    try {
      const workspace = await createMutation.mutateAsync(input);
      setIsCreateModalOpen(false);
      router.push(`/dataset-workspaces/${workspace.id}`);
    } catch (error) {
      console.error('Failed to create workspace:', error);
      alert('Failed to create workspace. Please try again.');
    }
  };

  const handleDeleteWorkspace = (id: number, name: string) => {
    setWorkspaceToDelete({ id, name });
    setDeleteConstraints(null);
  };

  const confirmDeleteWorkspace = async () => {
    if (!workspaceToDelete) return;
    setIsDeletingWorkspace(true);
    try {
      await deleteMutation.mutateAsync(workspaceToDelete.id);
      setWorkspaceToDelete(null);
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      if (detail?.constraints) {
        setDeleteConstraints(detail.constraints);
      } else {
        alert(`Failed to delete workspace: ${detail || error.message}`);
        setWorkspaceToDelete(null);
      }
    } finally {
      setIsDeletingWorkspace(false);
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
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Failed to load workspaces</h2>
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
        title={t('module.workspaces.title')}
        description="Table-based datasets for exploring and analyzing data from your datasources"
        overview={(
          <ModuleOverview
            icon={Database}
            title={t('overview.workspaces.title')}
            description={t('overview.workspaces.description')}
            badges={[t('overview.workspaces.badge1'), t('overview.workspaces.badge2'), t('overview.workspaces.badge3')]}
            stats={[
              {
                label: t('overview.workspaces.count'),
                value: workspaceItems.length,
                helper: t('overview.workspaces.countHelper'),
              },
              {
                label: t('overview.workspaces.documented'),
                value: documentedWorkspaces,
                helper: t('overview.workspaces.documentedHelper'),
              },
              {
                label: t('overview.workspaces.updated'),
                value: updatedThisWeek,
                helper: t('overview.workspaces.updatedHelper'),
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
            {t('action.newWorkspace')}
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = (workspaces ?? []).filter((w: any) =>
            w.name.toLowerCase().includes(filterText.toLowerCase())
          );

          if (!workspaces || workspaces.length === 0) {
            return (
              <div className="text-center py-12">
                <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-900 mb-2">No workspaces yet</h2>
                <p className="text-gray-600 mb-6">
                  Create your first dataset workspace to start exploring tables from your datasources
                </p>
                <button
                  onClick={() => setIsCreateModalOpen(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  <Plus className="w-5 h-5" />
                  Create Workspace
                </button>
              </div>
            );
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No workspaces matching "<strong>{filterText}</strong>"</p>
              </div>
            );
          }

          if (viewMode === 'grid') {
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filtered.map((workspace: any) => (
                  <div
                    key={workspace.id}
                    className="bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all group"
                  >
                    <button
                      onClick={() => router.push(`/dataset-workspaces/${workspace.id}`)}
                      className="w-full p-6 text-left"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-blue-50 rounded-lg">
                            <Database className="w-5 h-5 text-blue-600" />
                          </div>
                          <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                            {workspace.name}
                          </h3>
                          <OwnerBadge email={workspace.owner_email} />
                        </div>
                        <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
                      </div>
                      {workspace.description && (
                        <p className="text-sm text-gray-600 mb-4 line-clamp-2">{workspace.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>{new Date(workspace.updated_at).toLocaleDateString(locale)}</span>
                        </div>
                      </div>
                    </button>
                    <div className="px-6 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
                      {getResourcePermissions(workspace.user_permission).canDelete && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteWorkspace(workspace.id, workspace.name); }}
                        disabled={deleteMutation.isPending}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                        title="Delete workspace"
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
              {filtered.map((workspace: any) => (
                <div key={workspace.id} className="flex items-center px-5 py-4 hover:bg-gray-50 group">
                  <div className="p-2 bg-blue-50 rounded-lg mr-3 flex-shrink-0">
                    <Database className="w-4 h-4 text-blue-600" />
                  </div>
                  <button
                    onClick={() => router.push(`/dataset-workspaces/${workspace.id}`)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 hover:text-blue-600 transition-colors">
                        {workspace.name}
                      </span>
                      <OwnerBadge email={workspace.owner_email} />
                    </div>
                    {workspace.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{workspace.description}</p>
                    )}
                  </button>
                  <span className="text-xs text-gray-400 mr-4 flex-shrink-0 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(workspace.updated_at).toLocaleDateString()}
                  </span>
                  {getResourcePermissions(workspace.user_permission).canDelete && (
                  <button
                    onClick={() => handleDeleteWorkspace(workspace.id, workspace.name)}
                    disabled={deleteMutation.isPending}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all disabled:opacity-50"
                    title="Delete workspace"
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
        <CreateWorkspaceModal
          onClose={() => setIsCreateModalOpen(false)}
          onCreate={handleCreateWorkspace}
          isLoading={createMutation.isPending}
        />
      )}

      {workspaceToDelete && (
        <DeleteConstraintModal
          itemName={workspaceToDelete.name}
          itemTypeLabel="workspace"
          constraints={deleteConstraints}
          isDeleting={isDeletingWorkspace}
          onConfirm={confirmDeleteWorkspace}
          onClose={() => { setWorkspaceToDelete(null); setDeleteConstraints(null); }}
        />
      )}
    </>
  );
}

// Create Workspace Modal Component
interface CreateWorkspaceModalProps {
  onClose: () => void;
  onCreate: (input: CreateWorkspaceInput) => void;
  isLoading: boolean;
}

function CreateWorkspaceModal({ onClose, onCreate, isLoading }: CreateWorkspaceModalProps) {
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
            <h2 className="text-xl font-semibold text-gray-900">Create Workspace</h2>
            <p className="text-sm text-gray-500 mt-1">
              Create a new dataset workspace to organize your tables
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
                placeholder="My Dataset Workspace"
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
                'Create Workspace'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
