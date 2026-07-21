'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';

import {
  personalAccessTokensApi,
  type PersonalAccessTokenRecord,
  type AdminPersonalAccessTokenRecord,
} from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useI18n } from '@/providers/LanguageProvider';
import { usePermissions, hasPermission, type ModuleKey, type PermissionLevel } from '@/hooks/use-permissions';
import { moduleLabel, levelLabel, initials } from './shared';

const PAT_ENABLED_MODULES: ModuleKey[] = ['data_sources', 'datasets', 'explore_charts', 'dashboards', 'workboards'];
const LEVEL_ORDER: Record<PermissionLevel, number> = { none: 0, view: 1, edit: 2, full: 3 };
const EXPIRY_DAYS = ['30', '90', '180', '365'] as const;

const LAST_REVEALED_TOKEN_STORAGE_KEY = 'appbi:last-created-pat';

function buildEmptyScopes(modules: ModuleKey[]): Record<string, string> {
  return Object.fromEntries(modules.map((m) => [m, 'none']));
}
function getExpiryValue(expiresAt: string | null): string {
  if (!expiresAt) return 'never';
  const d = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(d) || d <= 30 * 864e5) return '30';
  if (d <= 90 * 864e5) return '90';
  if (d <= 180 * 864e5) return '180';
  return '365';
}
function isExpiredToken(token: PersonalAccessTokenRecord): boolean {
  if (!token.expires_at || token.revoked_at) return false;
  const e = new Date(token.expires_at).getTime();
  return !Number.isNaN(e) && e <= Date.now();
}

type TokenFormState = { tokenId: string; name: string; expiry: string; scopes: Record<string, string> };
type RevealedTokenState = { token: string; tokenId: string; name: string };

/* ═══════════ TOKENS TAB (sub-tabs) ═══════════ */

export function TokensTab() {
  const { t } = useI18n();
  const { data: permData } = usePermissions();
  const isAdmin = hasPermission(permData?.permissions, 'settings', 'full');
  const [view, setView] = useState<'mine' | 'all'>('mine');

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-h5 font-emphasis text-text-primary">{t('settings.tokens.title')}</h2>
          <p className="mt-0.5 text-caption text-text-tertiary">
            {view === 'all' ? t('settings.tokens.allDescription') : t('settings.tokens.description')}
          </p>
        </div>
        {isAdmin && (
          <Tabs
            variant="pill" size="sm" value={view} onChange={(v) => setView(v as 'mine' | 'all')}
            items={[{ key: 'mine', label: t('settings.tokens.mine') }, { key: 'all', label: t('settings.tokens.all') }]}
          />
        )}
      </div>
      {view === 'all' && isAdmin ? <AdminTokensPanel /> : <PersonalTokensPanel />}
    </div>
  );
}

/* ═══════════ PERSONAL TOKENS ═══════════ */

export function PersonalTokensPanel() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { data: permData } = usePermissions();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [editForm, setEditForm] = useState<TokenFormState | null>(null);
  const [revealed, setRevealed] = useState<RevealedTokenState | null>(null);
  const [revealedHidden, setRevealedHidden] = useState(false);
  const [tokenToDelete, setTokenToDelete] = useState<PersonalAccessTokenRecord | null>(null);

  const { data: tokens = [], isLoading } = useQuery<PersonalAccessTokenRecord[]>({
    queryKey: ['personal-access-tokens'], queryFn: personalAccessTokensApi.list,
  });

  const expiryOptions = useMemo(
    () => [...EXPIRY_DAYS.map((d) => ({ value: d, label: t('settings.tokens.days', { count: d }) })), { value: 'never', label: t('settings.tokens.noExpiry') }],
    [t],
  );

  const availableModules = useMemo(() => {
    const permissions = permData?.permissions ?? {};
    return PAT_ENABLED_MODULES.filter((m) => LEVEL_ORDER[(permissions[m] ?? 'none') as PermissionLevel] > 0);
  }, [permData?.permissions]);

  useEffect(() => {
    setScopes((cur) => ({ ...buildEmptyScopes(availableModules), ...cur }));
  }, [availableModules]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.sessionStorage.getItem(LAST_REVEALED_TOKEN_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as RevealedTokenState;
      if (parsed?.token && parsed?.tokenId) setRevealed(parsed);
    } catch { window.sessionStorage.removeItem(LAST_REVEALED_TOKEN_STORAGE_KEY); }
  }, []);

  const createMutation = useMutation({
    mutationFn: () => personalAccessTokensApi.create({ name, scopes, expires_in_days: expiry === 'never' ? null : Number(expiry) }),
    onSuccess: (data) => {
      const next = { token: data.token, tokenId: data.item.id, name: data.item.name };
      setRevealed(next); setRevealedHidden(false);
      if (typeof window !== 'undefined') window.sessionStorage.setItem(LAST_REVEALED_TOKEN_STORAGE_KEY, JSON.stringify(next));
      setName(''); setExpiry('90'); setScopes(buildEmptyScopes(availableModules));
      qc.invalidateQueries({ queryKey: ['personal-access-tokens'] });
      toast.success(t('settings.tokens.createdToast'));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.tokens.createFailed'))),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => personalAccessTokensApi.revoke(id),
    onSuccess: () => { setEditForm(null); qc.invalidateQueries({ queryKey: ['personal-access-tokens'] }); toast.success(t('settings.tokens.revokedToast')); },
    onError: (err) => toast.error(extractApiError(err, t('settings.tokens.revokeFailed'))),
  });

  const updateMutation = useMutation({
    mutationFn: (p: TokenFormState) => personalAccessTokensApi.update(p.tokenId, { name: p.name, scopes: p.scopes, expires_in_days: p.expiry === 'never' ? null : Number(p.expiry) }),
    onSuccess: () => { setEditForm(null); qc.invalidateQueries({ queryKey: ['personal-access-tokens'] }); toast.success(t('settings.tokens.updatedToast')); },
    onError: (err) => toast.error(extractApiError(err, t('settings.tokens.updateFailed'))),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => personalAccessTokensApi.deletePermanently(id),
    onSuccess: () => { setEditForm(null); qc.invalidateQueries({ queryKey: ['personal-access-tokens'] }); toast.success(t('settings.tokens.deletedToast')); },
    onError: (err) => toast.error(extractApiError(err, t('settings.tokens.deleteFailed'))),
  });

  const selectedScopeCount = Object.values(scopes).filter((l) => l && l !== 'none').length;
  const editScopeCount = Object.values(editForm?.scopes ?? {}).filter((l) => l && l !== 'none').length;

  const copyRevealed = async () => { if (revealed?.token) { await navigator.clipboard.writeText(revealed.token); toast.success(t('settings.tokens.copiedToast')); } };
  const forgetRevealed = () => { setRevealed(null); setRevealedHidden(false); if (typeof window !== 'undefined') window.sessionStorage.removeItem(LAST_REVEALED_TOKEN_STORAGE_KEY); };

  const startEditing = (token: PersonalAccessTokenRecord) => {
    const next = buildEmptyScopes(availableModules);
    for (const [m, l] of Object.entries(token.scopes)) next[m] = l;
    setEditForm({ tokenId: token.id, name: token.name, expiry: getExpiryValue(token.expires_at), scopes: next });
  };

  const fmt = (v: string | null) => (v ? new Date(v).toLocaleString(locale) : t('settings.common.never'));

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      {/* create */}
      <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="mb-4">
          <h3 className="text-small font-strong text-text-primary">{t('settings.tokens.createHeading')}</h3>
          <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.createHint')}</p>
        </div>
        <div className="space-y-4">
          <FieldGroup label={t('settings.tokens.name')} htmlFor="pat-name" required>
            <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.tokens.namePlaceholder')} />
          </FieldGroup>
          <FieldGroup label={t('settings.tokens.expiry')} htmlFor="pat-expiry">
            <Select id="pat-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {expiryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </FieldGroup>
          <div className="space-y-3">
            <div>
              <p className="text-label font-emphasis text-text-secondary">{t('settings.tokens.scopes')}</p>
              <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.scopesSelected', { count: selectedScopeCount })}</p>
            </div>
            {availableModules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-5 text-caption text-text-tertiary">
                {t('settings.tokens.noEligible')}
              </div>
            ) : (
              <div className="space-y-3">
                {availableModules.map((m) => {
                  const maxLevel = (permData?.permissions?.[m] ?? 'none') as PermissionLevel;
                  const allowed = (permData?.module_levels?.[m] ?? ['none']).filter((l) => LEVEL_ORDER[l as PermissionLevel] <= LEVEL_ORDER[maxLevel]);
                  return (
                    <div key={m} className="grid gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center">
                      <div>
                        <p className="text-caption font-emphasis text-text-primary">{moduleLabel(m, t)}</p>
                        <p className="text-tiny text-text-quaternary">{t('settings.tokens.maxLevel', { level: levelLabel(maxLevel, t) })}</p>
                      </div>
                      <Select value={scopes[m] ?? 'none'} onChange={(e) => setScopes((cur) => ({ ...cur, [m]: e.target.value }))}>
                        {allowed.map((l) => <option key={l} value={l}>{levelLabel(l, t)}</option>)}
                      </Select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <Button variant="primary" fullWidth loading={createMutation.isPending} disabled={!name.trim() || selectedScopeCount === 0} onClick={() => createMutation.mutate()}>
            {t('settings.tokens.create')}
          </Button>
        </div>

        {revealed && !revealedHidden && (
          <div className="mt-5 rounded-lg border border-brand/30 bg-brand/8 p-4">
            <p className="text-label font-emphasis text-text-primary">{t('settings.tokens.copyNow')}</p>
            <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.copyHint')}</p>
            <div className="mt-3 break-all rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-3 font-mono text-caption text-text-primary">{revealed.token}</div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" onClick={copyRevealed}>{t('settings.tokens.copy')}</Button>
              <Button variant="secondary" size="sm" onClick={() => setRevealedHidden(true)}>{t('settings.tokens.hide')}</Button>
              <Button variant="secondary" size="sm" onClick={forgetRevealed}>{t('settings.tokens.forget')}</Button>
            </div>
          </div>
        )}
        {revealed && revealedHidden && (
          <div className="mt-5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <p className="text-label font-emphasis text-text-primary">{t('settings.tokens.stillAvailableTitle')}</p>
            <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.stillAvailableBody', { name: revealed.name })}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" onClick={() => setRevealedHidden(false)}>{t('settings.tokens.showAgain')}</Button>
              <Button variant="secondary" size="sm" onClick={copyRevealed}>{t('settings.tokens.copyAgain')}</Button>
              <Button variant="secondary" size="sm" onClick={forgetRevealed}>{t('settings.tokens.forget')}</Button>
            </div>
          </div>
        )}
      </section>

      {/* issued */}
      <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-small font-strong text-text-primary">{t('settings.tokens.issued')}</h3>
            <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.issuedHint')}</p>
          </div>
          <Badge variant="neutral" size="sm">{t('settings.tokens.total', { count: tokens.length })}</Badge>
        </div>

        {isLoading ? (
          <div className="h-40 animate-pulse rounded-lg bg-surface-2" />
        ) : tokens.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-8 text-center text-caption text-text-tertiary">{t('settings.tokens.none')}</div>
        ) : (
          <div className="space-y-3">
            {tokens.map((token) => {
              const isRevoked = !!token.revoked_at;
              const isExpired = isExpiredToken(token);
              const isEditing = editForm?.tokenId === token.id;
              const statusKey = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';
              return (
                <div key={token.id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-caption font-emphasis text-text-primary">{token.name}</p>
                        <Badge variant={isRevoked || isExpired ? 'danger' : 'success'} size="xs">{t(`settings.tokens.status.${statusKey}`)}</Badge>
                      </div>
                      <p className="mt-1 font-mono text-tiny text-text-quaternary">{token.token_hint}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!isRevoked && (
                        <>
                          <Button variant="secondary" size="xs" disabled={updateMutation.isPending || deleteMutation.isPending} onClick={() => startEditing(token)}>{t('settings.tokens.edit')}</Button>
                          <Button variant="danger" size="xs" loading={revokeMutation.isPending && revokeMutation.variables === token.id} onClick={() => revokeMutation.mutate(token.id)}>{t('settings.tokens.revoke')}</Button>
                        </>
                      )}
                      <Button variant="secondary" size="xs" loading={deleteMutation.isPending && deleteMutation.variables === token.id} onClick={() => setTokenToDelete(token)}>{t('settings.tokens.deletePermanently')}</Button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(token.scopes).map(([m, l]) => (
                      <Badge key={`${token.id}-${m}`} variant="neutral" size="xs">{moduleLabel(m, t)}: {levelLabel(l, t)}</Badge>
                    ))}
                  </div>

                  <div className="mt-3 grid gap-2 text-tiny text-text-quaternary sm:grid-cols-3">
                    <div>{t('settings.tokens.created', { date: fmt(token.created_at) })}</div>
                    <div>{t('settings.tokens.lastUsed', { date: token.last_used_at ? fmt(token.last_used_at) : t('settings.common.never') })}</div>
                    <div>{t('settings.tokens.expires', { date: token.expires_at ? fmt(token.expires_at) : t('settings.tokens.noExpiry') })}</div>
                  </div>

                  {isEditing && editForm && (
                    <div className="mt-4 rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 p-4">
                      <div className="mb-3">
                        <p className="text-label font-emphasis text-text-primary">{t('settings.tokens.editHeading')}</p>
                        <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.editHint')}</p>
                      </div>
                      <div className="space-y-4">
                        <FieldGroup label={t('settings.tokens.name')} htmlFor={`token-name-${token.id}`} required>
                          <Input id={`token-name-${token.id}`} value={editForm.name} onChange={(e) => setEditForm((c) => c ? { ...c, name: e.target.value } : c)} />
                        </FieldGroup>
                        <FieldGroup label={t('settings.tokens.expiry')} htmlFor={`token-expiry-${token.id}`}>
                          <Select id={`token-expiry-${token.id}`} value={editForm.expiry} onChange={(e) => setEditForm((c) => c ? { ...c, expiry: e.target.value } : c)}>
                            {expiryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </FieldGroup>
                        <div className="space-y-3">
                          <div>
                            <p className="text-label font-emphasis text-text-secondary">{t('settings.tokens.scopes')}</p>
                            <p className="mt-1 text-caption text-text-tertiary">{t('settings.tokens.scopesSelected', { count: editScopeCount })}</p>
                          </div>
                          <div className="space-y-3">
                            {availableModules.map((m) => {
                              const maxLevel = (permData?.permissions?.[m] ?? 'none') as PermissionLevel;
                              const allowed = (permData?.module_levels?.[m] ?? ['none']).filter((l) => LEVEL_ORDER[l as PermissionLevel] <= LEVEL_ORDER[maxLevel]);
                              return (
                                <div key={`${token.id}-${m}`} className="grid gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center">
                                  <div>
                                    <p className="text-caption font-emphasis text-text-primary">{moduleLabel(m, t)}</p>
                                    <p className="text-tiny text-text-quaternary">{t('settings.tokens.maxLevel', { level: levelLabel(maxLevel, t) })}</p>
                                  </div>
                                  <Select value={editForm.scopes[m] ?? 'none'} onChange={(e) => setEditForm((c) => c ? { ...c, scopes: { ...c.scopes, [m]: e.target.value } } : c)}>
                                    {allowed.map((l) => <option key={l} value={l}>{levelLabel(l, t)}</option>)}
                                  </Select>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="primary" size="sm" loading={updateMutation.isPending} disabled={!editForm.name.trim() || editScopeCount === 0} onClick={() => updateMutation.mutate(editForm)}>{t('settings.tokens.saveChanges')}</Button>
                          <Button variant="secondary" size="sm" onClick={() => setEditForm(null)}>{t('settings.common.cancel')}</Button>
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

      <ConfirmDialog
        isOpen={!!tokenToDelete}
        onClose={() => setTokenToDelete(null)}
        onConfirm={() => { if (tokenToDelete) deleteMutation.mutate(tokenToDelete.id); }}
        title={tokenToDelete ? t('settings.tokens.deleteConfirmTitle', { name: tokenToDelete.name }) : t('settings.tokens.deletePermanently')}
        description={t('settings.tokens.deleteConfirmBody')}
        confirmLabel={t('settings.tokens.deletePermanently')}
        variant="danger"
      />
    </div>
  );
}

/* ═══════════ ADMIN OVERSIGHT ═══════════ */

function AdminTokensPanel() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [toRevoke, setToRevoke] = useState<AdminPersonalAccessTokenRecord | null>(null);

  const { data: tokens = [], isLoading } = useQuery<AdminPersonalAccessTokenRecord[]>({
    queryKey: ['personal-access-tokens', 'admin'], queryFn: personalAccessTokensApi.adminList,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => personalAccessTokensApi.adminRevoke(id),
    onSuccess: () => { setToRevoke(null); qc.invalidateQueries({ queryKey: ['personal-access-tokens', 'admin'] }); toast.success(t('settings.tokens.revokedToast')); },
    onError: (err) => toast.error(extractApiError(err, t('settings.tokens.revokeFailed'))),
  });

  const fmt = (v: string | null) => (v ? new Date(v).toLocaleDateString(locale) : t('settings.common.never'));
  const needle = search.trim().toLowerCase();
  const visible = tokens.filter((tk) =>
    !needle
    || tk.owner_name.toLowerCase().includes(needle)
    || tk.owner_email.toLowerCase().includes(needle)
    || tk.name.toLowerCase().includes(needle)
    || Object.keys(tk.scopes).some((m) => m.includes(needle)),
  );

  return (
    <div className="space-y-3">
      <div className="w-full sm:w-96">
        <Input size="sm" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('settings.tokens.searchPlaceholder')} leadingIcon={<Search />} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        {isLoading ? (
          <div className="p-12 text-center text-caption text-text-quaternary">{t('settings.users.loading')}</div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center text-caption text-text-quaternary">{tokens.length === 0 ? t('settings.tokens.allEmpty') : t('settings.tokens.allNoMatch', { query: search })}</div>
        ) : (
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2 text-tiny uppercase tracking-[0.14em] text-text-quaternary">
                <th className="px-4 py-3 text-left">{t('settings.tokens.owner')}</th>
                <th className="px-4 py-3 text-left">{t('settings.tokens.name')}</th>
                <th className="px-4 py-3 text-left">{t('settings.tokens.scopes')}</th>
                <th className="px-4 py-3 text-left">{t('settings.users.header.status')}</th>
                <th className="px-4 py-3 text-left">{t('settings.tokens.lastUsed', { date: '' }).trim()}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((tk) => {
                const isRevoked = !!tk.revoked_at;
                const isExpired = isExpiredToken(tk);
                const statusKey = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';
                return (
                  <tr key={tk.id} className="border-b border-[rgb(var(--border-line))] last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand text-tiny font-strong text-text-inverse">{initials(tk.owner_name || tk.owner_email)}</div>
                        <div className="min-w-0">
                          <p className="truncate font-emphasis text-text-primary">{tk.owner_name}</p>
                          <p className="truncate text-tiny text-text-quaternary">{tk.owner_email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-emphasis text-text-secondary">{tk.name}</p>
                      <p className="font-mono text-tiny text-text-quaternary">{tk.token_hint}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(tk.scopes).map(([m, l]) => (
                          <Badge key={`${tk.id}-${m}`} variant="neutral" size="xs">{moduleLabel(m, t)}: {levelLabel(l, t)}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={isRevoked || isExpired ? 'danger' : 'success'} size="xs">{t(`settings.tokens.status.${statusKey}`)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">{tk.last_used_at ? fmt(tk.last_used_at) : t('settings.common.never')}</td>
                    <td className="px-4 py-3 text-right">
                      {!isRevoked && (
                        <Button variant="danger" size="xs" onClick={() => setToRevoke(tk)}>{t('settings.tokens.revoke')}</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!toRevoke}
        onClose={() => setToRevoke(null)}
        onConfirm={() => { if (toRevoke) revokeMutation.mutate(toRevoke.id); }}
        title={t('settings.tokens.revokeConfirmTitle')}
        description={t('settings.tokens.revokeConfirmBody')}
        confirmLabel={t('settings.tokens.revoke')}
        variant="danger"
      />
    </div>
  );
}
