'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, Trash2, UserX, Users, Search } from 'lucide-react';
import { permissionsApi, usersApi } from '@/lib/api-client';
import { extractApiError, validatePasswordStrength } from '@/lib/api-errors';
import { authConfig, type AuthProvider } from '@/lib/auth-config';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Select, FieldGroup } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

/* ───────────── types ───────────── */

interface UserPermissionRow {
  user_id: string;
  email: string;
  full_name: string;
  permissions: Record<string, string>;
}

interface PermissionMatrix {
  modules: string[];
  module_levels: Record<string, string[]>;
  users: UserPermissionRow[];
}

type UserStatus = 'active' | 'deactivated';
interface UserRecord {
  id: string;
  email: string;
  full_name: string;
  auth_provider: AuthProvider;
  google_connected: boolean;
  has_password: boolean;
  status: UserStatus;
  teams: UserTeamRecord[];
  last_login_at: string | null;
  created_at: string;
}

interface UserTeamRecord {
  id: string;
  name: string;
  description: string | null;
}

interface TeamMemberRecord {
  user_id: string;
  email: string;
  full_name: string;
}

interface TeamRecord {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  members: TeamMemberRecord[];
  created_at: string;
  updated_at: string;
}

/* ───────────── constants ───────────── */

const MODULE_LABEL_KEYS: Record<string, string> = {
  data_sources: 'settings.module.data_sources',
  datasets: 'settings.module.datasets',
  intelligence: 'settings.module.intelligence',
  ai_inbox: 'settings.module.ai_inbox',
  semantics: 'settings.module.semantics',
  ai_guidance: 'settings.module.ai_guidance',
  govern: 'settings.module.govern',
  observability: 'settings.module.observability',
  explore_charts: 'settings.module.explore_charts',
  dashboards: 'settings.module.dashboards',
  workboards: 'settings.module.workboards',
  settings: 'settings.module.settings',
};

const LEVEL_CLASSES: Record<string, string> = {
  none: 'bg-danger/10 text-danger',
  view: 'bg-brand/10 text-brand',
  edit: 'bg-success/10 text-success',
  full: 'bg-info/10 text-info',
};

const LEVEL_LABEL_KEYS: Record<string, string> = {
  none: 'settings.level.none',
  view: 'settings.level.view',
  edit: 'settings.level.edit',
  full: 'settings.level.full',
};

const LEVEL_HELP_KEYS: Record<string, string> = {
  none: 'settings.levelHelp.none',
  view: 'settings.levelHelp.view',
  edit: 'settings.levelHelp.edit',
  full: 'settings.levelHelp.full',
};

const PRESETS = ['admin', 'editor', 'viewer', 'minimal'] as const;
const PRESET_LABEL_KEYS: Record<string, string> = {
  admin: 'settings.preset.admin',
  editor: 'settings.preset.editor',
  viewer: 'settings.preset.viewer',
  minimal: 'settings.preset.minimal',
};

function moduleLabel(module: string, t: (key: string) => string): string {
  const key = MODULE_LABEL_KEYS[module];
  return key ? t(key) : module;
}

function levelLabel(level: string, t: (key: string) => string): string {
  const key = LEVEL_LABEL_KEYS[level];
  return key ? t(key) : level;
}

function levelHelp(level: string, t: (key: string) => string): string {
  const key = LEVEL_HELP_KEYS[level];
  return key ? t(key) : '';
}

function presetLabel(preset: string, t: (key: string) => string): string {
  const key = PRESET_LABEL_KEYS[preset];
  return key ? t(key) : preset;
}

function authMethodLabel(user: { auth_provider: AuthProvider; google_connected: boolean }, t: (key: string) => string): string {
  if (user.auth_provider === 'password' && user.google_connected) return t('settings.auth.googlePassword');
  return t(user.auth_provider === 'google' ? 'settings.auth.google' : 'settings.auth.password');
}

type Tab = 'matrix' | 'users' | 'teams' | 'presets';

/* ═══════════ MAIN PAGE ═══════════ */

export default function PermissionsPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('matrix');

  return (
    <div className="w-full px-8 py-6 max-w-[1400px]">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-h1 text-text-primary font-emphasis">{t('settings.permissions.title')}</h1>
        <p className="text-caption text-text-tertiary mt-1">
          {t('settings.permissions.description')}
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-[rgb(var(--border-line))] mb-6">
        <nav className="flex gap-6">
          {([
            { key: 'matrix', label: t('settings.tabs.matrix') },
            { key: 'users',  label: t('settings.tabs.users') },
            { key: 'teams', label: t('settings.tabs.teams') },
            { key: 'presets', label: t('settings.tabs.presets') },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'pb-3 text-caption font-emphasis border-b-2 transition-colors',
                activeTab === t.key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'matrix' && <MatrixTab />}
      {activeTab === 'users'  && <UsersTab />}
      {activeTab === 'teams' && <TeamsTab />}
      {activeTab === 'presets' && <PresetsTab />}
    </div>
  );
}

/* ═══════════ MATRIX TAB ═══════════ */

function MatrixTab() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [userQuery, setUserQuery] = useState('');
  const [pendingChanges, setPendingChanges] = useState<Record<string, Record<string, string>>>({});

  const { data: matrix, isLoading } = useQuery<PermissionMatrix>({
    queryKey: ['permissions', 'matrix'],
    queryFn: permissionsApi.getMatrix,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ userId, permissions }: { userId: string; permissions: Record<string, string> }) =>
      permissionsApi.updateUserPermissions(userId, permissions),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      toast.success(t('settings.matrix.saved'));
    },
    onError: (err: any) => toast.error(extractApiError(err, t('settings.matrix.saveFailed'))),
  });

  const presetMutation = useMutation({
    mutationFn: async ({ userId, preset }: { userId: string; preset: string }) =>
      permissionsApi.applyPreset(userId, preset),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      setPendingChanges((p) => { const n = { ...p }; delete n[vars.userId]; return n; });
      toast.success(t('settings.matrix.presetApplied', { preset: presetLabel(vars.preset, t) }));
    },
    onError: (err: any) => toast.error(extractApiError(err, t('settings.matrix.presetFailed'))),
  });

  const setLevel = (userId: string, module: string, level: string) => {
    setPendingChanges((p) => ({
      ...p,
      [userId]: { ...(p[userId] || {}), [module]: level },
    }));
  };

  const getEffective = (user: UserPermissionRow, mod: string) =>
    pendingChanges[user.user_id]?.[mod] ?? user.permissions[mod] ?? 'none';

  const handleSaveAll = () => {
    Object.entries(pendingChanges).forEach(([uid, perms]) => {
      saveMutation.mutate({ userId: uid, permissions: perms });
    });
    setPendingChanges({});
  };

  const handleResetAll = () => {
    setPendingChanges({});
    toast.info(t('settings.matrix.discarded'));
  };

  const pendingCount = Object.keys(pendingChanges).length;
  const hasPending = pendingCount > 0;

  if (isLoading) return <div className="animate-pulse h-64 bg-surface-2 rounded-lg" />;

  const modules = matrix?.modules || [];
  const allUsers = matrix?.users || [];
  const moduleLevels = matrix?.module_levels ?? {};
  const needle = userQuery.trim().toLowerCase();
  const users = needle
    ? allUsers.filter(
        (u) => u.full_name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
      )
    : allUsers;

  return (
    <>
      {/* Toolbar: search + hint */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:w-80">
          <Input
            size="sm"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder={t('settings.matrix.searchPlaceholder')}
            leadingIcon={<Search />}
          />
        </div>
        <span className="text-tiny text-text-quaternary">
          {t('settings.matrix.hintPrefix')} <span className="font-emphasis text-text-tertiary">{t('settings.matrix.quickSet')}</span> {t('settings.matrix.hintSuffix')}
        </span>
      </div>

      {/* Matrix table */}
      <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] overflow-x-auto shadow-linear-sm">
        <table className="w-full text-caption">
          <thead>
            <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2">
              <th className="text-left px-5 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary sticky left-0 bg-surface-2 min-w-[200px]">
                {t('settings.matrix.header.user')}
              </th>
              {modules.map((m) => (
                <th key={m} className="text-center px-3 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary min-w-[110px]">
                  {moduleLabel(m, t)}
                </th>
              ))}
              <th className="text-center px-3 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary min-w-[130px]">
                {t('settings.matrix.header.quickSet')}
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={modules.length + 2} className="px-5 py-10 text-center text-caption text-text-tertiary">
                  {t('settings.matrix.noUsersMatch', { query: userQuery })}
                </td>
              </tr>
            ) : users.map((user) => {
              const rowPending = !!pendingChanges[user.user_id];
              const isOwner = user.permissions?.settings === 'full';
              return (
                <tr
                  key={user.user_id}
                  className={cn(
                    'transition-colors border-b border-[rgb(var(--border-line))] last:border-0',
                    rowPending ? 'bg-warning/10' : 'hover:bg-surface-2',
                  )}
                >
                  <td className={cn(
                    'px-5 py-3 sticky left-0',
                    rowPending ? 'bg-warning/10' : 'bg-surface-1',
                  )}>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center bg-brand text-text-inverse text-tiny font-strong flex-shrink-0">
                        {(user.full_name || user.email).slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-emphasis text-text-primary truncate">{user.full_name}</p>
                          {isOwner && (
                            <Badge variant="neutral" size="xs">{t('settings.users.owner')}</Badge>
                          )}
                        </div>
                        <p className="text-tiny text-text-quaternary truncate">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  {modules.map((m) => {
                    const val = getEffective(user, m);
                    const changed = pendingChanges[user.user_id]?.[m] !== undefined;
                    const allowed = moduleLevels[m] || ['none', 'view', 'edit', 'full'];
                    const cls = LEVEL_CLASSES[val] || LEVEL_CLASSES.none;
                    return (
                      <td key={m} className="px-3 py-3 text-center">
                        <select
                          value={val}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setLevel(user.user_id, m, e.target.value)}
                          className={cn(
                            'appearance-none cursor-pointer text-center min-w-[80px] px-3 py-1.5 rounded-md text-tiny font-strong transition-all hover:shadow-linear-sm focus-visible:outline-none focus-visible:shadow-focus-brand',
                            changed ? 'bg-warning/10 text-warning' : cls,
                          )}
                        >
                          {allowed.map((lvl) => (
                            <option key={lvl} value={lvl}>
                            {levelLabel(lvl, t)}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-center">
                    <select
                      value=""
                      disabled={presetMutation.isPending}
                      onChange={(e) => {
                        const preset = e.target.value;
                        if (preset) presetMutation.mutate({ userId: user.user_id, preset });
                      }}
                      title={t('settings.matrix.presetTitle')}
                      className="min-w-[110px] cursor-pointer appearance-none rounded-md bg-surface-2 px-3 py-1.5 text-center text-tiny font-emphasis text-text-secondary transition-colors hover:bg-surface-3 focus-visible:shadow-focus-brand focus-visible:outline-none"
                    >
                      <option value="">{t('settings.matrix.presetPlaceholder')}</option>
                      {PRESETS.map((p) => (
                        <option key={p} value={p}>{presetLabel(p, t)}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 mt-4 text-tiny text-text-tertiary">
        {Object.keys(LEVEL_LABEL_KEYS).map((val) => {
          const cls = LEVEL_CLASSES[val] || LEVEL_CLASSES.none;
          return (
            <div key={val} className="flex items-center gap-1.5">
              <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md font-emphasis', cls)}>
                {levelLabel(val, t)}
              </span>
              <span>— {levelHelp(val, t)}</span>
            </div>
          );
        })}
      </div>

      {/* Sticky save bar — only when there are unsaved changes */}
      {hasPending && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center gap-3 rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2.5 shadow-lg">
            <span className="flex items-center gap-1.5 text-caption font-emphasis text-text-primary">
              <span className="h-2 w-2 rounded-full bg-warning" />
              {t(pendingCount === 1 ? 'settings.matrix.unsavedOne' : 'settings.matrix.unsaved', { count: pendingCount })}
            </span>
            <div className="h-4 w-px bg-[rgb(var(--border-line))]" />
            <Button variant="secondary" size="sm" onClick={handleResetAll} disabled={saveMutation.isPending}>
              {t('settings.matrix.discard')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveAll}
              disabled={saveMutation.isPending}
              loading={saveMutation.isPending}
            >
              {saveMutation.isPending ? t('settings.matrix.saving') : t('settings.common.saveChanges')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/* ═══════════ USERS TAB ═══════════ */

function UsersTab() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [selectedTeamFilter, setSelectedTeamFilter] = useState('all');

  const { data: users = [], isLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const { data: teams = [], isLoading: isTeamsLoading } = useQuery<TeamRecord[]>({
    queryKey: ['permissions', 'teams'],
    queryFn: permissionsApi.getTeams,
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => usersApi.deactivate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
      toast.success(t('settings.users.deactivatedToast'));
    },
    onError: (err: any) => toast.error(extractApiError(err, t('settings.users.failed'))),
  });

  const visibleUsers = users.filter((user) => {
    if (selectedTeamFilter === 'all') return true;
    if (selectedTeamFilter === 'unassigned') return user.teams.length === 0;
    return user.teams.some((team) => team.id === selectedTeamFilter);
  });

  const defaultTeamIds = selectedTeamFilter !== 'all' && selectedTeamFilter !== 'unassigned'
    ? [selectedTeamFilter]
    : [];

  return (
    <>
      <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="text-caption text-text-tertiary">{t('settings.users.count', { visible: visibleUsers.length, total: users.length })}</p>
          <div className="w-full sm:w-[260px]">
            <Select value={selectedTeamFilter} onChange={(e) => setSelectedTeamFilter(e.target.value)} disabled={isTeamsLoading}>
              <option value="all">{t('settings.users.allTeams')}</option>
              <option value="unassigned">{t('settings.users.unassignedUsers')}</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <Button
          variant="primary"
          size="md"
          leadingIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowInviteModal(true)}
        >
          {t('settings.users.add')}
        </Button>
      </div>

      <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] overflow-hidden shadow-linear-sm">
        {(isLoading || isTeamsLoading) ? (
          <div className="p-12 text-center text-text-quaternary">{t('settings.users.loading')}</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">{t('settings.users.empty')}</div>
        ) : visibleUsers.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">{t('settings.users.noTeamMatch')}</div>
        ) : (
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2">
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.name')}</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.email')}</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.teams')}</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.loginMethod')}</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.status')}</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">{t('settings.users.header.lastLogin')}</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => (
                <tr key={u.id} className="border-b border-[rgb(var(--border-line))] last:border-0 hover:bg-surface-2 transition-colors">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-brand text-text-inverse text-tiny font-strong flex-shrink-0">
                        {(u.full_name || u.email).slice(0, 2).toUpperCase()}
                      </div>
                      <span className="font-emphasis text-text-primary">{u.full_name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3 text-text-secondary">{u.email}</td>
                  <td className="px-6 py-3">
                    <div className="flex flex-wrap gap-2">
                      {u.teams.length > 0 ? (
                        <>
                          {u.teams.slice(0, 3).map((team) => (
                            <Badge key={team.id} variant="brand" size="sm">{team.name}</Badge>
                          ))}
                          {u.teams.length > 3 && (
                            <Badge variant="neutral" size="sm">+{u.teams.length - 3}</Badge>
                          )}
                        </>
                      ) : (
                        <span className="text-text-quaternary">{t('settings.users.unassigned')}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant="neutral" size="sm">
                      {authMethodLabel(u, t)}
                    </Badge>
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant={u.status === 'active' ? 'success' : 'danger'} size="sm">
                      {t(`settings.common.status.${u.status}`)}
                    </Badge>
                  </td>
                  <td className="px-6 py-3 text-text-tertiary">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString(locale) : t('settings.common.never')}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton aria-label={t('settings.users.editAria')} variant="ghost" size="sm" onClick={() => setEditingUser(u)}>
                        <Edit2 className="h-4 w-4" />
                      </IconButton>
                      {u.status === 'active' && (
                        <IconButton
                          aria-label={t('settings.users.deactivateAria')}
                          variant="ghost"
                          size="sm"
                          onClick={() => deactivateMutation.mutate(u.id)}
                          disabled={deactivateMutation.isPending}
                          className="hover:text-danger"
                        >
                          <UserX className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showInviteModal && (
        <InviteModal
          availableTeams={teams}
          defaultTeamIds={defaultTeamIds}
          onClose={() => setShowInviteModal(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
            setShowInviteModal(false);
          }}
        />
      )}
      {editingUser && (
        <EditUserModal
          user={editingUser}
          availableTeams={teams}
          onClose={() => setEditingUser(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
            setEditingUser(null);
          }}
        />
      )}
    </>
  );
}

/* ═══════════ TEAMS TAB ═══════════ */

function TeamsTab() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [editingTeam, setEditingTeam] = useState<TeamRecord | null>(null);
  const [showTeamModal, setShowTeamModal] = useState(false);

  const { data: teams = [], isLoading: isTeamsLoading } = useQuery<TeamRecord[]>({
    queryKey: ['permissions', 'teams'],
    queryFn: permissionsApi.getTeams,
  });

  const { data: users = [], isLoading: isUsersLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const deleteMutation = useMutation({
    mutationFn: (teamId: string) => permissionsApi.deleteTeam(teamId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('settings.teams.deletedToast'));
    },
    onError: (err: any) => toast.error(extractApiError(err, t('settings.teams.deleteFailed'))),
  });

  const activeUsers = users.filter((user) => user.status === 'active');

  const openCreateModal = () => {
    setEditingTeam(null);
    setShowTeamModal(true);
  };

  const openEditModal = (team: TeamRecord) => {
    setEditingTeam(team);
    setShowTeamModal(true);
  };

  const closeModal = () => {
    setShowTeamModal(false);
    setEditingTeam(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-h4 text-text-primary font-emphasis">{t('settings.teams.title')}</h2>
          <p className="text-caption text-text-tertiary mt-1 max-w-2xl">
            {t('settings.teams.description')}
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          leadingIcon={<Plus className="h-4 w-4" />}
          onClick={openCreateModal}
        >
          {t('settings.teams.add')}
        </Button>
      </div>

      {(isTeamsLoading || isUsersLoading) ? (
        <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] p-12 text-center text-text-quaternary shadow-linear-sm">
          {t('settings.teams.loading')}
        </div>
      ) : teams.length === 0 ? (
        <div className="bg-surface-1 rounded-xl border border-dashed border-[rgb(var(--border-line))] p-12 text-center shadow-linear-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Users className="h-5 w-5" />
          </div>
          <h3 className="text-h5 text-text-primary font-emphasis">{t('settings.teams.emptyTitle')}</h3>
          <p className="mt-2 text-caption text-text-tertiary">
            {t('settings.teams.emptyBody')}
          </p>
          <div className="mt-5">
            <Button variant="primary" size="md" onClick={openCreateModal}>{t('settings.teams.createFirst')}</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {teams.map((team) => (
            <div
              key={team.id}
              className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] p-5 shadow-linear-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-h5 text-text-primary font-emphasis">{team.name}</h3>
                    <Badge variant="neutral" size="sm">{t(team.member_count === 1 ? 'settings.teams.memberCountOne' : 'settings.teams.memberCount', { count: team.member_count })}</Badge>
                  </div>
                  <p className="mt-2 text-caption text-text-tertiary min-h-[2.75rem]">
                    {team.description || t('settings.common.noDescription')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton aria-label={t('settings.teams.editAria')} variant="ghost" size="sm" onClick={() => openEditModal(team)}>
                    <Edit2 className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label={t('settings.teams.deleteAria')}
                    variant="ghost"
                    size="sm"
                    className="hover:text-danger"
                    onClick={() => deleteMutation.mutate(team.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {team.members.length > 0 ? (
                  <>
                    {team.members.slice(0, 6).map((member) => (
                      <Badge key={member.user_id} variant="brand" size="sm">
                        {member.full_name || member.email}
                      </Badge>
                    ))}
                    {team.members.length > 6 && (
                      <Badge variant="neutral" size="sm">{t('settings.teams.moreMembers', { count: team.members.length - 6 })}</Badge>
                    )}
                  </>
                ) : (
                  <span className="text-caption text-text-quaternary">{t('settings.teams.noMembers')}</span>
                )}
              </div>

              <div className="mt-4 text-tiny text-text-quaternary">
                {t('settings.teams.updated', { date: new Date(team.updated_at).toLocaleDateString(locale) })}
              </div>
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
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['permissions', 'teams'] });
            qc.invalidateQueries({ queryKey: ['users'] });
            closeModal();
          }}
        />
      )}
    </div>
  );
}

/* ═══════════ PRESETS TAB ═══════════ */

function PresetsTab() {
  const { t } = useI18n();
  const { data: presets } = useQuery<{ presets: Record<string, Record<string, string>> }>({
    queryKey: ['permissions', 'presets'],
    queryFn: permissionsApi.getPresets,
  });

  const allPresets = presets?.presets ?? {};

  return (
    <div className="space-y-6">
      <p className="text-caption text-text-tertiary">
        {t('settings.presets.description')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Object.entries(allPresets).map(([name, perms]) => (
          <div key={name} className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] p-5 shadow-linear-sm">
            <div className="flex items-center gap-2 mb-3">
              <Badge variant="brand" size="md">{presetLabel(name, t)}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(perms).map(([mod, level]) => {
                const cls = LEVEL_CLASSES[level] || LEVEL_CLASSES.none;
                return (
                  <div key={mod} className="flex items-center gap-1 text-tiny">
                    <span className="text-text-tertiary">{moduleLabel(mod, t)}:</span>
                    <span className={cn('px-1.5 py-0.5 rounded font-emphasis', cls)}>
                      {levelLabel(level, t)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════ MODALS ═══════════ */

function TeamAssignmentField({
  availableTeams,
  selectedTeamIds,
  onToggle,
}: {
  availableTeams: TeamRecord[];
  selectedTeamIds: string[];
  onToggle: (teamId: string) => void;
}) {
  const { t } = useI18n();
  const selectedTeams = selectedTeamIds
    .map((teamId) => availableTeams.find((team) => team.id === teamId))
    .filter((team): team is TeamRecord => Boolean(team));

  return (
    <FieldGroup label={t('settings.assignment.label')} description={t('settings.assignment.description')}>
      {availableTeams.length === 0 ? (
        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-quaternary">
          {t('settings.assignment.noTeams')}
        </div>
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-4 space-y-4">
          <div className="flex flex-wrap gap-2 min-h-[2rem]">
            {selectedTeams.length > 0 ? (
              selectedTeams.map((team) => (
                <Badge key={team.id} variant="brand" size="sm">{team.name}</Badge>
              ))
            ) : (
              <span className="text-caption text-text-quaternary">{t('settings.assignment.noneSelected')}</span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {availableTeams.map((team) => {
              const checked = selectedTeamIds.includes(team.id);
              return (
                <label
                  key={team.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors',
                    checked
                      ? 'border-brand bg-brand/10'
                      : 'border-[rgb(var(--border-line))] bg-surface-1 hover:bg-surface-2',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(team.id)}
                    className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border-line))] text-brand focus:ring-brand"
                  />
                  <div className="min-w-0">
                    <div className="font-emphasis text-text-primary">{team.name}</div>
                    <div className="text-caption text-text-tertiary">{team.description || t('settings.assignment.noDescription')}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </FieldGroup>
  );
}

function InviteModal({
  availableTeams,
  defaultTeamIds,
  onClose,
  onSuccess,
}: {
  availableTeams: TeamRecord[];
  defaultTeamIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [authProvider, setAuthProvider] = useState<AuthProvider>(
    authConfig.googleEnabled ? 'google' : 'password',
  );
  const [password, setPassword] = useState('');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(defaultTeamIds);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleTeam = (teamId: string) => {
    setSelectedTeamIds((current) => (
      current.includes(teamId)
        ? current.filter((id) => id !== teamId)
        : [...current, teamId]
    ));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (authProvider === 'password') {
      const passwordError = validatePasswordStrength(password);
      if (passwordError) {
        setError(t('settings.invite.passwordHelp'));
        return;
      }
    }
    setLoading(true);
    try {
      await usersApi.create({
        email,
        full_name: fullName,
        auth_provider: authProvider,
        team_ids: selectedTeamIds,
        ...(authProvider === 'password' ? { password } : {}),
      });
      toast.success(t('settings.invite.createdToast', { email }));
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, t('settings.invite.failed')));
    } finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('settings.invite.title')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="invite-user-form" disabled={loading} loading={loading}>
            {loading ? t('settings.invite.creating') : t('settings.common.create')}
          </Button>
        </>
      }
    >
      <form id="invite-user-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}
        <FieldGroup label={t('settings.invite.fullName')} required>
          <Input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </FieldGroup>
        <FieldGroup label={t('settings.invite.email')} required>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FieldGroup>
        {(authConfig.googleEnabled || authConfig.passwordEnabled) && (
          <FieldGroup label={t('settings.invite.loginMethod')}>
            <Select value={authProvider} onChange={(e) => setAuthProvider(e.target.value as AuthProvider)}>
              {authConfig.googleEnabled && <option value="google">{t('settings.auth.google')}</option>}
              {authConfig.passwordEnabled && <option value="password">{t('settings.auth.password')}</option>}
            </Select>
          </FieldGroup>
        )}
        {authProvider === 'password' ? (
          <FieldGroup label={t('settings.invite.password')} required description={t('settings.invite.passwordHelp')}>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('settings.invite.passwordPlaceholder')}
            />
          </FieldGroup>
        ) : (
          <div className="rounded-md border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand">
            {t('settings.invite.googleNotice')}
          </div>
        )}
        <TeamAssignmentField
          availableTeams={availableTeams}
          selectedTeamIds={selectedTeamIds}
          onToggle={toggleTeam}
        />
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  availableTeams,
  onClose,
  onSuccess,
}: {
  user: UserRecord;
  availableTeams: TeamRecord[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const [userStatus, setUserStatus] = useState<UserStatus>(user.status);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(user.teams.map((team) => team.id));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleTeam = (teamId: string) => {
    setSelectedTeamIds((current) => (
      current.includes(teamId)
        ? current.filter((id) => id !== teamId)
        : [...current, teamId]
    ));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await usersApi.update(user.id, { status: userStatus, team_ids: selectedTeamIds });
      toast.success(t('settings.editUser.updatedToast'));
      onSuccess();
    } catch (err: any) { setError(extractApiError(err, t('settings.editUser.failed'))); }
    finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('settings.editUser.title')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="edit-user-form" disabled={loading} loading={loading}>
            {loading ? t('settings.common.saving') : t('settings.common.save')}
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-tertiary mb-4">{user.email}</p>
      <form id="edit-user-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}
        <FieldGroup label={t('settings.users.header.status')}>
          <Select value={userStatus} onChange={(e) => setUserStatus(e.target.value as UserStatus)}>
            <option value="active">{t('settings.common.status.active')}</option>
            <option value="deactivated">{t('settings.common.status.deactivated')}</option>
          </Select>
        </FieldGroup>
        <TeamAssignmentField
          availableTeams={availableTeams}
          selectedTeamIds={selectedTeamIds}
          onToggle={toggleTeam}
        />
      </form>
    </Modal>
  );
}

function TeamModal({
  team,
  allUsers,
  onClose,
  onSuccess,
}: {
  team: TeamRecord | null;
  allUsers: UserRecord[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(
    team?.members.map((member) => member.user_id) ?? [],
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const filteredUsers = allUsers.filter((user) => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return true;
    return `${user.full_name} ${user.email}`.toLowerCase().includes(query);
  });

  const selectedMembers = selectedMemberIds
    .map((memberId) => allUsers.find((user) => user.id === memberId))
    .filter((user): user is UserRecord => Boolean(user));

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((current) => (
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    ));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('settings.teamModal.nameRequired'));
      return;
    }

    setError('');
    setLoading(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        member_ids: selectedMemberIds,
      };

      if (team) {
        await permissionsApi.updateTeam(team.id, payload);
        toast.success(t('settings.teamModal.updatedToast', { name: trimmedName }));
      } else {
        await permissionsApi.createTeam(payload);
        toast.success(t('settings.teamModal.createdToast', { name: trimmedName }));
      }
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, t('settings.teamModal.failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={team ? t('settings.teamModal.editTitle', { name: team.name }) : t('settings.teamModal.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="team-form" disabled={loading} loading={loading}>
            {loading ? t('settings.common.saving') : team ? t('settings.common.saveChanges') : t('settings.teamModal.createTitle')}
          </Button>
        </>
      }
    >
      <form id="team-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldGroup label={t('settings.teamModal.teamName')} required>
            <Input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.teamModal.teamNamePlaceholder')} />
          </FieldGroup>
          <FieldGroup label={t('settings.teamModal.description')} description={t('settings.teamModal.descriptionHint')}>
            <Input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('settings.teamModal.descriptionPlaceholder')} />
          </FieldGroup>
        </div>

        <FieldGroup label={t('settings.teamModal.assignedMembers')} description={t('settings.teamModal.assignedMembersHint')}>
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-4 space-y-4">
            <Input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder={t('settings.teamModal.filterPlaceholder')}
            />

            <div className="flex flex-wrap gap-2 min-h-[2rem]">
              {selectedMembers.length > 0 ? (
                selectedMembers.map((member) => (
                  <Badge key={member.id} variant="brand" size="sm">
                    {member.full_name || member.email}
                  </Badge>
                ))
              ) : (
                <span className="text-caption text-text-quaternary">{t('settings.teamModal.noUsersSelected')}</span>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
              {filteredUsers.length === 0 ? (
                <div className="px-4 py-6 text-center text-caption text-text-quaternary">{t('settings.teamModal.noActiveMatch')}</div>
              ) : (
                filteredUsers.map((user) => {
                  const checked = selectedMemberIds.includes(user.id);
                  return (
                    <label
                      key={user.id}
                      className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMember(user.id)}
                        className="h-4 w-4 rounded border-[rgb(var(--border-line))] text-brand focus:ring-brand"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-emphasis text-text-primary truncate">{user.full_name || user.email}</div>
                        <div className="text-caption text-text-tertiary truncate">{user.email}</div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </FieldGroup>
      </form>
    </Modal>
  );
}
