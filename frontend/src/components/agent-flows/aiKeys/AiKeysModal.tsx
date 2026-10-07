'use client';

/**
 * AI Keys — where an author keeps the provider keys their Agent Flow steps run on.
 *
 * A key is entered ONCE here and picked by any step of any flow afterwards. The
 * secret goes up on create / replace and never comes back: rows show a name, the
 * vendor and the last four characters. Sharing a key lets a colleague USE it in
 * their own steps; only the owner renames it into a default, shares or deletes it.
 */
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { CheckCircle2, Eye, EyeOff, KeyRound, Plus, Share2, Star, Trash2, XCircle } from 'lucide-react';
import React from 'react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldGroup, Input } from '@/components/ui/Input';
import {
  createCredential, credentialUsage, deleteCredential, testCredential, updateCredential,
  type AiCredential, type AiCredentialUsage, type Provider,
} from '@/lib/agentFlows';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
};
const PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini'];

function detailMsg(e: unknown): string | undefined {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === 'string' ? d : undefined;
}

interface Props {
  credentials: AiCredential[];
  /** False until the first list arrives: "no keys yet" would be a false claim. */
  loaded: boolean;
  canEdit: boolean;
  initialProvider?: Provider;
  onChanged: () => Promise<AiCredential[]>;
  onCreated: (credential: AiCredential) => void;
  onClose: () => void;
}

export function AiKeysModal({ credentials, loaded, canEdit, initialProvider, onChanged, onCreated, onClose }: Props) {
  const { t } = useI18n();
  const [adding, setAdding] = React.useState<boolean>(!!initialProvider && canEdit);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [sharing, setSharing] = React.useState<AiCredential | null>(null);
  const [deleting, setDeleting] = React.useState<{ row: AiCredential; usage: AiCredentialUsage[] } | null>(null);
  const [testing, setTesting] = React.useState<number | null>(null);

  const remove = async (row: AiCredential) => {
    try {
      await deleteCredential(row.id);
      toast.success(t('agentFlows.aiKeys.deleted', { name: row.name }));
      await onChanged();
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.aiKeys.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  };

  const askDelete = async (row: AiCredential) => {
    try {
      setDeleting({ row, usage: await credentialUsage(row.id) });
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.aiKeys.deleteFailed'));
    }
  };

  const runTest = async (row: AiCredential) => {
    setTesting(row.id);
    try {
      const r = await testCredential(row.id);
      if (r.ok) toast.success(t('agentFlows.aiKeys.testOk', { name: row.name, ms: r.latency_ms }));
      else toast.error(t('agentFlows.aiKeys.testFailed', { name: row.name, error: r.error || '' }));
      await onChanged();
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.aiKeys.testFailed', { name: row.name, error: '' }));
    } finally {
      setTesting(null);
    }
  };

  const makeDefault = async (row: AiCredential) => {
    try {
      await updateCredential(row.id, { is_default: true });
      await onChanged();
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.aiKeys.saveFailed'));
    }
  };

  const grouped = PROVIDERS
    .map((p) => ({ provider: p, rows: credentials.filter((c) => c.provider === p) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      <AppModalShell
        onClose={onClose}
        title={t('agentFlows.aiKeys.title')}
        description={t('agentFlows.aiKeys.description')}
        icon={<KeyRound className="h-4 w-4" />}
        maxWidthClass="max-w-2xl"
        testId="ai-keys-modal"
        footer={(
          <div className="flex w-full items-center justify-between gap-2">
            <p className="text-caption text-text-tertiary">{t('agentFlows.aiKeys.secretNote')}</p>
            <Button size="sm" variant="secondary" onClick={onClose}>{t('agentFlows.common.close')}</Button>
          </div>
        )}
      >
        <div className="space-y-4">
          {canEdit && !adding && (
            <Button
              data-testid="ai-key-add"
              size="sm"
              leadingIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => { setAdding(true); setEditing(null); }}
            >
              {t('agentFlows.aiKeys.add')}
            </Button>
          )}
          {adding && (
            <KeyForm
              mode="create"
              initialProvider={initialProvider || 'openai'}
              existingNames={credentials.filter((c) => c.mine).map((c) => c.name)}
              onCancel={() => setAdding(false)}
              onSaved={async (created) => {
                setAdding(false);
                await onChanged();
                onCreated(created);
                // Opened from a step's picker: the key is now on that step, and the
                // author came here only to make it — hand them straight back.
                if (initialProvider) onClose();
              }}
            />
          )}

          {!loaded && (
            <p data-testid="ai-keys-loading" className="text-caption text-text-tertiary">
              {t('agentFlows.model.keyLoading')}
            </p>
          )}
          {loaded && grouped.length === 0 && !adding && (
            <EmptyState
              icon={<KeyRound className="h-5 w-5" />}
              title={t('agentFlows.aiKeys.emptyTitle')}
              description={t('agentFlows.aiKeys.emptyDescription')}
            />
          )}

          {grouped.map((g) => (
            <section key={g.provider} className="space-y-2">
              <h3 className="text-label font-emphasis text-text-secondary">{PROVIDER_LABELS[g.provider]}</h3>
              <ul className="space-y-2">
                {g.rows.map((row) => (
                  <li
                    key={row.id}
                    data-testid="ai-key-row"
                    data-key-name={row.name}
                    className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2.5"
                  >
                    {editing === row.id ? (
                      <KeyForm
                        mode="edit"
                        row={row}
                        initialProvider={row.provider}
                        existingNames={credentials.filter((c) => c.mine && c.id !== row.id).map((c) => c.name)}
                        onCancel={() => setEditing(null)}
                        onSaved={async () => { setEditing(null); await onChanged(); }}
                      />
                    ) : (
                      <KeyRow
                        row={row}
                        testing={testing === row.id}
                        onTest={() => void runTest(row)}
                        onEdit={() => { setEditing(row.id); setAdding(false); }}
                        onDefault={() => void makeDefault(row)}
                        onShare={() => setSharing(row)}
                        onDelete={() => void askDelete(row)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </AppModalShell>

      {sharing && (
        <ShareDialog
          resourceType="ai_credential"
          resourceId={sharing.id}
          resourceName={sharing.name}
          notice={t('agentFlows.aiKeys.shareNotice')}
          onClose={() => { setSharing(null); void onChanged(); }}
        />
      )}
      <ConfirmDialog
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void remove(deleting.row); }}
        title={t('agentFlows.aiKeys.deleteTitle', { name: deleting?.row.name ?? '' })}
        description={
          deleting && deleting.usage.length > 0
            ? t('agentFlows.aiKeys.deleteInUse', {
              count: deleting.usage.length,
              steps: deleting.usage.slice(0, 6).map((u) => `${u.flow_name} › ${u.step_name}`).join('; '),
            })
            : t('agentFlows.aiKeys.deleteUnused')
        }
        confirmLabel={t('agentFlows.aiKeys.deleteConfirm')}
        variant="danger"
      />
    </>
  );
}

function KeyRow({ row, testing, onTest, onEdit, onDefault, onShare, onDelete }: {
  row: AiCredential;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const perms = getResourcePermissions(row.permission, row.capabilities);
  const canChange = perms.canEdit;
  const canManage = perms.canDelete;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-caption font-emphasis text-text-primary">{row.name}</span>
          <span className="font-mono text-tiny text-text-tertiary">••••{row.key_hint}</span>
          {row.is_default && row.mine && (
            <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-tiny text-brand">
              <Star className="h-3 w-3" /> {t('agentFlows.aiKeys.default')}
            </span>
          )}
          {!row.mine && row.owner && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-tiny text-text-tertiary">
              {t('agentFlows.aiKeys.sharedBy', { name: row.owner.name || row.owner.email })}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-tiny text-text-tertiary">
          <span>{t('agentFlows.aiKeys.usedBy', { count: row.usage_count ?? 0 })}</span>
          {row.last_test_at && (
            <span className={cn('inline-flex items-center gap-1', row.last_test_ok ? 'text-success' : 'text-danger')}>
              {row.last_test_ok
                ? <><CheckCircle2 className="h-3 w-3" /> {t('agentFlows.aiKeys.lastTestOk')}</>
                : <><XCircle className="h-3 w-3" /> {row.last_test_error || t('agentFlows.aiKeys.lastTestFailed')}</>}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <Button data-testid="ai-key-test" size="xs" variant="ghost" disabled={testing} onClick={onTest}>
          {testing ? t('agentFlows.aiKeys.testing') : t('agentFlows.aiKeys.test')}
        </Button>
        {canChange && (
          <Button size="xs" variant="ghost" onClick={onEdit}>{t('agentFlows.aiKeys.edit')}</Button>
        )}
        {canManage && row.mine && !row.is_default && (
          <Button size="xs" variant="ghost" onClick={onDefault}>{t('agentFlows.aiKeys.makeDefault')}</Button>
        )}
        {canManage && (
          <Button size="xs" variant="ghost" aria-label={t('agentFlows.aiKeys.share')} title={t('agentFlows.aiKeys.share')} onClick={onShare}>
            <Share2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {canManage && (
          <Button data-testid="ai-key-delete" size="xs" variant="ghost" aria-label={t('agentFlows.aiKeys.delete')} title={t('agentFlows.aiKeys.delete')} onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        )}
      </div>
    </div>
  );
}

function KeyForm({ mode, row, initialProvider, existingNames, onCancel, onSaved }: {
  mode: 'create' | 'edit';
  row?: AiCredential;
  initialProvider: Provider;
  existingNames: string[];
  onCancel: () => void;
  onSaved: (credential: AiCredential) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = React.useState<Provider>(row?.provider || initialProvider);
  const [name, setName] = React.useState(row?.name || '');
  const [secret, setSecret] = React.useState('');
  const [show, setShow] = React.useState(false);
  const [asDefault, setAsDefault] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const trimmed = name.trim();
  const clash = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const valid = !!trimmed && !clash && (mode === 'edit' || !!secret.trim());

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const saved = mode === 'create'
        ? await createCredential({ name: trimmed, provider, secret: secret.trim(), is_default: asDefault || undefined })
        : await updateCredential(row!.id, { name: trimmed, secret: secret.trim() || undefined });
      toast.success(mode === 'create'
        ? t('agentFlows.aiKeys.created', { name: saved.name })
        : t('agentFlows.aiKeys.saved', { name: saved.name }));
      setSecret('');
      await onSaved(saved);
    } catch (e) {
      toast.error(detailMsg(e) || t('agentFlows.aiKeys.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/40 p-3"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      {mode === 'create' && (
        <FieldGroup label={t('agentFlows.aiKeys.provider')} htmlFor="ai-key-provider">
          <select
            id="ai-key-provider"
            data-testid="ai-key-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            className="h-9 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 text-caption text-text-primary outline-none focus:border-brand"
          >
            {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
          </select>
        </FieldGroup>
      )}
      <FieldGroup
        label={t('agentFlows.aiKeys.name')}
        htmlFor="ai-key-name"
        error={clash ? t('agentFlows.aiKeys.nameTaken') : undefined}
      >
        <Input
          id="ai-key-name"
          data-testid="ai-key-name"
          value={name}
          maxLength={120}
          placeholder={t('agentFlows.aiKeys.namePlaceholder', { provider: PROVIDER_LABELS[provider] })}
          onChange={(e) => setName(e.target.value)}
        />
      </FieldGroup>
      <FieldGroup
        label={mode === 'create' ? t('agentFlows.aiKeys.secret') : t('agentFlows.aiKeys.replaceSecret')}
        htmlFor="ai-key-secret"
        description={mode === 'edit' ? t('agentFlows.aiKeys.replaceSecretHint') : t('agentFlows.aiKeys.secretHint')}
      >
        <Input
          id="ai-key-secret"
          data-testid="ai-key-secret"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={secret}
          placeholder={mode === 'edit' && row ? `••••${row.key_hint}` : ''}
          onChange={(e) => setSecret(e.target.value)}
          trailingIcon={(
            <button
              type="button"
              aria-label={show ? t('agentFlows.aiKeys.hide') : t('agentFlows.aiKeys.show')}
              onClick={() => setShow((v) => !v)}
              className="text-text-tertiary hover:text-text-primary"
            >
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          )}
        />
      </FieldGroup>
      {mode === 'create' && (
        <label className="flex items-center gap-2 text-caption text-text-secondary">
          <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
          {t('agentFlows.aiKeys.setDefault')}
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('agentFlows.aiKeys.cancel')}
        </Button>
        <Button data-testid="ai-key-save" type="submit" size="sm" disabled={!valid || busy}>
          {busy ? t('agentFlows.aiKeys.saving') : t('agentFlows.aiKeys.save')}
        </Button>
      </div>
    </form>
  );
}
