'use client';

/**
 * Observability — built on the core list layout (PageListLayout + ModuleOverview
 * + PaginatedCollection) so it matches every other module (Datasets / Govern).
 *
 * ONE surface: a paginated, searchable per-dataset HEALTH list (open incidents ·
 * monitors · consumption). Global scorecard sits in ModuleOverview + a pillar
 * strip. Opening a dataset drills into its detail (incidents / monitors / quality
 * / Lineage) via the shared Tabs component — exactly like Govern's metric detail.
 * Alert channels are managed in one modal.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ShieldCheck, AlertTriangle, ChevronRight, ChevronLeft, Search, RefreshCw, Bell, Loader2,
  Activity, GitBranch, Clock, BarChart3, LayoutDashboard, CheckCircle2, Database,
} from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useDataset } from '@/hooks/use-datasets';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { useUrlNav } from '@/hooks/use-url-nav';
import { DatasetQualityPanel } from '@/components/datasets/DatasetQualityPanel';
import { useI18n } from '@/providers/LanguageProvider';

import { MonitorsTab } from '@/components/observability/MonitorsTab';
import { IncidentsTab } from '@/components/observability/IncidentsTab';
import { LineageTab } from '@/components/observability/LineageTab';
import { AlertChannelsModal } from '@/components/observability/AlertChannelsModal';
import { fmtNumber, fmtDuration, relativeTime, PillarBadge } from '@/components/observability/ui';
import {
  getOverview, getUsage, runScan,
  type ObservabilityOverview, type UsageRow,
} from '@/lib/observability';

const DETAIL_TABS = [
  { key: 'incidents', labelKey: 'observability.detail.tab.incidents', icon: <AlertTriangle className="h-4 w-4" /> },
  { key: 'monitors', labelKey: 'observability.detail.tab.monitors', icon: <Activity className="h-4 w-4" /> },
  { key: 'quality', labelKey: 'observability.detail.tab.quality', icon: <ShieldCheck className="h-4 w-4" /> },
  { key: 'lineage', labelKey: 'observability.detail.tab.lineage', icon: <GitBranch className="h-4 w-4" /> },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

export default function ObservabilityPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">{t('observability.loading')}</div>}>
      <ObservabilityModule />
    </Suspense>
  );
}

function ObservabilityModule() {
  const nav = useUrlNav();
  const datasetParam = nav.get('dataset');
  const datasetId = datasetParam ? Number(datasetParam) : 0;

  if (datasetId) {
    return (
      <DetailShell>
        <DatasetDetail datasetId={datasetId} onBack={() => nav.set({ dataset: null, dt: null })} nav={nav} />
      </DetailShell>
    );
  }
  return <HealthList onOpen={(id) => nav.set({ dataset: String(id) })} />;
}

/** Same outer chrome (padding + scroll) as PageListLayout, for full-pane detail. */
function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col px-4 pt-6 sm:px-6 xl:px-8">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</div>
    </div>
  );
}

// ── The per-dataset health list (the whole Observability surface) ────────────
function HealthList({ onOpen }: { onOpen: (datasetId: number) => void }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    return Promise.all([getOverview(), getUsage()])
      .then(([o, u]) => { setOverview(o); setUsage(u); })
      .catch(() => { setOverview(null); setUsage([]); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const onScan = async () => {
    setScanning(true);
    try {
      const r = await runScan();
      toast.success(t('observability.toast.scanSuccess', {
        breached: r.breached ?? 0,
        folded: (r.quality_folded ?? 0) + (r.anomaly_folded ?? 0),
        alerts: r.alerts_sent ?? 0,
      }));
      await reload();
    } catch { toast.error(t('observability.toast.scanFailed')); }
    finally { setScanning(false); }
  };

  const inc = overview?.incidents;
  const openCount = (inc?.open ?? 0) + (inc?.acknowledged ?? 0);

  return (
    <>
      <PageListLayout
        title={t('module.observability.title')}
        description={t('observability.page.description')}
        overview={(
          <ModuleOverview
            stats={[
              { label: t('observability.page.stats.datasetsMonitored.label'), value: overview?.datasetsMonitored ?? 0, helper: t('observability.page.stats.datasetsMonitored.helper') },
              { label: t('observability.page.stats.openIncidents.label'), value: openCount, helper: t('observability.page.stats.openIncidents.helper') },
              { label: t('observability.page.stats.mttr30.label'), value: overview?.mttrHours != null ? fmtDuration(overview.mttrHours, t, locale) : '—', helper: t('observability.page.stats.mttr30.helper') },
              { label: t('observability.page.stats.resolved7d.label'), value: inc?.resolved7d ?? 0, helper: t('observability.page.stats.resolved7d.helper') },
            ]}
          />
        )}
        action={(
          <div className="flex items-center gap-2">
            <Button variant="secondary" leadingIcon={<Bell className="h-4 w-4" />} onClick={() => setChannelsOpen(true)}>{t('observability.action.alertChannels')}</Button>
            <Button variant="primary" leadingIcon={scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} disabled={scanning} onClick={onScan}>
              {scanning ? t('observability.action.scanning') : t('observability.action.scanNow')}
            </Button>
          </div>
        )}
        isLoading={loading}
        loadingText={t('observability.loading')}
        searchPlaceholder={t('observability.searchDataset')}
        viewToggle={false}
        toolbarExtra={(
          <FilterTag tone="danger" active={onlyIssues} onClick={() => setOnlyIssues((v) => !v)}>
            <AlertTriangle className="mr-1 h-3 w-3" /> {t('observability.filter.onlyIssues')}{openCount ? ` (${openCount})` : ''}
          </FilterTag>
        )}
      >
        {({ filterText }) => {
          const needle = filterText.trim().toLowerCase();
          const rows = usage.filter((r) =>
            (!needle || r.dataset.toLowerCase().includes(needle))
            && (!onlyIssues || r.openIncidents > 0));

          return (
            <div className="space-y-4">
              {overview && overview.pillars.length > 0 && <PillarStrip overview={overview} />}

              {usage.length === 0 ? (
                <div className="py-16 text-center">
                  <ShieldCheck className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
                  <h2 className="mb-2 text-small font-strong text-text-primary">{t('observability.empty.noDatasets.title')}</h2>
                  <p className="text-caption text-text-tertiary">{t('observability.empty.noDatasets.body')}</p>
                </div>
              ) : rows.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center text-center">
                  <Search className="mb-2 h-8 w-8 text-text-quaternary" />
                  <p className="text-caption text-text-tertiary">
                    {onlyIssues ? t('observability.empty.noIssueDatasets') : t('observability.empty.noDatasetMatches', { query: filterText })}
                  </p>
                </div>
              ) : (
                <PaginatedCollection items={rows} viewMode="list" resetKey={`${filterText}|${onlyIssues}`}>
                  {({ pageItems, pagination, hasFooter }) => (
                    <div>
                      <div className={cn('border border-[rgb(var(--border-line))] bg-surface-1', hasFooter ? 'rounded-t-xl border-b-0' : 'rounded-xl')}>
                        <div className="app-list-table-wrap">
                          <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
                            <thead className="bg-surface-2"><tr>
                              <th className="app-list-header w-[34%]">{t('observability.health.header.dataset')}</th>
                              <th className="app-list-header w-[12%]">{t('observability.health.header.openIncidents')}</th>
                              <th className="app-list-header w-[12%]">{t('observability.health.header.monitors')}</th>
                              <th className="app-list-header w-[18%]">{t('observability.health.header.usage')}</th>
                              <th className="app-list-header w-[16%]">{t('observability.health.header.refreshed')}</th>
                              <th className="app-list-header w-[64px] text-right" />
                            </tr></thead>
                            <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                              {pageItems.map((r) => (
                                <tr key={r.datasetId} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(r.datasetId)}>
                                  <td className="app-list-cell">
                                    <span className="flex w-full items-start gap-3 text-left">
                                      <span className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md', r.openIncidents > 0 ? 'bg-danger/10 text-danger' : 'bg-brand/10 text-brand')}>
                                        {r.openIncidents > 0 ? <AlertTriangle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                                      </span>
                                      <span className="min-w-0">
                                        <span className="app-list-text-main block text-caption font-emphasis text-text-primary transition-colors hover:text-brand">{r.dataset}</span>
                                        <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary">
                                          {t('observability.health.rowTables', { count: r.tables })} · {t('observability.health.rowRows', { count: fmtNumber(r.rows, locale) })}{r.unused ? ` · ${t('observability.health.rowUnused')}` : ''}
                                        </span>
                                      </span>
                                    </span>
                                  </td>
                                  <td className="app-list-cell">
                                    {r.openIncidents > 0
                                      ? <span className="inline-flex items-center gap-1 text-caption font-emphasis text-danger"><AlertTriangle className="h-3.5 w-3.5" />{r.openIncidents}</span>
                                      : <span className="inline-flex items-center gap-1 text-caption text-success"><CheckCircle2 className="h-3.5 w-3.5" />0</span>}
                                  </td>
                                  <td className="app-list-cell text-caption text-text-tertiary">{t('observability.health.monitorCount', { count: r.monitors })}</td>
                                  <td className="app-list-cell">
                                    <span className="flex items-center gap-3 text-caption text-text-tertiary">
                                      <span className="inline-flex items-center gap-1"><BarChart3 className="h-3.5 w-3.5" />{r.chartCount}</span>
                                      <span className="inline-flex items-center gap-1"><LayoutDashboard className="h-3.5 w-3.5" />{r.dashboardCount}</span>
                                    </span>
                                  </td>
                                  <td className="app-list-cell text-tiny text-text-quaternary"><Clock className="mr-1 inline h-3 w-3" />{relativeTime(r.lastRefresh, t, locale)}</td>
                                  <td className="app-list-cell-tight text-right"><ChevronRight className="inline h-4 w-4 text-text-quaternary" /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      {pagination}
                    </div>
                  )}
                </PaginatedCollection>
              )}
            </div>
          );
        }}
      </PageListLayout>

      {channelsOpen && <AlertChannelsModal onClose={() => setChannelsOpen(false)} />}
    </>
  );
}

/** Compact 5-pillar health strip shown above the list. */
function PillarStrip({ overview }: { overview: ObservabilityOverview }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-tiny font-emphasis uppercase tracking-wide text-text-quaternary">{t('observability.pillars.label')}</span>
      {overview.pillars.map((p) => (
        <span key={p.pillar} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-tiny',
          p.healthy ? 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary' : 'border-danger/40 bg-danger/5 text-danger')}>
          <PillarBadge pillar={p.pillar} />
          {p.healthy ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <span className="font-emphasis">{p.openIncidents}</span>}
        </span>
      ))}
    </div>
  );
}

// ── Per-dataset detail (incidents / monitors / quality / lineage) ────────────
function DatasetDetail({ datasetId, onBack, nav }: { datasetId: number; onBack: () => void; nav: ReturnType<typeof useUrlNav> }) {
  const { t } = useI18n();
  const { data, isLoading } = useDataset(datasetId);
  const canEdit = getResourcePermissions(data?.user_permission).canEdit;
  const tab = (nav.get('dt') as DetailTab) || 'incidents';
  const setTab = (t: string) => nav.set({ dt: t });

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-primary">
        <ChevronLeft className="h-3.5 w-3.5" /> {t('module.observability.title')}
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <Database className="h-5 w-5 text-brand" />
        <h1 className="text-h1 font-emphasis text-text-primary">{data?.name || t('observability.detail.datasetFallback')}</h1>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{t('module.observability.title')}</span>
      </div>

      <Tabs<DetailTab> variant="pill" value={tab} onChange={setTab} items={DETAIL_TABS.map((item) => ({ key: item.key, label: t(item.labelKey), icon: item.icon }))} />

      <div className="pt-1">
        {tab === 'incidents' && <IncidentsTab datasetId={datasetId} showChannels={false} />}
        {tab === 'monitors' && <MonitorsTab datasetId={datasetId} />}
        {tab === 'quality' && (
          isLoading ? <p className="py-10 text-center text-caption text-text-tertiary">{t('observability.loading')}</p>
            : data ? <DatasetQualityPanel datasetId={datasetId} tables={data.tables ?? []} canEdit={canEdit} />
            : <DetailError />
        )}
        {tab === 'lineage' && <LineageTab datasetId={datasetId} />}
      </div>
    </div>
  );
}

function DetailError() {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
      <p className="text-small font-emphasis text-text-primary">{t('observability.detail.loadFailedTitle')}</p>
      <p className="mt-1 text-caption text-text-tertiary">{t('observability.detail.loadFailedBody')}</p>
    </div>
  );
}
