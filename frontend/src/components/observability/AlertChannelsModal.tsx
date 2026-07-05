'use client';

/**
 * Alert channels manager — where new incidents get dispatched (email / Slack /
 * webhook), severity-gated. Backed by /observability/alert-channels.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Mail, Slack, Webhook, Send, Loader2, Power, AlertCircle, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { relativeTime } from './ui';
import {
  listAlertChannels, createAlertChannel, updateAlertChannel, deleteAlertChannel, testAlertChannel,
  type AlertChannel, type ChannelKind, type Severity,
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

export function AlertChannelsModal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  // new-channel form
  const [kind, setKind] = useState<ChannelKind>('email');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [minSeverity, setMinSeverity] = useState<Severity>('warning');

  const reload = useCallback(() => {
    setLoading(true);
    return listAlertChannels().then(setChannels).catch(() => setChannels([])).finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const onCreate = async () => {
    if (!target.trim()) { toast.error(t('observability.alertChannels.targetRequired')); return; }
    setBusyId(-1);
    try {
      await createAlertChannel({ kind, name: name.trim() || t(KIND_META[kind].labelKey), target: target.trim(), min_severity: minSeverity });
      setAdding(false); setName(''); setTarget('');
      await reload();
      toast.success(t('observability.alertChannels.createSuccess'));
    } catch (e: any) { toast.error(e?.response?.data?.detail ?? t('observability.alertChannels.createFailed')); }
    finally { setBusyId(null); }
  };
  const onToggle = async (c: AlertChannel) => { setBusyId(c.id); try { await updateAlertChannel(c.id, { isActive: !c.isActive }); await reload(); } finally { setBusyId(null); } };
  const onDelete = async (c: AlertChannel) => { if (!confirm(t('observability.alertChannels.deleteConfirm', { name: c.name }))) return; setBusyId(c.id); try { await deleteAlertChannel(c.id); await reload(); } finally { setBusyId(null); } };
  const onTest = async (c: AlertChannel) => {
    setBusyId(c.id);
    try {
      const r = await testAlertChannel(c.id);
      r.ok ? toast.success(t('observability.alertChannels.testSuccess')) : toast.error(t('observability.alertChannels.testFailed', { error: r.error ?? '' }));
      await reload();
    } finally { setBusyId(null); }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('observability.alertChannels.title')} size="lg"
      footer={<Button variant="ghost" onClick={onClose}>{t('observability.action.close')}</Button>}>
      <div className="space-y-4">
        <p className="text-caption text-text-tertiary">
          {t('observability.alertChannels.description')}
        </p>

        {loading ? (
          <p className="py-6 text-center text-caption text-text-tertiary">{t('observability.loading')}</p>
        ) : channels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-4 py-8 text-center text-caption text-text-quaternary">{t('observability.alertChannels.empty')}</div>
        ) : (
          <ul className="divide-y divide-[rgb(var(--border-line))] rounded-lg border border-[rgb(var(--border-line))]">
            {channels.map((c) => {
              const Meta = KIND_META[c.kind];
              return (
                <li key={c.id} className={cn('flex items-center gap-3 px-3 py-2.5', !c.isActive && 'opacity-50')}>
                  <Meta.icon className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-caption font-emphasis text-text-primary">{c.name}</span>
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">{t(SEV_OPTS.find((s) => s.v === c.minSeverity)?.labelKey ?? 'observability.alertChannels.minSeverity.warning')}</span>
                    </div>
                    <div className="truncate text-tiny text-text-quaternary">{c.target}</div>
                    {c.lastError
                      ? <div className="mt-0.5 inline-flex items-center gap-1 text-tiny text-danger"><AlertCircle className="h-3 w-3" />{c.lastError}</div>
                      : c.lastSentAt && <div className="mt-0.5 inline-flex items-center gap-1 text-tiny text-success"><CheckCircle2 className="h-3 w-3" />{t('observability.alertChannels.lastSent', { time: relativeTime(c.lastSentAt, t, locale) })}</div>}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <IconBtn title={t('observability.action.test')} onClick={() => onTest(c)} loading={busyId === c.id}><Send className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title={c.isActive ? t('observability.action.pause') : t('observability.action.enable')} onClick={() => onToggle(c)}><Power className={cn('h-3.5 w-3.5', c.isActive ? 'text-success' : 'text-text-quaternary')} /></IconBtn>
                    <IconBtn title={t('observability.action.delete')} onClick={() => onDelete(c)}><Trash2 className="h-3.5 w-3.5 text-danger" /></IconBtn>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {adding ? (
          <div className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
            <div className="flex gap-2">
              {(Object.keys(KIND_META) as ChannelKind[]).map((k) => {
                const Meta = KIND_META[k];
                return (
                  <button key={k} onClick={() => setKind(k)}
                    className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-caption', kind === k ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-tertiary')}>
                    <Meta.icon className="h-3.5 w-3.5" />{t(Meta.labelKey)}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('observability.alertChannels.namePlaceholder')} />
              <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}
                className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus:border-brand focus:outline-none">
                {SEV_OPTS.map((s) => <option key={s.v} value={s.v}>{t(s.labelKey)}</option>)}
              </select>
            </div>
            <Input size="sm" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t(KIND_META[kind].placeholderKey)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>{t('observability.action.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={busyId === -1} onClick={onCreate}
                leadingIcon={busyId === -1 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}>{t('observability.action.addChannel')}</Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>{t('observability.alertChannels.addNew')}</Button>
        )}
      </div>
    </Modal>
  );
}

function IconBtn({ children, title, onClick, loading }: { children: React.ReactNode; title: string; onClick: () => void; loading?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={loading}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(var(--border-line))] text-text-tertiary hover:bg-surface-2 disabled:opacity-50">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}
