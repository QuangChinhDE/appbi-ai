'use client';

/**
 * Which AI a model step runs on: pick the PROVIDER, then one of its MODELS.
 *
 * That is the whole choice. The key is filled in from the author's AI Keys — their
 * default for that provider — and shown on one line underneath, so it is visible
 * without being another decision. Changing the provider re-picks the key for the
 * new provider; with no key for it, the line offers to add one in place.
 *
 * Used by the Agent step and by the Coordinate step's planner: both are model
 * calls, and both run on a key of their own.
 */
import { AlertTriangle, KeyRound } from 'lucide-react';
import React from 'react';

import { useAiKeys } from '@/components/agent-flows/aiKeys/AiKeysContext';
import { PROVIDER_LABELS } from '@/components/agent-flows/aiKeys/AiKeysModal';
import {
  DEFAULT_MODEL, DEFAULT_PROVIDER, defaultCredentialFor,
  type AiCredential, type Provider, type ProviderGroup,
} from '@/lib/agentFlows';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

import { Select } from './fields';

export interface ModelChoice {
  provider?: Provider;
  model?: string;
  credential_id?: number | null;
}

export function ModelPicker({ value, providers, onChange, testId = 'model-picker' }: {
  value: ModelChoice;
  providers: ProviderGroup[];
  onChange: (patch: ModelChoice) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const { credentials, loaded, canEdit, open } = useAiKeys();
  const provider: Provider = value.provider || DEFAULT_PROVIDER;
  const group = providers.find((p) => p.provider === provider);
  const models = group?.models || [];
  const usable = credentials.filter((c) => c.provider === provider);
  const current = credentials.find((c) => c.id === value.credential_id);

  const changeProvider = (next: Provider) => {
    const nextGroup = providers.find((p) => p.provider === next);
    onChange({
      provider: next,
      model: nextGroup?.models[0]?.model || (next === DEFAULT_PROVIDER ? DEFAULT_MODEL : ''),
      credential_id: defaultCredentialFor(next, credentials),
    });
  };

  const addKey = () => open({
    provider,
    onCreated: (c: AiCredential) => { if (c.provider === provider) onChange({ credential_id: c.id }); },
  });

  // A key id the list does not contain: deleted, unshared, or someone else's key on
  // a flow shared with me. The step keeps it (saving other edits does not strip it);
  // the run re-checks it and fails by name if it is no longer usable.
  const foreign = value.credential_id != null && loaded && !current;

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block">
          <span className="mb-0.5 block text-tiny text-text-tertiary">{t('agentFlows.model.provider')}</span>
          <Select
            value={provider}
            onChange={(v) => changeProvider(v as Provider)}
            options={(providers.length ? providers : [{ provider: DEFAULT_PROVIDER, label: 'OpenAI', models: [] }])
              .map((p) => ({ value: p.provider, label: p.label }))}
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-tiny text-text-tertiary">{t('agentFlows.model.model')}</span>
          <Select
            value={value.model || models[0]?.model || ''}
            onChange={(v) => onChange({ model: v })}
            options={models.map((m) => ({ value: m.model, label: m.label }))}
          />
        </label>
      </div>

      <div
        data-testid={`${testId}-key`}
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-caption',
          current ? 'bg-surface-2 text-text-secondary' : 'bg-warning/10 text-warning',
        )}
      >
        {current ? (
          <>
            <KeyRound className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 truncate">
              {t('agentFlows.model.keyLine', { name: current.name, hint: current.key_hint })}
            </span>
            {usable.length > 1 && (
              <select
                aria-label={t('agentFlows.model.changeKey')}
                data-testid={`${testId}-key-select`}
                value={String(current.id)}
                onChange={(e) => onChange({ credential_id: Number(e.target.value) })}
                className="ml-auto h-6 rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1 text-tiny"
              >
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ••••{c.key_hint}</option>
                ))}
              </select>
            )}
          </>
        ) : (
          <>
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0">
              {!loaded
                ? t('agentFlows.model.keyLoading')
                : foreign
                  ? t('agentFlows.model.keyUnavailable')
                  : usable.length > 0
                    // The author HAS keys for this provider; this step just has none
                    // picked. "You have no key" would be false.
                    ? t('agentFlows.model.noKeyPicked')
                    : t('agentFlows.model.noKey', { provider: PROVIDER_LABELS[provider] })}
            </span>
            {loaded && usable.length > 0 && (
              <select
                aria-label={t('agentFlows.model.changeKey')}
                data-testid={`${testId}-key-select`}
                value=""
                onChange={(e) => { if (e.target.value) onChange({ credential_id: Number(e.target.value) }); }}
                className="h-6 rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1 text-tiny text-text-primary"
              >
                <option value="">{t('agentFlows.model.pickKey')}</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ••••{c.key_hint}</option>
                ))}
              </select>
            )}
            {loaded && canEdit && (
              <button
                type="button"
                data-testid={`${testId}-add-key`}
                onClick={addKey}
                className="font-emphasis text-brand underline-offset-2 hover:underline"
              >
                {t('agentFlows.model.addKey')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Does this step have a key the current author can see as usable? For badges. */
export function stepHasUsableKey(credentialId: number | null | undefined, provider: Provider | undefined,
  credentials: AiCredential[]): boolean {
  if (credentialId == null) return false;
  const c = credentials.find((k) => k.id === credentialId);
  return !!c && c.provider === (provider || DEFAULT_PROVIDER);
}
