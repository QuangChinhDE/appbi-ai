'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, LayoutDashboard, Clock, Eye, Trash2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { useDashboards, useCreateDashboard, useDeleteDashboard } from '@/hooks/use-dashboards';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { DashboardList } from '@/components/dashboards/DashboardList';
import { DeleteConstraintModal } from '@/components/common/DeleteConstraintModal';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { useI18n } from '@/providers/LanguageProvider';

export default function DashboardsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [isCreating, setIsCreating] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState('');
  const [newDashboardDescription, setNewDashboardDescription] = useState('');
  const [dashboardToDelete, setDashboardToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingDashboard, setIsDeletingDashboard] = useState(false);

  const { data: dashboards, isLoading } = useDashboards();
  const { data: permData } = usePermissions();
  const canEdit = hasPermission(permData?.permissions, 'dashboards', 'edit');
  const createMutation = useCreateDashboard();
  const deleteMutation = useDeleteDashboard();
  const dashboardItems = dashboards ?? [];
  const totalChartLinks = dashboardItems.reduce(
    (sum, dashboard) => sum + (dashboard.dashboard_charts?.length || 0),
    0,
  );
  const dashboardsUpdatedThisWeek = dashboardItems.filter((dashboard) => {
    const updatedAt = new Date(dashboard.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;

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

  return (
    <>
      <PageListLayout
        title={t('module.dashboards.title')}
        description={`${dashboards?.length ?? 0} dashboard${dashboards?.length !== 1 ? 's' : ''}`}
        overview={(
          <ModuleOverview
            icon={LayoutDashboard}
            title={t('overview.dashboards.title')}
            description={t('overview.dashboards.description')}
            badges={[t('overview.dashboards.badge1'), t('overview.dashboards.badge2'), t('overview.dashboards.badge3')]}
            stats={[
              {
                label: t('overview.dashboards.saved'),
                value: dashboardItems.length,
                helper: t('overview.dashboards.savedHelper'),
              },
              {
                label: t('overview.dashboards.charts'),
                value: totalChartLinks,
                helper: t('overview.dashboards.chartsHelper'),
              },
              {
                label: t('overview.dashboards.updated'),
                value: dashboardsUpdatedThisWeek,
                helper: t('overview.dashboards.updatedHelper'),
              },
            ]}
          />
        )}
        action={canEdit ? (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t('action.newDashboard')}
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('common.loading')}
        searchPlaceholder={t('common.search')}
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = (dashboards ?? []).filter((dashboard) =>
            dashboard.name.toLowerCase().includes(filterText.toLowerCase()) ||
            dashboard.description?.toLowerCase().includes(filterText.toLowerCase()),
          );

          return (
            <div className="space-y-6">
              {(!dashboards || dashboards.length === 0) ? (
                <DashboardList dashboards={[]} onDelete={handleDelete} />
              ) : filtered.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center">
                  <Search className="mb-2 h-8 w-8 text-gray-300" />
                  <p className="text-sm text-gray-500">
                    No dashboards matching "<strong>{filterText}</strong>"
                  </p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                  {filtered.map((dashboard) => {
                    const chartCount = dashboard.dashboard_charts?.length || 0;
                    const createdAt = new Date(dashboard.created_at).toLocaleDateString(locale, {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    });

                    return (
                      <div
                        key={dashboard.id}
                        className="group flex flex-col rounded-lg border border-gray-200 bg-white transition-all hover:shadow-md"
                      >
                        <div className="flex-1 p-5">
                          <div className="mb-3 flex items-start justify-between">
                            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
                              <LayoutDashboard className="h-5 w-5 text-blue-600" />
                            </div>
                            {getResourcePermissions(dashboard.user_permission).canDelete && (
                              <button
                                onClick={() => handleDelete(dashboard.id)}
                                className="rounded p-1 text-gray-400 opacity-0 transition-all hover:text-red-600 group-hover:opacity-100"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                          <h3 className="mb-1 truncate text-sm font-semibold text-gray-900">{dashboard.name}</h3>
                          {dashboard.description && (
                            <p className="mb-2 line-clamp-2 text-xs text-gray-500">{dashboard.description}</p>
                          )}
                          <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
                            <span>{chartCount} chart{chartCount !== 1 ? 's' : ''}</span>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {createdAt}
                            </span>
                          </div>
                        </div>
                        <div className="flex justify-end rounded-b-lg border-t bg-gray-50 px-5 py-3">
                          <button
                            onClick={() => router.push(`/dashboards/${dashboard.id}`)}
                            className="flex items-center gap-1.5 text-xs font-medium text-blue-600 transition-colors hover:text-blue-800"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Open
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <DashboardList
                  dashboards={filtered}
                  onDelete={canEdit ? handleDelete : undefined}
                  deletingId={isDeletingDashboard ? dashboardToDelete?.id : undefined}
                />
              )}
            </div>
          );
        }}
      </PageListLayout>

      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white shadow-xl">
            <form onSubmit={handleCreate}>
              <div className="border-b border-gray-200 p-6">
                <h2 className="text-xl font-semibold">Create New Dashboard</h2>
              </div>
              <div className="space-y-4 p-6">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Dashboard Name *</label>
                  <input
                    type="text"
                    value={newDashboardName}
                    onChange={(event) => setNewDashboardName(event.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
                  <textarea
                    value={newDashboardDescription}
                    onChange={(event) => setNewDashboardDescription(event.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows={3}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 border-t border-gray-200 p-6">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreating(false);
                    setNewDashboardName('');
                    setNewDashboardDescription('');
                  }}
                  className="rounded-md border border-gray-300 px-4 py-2 transition-colors hover:bg-gray-50"
                  disabled={createMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || !newDashboardName}
                  className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
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
          onClose={() => {
            setDashboardToDelete(null);
            setDeleteConstraints(null);
          }}
        />
      )}
    </>
  );
}
