/**
 * Layout for ``/workboards/[id]/*`` — shared header (breadcrumb + top-level IA
 * tabs + publish/preview/share/overflow) above the sibling routes.
 *
 * P1 IA: four top-level sections — Build | Access | Automations | Settings —
 * with Preview / publish / Share / ··· as TOPBAR ACTIONS (not tabs). Splitting
 * sections into routes lets users deep-link into one, keeps browser
 * back/forward sane, and lets each keep its own loading state.
 *
 * Publish status is now separated from the publish action (see
 * WorkboardPublishToggle variant="topbar"); the destructive Unpublish is
 * demoted into the ··· overflow with a confirm.
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ClipboardList,
  Download,
  Eye,
  Loader2,
  Settings2,
  Share2,
  ShieldCheck,
  Undo2,
  Wrench,
  Zap,
} from 'lucide-react';

import { useWorkboard, useUnpublishWorkboard } from '@/hooks/use-workboards';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/common/Modal';
import { toast } from '@/lib/toast';
import WorkboardImportExportModal from '@/components/workboards/builder/WorkboardImportExportModal';
import { WorkboardPublishToggle } from '@/components/workboards/WorkboardPublishToggle';
import WorkboardShareModal, {
  WORKBOARD_SHARE_OPEN,
} from '@/components/workboards/WorkboardShareModal';
import { DetailHeader } from '@/components/common/DetailHeader';
import { DefaultOwnerCredentialsDialog } from '@/components/workboards/DefaultOwnerCredentialsDialog';
import {
  clearWorkboardDefaultOwnerNotice,
  peekWorkboardDefaultOwnerNotice,
  type WorkboardDefaultOwnerNotice,
} from '@/lib/workboard-default-owner-notice';
import { useI18n } from '@/providers/LanguageProvider';

export default function WorkboardLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const pathname = usePathname() || '';
  const id = Number(params.id);
  const [importExportMode, setImportExportMode] = useState<'export' | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [defaultOwnerNotice, setDefaultOwnerNotice] = useState<WorkboardDefaultOwnerNotice | null>(null);

  const { data: workboard, isLoading, error } = useWorkboard(id);
  const unpublish = useUnpublishWorkboard();

  // The Live Preview's "chưa gắn Cổng" hint opens this same Share modal via an
  // event (it lives in the page, this modal in the layout).
  useEffect(() => {
    const open = () => setShowShare(true);
    window.addEventListener(WORKBOARD_SHARE_OPEN, open);
    return () => window.removeEventListener(WORKBOARD_SHARE_OPEN, open);
  }, []);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) return;
    // Only present when the user left the create dialog without acknowledging.
    setDefaultOwnerNotice(peekWorkboardDefaultOwnerNotice(id));
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-brand" />
      </div>
    );
  }

  if (error || !workboard) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <ClipboardList className="h-10 w-10 text-text-tertiary" />
        <p className="text-body text-text-secondary">{t('workboards.layout.notFound')}</p>
        <Button
          onClick={() => router.push('/workboards')}
          leadingIcon={<ChevronLeft className="h-4 w-4" />}
        >
          {t('workboards.layout.backToList')}
        </Button>
      </div>
    );
  }

  // Active section inferred from URL — single source of truth, survives
  // refresh and bookmarking. Preview is an ACTION (its own view), not a tab.
  const baseHref = `/workboards/${id}`;
  const isPreview = pathname.startsWith(`${baseHref}/preview`);
  const isAccess = pathname.startsWith(`${baseHref}/users`);
  const isAutomations = pathname.startsWith(`${baseHref}/webhooks`);
  const isSettings = pathname.startsWith(`${baseHref}/settings`);
  const isBuild = !isAccess && !isAutomations && !isSettings && !isPreview;

  const canEdit = getResourcePermissions(workboard.user_permission ?? undefined, workboard.capabilities).canEdit;
  const liveish = workboard.publish_status !== 'draft';

  const doUnpublish = async () => {
    setConfirmUnpublish(false);
    try {
      await unpublish.mutateAsync(workboard.id);
      toast.success(t('workboards.publish.draftToast'));
    } catch {
      toast.error(t('workboards.publish.draftFailed'));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        tabsInlineFrom="xl"
        testId="workboard-header"
        back={{ label: t('workboards.layout.workboards'), onClick: () => router.push('/workboards') }}
        title={<span title={workboard.name}>{workboard.name}</span>}
        tabs={
          <div
            role="tablist"
            aria-label={workboard.name}
            className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5"
          >
            <SegmentLink active={isBuild} href={baseHref}>
              <Wrench className="h-3.5 w-3.5" />
              {t('workboards.layout.builder')}
            </SegmentLink>
            <SegmentLink active={isAccess} href={`${baseHref}/users`}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('workboards.layout.access')}
            </SegmentLink>
            <SegmentLink active={isAutomations} href={`${baseHref}/webhooks`}>
              <Zap className="h-3.5 w-3.5" />
              {t('workboards.layout.automations')}
            </SegmentLink>
            <SegmentLink active={isSettings} href={`${baseHref}/settings`}>
              <Settings2 className="h-3.5 w-3.5" />
              {t('workboards.layout.settings')}
            </SegmentLink>
          </div>
        }
        secondaryActions={[
          // Preview — an action, decoupled from any Cổng: preview the Draft.
          {
            id: 'preview',
            testId: 'workboard-preview',
            inlineFrom: 'md',
            label: t('workboards.layout.preview'),
            icon: <Eye />,
            onSelect: () => router.push(`${baseHref}/preview`),
            renderInline: () => (
              <button
                type="button"
                data-testid="workboard-preview"
                onClick={() => router.push(`${baseHref}/preview`)}
                aria-pressed={isPreview}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                  isPreview
                    ? 'bg-brand/10 text-brand'
                    : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                }`}
                title={t('workboards.layout.preview')}
              >
                <Eye className="h-3.5 w-3.5" />
                {t('workboards.layout.preview')}
              </button>
            ),
          },
          {
            id: 'share',
            testId: 'workboard-share',
            inlineFrom: 'sm',
            label: t('common.share'),
            icon: <Share2 />,
            onSelect: () => setShowShare(true),
          },
        ]}
        // Low-frequency / destructive actions.
        menuItems={[
          {
            id: 'export',
            testId: 'workboard-export',
            label: t('workboards.layout.export'),
            icon: <Download />,
            onSelect: () => setImportExportMode('export'),
          },
          ...(canEdit && liveish
            ? [
                {
                  id: 'unpublish',
                  testId: 'workboard-unpublish',
                  label: t('workboards.layout.unpublish'),
                  icon: <Undo2 />,
                  danger: true,
                  onSelect: () => setConfirmUnpublish(true),
                },
              ]
            : []),
        ]}
        overflowTestId="workboard-more"
        actions={<WorkboardPublishToggle workboard={workboard} variant="topbar" canEdit={canEdit} />}
      />

      {defaultOwnerNotice && (
        <DefaultOwnerCredentialsDialog
          isOpen
          workboardName={workboard.name}
          username={defaultOwnerNotice.username}
          pin={defaultOwnerNotice.pin}
          confirmLabel={t('workboards.credentials.done')}
          onConfirm={() => {
            clearWorkboardDefaultOwnerNotice(id);
            setDefaultOwnerNotice(null);
          }}
        />
      )}

      <div className="flex-1 overflow-hidden">{children}</div>

      {importExportMode && (
        <WorkboardImportExportModal
          workboard={workboard}
          mode={importExportMode}
          onClose={() => setImportExportMode(null)}
        />
      )}

      {showShare && (
        <WorkboardShareModal workboard={workboard} onClose={() => setShowShare(false)} />
      )}

      {confirmUnpublish && (
        <Modal
          isOpen
          onClose={() => setConfirmUnpublish(false)}
          title={t('workboards.publish.confirmTitle')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmUnpublish(false)}>
                {t('workboards.publish.cancel')}
              </Button>
              <Button variant="danger" size="sm" onClick={doUnpublish} loading={unpublish.isPending}>
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
      )}
    </div>
  );
}

function SegmentLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => router.push(href)}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-surface-1 text-brand shadow-linear-sm'
          : 'text-text-tertiary hover:bg-surface-1'
      }`}
    >
      {children}
    </button>
  );
}
