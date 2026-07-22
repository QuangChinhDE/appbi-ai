/**
 * WorkboardPublishToggle — the single source of truth for the Draft ⇄ Live
 * control, shown in two places with one behaviour:
 *   - variant="pill"  → builder topbar (status pill + click to act)
 *   - variant="icon"  → list/grid row action (matches Share/Delete IconButtons)
 *
 * Three lifecycle states (BE-computed ``publish_status``):
 *   draft                      → click Publishes (Go live)
 *   live                       → click asks to un-publish (hides from public)
 *   live_unpublished_changes   → draft moved ahead of live; click re-publishes
 *
 * Publishing flushes the builder's autosave first (so the promotion snapshots
 * the latest draft) and is gated server-side by the readiness audit — blocking
 * errors come back as 422 and are shown in a modal instead of a toast.
 */
'use client';

import React, { useState } from 'react';
import { AlertTriangle, Globe2, Loader2, PencilLine, UploadCloud } from 'lucide-react';

import { Button, IconButton } from '@/components/ui/Button';
import { FilterTag } from '@/components/ui/FilterTag';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { usePublishWorkboard, useUnpublishWorkboard } from '@/hooks/use-workboards';
import { useI18n } from '@/providers/LanguageProvider';
import type { Workboard } from '@/lib/api/workboards';
import { flushPendingAutosave } from './builder/autosaveFlushRegistry';

type PublishStatus = 'draft' | 'live' | 'live_unpublished_changes';

interface AuditIssue {
  severity: string;
  screen_title?: string | null;
  screen_id?: string | null;
  code: string;
  detail: string;
}
interface AuditResult {
  ok: boolean;
  issue_count: number;
  issues: AuditIssue[];
}

function apiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  // Publish 422 returns detail = { message, audit }. Prefer the message.
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return fallback;
}

interface Props {
  workboard: Pick<
    Workboard,
    'id' | 'name' | 'is_published' | 'publish_status' | 'version' | 'published_version'
  >;
  variant: 'pill' | 'icon' | 'topbar';
  /** Hide when the viewer can't edit (list passes canEdit). */
  canEdit?: boolean;
}

function statusOf(wb: Props['workboard']): PublishStatus {
  if (wb.publish_status) return wb.publish_status;
  // Fallback for any caller without the computed field.
  if (!wb.is_published) return 'draft';
  if (
    typeof wb.version === 'number' &&
    typeof wb.published_version === 'number' &&
    wb.version > wb.published_version
  ) {
    return 'live_unpublished_changes';
  }
  return 'live';
}

export function WorkboardPublishToggle({ workboard, variant, canEdit = true }: Props) {
  const { t } = useI18n();
  const publish = usePublishWorkboard();
  const unpublish = useUnpublishWorkboard();
  const [confirmingDraft, setConfirmingDraft] = useState(false);
  const [auditBlock, setAuditBlock] = useState<AuditResult | null>(null);

  const status = statusOf(workboard);
  const busy = publish.isPending || unpublish.isPending;

  if (!canEdit) {
    // Read-only viewers still see the state, just can't change it.
    return variant === 'pill' ? <StatePill status={status} /> : null;
  }

  const doPublish = async () => {
    try {
      // Snapshot the LATEST draft: drain any debounced/in-flight autosave first.
      await flushPendingAutosave();
      await publish.mutateAsync(workboard.id);
      toast.success(t('workboards.publish.publishedToast'));
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      if (detail && typeof detail === 'object' && (detail as { audit?: unknown }).audit) {
        // Readiness gate blocked publish — show the fixable errors.
        setAuditBlock((detail as { audit: AuditResult }).audit);
        return;
      }
      toast.error(apiErrorMessage(err, t('workboards.publish.publishFailed')));
    }
  };

  const doDraft = async () => {
    setConfirmingDraft(false);
    try {
      await unpublish.mutateAsync(workboard.id);
      toast.success(t('workboards.publish.draftToast'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('workboards.publish.draftFailed')));
    }
  };

  const onClick = () => {
    if (busy) return;
    // Clean live → un-publish (confirm). Draft or unpublished-changes → publish.
    if (status === 'live') setConfirmingDraft(true);
    else void doPublish();
  };

  const confirmModal = confirmingDraft ? (
    <Modal
      isOpen
      onClose={() => setConfirmingDraft(false)}
      title={t('workboards.publish.confirmTitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDraft(false)}>
            {t('workboards.publish.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={doDraft} loading={unpublish.isPending}>
            {t('workboards.publish.confirmDraft')}
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-secondary">
        {t('workboards.publish.confirmDescriptionPrefix')} <strong>{workboard.name}</strong>{' '}
        {t('workboards.publish.confirmDescriptionMiddle')}{' '}
        <strong>{t('workboards.publish.hiddenFromPublicLinks')}</strong>{' '}
        {t('workboards.publish.confirmDescriptionSuffix')}
      </p>
    </Modal>
  ) : null;

  const errorIssues = (auditBlock?.issues || []).filter((i) => i.severity === 'error');
  const auditModal = auditBlock ? (
    <Modal
      isOpen
      onClose={() => setAuditBlock(null)}
      title="Chưa thể xuất bản"
      size="sm"
      footer={
        <Button variant="ghost" size="sm" onClick={() => setAuditBlock(null)}>
          Đóng
        </Button>
      }
    >
      <p className="mb-3 text-caption text-text-secondary">
        Ứng dụng còn {errorIssues.length} lỗi chặn. Sửa hết rồi xuất bản lại:
      </p>
      <ul className="space-y-2">
        {errorIssues.map((issue, idx) => (
          <li
            key={idx}
            className="flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              <strong>{issue.screen_title || issue.screen_id || '—'}</strong>: {issue.detail}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  ) : null;

  if (variant === 'topbar') {
    // P1 IA: status is separated from action. The pill only REPORTS state; a
    // distinct primary button performs the actionable transition. Unpublish is
    // demoted to the topbar overflow (···) so the destructive action isn't one
    // stray click away. Clean "live" shows just the pill (nothing to do here).
    const action =
      status === 'draft'
        ? { label: t('workboards.publish.goLive'), title: t('workboards.publish.goLiveTitle') }
        : status === 'live_unpublished_changes'
          ? {
              label: t('workboards.publish.publishChanges'),
              title: t('workboards.publish.publishChangesTitle'),
            }
          : null;
    return (
      <>
        <div className="inline-flex items-center gap-2">
          <StatePill status={status} />
          {action ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void doPublish()}
              loading={publish.isPending}
              disabled={busy}
              leadingIcon={<UploadCloud className="h-3.5 w-3.5" />}
              title={action.title}
            >
              {action.label}
            </Button>
          ) : null}
        </div>
        {auditModal}
      </>
    );
  }

  if (variant === 'icon') {
    const liveish = status !== 'draft';
    return (
      <>
        <IconButton
          aria-label={
            status === 'live'
              ? t('workboards.publish.moveToDraftAria')
              : t('workboards.publish.publishAria')
          }
          title={
            status === 'live_unpublished_changes'
              ? 'Live · có thay đổi chưa xuất bản'
              : status === 'live'
                ? t('workboards.publish.publishedTitle')
                : t('workboards.publish.draftTitle')
          }
          variant="ghost"
          size="xs"
          onClick={onClick}
          disabled={busy}
          className={liveish ? 'text-success hover:bg-success/10' : 'text-text-tertiary hover:bg-surface-2'}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : status === 'live_unpublished_changes' ? (
            <UploadCloud className="h-3.5 w-3.5" />
          ) : liveish ? (
            <Globe2 className="h-3.5 w-3.5" />
          ) : (
            <PencilLine className="h-3.5 w-3.5" />
          )}
        </IconButton>
        {confirmModal}
        {auditModal}
      </>
    );
  }

  // pill variant (topbar)
  const pill = {
    draft: { tone: 'warning' as const, dot: 'bg-warning', label: t('workboards.filter.draft'), title: 'Nhấn để xuất bản (Go live)' },
    live: { tone: 'success' as const, dot: 'bg-success', label: t('workboards.filter.published'), title: 'Đang chạy — nhấn để chuyển về nháp' },
    live_unpublished_changes: {
      tone: 'warning' as const,
      dot: 'bg-amber-500',
      label: 'Live · thay đổi chưa xuất bản',
      title: 'Bản nháp có thay đổi chưa lên production — nhấn để xuất bản',
    },
  }[status];

  return (
    <>
      <FilterTag tone={pill.tone} onClick={onClick} disabled={busy} className="gap-1" title={pill.title}>
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
        )}
        {pill.label}
        {status === 'live_unpublished_changes' && !busy ? <UploadCloud className="ml-0.5 h-3 w-3" /> : null}
      </FilterTag>
      {confirmModal}
      {auditModal}
    </>
  );
}

function StatePill({ status }: { status: PublishStatus }) {
  const { t } = useI18n();
  const map = {
    draft: { tone: 'warning' as const, dot: 'bg-warning', label: t('workboards.filter.draft') },
    live: { tone: 'success' as const, dot: 'bg-success', label: t('workboards.filter.published') },
    live_unpublished_changes: { tone: 'warning' as const, dot: 'bg-amber-500', label: 'Live · thay đổi chưa xuất bản' },
  }[status];
  return (
    <FilterTag tone={map.tone} disabled className="gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${map.dot}`} />
      {map.label}
    </FilterTag>
  );
}
