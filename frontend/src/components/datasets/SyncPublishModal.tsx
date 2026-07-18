'use client';

/**
 * Sync & Publish control modal (Pha A + B). The BI Engineer configures, per
 * materializable table, how the BigQuery snapshot is stored — PARTITION column
 * (+ granularity) and CLUSTER columns (≤4) — and the refresh SCHEDULE, then
 * either saves the config or runs Sync & Publish now (which applies it).
 *
 * Partition dropdown only offers DATE/TIMESTAMP/DATETIME columns (BigQuery
 * partition rule); clustering offers any column.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check, Database, Loader2, UploadCloud, Layers, Rows3 } from 'lucide-react';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetSnapshotConfig,
  useSaveSnapshotConfig,
  useSyncAndPublishDataset,
  type SnapshotSchedule,
  type SnapshotTableConfig,
} from '@/hooks/use-datasets';

const MAX_CLUSTER = 4;

/** Derived BigQuery storage type from the partition/cluster choice, so the user
 * sees exactly which of Standard / Partitioned / Clustered / Partition+Cluster
 * their config produces. */
function storageType(cfg: SnapshotTableConfig): { key: string; variant: BadgeProps['variant'] } {
  const p = !!cfg.partition_field;
  const c = (cfg.cluster_fields?.length ?? 0) > 0;
  if (p && c) return { key: 'datasets.sync.typePartitionCluster', variant: 'success' };
  if (p) return { key: 'datasets.sync.typePartitioned', variant: 'info' };
  if (c) return { key: 'datasets.sync.typeClustered', variant: 'info' };
  return { key: 'datasets.sync.typeStandard', variant: 'neutral' };
}

export function SyncPublishModal({ datasetId, onClose }: { datasetId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isLoading } = useDatasetSnapshotConfig(datasetId);
  const save = useSaveSnapshotConfig();
  const publish = useSyncAndPublishDataset();

  const [schedule, setSchedule] = useState<SnapshotSchedule>({ mode: 'manual', timezone: 'UTC' });
  const [tablesCfg, setTablesCfg] = useState<Record<string, SnapshotTableConfig>>({});

  useEffect(() => {
    if (!data) return;
    setSchedule(data.schedule || { mode: 'manual' });
    const init: Record<string, SnapshotTableConfig> = {};
    for (const tb of data.tables) init[String(tb.id)] = { ...tb.config };
    setTablesCfg(init);
  }, [data]);

  const busy = save.isPending || publish.isPending;

  const setTable = (id: number, patch: Partial<SnapshotTableConfig>) =>
    setTablesCfg((prev) => ({ ...prev, [String(id)]: { ...prev[String(id)], ...patch } }));

  const toggleCluster = (id: number, col: string) => {
    const cur = tablesCfg[String(id)]?.cluster_fields ?? [];
    const next = cur.includes(col) ? cur.filter((c) => c !== col) : (cur.length < MAX_CLUSTER ? [...cur, col] : cur);
    setTable(id, { cluster_fields: next });
  };

  const payload = useMemo(() => ({ datasetId, schedule, tables: tablesCfg }), [datasetId, schedule, tablesCfg]);

  const doSave = async () => {
    try {
      await save.mutateAsync(payload);
      toast.success(t('datasets.sync.savedConfig'));
    } catch (e: any) {
      toast.error(t('datasets.sync.saveError'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  const doSyncNow = async () => {
    try {
      await save.mutateAsync(payload);
      const res = await publish.mutateAsync(datasetId);
      if (res.started === false) toast.info(t('datasets.publish.toastAlreadySyncing'));
      else toast.success(t('datasets.publish.toastStarted'));
      onClose();
    } catch (e: any) {
      toast.error(t('datasets.publish.toastFailed'), { description: e?.response?.data?.detail ?? e?.message });
    }
  };

  return (
    <AppModalShell
      onClose={onClose}
      title={t('datasets.sync.title')}
      description={t('datasets.sync.subtitle')}
      icon={<UploadCloud className="h-4 w-4" />}
      maxWidthClass="max-w-3xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={doSave}>{t('datasets.sync.saveOnly')}</Button>
          <Button variant="primary" size="sm" disabled={busy}
            leadingIcon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            onClick={doSyncNow}>
            {t('datasets.publish.syncAndPublish')}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 p-6 text-text-tertiary"><Loader2 className="h-4 w-4 animate-spin" />…</div>
      ) : (
        <div className="space-y-6">
          {/* Schedule */}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
              <CalendarClock className="h-3.5 w-3.5" /> {t('datasets.sync.scheduleTitle')}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="w-44">
                <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.sync.scheduleMode')}</span>
                <Select value={schedule.mode} onChange={(e) => setSchedule({ ...schedule, mode: e.target.value as SnapshotSchedule['mode'] })}>
                  <option value="manual">{t('datasets.sync.modeManual')}</option>
                  <option value="hourly">{t('datasets.sync.modeHourly')}</option>
                  <option value="daily">{t('datasets.sync.modeDaily')}</option>
                  <option value="cron">{t('datasets.sync.modeCron')}</option>
                </Select>
              </label>
              {schedule.mode === 'daily' && (
                <label className="w-32">
                  <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.sync.atTime')}</span>
                  <Input type="time" value={schedule.at || '02:00'} onChange={(e) => setSchedule({ ...schedule, at: e.target.value })} />
                </label>
              )}
              {schedule.mode === 'cron' && (
                <label className="flex-1 min-w-[180px]">
                  <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.sync.cronExpr')}</span>
                  <Input value={schedule.cron || ''} placeholder="0 2 * * *" onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })} />
                </label>
              )}
            </div>
            <p className="mt-1.5 text-tiny text-text-quaternary">{t('datasets.sync.scheduleHint')}</p>
          </section>

          {/* Per-table storage */}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-tertiary">
              <Database className="h-3.5 w-3.5" /> {t('datasets.sync.storageTitle')}
            </div>
            <p className="mb-3 text-tiny text-text-quaternary">{t('datasets.sync.storageHint')}</p>
            <div className="space-y-3">
              {(data?.tables ?? []).map((tb) => {
                const cfg = tablesCfg[String(tb.id)] || {};
                const cluster = cfg.cluster_fields ?? [];
                return (
                  <div key={tb.id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Database className="h-3.5 w-3.5 text-text-tertiary" />
                      <span className="text-caption font-emphasis text-text-primary">{tb.display_name}</span>
                      {(() => { const st = storageType(cfg); return (
                        <Badge variant={st.variant} size="sm" className="ml-auto">{t(st.key)}</Badge>
                      ); })()}
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="w-48">
                        <span className="mb-1 flex items-center gap-1 text-tiny text-text-tertiary"><Rows3 className="h-3 w-3" />{t('datasets.sync.partitionField')}</span>
                        <Select value={cfg.partition_field || ''} onChange={(e) => setTable(tb.id, { partition_field: e.target.value || null })}>
                          <option value="">{t('datasets.sync.noPartition')}</option>
                          {tb.date_columns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </Select>
                      </label>
                      {cfg.partition_field && (
                        <label className="w-32">
                          <span className="mb-1 block text-tiny text-text-tertiary">{t('datasets.sync.granularity')}</span>
                          <Select value={cfg.partition_granularity || 'DAY'} onChange={(e) => setTable(tb.id, { partition_granularity: e.target.value as any })}>
                            <option value="DAY">{t('datasets.sync.granDay')}</option>
                            <option value="MONTH">{t('datasets.sync.granMonth')}</option>
                            <option value="YEAR">{t('datasets.sync.granYear')}</option>
                          </Select>
                        </label>
                      )}
                    </div>
                    <div className="mt-3">
                      <span className="mb-1.5 flex items-center gap-1 text-tiny text-text-tertiary">
                        <Layers className="h-3 w-3" />{t('datasets.sync.clusterFields')} ({cluster.length}/{MAX_CLUSTER})
                        <span className="text-text-quaternary">— {t('datasets.sync.clusterPick')}</span>
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {tb.columns.map((c) => {
                          const on = cluster.includes(c);
                          const disabled = !on && cluster.length >= MAX_CLUSTER;
                          return (
                            <button key={c} type="button" disabled={disabled}
                              onClick={() => toggleCluster(tb.id, c)}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-tiny transition-colors ${
                                on ? 'border-brand bg-brand text-text-inverse'
                                   : disabled ? 'border-[rgb(var(--border-line))] bg-surface-2 text-text-quaternary opacity-50 cursor-not-allowed'
                                   : 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary hover:border-brand hover:text-brand'}`}>
                              {on ? <Check className="h-3 w-3" /> : <span className="text-text-quaternary">+</span>}
                              {c}
                            </button>
                          );
                        })}
                        {tb.columns.length === 0 && <span className="text-tiny text-text-quaternary">—</span>}
                      </div>
                    </div>
                    {tb.date_columns.length === 0 && (
                      <p className="mt-2 text-tiny text-text-quaternary">{t('datasets.sync.noDateCols')}</p>
                    )}
                  </div>
                );
              })}
              {(data?.tables ?? []).length === 0 && (
                <p className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-4 text-center text-tiny text-text-tertiary">
                  {t('datasets.sync.noTables')}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </AppModalShell>
  );
}
