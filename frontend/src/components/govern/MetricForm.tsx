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
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Pencil, Trash2, Save, Target, Sigma, BookText, ArrowUpRight, Loader2,
} from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Label, Select } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  getManagedMetric, upsertManagedMetric, deleteManagedMetric,
  type ManagedMetric, type ManagedMetricWrite, type ManagedMetricDetail,
} from '@/lib/catalog';
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
function emptyForm(homeDocId?: number | null, datasetId?: number | null): ManagedMetricWrite {
  // `dataset_id` is seeded, not left to the author. Every metric in this
  // deployment was created unbound because the only place to make one was a global
  // screen that never asked which dataset it described — nine rows that belonged
  // to nothing, and had to be deleted. A metric created from inside a dataset
  // belongs to that dataset from the first keystroke.
  return {
    name: '', direction: 'neutral', status: 'Draft', synonyms: [],
    home_doc_id: homeDocId ?? null,
    dataset_id: datasetId ?? null,
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
export function MetricFormModal({ machineName, defaultHomeDocId, defaultDatasetId, views = [], docs = [], onClose, onChanged, onCreated, onOpenDoc }: {
  machineName: string | null;                 // null = create
  defaultHomeDocId?: number | null;           // pre-bound SSOT doc for create-from-doc
  defaultDatasetId?: number | null;           // the dataset this metric describes
  /** This dataset's views, so Data link becomes two dropdowns instead of a
   *  string somebody has to spell exactly right. */
  views?: {
    id: number; name: string; dataset_table_id?: number;
    table_display_name?: string; measures: { name: string }[];
  }[];
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
  const [form, setForm] = useState<ManagedMetricWrite>(() => emptyForm(defaultHomeDocId, defaultDatasetId));
  // Which view the Data link points at. Kept separately because `measure_ref` is a
  // single string; derived from it on load so opening an existing metric shows the
  // table already selected rather than blank.
  const [linkViewId, setLinkViewId] = useState<number | null>(null);
  const linkView = views.find((v) => v.id === linkViewId) ?? null;
  const [synText, setSynText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const toForm = useCallback((m: ManagedMetricDetail): ManagedMetricWrite => ({
    name: m.name, machine_name: m.machine_name, definition: m.definition ?? '', formula: m.formula ?? '',
    unit: m.unit ?? '', grain: m.grain ?? '', category: m.category ?? '', direction: m.direction,
    target_value: m.target_value ?? null, target_operator: m.target_operator ?? '', target_value2: m.target_value2 ?? null,
    owner: m.owner ?? '', measure_ref: m.measure_ref ?? '', related_term_fqn: m.related_term_fqn ?? '',
    home_doc_id: m.home_doc_id ?? null, status: m.status, synonyms: m.synonyms ?? [],
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
        const tid = Number((/^dataset_table_(\d+)\./.exec(m.measure_ref || '') || [])[1] || 0);
        if (tid) setLinkViewId(views.find((v) => (v.dataset_table_id ?? v.id) === tid)?.id ?? null);
      })
      .catch(() => { if (on) toast.error(t('govern.metric.loadFailed')); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [machineName, t, toForm]);

  const upd = (patch: Partial<ManagedMetricWrite>) => setForm((p) => ({ ...p, ...patch }));

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
          <div className="grid grid-cols-3 gap-3">
            {/* Data link was one text box holding "dataset_table_437.on_time_rate" —
                a string with a database id in it, typed from memory. Two dropdowns
                off the dataset's own model produce the same value and cannot be
                misspelled. Falls back to the text box when no views loaded, so a
                metric authored outside a dataset is still editable. */}
            {views.length > 0 ? (
              <>
                <Field label={t('govern.metric.linkTable')}>
                  <Select
                    value={linkView?.id != null ? String(linkView.id) : ''}
                    onChange={(e) => setLinkViewId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{t('common.none')}</option>
                    {/* display name, not `name` — that one is the physical view ("dataset_table_440")
     and nobody can tell which table it is from the id. */}
                    {views.map((v) => (
                      <option key={v.id} value={v.id}>{v.table_display_name || v.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('govern.metric.linkMeasure')} hint={t('govern.metric.measureRefHint')}>
                  <Select
                    value={form.measure_ref ?? ''}
                    disabled={!linkView}
                    onChange={(e) => upd({ measure_ref: e.target.value })}
                  >
                    <option value="">{t('common.none')}</option>
                    {(linkView?.measures ?? []).map((m) => {
                      const ref = `dataset_table_${linkView?.dataset_table_id ?? linkView?.id}.${m.name}`;
                      return <option key={m.name} value={ref}>{m.name}</option>;
                    })}
                  </Select>
                </Field>
              </>
            ) : (
              <Field label={t('govern.metric.measureRef')} hint={t('govern.metric.measureRefHint')}><Input value={form.measure_ref ?? ''} onChange={(e) => upd({ measure_ref: e.target.value })} /></Field>
            )}
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
            <Field label={t('govern.metric.status')}><Select value={form.status ?? 'Draft'} onChange={(e) => upd({ status: e.target.value as ManagedMetric['status'] })}>{STATUSES.map((s) => <option key={s} value={s}>{metricStatusLabel(s, t)}</option>)}</Select></Field>
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
        <Meta label={t('govern.metric.measureRef')} value={detail.measure_ref || '—'} mono />
        <Meta label={t('govern.metric.relatedTerm')} value={detail.related_term_fqn || '—'} mono />
        {detail.synonyms.length > 0 && <Meta label={t('govern.metric.synonyms')} value={detail.synonyms.join(', ')} />}
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
