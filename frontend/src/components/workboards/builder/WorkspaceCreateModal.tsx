'use client';

/**
 * WorkspaceCreateModal — create a new workspace from inside the workboard
 * builder. The new workspace's menu is pre-filled with the current workboard
 * (access_mode defaults to public_app_users on the BE), so the board is
 * immediately reachable + the live preview can switch to it.
 */
import React, { useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { workspaceAdminApi, type WorkspaceAdmin } from '@/lib/api/workspaces';

function errorDetail(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

interface Props {
  workboardName: string;
  workboardSlug: string;
  workboardIcon?: string | null;
  workboardDescription?: string | null;
  onClose: () => void;
  onCreated: (ws: WorkspaceAdmin) => void;
}

export function WorkspaceCreateModal({
  workboardName,
  workboardSlug,
  workboardIcon,
  workboardDescription,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState(`${workboardName} – cổng`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Nhập tên cổng.');
      return;
    }
    if (!workboardSlug) {
      setError('App chưa có slug — lưu app trước khi tạo cổng.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await workspaceAdminApi.createWithWorkboard({
        name: trimmed,
        workboardSlug,
        // label MUST be non-empty (public menu validator drops empty-label cards)
        workboardLabel: workboardName?.trim() || workboardSlug,
        workboardIcon: workboardIcon ?? null,
        workboardDescription: workboardDescription ?? null,
      });
      onCreated(ws);
      onClose();
    } catch (err) {
      setError(errorDetail(err, 'Không thể tạo cổng.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Tạo cổng công khai mới"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Huỷ
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>
            Tạo cổng
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-caption font-emphasis text-text-secondary">
        Tên cổng (link công khai)
      </label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder="VD: Cổng vận hành công trường"
        className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus-visible:shadow-focus-brand focus-visible:outline-none"
      />
      <p className="mt-2 text-caption text-text-tertiary">
        App “{workboardName}” sẽ tự động được thêm vào menu của cổng này.
      </p>
      <p className="mt-1 text-caption text-text-quaternary">
        Cổng là một link công khai (<code>/ws/…</code>) cho người dùng cuối đăng nhập
        bằng PIN. Khác với “Workspace” — đó là nhóm màn hình bên trong app.
      </p>
      {error && <p className="mt-2 text-caption text-danger">Lỗi: {error}</p>}
    </Modal>
  );
}
