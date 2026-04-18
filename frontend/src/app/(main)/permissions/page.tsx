'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, UserX } from 'lucide-react';
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
  last_login_at: string | null;
  created_at: string;
}

/* ───────────── constants ───────────── */

const MODULE_LABELS: Record<string, string> = {
  data_sources:      'Data sources',
  datasets:          'Datasets',
  explore_charts:    'Explore + charts',
  dashboards:        'Dashboards',
  report_templates:  'Report templates',
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

type Tab = 'matrix' | 'users' | 'presets';

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

  const { data: users = [], isLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => usersApi.deactivate(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('User deactivated'); },
    onError: (err: any) => toast.error(extractApiError(err, 'Failed')),
  });

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-caption text-text-tertiary">{users.length} users</p>
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
        {isLoading ? (
          <div className="p-12 text-center text-text-quaternary">Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">No users found.</div>
        ) : (
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-[rgb(var(--border-line))] bg-surface-2">
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Name</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Email</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Login method</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Status</th>
                <th className="text-left px-6 py-3 text-tiny uppercase tracking-[0.14em] text-text-quaternary">Last login</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
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

      {showInviteModal && <InviteModal onClose={() => setShowInviteModal(false)} onSuccess={() => { qc.invalidateQueries({ queryKey: ['users'] }); setShowInviteModal(false); }} />}
      {editingUser && <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} onSuccess={() => { qc.invalidateQueries({ queryKey: ['users'] }); setEditingUser(null); }} />}
    </>
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

function InviteModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [authProvider, setAuthProvider] = useState<AuthProvider>(
    authConfig.googleEnabled ? 'google' : 'password',
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      size="sm"
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
      </form>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSuccess }: { user: UserRecord; onClose: () => void; onSuccess: () => void }) {
  const [userStatus, setUserStatus] = useState<UserStatus>(user.status);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await usersApi.update(user.id, { status: userStatus });
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
      size="sm"
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
      </form>
    </Modal>
  );
}
