'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, LayoutDashboard, Clock, Eye, Trash2, Search } from 'lucide-react';
import { useDashboards, useCreateDashboard, useDeleteDashboard } from '@/hooks/use-dashboards';
import { DashboardList } from '@/components/dashboards/DashboardList';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { PageListLayout } from '@/components/common/PageListLayout';
import { toast } from 'sonner';

export default function DashboardsPage() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState('');
  const [newDashboardDescription, setNewDashboardDescription] = useState('');
  const [dashboardToDelete, setDashboardToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingDashboard, setIsDeletingDashboard] = useState(false);

  const { data: dashboards, isLoading } = useDashboards();
  const createMutation = useCreateDashboard();
  const deleteMutation = useDeleteDashboard();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({
        name: newDashboardName,
        description: newDashboardDescription || undefined,
      });
      setNewDashboardName('');
      setNewDashboardDescription('');
      setIsCreating(false);
    } catch (error: any) {
      toast.error(`Không thể tạo: ${error.message}`);
    }
  };

  const handleDelete = (id: number) => {
    const dashboard = dashboards?.find(d => d.id === id);
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
        toast.error(`Không thể xóa: ${detail || error.message}`);
        setDashboardToDelete(null);
      }
    } finally {
      setIsDeletingDashboard(false);
    }
  };

  return (
    <>
      <PageListLayout
        title="Dashboards"
        description={`${dashboards?.length ?? 0} dashboard${dashboards?.length !== 1 ? 's' : ''}`}
        action={
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Dashboard
          </button>
        }
        isLoading={isLoading}
        loadingText="Loading dashboards…"
        searchPlaceholder="Search dashboards…"
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = (dashboards ?? []).filter(d =>
            d.name.toLowerCase().includes(filterText.toLowerCase()) ||
            d.description?.toLowerCase().includes(filterText.toLowerCase())
          );

          if (!dashboards || dashboards.length === 0) {
            return <DashboardList dashboards={[]} onDelete={handleDelete} />;
          }

          if (filtered.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <Search className="w-8 h-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No dashboards matching "<strong>{filterText}</strong>"</p>
              </div>
            );
          }

          if (viewMode === 'grid') {
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filtered.map(dashboard => {
                  const chartCount = dashboard.dashboard_charts?.length || 0;
                  const createdAt = new Date(dashboard.created_at).toLocaleDateString('vi-VN', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                  });
                  return (
                    <div
                      key={dashboard.id}
                      className="bg-white rounded-lg border border-gray-200 hover:shadow-md transition-all group flex flex-col"
                    >
                      <div className="p-5 flex-1">
                        <div className="flex items-start justify-between mb-3">
                          <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                            <LayoutDashboard className="w-5 h-5 text-purple-600" />
                          </div>
                          <button
                            onClick={() => handleDelete(dashboard.id)}
                            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-all p-1 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <h3 className="font-semibold text-gray-900 text-sm truncate mb-1">{dashboard.name}</h3>
                        {dashboard.description && (
                          <p className="text-xs text-gray-500 line-clamp-2 mb-2">{dashboard.description}</p>
                        )}
                        <div className="flex items-center justify-between text-xs text-gray-400 mt-2">
                          <span>{chartCount} chart{chartCount !== 1 ? 's' : ''}</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {createdAt}
                          </span>
                        </div>
                      </div>
                      <div className="px-5 py-3 border-t bg-gray-50 rounded-b-lg flex justify-end">
                        <button
                          onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                          className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Open
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          }

          // List view
          return (
            <DashboardList
              dashboards={filtered}
              onDelete={handleDelete}
              deletingId={isDeletingDashboard ? dashboardToDelete?.id : undefined}
            />
          );
        }}
      </PageListLayout>

      {/* Create Form Modal */}
      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <form onSubmit={handleCreate}>
              <div className="p-6 border-b border-gray-200">
                <h2 className="text-xl font-semibold">Create New Dashboard</h2>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dashboard Name *</label>
                  <input
                    type="text"
                    value={newDashboardName}
                    onChange={(e) => setNewDashboardName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={newDashboardDescription}
                    onChange={(e) => setNewDashboardDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows={3}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 p-6 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => { setIsCreating(false); setNewDashboardName(''); setNewDashboardDescription(''); }}
                  className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  disabled={createMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || !newDashboardName}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dashboardToDelete && (
        <DeleteConstraintModal
          itemName={dashboardToDelete.name}
          itemTypeLabel="dashboard"
          constraints={deleteConstraints}
          isDeleting={isDeletingDashboard}
          onConfirm={confirmDelete}
          onClose={() => { setDashboardToDelete(null); setDeleteConstraints(null); }}
        />
      )}
    </>
  );
}
