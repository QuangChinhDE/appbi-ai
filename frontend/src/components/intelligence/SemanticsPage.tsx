'use client';

/**
 * Chỉ số & Thuật ngữ — the business-semantic contract the AI reasons over.
 * Metrics stay the SAME GovernMetric store the docs hub authors (SSOT — no
 * second registry); this page is the registry view with certify + binding
 * validation. Also home of "Lưu ý dữ liệu" (always-inject caveats).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpenCheck, Plus, ShieldCheck, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Input, Label, Textarea } from '@/components/ui/Input';
import { ModuleOverview } from '@/components/common/ModuleOverview';
import { PageListLayout } from '@/components/common/PageListLayout';
import { AppModalShell } from '@/components/common/AppModalShell';
import { MetricFormModal } from '@/components/govern/MetricForm';
import { Panel, EmptyHint, StatusBadge, useCanAuthor } from '@/components/intelligence/shared';
import {
  listManagedMetrics, intelligenceOverview, certifyEntity, listCaveats, upsertCaveat, deleteCaveat,
  listDatasetsLite, type ManagedMetric, type GovernCaveat, type DatasetLite,
} from '@/lib/catalog';
import { apiClient } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { useI18n } from '@/providers/LanguageProvider';

export function SemanticsPage() {
  const { t } = useI18n();
  const canAuthor = useCanAuthor();
  const [tab, setTab] = useState<'metrics' | 'caveats'>('metrics');
  const [metrics, setMetrics] = useState<ManagedMetric[]>([]);
  const [unbound, setUnbound] = useState<Record<string, string>>({});
  const [caveats, setCaveats] = useState<GovernCaveat[]>([]);
  const [loading, setLoading] = useState(true);
  const [metricModal, setMetricModal] = useState<{ open: boolean; machineName: string | null }>({ open: false, machineName: null });
  const [caveatModal, setCaveatModal] = useState<GovernCaveat | 'new' | null>(null);
  const [search, setSearch] = useState('');

  const reload = useCallback(async () => {
    try {
      const [m, ov, cv] = await Promise.all([
        listManagedMetrics(),
        intelligenceOverview().catch(() => null),
        listCaveats().catch(() => []),
      ]);
      setMetrics(m);
      setCaveats(cv);
      const u: Record<string, string> = {};
      ov?.unbound_metrics.forEach((x) => { u[x.name] = x.binding; });
      setUnbound(u);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return metrics;
    return metrics.filter((m) => `${m.name} ${m.machine_name} ${m.definition ?? ''}`.toLowerCase().includes(q));
  }, [metrics, search]);

  const certify = async (m: ManagedMetric) => {
    try {
      await apiClient.post(`/catalog/govern/managed-metric/${encodeURIComponent(m.machine_name)}/certify`);
      toast.success(`${t('intel.sem.certified')}: ${m.name}`, { description: t('intel.sem.certifiedDesc') });
      reload();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.sem.certifyFailed')));
    }
  };

  const approvedCount = metrics.filter((m) => m.status === 'Approved').length;

  return (
    <PageListLayout
      title={t('intel.sem.title')}
      description={t('intel.sem.desc')}
      searchable
      searchValue={search}
      onSearchValueChange={setSearch}
      searchPlaceholder={t('intel.sem.search')}
      viewToggle={false}
      isLoading={loading}
      action={canAuthor ? (
        <div className="flex items-center gap-2">
          {tab === 'metrics' ? (
            <Button variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setMetricModal({ open: true, machineName: null })}>
              {t('intel.sem.newMetric')}
            </Button>
          ) : (
            <Button variant="primary" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCaveatModal('new')}>
              {t('intel.sem.newCaveat')}
            </Button>
          )}
        </div>
      ) : undefined}
      overview={(
        <ModuleOverview stats={[
          { label: t('intel.sem.statCertified'), value: `${approvedCount}/${metrics.length}` },
          { label: t('intel.sem.statUnbound'), value: Object.keys(unbound).length, helper: t('intel.sem.statUnboundHelp') },
          { label: t('intel.sem.statCaveats'), value: caveats.length, helper: t('intel.sem.statCaveatsHelp') },
        ]}
      />)}
      toolbarExtra={(
        <Tabs
          size="sm"
          value={tab}
          onChange={(k) => setTab(k)}
          items={[
            { key: 'metrics', label: t('intel.sem.tabMetrics') },
            { key: 'caveats', label: t('intel.sem.tabCaveats') },
          ]}
        />
      )}
    >
      {tab === 'metrics' ? (
        <div className="pb-8">
          <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="app-list-table divide-y divide-[rgb(var(--border-line))]">
              <colgroup>
                <col className="w-[26%]" /><col className="w-[24%]" /><col className="w-[10%]" />
                <col className="w-[12%]" /><col className="w-[14%]" /><col className="w-[14%]" />
              </colgroup>
              <thead className="bg-surface-2">
                <tr>
                  <th className="app-list-header">{t('intel.sem.colMetric')}</th>
                  <th className="app-list-header">{t('intel.sem.colFormula')}</th>
                  <th className="app-list-header">{t('intel.sem.colUnit')}</th>
                  <th className="app-list-header">{t('intel.sem.colBinding')}</th>
                  <th className="app-list-header">{t('intel.sem.colStatus')}</th>
                  <th className="app-list-header text-right">{t('intel.sem.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                {filtered.map((m) => {
                  const bind = unbound[m.machine_name];
                  return (
                    <tr key={m.machine_name} className="cursor-pointer hover:bg-surface-2" onClick={() => setMetricModal({ open: true, machineName: m.machine_name })}>
                      <td className="app-list-cell">
                        <span className="block truncate text-caption font-emphasis text-text-primary">{m.name}</span>
                        <span className="block truncate text-tiny text-text-quaternary">{m.definition || m.machine_name}</span>
                      </td>
                      <td className="app-list-cell">
                        <span className="block truncate font-mono text-tiny text-text-tertiary">{m.formula || '—'}</span>
                      </td>
                      <td className="app-list-cell text-caption text-text-secondary">{m.unit || '—'}</td>
                      <td className="app-list-cell">
                        {m.measure_ref ? (
                          bind ? (
                            <Badge variant="warning" size="xs"><AlertTriangle className="h-2.5 w-2.5" /> {bind === 'unresolved' ? t('intel.sem.bindDrift') : t('intel.sem.bindMissing')}</Badge>
                          ) : (
                            <Badge variant="success" size="xs">✓ {t('intel.sem.bindOk')}</Badge>
                          )
                        ) : (
                          <Badge variant="danger" size="xs">○ {t('intel.sem.bindMissing')}</Badge>
                        )}
                      </td>
                      <td className="app-list-cell">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusBadge status={m.status} />
                          <span className="text-tiny text-text-quaternary">v{m.version}</span>
                        </span>
                      </td>
                      <td className="app-list-cell-tight text-right" onClick={(e) => e.stopPropagation()}>
                        {m.status !== 'Approved' && (
                          <Button size="xs" variant="secondary" leadingIcon={<ShieldCheck className="h-3 w-3" />} onClick={() => certify(m)}>
                            {t('intel.sem.certify')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="p-8"><EmptyHint>{t('intel.sem.emptyMetrics')}</EmptyHint></div>
            )}
          </div>
          <p className="mt-2 text-tiny text-text-quaternary">{t('intel.sem.certifyNote')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 pb-8 lg:grid-cols-2">
          {caveats.map((c) => (
            <Panel
              key={c.id}
              title={(
                <span className="inline-flex items-center gap-2">
                  <BookOpenCheck className="h-3.5 w-3.5 text-warning" />{c.title}
                  {c.always_inject && <Badge variant="warning" size="xs">{t('intel.sem.alwaysInject')}</Badge>}
                </span>
              )}
              sub={c.dataset_id ? `${t('intel.sem.dataset')} #${c.dataset_id}` : t('intel.sem.allDatasets')}
              action={canAuthor ? (
                <div className="flex items-center gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setCaveatModal(c)}>{t('intel.common.edit')}</Button>
                  <Button size="xs" variant="ghost" className="text-danger hover:text-danger" onClick={async () => {
                    await deleteCaveat(c.id); toast.success(t('intel.sem.caveatDeleted')); reload();
                  }}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ) : undefined}
            >
              <p className="text-caption leading-relaxed text-text-secondary">{c.content}</p>
            </Panel>
          ))}
          {caveats.length === 0 && (
            <div className="lg:col-span-2"><EmptyHint>{t('intel.sem.emptyCaveats')}</EmptyHint></div>
          )}
        </div>
      )}

      {metricModal.open && (
        <MetricFormModal
          machineName={metricModal.machineName}
          onClose={() => setMetricModal({ open: false, machineName: null })}
          onChanged={reload}
        />
      )}
      {caveatModal !== null && (
        <CaveatModal
          caveat={caveatModal === 'new' ? null : caveatModal}
          onClose={() => setCaveatModal(null)}
          onSaved={() => { setCaveatModal(null); reload(); }}
        />
      )}
    </PageListLayout>
  );
}

function CaveatModal({ caveat, onClose, onSaved }: {
  caveat: GovernCaveat | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(caveat?.title ?? '');
  const [content, setContent] = useState(caveat?.content ?? '');
  const [datasetId, setDatasetId] = useState<string>(caveat?.dataset_id ? String(caveat.dataset_id) : '');
  const [alwaysInject, setAlwaysInject] = useState(caveat?.always_inject ?? true);
  const [datasets, setDatasets] = useState<DatasetLite[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { listDatasetsLite().then(setDatasets).catch(() => setDatasets([])); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await upsertCaveat({
        id: caveat?.id,
        title, content,
        dataset_id: datasetId ? Number(datasetId) : null,
        always_inject: alwaysInject,
      });
      toast.success(t('intel.sem.caveatSaved'));
      onSaved();
    } catch (err) {
      toast.error(extractApiError(err, t('intel.common.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={caveat ? t('intel.sem.editCaveat') : t('intel.sem.newCaveat')}
      description={t('intel.sem.caveatModalDesc')}
      icon={<BookOpenCheck className="h-4 w-4" />}
      maxWidthClass="max-w-xl"
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('intel.common.cancel')}</Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!title.trim() || !content.trim()} onClick={save}>
            {t('intel.common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('intel.sem.caveatTitle')}</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('intel.sem.caveatTitlePh')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('intel.sem.caveatContent')}</Label>
          <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('intel.sem.caveatContentPh')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('intel.sem.dataset')}</Label>
            <select
              className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 text-caption text-text-primary outline-none focus:border-brand"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
            >
              <option value="">{t('intel.sem.allDatasets')}</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <label className="mt-6 inline-flex items-center gap-2 text-caption text-text-secondary">
            <input type="checkbox" className="h-3.5 w-3.5 rounded accent-[rgb(var(--brand))]" checked={alwaysInject} onChange={(e) => setAlwaysInject(e.target.checked)} />
            {t('intel.sem.alwaysInject')}
          </label>
        </div>
        <p className="text-tiny text-text-quaternary">{t('intel.sem.caveatNote')}</p>
      </div>
    </AppModalShell>
  );
}
