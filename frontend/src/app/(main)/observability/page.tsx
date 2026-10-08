'use client';

/**
 * Observability — built on the core list layout (PageListLayout + ModuleOverview
 * + PaginatedCollection) so it matches every other module (Datasets / Govern).
 *
 * Overview  = is MONITORING itself working (scanner banner) → what needs
 *             attention now (worst open incidents across datasets) → per-dataset
 *             health list (datasets with checks, incidents or a semantic failure).
 * Detail    = Checks (automatic monitors + quality rules) / Incidents / Lineage.
 * Deep link = ?incident=<id> (what notifications send) resolves to the right
 *             dataset's Incidents tab with that incident open.
 *
 * Health is the server's `health` - never derived here from incident counts -
 * and a load that FAILED is shown as an error, never as "nothing wrong".
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, Unlink, AlertTriangle, ChevronRight, ChevronLeft, Search, RefreshCw, Bell, Loader2,
  GitBranch, Clock, BarChart3, LayoutDashboard, CheckCircle2, Database, Plus, CircleSlash, HelpCircle, Activity,
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
import { MonitorsPanel } from '@/components/observability/MonitorsPanel';
import { SemanticLineageTab } from '@/components/observability/SemanticLineageTab';
import { AlertChannelsModal } from '@/components/observability/AlertChannelsModal';
import {
  fmtNumber, fmtDuration, relativeTime, LoadErrorState, SeverityBadge, PillarBadge, StatusPill,
} from '@/components/observability/ui';
import {
  getOverview, getUsage, runScan, getScannerStatus, getObservabilityMe, getIncident, loadErrorOf, apiErrorMessage,
  NEEDS_ATTENTION,
  type HealthState, type LoadError, type ObservabilityMe, type ObservabilityOverview, type ScannerStatus, type UsageRow,
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
  const datasetId = Number(nav.get('dataset') || 0);
  const incidentParam = Number(nav.get('incident') || 0);

  // ?incident=<id> without a dataset: resolve it to its dataset, then replace
  // the URL (so Back does not bounce through the resolver).
  if (incidentParam && !datasetId) return <IncidentResolver incidentId={incidentParam} nav={nav} />;
  if (datasetId) {
    return <DatasetDetail datasetId={datasetId} onBack={() => nav.set({ dataset: null, dt: null, incident: null }, { push: true })} nav={nav} />;
  }
  return <HealthList onOpen={(id) => nav.set({ dataset: String(id) }, { push: true })} onOpenIncident={(ds, inc) => nav.set({ dataset: String(ds), dt: 'incidents', incident: String(inc) }, { push: true })} />;
}

function IncidentResolver({ incidentId, nav }: { incidentId: number; nav: ReturnType<typeof useUrlNav> }) {
  const { t } = useI18n();
  const [error, setError] = useState<LoadError | null>(null);
  useEffect(() => {
    let live = true;
    getIncident(incidentId)
      .then((inc) => { if (live) nav.set({ dataset: String(inc.datasetId), dt: 'incidents', incident: String(inc.id) }, undefined); })
      .catch((e) => { if (live) setError(loadErrorOf(e)); });
    return () => { live = false; };
  }, [incidentId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!error) return <p className="px-8 py-10 text-caption text-text-tertiary" role="status">{t('observability.incidents.opening')}</p>;
  return (
    <div className="mx-auto max-w-xl px-4 py-10" data-testid="obs-incident-link-error">
      <LoadErrorState error={error} />
      <div className="mt-4 text-center">
        <Button variant="secondary" onClick={() => nav.set({ incident: null }, undefined)}>{t('observability.action.backToOverview')}</Button>
      </div>
    </div>
  );
}

const isAttention = (h?: HealthState) => !!h && NEEDS_ATTENTION.includes(h);

// ── Overview: scanner health, needs attention, per-dataset health list ───────
function HealthList({ onOpen, onOpenIncident }: { onOpen: (datasetId: number) => void; onOpenIncident: (datasetId: number, incidentId: number) => void }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [me, setMe] = useState<ObservabilityMe | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    // Overview + usage are the page: if either fails the page is an error.
    // Scanner status / capabilities are secondary and degrade on their own.
    getScannerStatus().then(setStatus).catch(() => setStatus(null));
    getObservabilityMe().then(setMe).catch(() => setMe(null));
    return Promise.all([getOverview(), getUsage()])
      .then(([o, u]) => { setOverview(o); setUsage(u); })
      .catch((e) => { setOverview(null); setUsage(null); setError(loadErrorOf(e)); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const onScan = async () => {
    setScanning(true);
    try {
      const r = await runScan();
      if (r.status === 'partial') toast.warning(t('observability.toast.scanPartial', { errors: r.errors?.length ?? 0 }));
      else toast.success(t('observability.toast.scanSuccess', { breached: r.breached ?? 0, folded: r.new_incidents ?? 0, alerts: r.alerts_sent ?? 0 }));
    } catch (e: any) {
      toast.error(e?.response?.status === 409 ? t('observability.toast.scanBusy') : (apiErrorMessage(e) ?? t('observability.toast.scanFailed')));
    } finally { setScanning(false); await reload(); }
  };

  const inc = overview?.incidents;
  const openCount = (inc?.open ?? 0) + (inc?.acknowledged ?? 0);
  const observed = useMemo(() => (usage ?? []).filter((r) => r.observed), [usage]);
  const candidates = useMemo(() => (usage ?? []).filter((r) => !r.observed && r.capabilities?.configure), [usage]);
  const attentionCount = useMemo(() => observed.filter((r) => isAttention(r.health)).length, [observed]);

  return (
    <>
      <PageListLayout
        title={t('module.observability.title')}
        description={t('observability.page.description')}
        overview={error ? undefined : (
          <div className="space-y-3">
            <ScannerBanner status={status} />
            <ModuleOverview
              stats={[
                { label: t('observability.page.stats.datasetsMonitored.label'), value: observed.length, helper: t('observability.page.stats.datasetsMonitored.helper') },
                { label: t('observability.page.stats.needsAttention.label'), value: attentionCount, helper: t('observability.page.stats.needsAttention.helper') },
                { label: t('observability.page.stats.openIncidents.label'), value: openCount, helper: t('observability.page.stats.openIncidents.helper') },
                { label: t('observability.page.stats.mttr30.label'), value: overview?.mttrHours != null ? fmtDuration(overview.mttrHours, t, locale) : '—', helper: t('observability.page.stats.mttr30.helper') },
              ]}
            />
            {overview && overview.recentIncidents.length > 0 && (
              <NeedsAttention incidents={overview.recentIncidents} total={openCount} onOpen={onOpenIncident} />
            )}
          </div>
        )}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" leadingIcon={<Bell className="h-4 w-4" />} onClick={() => setChannelsOpen(true)}>{t('observability.action.alertChannels')}</Button>
            {candidates.length > 0 && (
              <Button variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setSetupOpen(true)}>{t('observability.action.setupDataset')}</Button>
            )}
            {me?.canScanAll && (
              <Button variant="primary" leadingIcon={scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} disabled={scanning} onClick={onScan} data-testid="obs-scan-all">
                {scanning ? t('observability.action.scanning') : t('observability.action.scanNow')}
              </Button>
            )}
          </div>
        )}
        isLoading={loading && !usage}
        loadingText={t('observability.loading')}
        searchPlaceholder={t('observability.searchDataset')}
        viewToggle={false}
        toolbarExtra={error ? undefined : (
          <FilterTag tone="danger" active={onlyIssues} onClick={() => setOnlyIssues((v) => !v)}>
            <AlertTriangle className="mr-1 h-3 w-3" aria-hidden /> {t('observability.filter.needsAttention')}{attentionCount ? ` (${attentionCount})` : ''}
          </FilterTag>
        )}
      >
        {({ filterText }) => {
          if (error) return <LoadErrorState error={error} onRetry={reload} testId="obs-overview-error" />;
          const needle = filterText.trim().toLowerCase();
          const rows = observed.filter((r) =>
            (!needle || r.dataset.toLowerCase().includes(needle))
            && (!onlyIssues || isAttention(r.health)));

          if (observed.length === 0) {
            return (
              <div className="py-16 text-center" data-testid="obs-empty">
                <ShieldCheck className="mx-auto mb-4 h-14 w-14 text-text-quaternary" aria-hidden />
                <h2 className="mb-2 text-small font-strong text-text-primary">{t('observability.monitors.empty.title')}</h2>
                <p className="mb-6 text-caption text-text-tertiary">{t('observability.monitors.empty.body')}</p>
                {candidates.length > 0 && (
                  <Button variant="primary" size="lg" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setSetupOpen(true)}>{t('observability.action.setupDataset')}</Button>
                )}
              </div>
            );
          }
          if (rows.length === 0) {
            return (
              <div className="flex h-48 flex-col items-center justify-center text-center">
                <Search className="mb-2 h-8 w-8 text-text-quaternary" aria-hidden />
                <p className="text-caption text-text-tertiary">
                  {onlyIssues && !needle ? t('observability.empty.noIssueDatasets') : t('observability.empty.noDatasetMatches', { query: filterText })}
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
                          <th className="app-list-header w-[32%]">{t('observability.health.header.dataset')}</th>
                          <th className="app-list-header w-[18%]">{t('observability.health.header.status')}</th>
                          <th className="app-list-header w-[16%]">{t('observability.health.header.checks')}</th>
                          <th className="app-list-header w-[12%]">{t('observability.health.header.usage')}</th>
                          <th className="app-list-header w-[16%]">{t('observability.health.header.checked')}</th>
                          <th className="app-list-header w-[48px] text-right"><span className="sr-only">{t('observability.action.open')}</span></th>
                        </tr></thead>
                        <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                          {pageItems.map((r) => (
                            <tr key={r.datasetId} className="cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2" onClick={() => onOpen(r.datasetId)}>
                              <td className="app-list-cell">
                                <span className="flex w-full items-start gap-3 text-left">
                                  <HealthIcon row={r} />
                                  <span className="min-w-0">
                                    <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(r.datasetId); }}
                                      className="app-list-text-main block rounded text-left text-caption font-emphasis text-text-primary transition-colors hover:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                                      {r.dataset}
                                    </button>
                                    <span className="app-list-text-sub mt-0.5 block text-tiny text-text-quaternary">
                                      {t('observability.health.rowTables', { count: r.tables })} · {t('observability.health.rowRows', { count: fmtNumber(r.rows, locale) })}
                                    </span>
                                  </span>
                                </span>
                              </td>
                              <td className="app-list-cell"><HealthLabel row={r} /></td>
                              <td className="app-list-cell"><CheckSummary row={r} /></td>
                              <td className="app-list-cell">
                                <span className="flex items-center gap-3 text-caption text-text-tertiary">
                                  <span className="inline-flex items-center gap-1" title={t('observability.health.charts')}><BarChart3 className="h-3.5 w-3.5" aria-hidden />{r.chartCount}</span>
                                  <span className="inline-flex items-center gap-1" title={t('observability.health.dashboards')}><LayoutDashboard className="h-3.5 w-3.5" aria-hidden />{r.dashboardCount}</span>
                                </span>
                              </td>
                              <td className="app-list-cell text-tiny text-text-quaternary">
                                <Clock className="mr-1 inline h-3 w-3" aria-hidden />{r.lastCheckedAt ? relativeTime(r.lastCheckedAt, t, locale) : t('observability.health.neverChecked')}
                              </td>
                              <td className="app-list-cell-tight text-right"><ChevronRight className="inline h-4 w-4 text-text-quaternary" aria-hidden /></td>
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

const HEALTH_TONE: Record<HealthState, string> = {
  semantic_invalid: 'bg-danger/10 text-danger', breached: 'bg-danger/10 text-danger', error: 'bg-warning/10 text-warning',
  unknown: 'bg-surface-2 text-text-tertiary', not_monitored: 'bg-surface-2 text-text-tertiary', healthy: 'bg-success/10 text-success',
};

function HealthIcon({ row }: { row: UsageRow }) {
  const { t } = useI18n();
  const h: HealthState = row.health ?? 'unknown';
  const Icon = h === 'semantic_invalid' ? Unlink : h === 'breached' ? AlertTriangle : h === 'error' ? CircleSlash
    : h === 'healthy' ? ShieldCheck : HelpCircle;
  return (
    <span data-testid={`obs-health-${row.datasetId}`} data-health={h}
      title={[t(`observability.health.state.${h}`), ...(h === 'semantic_invalid' ? (row.semantic?.reasons ?? []) : [])].join('\n')}
      className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md', HEALTH_TONE[h])}>
      <Icon className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t(`observability.health.state.${h}`)}</span>
    </span>
  );
}

function HealthLabel({ row }: { row: UsageRow }) {
  const { t } = useI18n();
  const h: HealthState = row.health ?? 'unknown';
  return (
    <span className="flex flex-col gap-0.5" data-testid={`obs-health-label-${row.datasetId}`}>
      <span className={cn('inline-flex w-fit items-center rounded-full px-2 py-0.5 text-tiny font-emphasis', HEALTH_TONE[h])}>{t(`observability.health.state.${h}`)}</span>
      {row.openIncidents > 0 && <span className="text-tiny text-danger">{t('observability.health.openIncidents', { count: row.openIncidents })}</span>}
      {h === 'semantic_invalid' && <span className="text-tiny text-danger">{t('observability.health.semanticInvalid', { count: row.semantic?.failed ?? 1 })}</span>}
    </span>
  );
}

function CheckSummary({ row }: { row: UsageRow }) {
  const { t } = useI18n();
  const c = row.checks;
  if (!c || c.active === 0) return <span className="text-caption text-text-quaternary">{t('observability.health.noActiveChecks')}</span>;
  return (
    <span className="flex flex-col gap-0.5 text-tiny" data-testid={`obs-checks-${row.datasetId}`}>
      <span className="text-caption text-text-secondary">{t('observability.health.checksPassing', { passing: c.passing, active: c.active })}</span>
      <span className="flex flex-wrap gap-x-2">
        {c.failing > 0 && <span className="text-danger">{t('observability.health.checksFailing', { count: c.failing })}</span>}
        {c.errored > 0 && <span className="text-warning">{t('observability.health.checksErrored', { count: c.errored })}</span>}
        {c.notRun > 0 && <span className="text-text-tertiary">{t('observability.health.checksNotRun', { count: c.notRun })}</span>}
      </span>
    </span>
  );
}

/** Is the monitoring itself working? Silent when it is. */
function ScannerBanner({ status }: { status: ScannerStatus | null }) {
  const { t, locale } = useI18n();
  if (!status) return null;
  const last = status.lastScan;
  const problems: { tone: 'danger' | 'warning'; text: string }[] = [];
  if (last?.status === 'failed') problems.push({ tone: 'danger', text: t('observability.scanner.failed', { time: relativeTime(last.startedAt, t, locale) }) });
  else if (last?.status === 'partial') problems.push({ tone: 'warning', text: t('observability.scanner.partial', { time: relativeTime(last.startedAt, t, locale), errors: (last.counts?.monitor_errors ?? 0) || last.errors.length }) });
  if (status.stale) {
    problems.push({ tone: 'warning', text: status.lastSuccessfulScan
      ? t('observability.scanner.stale', { time: relativeTime(status.lastSuccessfulScan.finishedAt ?? status.lastSuccessfulScan.startedAt, t, locale), hours: status.staleAfterHours })
      : t('observability.scanner.never') });
  }
  if (status.deliveries.dead > 0 || status.deliveries.failed > 0) {
    problems.push({ tone: 'danger', text: t('observability.scanner.deliveries', { failed: status.deliveries.failed, dead: status.deliveries.dead }) });
  }
  if (!problems.length) {
    return (
      <p className="flex items-center gap-1.5 text-tiny text-text-tertiary" data-testid="obs-scanner-ok">
        <Activity className="h-3.5 w-3.5" aria-hidden />
        {t('observability.scanner.ok', { time: relativeTime(last?.finishedAt ?? last?.startedAt, t, locale) })}
        {status.running && <> · {t('observability.scanner.running')}</>}
      </p>
    );
  }
  return (
    <div role="status" data-testid="obs-scanner-banner" className="space-y-1">
      {problems.map((p, i) => (
        <p key={i} className={cn('flex items-start gap-1.5 rounded-lg px-3 py-2 text-caption',
          p.tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />{p.text}
        </p>
      ))}
    </div>
  );
}

function NeedsAttention({ incidents, total, onOpen }: { incidents: ObservabilityOverview['recentIncidents']; total: number; onOpen: (datasetId: number, incidentId: number) => void }) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="obs-needs-attention" className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1" data-testid="obs-needs-attention">
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-2">
        <h2 id="obs-needs-attention" className="text-caption font-strong text-text-primary">{t('observability.attention.title')}</h2>
        {total > incidents.length && <span className="text-tiny text-text-tertiary">{t('observability.attention.more', { shown: incidents.length, total })}</span>}
      </div>
      <ul className="divide-y divide-[rgb(var(--border-line))]">
        {incidents.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => onOpen(i.datasetId, i.id)} data-testid={`obs-attention-${i.id}`}
              className="flex w-full flex-col gap-1 px-4 py-2 text-left hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:flex-row sm:items-center sm:gap-3">
              <span className="flex flex-shrink-0 items-center gap-1.5"><SeverityBadge severity={i.severity} /><StatusPill status={i.status} /></span>
              <span className="min-w-0 flex-1 truncate text-caption text-text-primary">{i.title}</span>
              <span className="flex flex-shrink-0 items-center gap-2 text-tiny text-text-quaternary">
                <PillarBadge pillar={i.pillar} />
                <span className="inline-flex items-center gap-1"><Database className="h-3 w-3" aria-hidden />{i.dataset ?? `#${i.datasetId}`}</span>
                <span>{relativeTime(i.lastSeenAt, t, locale)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Set-up picker: datasets not yet observed that the user may configure ─────
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
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('observability.setup.search')} aria-label={t('observability.setup.search')} leadingIcon={<Search />} />
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-caption text-text-quaternary">{t('observability.setup.allObserved')}</p>
        ) : (
          <ul className="max-h-80 divide-y divide-[rgb(var(--border-line))] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))]">
            {filtered.map((c) => (
              <li key={c.datasetId}>
                <button onClick={() => onPick(c.datasetId)} className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
                  <span className="flex items-center gap-1.5 text-caption text-text-secondary"><Database className="h-3.5 w-3.5 text-text-quaternary" aria-hidden />{c.dataset}</span>
                  <ChevronRight className="h-4 w-4 text-text-quaternary" aria-hidden />
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
  const { data, isLoading, error } = useDataset(datasetId);
  const canEdit = getResourcePermissions(data?.user_permission, data?.capabilities).canEdit;
  const tab = (nav.get('dt') as DetailTab) || 'quality';
  const focusIncident = Number(nav.get('incident') || 0) || null;
  const setTab = (next: string) => nav.set({ dt: next, incident: next === 'incidents' ? nav.get('incident') : null }, { push: true });
  const loadError: LoadError | null = error ? loadErrorOf(error) : null;
  const [version, setVersion] = useState(0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-1.5">
        <button onClick={onBack} className="flex items-center gap-1 rounded text-sm text-text-tertiary transition-colors hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <ChevronLeft className="h-4 w-4" aria-hidden />{t('module.observability.title')}
        </button>
        <span className="text-text-quaternary" aria-hidden>/</span>
        <span className="max-w-[220px] truncate text-sm font-medium text-text-primary">{data?.name || t('observability.detail.datasetFallback')}</span>
        <div className="mx-1 hidden h-5 w-px bg-surface-3 sm:block" />
        <Tabs<DetailTab> variant="pill" size="sm" value={tab} onChange={setTab} items={DETAIL_TABS.map((item) => ({ key: item.key, label: t(item.labelKey), icon: item.icon }))} />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-surface-2">
        {loadError ? (
          <ScrollArea><LoadErrorState error={loadError} testId="obs-dataset-error" /></ScrollArea>
        ) : (
          <>
            {tab === 'quality' && (
              <ScrollArea>
                <div className="space-y-4">
                  <MonitorsPanel key={`m${version}`} datasetId={datasetId} onChanged={() => setVersion((v) => v + 1)} />
                  {isLoading ? <p className="py-10 text-center text-caption text-text-tertiary" role="status">{t('observability.loading')}</p>
                    : data ? <DatasetQualityPanel datasetId={datasetId} tables={data.tables ?? []} canEdit={canEdit} />
                    : null}
                </div>
              </ScrollArea>
            )}
            {tab === 'incidents' && <ScrollArea><IncidentsTab key={`i${datasetId}`} datasetId={datasetId} showChannels={false} focusIncidentId={focusIncident} /></ScrollArea>}
            {tab === 'lineage' && <ScrollArea><SemanticLineageTab datasetId={datasetId} /></ScrollArea>}
          </>
        )}
      </div>
    </div>
  );
}

function ScrollArea({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto px-4 py-5 sm:px-6 xl:px-8 [scrollbar-gutter:stable]">{children}</div>;
}
