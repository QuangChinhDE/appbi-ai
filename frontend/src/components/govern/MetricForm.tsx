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
import {
  getManagedMetric, upsertManagedMetric, deleteManagedMetric,
  type ManagedMetric, type ManagedMetricWrite, type ManagedMetricDetail,
} from '@/lib/catalog';
import { managedTargetLabel } from './knowledge-markdown';

const GRAINS = ['', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'point_in_time'];
const GRAIN_LABEL: Record<string, string> = {
  '': 'Không rõ', daily: 'Ngày', weekly: 'Tuần', monthly: 'Tháng', quarterly: 'Quý', yearly: 'Năm', point_in_time: 'Tại thời điểm',
};
const DIRECTIONS: { value: ManagedMetric['direction']; label: string }[] = [
  { value: 'up_good', label: 'Càng cao càng tốt' },
  { value: 'down_good', label: 'Càng thấp càng tốt' },
  { value: 'neutral', label: 'Trung tính' },
];
const STATUSES: ManagedMetric['status'][] = ['Draft', 'Approved', 'Deprecated'];
const OPERATORS = ['', '>=', '<=', '=', 'between'];
const STATUS_TONE: Record<string, string> = {
  Approved: 'bg-success/10 text-success', Draft: 'bg-surface-2 text-text-tertiary', Deprecated: 'bg-danger/10 text-danger',
};

function errDetail(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}
function emptyForm(homeDocId?: number | null): ManagedMetricWrite {
  return { name: '', direction: 'neutral', status: 'Draft', synonyms: [], home_doc_id: homeDocId ?? null };
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
export function MetricFormModal({ machineName, defaultHomeDocId, onClose, onChanged, onCreated, onOpenDoc }: {
  machineName: string | null;                 // null = create
  defaultHomeDocId?: number | null;           // pre-bound SSOT doc for create-from-doc
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
  onCreated?: (machineName: string, name: string) => void;
  onOpenDoc?: (docId: number) => void;
}) {
  const [detail, setDetail] = useState<ManagedMetricDetail | null>(null);
  const [loading, setLoading] = useState(!!machineName);
  const [mode, setMode] = useState<'view' | 'edit'>(machineName ? 'view' : 'edit');
  const [form, setForm] = useState<ManagedMetricWrite>(() => emptyForm(defaultHomeDocId));
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
      .then((m) => { if (on) { setDetail(m); setForm(toForm(m)); setSynText((m.synonyms ?? []).join(', ')); } })
      .catch(() => { if (on) toast.error('Không tải được chỉ số'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [machineName, toForm]);

  const upd = (patch: Partial<ManagedMetricWrite>) => setForm((p) => ({ ...p, ...patch }));

  const save = async () => {
    if (!form.name.trim()) { toast.error('Tên chỉ số không được để trống'); return; }
    setSaving(true);
    try {
      const body: ManagedMetricWrite = {
        ...form,
        synonyms: synText.split(',').map((s) => s.trim()).filter(Boolean),
        target_value: form.target_value == null || (form.target_value as unknown) === '' ? null : Number(form.target_value),
        target_value2: form.target_value2 == null || (form.target_value2 as unknown) === '' ? null : Number(form.target_value2),
      };
      const r = await upsertManagedMetric(body);
      toast.success(form.machine_name ? `Đã cập nhật (v${r.version})` : 'Đã tạo chỉ số quản trị');
      if (onChanged) await onChanged();
      if (form.machine_name) {
        const fresh = await getManagedMetric(r.machine_name); setDetail(fresh); setForm(toForm(fresh)); setMode('view');
      } else {
        onCreated?.(r.machine_name, form.name);
        onClose();
      }
    } catch (e) { toast.error(errDetail(e) || 'Lưu thất bại'); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!detail || !window.confirm(`Xoá chỉ số "${detail.name}"?`)) return;
    setDeleting(true);
    try { await deleteManagedMetric(detail.machine_name); toast.success('Đã xoá'); if (onChanged) await onChanged(); onClose(); }
    catch (e) { toast.error(errDetail(e) || 'Xoá thất bại'); }
    finally { setDeleting(false); }
  };

  const title = machineName ? (detail?.name || 'Chỉ số quản trị') : 'Định nghĩa chỉ số';
  const footer = mode === 'view' && detail ? (
    <>
      <Button variant="ghost" onClick={remove} loading={deleting} leadingIcon={<Trash2 className="h-4 w-4" />}>Xoá</Button>
      <div className="flex-1" />
      <Button variant="secondary" onClick={onClose}>Đóng</Button>
      <Button variant="primary" leadingIcon={<Pencil className="h-4 w-4" />} onClick={() => setMode('edit')}>Sửa</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => (machineName ? setMode('view') : onClose())} disabled={saving}>Huỷ</Button>
      <Button variant="primary" leadingIcon={<Save className="h-4 w-4" />} onClick={save} loading={saving}>Lưu chỉ số</Button>
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
              Chỉ số này sẽ lấy trang tài liệu hiện tại làm <strong className="text-text-primary">nguồn định nghĩa (SSOT)</strong>. Sau khi lưu, thẻ <code className="font-mono">{'{{metric:…}}'}</code> được chèn vào nội dung.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tên chỉ số *" hint="Ví dụ: Tỷ lệ giao đúng hẹn"><Input value={form.name} onChange={(e) => upd({ name: e.target.value })} placeholder="Tên KPI" /></Field>
            <Field label="Nhóm" hint="Ví dụ: Vận hành, Tài chính"><Input value={form.category ?? ''} onChange={(e) => upd({ category: e.target.value })} /></Field>
          </div>
          <Field label="Định nghĩa" hint="Chỉ số này nghĩa là gì (ngôn ngữ nghiệp vụ)"><Textarea rows={2} value={form.definition ?? ''} onChange={(e) => upd({ definition: e.target.value })} /></Field>
          <Field label="Công thức tính" hint="Cách tính, ví dụ: count(đơn đúng hẹn) / count(đơn đã giao) * 100"><Textarea rows={2} value={form.formula ?? ''} onChange={(e) => upd({ formula: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Đơn vị"><Input value={form.unit ?? ''} onChange={(e) => upd({ unit: e.target.value })} placeholder="%, BRL, đơn…" /></Field>
            <Field label="Chu kỳ"><Select value={form.grain ?? ''} onChange={(e) => upd({ grain: e.target.value })}>{GRAINS.map((g) => <option key={g} value={g}>{GRAIN_LABEL[g]}</option>)}</Select></Field>
            <Field label="Chiều tốt"><Select value={form.direction ?? 'neutral'} onChange={(e) => upd({ direction: e.target.value as ManagedMetric['direction'] })}>{DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select></Field>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Điều kiện target"><Select value={form.target_operator ?? ''} onChange={(e) => upd({ target_operator: e.target.value })}>{OPERATORS.map((o) => <option key={o} value={o}>{o || '—'}</option>)}</Select></Field>
            <Field label="Giá trị target"><Input type="number" value={form.target_value ?? ''} onChange={(e) => upd({ target_value: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            {form.target_operator === 'between' && (
              <Field label="Đến"><Input type="number" value={form.target_value2 ?? ''} onChange={(e) => upd({ target_value2: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            )}
            <Field label="Chủ sở hữu"><Input value={form.owner ?? ''} onChange={(e) => upd({ owner: e.target.value })} placeholder="Team / người phụ trách" /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Liên kết dữ liệu (measure/cột)" hint="vd: dataset_table_437.on_time_rate"><Input value={form.measure_ref ?? ''} onChange={(e) => upd({ measure_ref: e.target.value })} /></Field>
            <Field label="Thuật ngữ liên quan (FQN)" hint="glossary.term"><Input value={form.related_term_fqn ?? ''} onChange={(e) => upd({ related_term_fqn: e.target.value })} /></Field>
            <Field label="Trang định nghĩa (doc id)" hint="Trang cẩm nang là nguồn định nghĩa (SSOT)"><Input type="number" value={form.home_doc_id ?? ''} onChange={(e) => upd({ home_doc_id: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cách gọi khác (synonyms)" hint="Ngăn cách bởi dấu phẩy: OTD, giao đúng hẹn"><Input value={synText} onChange={(e) => setSynText(e.target.value)} /></Field>
            <Field label="Trạng thái"><Select value={form.status ?? 'Draft'} onChange={(e) => upd({ status: e.target.value as ManagedMetric['status'] })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
          </div>
        </div>
      )}
    </AppModalShell>
  );
}

function MetricView({ detail, onOpenDoc }: { detail: ManagedMetricDetail; onOpenDoc?: (docId: number) => void }) {
  const lin = detail.lineage;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-tiny', STATUS_TONE[detail.status] || '')}>{detail.status}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">v{detail.version}</span>
        {detail.category && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{detail.category}</span>}
        {detail.grain && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{GRAIN_LABEL[detail.grain] || detail.grain}</span>}
      </div>

      {detail.definition && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Định nghĩa</div>
          <p className="text-caption text-text-secondary">{detail.definition}</p>
        </div>
      )}
      {detail.formula && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
          <div className="mb-1 text-tiny uppercase tracking-[0.08em] text-text-tertiary">Công thức</div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 font-mono text-tiny text-text-secondary">{detail.formula}</pre>
        </div>
      )}

      <div className="grid gap-x-6 gap-y-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 sm:grid-cols-2">
        <Meta label="Đơn vị" value={detail.unit || '—'} />
        <Meta label="Mục tiêu" value={managedTargetLabel(detail)} />
        <Meta label="Chủ sở hữu" value={detail.owner || '—'} />
        <Meta label="Chiều tốt" value={DIRECTIONS.find((d) => d.value === detail.direction)?.label || detail.direction} />
        <Meta label="Liên kết dữ liệu" value={detail.measure_ref || '—'} mono />
        <Meta label="Thuật ngữ" value={detail.related_term_fqn || '—'} mono />
        {detail.synonyms.length > 0 && <Meta label="Cách gọi khác" value={detail.synonyms.join(', ')} />}
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-2 flex items-center gap-1.5 text-tiny uppercase tracking-[0.08em] text-text-tertiary"><Sigma className="h-3.5 w-3.5" />Xuất xứ & mức độ dùng lại</div>
        <div className="space-y-2">
          <div>
            <span className="text-tiny text-text-quaternary">Trang định nghĩa (SSOT)</span>
            {lin?.home_doc ? (
              <button onClick={() => onOpenDoc?.(lin.home_doc!.id)} className="ml-2 inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5 text-tiny text-brand hover:bg-brand/20">
                <BookText className="h-3 w-3" />{lin.home_doc.title}<ArrowUpRight className="h-3 w-3" />
              </button>
            ) : <span className="ml-2 text-tiny text-text-quaternary">Chưa gắn</span>}
          </div>
          <div>
            <span className="text-tiny text-text-quaternary">Được dùng lại tại {lin?.used_in.length || 0} trang</span>
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
