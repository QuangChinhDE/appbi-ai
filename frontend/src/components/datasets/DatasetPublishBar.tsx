'use client';

/**
 * Import-mode publish lifecycle surface for the dataset editor.
 *
 * - `DatasetPublishControls` — compact header cluster: status badge +
 *   "Sync & Publish" button (gated on MANAGE) + "Grants" button (gated on RESHARE).
 * - `DatasetPublishBanner` — full-width strip below the header for the
 *   changes-pending / sync-failed / draft states with a re-publish CTA.
 *
 * Legacy datasets (publish_state === null) never entered the lifecycle: the
 * badge shows "Live" and no lifecycle CTA is offered.
 */

import * as React from 'react';
import { useState } from 'react';
import {
  CheckCircle2,
  UploadCloud,
  Loader2,
  AlertTriangle,
  FileEdit,
  RadioTower,
  Users,
} from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetPublishStatus,
  useSyncAndPublishDataset,
  useDatasetGrants,
  type DatasetPublishState,
} from '@/hooks/use-datasets';
import { DatasetGrantsModal } from './DatasetGrantsModal';
import { SyncPublishModal } from './SyncPublishModal';

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

const STATE_META: Record<
  Exclude<DatasetPublishState, never>,
  { variant: BadgeProps['variant']; icon: React.ReactNode; labelKey: string; dot?: boolean }
> = {
  draft: { variant: 'neutral', icon: <FileEdit className="h-3 w-3" />, labelKey: 'datasets.publish.stateDraft', dot: true },
  ready: { variant: 'info', icon: <UploadCloud className="h-3 w-3" />, labelKey: 'datasets.publish.stateReady' },
  syncing: { variant: 'brand', icon: <Loader2 className="h-3 w-3 animate-spin" />, labelKey: 'datasets.publish.stateSyncing' },
  published: { variant: 'success', icon: <CheckCircle2 className="h-3 w-3" />, labelKey: 'datasets.publish.statePublished' },
  changes_pending: { variant: 'warning', icon: <AlertTriangle className="h-3 w-3" />, labelKey: 'datasets.publish.stateChangesPending' },
  sync_failed: { variant: 'danger', icon: <AlertTriangle className="h-3 w-3" />, labelKey: 'datasets.publish.stateSyncFailed' },
  disabled: { variant: 'subtle', icon: null, labelKey: 'datasets.publish.stateDisabled' },
};

interface ControlsProps {
  datasetId: number;
  /** Fall back gate when grants query is still loading — from ResourceShare perms. */
  canEditFallback?: boolean;
}

export function DatasetPublishControls({ datasetId, canEditFallback }: ControlsProps) {
  const { t } = useI18n();
  const { data: status } = useDatasetPublishStatus(datasetId);
  const { data: grants } = useDatasetGrants(datasetId);
  const publish = useSyncAndPublishDataset();
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const caps = grants?.my_capabilities ?? [];
  const canManage = caps.includes('manage') || (grants === undefined && !!canEditFallback);
  const canReshare = caps.includes('reshare') || caps.includes('manage');

  const state = status?.publish_state ?? null;
  const syncing = status?.syncing || state === 'syncing' || publish.isPending;

  // Badge — legacy (null) shows "Live"; otherwise the lifecycle state.
  const badge = state === null ? (
    <span title={t('datasets.publish.tooltipLive')}>
      <Badge variant="outline" size="sm" className="gap-1">
        <RadioTower className="h-3 w-3" />
        {t('datasets.publish.stateLive')}
      </Badge>
    </span>
  ) : (
    <span
      title={
        state === 'published'
          ? t('datasets.publish.tooltipPublished', { when: formatWhen(status?.published_at ?? null) })
          : state === 'sync_failed' && status?.last_sync_error
            ? status.last_sync_error
            : undefined
      }
    >
      <Badge variant={STATE_META[state].variant} size="sm" dot={STATE_META[state].dot} className="gap-1">
        {STATE_META[state].icon}
        {t(STATE_META[state].labelKey)}
        {state === 'published' && status?.published_generation != null && (
          <span className="ml-1 opacity-60">{t('datasets.publish.generation', { gen: status.published_generation })}</span>
        )}
      </Badge>
    </span>
  );

  const publishLabel = syncing
    ? t('datasets.publish.publishing')
    : state === 'published'
      ? t('datasets.publish.republish')
      : t('datasets.publish.syncAndPublish');

  return (
    <div className="flex items-center gap-2">
      {badge}
      {canManage && (
        <Button
          size="xs"
          variant={state === 'changes_pending' || state === 'draft' || state === null ? 'primary' : 'secondary'}
          leadingIcon={syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
          disabled={syncing}
          onClick={() => setSyncOpen(true)}
        >
          {publishLabel}
        </Button>
      )}
      {canReshare && (
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={<Users className="h-3.5 w-3.5" />}
          onClick={() => setGrantsOpen(true)}
        >
          {t('datasets.publish.share')}
        </Button>
      )}
      {grantsOpen && <DatasetGrantsModal datasetId={datasetId} onClose={() => setGrantsOpen(false)} />}
      {syncOpen && <SyncPublishModal datasetId={datasetId} onClose={() => setSyncOpen(false)} />}
    </div>
  );
}

export function DatasetPublishBanner({ datasetId, canEditFallback }: ControlsProps) {
  const { t } = useI18n();
  const { data: status } = useDatasetPublishStatus(datasetId);
  const { data: grants } = useDatasetGrants(datasetId);
  const publish = useSyncAndPublishDataset();

  const state = status?.publish_state ?? null;
  const caps = grants?.my_capabilities ?? [];
  const canManage = caps.includes('manage') || (grants === undefined && !!canEditFallback);
  const syncing = status?.syncing || state === 'syncing' || publish.isPending;

  // Only show a banner for the states that need viewer attention.
  const kind: 'changes' | 'failed' | 'draft' | null =
    state === 'changes_pending' ? 'changes'
    : state === 'sync_failed' ? 'failed'
    : state === 'draft' && !status?.has_published_data ? 'draft'
    : null;
  if (!kind) return null;

  const onPublish = async () => {
    try {
      const res = await publish.mutateAsync(datasetId);
      if (res.started === false) toast.info(t('datasets.publish.toastAlreadySyncing'));
      else toast.success(t('datasets.publish.toastStarted'));
    } catch (e: any) {
      toast.error(t('datasets.publish.toastFailed'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  const palette =
    kind === 'failed'
      ? 'border-danger/30 bg-danger/8 text-danger'
      : kind === 'changes'
        ? 'border-warning/30 bg-warning/8 text-warning'
        : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary';

  const title =
    kind === 'failed' ? t('datasets.publish.bannerFailedTitle')
    : kind === 'changes' ? t('datasets.publish.bannerChangesTitle')
    : t('datasets.publish.bannerDraftTitle');
  const body =
    kind === 'failed' ? status?.last_sync_error ?? ''
    : kind === 'changes' ? t('datasets.publish.bannerChangesBody')
    : t('datasets.publish.bannerDraftBody');

  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-xs ${palette}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-emphasis">{title}</span>{' '}
        <span className="opacity-80">{body}</span>
      </div>
      {canManage && (
        <Button
          size="xs"
          variant="primary"
          leadingIcon={syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
          disabled={syncing}
          onClick={onPublish}
        >
          {syncing ? t('datasets.publish.publishing') : t('datasets.publish.syncAndPublish')}
        </Button>
      )}
    </div>
  );
}
