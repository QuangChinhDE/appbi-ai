'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Plus, Edit2, UserX, ChevronDown } from 'lucide-react';
import { permissionsApi, usersApi } from '@/lib/api-client';
import { toast } from 'sonner';

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
  status: UserStatus;
  last_login_at: string | null;
  created_at: string;
}

/* ───────────── constants ───────────── */

const MODULE_LABELS: Record<string, string> = {
  data_sources:   'Data sources',
  datasets:       'Datasets',
  workspaces:     'Workspaces',
  explore_charts: 'Explore + charts',
  dashboards:     'Dashboards',
  ai_chat:        'AI chat',
  ai_agent:       'AI agent',
  settings:       'Settings',
};

const LEVEL_STYLES: Record<string, { bg: string; text: string; ring: string }> = {
  none: { bg: 'bg-red-50',    text: 'text-red-700',    ring: 'ring-red-200' },
  view: { bg: 'bg-blue-50',   text: 'text-blue-700',   ring: 'ring-blue-200' },
  edit: { bg: 'bg-green-50',  text: 'text-green-700',  ring: 'ring-green-200' },
  full: { bg: 'bg-purple-50', text: 'text-purple-700', ring: 'ring-purple-200' },
};

const LEVEL_LABELS: Record<string, string> = {
  none: 'No access',
  view: 'View',
  edit: 'Edit',
  full: 'Full',
};

const PRESET_COLORS: Record<string, string> = {
  admin:   'bg-purple-100 text-purple-800 border-purple-300',
  editor:  'bg-blue-100 text-blue-800 border-blue-300',
  viewer:  'bg-green-100 text-green-800 border-green-300',
  minimal: 'bg-orange-100 text-orange-800 border-orange-300',
};

const PRESETS = ['admin', 'editor', 'viewer', 'minimal'] as const;
const PRESET_LABELS: Record<string, string> = {
  admin: 'Admin (full)', editor: 'Editor', viewer: 'Viewer', minimal: 'Minimal',
};
const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  deactivated: 'bg-red-100 text-red-700',
};

type Tab = 'matrix' | 'users' | 'presets';

/* ═══════════ MAIN PAGE ═══════════ */

export default function PermissionsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('matrix');

  return (
    <div className="w-full px-8 py-6 max-w-[1400px]">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Permissions</h1>
        <p className="text-gray-500 text-sm mt-1">
          Set per-module access level for each user
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex space-x-6">
          {([
            { key: 'matrix', label: 'Permission matrix' },
            { key: 'users',  label: 'Users' },
            { key: 'presets', label: 'Presets' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === t.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
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
    onError: (err: any) => toast.error(err?.response?.data?.detail || 'Save failed'),
  });

  const presetMutation = useMutation({
    mutationFn: async ({ userId, preset }: { userId: string; preset: string }) =>
      permissionsApi.applyPreset(userId, preset),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      setPendingChanges((p) => { const n = { ...p }; delete n[vars.userId]; return n; });
      toast.success(`Applied "${vars.preset}" preset`);
    },
    onError: (err: any) => toast.error(err?.response?.data?.detail || 'Preset failed'),
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

  if (isLoading) return <div className="animate-pulse h-64 bg-gray-100 rounded-lg" />;

  const modules = matrix?.modules || [];
  const users = matrix?.users || [];
  const moduleLevels = matrix?.module_levels ?? {};

  return (
    <>
      {/* Preset bar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <span className="text-sm text-gray-500 mr-1">Apply preset:</span>
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => {
              if (!selectedUser) { toast.info('Select a user first, then click preset'); return; }
              presetMutation.mutate({ userId: selectedUser, preset: p });
            }}
            disabled={presetMutation.isPending}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-all hover:shadow-sm disabled:opacity-50 ${PRESET_COLORS[p]}`}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        {!selectedUser && (
          <span className="text-xs text-gray-400 italic">Select a user first, then click preset</span>
        )}
      </div>

      {/* Matrix table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/80">
              <th className="text-left px-5 py-3.5 font-medium text-gray-600 sticky left-0 bg-gray-50/80 min-w-[200px]">
                User
              </th>
              {modules.map((m) => (
                <th key={m} className="text-center px-3 py-3.5 font-medium text-gray-600 min-w-[110px]">
                  {MODULE_LABELS[m] || m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((user) => {
              const isSelected = selectedUser === user.user_id;
              const rowPending = !!pendingChanges[user.user_id];
              const isOwner = user.permissions?.settings === 'full';
              return (
                <tr
                  key={user.user_id}
                  onClick={() => setSelectedUser(isSelected ? null : user.user_id)}
                  className={`transition-colors cursor-pointer ${
                    isSelected ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' :
                    rowPending ? 'bg-yellow-50/60' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-5 py-3.5 sticky left-0 bg-inherit">
                    <div className="flex items-center space-x-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${
                        isSelected ? 'bg-blue-600' : 'bg-gradient-to-br from-blue-500 to-purple-500'
                      }`}>
                        {(user.full_name || user.email).slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900 truncate">{user.full_name}</p>
                          {isOwner && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-medium">Owner</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  {modules.map((m) => {
                    const val = getEffective(user, m);
                    const changed = pendingChanges[user.user_id]?.[m] !== undefined;
                    const allowed = moduleLevels[m] || ['none', 'view', 'edit', 'full'];
                    const s = LEVEL_STYLES[val] || LEVEL_STYLES.none;
                    return (
                      <td key={m} className="px-3 py-3.5 text-center">
                        <select
                          value={val}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setLevel(user.user_id, m, e.target.value)}
                          className={`appearance-none cursor-pointer text-center min-w-[80px] px-3 py-1.5 rounded-lg text-xs font-semibold ring-1 ring-inset transition-all hover:shadow-sm ${
                            changed ? 'ring-yellow-400 bg-yellow-50 text-yellow-800 shadow-sm' : `${s.bg} ${s.text} ${s.ring}`
                          }`}
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
      <div className="flex flex-wrap items-center gap-4 mt-4 text-xs text-gray-500">
        {Object.entries(LEVEL_LABELS).map(([val, label]) => {
          const s = LEVEL_STYLES[val] || LEVEL_STYLES.none;
          return (
            <div key={val} className="flex items-center gap-1.5">
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md ring-1 ring-inset font-medium ${s.bg} ${s.text} ${s.ring}`}>
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
      <div className="flex items-center justify-center gap-4 mt-6">
        <button
          onClick={handleResetAll}
          disabled={!hasPending}
          className="px-6 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Reset to defaults
        </button>
        <button
          onClick={handleSaveAll}
          disabled={!hasPending || saveMutation.isPending}
          className="px-6 py-2.5 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
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
    onError: (err: any) => toast.error(err?.response?.data?.detail || 'Failed'),
  });

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">{users.length} users</p>
        <button
          onClick={() => setShowInviteModal(true)}
          className="flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add user
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-gray-400">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/80">
                <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Email</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Last login</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3 font-medium text-gray-900">{u.full_name}</td>
                  <td className="px-6 py-3 text-gray-600">{u.email}</td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[u.status]}`}>{u.status}</span>
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center justify-end space-x-2">
                      <button onClick={() => setEditingUser(u)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                        <Edit2 className="h-4 w-4" />
                      </button>
                      {u.status === 'active' && (
                        <button onClick={() => deactivateMutation.mutate(u.id)} disabled={deactivateMutation.isPending}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50" title="Deactivate">
                          <UserX className="h-4 w-4" />
                        </button>
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
      <p className="text-sm text-gray-500">
        Presets are pre-defined permission sets that can be applied quickly from the Permission matrix tab.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.entries(allPresets).map(([name, perms]) => (
          <div key={name} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-3 py-1 rounded-full text-sm font-semibold border capitalize ${PRESET_COLORS[name] || 'bg-gray-100 text-gray-700 border-gray-300'}`}>
                {PRESET_LABELS[name] || name}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(perms).map(([mod, level]) => {
                const s = LEVEL_STYLES[level] || LEVEL_STYLES.none;
                return (
                  <div key={mod} className="flex items-center gap-1 text-xs">
                    <span className="text-gray-500">{MODULE_LABELS[mod] || mod}:</span>
                    <span className={`px-1.5 py-0.5 rounded font-medium ${s.bg} ${s.text}`}>
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
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await usersApi.create({ email, full_name: fullName, password });
      toast.success(`User ${email} created`);
      onSuccess();
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to create user.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add user</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
            <input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Min 8 characters" />
          </div>
          <div className="flex justify-end space-x-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg border border-gray-200">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60">
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
    } catch (err: any) { setError(err?.response?.data?.detail || 'Failed'); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Edit user</h2>
        <p className="text-sm text-gray-500 mb-4">{user.email}</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <div className="relative">
              <select value={userStatus} onChange={(e) => setUserStatus(e.target.value as UserStatus)}
                className="w-full appearance-none px-3 pr-8 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                <option value="active">Active</option>
                <option value="deactivated">Deactivated</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            </div>
          </div>
          <div className="flex justify-end space-x-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg border border-gray-200">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60">
              {loading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
