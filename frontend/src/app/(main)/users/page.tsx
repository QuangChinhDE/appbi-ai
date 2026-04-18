'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Edit2, UserX } from 'lucide-react';
import { usersApi } from '@/lib/api-client';
import { extractApiError, PASSWORD_REQUIREMENTS_TEXT, validatePasswordStrength } from '@/lib/api-errors';
import { authConfig, getAuthMethodLabel, type AuthProvider } from '@/lib/auth-config';
import { toast } from '@/lib/toast';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Select, FieldGroup } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/common/Modal';

type UserStatus = 'active' | 'deactivated';

interface User {
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

export default function UsersPage() {
  const qc = useQueryClient();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => usersApi.deactivate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User deactivated');
    },
    onError: (err: any) => {
      toast.error(extractApiError(err, 'Failed to deactivate user'));
    },
  });

  return (
    <div className="w-full px-8 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-h1 text-text-primary font-emphasis">Users</h1>
          <p className="text-caption text-text-tertiary mt-1">Manage team members and their access levels.</p>
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

      {/* List */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="p-12 text-center text-text-quaternary">Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-text-quaternary">No users found.</div>
        ) : (
          users.map((user) => (
            <div
              key={user.id}
              className="bg-surface-1 border border-[rgb(var(--border-line))] rounded-lg p-3 flex items-center gap-3"
            >
              <div className="h-9 w-9 rounded-full flex items-center justify-center bg-brand text-text-inverse text-tiny font-strong flex-shrink-0">
                {(user.full_name || user.email).slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-emphasis text-text-primary truncate">{user.full_name}</span>
                  <Badge variant={user.status === 'active' ? 'success' : 'danger'} size="xs">
                    {user.status}
                  </Badge>
                </div>
                <span className="text-tiny text-text-quaternary truncate block">{user.email}</span>
              </div>
              <Badge variant="neutral" size="sm">
                {getAuthMethodLabel(user.auth_provider, user.google_connected)}
              </Badge>
              <span className="text-caption text-text-tertiary hidden md:inline">
                {user.last_login_at
                  ? new Date(user.last_login_at).toLocaleDateString()
                  : 'Never'}
              </span>
              <div className="flex items-center gap-1">
                <IconButton aria-label="Edit role" variant="ghost" size="sm" onClick={() => setEditingUser(user)}>
                  <Edit2 className="h-4 w-4" />
                </IconButton>
                {user.status === 'active' && (
                  <IconButton
                    aria-label="Deactivate user"
                    variant="ghost"
                    size="sm"
                    onClick={() => deactivateMutation.mutate(user.id)}
                    disabled={deactivateMutation.isPending}
                    className="hover:text-danger"
                  >
                    <UserX className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Invite Modal */}
      {showInviteModal && (
        <InviteModal
          onClose={() => setShowInviteModal(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            setShowInviteModal(false);
          }}
        />
      )}

      {/* Edit Role Modal */}
      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['users'] });
            setEditingUser(null);
          }}
        />
      )}
    </div>
  );
}

// ── Invite modal ────────────────────────────────────────────────────────────

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
      toast.success(`User ${email} created successfully`);
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, 'Failed to create user.'));
    } finally {
      setLoading(false);
    }
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
          <Button variant="primary" type="submit" form="users-invite-form" disabled={loading} loading={loading}>
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="users-invite-form" onSubmit={handleSubmit} className="space-y-3">
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

// ── Edit role/status modal ────────────────────────────────────────────────

function EditUserModal({
  user,
  onClose,
  onSuccess,
}: {
  user: User;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await usersApi.update(user.id, { status });
      toast.success('User updated');
      onSuccess();
    } catch (err: any) {
      setError(extractApiError(err, 'Failed to update user.'));
    } finally {
      setLoading(false);
    }
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
          <Button variant="primary" type="submit" form="users-edit-form" disabled={loading} loading={loading}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="text-caption text-text-tertiary mb-4">{user.email}</p>
      <form id="users-edit-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>
        )}
        <FieldGroup label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as UserStatus)}>
            <option value="active">Active</option>
            <option value="deactivated">Deactivated</option>
          </Select>
        </FieldGroup>
      </form>
    </Modal>
  );
}
