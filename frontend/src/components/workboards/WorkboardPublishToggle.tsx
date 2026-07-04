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
import { FilterTag } from '@/components/ui/FilterTag';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import { usePublishWorkboard, useUpdateWorkboard } from '@/hooks/use-workboards';
import { useI18n } from '@/providers/LanguageProvider';
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
  const { t } = useI18n();
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
      toast.success(t('workboards.publish.publishedToast'));
    } catch (err) {
      // Surface the BE's actionable reason (e.g. "đổi PIN mặc định cho owner…")
      // instead of a generic failure, so the user knows what to fix.
      toast.error(apiErrorMessage(err, t('workboards.publish.publishFailed')));
    }
  };

  const doDraft = async () => {
    setConfirmingDraft(false);
    try {
      await update.mutateAsync({ id: workboard.id, data: { is_published: false } });
      toast.success(t('workboards.publish.draftToast'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('workboards.publish.draftFailed')));
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
      title={t('workboards.publish.confirmTitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDraft(false)}>
            {t('workboards.publish.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={doDraft} loading={update.isPending}>
            {t('workboards.publish.confirmDraft')}
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-secondary">
        {t('workboards.publish.confirmDescriptionPrefix')} <strong>{workboard.name}</strong>{' '}
        {t('workboards.publish.confirmDescriptionMiddle')} <strong>{t('workboards.publish.hiddenFromPublicLinks')}</strong>{' '}
        {t('workboards.publish.confirmDescriptionSuffix')}
      </p>
    </Modal>
  ) : null;

  if (variant === 'icon') {
    return (
      <>
        <IconButton
          aria-label={published ? t('workboards.publish.moveToDraftAria') : t('workboards.publish.publishAria')}
          title={published ? t('workboards.publish.publishedTitle') : t('workboards.publish.draftTitle')}
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

  // pill variant (topbar) — uses the project's FilterTag status-chip primitive
  // (tinted, rounded, tone-based) so it reads identically to the Draft/Published
  // chips in the list.
  return (
    <>
      <FilterTag
        tone={published ? 'success' : 'warning'}
        onClick={onClick}
        disabled={busy}
        className="gap-1"
        title={published ? t('workboards.publish.publishedTitle') : t('workboards.publish.draftTitle')}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <span className={`h-1.5 w-1.5 rounded-full ${published ? 'bg-success' : 'bg-warning'}`} />
        )}
        {published ? t('workboards.filter.published') : t('workboards.filter.draft')}
      </FilterTag>
      {confirmModal}
    </>
  );
}

function StatePill({ published }: { published: boolean; muted?: boolean }) {
  const { t } = useI18n();
  return (
    <FilterTag tone={published ? 'success' : 'warning'} disabled className="gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${published ? 'bg-success' : 'bg-warning'}`} />
      {published ? t('workboards.filter.published') : t('workboards.filter.draft')}
    </FilterTag>
  );
}
