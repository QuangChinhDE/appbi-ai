'use client';

import React, { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bot,
  Clock,
  FileText,
  History,
  LayoutDashboard,
  PencilLine,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { useAgentReportSpecs, useDeleteAgentReportSpec } from '@/hooks/use-agent-report-specs';
import { hasPermission, usePermissions } from '@/hooks/use-permissions';
import { useI18n } from '@/providers/LanguageProvider';

function statusTone(status: string) {
  if (status === 'ready' || status === 'succeeded') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'failed') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-blue-50 text-blue-700 border-blue-200';
}

export default function AIReportsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();

  const { data: permData } = usePermissions();
  const canViewAgent = hasPermission(permData?.permissions, 'ai_agent', 'view');
  const canEditAgent =
    hasPermission(permData?.permissions, 'ai_agent', 'edit') &&
    hasPermission(permData?.permissions, 'dashboards', 'edit') &&
    hasPermission(permData?.permissions, 'explore_charts', 'edit');
  const { data: savedReports = [], isLoading } = useAgentReportSpecs(canViewAgent);
  const deleteSpecMutation = useDeleteAgentReportSpec();

  const reportCountLabel = useMemo(
    () => `${savedReports.length} saved AI report${savedReports.length !== 1 ? 's' : ''}`,
    [savedReports.length],
  );
  const reportStats = useMemo(
    () => ({
      ready: savedReports.filter((spec) => spec.status === 'ready').length,
      linkedDashboards: savedReports.filter((spec) => Boolean(spec.latest_dashboard_id)).length,
    }),
    [savedReports],
  );

  async function handleDeleteReport(specId: number, specName: string, hasDashboard: boolean) {
    const confirmed = window.confirm(
      hasDashboard
        ? t('aiReports.delete.withDashboard', { name: specName })
        : t('aiReports.delete.withoutDashboard', { name: specName }),
    );
    if (!confirmed) return;

    try {
      await deleteSpecMutation.mutateAsync(specId);
      router.refresh();
    } catch (error) {
      console.error('Failed to delete AI report', error);
    }
  }

  if (!canViewAgent) {
    return (
      <div className="p-8">
        <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{t('aiReports.permissionTitle')}</h1>
              <p className="mt-1 text-sm text-gray-500">{t('aiReports.permissionDescription')}</p>
            </div>
          </div>
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {t('aiReports.permissionMessage')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageListLayout
        title={t('module.aiReports.title')}
        description={reportCountLabel}
        overview={(
          <ModuleOverview
            icon={Bot}
            title={t('overview.aiReports.title')}
            description={t('overview.aiReports.description')}
            badges={[t('overview.aiReports.badge1'), t('overview.aiReports.badge2'), t('overview.aiReports.badge3'), t('overview.aiReports.badge4')]}
            stats={[
              {
                label: t('overview.aiReports.saved'),
                value: savedReports.length,
                helper: t('overview.aiReports.savedHelper'),
              },
              {
                label: t('overview.aiReports.ready'),
                value: reportStats.ready,
                helper: t('overview.aiReports.readyHelper'),
              },
              {
                label: t('overview.aiReports.linked'),
                value: reportStats.linkedDashboards,
                helper: t('overview.aiReports.linkedHelper'),
              },
            ]}
          />
        )}
        action={canEditAgent ? (
          <button
            onClick={() => router.push('/ai-reports/new')}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            <Bot className="h-4 w-4" />
            {t('aiReports.new')}
          </button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('aiReports.loading')}
        searchPlaceholder={t('aiReports.searchPlaceholder')}
        defaultView="grid"
      >
        {({ viewMode, filterText }) => {
          const filtered = savedReports.filter((spec) => {
            const needle = filterText.toLowerCase();
            return (
              spec.name.toLowerCase().includes(needle) ||
              spec.description?.toLowerCase().includes(needle) ||
              spec.status.toLowerCase().includes(needle)
            );
          });

          return (
            <div className="space-y-6">
              {savedReports.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center shadow-sm">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                    <FileText className="h-6 w-6" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-gray-900">{t('aiReports.noReportsTitle')}</h3>
                  <p className="mt-2 text-sm text-gray-500">{t('aiReports.noReportsDescription')}</p>
                  {canEditAgent && (
                    <button
                      onClick={() => router.push('/ai-reports/new')}
                      className="mt-6 inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                    >
                      <Bot className="h-4 w-4" />
                      {t('aiReports.new')}
                    </button>
                  )}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center">
                  <Search className="mb-2 h-8 w-8 text-gray-300" />
                  <p className="text-sm text-gray-500">
                    No AI reports matching "<strong>{filterText}</strong>"
                  </p>
                </div>
              ) : viewMode === 'grid' ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filtered.map((spec) => (
                    <div key={spec.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-gray-900">{spec.name}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{t('aiReports.specLabel')} #{spec.id}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusTone(spec.status)}`}>
                          {spec.status}
                        </span>
                      </div>
                      {spec.description && (
                        <p className="mt-3 line-clamp-3 text-sm text-gray-600">{spec.description}</p>
                      )}
                      <div className="mt-4 grid gap-3 text-xs text-gray-500 sm:grid-cols-2">
                        <div className="rounded-lg bg-gray-50 px-3 py-2">
                          <p className="font-medium text-gray-700">{t('aiReports.inScope')}</p>
                          <p className="mt-1">{spec.selected_tables_snapshot?.length ?? 0}</p>
                        </div>
                        <div className="rounded-lg bg-gray-50 px-3 py-2">
                          <p className="font-medium text-gray-700">{t('aiReports.latestDashboard')}</p>
                          <p className="mt-1">{spec.latest_dashboard_id ? `#${spec.latest_dashboard_id}` : t('common.draftOnly')}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
                        <span className="inline-flex items-center gap-1">
                          <History className="h-3.5 w-3.5" />
                          {t('aiReports.savedReport')}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {spec.last_run_at ? new Date(spec.last_run_at).toLocaleDateString(locale) : t('common.notRunYet')}
                        </span>
                      </div>
                      <div className="mt-5 space-y-2">
                        {spec.latest_dashboard_id && (
                          <button
                            onClick={() => router.push(`/dashboards/${spec.latest_dashboard_id}`)}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                          >
                            <LayoutDashboard className="h-4 w-4" />
                            {t('aiReports.editInDashboard')}
                          </button>
                        )}
                        <div className={`grid gap-2 ${canEditAgent ? 'grid-cols-3' : 'grid-cols-1'}`}>
                          <button
                            onClick={() => router.push(`/ai-reports/${spec.id}`)}
                            className="inline-flex min-w-0 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                          >
                            <Sparkles className="h-4 w-4 shrink-0" />
                            <span className="truncate">{t('aiReports.read')}</span>
                          </button>
                          {canEditAgent && (
                            <button
                              onClick={() => router.push(`/ai-reports/${spec.id}/edit`)}
                              className="inline-flex min-w-0 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                            >
                              <PencilLine className="h-4 w-4 shrink-0" />
                              <span className="truncate">{t('aiReports.editBrief')}</span>
                            </button>
                          )}
                          {canEditAgent && (
                            <button
                              onClick={() => handleDeleteReport(spec.id, spec.name, Boolean(spec.latest_dashboard_id))}
                              disabled={deleteSpecMutation.isPending}
                              className="inline-flex min-w-0 items-center justify-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Trash2 className="h-4 w-4 shrink-0" />
                              <span className="truncate">{t('common.delete')}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="grid grid-cols-[minmax(0,2fr)_120px_120px_160px_auto] gap-3 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                    <span>Report</span>
                    <span>Status</span>
                    <span>Tables</span>
                    <span>Last run</span>
                    <span className="text-right">Actions</span>
                  </div>
                  {filtered.map((spec) => (
                    <div
                      key={spec.id}
                      className="grid grid-cols-[minmax(0,2fr)_120px_120px_160px_auto] gap-3 border-b border-gray-100 px-5 py-4 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-gray-900">{spec.name}</p>
                        {spec.description && <p className="mt-1 truncate text-sm text-gray-500">{spec.description}</p>}
                      </div>
                      <div>
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusTone(spec.status)}`}>
                          {spec.status}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600">{spec.selected_tables_snapshot?.length ?? 0}</div>
                      <div className="text-sm text-gray-600">
                        {spec.last_run_at ? new Date(spec.last_run_at).toLocaleDateString('vi-VN') : 'Not run yet'}
                      </div>
                      <div className="flex justify-end gap-2">
                        {spec.latest_dashboard_id && (
                          <button
                            onClick={() => router.push(`/dashboards/${spec.latest_dashboard_id}`)}
                            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                          >
                            <LayoutDashboard className="h-4 w-4" />
                            Edit dashboard
                          </button>
                        )}
                        <button
                          onClick={() => router.push(`/ai-reports/${spec.id}`)}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                        >
                          <Sparkles className="h-4 w-4" />
                          Read
                        </button>
                        {canEditAgent && (
                          <button
                            onClick={() => router.push(`/ai-reports/${spec.id}/edit`)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                          >
                            <PencilLine className="h-4 w-4" />
                            Edit brief
                          </button>
                        )}
                        {canEditAgent && (
                          <button
                            onClick={() => handleDeleteReport(spec.id, spec.name, Boolean(spec.latest_dashboard_id))}
                            disabled={deleteSpecMutation.isPending}
                            className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </PageListLayout>

    </>
  );
}
