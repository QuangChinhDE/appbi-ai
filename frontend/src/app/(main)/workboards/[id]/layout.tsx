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
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Download,
  Eye,
  Loader2,
  MoreHorizontal,
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
import {
  consumeWorkboardDefaultOwnerNotice,
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
  const [showOverflow, setShowOverflow] = useState(false);
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
    setDefaultOwnerNotice(consumeWorkboardDefaultOwnerNotice(id));
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

  const canEdit = getResourcePermissions(workboard.user_permission ?? undefined).canEdit;
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
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        <button
          onClick={() => router.push('/workboards')}
          className="flex items-center gap-1 text-sm text-text-tertiary transition-colors hover:text-text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('workboards.layout.workboards')}
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="max-w-[220px] truncate text-sm font-medium text-text-primary">
          {workboard.name}
        </span>

        <div className="mx-1 h-5 w-px bg-surface-3" />

        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
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

        <div className="flex-1" />

        {/* Preview — an action, decoupled from any Cổng: preview the Draft. */}
        <button
          onClick={() => router.push(`${baseHref}/preview`)}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
            isPreview
              ? 'bg-brand/10 text-brand'
              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
          }`}
          title={t('workboards.layout.preview')}
        >
          <Eye className="h-3.5 w-3.5" />
          {t('workboards.layout.preview')}
        </button>

        <div className="mx-0.5 h-5 w-px bg-surface-3" />

        <WorkboardPublishToggle workboard={workboard} variant="topbar" canEdit={canEdit} />

        <button
          onClick={() => setShowShare(true)}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('workboards.layout.shareTitle')}
        >
          <Share2 className="h-3.5 w-3.5" />
          {t('common.share')}
        </button>

        {/* Overflow (···) — low-frequency / destructive actions. */}
        <div className="relative">
          <button
            onClick={() => setShowOverflow((v) => !v)}
            className="inline-flex items-center rounded p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            title={t('workboards.layout.more')}
            aria-haspopup="menu"
            aria-expanded={showOverflow}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {showOverflow && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowOverflow(false)} />
              <div
                role="menu"
                className="absolute right-0 top-9 z-50 min-w-[220px] overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 py-1 shadow-linear-md"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setShowOverflow(false);
                    setImportExportMode('export');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('workboards.layout.export')}
                </button>
                {canEdit && liveish && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setShowOverflow(false);
                      setConfirmUnpublish(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-danger transition-colors hover:bg-danger/10"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('workboards.layout.unpublish')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {defaultOwnerNotice && (
        <div className="flex items-start gap-3 border-b border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('workboards.layout.defaultOwnerCreated')}</p>
            <p className="text-xs text-danger/90">
              {t('workboards.layout.usernameLabel')} <strong>{defaultOwnerNotice.username}</strong> |{' '}
              {t('workboards.layout.defaultPinLabel')}{' '}
              <strong>{defaultOwnerNotice.pin}</strong>. {t('workboards.layout.changePinInUsers')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDefaultOwnerNotice(null)}
            className="rounded px-1 py-0.5 text-xs text-danger/80 transition-colors hover:bg-danger/10 hover:text-danger"
          >
            {t('workboards.layout.close')}
          </button>
        </div>
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
      onClick={() => router.push(href)}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-surface-1 text-brand shadow-linear-sm'
          : 'text-text-tertiary hover:bg-surface-1'
      }`}
    >
      {children}
    </button>
  );
}
