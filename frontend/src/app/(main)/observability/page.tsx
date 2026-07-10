'use client';

/**
 * Observability — built on the core list layout (PageListLayout + ModuleOverview
 * + PaginatedCollection) so it matches every other module (Datasets / Govern).
 *
 * List = per-dataset HEALTH list, but ONLY datasets actually being observed
 * (have a monitor / quality rule / open incident). A "Set up dataset" picker
 * adds the rest. Opening a dataset drills into a compact detail (Checks /
 * Incidents / Lineage) — the header mirrors the Dataset module's one-line bar.
 * "Checks" merges auto-monitors (table-level) and quality rules (column-level),
 * since both are just checks that can fail and open an incident.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, AlertTriangle, ChevronRight, ChevronLeft, Search, RefreshCw, Bell, Loader2,
  GitBranch, Clock, BarChart3, LayoutDashboard, CheckCircle2, Database, Plus,
} from 'lucide-react';

import { PageListLayout } from '@/components/common/PageListLayout';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PaginatedCollection } from '@/components/common/PaginatedCollection';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { FilterTag } from '@/components/ui/FilterTag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useDataset } from '@/hooks/use-datasets';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { useUrlNav } from '@/hooks/use-url-nav';
import { DatasetQualityPanel } from '@/components/datasets/DatasetQualityPanel';
import { useI18n } from '@/providers/LanguageProvider';

import { IncidentsTab } from '@/components/observability/IncidentsTab';
import { SemanticLineageTab } from '@/components/observability/SemanticLineageTab';
import { AlertChannelsModal } from '@/components/observability/AlertChannelsModal';
import { fmtNumber, fmtDuration, relativeTime } from '@/components/observability/ui';
import {
  getOverview, getUsage, runScan,
  type ObservabilityOverview, type UsageRow,
} from '@/lib/observability';

const DETAIL_TABS = [
  { key: 'quality', labelKey: 'observability.detail.tab.quality', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  { key: 'incidents', labelKey: 'observability.detail.tab.incidents', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  { key: 'lineage', labelKey: 'observability.detail.tab.lineage', icon: <GitBranch className="h-3.5 w-3.5" /> },
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
    return <DatasetDetail datasetId={datasetId} onBack={() => nav.set({ dataset: null, dt: null })} nav={nav} />;
  }
  return <HealthList onOpen={(id) => nav.set({ dataset: String(id) })} />;
}

// ── The per-dataset health list (only observed datasets) ─────────────────────
function HealthList({ onOpen }: { onOpen: (datasetId: number) => void }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

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
  // Only datasets actually being observed appear in the list; the rest are
  // offered in the "Set up dataset" picker.
  const observed = useMemo(() => usage.filter((r) => r.observed), [usage]);
  const candidates = useMemo(() => usage.filter((r) => !r.observed), [usage]);

  return (
    <>
      <PageListLayout
        title={t('module.observability.title')}
        description={t('observability.page.description')}
        overview={(
          <ModuleOverview
            stats={[
              { label: t('observability.page.stats.datasetsMonitored.label'), value: observed.length, helper: t('observability.page.stats.datasetsMonitored.helper') },
              { label: t('observability.page.stats.openIncidents.label'), value: openCount, helper: t('observability.page.stats.openIncidents.helper') },
              { label: t('observability.page.stats.mttr30.label'), value: overview?.mttrHours != null ? fmtDuration(overview.mttrHours, t, locale) : '—', helper: t('observability.page.stats.mttr30.helper') },
              { label: t('observability.page.stats.resolved7d.label'), value: inc?.resolved7d ?? 0, helper: t('observability.page.stats.resolved7d.helper') },
            ]}
          />
        )}
        action={(
          <div className="flex items-center gap-2">
            <Button variant="secondary" leadingIcon={<Bell className="h-4 w-4" />} onClick={() => setChannelsOpen(true)}>{t('observability.action.alertChannels')}</Button>
            <Button variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} disabled={!candidates.length} onClick={() => setSetupOpen(true)}>{t('observability.action.setupDataset')}</Button>
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
          const rows = observed.filter((r) =>
            (!needle || r.dataset.toLowerCase().includes(needle))
            && (!onlyIssues || r.openIncidents > 0));

          if (observed.length === 0) {
            return (
              <div className="py-16 text-center">
                <ShieldCheck className="mx-auto mb-4 h-14 w-14 text-text-quaternary" />
                <h2 className="mb-2 text-small font-strong text-text-primary">{t('observability.monitors.empty.title')}</h2>
                <p className="mb-6 text-caption text-text-tertiary">{t('observability.monitors.empty.body')}</p>
                <Button variant="primary" size="lg" leadingIcon={<Plus className="h-4 w-4" />} disabled={!candidates.length} onClick={() => setSetupOpen(true)}>{t('observability.action.setupDataset')}</Button>
              </div>
            );
          }
          if (rows.length === 0) {
            return (
              <div className="flex h-48 flex-col items-center justify-center text-center">
                <Search className="mb-2 h-8 w-8 text-text-quaternary" />
                <p className="text-caption text-text-tertiary">
                  {onlyIssues ? t('observability.empty.noIssueDatasets') : t('observability.empty.noDatasetMatches', { query: filterText })}
                </p>
              </div>
            );
          }

          return (
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
                                      {t('observability.health.rowTables', { count: r.tables })} · {t('observability.health.rowRows', { count: fmtNumber(r.rows, locale) })}
                                    </span>
                                  </span>
                                </span>
                              </td>
                              <td className="app-list-cell">
                                {r.openIncidents > 0
                                  ? <span className="inline-flex items-center gap-1 text-caption font-emphasis text-danger"><AlertTriangle className="h-3.5 w-3.5" />{r.openIncidents}</span>
                                  : <span className="inline-flex items-center gap-1 text-caption text-success"><CheckCircle2 className="h-3.5 w-3.5" />0</span>}
                              </td>
                              <td className="app-list-cell text-caption text-text-tertiary">{t('observability.health.monitorCount', { count: r.monitors + r.qualityRules })}</td>
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
          );
        }}
      </PageListLayout>

      {channelsOpen && <AlertChannelsModal onClose={() => setChannelsOpen(false)} />}
      {setupOpen && <SetupPickerModal candidates={candidates} onClose={() => setSetupOpen(false)} onPick={(id) => { setSetupOpen(false); onOpen(id); }} />}
    </>
  );
}

// ── Set-up picker: datasets not yet observed → open detail to add checks ─────
function SetupPickerModal({ candidates, onClose, onPick }: { candidates: UsageRow[]; onClose: () => void; onPick: (datasetId: number) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return candidates.filter((c) => !n || c.dataset.toLowerCase().includes(n));
  }, [candidates, q]);
  return (
    <Modal isOpen onClose={onClose} title={t('observability.setup.title')} size="md" footer={<Button variant="ghost" onClick={onClose}>{t('observability.action.close')}</Button>}>
      <div className="space-y-3">
        <p className="text-caption text-text-tertiary">{t('observability.setup.body')}</p>
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('observability.setup.search')} leadingIcon={<Search />} />
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-caption text-text-quaternary">{t('observability.setup.allObserved')}</p>
        ) : (
          <ul className="max-h-80 divide-y divide-[rgb(var(--border-line))] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))]">
            {filtered.map((c) => (
              <li key={c.datasetId}>
                <button onClick={() => onPick(c.datasetId)} className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-surface-2">
                  <span className="flex items-center gap-1.5 text-caption text-text-secondary"><Database className="h-3.5 w-3.5 text-text-quaternary" />{c.dataset}</span>
                  <ChevronRight className="h-4 w-4 text-text-quaternary" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── Per-dataset detail — compact one-line header like the Dataset module ─────
function DatasetDetail({ datasetId, onBack, nav }: { datasetId: number; onBack: () => void; nav: ReturnType<typeof useUrlNav> }) {
  const { t } = useI18n();
  const { data, isLoading } = useDataset(datasetId);
  const canEdit = getResourcePermissions(data?.user_permission).canEdit;
  const tab = (nav.get('dt') as DetailTab) || 'quality';
  const setTab = (next: string) => nav.set({ dt: next });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* One-line compact header — mirrors datasets/[id] */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-text-tertiary transition-colors hover:text-text-primary">
          <ChevronLeft className="h-4 w-4" />{t('module.observability.title')}
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[220px] truncate text-sm font-medium text-text-primary">{data?.name || t('observability.detail.datasetFallback')}</span>
        <div className="mx-1 h-5 w-px bg-surface-3" />
        <Tabs<DetailTab> variant="pill" size="sm" value={tab} onChange={setTab} items={DETAIL_TABS.map((item) => ({ key: item.key, label: t(item.labelKey), icon: item.icon }))} />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface-2">
        {tab === 'quality' && (
          isLoading ? <ScrollArea><p className="py-10 text-center text-caption text-text-tertiary">{t('observability.loading')}</p></ScrollArea>
            : data ? <DatasetQualityPanel datasetId={datasetId} tables={data.tables ?? []} canEdit={canEdit} />
            : <ScrollArea><DetailError /></ScrollArea>
        )}
        {tab === 'incidents' && <ScrollArea><IncidentsTab datasetId={datasetId} showChannels={false} /></ScrollArea>}
        {tab === 'lineage' && <ScrollArea><SemanticLineageTab datasetId={datasetId} /></ScrollArea>}
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

function ScrollArea({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto px-4 py-5 sm:px-6 xl:px-8 [scrollbar-gutter:stable]">{children}</div>;
}
