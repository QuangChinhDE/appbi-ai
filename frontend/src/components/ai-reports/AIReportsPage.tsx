'use client';

import React, { useMemo, useState } from 'react';
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
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { PageListLayout } from '@/components/common/PageListLayout';
import { useAgentReportSpecs, useDeleteAgentReportSpec } from '@/hooks/use-agent-report-specs';
import { hasPermission, usePermissions } from '@/hooks/use-permissions';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { Button, IconButton } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterTag } from '@/components/ui/FilterTag';
import { useI18n } from '@/providers/LanguageProvider';

function statusBadgeVariant(status: string): 'success' | 'danger' | 'info' {
  if (status === 'ready' || status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  return 'info';
}

export default function AIReportsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [listFilters, setListFilters] = useState<{ status?: string; linkage?: string; owner?: string }>({});

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
  const activeListFilterCount = Object.values(listFilters).filter(Boolean).length;

  const toggleListFilter = (key: 'status' | 'linkage' | 'owner', value: string) => {
    setListFilters((current) => ({
      ...current,
      [key]: current[key] === value ? undefined : value,
    }));
  };

  const clearListFilters = () => setListFilters({});

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
      <div className="px-8 py-7">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-h2 font-emphasis text-text-primary">{t('aiReports.permissionTitle')}</h1>
              <p className="mt-0.5 text-caption text-text-tertiary">{t('aiReports.permissionDescription')}</p>
            </div>
          </div>
          <div className="mt-5 rounded-md border border-warning/30 bg-warning/10 p-3 text-caption text-warning">
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
              { label: t('overview.aiReports.saved'), value: savedReports.length, helper: t('overview.aiReports.savedHelper') },
              { label: t('overview.aiReports.ready'), value: reportStats.ready, helper: t('overview.aiReports.readyHelper') },
              { label: t('overview.aiReports.linked'), value: reportStats.linkedDashboards, helper: t('overview.aiReports.linkedHelper') },
            ]}
          />
        )}
        action={canEditAgent ? (
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Bot className="h-3.5 w-3.5" />}
            onClick={() => router.push('/ai-reports/new')}
          >
            {t('aiReports.new')}
          </Button>
        ) : undefined}
        isLoading={isLoading}
        loadingText={t('aiReports.loading')}
        searchPlaceholder={t('aiReports.searchPlaceholder')}
        defaultView="list"
        activeFilters={activeListFilterCount > 0 ? (
          <>
            {listFilters.status && (
              <FilterTag
                tone={statusBadgeVariant(listFilters.status)}
                active
                onClick={() => toggleListFilter('status', listFilters.status!)}
              >
                {listFilters.status}
              </FilterTag>
            )}
            {listFilters.linkage && (
              <FilterTag
                tone={listFilters.linkage === 'linked' ? 'success' : 'warning'}
                active
                onClick={() => toggleListFilter('linkage', listFilters.linkage!)}
              >
                {listFilters.linkage === 'linked' ? 'Linked dashboard' : t('common.draftOnly')}
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
          const filtered = savedReports.filter((spec) => {
            const needle = filterText.toLowerCase();
            const linkage = spec.latest_dashboard_id ? 'linked' : 'draft';
            const matchesSearch =
              spec.name.toLowerCase().includes(needle) ||
              spec.description?.toLowerCase().includes(needle) ||
              spec.status.toLowerCase().includes(needle) ||
              (spec.owner_email ?? '').toLowerCase().includes(needle);

            return (
              matchesSearch &&
              (!listFilters.status || spec.status === listFilters.status) &&
              (!listFilters.linkage || linkage === listFilters.linkage) &&
              (!listFilters.owner || spec.owner_email === listFilters.owner)
            );
          });

          return (
            <PaginatedCollection
              items={filtered}
              viewMode={viewMode}
              resetKey={JSON.stringify({ filterText, viewMode, listFilters })}
            >
              {({ pageItems, pagination }) => (
                <div className="space-y-6">
                  {savedReports.length === 0 ? (
                    <EmptyState
                      icon={<FileText />}
                      title={t('aiReports.noReportsTitle')}
                      description={t('aiReports.noReportsDescription')}
                      action={canEditAgent ? (
                        <Button
                          variant="primary"
                          size="sm"
                          leadingIcon={<Bot className="h-3.5 w-3.5" />}
                          onClick={() => router.push('/ai-reports/new')}
                        >
                          {t('aiReports.new')}
                        </Button>
                      ) : undefined}
                    />
                  ) : filtered.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                      <Search className="mb-2 h-7 w-7 text-text-quaternary" />
                      <p className="text-caption text-text-tertiary">
                        No AI reports matching &ldquo;<strong className="text-text-primary">{filterText}</strong>&rdquo;
                      </p>
                    </div>
                  ) : viewMode === 'grid' ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {pageItems.map((spec) => (
                    <div key={spec.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-small font-strong text-text-primary">{spec.name}</p>
                          <div className="mt-1 flex items-center gap-2">
                            <OwnerBadge email={spec.owner_email} />
                            <span className="text-tiny uppercase tracking-[0.14em] text-text-quaternary font-emphasis">
                              {t('aiReports.specLabel')} #{spec.id}
                            </span>
                          </div>
                        </div>
                        <Badge variant={statusBadgeVariant(spec.status)} size="sm" dot>
                          {spec.status}
                        </Badge>
                      </div>
                      {spec.description && (
                        <p className="mt-2.5 line-clamp-3 text-caption text-text-secondary">{spec.description}</p>
                      )}
                      <div className="mt-3 grid gap-2 text-caption sm:grid-cols-2">
                        <div className="rounded-md bg-surface-2 px-3 py-2">
                          <p className="text-tiny font-emphasis text-text-tertiary uppercase tracking-[0.12em]">
                            {t('aiReports.inScope')}
                          </p>
                          <p className="mt-0.5 text-text-primary font-strong">{spec.selected_tables_snapshot?.length ?? 0}</p>
                        </div>
                        <div className="rounded-md bg-surface-2 px-3 py-2">
                          <p className="text-tiny font-emphasis text-text-tertiary uppercase tracking-[0.12em]">
                            {t('aiReports.latestDashboard')}
                          </p>
                          <p className="mt-0.5 text-text-primary font-strong">
                            {spec.latest_dashboard_id ? `#${spec.latest_dashboard_id}` : t('common.draftOnly')}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-tiny text-text-tertiary">
                        <span className="inline-flex items-center gap-1">
                          <History className="h-3 w-3" />
                          {t('aiReports.savedReport')}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {spec.last_run_at ? new Date(spec.last_run_at).toLocaleDateString(locale) : t('common.notRunYet')}
                        </span>
                      </div>
                      <div className="mt-4 space-y-2">
                        {spec.latest_dashboard_id && (
                          <Button
                            variant="primary"
                            size="sm"
                            fullWidth
                            leadingIcon={<LayoutDashboard className="h-3.5 w-3.5" />}
                            onClick={() => router.push(`/dashboards/${spec.latest_dashboard_id}`)}
                          >
                            {t('aiReports.editInDashboard')}
                          </Button>
                        )}
                        <div className={`grid gap-2 ${canEditAgent ? 'grid-cols-3' : 'grid-cols-1'}`}>
                          <Button
                            variant="secondary"
                            size="sm"
                            leadingIcon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
                            onClick={() => router.push(`/ai-reports/${spec.id}`)}
                          >
                            <span className="truncate">{t('aiReports.read')}</span>
                          </Button>
                          {canEditAgent && (
                            <Button
                              variant="secondary"
                              size="sm"
                              leadingIcon={<PencilLine className="h-3.5 w-3.5 shrink-0" />}
                              onClick={() => router.push(`/ai-reports/${spec.id}/edit`)}
                            >
                              <span className="truncate">{t('aiReports.editBrief')}</span>
                            </Button>
                          )}
                          {canEditAgent && (
                            <Button
                              variant="secondary"
                              size="sm"
                              leadingIcon={<Trash2 className="h-3.5 w-3.5 shrink-0" />}
                              disabled={deleteSpecMutation.isPending}
                              onClick={() => handleDeleteReport(spec.id, spec.name, Boolean(spec.latest_dashboard_id))}
                              className="text-danger border-danger/30 hover:bg-danger/10"
                            >
                              <span className="truncate">{t('common.delete')}</span>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                      ))}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
                  <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
                    <thead className="bg-surface-2">
                      <tr>
                        <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Report
                        </th>
                        <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Tags
                        </th>
                        <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Owner
                        </th>
                        <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Tables
                        </th>
                        <th className="px-5 py-3 text-left text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Last run
                        </th>
                        <th className="px-5 py-3 text-right text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                      {pageItems.map((spec) => {
                        const linkage = spec.latest_dashboard_id ? 'linked' : 'draft';

                        return (
                          <tr key={spec.id} className="hover:bg-surface-2">
                            <td className="px-5 py-3.5">
                              <button
                                type="button"
                                onClick={() => router.push(`/ai-reports/${spec.id}`)}
                                className="min-w-0 text-left"
                              >
                                <div className="flex items-center gap-2">
                                  <p className="truncate text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{spec.name}</p>
                                  <span className="text-tiny uppercase tracking-[0.14em] text-text-quaternary font-emphasis">
                                    #{spec.id}
                                  </span>
                                </div>
                                {spec.description && <p className="mt-0.5 truncate text-tiny text-text-tertiary">{spec.description}</p>}
                              </button>
                            </td>
                            <td className="px-5 py-3.5">
                              <div className="flex flex-wrap gap-1.5">
                                <FilterTag
                                  tone={statusBadgeVariant(spec.status)}
                                  active={listFilters.status === spec.status}
                                  onClick={() => toggleListFilter('status', spec.status)}
                                >
                                  {spec.status}
                                </FilterTag>
                                <FilterTag
                                  tone={linkage === 'linked' ? 'success' : 'warning'}
                                  active={listFilters.linkage === linkage}
                                  onClick={() => toggleListFilter('linkage', linkage)}
                                >
                                  {linkage === 'linked' ? 'Linked dashboard' : t('common.draftOnly')}
                                </FilterTag>
                              </div>
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              <OwnerBadge
                                email={spec.owner_email}
                                active={listFilters.owner === spec.owner_email}
                                onClick={spec.owner_email ? () => toggleListFilter('owner', spec.owner_email!) : undefined}
                              />
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-caption text-text-tertiary">
                              {spec.selected_tables_snapshot?.length ?? 0}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-caption text-text-tertiary">
                              {spec.last_run_at ? new Date(spec.last_run_at).toLocaleDateString(locale) : t('common.notRunYet')}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1">
                                {spec.latest_dashboard_id && (
                                  <IconButton
                                    aria-label="Open linked dashboard"
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => router.push(`/dashboards/${spec.latest_dashboard_id}`)}
                                    title="Open linked dashboard"
                                    className="text-brand hover:bg-brand/10"
                                  >
                                    <LayoutDashboard className="h-3.5 w-3.5" />
                                  </IconButton>
                                )}
                                {canEditAgent && (
                                  <IconButton
                                    aria-label="Edit report brief"
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => router.push(`/ai-reports/${spec.id}/edit`)}
                                    title="Edit brief"
                                    className="text-brand hover:bg-brand/10"
                                  >
                                    <PencilLine className="h-3.5 w-3.5" />
                                  </IconButton>
                                )}
                                {canEditAgent && (
                                  <IconButton
                                    aria-label="Delete report"
                                    variant="ghost"
                                    size="xs"
                                    disabled={deleteSpecMutation.isPending}
                                    onClick={() => handleDeleteReport(spec.id, spec.name, Boolean(spec.latest_dashboard_id))}
                                    className="text-danger hover:bg-danger/10"
                                    title="Delete"
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
                  )}

                  {pagination}
                </div>
              )}
            </PaginatedCollection>
          );
        }}
      </PageListLayout>
    </>
  );
}
