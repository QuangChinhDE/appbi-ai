/**
 * WorkboardWebhooksTab — admin UI for outbound webhook configs + sync
 * run history. Two sub-tabs: Endpoints (CRUD + Send test) and History
 * (paginated runs with filters).
 */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook as WebhookIcon,
  XCircle,
} from 'lucide-react';

import {
  workboardWebhookApi,
  type SyncRunRow,
  type SyncRunStatus,
  type WebhookConfig,
  type WebhookCreateInput,
} from '@/lib/api/workboard-webhooks';
import { useWorkboard } from '@/hooks/use-workboards';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/lib/toast';

type DocScreenStub = { id: string; title: string };

function extractDocScreens(layoutJson: unknown): DocScreenStub[] {
  const raw = (layoutJson as { screens?: unknown[] } | null | undefined)?.screens;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is { id: string; kind: string; title?: string } =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as { id?: unknown }).id === 'string' &&
        (s as { kind?: unknown }).kind === 'doc',
    )
    .map((s) => ({ id: s.id, title: s.title || s.id }));
}

interface Props {
  workboardId: number;
}

type SubTab = 'endpoints' | 'history';

const STATUS_LABELS: Record<SyncRunStatus, string> = {
  pending: 'Đang chờ',
  running: 'Đang chạy',
  success: 'Thành công',
  failed: 'Thất bại',
  partial: 'Một phần',
  cancelled: 'Đã huỷ',
};

const STATUS_TONE: Record<SyncRunStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  running: 'bg-sky-100 text-sky-700',
  success: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  partial: 'bg-orange-100 text-orange-700',
  cancelled: 'bg-slate-100 text-slate-600',
};

function emptyCreate(defaultScreenId: string): WebhookCreateInput {
  return {
    name: '',
    url: '',
    screen_id: defaultScreenId,
    headers: [],
    batch_size: 500,
    delay_between_batches_ms: 0,
    timeout_ms: 15000,
    stop_on_error: true,
    is_active: true,
    description: '',
  };
}

function WebhookSubTabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-surface-1 text-brand shadow-linear-sm'
          : 'text-text-tertiary hover:bg-surface-1'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export default function WorkboardWebhooksTab({ workboardId }: Props) {
  const [subTab, setSubTab] = useState<SubTab>('endpoints');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2">
        <div className="inline-flex items-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <WebhookSubTabButton
            active={subTab === 'endpoints'}
            onClick={() => setSubTab('endpoints')}
            icon={<WebhookIcon className="h-3.5 w-3.5" />}
          >
            Endpoints
          </WebhookSubTabButton>
          <WebhookSubTabButton
            active={subTab === 'history'}
            onClick={() => setSubTab('history')}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            History
          </WebhookSubTabButton>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {subTab === 'endpoints' ? (
          <EndpointsPane workboardId={workboardId} />
        ) : (
          <HistoryPane workboardId={workboardId} />
        )}
      </div>
    </div>
  );
}

// ── Endpoints ────────────────────────────────────────────────────────────

function EndpointsPane({ workboardId }: { workboardId: number }) {
  const [items, setItems] = useState<WebhookConfig[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WebhookConfig | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: workboard } = useWorkboard(workboardId);
  const docScreens = useMemo(
    () => extractDocScreens(workboard?.layout_json),
    [workboard?.layout_json],
  );
  const docScreenById = useMemo(() => {
    const map = new Map<string, DocScreenStub>();
    docScreens.forEach((s) => map.set(s.id, s));
    return map;
  }, [docScreens]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await workboardWebhookApi.list(workboardId);
      setItems(data);
    } catch (err) {
      toast.error('Không tải được danh sách webhook');
    } finally {
      setLoading(false);
    }
  }, [workboardId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && items === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Outbound webhooks</h2>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Cấu hình các endpoint nhận dữ liệu khi user bấm Sync trên doc.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} leadingIcon={<Plus className="h-4 w-4" />}>
          Thêm webhook
        </Button>
      </div>

      {items && items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[rgb(var(--border-line))] py-10 text-text-tertiary">
          <WebhookIcon className="h-7 w-7" />
          <p className="text-sm">Chưa có webhook nào.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-text-tertiary">
              <tr>
                <th className="px-3 py-2 text-left">Tên</th>
                <th className="px-3 py-2 text-left">Doc screen</th>
                <th className="px-3 py-2 text-left">URL</th>
                <th className="px-3 py-2 text-left">Batch</th>
                <th className="px-3 py-2 text-left">Trạng thái</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items?.map((w) => {
                const screen = w.screen_id ? docScreenById.get(w.screen_id) : null;
                const orphaned = w.screen_id && !screen;
                return (
                <tr key={w.id} className="border-t border-[rgb(var(--border-line))]">
                  <td className="px-3 py-2">
                    <div className="font-medium text-text-primary">{w.name}</div>
                    <div className="text-xs text-text-tertiary">{w.id}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {screen ? (
                      <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">
                        <FileText className="h-3 w-3" />
                        {screen.title}
                      </span>
                    ) : orphaned ? (
                      <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">
                        <AlertTriangle className="h-3 w-3" />
                        Screen đã xoá ({w.screen_id})
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                        <AlertTriangle className="h-3 w-3" />
                        Chưa gán
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary">
                    <code className="break-all">{w.url}</code>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {w.batch_size}
                    {w.delay_between_batches_ms > 0 && (
                      <span className="text-text-tertiary">
                        {' '}
                        · {w.delay_between_batches_ms}ms
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {w.is_active ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" />
                        Đang bật
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                        <XCircle className="h-3 w-3" />
                        Tắt
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(w)}
                      className="rounded p-1 text-text-tertiary hover:bg-surface-2"
                      title="Sửa"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm(`Xoá webhook "${w.name}"?`)) return;
                        try {
                          await workboardWebhookApi.remove(workboardId, w.id);
                          toast.success('Đã xoá');
                          load();
                        } catch {
                          toast.error('Xoá thất bại');
                        }
                      }}
                      className="rounded p-1 text-rose-500 hover:bg-rose-50"
                      title="Xoá"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <WebhookEditorModal
          workboardId={workboardId}
          initial={editing}
          docScreens={docScreens}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function WebhookEditorModal({
  workboardId,
  initial,
  docScreens,
  onClose,
  onSaved,
}: {
  workboardId: number;
  initial: WebhookConfig | null;
  docScreens: DocScreenStub[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<WebhookCreateInput>(() =>
    initial
      ? {
          name: initial.name,
          url: initial.url,
          screen_id: initial.screen_id || (docScreens[0]?.id ?? ''),
          headers: initial.headers,
          batch_size: initial.batch_size,
          delay_between_batches_ms: initial.delay_between_batches_ms,
          timeout_ms: initial.timeout_ms,
          stop_on_error: initial.stop_on_error,
          is_active: initial.is_active,
          description: initial.description ?? '',
        }
      : emptyCreate(docScreens[0]?.id ?? ''),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number | null;
    error?: string;
    duration_ms: number;
  } | null>(null);

  const onSave = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      toast.error('Tên và URL bắt buộc');
      return;
    }
    if (!form.screen_id) {
      toast.error('Chọn doc screen mà webhook này phục vụ');
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await workboardWebhookApi.update(workboardId, initial.id, form);
        toast.success('Đã cập nhật webhook');
      } else {
        await workboardWebhookApi.create(workboardId, form);
        toast.success('Đã tạo webhook');
      }
      onSaved();
    } catch (err) {
      const msg =
        (err as { response?: { data?: { detail?: string } } }).response?.data?.detail ||
        'Lưu thất bại';
      toast.error(String(msg));
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (!initial) {
      toast.error('Lưu webhook trước khi test.');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await workboardWebhookApi.test(workboardId, initial.id);
      setTestResult({
        ok: r.ok,
        status: r.status,
        error: r.error,
        duration_ms: r.duration_ms,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        status: null,
        error: String((err as Error).message || 'Lỗi không xác định'),
        duration_ms: 0,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface-1 shadow-xl">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {initial ? 'Sửa webhook' : 'Tạo webhook'}
          </h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-surface-2">
            <XCircle className="h-4 w-4 text-text-tertiary" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <Field label="Tên webhook *">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="VD: Đẩy ca sản xuất lên ERP"
            />
          </Field>
          <Field label="Phục vụ doc screen *">
            {docScreens.length === 0 ? (
              <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                Workboard này chưa có doc screen nào. Tạo doc screen trong Builder trước.
              </p>
            ) : (
              <select
                value={form.screen_id}
                onChange={(e) => setForm({ ...form, screen_id: e.target.value })}
                className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm"
              >
                <option value="">— Chọn doc screen —</option>
                {docScreens.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.id})
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-[11px] text-text-tertiary">
              Webhook chỉ nhận dữ liệu từ doc này — nó được thiết kế cho row shape
              của doc cụ thể, không tái dùng giữa các doc.
            </p>
          </Field>
          <Field label="URL *">
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://n8n.local/webhook/abc"
            />
          </Field>
          <Field label="Mô tả">
            <textarea
              value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-sm"
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Batch size (≤ 500)">
              <Input
                type="number"
                value={form.batch_size}
                onChange={(e) =>
                  setForm({
                    ...form,
                    batch_size: Math.max(
                      1,
                      Math.min(500, Number(e.target.value || 0) || 1),
                    ),
                  })
                }
              />
            </Field>
            <Field label="Delay giữa batch (ms)">
              <Input
                type="number"
                value={form.delay_between_batches_ms}
                onChange={(e) =>
                  setForm({
                    ...form,
                    delay_between_batches_ms: Math.max(
                      0,
                      Number(e.target.value || 0) || 0,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                value={form.timeout_ms}
                onChange={(e) =>
                  setForm({
                    ...form,
                    timeout_ms: Math.max(1000, Number(e.target.value || 0) || 15000),
                  })
                }
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              Đang bật
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.stop_on_error}
                onChange={(e) => setForm({ ...form, stop_on_error: e.target.checked })}
              />
              Dừng khi batch lỗi
            </label>
          </div>

          <Field label="Headers (key-value)">
            <div className="space-y-1.5">
              {form.headers.map((h, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={h.key}
                    placeholder="Authorization"
                    onChange={(e) => {
                      const next = [...form.headers];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setForm({ ...form, headers: next });
                    }}
                  />
                  <Input
                    value={h.value}
                    placeholder="Bearer xxx"
                    onChange={(e) => {
                      const next = [...form.headers];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setForm({ ...form, headers: next });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...form.headers];
                      next.splice(idx, 1);
                      setForm({ ...form, headers: next });
                    }}
                    className="rounded p-1 text-rose-500 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setForm({
                    ...form,
                    headers: [...form.headers, { key: '', value: '' }],
                  })
                }
                className="inline-flex items-center gap-1 rounded border border-dashed border-[rgb(var(--border-line))] px-2 py-1 text-xs text-text-tertiary hover:bg-surface-2"
              >
                <Plus className="h-3 w-3" />
                Thêm header
              </button>
              <p className="text-[11px] text-text-tertiary">
                Lưu ý: headers được lưu plaintext trong workboard settings. Đừng đặt
                secret quá nhạy cảm, ưu tiên dùng URL có token hoặc IP whitelist
                phía endpoint.
              </p>
            </div>
          </Field>

          {testResult && (
            <div
              className={`rounded border p-2 text-xs ${
                testResult.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                  Test OK · HTTP {testResult.status} · {testResult.duration_ms}ms
                </>
              ) : (
                <>
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  Test thất bại · HTTP {testResult.status ?? '—'} ·{' '}
                  {testResult.error ?? 'lỗi không xác định'}
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
          <button
            type="button"
            onClick={onTest}
            disabled={!initial || testing}
            className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-xs font-medium disabled:opacity-60"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Gửi test
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-xs"
            >
              Huỷ
            </button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Lưu'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

// ── History ──────────────────────────────────────────────────────────────

function HistoryPane({ workboardId }: { workboardId: number }) {
  const [rows, setRows] = useState<SyncRunRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<SyncRunStatus | ''>('');
  const [selected, setSelected] = useState<SyncRunRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await workboardWebhookApi.listRuns(workboardId, {
        status: statusFilter || undefined,
        limit: 100,
      });
      setRows(data);
    } catch {
      toast.error('Không tải được lịch sử sync');
    } finally {
      setLoading(false);
    }
  }, [workboardId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SyncRunStatus | '')}
          className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="">Tất cả trạng thái</option>
          {(Object.keys(STATUS_LABELS) as SyncRunStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>

      {loading && rows === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] py-10 text-center text-sm text-text-tertiary">
          Chưa có lượt đồng bộ nào.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))]">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-text-tertiary">
              <tr>
                <th className="px-3 py-2 text-left">Thời điểm</th>
                <th className="px-3 py-2 text-left">Webhook</th>
                <th className="px-3 py-2 text-left">Screen / Block</th>
                <th className="px-3 py-2 text-left">Tiến độ</th>
                <th className="px-3 py-2 text-left">Trạng thái</th>
                <th className="px-3 py-2 text-left">HTTP</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr
                  key={r.run_id}
                  className="cursor-pointer border-t border-[rgb(var(--border-line))] hover:bg-surface-2"
                  onClick={() => setSelected(r)}
                >
                  <td className="px-3 py-2 text-xs">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.webhook_name || r.webhook_id}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.screen_id} · #{r.block_index + 1}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.completed_batches + r.failed_batches}/{r.total_batches}
                    {r.failed_batches > 0 && (
                      <span className="ml-1 text-rose-600">({r.failed_batches} lỗi)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] ${STATUS_TONE[r.status]}`}
                    >
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.last_response_status ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(r.status === 'pending' || r.status === 'running') && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await workboardWebhookApi.cancelRun(workboardId, r.run_id);
                            toast.success('Đã yêu cầu huỷ');
                            load();
                          } catch {
                            toast.error('Huỷ thất bại');
                          }
                        }}
                        className="rounded p-1 text-rose-500 hover:bg-rose-50"
                        title="Huỷ"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SyncRunDetailModal
          workboardId={workboardId}
          runId={selected.run_id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function SyncRunDetailModal({
  workboardId,
  runId,
  onClose,
}: {
  workboardId: number;
  runId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof workboardWebhookApi.getRun>
  > | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await workboardWebhookApi.getRun(workboardId, runId);
        if (!cancelled) setDetail(d);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workboardId, runId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface-1 shadow-xl">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] px-4 py-3">
          <h3 className="text-sm font-semibold">Chi tiết sync run</h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-surface-2">
            <XCircle className="h-4 w-4 text-text-tertiary" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 text-sm">
          {loading || !detail ? (
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-text-tertiary" />
          ) : (
            <dl className="grid grid-cols-2 gap-y-2 text-xs">
              <DT label="Run ID">{detail.run_id}</DT>
              <DT label="Trạng thái">
                <span
                  className={`rounded px-1.5 py-0.5 ${STATUS_TONE[detail.status]}`}
                >
                  {STATUS_LABELS[detail.status]}
                </span>
              </DT>
              <DT label="Webhook">{detail.webhook_name || detail.webhook_id}</DT>
              <DT label="URL">
                <code className="break-all">{detail.webhook_url}</code>
              </DT>
              <DT label="Screen / Block">
                {detail.screen_id} · #{detail.block_index + 1}
              </DT>
              <DT label="Trigger">{detail.trigger_id}</DT>
              <DT label="Rows">{detail.total_rows}</DT>
              <DT label="Batches">
                {detail.completed_batches + detail.failed_batches} /{' '}
                {detail.total_batches} ({detail.failed_batches} lỗi)
              </DT>
              <DT label="HTTP cuối">{detail.last_response_status ?? '—'}</DT>
              <DT label="Duration">
                {detail.duration_ms ? `${detail.duration_ms} ms` : '—'}
              </DT>
              {detail.last_error && (
                <div className="col-span-2 rounded border border-rose-200 bg-rose-50 p-2 text-rose-700">
                  {detail.last_error}
                </div>
              )}
              {detail.response_excerpt && (
                <div className="col-span-2">
                  <div className="mb-1 text-text-tertiary">Response (cắt 2KB)</div>
                  <pre className="max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px]">
                    {JSON.stringify(detail.response_excerpt, null, 2)}
                  </pre>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

function DT({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="break-all text-text-primary">{children}</dd>
    </>
  );
}
