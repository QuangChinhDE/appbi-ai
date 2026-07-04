'use client';

/**
 * WorkspaceCreateModal — create a new workspace from inside the workboard
 * builder. The new workspace's menu is pre-filled with the current workboard
 * (access_mode defaults to public_app_users on the BE), so the board is
 * immediately reachable + the live preview can switch to it.
 */
import React, { useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { workspaceAdminApi, type WorkspaceAdmin } from '@/lib/api/workspaces';
import { useI18n } from '@/providers/LanguageProvider';

function errorDetail(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response
    ?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

interface Props {
  workboardName: string;
  workboardSlug: string;
  workboardIcon?: string | null;
  workboardDescription?: string | null;
  onClose: () => void;
  onCreated: (ws: WorkspaceAdmin) => void;
}

export function WorkspaceCreateModal({
  workboardName,
  workboardSlug,
  workboardIcon,
  workboardDescription,
  onClose,
  onCreated,
}: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(() => t('workboards.workspace.defaultName', { name: workboardName }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('workboards.workspace.nameRequired'));
      return;
    }
    if (!workboardSlug) {
      setError(t('workboards.workspace.slugRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await workspaceAdminApi.createWithWorkboard({
        name: trimmed,
        workboardSlug,
        // label MUST be non-empty (public menu validator drops empty-label cards)
        workboardLabel: workboardName?.trim() || workboardSlug,
        workboardIcon: workboardIcon ?? null,
        workboardDescription: workboardDescription ?? null,
      });
      onCreated(ws);
      onClose();
    } catch (err) {
      setError(errorDetail(err, t('workboards.workspace.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('workboards.workspace.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('workboards.workspace.cancel')}
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>
            {t('workboards.workspace.create')}
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-caption font-emphasis text-text-secondary">
        {t('workboards.workspace.nameLabel')}
      </label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder={t('workboards.workspace.namePlaceholder')}
        className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus-visible:shadow-focus-brand focus-visible:outline-none"
      />
      <p className="mt-2 text-caption text-text-tertiary">
        {t('workboards.workspace.autoAddPrefix')} “{workboardName}” {t('workboards.workspace.autoAddSuffix')}
      </p>
      <p className="mt-1 text-caption text-text-quaternary">
        {t('workboards.workspace.publicLinkPrefix')} (<code>/ws/…</code>) {t('workboards.workspace.publicLinkSuffix')}
      </p>
      {error && <p className="mt-2 text-caption text-danger">{t('workboards.workspace.errorLabel')} {error}</p>}
    </Modal>
  );
}
