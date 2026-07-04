/**
 * Layout for ``/workboards/[id]/*`` — shared header (breadcrumb + tabs +
 * Export) above three sibling routes: Builder, Users, Preview.
 *
 * Splitting tabs into routes lets users deep-link directly into a tab,
 * keeps browser back/forward semantics sane, and lets each tab keep its
 * own loading state without one giant ``useState<Tab>``.
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
  Share2,
  UserCircle2,
  Webhook,
  Wrench,
} from 'lucide-react';

import { useWorkboard } from '@/hooks/use-workboards';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { Button } from '@/components/ui/Button';
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
  const [defaultOwnerNotice, setDefaultOwnerNotice] = useState<WorkboardDefaultOwnerNotice | null>(null);

  const { data: workboard, isLoading, error } = useWorkboard(id);

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

  // Active tab inferred from URL — single source of truth, survives
  // refresh and bookmarking.
  const baseHref = `/workboards/${id}`;
  const isPreview = pathname.startsWith(`${baseHref}/preview`);
  const isUsers = pathname.startsWith(`${baseHref}/users`);
  const isWebhooks = pathname.startsWith(`${baseHref}/webhooks`);
  const isBuilder = !isUsers && !isPreview && !isWebhooks;

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
        <span className="max-w-[260px] truncate text-sm font-medium text-text-primary">
          {workboard.name}
        </span>

        <div className="mx-1 h-5 w-px bg-surface-3" />

        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <SegmentLink active={isBuilder} href={baseHref}>
            <Wrench className="h-3.5 w-3.5" />
            {t('workboards.layout.builder')}
          </SegmentLink>
          <SegmentLink active={isUsers} href={`${baseHref}/users`}>
            <UserCircle2 className="h-3.5 w-3.5" />
            {t('workboards.layout.users')}
          </SegmentLink>
          <SegmentLink active={isPreview} href={`${baseHref}/preview`}>
            <Eye className="h-3.5 w-3.5" />
            {t('workboards.layout.preview')}
          </SegmentLink>
          <SegmentLink active={isWebhooks} href={`${baseHref}/webhooks`}>
            <Webhook className="h-3.5 w-3.5" />
            {t('workboards.layout.webhook')}
          </SegmentLink>
        </div>

        <div className="flex-1" />

        <WorkboardPublishToggle
          workboard={workboard}
          variant="pill"
          canEdit={getResourcePermissions(workboard.user_permission ?? undefined).canEdit}
        />
        <div className="mx-0.5 h-5 w-px bg-surface-3" />

        <button
          onClick={() => setShowShare(true)}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('workboards.layout.shareTitle')}
        >
          <Share2 className="h-3.5 w-3.5" />
          {t('common.share')}
        </button>
        <button
          onClick={() => setImportExportMode('export')}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('workboards.layout.exportTitle')}
        >
          <Download className="h-3.5 w-3.5" />
          {t('workboards.layout.export')}
        </button>
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
