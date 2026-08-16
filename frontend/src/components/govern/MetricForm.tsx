'use client';

/**
 * MetricFormModal — the reusable create/edit modal for a governed KPI
 * (ManagedMetric). Extracted from the old Chỉ số tab so it can be opened from
 * INSIDE a knowledge document:
 *   • Editor → "Định nghĩa chỉ số" opens it in CREATE mode with home_doc_id
 *     pre-bound to the current doc; on save the caller inserts {{metric:slug}}.
 *   • Reader → the pencil on a metric card opens it in EDIT mode (by machine_name).
 * View mode also shows the SSOT + reuse lineage panel. Wired to
 * upsert/deleteManagedMetric. Design-system tokens only (AppModalShell chrome).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Pencil, Trash2, Save, Target, Sigma, BookText, ArrowUpRight, Loader2, ShieldCheck, X,
} from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  getManagedMetric, upsertManagedMetric, deleteManagedMetric, certifyManagedMetric, listDatasetsLite,
  type ManagedMetric, type ManagedMetricWrite, type ManagedMetricDetail, type DatasetLite,
} from '@/lib/catalog';
import { fetchDatasetModel, type DatasetModelView } from '@/hooks/use-dataset-model';
import { managedTargetLabel } from './knowledge-markdown';

const GRAINS = ['', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'point_in_time'];
const DIRECTIONS: ManagedMetric['direction'][] = ['up_good', 'down_good', 'neutral'];
const STATUSES: ManagedMetric['status'][] = ['Draft', 'Approved', 'Deprecated'];
const OPERATORS = ['', '>=', '<=', '=', 'between'];
const STATUS_TONE: Record<string, string> = {
  Approved: 'bg-success/10 text-success', Draft: 'bg-surface-2 text-text-tertiary', Deprecated: 'bg-danger/10 text-danger',
};

function errDetail(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}
function emptyForm(homeDocId?: number | null): ManagedMetricWrite {
  return {
    name: '', direction: 'neutral', status: 'Draft', synonyms: [],
    home_doc_id: homeDocId ?? null,
  };
}
function grainLabel(grain: string | null | undefined, t: (key: string) => string): string {
  return t(`govern.metric.grain.${grain ?? ''}`);
}
function directionLabel(direction: ManagedMetric['direction'] | undefined, t: (key: string) => string): string {
  return direction ? t(`govern.metric.direction.${direction}`) : '—';
}
function metricStatusLabel(status: ManagedMetric['status'], t: (key: string) => string): string {
  return t(`govern.metric.status.${status}`);
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-tiny text-text-quaternary">{hint}</p>}
    </div>
  );
}

/**
 * Reusable managed-metric modal. `machineName === null` → create mode
 * (optionally bound to `defaultHomeDocId`). Otherwise edit/view an existing KPI.
 */
export function MetricFormModal({ machineName, defaultHomeDocId, datasets = [], docs = [], onClose, onChanged, onCreated, onOpenDoc }: {
  machineName: string | null;                 // null = create
  defaultHomeDocId?: number | null;           // pre-bound SSOT doc for create-from-doc
  /** Available realization scopes when opened from the central Registry. */
  datasets?: DatasetLite[];
  /** Knowledge docs, so Home doc stops asking for a numeric id. */
  docs?: { id: number; title: string }[];
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
  onCreated?: (machineName: string, name: string) => void;
  onOpenDoc?: (docId: number) => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<ManagedMetricDetail | null>(null);
  const [loading, setLoading] = useState(!!machineName);
  const [mode, setMode] = useState<'view' | 'edit'>(machineName ? 'view' : 'edit');
  const [form, setForm] = useState<ManagedMetricWrite>(() => emptyForm(defaultHomeDocId));
  const [datasetOptions, setDatasetOptions] = useState<DatasetLite[]>(datasets);
  const [bindingDatasetId, setBindingDatasetId] = useState<number | null>(null);
  const [centralViews, setCentralViews] = useState<DatasetModelView[]>([]);
  const [loadingModel, setLoadingModel] = useState(false);
  // Which view the Data link points at. Kept separately because `measure_ref` is a
  // single string; derived from it on load so opening an existing metric shows the
  // table already selected rather than blank.
  const [linkViewId, setLinkViewId] = useState<number | null>(null);
  const activeDatasetId = bindingDatasetId;
  const effectiveViews = centralViews;
  const linkView = effectiveViews.find((v) => v.id === linkViewId) ?? null;
  const [synText, setSynText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [certifying, setCertifying] = useState(false);

  const toForm = useCallback((m: ManagedMetricDetail): ManagedMetricWrite => ({
    name: m.name, machine_name: m.machine_name, definition: m.definition ?? '', formula: m.formula ?? '',
    unit: m.unit ?? '', grain: m.grain ?? '', category: m.category ?? '', direction: m.direction,
    target_value: m.target_value ?? null, target_operator: m.target_operator ?? '', target_value2: m.target_value2 ?? null,
    owner: m.owner ?? '', dataset_id: m.dataset_id ?? null, dataset_table_id: m.dataset_table_id ?? null,
    measure_ref: m.measure_ref ?? '', related_term_fqn: m.related_term_fqn ?? '',
    home_doc_id: m.home_doc_id ?? null, status: m.status, synonyms: m.synonyms ?? [],
    // CARRIED THROUGH, NOT DROPPED. A metric may be computed in several datasets;
    // this screen edits the binding for the dataset it was opened from, and the
    // rest have to survive the round trip or editing here would quietly unbind the
    // definition everywhere else.
    bindings: m.bindings ?? [],
  }), []);

  useEffect(() => {
    if (!machineName) return;
    let on = true;
    setLoading(true);
    getManagedMetric(machineName)
      .then((m) => {
        if (!on) return;
        setDetail(m); setForm(toForm(m)); setSynText((m.synonyms ?? []).join(', '));
        // Preselect the table the stored measure_ref names, so the dropdown opens
        // on the right row instead of looking unset on an existing metric.
        const primary = (m.bindings ?? []).find((binding) => binding.is_primary) ?? m.bindings?.[0];
        setBindingDatasetId(primary?.dataset_id ?? m.dataset_id ?? null);
      })
      .catch(() => { if (on) toast.error(t('govern.metric.loadFailed')); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [machineName, t, toForm]);

  useEffect(() => {
    if (datasetOptions.length > 0) return;
    listDatasetsLite().then(setDatasetOptions).catch(() => setDatasetOptions([]));
  }, [datasetOptions.length]);

  useEffect(() => {
    if (bindingDatasetId == null) {
      setCentralViews([]);
      return;
    }
    let active = true;
    setLoadingModel(true);
    fetchDatasetModel(bindingDatasetId)
      .then((model) => { if (active) setCentralViews(model.views ?? []); })
      .catch(() => { if (active) setCentralViews([]); })
      .finally(() => { if (active) setLoadingModel(false); });
    return () => { active = false; };
  }, [bindingDatasetId]);

  const activeBinding = useMemo(
    () => (form.bindings ?? []).find((binding) => binding.dataset_id === activeDatasetId) ?? null,
    [activeDatasetId, form.bindings],
  );

  useEffect(() => {
    const tableId = activeBinding?.dataset_table_id;
    setLinkViewId(tableId == null
      ? null
      : effectiveViews.find((view) => (view.dataset_table_id ?? view.id) === tableId)?.id ?? null);
  }, [activeBinding?.dataset_table_id, effectiveViews]);

  const upd = (patch: Partial<ManagedMetricWrite>) => setForm((p) => ({ ...p, ...patch }));

  /** Rewrite the binding for the dataset this form was opened from, leaving every
   *  other dataset's binding exactly as it was. Editing "where GMV comes from
   *  here" must not touch where it comes from anywhere else. */
  const setLocalBinding = (patch: { dataset_table_id?: number | null; measure_ref?: string | null }) =>
    setForm((p) => {
      const ds = activeDatasetId;
      if (ds == null) return p;
      const others = (p.bindings ?? []).filter((b) => b.dataset_id !== ds);
      const mine = (p.bindings ?? []).find((b) => b.dataset_id === ds) ?? {
        dataset_id: ds, is_primary: (p.bindings ?? []).length === 0,
      };
      const next = { ...mine, ...patch };
      const keep = next.dataset_table_id != null || (next.measure_ref || '').trim() !== ''
        || next.dataset_id != null;
      return {
        ...p,
        bindings: keep ? [...others, next] : others,
      };
    });

  /** Datasets OTHER than this one that compute the same definition. Shown so the
   *  screen cannot be read as "this dataset owns this metric". */
  const elsewhere = (form.bindings ?? []).filter(
    (b) => b.dataset_id != null && b.dataset_id !== activeDatasetId,
  );

  const certify = async () => {
    if (!detail) return;
    setCertifying(true);
    try {
      await certifyManagedMetric(detail.machine_name);
      const fresh = await getManagedMetric(detail.machine_name);
      setDetail(fresh); setForm(toForm(fresh));
      toast.success(t('govern.metric.certified'));
      if (onChanged) await onChanged();
    } catch (error) {
      toast.error(errDetail(error) || t('govern.metric.certifyFailed'));
    } finally {
      setCertifying(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('govern.metric.nameRequired')); return; }
    setSaving(true);
    try {
      const body: ManagedMetricWrite = {
        ...form,
        synonyms: synText.split(',').map((s) => s.trim()).filter(Boolean),
        target_value: form.target_value == null || (form.target_value as unknown) === '' ? null : Number(form.target_value),
        target_value2: form.target_value2 == null || (form.target_value2 as unknown) === '' ? null : Number(form.target_value2),
      };
      const r = await upsertManagedMetric(body);
      toast.success(form.machine_name ? t('govern.metric.updated', { version: r.version }) : t('govern.metric.created'));
      if (onChanged) await onChanged();
      if (form.machine_name) {
        const fresh = await getManagedMetric(r.machine_name); setDetail(fresh); setForm(toForm(fresh)); setMode('view');
      } else {
        onCreated?.(r.machine_name, form.name);
        onClose();
      }
    } catch (e) { toast.error(errDetail(e) || t('govern.metric.saveFailed')); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!detail || !window.confirm(t('govern.metric.deleteConfirm', { name: detail.name }))) return;
    setDeleting(true);
    try { await deleteManagedMetric(detail.machine_name); toast.success(t('govern.metric.deleted')); if (onChanged) await onChanged(); onClose(); }
    catch (e) { toast.error(errDetail(e) || t('govern.metric.deleteFailed')); }
    finally { setDeleting(false); }
  };

  const title = machineName ? (detail?.name || t('govern.metric.titleFallback')) : t('govern.metric.titleNew');
  const footer = mode === 'view' && detail ? (
    <>
      <Button variant="ghost" onClick={remove} loading={deleting} leadingIcon={<Trash2 className="h-4 w-4" />}>{t('govern.action.delete')}</Button>
      <div className="flex-1" />
      {detail.status !== 'Approved' && (
        <Button variant="secondary" leadingIcon={<ShieldCheck className="h-4 w-4" />} onClick={certify} loading={certifying} disabled={detail.binding_status !== 'ok'}>{t('govern.metric.certify')}</Button>
      )}
      <Button variant="secondary" onClick={onClose}>{t('govern.action.close')}</Button>
      <Button variant="primary" leadingIcon={<Pencil className="h-4 w-4" />} onClick={() => setMode('edit')}>{t('govern.action.edit')}</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => (machineName ? setMode('view') : onClose())} disabled={saving}>{t('govern.action.cancel')}</Button>
      <Button variant="primary" leadingIcon={<Save className="h-4 w-4" />} onClick={save} loading={saving}>{t('govern.metric.save')}</Button>
    </>
  );

  return (
    <AppModalShell onClose={onClose} title={title} icon={<Target className="h-4 w-4" />} maxWidthClass="max-w-3xl" footer={footer}>
      {loading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>
      ) : mode === 'view' && detail ? (
        <MetricView detail={detail} onOpenDoc={onOpenDoc} />
      ) : (
        <div className="space-y-4">
          {!machineName && defaultHomeDocId != null && (
            <p className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-tiny text-text-secondary">
              {t('govern.metric.ssotNotice')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('govern.metric.name')} hint={t('govern.metric.nameHint')}><Input value={form.name} onChange={(e) => upd({ name: e.target.value })} placeholder={t('govern.metric.namePlaceholder')} /></Field>
            <Field label={t('govern.metric.category')} hint={t('govern.metric.categoryHint')}><Input value={form.category ?? ''} onChange={(e) => upd({ category: e.target.value })} /></Field>
          </div>
          <Field label={t('govern.metric.definition')} hint={t('govern.metric.definitionHint')}><Textarea rows={2} value={form.definition ?? ''} onChange={(e) => upd({ definition: e.target.value })} /></Field>
          <Field label={t('govern.metric.formula')} hint={t('govern.metric.formulaHint')}><Textarea rows={2} value={form.formula ?? ''} onChange={(e) => upd({ formula: e.target.value })} /></Field>
          {elsewhere.length > 0 && (
            /* WHERE ELSE THIS SAME DEFINITION IS COMPUTED.
               One line of chips, no sentence: the fact that needs conveying is
               "this is shared, not yours", and a list of dataset names conveys it
               faster than a paragraph explaining the concept. */
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="text-tiny text-text-tertiary">{t('govern.metric.alsoComputedIn')}</span>
              {elsewhere.map((b) => (
                <span
                  key={`${b.dataset_id}-${b.measure_ref}`}
                  className="rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 text-tiny text-text-secondary"
                >
                  {b.dataset_name || `#${b.dataset_id}`}
                </span>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('govern.metric.unit')}>
              {/* datalist, not a Select: these cover almost every metric but the list
                  cannot be exhaustive, so typing something else must stay possible.
                  A closed dropdown here would block a legitimate unit. */}
              <Input list="metric-units" value={form.unit ?? ''} onChange={(e) => upd({ unit: e.target.value })} placeholder={t('govern.metric.unitPlaceholder')} />
              <datalist id="metric-units">
                {['VND', 'USD', '%', 'don', 'ngay', 'gio', 'khach', 'san pham', 'diem'].map((u) => <option key={u} value={u} />)}
              </datalist>
            </Field>
            <Field label={t('govern.metric.grain')}><Select value={form.grain ?? ''} onChange={(e) => upd({ grain: e.target.value })}>{GRAINS.map((g) => <option key={g} value={g}>{grainLabel(g, t)}</option>)}</Select></Field>
            <Field label={t('govern.metric.direction')}><Select value={form.direction ?? 'neutral'} onChange={(e) => upd({ direction: e.target.value as ManagedMetric['direction'] })}>{DIRECTIONS.map((d) => <option key={d} value={d}>{directionLabel(d, t)}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label={t('govern.metric.targetOperator')}><Select value={form.target_operator ?? ''} onChange={(e) => upd({ target_operator: e.target.value })}>{OPERATORS.map((o) => <option key={o} value={o}>{o || '—'}</option>)}</Select></Field>
            <Field label={t('govern.metric.targetValue')}><Input type="number" value={form.target_value ?? ''} onChange={(e) => upd({ target_value: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            {form.target_operator === 'between' && (
              <Field label={t('govern.metric.to')}><Input type="number" value={form.target_value2 ?? ''} onChange={(e) => upd({ target_value2: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            )}
            <Field label={t('govern.metric.owner')}><Input value={form.owner ?? ''} onChange={(e) => upd({ owner: e.target.value })} placeholder={t('govern.metric.ownerPlaceholder')} /></Field>
          </div>
          <div className="space-y-3 border-y border-[rgb(var(--border-line))] py-3">
            <div className="flex items-center justify-between">
              <Label>{t('govern.metric.realizations')}</Label>
              <span className="text-tiny text-text-quaternary">{t('govern.metric.realizationCount', { count: form.bindings?.length ?? 0 })}</span>
            </div>
            {(form.bindings ?? []).length > 0 && (
              <div className="divide-y divide-[rgb(var(--border-line))] border border-[rgb(var(--border-line))]">
                {(form.bindings ?? []).map((binding) => (
                  <div key={`${binding.dataset_id}:${binding.dataset_table_id}:${binding.measure_ref}`} className="flex items-center gap-2 px-2.5 py-2 text-tiny">
                    <span className="min-w-0 flex-1 truncate text-text-secondary">
                      {binding.dataset_name || datasetOptions.find((dataset) => dataset.id === binding.dataset_id)?.name || `#${binding.dataset_id}`}
                    </span>
                    <span className="min-w-0 flex-[1.4] truncate font-mono text-text-tertiary">{binding.measure_label || binding.measure_ref || t('govern.registry.binding.unbound')}</span>
                    <span className={cn('rounded px-1.5 py-0.5', binding.status === 'ok' ? 'bg-success/10 text-success' : binding.status === 'unresolved' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>
                      {t(`govern.registry.binding.${binding.status || (binding.measure_ref ? 'unresolved' : 'unbound')}`)}
                    </span>
                    <button type="button" title={t('govern.metric.removeRealization')} onClick={() => setForm((current) => ({ ...current, bindings: (current.bindings ?? []).filter((item) => item !== binding) }))} className="rounded p-1 text-text-quaternary hover:bg-danger/10 hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('govern.metric.linkDataset')}>
                <Select value={bindingDatasetId == null ? '' : String(bindingDatasetId)} onChange={(event) => { setBindingDatasetId(event.target.value ? Number(event.target.value) : null); setLinkViewId(null); }}>
                  <option value="">{t('common.none')}</option>
                  {datasetOptions.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                </Select>
              </Field>
              <Field label={t('govern.metric.linkTable')}>
                <Select
                  value={linkView?.id != null ? String(linkView.id) : ''}
                  disabled={activeDatasetId == null || loadingModel}
                  onChange={(event) => {
                    const nextView = effectiveViews.find((view) => view.id === Number(event.target.value)) ?? null;
                    setLinkViewId(nextView?.id ?? null);
                    setLocalBinding({ dataset_table_id: nextView?.dataset_table_id ?? nextView?.id ?? null, measure_ref: null });
                  }}
                >
                  <option value="">{loadingModel ? t('govern.loading') : t('common.none')}</option>
                  {effectiveViews.map((view) => <option key={view.id} value={view.id}>{view.table_display_name || view.name}</option>)}
                </Select>
              </Field>
              <Field label={t('govern.metric.linkMeasure')} hint={t('govern.metric.measureRefHint')}>
                <Select
                  value={activeBinding?.measure_ref ?? ''}
                  disabled={!linkView}
                  onChange={(event) => setLocalBinding({ measure_ref: event.target.value || null, dataset_table_id: linkView?.dataset_table_id ?? linkView?.id ?? null })}
                >
                  <option value="">{t('common.none')}</option>
                  {(linkView?.measures ?? []).map((measure) => {
                    const ref = `${linkView?.name}.${measure.name}`;
                    return <option key={measure.name} value={ref}>{measure.label || measure.name}</option>;
                  })}
                </Select>
              </Field>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('govern.metric.relatedTerm')} hint={t('govern.metric.relatedTermHint')}>
              <Input value={form.related_term_fqn ?? ''} onChange={(e) => upd({ related_term_fqn: e.target.value })} />
            </Field>
            <Field label={t('govern.metric.homeDoc')} hint={t('govern.metric.homeDocHint')}>
              {docs.length > 0 ? (
                <Select
                  value={form.home_doc_id != null ? String(form.home_doc_id) : ''}
                  onChange={(e) => upd({ home_doc_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">{t('common.none')}</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </Select>
              ) : (
                <Input type="number" value={form.home_doc_id ?? ''} onChange={(e) => upd({ home_doc_id: e.target.value === '' ? null : Number(e.target.value) })} />
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('govern.metric.synonyms')} hint={t('govern.metric.synonymsHint')}><Input value={synText} onChange={(e) => setSynText(e.target.value)} /></Field>
            <Field label={t('govern.metric.status')}><Select value={form.status ?? 'Draft'} onChange={(e) => upd({ status: e.target.value as ManagedMetric['status'] })}>{STATUSES.filter((status) => status !== 'Approved' || detail?.status === 'Approved').map((s) => <option key={s} value={s}>{metricStatusLabel(s, t)}</option>)}</Select></Field>
          </div>
        </div>
      )}
    </AppModalShell>
  );
}

function MetricView({ detail, onOpenDoc }: { detail: ManagedMetricDetail; onOpenDoc?: (docId: number) => void }) {
  const { t } = useI18n();
  const lin = detail.lineage;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[detail.status] || '')}>{metricStatusLabel(detail.status, t)}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">v{detail.version}</span>
        {detail.category && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{detail.category}</span>}
        {detail.grain && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{grainLabel(detail.grain, t)}</span>}
        <span className={cn('rounded-full px-2 py-0.5 text-tiny', detail.binding_status === 'ok' ? 'bg-success/10 text-success' : detail.binding_status === 'unresolved' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>
          {t(`govern.registry.binding.${detail.binding_status || 'unbound'}`)}
        </span>
      </div>

      {detail.definition && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">{t('govern.metric.definitionSection')}</div>
          <p className="text-caption text-text-secondary">{detail.definition}</p>
        </div>
      )}
      {detail.formula && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">{t('govern.metric.formulaSection')}</div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 font-mono text-tiny text-text-secondary">{detail.formula}</pre>
        </div>
      )}

      <div className="grid gap-x-6 gap-y-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 sm:grid-cols-2">
        <Meta label={t('govern.metric.unit')} value={detail.unit || '—'} />
        <Meta label={t('govern.metric.target')} value={managedTargetLabel(detail)} />
        <Meta label={t('govern.metric.owner')} value={detail.owner || '—'} />
        <Meta label={t('govern.metric.direction')} value={directionLabel(detail.direction, t)} />
        <Meta label={t('govern.metric.relatedTerm')} value={detail.related_term_fqn || '—'} mono />
        {detail.synonyms.length > 0 && <Meta label={t('govern.metric.synonyms')} value={detail.synonyms.join(', ')} />}
      </div>

      <div className="border-y border-[rgb(var(--border-line))] py-3">
        <div className="mb-2 text-tiny uppercase text-text-tertiary">{t('govern.metric.realizations')}</div>
        {(detail.bindings ?? []).length === 0 ? (
          <p className="text-caption text-warning">{t('govern.registry.binding.unbound')}</p>
        ) : (
          <div className="divide-y divide-[rgb(var(--border-line))]">
            {(detail.bindings ?? []).map((binding) => (
              <div key={`${binding.dataset_id}:${binding.dataset_table_id}:${binding.measure_ref}`} className="grid grid-cols-[10rem_minmax(0,1fr)_7rem] gap-3 py-2 text-caption">
                <span className="truncate text-text-secondary">{binding.dataset_name || `#${binding.dataset_id}`}</span>
                <span className="truncate font-mono text-text-tertiary">{binding.measure_label || binding.measure_ref || '—'}</span>
                <span className={binding.status === 'ok' ? 'text-success' : binding.status === 'unresolved' ? 'text-danger' : 'text-warning'}>{t(`govern.registry.binding.${binding.status || 'unbound'}`)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-2 flex items-center gap-1.5 text-tiny uppercase tracking-[0.08em] text-text-tertiary"><Sigma className="h-3.5 w-3.5" />{t('govern.metric.origin')}</div>
        <div className="space-y-2">
          <div>
            <span className="text-tiny text-text-quaternary">{t('govern.metric.ssotPage')}</span>
            {lin?.home_doc ? (
              <button onClick={() => onOpenDoc?.(lin.home_doc!.id)} className="ml-2 inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5 text-tiny text-brand hover:bg-brand/20">
                <BookText className="h-3 w-3" />{lin.home_doc.title}<ArrowUpRight className="h-3 w-3" />
              </button>
            ) : <span className="ml-2 text-tiny text-text-quaternary">{t('govern.metric.notLinked')}</span>}
          </div>
          <div>
            <span className="text-tiny text-text-quaternary">{t('govern.metric.reusedIn', { count: lin?.used_in.length || 0 })}</span>
            {lin && lin.used_in.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {lin.used_in.map((d) => (
                  <button key={d.id} onClick={() => onOpenDoc?.(d.id)} className="inline-flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-tiny text-text-secondary hover:bg-surface-3">
                    <BookText className="h-3 w-3 text-text-quaternary" />{d.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-tiny uppercase tracking-[0.08em] text-text-quaternary">{label}</span>
      <span className={cn('text-caption font-emphasis text-text-primary', mono && 'font-mono')}>{value}</span>
    </div>
  );
}
