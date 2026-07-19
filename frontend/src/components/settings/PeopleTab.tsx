'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, ChevronRight, UserX, UserCheck, Trash2, Users as UsersIcon,
} from 'lucide-react';

import { permissionsApi, usersApi } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Select, FieldGroup } from '@/components/ui/Input';
import { Badge, StatusDot } from '@/components/ui/Badge';
import { Modal } from '@/components/common/Modal';
import { AccessLevelToggle } from '@/components/ui/AccessLevelToggle';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useUrlNav } from '@/hooks/use-url-nav';

import {
  type UserRecord, type TeamRecord, type PermissionMatrix, type UserPermissionRow,
  MODULE_ICONS, groupModules, levelLabels, levelHelp, LEVEL_LABEL_KEYS, LEVEL_CLASSES,
  moduleLabel, levelLabel, roleLabel, deriveRole, presetLabel, PRESETS,
  ROLE_BADGE_VARIANT, authMethodLabel, initials,
  InviteModal, ManageTeamsModal,
} from './shared';

type PresetsData = { presets: Record<string, Record<string, string>> };

export function PeopleTab() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const nav = useUrlNav();
  const selectedId = nav.get('user');
  const { data: me } = useCurrentUser();

  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [showInvite, setShowInvite] = useState(false);
  const [manageTeamsFor, setManageTeamsFor] = useState<UserRecord | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserRecord | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});

  const { data: matrix, isLoading: matrixLoading } = useQuery<PermissionMatrix>({
    queryKey: ['permissions', 'matrix'], queryFn: permissionsApi.getMatrix,
  });
  const { data: users = [], isLoading: usersLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'], queryFn: usersApi.getAll,
  });
  const { data: teams = [] } = useQuery<TeamRecord[]>({
    queryKey: ['permissions', 'teams'], queryFn: permissionsApi.getTeams,
  });
  const { data: presetsData } = useQuery<PresetsData>({
    queryKey: ['permissions', 'presets'], queryFn: permissionsApi.getPresets,
  });

  // Reset unsaved edits whenever the selected person changes.
  useEffect(() => { setPending({}); }, [selectedId]);

  const modules = matrix?.modules ?? [];
  const moduleLevels = matrix?.module_levels ?? {};
  const permByUser = useMemo(() => {
    const map = new Map<string, UserPermissionRow>();
    (matrix?.users ?? []).forEach((row) => map.set(row.user_id, row));
    return map;
  }, [matrix]);

  const roleForUser = (userId: string): string => {
    const row = permByUser.get(userId);
    if (!row) return 'custom';
    return deriveRole(row.permissions, presetsData?.presets, modules);
  };

  const needle = search.trim().toLowerCase();
  const visibleUsers = users.filter((u) => {
    if (needle && !u.full_name.toLowerCase().includes(needle) && !u.email.toLowerCase().includes(needle)) return false;
    if (teamFilter === 'all') return true;
    if (teamFilter === 'unassigned') return u.teams.length === 0;
    return u.teams.some((team) => team.id === teamFilter);
  });

  const selectedUser = users.find((u) => u.id === selectedId) ?? null;
  const selectedPerm = selectedId ? permByUser.get(selectedId) : undefined;

  const saveMutation = useMutation({
    mutationFn: (perms: Record<string, string>) => permissionsApi.updateUserPermissions(selectedId!, perms),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['permissions', 'me'] });
      setPending({});
      toast.success(t('settings.people.savedToast'));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.people.saveFailed'))),
  });

  const presetMutation = useMutation({
    mutationFn: (preset: string) => permissionsApi.applyPreset(selectedId!, preset),
    onSuccess: (_d, preset) => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      setPending({});
      toast.success(t('settings.matrix.presetApplied', { preset: presetLabel(preset, t) }));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.matrix.presetFailed'))),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'deactivated' }) => usersApi.update(id, { status }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
      toast.success(vars.status === 'active' ? t('settings.danger.reactivatedToast') : t('settings.users.deactivatedToast'));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.users.failed'))),
  });

  const getEffective = (m: string) => pending[m] ?? selectedPerm?.permissions[m] ?? 'none';
  const setLevel = (m: string, level: string) => {
    const base = selectedPerm?.permissions[m] ?? 'none';
    setPending((p) => {
      const next = { ...p };
      if (level === base) delete next[m];
      else next[m] = level;
      return next;
    });
  };
  const pendingCount = Object.keys(pending).length;
  const levelLabelMap = levelLabels(t);

  const isSelf = selectedUser?.id === me?.id;
  const isOwner = (selectedPerm?.permissions.settings ?? 'none') === 'full';

  const isLoading = matrixLoading || usersLoading;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* ── Master: people list ── */}
      <div className="flex flex-col rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        <div className="border-b border-[rgb(var(--border-line))] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Input size="sm" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('settings.people.searchPlaceholder')} leadingIcon={<Search />} />
            </div>
            <IconButton aria-label={t('settings.users.add')} variant="primary" size="sm" onClick={() => setShowInvite(true)}>
              <Plus className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Select size="sm" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className="flex-1">
              <option value="all">{t('settings.users.allTeams')}</option>
              <option value="unassigned">{t('settings.users.unassignedUsers')}</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </Select>
            <span className="whitespace-nowrap text-tiny text-text-quaternary">
              {t('settings.people.count', { visible: visibleUsers.length, total: users.length })}
            </span>
          </div>
        </div>

        <div className="lg:max-h-[calc(100vh-260px)] lg:overflow-y-auto p-1.5">
          {isLoading ? (
            <div className="space-y-1.5 p-1.5">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-2" />)}
            </div>
          ) : visibleUsers.length === 0 ? (
            <div className="p-8 text-center text-caption text-text-quaternary">
              {users.length === 0 ? t('settings.people.emptyList') : t('settings.people.noMatch', { query: search })}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {visibleUsers.map((u) => {
                const active = u.id === selectedId;
                const role = roleForUser(u.id);
                return (
                  <li key={u.id}>
                    <button
                      onClick={() => nav.set({ user: u.id })}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        active ? 'bg-brand/10' : 'hover:bg-surface-2',
                      )}
                    >
                      <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand text-tiny font-strong text-text-inverse">
                        {initials(u.full_name || u.email)}
                        <StatusDot
                          variant={u.status === 'active' ? 'success' : 'danger'}
                          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface-1"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-caption font-emphasis', active ? 'text-text-primary' : 'text-text-secondary')}>{u.full_name}</p>
                        <p className="truncate text-tiny text-text-quaternary">{u.email}</p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Badge variant={ROLE_BADGE_VARIANT[role] ?? 'neutral'} size="xs">{roleLabel(role, t)}</Badge>
                        <ChevronRight className={cn('h-3.5 w-3.5', active ? 'text-brand' : 'text-text-quaternary')} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Detail: selected person ── */}
      <div className="min-w-0">
        {!selectedUser || !selectedPerm ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-10 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand/10 text-brand">
              <UsersIcon className="h-5 w-5" />
            </div>
            <p className="max-w-xs text-caption text-text-tertiary">{t('settings.people.selectPrompt')}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
            {/* header */}
            <div className="flex flex-col gap-4 border-b border-[rgb(var(--border-line))] p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand text-caption font-strong text-text-inverse">
                  {initials(selectedUser.full_name || selectedUser.email)}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-h5 font-emphasis text-text-primary">{selectedUser.full_name}</h2>
                    {isOwner && <Badge variant="info" size="xs">{t('settings.users.owner')}</Badge>}
                  </div>
                  <p className="truncate text-caption text-text-tertiary">{selectedUser.email}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-tiny text-text-quaternary">
                    <Badge variant={selectedUser.status === 'active' ? 'success' : 'danger'} size="xs" dot>
                      {t(`settings.common.status.${selectedUser.status}`)}
                    </Badge>
                    <Badge variant="neutral" size="xs">{authMethodLabel(selectedUser, t)}</Badge>
                    <span>
                      {selectedUser.last_login_at
                        ? t('settings.people.lastLogin', { date: new Date(selectedUser.last_login_at).toLocaleDateString(locale) })
                        : t('settings.people.neverLoggedIn')}
                    </span>
                  </div>
                </div>
              </div>
              {/* role apply */}
              <div className="flex items-center gap-2">
                <span className="text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.role.label')}</span>
                <Select
                  size="sm"
                  value=""
                  disabled={presetMutation.isPending}
                  onChange={(e) => { if (e.target.value) presetMutation.mutate(e.target.value); }}
                  title={t('settings.matrix.presetTitle')}
                >
                  <option value="">{t('settings.role.apply')}</option>
                  {PRESETS.map((p) => <option key={p} value={p}>{presetLabel(p, t)}</option>)}
                </Select>
              </div>
            </div>

            {/* access by area */}
            <div className="p-5">
              <div className="mb-4">
                <h3 className="text-small font-strong text-text-primary">{t('settings.people.access')}</h3>
                <p className="mt-0.5 text-caption text-text-tertiary">{t('settings.people.accessHint')}</p>
              </div>

              <div className="space-y-5">
                {groupModules(modules).map((group) => (
                  <div key={group.key}>
                    <p className="mb-2 text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">{t(group.labelKey)}</p>
                    <div className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] divide-y divide-[rgb(var(--border-line))]">
                      {group.modules.map((m) => {
                        const Icon = MODULE_ICONS[m];
                        const val = getEffective(m);
                        const changed = pending[m] !== undefined;
                        const allowed = moduleLevels[m] || ['none', 'view', 'edit', 'full'];
                        return (
                          <div key={m} className="flex items-center justify-between gap-3 bg-surface-1 px-3 py-2.5">
                            <div className="flex min-w-0 items-center gap-2.5">
                              {Icon && <Icon className="h-4 w-4 flex-shrink-0 text-text-tertiary" />}
                              <span className="truncate text-caption font-emphasis text-text-secondary">{moduleLabel(m, t)}</span>
                            </div>
                            <AccessLevelToggle
                              value={val}
                              allowed={allowed}
                              labels={levelLabelMap}
                              changed={changed}
                              ariaLabel={moduleLabel(m, t)}
                              onChange={(lvl) => setLevel(m, lvl)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* teams */}
              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">{t('settings.people.teams')}</p>
                  <Button variant="subtle" size="xs" onClick={() => setManageTeamsFor(selectedUser)}>{t('settings.people.manageTeams')}</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedUser.teams.length > 0
                    ? selectedUser.teams.map((team) => <Badge key={team.id} variant="brand" size="sm">{team.name}</Badge>)
                    : <span className="text-caption text-text-quaternary">{t('settings.users.unassigned')}</span>}
                </div>
              </div>

              {/* danger zone */}
              <div className="mt-6 rounded-lg border border-danger/25 bg-danger/5 p-4">
                <p className="text-caption font-strong text-danger">{t('settings.danger.title')}</p>
                {isSelf ? (
                  <p className="mt-2 text-caption text-text-tertiary">{t('settings.danger.self')}</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-caption text-text-tertiary">
                        {selectedUser.status === 'active' ? t('settings.danger.deactivateHint') : t('settings.danger.deleteHint')}
                      </p>
                      <div className="flex items-center gap-2">
                        {selectedUser.status === 'active' ? (
                          <Button
                            variant="secondary" size="sm" leadingIcon={<UserX className="h-3.5 w-3.5" />}
                            loading={statusMutation.isPending}
                            onClick={() => statusMutation.mutate({ id: selectedUser.id, status: 'deactivated' })}
                          >
                            {t('settings.danger.deactivate')}
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="secondary" size="sm" leadingIcon={<UserCheck className="h-3.5 w-3.5" />}
                              loading={statusMutation.isPending}
                              onClick={() => statusMutation.mutate({ id: selectedUser.id, status: 'active' })}
                            >
                              {t('settings.danger.reactivate')}
                            </Button>
                            <Button
                              variant="danger" size="sm" leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                              onClick={() => setDeleteUser(selectedUser)}
                            >
                              {t('settings.danger.delete')}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* sticky save bar */}
            {pendingCount > 0 && (
              <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-xl border-t border-[rgb(var(--border-strong))] bg-surface-1/95 px-5 py-3 backdrop-blur">
                <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">
                  <span className="h-2 w-2 rounded-full bg-warning" />
                  {t(pendingCount === 1 ? 'settings.people.unsavedOne' : 'settings.people.unsaved', { count: pendingCount })}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setPending({})} disabled={saveMutation.isPending}>
                    {t('settings.people.discard')}
                  </Button>
                  <Button variant="primary" size="sm" loading={saveMutation.isPending} onClick={() => saveMutation.mutate(pending)}>
                    {t('settings.common.saveChanges')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* legend */}
      <div className="lg:col-span-2 flex flex-wrap items-center gap-4 text-tiny text-text-tertiary">
        {Object.keys(LEVEL_LABEL_KEYS).map((val) => (
          <div key={val} className="flex items-center gap-1.5">
            <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 font-emphasis', LEVEL_CLASSES[val])}>{levelLabel(val, t)}</span>
            <span>— {levelHelp(val, t)}</span>
          </div>
        ))}
      </div>

      {showInvite && (
        <InviteModal
          availableTeams={teams}
          defaultTeamIds={teamFilter !== 'all' && teamFilter !== 'unassigned' ? [teamFilter] : []}
          onClose={() => setShowInvite(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            qc.invalidateQueries({ queryKey: ['permissions'] });
            setShowInvite(false);
          }}
        />
      )}
      {manageTeamsFor && (
        <ManageTeamsModal
          user={manageTeamsFor}
          availableTeams={teams}
          onClose={() => setManageTeamsFor(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
            setManageTeamsFor(null);
          }}
        />
      )}
      {deleteUser && (
        <DeleteUserModal
          user={deleteUser}
          onClose={() => setDeleteUser(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            qc.invalidateQueries({ queryKey: ['permissions'] });
            if (deleteUser.id === selectedId) nav.set({ user: null });
            setDeleteUser(null);
          }}
        />
      )}
    </div>
  );
}

/* ═══════════ DELETE (permanent) MODAL ═══════════ */

const REASSIGN_KEYS = ['data_sources', 'datasets', 'explore_charts', 'dashboards', 'workboards'];

function DeleteUserModal({ user, onClose, onSuccess }: { user: UserRecord; onClose: () => void; onSuccess: () => void }) {
  const { t } = useI18n();
  const [confirmText, setConfirmText] = useState('');

  const { data: impact, isLoading } = useQuery({
    queryKey: ['user-deletion-impact', user.id],
    queryFn: () => usersApi.deletionImpact(user.id),
  });

  const del = useMutation({
    mutationFn: () => usersApi.deletePermanently(user.id),
    onSuccess: () => { toast.success(t('settings.delete.deletedToast')); onSuccess(); },
    onError: (err) => toast.error(extractApiError(err, t('settings.delete.failed'))),
  });

  const canDelete = confirmText.trim().toLowerCase() === user.email.toLowerCase();
  const counts = impact?.counts ?? {};
  const reassigned = REASSIGN_KEYS.map((k) => ({ k, n: counts[k] ?? 0 })).filter((x) => x.n > 0);
  const removed = [
    { k: 'shares', n: counts.shares_given ?? 0 },
    { k: 'tokens', n: counts.api_tokens ?? 0 },
  ].filter((x) => x.n > 0);
  const nothingOwned = reassigned.length === 0 && removed.length === 0;

  return (
    <Modal
      isOpen onClose={onClose} title={t('settings.delete.title', { name: user.full_name })} size="md"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="danger" disabled={!canDelete || del.isPending} loading={del.isPending} onClick={() => del.mutate()}>
            {t('settings.delete.confirm')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-caption text-text-secondary">
          {t('settings.delete.intro', { email: impact?.reassign_to_email ?? '' })}
        </p>

        {isLoading ? (
          <div className="h-16 animate-pulse rounded-lg bg-surface-2" />
        ) : nothingOwned ? (
          <p className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-tertiary">
            {t('settings.delete.nothingOwned')}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {reassigned.length > 0 && (
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="mb-2 text-tiny font-emphasis uppercase tracking-[0.14em] text-success">{t('settings.delete.reassignHeading')}</p>
                <ul className="space-y-1">
                  {reassigned.map(({ k, n }) => (
                    <li key={k} className="flex justify-between text-caption text-text-secondary">
                      <span>{moduleLabel(k, t)}</span><span className="font-strong text-text-primary">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {removed.length > 0 && (
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                <p className="mb-2 text-tiny font-emphasis uppercase tracking-[0.14em] text-danger">{t('settings.delete.removeHeading')}</p>
                <ul className="space-y-1">
                  {removed.map(({ k, n }) => (
                    <li key={k} className="flex justify-between text-caption text-text-secondary">
                      <span>{k === 'shares' ? t('settings.delete.shares') : t('settings.delete.tokens')}</span>
                      <span className="font-strong text-text-primary">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <FieldGroup label={t('settings.delete.confirmLabel')}>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={user.email} autoComplete="off" />
        </FieldGroup>
      </div>
    </Modal>
  );
}
