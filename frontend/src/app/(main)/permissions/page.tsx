'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, Trash2, UserX, Users } from 'lucide-react';
import { permissionsApi, usersApi } from '@/lib/api-client';
import { extractApiError, PASSWORD_REQUIREMENTS_TEXT, validatePasswordStrength } from '@/lib/api-errors';
import { authConfig, getAuthMethodLabel, type AuthProvider } from '@/lib/auth-config';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Select, FieldGroup } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/lib/utils';

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

const MODULE_LABELS: Record<string, string> = {
  data_sources:      'Data sources',
  datasets:          'Datasets',
  explore_charts:    'Explore + charts',
  dashboards:        'Dashboards',
  workboards:        'Workboards',
  ai_chat:           'AI chat',
  ai_agent:          'AI agent',
  settings:          'Settings',
};

const LEVEL_CLASSES: Record<string, string> = {
  none: 'bg-danger/10 text-danger',
  view: 'bg-brand/10 text-brand',
  edit: 'bg-success/10 text-success',
  full: 'bg-info/10 text-info',
};

const LEVEL_LABELS: Record<string, string> = {
  none: 'No access',
  view: 'View',
  edit: 'Edit',
  full: 'Full',
};

const PRESETS = ['admin', 'editor', 'viewer', 'minimal'] as const;
const PRESET_LABELS: Record<string, string> = {
  admin: 'Admin (full)', editor: 'Editor', viewer: 'Viewer', minimal: 'Minimal',
};

type Tab = 'matrix' | 'users' | 'teams' | 'presets';

/* ═══════════ MAIN PAGE ═══════════ */

export default function PermissionsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('matrix');

  return (
    <div className="w-full px-8 py-6 max-w-[1400px]">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-h1 text-text-primary font-emphasis">Permissions</h1>
        <p className="text-caption text-text-tertiary mt-1">
          Set per-module access level for each user
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-[rgb(var(--border-line))] mb-6">
        <nav className="flex gap-6">
          {([
            { key: 'matrix', label: 'Permission matrix' },
            { key: 'users',  label: 'Users' },
            { key: 'teams', label: 'Teams' },
            { key: 'presets', label: 'Presets' },
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
  const qc = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
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
      toast.success('Permissions saved');
    },
    onError: (err: any) => toast.error(extractApiError(err, 'Save failed')),
  });

  const presetMutation = useMutation({
    mutationFn: async ({ userId, preset }: { userId: string; preset: string }) =>
      permissionsApi.applyPreset(userId, preset),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      setPendingChanges((p) => { const n = { ...p }; delete n[vars.userId]; return n; });
      toast.success(`Applied "${vars.preset}" preset`);
    },
    onError: (err: any) => toast.error(extractApiError(err, 'Preset failed')),
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
    toast.info('Changes discarded');
  };

  const hasPending = Object.keys(pendingChanges).length > 0;

  if (isLoading) return <div className="animate-pulse h-64 bg-surface-2 rounded-lg" />;

  const modules = matrix?.modules || [];
  const users = matrix?.users || [];
  const moduleLevels = matrix?.module_levels ?? {};

  return (
    <>
      {/* Preset bar */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <span className="text-caption text-text-tertiary mr-1">Apply preset:</span>
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant="secondary"
            onClick={() => {
              if (!selectedUser) { toast.info('Select a user first, then click preset'); return; }
              presetMutation.mutate({ userId: selectedUser, preset: p });
            }}
            disabled={presetMutation.isPending}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        {!selectedUser && (
          <span className="text-tiny text-text-quaternary italic">Select a user first, then click preset</span>
        )}
      </div>

      {/* Matrix table */}
      <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] overflow-x-auto shadow-linear-sm">
        <table className="w-full text-caption">
          <thead>
            <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2">
              <th className="text-left px-5 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary sticky left-0 bg-surface-2 min-w-[200px]">
                User
              </th>
              {modules.map((m) => (
                <th key={m} className="text-center px-3 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary min-w-[110px]">
                  {MODULE_LABELS[m] || m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelected = selectedUser === user.user_id;
              const rowPending = !!pendingChanges[user.user_id];
              const isOwner = user.permissions?.settings === 'full';
              return (
                <tr
                  key={user.user_id}
                  onClick={() => setSelectedUser(isSelected ? null : user.user_id)}
                  className={cn(
                    'transition-colors cursor-pointer border-b border-[rgb(var(--border-line))] last:border-0',
                    isSelected && 'bg-brand/10',
                    !isSelected && rowPending && 'bg-warning/10',
                    !isSelected && !rowPending && 'hover:bg-surface-2',
                  )}
                >
                  <td className={cn(
                    'px-5 py-3 sticky left-0',
                    isSelected ? 'bg-brand/10' : rowPending ? 'bg-warning/10' : 'bg-surface-1',
                  )}>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center bg-brand text-text-inverse text-tiny font-strong flex-shrink-0">
                        {(user.full_name || user.email).slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-emphasis text-text-primary truncate">{user.full_name}</p>
                          {isOwner && (
                            <Badge variant="neutral" size="xs">Owner</Badge>
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
                              {LEVEL_LABELS[lvl] || lvl}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 mt-4 text-tiny text-text-tertiary">
        {Object.entries(LEVEL_LABELS).map(([val, label]) => {
          const cls = LEVEL_CLASSES[val] || LEVEL_CLASSES.none;
          return (
            <div key={val} className="flex items-center gap-1.5">
              <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md font-emphasis', cls)}>
                {label}
              </span>
              <span>
                {val === 'none' ? '— module ẩn khỏi sidebar'
                  : val === 'view' ? '— xem own + shared, tương tác filters'
                  : val === 'edit' ? '— CRUD own, xem shared, share cho người khác'
                  : '— CRUD tất cả, manage config'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-3 mt-6">
        <Button
          variant="secondary"
          size="md"
          onClick={handleResetAll}
          disabled={!hasPending}
        >
          Reset to defaults
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSaveAll}
          disabled={!hasPending || saveMutation.isPending}
          loading={saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}

/* ═══════════ USERS TAB ═══════════ */

function UsersTab() {
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
      toast.success('User deactivated');
    },
    onError: (err: any) => toast.error(extractApiError(err, 'Failed')),
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
          <p className="text-caption text-text-tertiary">{visibleUsers.length} of {users.length} users</p>
          <div className="w-full sm:w-[260px]">
            <Select value={selectedTeamFilter} onChange={(e) => setSelectedTeamFilter(e.target.value)} disabled={isTeamsLoading}>
              <option value="all">All teams</option>
              <option value="unassigned">Unassigned users</option>
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
          Add user
        </Button>
      </div>

      <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] overflow-hidden shadow-linear-sm">
        {(isLoading || isTeamsLoading) ? (
          <div className="p-12 text-center text-text-quaternary">Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">No users found.</div>
        ) : visibleUsers.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">No users match this team filter.</div>
        ) : (
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2">
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Name</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Email</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Teams</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Login method</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Status</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Last login</th>
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
                        <span className="text-text-quaternary">Unassigned</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant="neutral" size="sm">
                      {getAuthMethodLabel(u.auth_provider, u.google_connected)}
                    </Badge>
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant={u.status === 'active' ? 'success' : 'danger'} size="sm">
                      {u.status}
                    </Badge>
                  </td>
                  <td className="px-6 py-3 text-text-tertiary">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton aria-label="Edit user" variant="ghost" size="sm" onClick={() => setEditingUser(u)}>
                        <Edit2 className="h-4 w-4" />
                      </IconButton>
                      {u.status === 'active' && (
                        <IconButton
                          aria-label="Deactivate user"
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
      toast.success('Team deleted');
    },
    onError: (err: any) => toast.error(extractApiError(err, 'Failed to delete team.')),
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
          <h2 className="text-h4 text-text-primary font-emphasis">Teams</h2>
          <p className="text-caption text-text-tertiary mt-1 max-w-2xl">
            Organize active users into reusable teams so Settings stays clean before wiring team-based sharing flows.
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          leadingIcon={<Plus className="h-4 w-4" />}
          onClick={openCreateModal}
        >
          Add team
        </Button>
      </div>

      {(isTeamsLoading || isUsersLoading) ? (
        <div className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] p-12 text-center text-text-quaternary shadow-linear-sm">
          Loading teams…
        </div>
      ) : teams.length === 0 ? (
        <div className="bg-surface-1 rounded-xl border border-dashed border-[rgb(var(--border-line))] p-12 text-center shadow-linear-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Users className="h-5 w-5" />
          </div>
          <h3 className="text-h5 text-text-primary font-emphasis">No teams configured yet</h3>
          <p className="mt-2 text-caption text-text-tertiary">
            Create the first team and assign members directly from active users in the workspace.
          </p>
          <div className="mt-5">
            <Button variant="primary" size="md" onClick={openCreateModal}>Create first team</Button>
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
                    <Badge variant="neutral" size="sm">{team.member_count} member{team.member_count === 1 ? '' : 's'}</Badge>
                  </div>
                  <p className="mt-2 text-caption text-text-tertiary min-h-[2.75rem]">
                    {team.description || 'No description yet.'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton aria-label="Edit team" variant="ghost" size="sm" onClick={() => openEditModal(team)}>
                    <Edit2 className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    aria-label="Delete team"
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
                      <Badge variant="neutral" size="sm">+{team.members.length - 6} more</Badge>
                    )}
                  </>
                ) : (
                  <span className="text-caption text-text-quaternary">No members assigned yet.</span>
                )}
              </div>

              <div className="mt-4 text-tiny text-text-quaternary">
                Updated {new Date(team.updated_at).toLocaleDateString()}
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
  const { data: presets } = useQuery<{ presets: Record<string, Record<string, string>> }>({
    queryKey: ['permissions', 'presets'],
    queryFn: permissionsApi.getPresets,
  });

  const allPresets = presets?.presets ?? {};

  return (
    <div className="space-y-6">
      <p className="text-caption text-text-tertiary">
        Presets are pre-defined permission sets that can be applied quickly from the Permission matrix tab.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Object.entries(allPresets).map(([name, perms]) => (
          <div key={name} className="bg-surface-1 rounded-xl border border-[rgb(var(--border-line))] p-5 shadow-linear-sm">
            <div className="flex items-center gap-2 mb-3">
              <Badge variant="brand" size="md">{PRESET_LABELS[name] || name}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(perms).map(([mod, level]) => {
                const cls = LEVEL_CLASSES[level] || LEVEL_CLASSES.none;
                return (
                  <div key={mod} className="flex items-center gap-1 text-tiny">
                    <span className="text-text-tertiary">{MODULE_LABELS[mod] || mod}:</span>
                    <span className={cn('px-1.5 py-0.5 rounded font-emphasis', cls)}>
                      {LEVEL_LABELS[level] || level}
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
  const selectedTeams = selectedTeamIds
    .map((teamId) => availableTeams.find((team) => team.id === teamId))
    .filter((team): team is TeamRecord => Boolean(team));

  return (
    <FieldGroup label="Teams" description="Assign this user to one or more pre-configured teams.">
      {availableTeams.length === 0 ? (
        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-quaternary">
          No teams have been created yet. Create teams in the Teams tab first.
        </div>
      ) : (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-4 space-y-4">
          <div className="flex flex-wrap gap-2 min-h-[2rem]">
            {selectedTeams.length > 0 ? (
              selectedTeams.map((team) => (
                <Badge key={team.id} variant="brand" size="sm">{team.name}</Badge>
              ))
            ) : (
              <span className="text-caption text-text-quaternary">No team selected.</span>
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
                    <div className="text-caption text-text-tertiary">{team.description || 'No description'}</div>
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
        setError(passwordError);
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
      toast.success(`User ${email} created`);
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, 'Failed to create user.'));
    } finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Add user"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="invite-user-form" disabled={loading} loading={loading}>
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="invite-user-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}
        <FieldGroup label="Full name" required>
          <Input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </FieldGroup>
        <FieldGroup label="Email" required>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FieldGroup>
        {(authConfig.googleEnabled || authConfig.passwordEnabled) && (
          <FieldGroup label="Login method">
            <Select value={authProvider} onChange={(e) => setAuthProvider(e.target.value as AuthProvider)}>
              {authConfig.googleEnabled && <option value="google">Google</option>}
              {authConfig.passwordEnabled && <option value="password">Password</option>}
            </Select>
          </FieldGroup>
        )}
        {authProvider === 'password' ? (
          <FieldGroup label="Password" required description={PASSWORD_REQUIREMENTS_TEXT}>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
            />
          </FieldGroup>
        ) : (
          <div className="rounded-md border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand">
            The user will sign in with Google using this email. No password is required.
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
      toast.success('User updated');
      onSuccess();
    } catch (err: any) { setError(extractApiError(err, 'Failed')); }
    finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Edit user"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-user-form" disabled={loading} loading={loading}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-tertiary mb-4">{user.email}</p>
      <form id="edit-user-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}
        <FieldGroup label="Status">
          <Select value={userStatus} onChange={(e) => setUserStatus(e.target.value as UserStatus)}>
            <option value="active">Active</option>
            <option value="deactivated">Deactivated</option>
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
      setError('Team name is required.');
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
        toast.success(`Updated ${trimmedName}`);
      } else {
        await permissionsApi.createTeam(payload);
        toast.success(`Created ${trimmedName}`);
      }
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, 'Failed to save team.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={team ? `Edit ${team.name}` : 'Create team'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="team-form" disabled={loading} loading={loading}>
            {loading ? 'Saving…' : team ? 'Save changes' : 'Create team'}
          </Button>
        </>
      }
    >
      <form id="team-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldGroup label="Team name" required>
            <Input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Commercial, Product, Leadership…" />
          </FieldGroup>
          <FieldGroup label="Description" description="Optional context for when this team should be used.">
            <Input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who belongs here and why" />
          </FieldGroup>
        </div>

        <FieldGroup label="Assigned members" description="Only active users can be assigned to a team.">
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-4 space-y-4">
            <Input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Filter by name or email"
            />

            <div className="flex flex-wrap gap-2 min-h-[2rem]">
              {selectedMembers.length > 0 ? (
                selectedMembers.map((member) => (
                  <Badge key={member.id} variant="brand" size="sm">
                    {member.full_name || member.email}
                  </Badge>
                ))
              ) : (
                <span className="text-caption text-text-quaternary">No users selected.</span>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 divide-y divide-[rgb(var(--border-line))]">
              {filteredUsers.length === 0 ? (
                <div className="px-4 py-6 text-center text-caption text-text-quaternary">No active users match this filter.</div>
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
