'use client';

/**
 * Alert channels manager — where new incidents get delivered (email / Slack /
 * webhook), severity-gated, either for EVERY dataset (global: Observability
 * administrators) or for ONE dataset (anyone who can edit that dataset).
 * Manage controls follow each channel's `capabilities`; every failed action is
 * reported. Delivery health (failed / given-up sends) is shown per channel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Mail, Slack, Webhook, Send, Loader2, Power, AlertCircle, CheckCircle2, Globe, Database } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { relativeTime, LoadErrorState } from './ui';
import {
  listAlertChannels, createAlertChannel, updateAlertChannel, deleteAlertChannel, testAlertChannel,
  getObservabilityMe, getUsage, loadErrorOf, apiErrorMessage,
  type AlertChannel, type ChannelKind, type LoadError, type ObservabilityMe, type Severity, type UsageRow,
} from '@/lib/observability';

const KIND_META: Record<ChannelKind, { labelKey: string; icon: typeof Mail; placeholderKey: string }> = {
  email: { labelKey: 'observability.alertChannels.kind.email', icon: Mail, placeholderKey: 'observability.alertChannels.placeholder.email' },
  slack: { labelKey: 'observability.alertChannels.kind.slack', icon: Slack, placeholderKey: 'observability.alertChannels.placeholder.slack' },
  webhook: { labelKey: 'observability.alertChannels.kind.webhook', icon: Webhook, placeholderKey: 'observability.alertChannels.placeholder.webhook' },
};
const SEV_OPTS: { v: Severity; labelKey: string }[] = [
  { v: 'info', labelKey: 'observability.alertChannels.minSeverity.info' },
  { v: 'warning', labelKey: 'observability.alertChannels.minSeverity.warning' },
  { v: 'critical', labelKey: 'observability.alertChannels.minSeverity.critical' },
];

export function AlertChannelsModal({ onClose, defaultDatasetId }: { onClose: () => void; defaultDatasetId?: number }) {
  const { t, locale } = useI18n();
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [me, setMe] = useState<ObservabilityMe | null>(null);
  const [datasets, setDatasets] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<AlertChannel | null>(null);

  // new-channel form
  const [kind, setKind] = useState<ChannelKind>('email');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [minSeverity, setMinSeverity] = useState<Severity>('warning');
  const [scope, setScope] = useState<'global' | 'dataset'>('dataset');
  const [datasetId, setDatasetId] = useState<number | ''>(defaultDatasetId ?? '');

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return Promise.all([listAlertChannels(), getObservabilityMe(), getUsage()])
      .then(([c, m, u]) => { setChannels(c); setMe(m); setDatasets(u); })
      .catch((e) => setError(loadErrorOf(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Datasets this user may attach a channel to: the ones they can edit.
  const editable = useMemo(() => datasets.filter((d) => d.capabilities?.configure), [datasets]);
  const canCreate = !!me?.canManageGlobalChannels || editable.length > 0;
  useEffect(() => {
    if (me?.canManageGlobalChannels && !editable.length) setScope('global');
  }, [me, editable.length]);

  const onCreate = async () => {
    if (!target.trim()) { toast.error(t('observability.alertChannels.targetRequired')); return; }
    if (scope === 'dataset' && datasetId === '') { toast.error(t('observability.alertChannels.datasetRequired')); return; }
    setBusyId(-1);
    try {
      await createAlertChannel({
        kind, name: name.trim() || t(KIND_META[kind].labelKey), target: target.trim(), min_severity: minSeverity,
        dataset_id: scope === 'global' ? null : Number(datasetId),
      });
      setAdding(false); setName(''); setTarget('');
      await reload();
      toast.success(t('observability.alertChannels.createSuccess'));
    } catch (e) { toast.error(apiErrorMessage(e) ?? t('observability.alertChannels.createFailed')); }
    finally { setBusyId(null); }
  };
  const run = async (c: AlertChannel, fn: () => Promise<unknown>, okKey?: string) => {
    setBusyId(c.id);
    try { await fn(); if (okKey) toast.success(t(okKey)); await reload(); }
    catch (e) { toast.error(apiErrorMessage(e) ?? t('observability.alertChannels.actionFailed')); }
    finally { setBusyId(null); }
  };
  const onTest = (c: AlertChannel) => run(c, async () => {
    const r = await testAlertChannel(c.id);
    if (r.ok) toast.success(t('observability.alertChannels.testSuccess'));
    else toast.error(t('observability.alertChannels.testFailed', { error: r.error ?? '' }));
  });

  const field = 'rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus:border-brand focus:outline-none';

  return (
    <Modal isOpen onClose={onClose} title={t('observability.alertChannels.title')} size="lg"
      footer={<Button variant="ghost" onClick={onClose}>{t('observability.action.close')}</Button>}>
      <div className="space-y-4" data-testid="obs-channels">
        <p className="text-caption text-text-tertiary">{t('observability.alertChannels.description')}</p>

        {loading ? (
          <p className="py-6 text-center text-caption text-text-tertiary" role="status">{t('observability.loading')}</p>
        ) : error ? (
          <LoadErrorState error={error} onRetry={reload} compact testId="obs-channels-error" />
        ) : channels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-4 py-8 text-center text-caption text-text-quaternary">{t('observability.alertChannels.empty')}</div>
        ) : (
          <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
            {channels.map((c) => {
              const Meta = KIND_META[c.kind];
              const manage = !!c.capabilities?.manage;
              const dl = c.deliveries ?? { pending: 0, failed: 0, dead: 0 };
              return (
                <li key={c.id} data-testid={`obs-channel-${c.id}`} className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3', !c.isActive && 'opacity-60')}>
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Meta.icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-caption font-emphasis text-text-primary">{c.name}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">
                          {c.scope === 'global' ? <><Globe className="h-3 w-3" aria-hidden />{t('observability.alertChannels.scope.global')}</>
                            : <><Database className="h-3 w-3" aria-hidden />{c.dataset ?? t('observability.detail.datasetIdFallback', { id: c.datasetId ?? '' })}</>}
                        </span>
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{t(SEV_OPTS.find((s) => s.v === c.minSeverity)?.labelKey ?? 'observability.alertChannels.minSeverity.warning')}</span>
                        {!c.isActive && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{t('observability.alertChannels.paused')}</span>}
                      </div>
                      <div className="truncate text-tiny text-text-quaternary">{c.target}</div>
                      {(dl.failed > 0 || dl.dead > 0) && (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-tiny text-danger" data-testid={`obs-channel-${c.id}-failures`}>
                          <AlertCircle className="h-3 w-3" aria-hidden />
                          {t('observability.alertChannels.deliveryProblems', { failed: dl.failed, dead: dl.dead })}
                          {c.lastError ? ` — ${c.lastError}` : ''}
                        </div>
                      )}
                      {dl.failed === 0 && dl.dead === 0 && c.lastError && (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-tiny text-danger"><AlertCircle className="h-3 w-3" aria-hidden />{c.lastError}</div>
                      )}
                      {!c.lastError && c.lastSentAt && (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-tiny text-success"><CheckCircle2 className="h-3 w-3" aria-hidden />{t('observability.alertChannels.lastSent', { time: relativeTime(c.lastSentAt, t, locale) })}</div>
                      )}
                    </div>
                  </div>
                  {manage ? (
                    <div className="flex flex-shrink-0 items-center gap-1.5 pl-7 sm:pl-0">
                      <IconBtn title={t('observability.action.test')} onClick={() => onTest(c)} loading={busyId === c.id}><Send className="h-3.5 w-3.5" /></IconBtn>
                      <IconBtn title={c.isActive ? t('observability.action.pause') : t('observability.action.enable')} disabled={busyId === c.id}
                        onClick={() => run(c, () => updateAlertChannel(c.id, { isActive: !c.isActive }), c.isActive ? 'observability.alertChannels.pausedToast' : 'observability.alertChannels.enabledToast')}>
                        <Power className={cn('h-3.5 w-3.5', c.isActive ? 'text-success' : 'text-text-quaternary')} />
                      </IconBtn>
                      <IconBtn title={t('observability.action.delete')} disabled={busyId === c.id} onClick={() => setDeleting(c)}><Trash2 className="h-3.5 w-3.5 text-danger" /></IconBtn>
                    </div>
                  ) : (
                    <span className="flex-shrink-0 pl-7 text-tiny text-text-quaternary sm:pl-0">{t('observability.alertChannels.readOnly')}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && (adding ? (
          <div className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3" data-testid="obs-channel-form">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('observability.alertChannels.kindLabel')}>
              {(Object.keys(KIND_META) as ChannelKind[]).map((k) => {
                const Meta = KIND_META[k];
                return (
                  <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                    className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-caption focus:outline-none focus-visible:ring-2 focus-visible:ring-brand', kind === k ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-tertiary')}>
                    <Meta.icon className="h-3.5 w-3.5" aria-hidden />{t(Meta.labelKey)}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-tiny text-text-tertiary">{t('observability.alertChannels.scopeLabel')}
                <select className={cn(field, 'w-full')} value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'dataset')} data-testid="obs-channel-scope">
                  {editable.length > 0 && <option value="dataset">{t('observability.alertChannels.scope.dataset')}</option>}
                  {me?.canManageGlobalChannels && <option value="global">{t('observability.alertChannels.scope.globalLong')}</option>}
                </select>
              </label>
              {scope === 'dataset' ? (
                <label className="text-tiny text-text-tertiary">{t('observability.alertChannels.datasetLabel')}
                  <select className={cn(field, 'w-full')} value={datasetId} onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : '')} data-testid="obs-channel-dataset">
                    <option value="">{t('observability.alertChannels.pickDataset')}</option>
                    {editable.map((d) => <option key={d.datasetId} value={d.datasetId}>{d.dataset}</option>)}
                  </select>
                </label>
              ) : <span />}
              <label className="text-tiny text-text-tertiary">{t('observability.alertChannels.nameLabel')}
                <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('observability.alertChannels.namePlaceholder')} />
              </label>
              <label className="text-tiny text-text-tertiary">{t('observability.alertChannels.minSeverityLabel')}
                <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)} className={cn(field, 'w-full')}>
                  {SEV_OPTS.map((s) => <option key={s.v} value={s.v}>{t(s.labelKey)}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-tiny text-text-tertiary">{t('observability.alertChannels.targetLabel')}
              <Input size="sm" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t(KIND_META[kind].placeholderKey)} data-testid="obs-channel-target" />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>{t('observability.action.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={busyId === -1} onClick={onCreate} data-testid="obs-channel-create"
                leadingIcon={busyId === -1 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}>{t('observability.action.addChannel')}</Button>
            </div>
          </div>
        ) : canCreate ? (
          <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} data-testid="obs-channel-add">{t('observability.alertChannels.addNew')}</Button>
        ) : (
          <p className="text-tiny text-text-quaternary">{t('observability.alertChannels.cannotCreate')}</p>
        ))}
      </div>
      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) run(deleting, () => deleteAlertChannel(deleting.id), 'observability.alertChannels.deletedToast'); }}
        title={t('observability.alertChannels.deleteTitle')}
        description={t('observability.alertChannels.deleteConfirm', { name: deleting?.name ?? '' })}
        confirmLabel={t('observability.action.delete')}
      />
    </Modal>
  );
}

function IconBtn({ children, title, onClick, loading, disabled }: { children: React.ReactNode; title: string; onClick: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} disabled={loading || disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[rgb(var(--border-line))] text-text-tertiary hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}
