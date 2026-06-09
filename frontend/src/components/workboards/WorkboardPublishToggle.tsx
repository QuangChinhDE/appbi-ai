/**
 * WorkboardPublishToggle — the single source of truth for the Draft ⇄ Published
 * control, shown in two places with one behaviour:
 *   - variant="pill"  → builder topbar (status pill + click to toggle)
 *   - variant="icon"  → list/grid row action (matches Share/Delete IconButtons)
 *
 * Publishing is one-click (non-destructive). Un-publishing hides the app from
 * public links, so it asks for confirmation first. Uses the existing
 * usePublishWorkboard / useUpdateWorkboard mutations so the React Query cache
 * stays in sync everywhere the workboard is shown.
 */
'use client';

import React, { useState } from 'react';
import { Globe2, Loader2, PencilLine } from 'lucide-react';

import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { usePublishWorkboard, useUpdateWorkboard } from '@/hooks/use-workboards';
import type { Workboard } from '@/lib/api/workboards';

function apiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof detail === 'string' && detail.trim() ? detail : fallback;
}

interface Props {
  workboard: Pick<Workboard, 'id' | 'name' | 'is_published'>;
  variant: 'pill' | 'icon';
  /** Hide when the viewer can't edit (list passes canEdit). */
  canEdit?: boolean;
}

export function WorkboardPublishToggle({ workboard, variant, canEdit = true }: Props) {
  const publish = usePublishWorkboard();
  const update = useUpdateWorkboard();
  const [confirmingDraft, setConfirmingDraft] = useState(false);

  const published = !!workboard.is_published;
  const busy = publish.isPending || update.isPending;

  if (!canEdit) {
    // Read-only viewers still see the state, just can't change it.
    return variant === 'pill' ? <StatePill published={published} muted /> : null;
  }

  const doPublish = async () => {
    try {
      await publish.mutateAsync(workboard.id);
      toast.success('Đã xuất bản — app hiển thị qua link công khai');
    } catch (err) {
      // Surface the BE's actionable reason (e.g. "đổi PIN mặc định cho owner…")
      // instead of a generic failure, so the user knows what to fix.
      toast.error(apiErrorMessage(err, 'Không xuất bản được'));
    }
  };

  const doDraft = async () => {
    setConfirmingDraft(false);
    try {
      await update.mutateAsync({ id: workboard.id, data: { is_published: false } });
      toast.success('Đã chuyển về Bản nháp — ẩn khỏi link công khai');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Không chuyển về nháp được'));
    }
  };

  const onClick = () => {
    if (busy) return;
    if (published) setConfirmingDraft(true);
    else doPublish();
  };

  const confirmModal = confirmingDraft ? (
    <Modal
      isOpen
      onClose={() => setConfirmingDraft(false)}
      title="Chuyển về Bản nháp?"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDraft(false)}>
            Huỷ
          </Button>
          <Button variant="danger" size="sm" onClick={doDraft} loading={update.isPending}>
            Chuyển về nháp
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-secondary">
        App <strong>{workboard.name}</strong> sẽ <strong>ẩn khỏi mọi link công khai</strong> —
        người dùng đang dùng sẽ không vào được nữa cho tới khi bạn xuất bản lại. Dữ liệu
        không bị mất.
      </p>
    </Modal>
  ) : null;

  if (variant === 'icon') {
    return (
      <>
        <IconButton
          aria-label={published ? 'Chuyển về Bản nháp' : 'Xuất bản'}
          title={published ? 'Đã xuất bản — bấm để chuyển về nháp' : 'Bản nháp — bấm để xuất bản'}
          variant="ghost"
          size="xs"
          onClick={onClick}
          disabled={busy}
          className={published ? 'text-success hover:bg-success/10' : 'text-text-tertiary hover:bg-surface-2'}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : published ? (
            <Globe2 className="h-3.5 w-3.5" />
          ) : (
            <PencilLine className="h-3.5 w-3.5" />
          )}
        </IconButton>
        {confirmModal}
      </>
    );
  }

  // pill variant (topbar)
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={published ? 'Đã xuất bản — bấm để chuyển về nháp' : 'Bản nháp — bấm để xuất bản'}
        className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-2 disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin text-text-tertiary" />
        ) : (
          <span
            className={`h-1.5 w-1.5 rounded-full ${published ? 'bg-success' : 'bg-warning'}`}
          />
        )}
        <span className={published ? 'text-success' : 'text-warning'}>
          {published ? 'Đã xuất bản' : 'Bản nháp'}
        </span>
      </button>
      {confirmModal}
    </>
  );
}

function StatePill({ published, muted }: { published: boolean; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium ${
        muted ? 'opacity-80' : ''
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${published ? 'bg-success' : 'bg-warning'}`} />
      <span className={published ? 'text-success' : 'text-warning'}>
        {published ? 'Đã xuất bản' : 'Bản nháp'}
      </span>
    </span>
  );
}
