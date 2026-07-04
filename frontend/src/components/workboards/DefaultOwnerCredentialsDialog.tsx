'use client';

import React from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

interface Props {
  isOpen: boolean;
  workboardName: string;
  username: string;
  pin: string;
  /** Confirmed: user clicked the "I saved this" button. */
  onConfirm: () => void;
}

type CopyKey = 'username' | 'pin' | 'both';

export function DefaultOwnerCredentialsDialog({
  isOpen,
  workboardName,
  username,
  pin,
  onConfirm,
}: Props) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = React.useState(false);
  const [copied, setCopied] = React.useState<CopyKey | null>(null);

  React.useEffect(() => {
    if (isOpen) {
      setConfirmed(false);
      setCopied(null);
    }
  }, [isOpen]);

  const copy = async (key: CopyKey, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      toast.error(t('workboards.credentials.copyFailed'));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      // Click backdrop / X is treated as "I will lose this" — bounce a warning
      // toast and force the user back to the confirm checkbox. We never
      // silently drop the credentials.
      onClose={() => {
        if (confirmed) {
          onConfirm();
          return;
        }
        toast.error(
          t('workboards.credentials.mustSaveBeforeClose'),
        );
      }}
      title={t('workboards.credentials.title')}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy('both', `${username} / ${pin}`)}
            leadingIcon={
              copied === 'both' ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
          >
            {copied === 'both' ? t('workboards.credentials.copied') : t('workboards.credentials.copyBoth')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!confirmed}
            onClick={onConfirm}
            title={
              confirmed
                ? t('workboards.credentials.enterBuilderTitle')
                : t('workboards.credentials.confirmSaveTitle')
            }
          >
            {t('workboards.credentials.enterBuilder')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="text-tiny text-text-secondary">
            <p className="font-emphasis text-text-primary">
              {t('workboards.credentials.oneTimeTitle')}
            </p>
            <p className="mt-0.5">
              {t('workboards.credentials.oneTimeBodyPrefix')}{' '}
              <span className="font-emphasis text-text-primary">"{workboardName}"</span>.
              {' '}
              {t('workboards.credentials.oneTimeBodyMiddle')}{' '}
              <span className="font-emphasis">{t('workboards.credentials.usersTab')}</span>{' '}
              {t('workboards.credentials.oneTimeBodySuffix')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <CredentialField
            label={t('workboards.credentials.username')}
            value={username}
            onCopy={() => copy('username', username)}
            copied={copied === 'username'}
            icon={<KeyRound className="h-3.5 w-3.5" />}
          />
          <CredentialField
            label={t('workboards.credentials.pin')}
            value={pin}
            onCopy={() => copy('pin', pin)}
            copied={copied === 'pin'}
            mono
          />
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2.5 text-tiny text-text-secondary hover:border-brand">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>
            {t('workboards.credentials.confirmSaved')}
          </span>
        </label>
      </div>
    </Modal>
  );
}

function CredentialField({
  label,
  value,
  onCopy,
  copied,
  mono,
  icon,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-emphasis text-text-tertiary">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 select-all rounded bg-surface-1 px-2 py-1.5 text-body text-text-primary ${
            mono ? 'font-mono tracking-wider' : ''
          }`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="flex shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-tiny font-medium text-text-secondary hover:border-brand hover:text-brand"
          title={t('workboards.credentials.copyFieldTitle', { label: label.toLowerCase() })}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> {t('workboards.credentials.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> {t('workboards.credentials.copy')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
