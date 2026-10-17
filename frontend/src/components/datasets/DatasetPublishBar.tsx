'use client';

/**
 * Import-mode publish lifecycle surface for the dataset editor.
 *
 * `useDatasetPublishHeader` returns it as DetailHeader slots:
 * - status: the lifecycle badge;
 * - primary: "Sync & Publish" (gated on MANAGE) — opens the config modal;
 * - secondaryActions: "Share" (gated on RESHARE) and "History";
 * - issues: sync-failed and mixed sources are CRITICAL (consumers cannot get the
 *   new data / charts cannot run live); changes-pending, first sync and an
 *   unpublished draft stay a pinned strip with the one-click re-publish CTA;
 * - overlays: the modals + the floating sync progress popup.
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
  History,
} from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import type { DetailIssue } from '@/components/common/IssueSummary';
import type { DetailSecondaryAction } from '@/components/common/DetailHeader';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetPublishStatus,
  useSyncAndPublishDataset,
  useDatasetGrants,
  type DatasetPublishState,
} from '@/hooks/use-datasets';
import { DatasetGrantsModal } from './DatasetGrantsModal';
import { SyncPublishModal } from './SyncPublishModal';
import { SyncProgressPopup } from './SyncProgressPopup';
import { RefreshHistoryModal } from './RefreshHistoryModal';

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

/** The generation id is epoch-millis of the build (`int(time.time()*1000)` on the
 * server), so show it as a readable local datetime instead of the raw number. */
function formatGenerationTime(gen: number | null): string {
  if (gen == null) return '';
  try {
    return new Date(gen).toLocaleString([], {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(gen);
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
  datasetId: number | null;
  /** Fall back gate when grants query is still loading — from ResourceShare perms. */
  canEditFallback?: boolean;
}

export interface DatasetPublishHeader {
  status: React.ReactNode;
  primary: React.ReactNode;
  secondaryActions: DetailSecondaryAction[];
  issues: DetailIssue[];
  overlays: React.ReactNode;
}

export function useDatasetPublishHeader({ datasetId, canEditFallback }: ControlsProps): DatasetPublishHeader {
  const { t } = useI18n();
  const { data: status } = useDatasetPublishStatus(datasetId);
  const { data: grants } = useDatasetGrants(datasetId);
  const publish = useSyncAndPublishDataset();
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const caps = grants?.my_capabilities ?? [];
  const canManage = caps.includes('manage') || (grants === undefined && !!canEditFallback);
  const canReshare = caps.includes('reshare') || caps.includes('manage');

  const state = status?.publish_state ?? null;
  const syncing = status?.syncing || state === 'syncing' || publish.isPending;

  // Badge — legacy (null) shows "Live"; otherwise the lifecycle state.
  const badge = state === null ? (
    <span title={t('datasets.publish.tooltipLive')} data-testid="dataset-publish-state">
      <Badge variant="outline" size="sm" className="gap-1">
        <RadioTower className="h-3 w-3" />
        {t('datasets.publish.stateLive')}
      </Badge>
    </span>
  ) : (
    <span
      data-testid="dataset-publish-state"
      data-state={state}
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
          <span className="ml-1 hidden opacity-60 xl:inline">
            {t('datasets.publish.generation', { when: formatGenerationTime(status.published_generation) })}
          </span>
        )}
      </Badge>
    </span>
  );

  const publishLabel = syncing
    ? t('datasets.publish.publishing')
    : state === 'published'
      ? t('datasets.publish.republish')
      : t('datasets.publish.syncAndPublish');

  const primary = canManage ? (
    <Button
      size="xs"
      data-testid="dataset-sync-publish"
      variant={state === 'changes_pending' || state === 'draft' || state === null ? 'primary' : 'secondary'}
      leadingIcon={syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
      disabled={syncing}
      onClick={() => setSyncOpen(true)}
      aria-label={publishLabel}
      title={publishLabel}
    >
      {/* Icon-only on phones so the dataset name keeps its room. */}
      <span className="hidden sm:inline">{publishLabel}</span>
    </Button>
  ) : null;

  const secondaryActions: DetailSecondaryAction[] = [];
  if (canReshare) {
    secondaryActions.push({
      id: 'grants',
      testId: 'dataset-grants',
      inlineFrom: 'lg',
      label: t('datasets.publish.share'),
      icon: <Users />,
      onSelect: () => setGrantsOpen(true),
    });
  }
  secondaryActions.push({
    id: 'history',
    testId: 'dataset-history',
    inlineFrom: 'lg',
    label: t('datasets.refreshHistory.button'),
    icon: <History />,
    onSelect: () => setHistoryOpen(true),
  });

  const onPublish = async () => {
    if (datasetId === null) return;
    try {
      const res = await publish.mutateAsync(datasetId);
      if (res.started === false) toast.info(t('datasets.publish.toastAlreadySyncing'));
      else toast.success(t('datasets.publish.toastStarted'));
    } catch (e: any) {
      toast.error(t('datasets.publish.toastFailed'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  const issues: DetailIssue[] = [];

  // A dataset whose source tables span more than one engine cannot run any
  // chart live — every chart is refused until it is Sync & Published. That is
  // a blocker for every consumer, so it is pinned, not counted.
  if (status?.live_executable === false && state !== 'published') {
    issues.push({
      id: 'mixed-sources',
      testId: 'dataset-issue-mixed-sources',
      severity: 'critical',
      title: t('datasets.publish.mixedSources'),
      detail: t('datasets.publish.mixedSourcesHint', { engines: (status?.live_engines ?? []).join(', ') }),
    });
  }

  // FIRST sync in progress (no complete generation yet): reports/preview may show
  // partial/live data → warn. Takes precedence over the static-state notices.
  const firstSync = (!!status?.syncing || state === 'syncing') && status?.has_prior_complete === false;
  const kind: 'firstsync' | 'changes' | 'failed' | 'draft' | null =
    firstSync ? 'firstsync'
    : state === 'changes_pending' ? 'changes'
    : state === 'sync_failed' ? 'failed'
    : state === 'draft' && !status?.has_published_data ? 'draft'
    : null;
  if (kind) {
    // One click, no config modal — the same direct re-publish as before. None
    // during the first sync: it is already running.
    const cta = canManage && kind !== 'firstsync' ? (
      <Button
        size="xs"
        variant="primary"
        data-testid="dataset-issue-publish"
        leadingIcon={syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
        disabled={syncing}
        onClick={onPublish}
      >
        {syncing ? t('datasets.publish.publishing') : t('datasets.publish.syncAndPublish')}
      </Button>
    ) : undefined;
    const failedDetail = [
      status?.last_sync_error ?? '',
      // The failed candidate was NOT published: say what dashboards serve instead.
      status?.published_generation != null
        ? t('datasets.publish.bannerFailedServing', { when: formatGenerationTime(status.published_generation) })
        : t('datasets.publish.bannerFailedNothing'),
    ].filter(Boolean).join(' ');
    issues.push({
      id: `lifecycle-${kind}`,
      testId: 'dataset-lifecycle-notice',
      severity: kind === 'failed' ? 'critical' : kind === 'draft' ? 'info' : 'warning',
      persistent: true,
      busy: kind === 'firstsync',
      title:
        kind === 'firstsync' ? t('datasets.sync.firstSyncWarnTitle')
        : kind === 'failed' ? t('datasets.publish.bannerFailedTitle')
        : kind === 'changes' ? t('datasets.publish.bannerChangesTitle')
        : t('datasets.publish.bannerDraftTitle'),
      detail:
        kind === 'firstsync' ? t('datasets.sync.firstSyncWarnBody')
        : kind === 'failed' ? failedDetail
        : kind === 'changes' ? t('datasets.publish.bannerChangesBody')
        : t('datasets.publish.bannerDraftBody'),
      action: cta,
    });
  }

  const overlays = datasetId === null ? null : (
    <>
      {grantsOpen && <DatasetGrantsModal datasetId={datasetId} onClose={() => setGrantsOpen(false)} />}
      {syncOpen && <SyncPublishModal datasetId={datasetId} onClose={() => setSyncOpen(false)} />}
      {historyOpen && <RefreshHistoryModal datasetId={datasetId} onClose={() => setHistoryOpen(false)} />}
      {/* Persistent, server-driven sync progress — auto-reopens on tab reload
          while a sync runs; offers Hide/Stop. Fixed-position (floats). */}
      <SyncProgressPopup datasetId={datasetId} />
    </>
  );

  return { status: badge, primary, secondaryActions, issues, overlays };
}
