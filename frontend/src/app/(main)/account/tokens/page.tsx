'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  personalAccessTokensApi,
  type PersonalAccessTokenRecord,
} from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { usePermissions, type ModuleKey, type PermissionLevel } from '@/hooks/use-permissions';

const MODULE_LABELS: Record<ModuleKey, string> = {
  data_sources: 'Data sources',
  datasets: 'Datasets',
  explore_charts: 'Explore + charts',
  dashboards: 'Dashboards',
  report_templates: 'Report templates',
  ai_chat: 'AI chat',
  ai_agent: 'AI agent',
  settings: 'Settings',
};

const PAT_ENABLED_MODULES: ModuleKey[] = [
  'data_sources',
  'datasets',
  'explore_charts',
  'dashboards',
  'report_templates',
];

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
  full: 3,
};

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '365 days' },
  { value: 'never', label: 'No expiry' },
];

type TokenFormState = {
  tokenId: string;
  name: string;
  expiry: string;
  scopes: Record<string, string>;
};

type RevealedTokenState = {
  token: string;
  tokenId: string;
  name: string;
};

const LAST_REVEALED_TOKEN_STORAGE_KEY = 'appbi:last-created-pat';

function buildEmptyScopes(modules: ModuleKey[]): Record<string, string> {
  return Object.fromEntries(modules.map((module) => [module, 'none']));
}

function getExpiryValue(expiresAt: string | null): string {
  if (!expiresAt) return 'never';
  const deltaMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(deltaMs) || deltaMs <= 30 * 24 * 60 * 60 * 1000) return '30';
  if (deltaMs <= 90 * 24 * 60 * 60 * 1000) return '90';
  if (deltaMs <= 180 * 24 * 60 * 60 * 1000) return '180';
  return '365';
}

function isExpiredToken(token: PersonalAccessTokenRecord): boolean {
  if (!token.expires_at || token.revoked_at) return false;
  const expiresAt = new Date(token.expires_at).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function PersonalAccessTokensPage() {
  const qc = useQueryClient();
  const { data: permData } = usePermissions();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [editForm, setEditForm] = useState<TokenFormState | null>(null);
  const [revealedTokenState, setRevealedTokenState] = useState<RevealedTokenState | null>(null);
  const [isRevealedTokenHidden, setIsRevealedTokenHidden] = useState(false);

  const { data: tokens = [], isLoading } = useQuery<PersonalAccessTokenRecord[]>({
    queryKey: ['personal-access-tokens'],
    queryFn: personalAccessTokensApi.list,
  });

  const availableModules = useMemo(() => {
    const permissions = permData?.permissions ?? {};
    return PAT_ENABLED_MODULES.filter(
      (module) => LEVEL_ORDER[(permissions[module] ?? 'none') as PermissionLevel] > 0,
    );
  }, [permData?.permissions]);

  useEffect(() => {
    setScopes((current) => {
      const next = { ...current };
      for (const module of availableModules) {
        if (!(module in next)) next[module] = 'none';
      }
      return next;
    });
  }, [availableModules]);

  useEffect(() => {
    setScopes((current) => {
      const next = { ...buildEmptyScopes(availableModules), ...current };
      return next;
    });
  }, [availableModules]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedValue = window.sessionStorage.getItem(LAST_REVEALED_TOKEN_STORAGE_KEY);
    if (!storedValue) return;

    try {
      const parsed = JSON.parse(storedValue) as RevealedTokenState;
      if (parsed?.token && parsed?.tokenId) {
        setRevealedTokenState(parsed);
      }
    } catch {
      window.sessionStorage.removeItem(LAST_REVEALED_TOKEN_STORAGE_KEY);
    }
  }, []);

  const createMutation = useMutation({
    mutationFn: () => personalAccessTokensApi.create({
      name,
      scopes,
      expires_in_days: expiry === 'never' ? null : Number(expiry),
    }),
    onSuccess: (data) => {
      const nextRevealedTokenState = {
        token: data.token,
        tokenId: data.item.id,
        name: data.item.name,
      };
      setRevealedTokenState(nextRevealedTokenState);
      setIsRevealedTokenHidden(false);
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(
          LAST_REVEALED_TOKEN_STORAGE_KEY,
          JSON.stringify(nextRevealedTokenState),
        );
      }
      setName('');
      setExpiry('90');
      setScopes(buildEmptyScopes(availableModules));
      qc.invalidateQueries({ queryKey: ['personal-access-tokens'] });
      toast.success('API token created');
    },
    onError: (error: unknown) => {
      toast.error(extractApiError(error, 'Failed to create token'));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => personalAccessTokensApi.revoke(tokenId),
    onSuccess: () => {
      setEditForm(null);
      qc.invalidateQueries({ queryKey: ['personal-access-tokens'] });
      toast.success('API token revoked');
    },
    onError: (error: unknown) => {
      toast.error(extractApiError(error, 'Failed to revoke token'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: TokenFormState) => personalAccessTokensApi.update(payload.tokenId, {
      name: payload.name,
      scopes: payload.scopes,
      expires_in_days: payload.expiry === 'never' ? null : Number(payload.expiry),
    }),
    onSuccess: () => {
      setEditForm(null);
      qc.invalidateQueries({ queryKey: ['personal-access-tokens'] });
      toast.success('API token updated');
    },
    onError: (error: unknown) => {
      toast.error(extractApiError(error, 'Failed to update token'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (tokenId: string) => personalAccessTokensApi.deletePermanently(tokenId),
    onSuccess: () => {
      setEditForm(null);
      qc.invalidateQueries({ queryKey: ['personal-access-tokens'] });
      toast.success('API token deleted');
    },
    onError: (error: unknown) => {
      toast.error(extractApiError(error, 'Failed to delete token'));
    },
  });

  const selectedScopeCount = Object.values(scopes).filter((level) => level && level !== 'none').length;

  const editScopeCount = Object.values(editForm?.scopes ?? {}).filter((level) => level && level !== 'none').length;

  async function copyRevealedToken() {
    if (!revealedTokenState?.token) return;
    await navigator.clipboard.writeText(revealedTokenState.token);
    toast.success('Token copied');
  }

  function hideRevealedToken() {
    setIsRevealedTokenHidden(true);
  }

  function showRevealedToken() {
    setIsRevealedTokenHidden(false);
  }

  function forgetRevealedToken() {
    setRevealedTokenState(null);
    setIsRevealedTokenHidden(false);
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(LAST_REVEALED_TOKEN_STORAGE_KEY);
    }
  }

  function startEditing(token: PersonalAccessTokenRecord) {
    const nextScopes = buildEmptyScopes(availableModules);
    for (const [module, level] of Object.entries(token.scopes)) {
      nextScopes[module] = level;
    }
    setEditForm({
      tokenId: token.id,
      name: token.name,
      expiry: getExpiryValue(token.expires_at),
      scopes: nextScopes,
    });
  }

  function confirmPermanentDelete(token: PersonalAccessTokenRecord) {
    const confirmed = window.confirm(
      `Delete token "${token.name}" permanently? This removes it from the list and cannot be undone.`,
    );
    if (!confirmed) return;
    deleteMutation.mutate(token.id);
  }

  return (
    <div className="w-full max-w-[1200px] px-8 py-6">
      <div className="mb-6">
        <h1 className="text-h1 text-text-primary font-emphasis">API Tokens</h1>
        <p className="mt-1 text-caption text-text-tertiary">
          Create personal access tokens for MCP and other non-browser clients. The secret is shown only once.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <div className="mb-4">
            <h2 className="text-small font-strong text-text-primary">Create token</h2>
            <p className="mt-1 text-caption text-text-tertiary">
              Select one or more modules. Each module can only be granted up to your current access level.
            </p>
          </div>

          <div className="space-y-4">
            <FieldGroup label="Token name" htmlFor="pat-name" required>
              <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude MCP token" />
            </FieldGroup>

            <FieldGroup label="Expiry" htmlFor="pat-expiry">
              <Select id="pat-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </FieldGroup>

            <div className="space-y-3">
              <div>
                <p className="text-label font-emphasis text-text-secondary">Module scopes</p>
                <p className="mt-1 text-caption text-text-tertiary">
                  Selected modules: {selectedScopeCount}
                </p>
              </div>
              {availableModules.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-5 text-caption text-text-tertiary">
                  No eligible modules available for token access.
                </div>
              ) : (
                <div className="space-y-3">
                  {availableModules.map((module) => {
                    const maxLevel = (permData?.permissions?.[module] ?? 'none') as PermissionLevel;
                    const allowedLevels = (permData?.module_levels?.[module] ?? ['none'])
                      .filter((level) => LEVEL_ORDER[level as PermissionLevel] <= LEVEL_ORDER[maxLevel as PermissionLevel]);
                    return (
                      <div key={module} className="grid gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center">
                        <div>
                          <p className="text-caption font-emphasis text-text-primary">{MODULE_LABELS[module]}</p>
                          <p className="text-tiny text-text-quaternary">Your max level: {maxLevel}</p>
                        </div>
                        <Select
                          value={scopes[module] ?? 'none'}
                          onChange={(e) => setScopes((current) => ({ ...current, [module]: e.target.value }))}
                        >
                          {allowedLevels.map((level) => (
                            <option key={level} value={level}>{level}</option>
                          ))}
                        </Select>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Button
              variant="primary"
              fullWidth
              loading={createMutation.isPending}
              disabled={!name.trim() || selectedScopeCount === 0}
              onClick={() => createMutation.mutate()}
            >
              Create token
            </Button>
          </div>

          {revealedTokenState && !isRevealedTokenHidden && (
            <div className="mt-5 rounded-lg border border-brand/30 bg-brand/8 p-4">
              <p className="text-label font-emphasis text-text-primary">Copy this token now</p>
              <p className="mt-1 text-caption text-text-tertiary">
                This secret stays available in this browser session until you explicitly forget it.
              </p>
              <div className="mt-3 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-3 font-mono text-caption text-text-primary break-all">
                {revealedTokenState.token}
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" size="sm" onClick={copyRevealedToken}>Copy token</Button>
                <Button variant="secondary" size="sm" onClick={hideRevealedToken}>Hide</Button>
                <Button variant="secondary" size="sm" onClick={forgetRevealedToken}>Forget token</Button>
              </div>
            </div>
          )}

          {revealedTokenState && isRevealedTokenHidden && (
            <div className="mt-5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4">
              <p className="text-label font-emphasis text-text-primary">Last created token is still available</p>
              <p className="mt-1 text-caption text-text-tertiary">
                {revealedTokenState.name} is hidden right now, but you can show it again and copy it without creating a new token.
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" size="sm" onClick={showRevealedToken}>Show token again</Button>
                <Button variant="secondary" size="sm" onClick={copyRevealedToken}>Copy again</Button>
                <Button variant="secondary" size="sm" onClick={forgetRevealedToken}>Forget token</Button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-small font-strong text-text-primary">Issued tokens</h2>
              <p className="mt-1 text-caption text-text-tertiary">
                Revoke tokens you no longer need, edit active tokens, or remove them permanently from the list.
              </p>
            </div>
            <Badge variant="neutral" size="sm">{tokens.length} total</Badge>
          </div>

          {isLoading ? (
            <div className="h-40 animate-pulse rounded-lg bg-surface-2" />
          ) : tokens.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-8 text-center text-caption text-text-tertiary">
              No API tokens created yet.
            </div>
          ) : (
            <div className="space-y-3">
              {tokens.map((token) => {
                const isRevoked = !!token.revoked_at;
                const isExpired = isExpiredToken(token);
                const isEditing = editForm?.tokenId === token.id;
                const statusLabel = isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Active';
                return (
                  <div key={token.id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-caption font-emphasis text-text-primary">{token.name}</p>
                          <Badge variant={isRevoked || isExpired ? 'danger' : 'neutral'} size="xs">
                            {statusLabel}
                          </Badge>
                        </div>
                        <p className="mt-1 font-mono text-tiny text-text-quaternary">{token.token_hint}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {!isRevoked && (
                          <>
                            <Button
                              variant="secondary"
                              size="xs"
                              disabled={updateMutation.isPending || deleteMutation.isPending}
                              onClick={() => startEditing(token)}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="danger"
                              size="xs"
                              loading={revokeMutation.isPending && revokeMutation.variables === token.id}
                              onClick={() => revokeMutation.mutate(token.id)}
                            >
                              Revoke
                            </Button>
                          </>
                        )}
                        <Button
                          variant="secondary"
                          size="xs"
                          loading={deleteMutation.isPending && deleteMutation.variables === token.id}
                          onClick={() => confirmPermanentDelete(token)}
                        >
                          Delete permanently
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {Object.entries(token.scopes).map(([module, level]) => (
                        <Badge key={`${token.id}-${module}`} variant="neutral" size="xs">
                          {MODULE_LABELS[module as ModuleKey] ?? module}: {level}
                        </Badge>
                      ))}
                    </div>

                    <div className="mt-3 grid gap-2 text-tiny text-text-quaternary sm:grid-cols-3">
                      <div>Created: {formatDate(token.created_at)}</div>
                      <div>Last used: {token.last_used_at ? formatDate(token.last_used_at) : 'Never'}</div>
                      <div>Expires: {formatDate(token.expires_at)}</div>
                    </div>

                    {isEditing && editForm && (
                      <div className="mt-4 rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 p-4">
                        <div className="mb-3">
                          <p className="text-label font-emphasis text-text-primary">Edit token</p>
                          <p className="mt-1 text-caption text-text-tertiary">
                            Updating a token keeps the same secret and replaces its scopes and expiry.
                          </p>
                        </div>

                        <div className="space-y-4">
                          <FieldGroup label="Token name" htmlFor={`token-name-${token.id}`} required>
                            <Input
                              id={`token-name-${token.id}`}
                              value={editForm.name}
                              onChange={(e) => setEditForm((current) => current ? { ...current, name: e.target.value } : current)}
                            />
                          </FieldGroup>

                          <FieldGroup label="Expiry" htmlFor={`token-expiry-${token.id}`}>
                            <Select
                              id={`token-expiry-${token.id}`}
                              value={editForm.expiry}
                              onChange={(e) => setEditForm((current) => current ? { ...current, expiry: e.target.value } : current)}
                            >
                              {EXPIRY_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </Select>
                          </FieldGroup>

                          <div className="space-y-3">
                            <div>
                              <p className="text-label font-emphasis text-text-secondary">Module scopes</p>
                              <p className="mt-1 text-caption text-text-tertiary">
                                Selected modules: {editScopeCount}
                              </p>
                            </div>
                            <div className="space-y-3">
                              {availableModules.map((module) => {
                                const maxLevel = (permData?.permissions?.[module] ?? 'none') as PermissionLevel;
                                const allowedLevels = (permData?.module_levels?.[module] ?? ['none'])
                                  .filter((level) => LEVEL_ORDER[level as PermissionLevel] <= LEVEL_ORDER[maxLevel as PermissionLevel]);
                                return (
                                  <div key={`${token.id}-${module}`} className="grid gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center">
                                    <div>
                                      <p className="text-caption font-emphasis text-text-primary">{MODULE_LABELS[module]}</p>
                                      <p className="text-tiny text-text-quaternary">Your max level: {maxLevel}</p>
                                    </div>
                                    <Select
                                      value={editForm.scopes[module] ?? 'none'}
                                      onChange={(e) => setEditForm((current) => current ? {
                                        ...current,
                                        scopes: { ...current.scopes, [module]: e.target.value },
                                      } : current)}
                                    >
                                      {allowedLevels.map((level) => (
                                        <option key={level} value={level}>{level}</option>
                                      ))}
                                    </Select>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              loading={updateMutation.isPending}
                              disabled={!editForm.name.trim() || editScopeCount === 0}
                              onClick={() => updateMutation.mutate(editForm)}
                            >
                              Save changes
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setEditForm(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}