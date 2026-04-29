/**
 * WorkboardAppUsersTab — manages end-user accounts that log into the
 * workboard's public link. Identity lives in AppBI's own DB
 * (``workboard_app_users``) so this tab is self-sufficient — no dataset
 * wiring required.
 *
 * The form supports an arbitrary "context" key/value bag because RLS
 * rules read ``{{app_user.<key>}}`` for vertical-specific fields
 * (``nong_trai_id``, ``clinic_id``, etc.). Suggested keys are picked up
 * from the workboard's existing layout — saves admins from hunting
 * through screens to remember what placeholders they wrote.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserCircle2,
  X,
} from 'lucide-react';

import {
  workboardApi,
  type Workboard,
  type WorkboardAppUserCreate,
  type WorkboardAppUserResponse,
  type WorkboardAppUserUpdate,
} from '@/lib/api/workboards';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';

interface Props {
  workboard: Workboard;
}

interface ApiError {
  response?: { data?: { detail?: string | { message?: string } } };
}

function getApiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as ApiError)?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: string }).message);
  }
  return fallback;
}

function collectContextKeySuggestions(workboard: Workboard): string[] {
  const seen = new Set<string>();
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      const matches = node.match(/\{\{\s*app_user\.([a-zA-Z0-9_]+)\s*\}\}/g);
      if (matches) {
        for (const m of matches) {
          const key = m.replace(/[{}\s]/g, '').replace(/^app_user\./, '');
          if (key && key !== 'username' && key !== 'role' && key !== 'full_name') {
            seen.add(key);
          }
        }
      }
    } else if (Array.isArray(node)) {
      for (const v of node) visit(v);
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) visit(v);
    }
  };
  visit(workboard.layout_json);
  return Array.from(seen).sort();
}

export default function WorkboardAppUsersTab({ workboard }: Props) {
  const [users, setUsers] = useState<WorkboardAppUserResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<WorkboardAppUserResponse | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkboardAppUserResponse | null>(null);

  const contextSuggestions = useMemo(
    () => collectContextKeySuggestions(workboard),
    [workboard],
  );

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await workboardApi.listAppUsers(workboard.id);
      setUsers(r);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Không tải được danh sách users.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workboard.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.username, u.full_name, u.role]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [users, search]);

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5">
        <UserCircle2 className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-medium text-text-primary">App users</h2>
        <span className="text-tiny text-text-tertiary">
          {users.length} {users.length === 1 ? 'user' : 'users'} đăng nhập được
          mini-app này
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quaternary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo username, tên, role…"
            className="h-7 w-56 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 pl-7 pr-2 text-tiny"
          />
        </div>
        <Button size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
          Thêm user
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-caption text-danger">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-8 text-center">
            <UserCircle2 className="mx-auto h-8 w-8 text-text-quaternary" />
            <p className="mt-2 text-caption text-text-secondary">
              {users.length === 0
                ? 'Chưa có user nào. Bấm "Thêm user" để tạo tài khoản đầu tiên.'
                : 'Không có user nào khớp tìm kiếm.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
            <table className="w-full text-caption">
              <thead className="border-b border-[rgb(var(--border-line))] bg-surface-2 text-tiny text-text-tertiary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Username</th>
                  <th className="px-3 py-2 text-left font-medium">Full name</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">Context</th>
                  <th className="px-3 py-2 text-left font-medium">Active</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[rgb(var(--border-line))] last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 font-medium text-text-primary">{u.username}</td>
                    <td className="px-3 py-2 text-text-secondary">{u.full_name || '—'}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {u.role ? (
                        <span className="inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 text-tiny">
                          {u.role}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-tiny text-text-tertiary">
                      {Object.keys(u.context || {}).length === 0
                        ? '—'
                        : Object.entries(u.context)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(', ')}
                    </td>
                    <td className="px-3 py-2">
                      {u.active ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <span className="text-tiny text-text-tertiary">tắt</span>
                      )}
                      {!u.has_pin && (
                        <span
                          title="Chưa có PIN — admin cần reset trước khi user login được"
                          className="ml-1.5 inline-flex rounded bg-warning/10 px-1.5 py-0.5 text-tiny text-warning"
                        >
                          chưa PIN
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setEditing(u)}
                        className="mr-1 rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                        title="Sửa"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(u)}
                        className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                        title="Xoá"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <AppUserEditModal
          workboardId={workboard.id}
          user={editing === 'new' ? null : editing}
          contextSuggestions={contextSuggestions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void loadUsers();
          }}
        />
      )}

      {pendingDelete && (
        <Modal
          isOpen
          onClose={() => setPendingDelete(null)}
          title={`Xoá user "${pendingDelete.username}"?`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                Huỷ
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  try {
                    await workboardApi.deleteAppUser(workboard.id, pendingDelete.id);
                    toast.success('Đã xoá user');
                    setPendingDelete(null);
                    void loadUsers();
                  } catch (err) {
                    toast.error(getApiErrorMessage(err, 'Xoá thất bại.'));
                  }
                }}
              >
                Xoá
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            Tài khoản này sẽ không đăng nhập được nữa. Hành động này không thể hoàn tác.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ── Edit / create modal ──────────────────────────────────────────────────

interface ContextRow {
  key: string;
  value: string;
}

function AppUserEditModal({
  workboardId,
  user,
  contextSuggestions,
  onClose,
  onSaved,
}: {
  workboardId: number;
  user: WorkboardAppUserResponse | null;
  contextSuggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = user === null;
  const [username, setUsername] = useState(user?.username ?? '');
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [role, setRole] = useState(user?.role ?? '');
  const [active, setActive] = useState(user?.active ?? true);
  const [pin, setPin] = useState('');
  const [contextRows, setContextRows] = useState<ContextRow[]>(() => {
    const seed = Object.entries(user?.context ?? {}).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
    if (seed.length === 0) {
      return contextSuggestions.map((key) => ({ key, value: '' }));
    }
    // Append any suggestion the user hasn't filled yet.
    for (const sug of contextSuggestions) {
      if (!seed.some((row) => row.key === sug)) seed.push({ key: sug, value: '' });
    }
    return seed;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRow = (idx: number, patch: Partial<ContextRow>) => {
    setContextRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const addRow = () => setContextRows((rows) => [...rows, { key: '', value: '' }]);
  const removeRow = (idx: number) =>
    setContextRows((rows) => rows.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setError(null);
    if (!username.trim()) {
      setError('Username không được rỗng.');
      return;
    }
    if (isCreate && !pin) {
      setError('PIN bắt buộc khi tạo user mới.');
      return;
    }
    const context: Record<string, unknown> = {};
    for (const row of contextRows) {
      const k = row.key.trim();
      if (!k) continue;
      context[k] = row.value;
    }
    setSubmitting(true);
    try {
      if (isCreate) {
        const payload: WorkboardAppUserCreate = {
          username: username.trim(),
          pin,
          full_name: fullName || null,
          role: role || null,
          active,
          context,
        };
        await workboardApi.createAppUser(workboardId, payload);
        toast.success('Đã tạo user');
      } else {
        const payload: WorkboardAppUserUpdate = {
          username: username.trim(),
          full_name: fullName || null,
          role: role || null,
          active,
          context,
        };
        if (pin) payload.pin = pin;
        await workboardApi.updateAppUser(workboardId, user!.id, payload);
        toast.success('Đã cập nhật user');
      }
      onSaved();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Lưu thất bại.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isCreate ? 'Tạo user mới' : `Sửa user "${user?.username}"`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} loading={submitting} disabled={submitting}>
            {isCreate ? 'Tạo' : 'Lưu'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Username *</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="vd: cn01"
              autoFocus={isCreate}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">
              {isCreate ? 'PIN *' : 'PIN (để trống = giữ nguyên)'}
            </span>
            <Input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder={isCreate ? 'PIN đăng nhập' : 'Đặt PIN mới…'}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Full name</span>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Nguyễn Văn A"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-text-secondary">Role</span>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="vd: team_lead"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-caption text-text-secondary">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Active (cho phép đăng nhập)
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-tiny font-medium text-text-secondary">
              Context (cho RLS — {'{{app_user.<key>}}'})
            </span>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1 text-tiny text-brand hover:underline"
            >
              <Plus className="h-3 w-3" /> Thêm key
            </button>
          </div>
          {contextRows.length === 0 ? (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-2 text-tiny text-text-tertiary">
              Chưa có context. Thêm các key cho RLS placeholder.
            </p>
          ) : (
            <div className="space-y-1">
              {contextRows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <Input
                    value={row.key}
                    onChange={(e) => updateRow(idx, { key: e.target.value })}
                    placeholder="key (vd: nong_trai_id)"
                    className="flex-1"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => updateRow(idx, { value: e.target.value })}
                    placeholder="value"
                    className="flex-1"
                  />
                  <button
                    onClick={() => removeRow(idx)}
                    className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                    title="Xoá row"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {contextSuggestions.length > 0 && (
            <p className="mt-1 text-tiny text-text-tertiary">
              Gợi ý từ layout: {contextSuggestions.map((k) => <code key={k} className="mx-0.5 rounded bg-surface-2 px-1">{k}</code>)}
            </p>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-danger/30 bg-danger/5 p-2 text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
