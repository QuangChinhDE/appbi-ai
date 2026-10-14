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
import { AlertTriangle, CheckCircle2, Circle, KeyRound, Loader2, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { useAiKeys } from '@/components/agent-flows/aiKeys/AiKeysContext';
import { PROVIDER_LABELS } from '@/components/agent-flows/aiKeys/AiKeysModal';
import {
  checkModel, DEFAULT_MODEL, DEFAULT_PROVIDER, defaultCredentialFor,
  type AiCredential, type ModelCheck, type ModelInfo, type Provider, type ProviderGroup,
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
  const chosen = value.model || models[0]?.model || '';
  const info = models.find((m) => m.model === chosen);

  // What the author is shown in the list: the name, then how far the claim goes.
  const optionLabel = (m: ModelInfo) => {
    const parts = [m.label];
    if (m.lifecycle && m.lifecycle !== 'active') parts.push(t(`agentFlows.model.life.${m.lifecycle}`));
    if (m.certification) parts.push(t(`agentFlows.model.status.${m.certification.status}`));
    return parts.join(' · ');
  };
  // A stored model the catalogue no longer lists is SHOWN as itself, never
  // silently replaced by the first option.
  const options = models.filter((m) => m.selectable !== false || m.model === chosen)
    .map((m) => ({ value: m.model, label: optionLabel(m) }));
  if (chosen && !info) options.unshift({ value: chosen, label: chosen });

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
            value={chosen}
            onChange={(v) => onChange({ model: v })}
            options={options}
          />
        </label>
      </div>

      <ModelFacts testId={testId} model={chosen} info={info} />

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

      <ModelCheckPanel testId={testId} credentialId={current ? current.id : null} model={chosen} />
    </div>
  );
}

function ModelFacts({ testId, model, info }: { testId: string; model: string; info?: ModelInfo }) {
  const { t } = useI18n();
  if (!info) {
    return model ? (
      <p data-testid={`${testId}-unknown`} className="rounded-md bg-danger/10 px-2 py-1 text-caption text-danger">
        {t('agentFlows.model.unknownModel', { model })}
      </p>
    ) : null;
  }
  const price = info.price;
  const cert = info.certification;
  return (
    <div data-testid={`${testId}-facts`} className="space-y-0.5 rounded-md bg-surface-2 px-2 py-1.5 text-caption text-text-secondary">
      {info.purpose && <p>{info.purpose}</p>}
      <p className="flex flex-wrap gap-x-2">
        <span data-testid={`${testId}-tools`}>{info.tools ? t('agentFlows.model.tools') : t('agentFlows.model.noTools')}</span>
        {info.reasoning && info.reasoning !== 'none' && <span>· {t('agentFlows.model.reasoning')}</span>}
      </p>
      <p data-testid={`${testId}-price`}>
        {price && price.input_per_mtok != null && price.output_per_mtok != null
          ? t('agentFlows.model.price', { input: price.input_per_mtok, output: price.output_per_mtok })
          : t('agentFlows.model.priceUnknown')}
        {price?.source && (
          <>
            {' '}(<a href={price.source} target="_blank" rel="noreferrer" className="underline">
              {t('agentFlows.model.priceSource', { date: price.as_of })}</a>)
          </>
        )}
        {price?.note && <span className="text-text-tertiary"> — {price.note}</span>}
      </p>
      {cert && (
        <p data-testid={`${testId}-cert`} data-status={cert.status}
          className={cert.status === 'unverified' ? 'text-warning' : 'text-success'}>
          {cert.status === 'certified'
            ? t('agentFlows.model.certified', { date: cert.as_of })
            : cert.status === 'legacy_verified'
              ? t('agentFlows.model.legacyVerified')
              : t('agentFlows.model.unverified', { reason: cert.reason || '' })}
        </p>
      )}
      {info.lifecycle_warning && (
        <p data-testid={`${testId}-lifecycle`} className="flex items-start gap-1 text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{info.lifecycle_warning}
        </p>
      )}
    </div>
  );
}

function ModelCheckPanel({ testId, credentialId, model }: { testId: string; credentialId: number | null; model: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelCheck | null>(null);
  const [failed, setFailed] = useState('');
  // A result is about ONE key and ONE model: it goes when either changes.
  useEffect(() => { setResult(null); setFailed(''); }, [credentialId, model]);

  const run = async () => {
    if (credentialId == null || !model) return;
    setBusy(true);
    setFailed('');
    try {
      setResult(await checkModel(credentialId, model, true));
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setFailed(typeof detail === 'string' ? detail : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid={`${testId}-check`}
        disabled={busy || credentialId == null || !model}
        onClick={run}
        title={credentialId == null ? t('agentFlows.model.checkNeedsKey') : undefined}
        className="inline-flex items-center gap-1 text-caption font-emphasis text-brand underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-text-tertiary disabled:no-underline"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {busy ? t('agentFlows.model.checking') : t('agentFlows.model.check')}
      </button>
      {failed && <p className="text-caption text-danger">{failed}</p>}
      {result && (
        <div data-testid={`${testId}-check-result`} data-verdict={result.verdict}
          className={cn('rounded-md px-2 py-1.5 text-caption',
            result.verdict === 'ready' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning')}>
          <p className="font-emphasis">{t(`agentFlows.model.verdict.${result.verdict}`)}</p>
          <ul className="mt-0.5 space-y-0.5 text-text-secondary">
            {result.levels.map((lv) => (
              <li key={lv.level} data-testid={`${testId}-level-${lv.level}`} data-status={lv.status} data-code={lv.code || ''}
                className="flex items-start gap-1">
                {lv.status === 'pass' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success" />
                  : lv.status === 'fail' ? <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-danger" />
                    : <Circle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />}
                <span><span className="font-emphasis">{t(`agentFlows.model.level.${lv.level}`)}:</span> {lv.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
