'use client';

import { Suspense, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, Trash2, Users, Search } from 'lucide-react';

import { permissionsApi, usersApi } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { AccessLevelToggle } from '@/components/ui/AccessLevelToggle';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import { useUrlNav } from '@/hooks/use-url-nav';

import { PeopleTab } from '@/components/settings/PeopleTab';
import { TokensTab } from '@/components/settings/TokensTab';
import {
  type TeamRecord, type UserRecord, type PermissionMatrix,
  groupModules, levelLabels, levelLabel, levelHelp, LEVEL_LABEL_KEYS, LEVEL_CLASSES,
  moduleLabel, presetLabel, roleLabel, deriveRole, PRESETS,
  ROLE_BADGE_VARIANT, TeamModal,
} from '@/components/settings/shared';

type HubTab = 'people' | 'teams' | 'roles' | 'tokens' | 'compare';
const TAB_KEYS: HubTab[] = ['people', 'teams', 'roles', 'tokens', 'compare'];

export default function PermissionsPage() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="px-8 py-10 text-caption text-text-tertiary">{t('settings.users.loading')}</div>}>
      <PermissionsHub />
    </Suspense>
  );
}

function PermissionsHub() {
  const { t } = useI18n();
  const nav = useUrlNav();
  const rawTab = nav.get('tab') as HubTab | null;
  const activeTab: HubTab = rawTab && TAB_KEYS.includes(rawTab) ? rawTab : 'people';

  return (
    <div className="w-full max-w-[1400px] px-6 py-6 lg:px-8">
      <div className="mb-5">
        <h1 className="text-h1 font-emphasis text-text-primary">{t('settings.permissions.title')}</h1>
        <p className="mt-1 text-caption text-text-tertiary">{t('settings.permissions.description')}</p>
      </div>

      <div className="mb-6">
        <Tabs
          variant="underline"
          value={activeTab}
          onChange={(k) => nav.set({ tab: k, user: null })}
          items={[
            { key: 'people', label: t('settings.tabs.people') },
            { key: 'teams', label: t('settings.tabs.teams') },
            { key: 'roles', label: t('settings.tabs.roles') },
            { key: 'tokens', label: t('settings.tabs.tokens') },
            { key: 'compare', label: t('settings.tabs.compare') },
          ]}
        />
      </div>

      {activeTab === 'people' && <PeopleTab />}
      {activeTab === 'teams' && <TeamsTab />}
      {activeTab === 'roles' && <RolesTab />}
      {activeTab === 'tokens' && <TokensTab />}
      {activeTab === 'compare' && <CompareTab />}
    </div>
  );
}

/* ═══════════ TEAMS ═══════════ */

function TeamsTab() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [editingTeam, setEditingTeam] = useState<TeamRecord | null>(null);
  const [showTeamModal, setShowTeamModal] = useState(false);

  const { data: teams = [], isLoading: isTeamsLoading } = useQuery<TeamRecord[]>({
    queryKey: ['permissions', 'teams'], queryFn: permissionsApi.getTeams,
  });
  const { data: users = [], isLoading: isUsersLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'], queryFn: usersApi.getAll,
  });

  const deleteMutation = useMutation({
    mutationFn: (teamId: string) => permissionsApi.deleteTeam(teamId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('settings.teams.deletedToast'));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.teams.deleteFailed'))),
  });

  const activeUsers = users.filter((u) => u.status === 'active');
  const openCreate = () => { setEditingTeam(null); setShowTeamModal(true); };
  const openEdit = (team: TeamRecord) => { setEditingTeam(team); setShowTeamModal(true); };
  const closeModal = () => { setShowTeamModal(false); setEditingTeam(null); };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-h4 font-emphasis text-text-primary">{t('settings.teams.title')}</h2>
          <p className="mt-1 max-w-2xl text-caption text-text-tertiary">{t('settings.teams.description')}</p>
        </div>
        <Button variant="primary" size="md" leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>{t('settings.teams.add')}</Button>
      </div>

      {(isTeamsLoading || isUsersLoading) ? (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-12 text-center text-text-quaternary shadow-linear-sm">{t('settings.teams.loading')}</div>
      ) : teams.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 p-12 text-center shadow-linear-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand"><Users className="h-5 w-5" /></div>
          <h3 className="text-h5 font-emphasis text-text-primary">{t('settings.teams.emptyTitle')}</h3>
          <p className="mt-2 text-caption text-text-tertiary">{t('settings.teams.emptyBody')}</p>
          <div className="mt-5"><Button variant="primary" size="md" onClick={openCreate}>{t('settings.teams.createFirst')}</Button></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {teams.map((team) => (
            <div key={team.id} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-h5 font-emphasis text-text-primary">{team.name}</h3>
                    <Badge variant="neutral" size="sm">{t(team.member_count === 1 ? 'settings.teams.memberCountOne' : 'settings.teams.memberCount', { count: team.member_count })}</Badge>
                  </div>
                  <p className="mt-2 min-h-[2.75rem] text-caption text-text-tertiary">{team.description || t('settings.common.noDescription')}</p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton aria-label={t('settings.teams.editAria')} variant="ghost" size="sm" onClick={() => openEdit(team)}><Edit2 className="h-4 w-4" /></IconButton>
                  <IconButton aria-label={t('settings.teams.deleteAria')} variant="ghost" size="sm" className="hover:text-danger" onClick={() => deleteMutation.mutate(team.id)} disabled={deleteMutation.isPending}><Trash2 className="h-4 w-4" /></IconButton>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {team.members.length > 0 ? (
                  <>
                    {team.members.slice(0, 6).map((m) => <Badge key={m.user_id} variant="brand" size="sm">{m.full_name || m.email}</Badge>)}
                    {team.members.length > 6 && <Badge variant="neutral" size="sm">{t('settings.teams.moreMembers', { count: team.members.length - 6 })}</Badge>}
                  </>
                ) : <span className="text-caption text-text-quaternary">{t('settings.teams.noMembers')}</span>}
              </div>
              <div className="mt-4 text-tiny text-text-quaternary">{t('settings.teams.updated', { date: new Date(team.updated_at).toLocaleDateString(locale) })}</div>
            </div>
          ))}
        </div>
      )}

      {showTeamModal && (
        <TeamModal
          key={editingTeam?.id || 'new-team'}
          team={editingTeam}
          allUsers={activeUsers}
          onClose={closeModal}
          onSuccess={() => { qc.invalidateQueries({ queryKey: ['permissions', 'teams'] }); qc.invalidateQueries({ queryKey: ['users'] }); closeModal(); }}
        />
      )}
    </div>
  );
}

/* ═══════════ ROLES (presets) ═══════════ */

function RolesTab() {
  const { t } = useI18n();
  const { data: presets } = useQuery<{ presets: Record<string, Record<string, string>> }>({
    queryKey: ['permissions', 'presets'], queryFn: permissionsApi.getPresets,
  });
  const allPresets = presets?.presets ?? {};

  return (
    <div className="space-y-6">
      <p className="text-caption text-text-tertiary">{t('settings.presets.description')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {Object.entries(allPresets).map(([name, perms]) => (
          <div key={name} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
            <div className="mb-3"><Badge variant="brand" size="md">{presetLabel(name, t)}</Badge></div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(perms).map(([mod, level]) => (
                <div key={mod} className="flex items-center gap-1 text-tiny">
                  <span className="text-text-tertiary">{moduleLabel(mod, t)}:</span>
                  <span className={cn('rounded px-1.5 py-0.5 font-emphasis', LEVEL_CLASSES[level] || LEVEL_CLASSES.none)}>{levelLabel(level, t)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════ COMPARE (improved matrix) ═══════════ */

function CompareTab() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [userQuery, setUserQuery] = useState('');
  const [pending, setPending] = useState<Record<string, Record<string, string>>>({});

  const { data: matrix, isLoading } = useQuery<PermissionMatrix>({
    queryKey: ['permissions', 'matrix'], queryFn: permissionsApi.getMatrix,
  });
  const { data: presetsData } = useQuery<{ presets: Record<string, Record<string, string>> }>({
    queryKey: ['permissions', 'presets'], queryFn: permissionsApi.getPresets,
  });

  const saveMutation = useMutation({
    mutationFn: ({ userId, permissions }: { userId: string; permissions: Record<string, string> }) => permissionsApi.updateUserPermissions(userId, permissions),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['permissions'] }); toast.success(t('settings.matrix.saved')); },
    onError: (err) => toast.error(extractApiError(err, t('settings.matrix.saveFailed'))),
  });
  const presetMutation = useMutation({
    mutationFn: ({ userId, preset }: { userId: string; preset: string }) => permissionsApi.applyPreset(userId, preset),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      setPending((p) => { const n = { ...p }; delete n[vars.userId]; return n; });
      toast.success(t('settings.matrix.presetApplied', { preset: presetLabel(vars.preset, t) }));
    },
    onError: (err) => toast.error(extractApiError(err, t('settings.matrix.presetFailed'))),
  });

  const setLevel = (userId: string, module: string, level: string) =>
    setPending((p) => ({ ...p, [userId]: { ...(p[userId] || {}), [module]: level } }));
  const handleSaveAll = () => { Object.entries(pending).forEach(([uid, perms]) => saveMutation.mutate({ userId: uid, permissions: perms })); setPending({}); };
  const pendingCount = Object.keys(pending).length;

  if (isLoading) return <div className="h-64 animate-pulse rounded-lg bg-surface-2" />;

  const modules = matrix?.modules ?? [];
  const moduleLevels = matrix?.module_levels ?? {};
  const groups = groupModules(modules);
  const orderedModules = groups.flatMap((g) => g.modules);
  const levelLabelMap = levelLabels(t);

  const needle = userQuery.trim().toLowerCase();
  const users = (matrix?.users ?? []).filter((u) => !needle || u.full_name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));
  const getEffective = (uid: string, mod: string, base: string) => pending[uid]?.[mod] ?? base;

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:w-80">
          <Input size="sm" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder={t('settings.matrix.searchPlaceholder')} leadingIcon={<Search />} />
        </div>
        <span className="text-tiny text-text-quaternary">{t('settings.compare.description')}</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        <table className="w-full border-separate border-spacing-0 text-caption">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 top-0 z-30 min-w-[200px] border-b border-[rgb(var(--border-line))] bg-surface-2 px-5 py-2 text-left text-tiny uppercase tracking-[0.14em] text-text-quaternary">
                {t('settings.matrix.header.user')}
              </th>
              {groups.map((g) => (
                <th key={g.key} colSpan={g.modules.length} className="sticky top-0 z-20 h-8 border-b border-l border-[rgb(var(--border-line))] bg-surface-2 px-3 text-center text-tiny font-emphasis uppercase tracking-[0.14em] text-text-tertiary">
                  {t(g.labelKey)}
                </th>
              ))}
              <th rowSpan={2} className="sticky top-0 z-20 min-w-[90px] border-b border-l border-[rgb(var(--border-line))] bg-surface-2 px-3 text-center text-tiny uppercase tracking-[0.14em] text-text-quaternary">
                {t('settings.role.label')}
              </th>
              <th rowSpan={2} className="sticky top-0 z-20 min-w-[120px] border-b border-l border-[rgb(var(--border-line))] bg-surface-2 px-3 text-center text-tiny uppercase tracking-[0.14em] text-text-quaternary">
                {t('settings.matrix.header.quickSet')}
              </th>
            </tr>
            <tr>
              {groups.map((g) => g.modules.map((m, i) => (
                <th key={m} className={cn('sticky top-8 z-10 h-9 min-w-[120px] border-b border-[rgb(var(--border-line))] bg-surface-2 px-2 text-center text-tiny font-emphasis text-text-quaternary', i === 0 && 'border-l')}>
                  {moduleLabel(m, t)}
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={orderedModules.length + 3} className="px-5 py-10 text-center text-caption text-text-tertiary">{t('settings.matrix.noUsersMatch', { query: userQuery })}</td></tr>
            ) : users.map((user) => {
              const rowPending = !!pending[user.user_id];
              const role = deriveRole({ ...user.permissions, ...(pending[user.user_id] || {}) }, presetsData?.presets, modules);
              return (
                <tr key={user.user_id} className={cn('transition-colors', rowPending ? 'bg-warning/5' : 'hover:bg-surface-2')}>
                  <td className={cn('sticky left-0 z-10 border-b border-[rgb(var(--border-line))] px-5 py-2', rowPending ? 'bg-warning/5' : 'bg-surface-1')}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-emphasis text-text-primary">{user.full_name}</p>
                        {user.permissions?.settings === 'full' && <Badge variant="info" size="xs">{t('settings.users.owner')}</Badge>}
                      </div>
                      <p className="truncate text-tiny text-text-quaternary">{user.email}</p>
                    </div>
                  </td>
                  {groups.map((g) => g.modules.map((m, i) => {
                    const base = user.permissions[m] ?? 'none';
                    const val = getEffective(user.user_id, m, base);
                    const allowed = moduleLevels[m] || ['none', 'view', 'edit', 'full'];
                    const changed = pending[user.user_id]?.[m] !== undefined;
                    return (
                      <td key={m} className={cn('border-b border-[rgb(var(--border-line))] px-2 py-2 text-center', i === 0 && 'border-l')}>
                        <div className="flex justify-center" title={moduleLabel(m, t)}>
                          <AccessLevelToggle value={val} allowed={allowed} labels={levelLabelMap} changed={changed} ariaLabel={moduleLabel(m, t)} onChange={(lvl) => setLevel(user.user_id, m, lvl)} />
                        </div>
                      </td>
                    );
                  }))}
                  <td className={cn('border-b border-l border-[rgb(var(--border-line))] px-3 py-2 text-center', rowPending ? 'bg-warning/5' : '')}>
                    <Badge variant={ROLE_BADGE_VARIANT[role] ?? 'neutral'} size="xs">{roleLabel(role, t)}</Badge>
                  </td>
                  <td className="border-b border-l border-[rgb(var(--border-line))] px-3 py-2 text-center">
                    <select
                      value=""
                      disabled={presetMutation.isPending}
                      onChange={(e) => { if (e.target.value) presetMutation.mutate({ userId: user.user_id, preset: e.target.value }); }}
                      title={t('settings.matrix.presetTitle')}
                      className="min-w-[110px] cursor-pointer appearance-none rounded-md bg-surface-2 px-3 py-1.5 text-center text-tiny font-emphasis text-text-secondary transition-colors hover:bg-surface-3 focus-visible:shadow-focus-brand focus-visible:outline-none"
                    >
                      <option value="">{t('settings.matrix.presetPlaceholder')}</option>
                      {PRESETS.map((p) => <option key={p} value={p}>{presetLabel(p, t)}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* legend */}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-tiny text-text-tertiary">
        {Object.keys(LEVEL_LABEL_KEYS).map((val) => (
          <div key={val} className="flex items-center gap-1.5">
            <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 font-emphasis', LEVEL_CLASSES[val])}>{levelLabel(val, t)}</span>
            <span>— {levelHelp(val, t)}</span>
          </div>
        ))}
      </div>

      {pendingCount > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center gap-3 rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2.5 shadow-lg">
            <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">
              <span className="h-2 w-2 rounded-full bg-warning" />
              {t(pendingCount === 1 ? 'settings.matrix.unsavedOne' : 'settings.matrix.unsaved', { count: pendingCount })}
            </span>
            <div className="h-4 w-px bg-[rgb(var(--border-line))]" />
            <Button variant="secondary" size="sm" onClick={() => { setPending({}); toast.info(t('settings.matrix.discarded')); }} disabled={saveMutation.isPending}>{t('settings.matrix.discard')}</Button>
            <Button variant="primary" size="sm" onClick={handleSaveAll} disabled={saveMutation.isPending} loading={saveMutation.isPending}>{t('settings.common.saveChanges')}</Button>
          </div>
        </div>
      )}
    </>
  );
}
