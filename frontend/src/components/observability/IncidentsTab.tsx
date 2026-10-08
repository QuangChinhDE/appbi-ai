'use client';

/**
 * Incidents tab — the ONE feed for breaches from every detector (quality ·
 * anomaly · freshness · volume · schema · semantic). Lifecycle: open →
 * acknowledged → resolved, plus an explicit "accept as the new baseline" for
 * schema / volume changes. Paged by the server; a failed load is an error,
 * never "no incidents". Actions appear only when the server's `capabilities`
 * say the caller may take them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, RotateCcw, CheckCircle2, ChevronDown, ChevronRight, Bell, Search, ShieldCheck, ChevronLeft,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FilterTag } from '@/components/ui/FilterTag';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { SeverityBadge, StatusPill, PillarBadge, relativeTime, fmtDuration, LoadErrorState } from './ui';
import { AlertChannelsModal } from './AlertChannelsModal';
import {
  listIncidents, getIncident, updateIncident, loadErrorOf, apiErrorMessage,
  type Incident, type IncidentAction, type LoadError, type Pillar, type Severity,
} from '@/lib/observability';

const PILLARS: Pillar[] = ['freshness', 'volume', 'schema', 'distribution', 'quality', 'semantic'];
const PAGE = 25;

export function IncidentsTab({ datasetId, showChannels = true, focusIncidentId, onChanged }: {
  datasetId?: number; showChannels?: boolean; focusIncidentId?: number | null; onChanged?: () => void;
} = {}) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [showResolved, setShowResolved] = useState(!!focusIncidentId);
  const [pillar, setPillar] = useState<Pillar | null>(null);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set(focusIncidentId ? [focusIncidentId] : []));
  const [busyId, setBusyId] = useState<number | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState<Incident | null>(null);
  const [focused, setFocused] = useState<Incident | null>(null);
  const [focusError, setFocusError] = useState<LoadError | null>(null);
  const seq = useRef(0);
  const focusRef = useRef<HTMLLIElement | null>(null);

  // debounce the search box
  useEffect(() => { const h = setTimeout(() => { setQ(query.trim()); setOffset(0); }, 300); return () => clearTimeout(h); }, [query]);
  // a different dataset / filter starts at page 1
  useEffect(() => { setOffset(0); }, [datasetId, showResolved, pillar, severity]);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    return listIncidents({
      status: showResolved ? undefined : 'open',
      pillar: pillar ?? undefined, severity: severity ?? undefined, datasetId, q, limit: PAGE, offset,
    }).then((page) => {
      if (mine !== seq.current) return;           // a newer request superseded this one
      setItems(page.items); setTotal(page.total);
    }).catch((e) => {
      if (mine !== seq.current) return;
      setItems([]); setTotal(0); setError(loadErrorOf(e));
    }).finally(() => { if (mine === seq.current) setLoading(false); });
  }, [showResolved, pillar, severity, datasetId, q, offset]);
  useEffect(() => { reload(); }, [reload]);

  // Deep link: the incident a notification pointed at is shown even when it is
  // not on the current page (or no longer open).
  useEffect(() => {
    if (!focusIncidentId) { setFocused(null); setFocusError(null); return; }
    let live = true;
    getIncident(focusIncidentId)
      .then((inc) => { if (live) { setFocused(inc); setFocusError(null); setExpanded((s) => new Set(s).add(inc.id)); } })
      .catch((e) => { if (live) { setFocused(null); setFocusError(loadErrorOf(e)); } });
    return () => { live = false; };
  }, [focusIncidentId]);
  useEffect(() => {
    if (focused && !loading) focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused, loading]);

  const rows = useMemo(() => {
    if (!focused) return items;
    return [focused, ...items.filter((i) => i.id !== focused.id)];
  }, [items, focused]);

  const act = async (inc: Incident, action: IncidentAction) => {
    setBusyId(inc.id);
    try {
      const next = await updateIncident(inc.id, action);
      if (focused?.id === inc.id) setFocused(next);
      toast.success(t(`observability.incidents.toast.${action}`));
      await reload();
      onChanged?.();
    } catch (e) {
      toast.error(apiErrorMessage(e) ?? t('observability.incidents.toast.updateFailed'));
    } finally { setBusyId(null); }
  };

  const toggleExpand = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div className="space-y-4" data-testid="obs-incidents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-text-tertiary">{t('observability.incidents.intro')}</p>
        {showChannels && <Button variant="secondary" size="sm" leadingIcon={<Bell className="h-4 w-4" />} onClick={() => setChannelsOpen(true)}>{t('observability.action.alertChannels')}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <Input size="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('observability.incidents.search')}
            aria-label={t('observability.incidents.search')} leadingIcon={<Search />} />
        </div>
        <FilterTag tone="neutral" active={!showResolved} onClick={() => setShowResolved(false)}>{t('observability.incidents.filter.open')}</FilterTag>
        <FilterTag tone="neutral" active={showResolved} onClick={() => setShowResolved(true)}>{t('observability.incidents.filter.all')}</FilterTag>
        <span className="mx-1 hidden h-4 w-px bg-[rgb(var(--border-line))] sm:block" />
        {(['critical', 'warning', 'info'] as Severity[]).map((s) => (
          <FilterTag key={s} tone={s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'info'} active={severity === s} onClick={() => setSeverity(severity === s ? null : s)}>
            {t(`observability.severity.${s}`)}
          </FilterTag>
        ))}
        <span className="mx-1 hidden h-4 w-px bg-[rgb(var(--border-line))] sm:block" />
        {PILLARS.map((p) => (
          <FilterTag key={p} tone="neutral" active={pillar === p} onClick={() => setPillar(pillar === p ? null : p)}>{t(`observability.pillar.${p}`)}</FilterTag>
        ))}
      </div>

      {focusError && <LoadErrorState error={focusError} compact testId="obs-incident-focus-error" />}

      {loading && rows.length === 0 ? (
        <p className="py-10 text-center text-caption text-text-tertiary" role="status">{t('observability.loading')}</p>
      ) : error ? (
        <LoadErrorState error={error} onRetry={reload} testId="obs-incidents-error" />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center" data-testid="obs-incidents-empty">
          <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-text-quaternary" aria-hidden />
          <h3 className="mb-1 text-small font-strong text-text-primary">
            {q || pillar || severity ? t('observability.incidents.empty.filtered')
              : showResolved ? t('observability.incidents.empty.allTitle') : t('observability.incidents.empty.openTitle')}
          </h3>
          {/* "No incidents" is not "healthy": incidents only exist for checks that ran. */}
          <p className="text-caption text-text-tertiary">{t('observability.incidents.empty.body')}</p>
        </div>
      ) : (
        <div className={cn('overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1', loading && 'opacity-70')} aria-busy={loading}>
          <ul className="divide-y divide-[rgb(var(--border-line))]">
            {rows.map((inc) => {
              const isOpen = expanded.has(inc.id);
              const resolved = inc.status === 'resolved';
              const canAct = !!inc.capabilities?.act;
              const isFocus = focused?.id === inc.id;
              return (
                <li key={inc.id} ref={isFocus ? focusRef : undefined} data-testid={`obs-incident-${inc.id}`} data-status={inc.status}
                  className={cn(isFocus && 'ring-2 ring-inset ring-brand')}>
                  <div className={cn('flex flex-col gap-2 px-4 py-3 hover:bg-surface-2 sm:flex-row sm:items-start sm:gap-3', resolved && 'opacity-70')}>
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <button onClick={() => toggleExpand(inc.id)} className="mt-0.5 rounded text-text-quaternary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        aria-expanded={isOpen} aria-controls={`obs-incident-detail-${inc.id}`}
                        aria-label={t(isOpen ? 'observability.incidents.collapse' : 'observability.incidents.expand', { title: inc.title })}>
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                      <span className={cn('mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
                        inc.severity === 'critical' ? 'bg-danger/10 text-danger' : inc.severity === 'warning' ? 'bg-warning/10 text-warning' : 'bg-info/10 text-info')} aria-hidden>
                        <AlertTriangle className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-words text-caption font-emphasis text-text-primary">{inc.title}</span>
                          <PillarBadge pillar={inc.pillar} />
                          <SeverityBadge severity={inc.severity} />
                          <StatusPill status={inc.status} />
                        </div>
                        <div className="mt-0.5 text-tiny text-text-quaternary">
                          {inc.dataset ?? t('observability.detail.datasetIdFallback', { id: inc.datasetId })} · #{inc.id} · {t('observability.incidents.detectedAt', { time: relativeTime(inc.firstSeenAt, t, locale) })}
                          {!resolved && inc.lastSeenAt && <> · {t('observability.incidents.lastSeen', { time: relativeTime(inc.lastSeenAt, t, locale) })}</>}
                          {resolved && inc.mttrHours != null && <> · <span className="text-success">{t('observability.incidents.resolvedIn', { duration: fmtDuration(inc.mttrHours, t, locale) })}</span></>}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 pl-14 sm:pl-0">
                      {canAct ? (
                        <>
                          {inc.status === 'open' && (
                            <Button size="sm" variant="ghost" disabled={busyId === inc.id} onClick={() => act(inc, 'acknowledge')} leadingIcon={<Check className="h-3.5 w-3.5" />}>{t('observability.action.acknowledge')}</Button>
                          )}
                          {!resolved && inc.capabilities?.acceptBaseline && (
                            <Button size="sm" variant="ghost" disabled={busyId === inc.id} onClick={() => setConfirmAccept(inc)}>{t('observability.action.acceptBaseline')}</Button>
                          )}
                          {!resolved && (
                            <Button size="sm" variant="secondary" disabled={busyId === inc.id} onClick={() => act(inc, 'resolve')} leadingIcon={<CheckCircle2 className="h-3.5 w-3.5" />}>{t('observability.action.resolve')}</Button>
                          )}
                          {resolved && (
                            <Button size="sm" variant="ghost" disabled={busyId === inc.id} onClick={() => act(inc, 'reopen')} leadingIcon={<RotateCcw className="h-3.5 w-3.5" />}>{t('observability.action.reopen')}</Button>
                          )}
                        </>
                      ) : (
                        <span className="text-tiny text-text-quaternary" title={t('observability.incidents.readOnlyHint')}>{t('observability.incidents.readOnly')}</span>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div id={`obs-incident-detail-${inc.id}`} className="border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 sm:px-12">
                      <IncidentDetail incident={inc} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {total > PAGE && (
            <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--border-line))] px-4 py-2 text-tiny text-text-tertiary">
              <span data-testid="obs-incidents-range">{t('observability.incidents.range', { from: total ? offset + 1 : 0, to: pageEnd, total })}</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  leadingIcon={<ChevronLeft className="h-3.5 w-3.5" />}>{t('observability.action.prev')}</Button>
                <Button size="sm" variant="ghost" disabled={pageEnd >= total || loading} onClick={() => setOffset(offset + PAGE)}
                  trailingIcon={<ChevronRight className="h-3.5 w-3.5" />}>{t('observability.action.next')}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!confirmAccept}
        onClose={() => setConfirmAccept(null)}
        onConfirm={() => { if (confirmAccept) act(confirmAccept, 'accept_baseline'); }}
        title={t('observability.incidents.acceptBaseline.title')}
        description={t(confirmAccept?.source === 'volume' ? 'observability.incidents.acceptBaseline.volume' : 'observability.incidents.acceptBaseline.schema')}
        confirmLabel={t('observability.action.acceptBaseline')}
        variant="warning"
      />
      {channelsOpen && <AlertChannelsModal onClose={() => setChannelsOpen(false)} />}
    </div>
  );
}

function IncidentDetail({ incident }: { incident: Incident }) {
  const { t, locale } = useI18n();
  const d = incident.detail ?? {};
  const rows: { k: string; v: string }[] = [];
  const push = (k: string, v: any) => { if (v != null && v !== '') rows.push({ k, v: typeof v === 'object' ? JSON.stringify(v) : String(v) }); };

  push(t('observability.incidents.detail.source'), t(`observability.pillar.${incident.pillar}`));
  if (incident.pillar === 'freshness') { push(t('observability.incidents.detail.lagHours'), d.lag_hours); push(t('observability.incidents.detail.maxLagHours'), d.max_lag_hours); push(t('observability.incidents.detail.lastLoadedAt'), d.last_loaded_at); push(t('observability.incidents.detail.reason'), d.reason); }
  if (incident.pillar === 'volume') { push(t('observability.incidents.detail.rowCount'), d.row_count); push(t('observability.incidents.detail.expected'), d.expected); push(t('observability.incidents.detail.zScore'), d.z_score); push(t('observability.incidents.detail.changePct'), d.change_pct); push(t('observability.incidents.detail.reason'), d.reason); }
  if (incident.pillar === 'schema') { push(t('observability.incidents.detail.columnsAdded'), (d.added || []).join(', ')); push(t('observability.incidents.detail.columnsRemoved'), (d.removed || []).join(', ')); push(t('observability.incidents.detail.typeChanges'), (d.retyped || []).map((r: any) => `${r.column}: ${r.from}→${r.to}`).join(', ')); }
  if (incident.pillar === 'distribution') { push(t('observability.incidents.detail.current'), d.current); push(t('observability.incidents.detail.expected'), d.expected); push(t('observability.incidents.detail.zScore'), d.z_score); push(t('observability.incidents.detail.changePct'), d.change_pct); push(t('observability.incidents.detail.explanation'), d.explanation); }
  if (incident.pillar === 'quality') { push(t('observability.incidents.detail.dimension'), d.dimension); push(t('observability.incidents.detail.ruleType'), d.rule_type); push(t('observability.incidents.detail.column'), d.column); push(t('observability.incidents.detail.failedRows'), d.rows_failed); }
  if (incident.pillar === 'semantic') { (d.reasons || []).forEach((r: string, i: number) => push(`${t('observability.incidents.detail.reason')} ${i + 1}`, r)); }
  if (d.merged_into) push(t('observability.incidents.detail.mergedInto'), `#${d.merged_into}`);
  const history = (d.history ?? []) as { action: string; at?: string; reason?: string }[];

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <pre className="overflow-x-auto text-tiny text-text-tertiary">{JSON.stringify(d, null, 2)}</pre>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2 text-tiny">
              <dt className="min-w-[110px] text-text-quaternary">{r.k}</dt>
              <dd className="break-all text-text-secondary">{r.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {history.length > 0 && (
        <div>
          <p className="mb-1 text-tiny font-emphasis text-text-tertiary">{t('observability.incidents.history')}</p>
          <ol className="space-y-0.5 text-tiny text-text-tertiary">
            {history.slice().reverse().map((h, i) => (
              <li key={i}>
                {t(`observability.incidents.historyAction.${h.action}`)}
                {h.reason ? ` (${t(`observability.incidents.reason.${h.reason}`)})` : ''} · {relativeTime(h.at, t, locale)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
