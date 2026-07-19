'use client';

import { useState } from 'react';
import {
  Plug, Database, Search, LayoutDashboard, Radar, Gauge, Inbox,
  LineChart, Compass, Landmark, ClipboardList, Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { permissionsApi, usersApi } from '@/lib/api-client';
import { extractApiError, validatePasswordStrength } from '@/lib/api-errors';
import { authConfig, type AuthProvider } from '@/lib/auth-config';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { Input, Select, FieldGroup } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';

/* ───────────── types ───────────── */

export type UserStatus = 'active' | 'deactivated';

export interface UserTeamRecord {
  id: string;
  name: string;
  description: string | null;
}

export interface UserRecord {
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

export interface TeamMemberRecord {
  user_id: string;
  email: string;
  full_name: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  members: TeamMemberRecord[];
  created_at: string;
  updated_at: string;
}

export interface UserPermissionRow {
  user_id: string;
  email: string;
  full_name: string;
  permissions: Record<string, string>;
}

export interface PermissionMatrix {
  modules: string[];
  module_levels: Record<string, string[]>;
  users: UserPermissionRow[];
}

/* ───────────── constants ───────────── */

export const MODULE_LABEL_KEYS: Record<string, string> = {
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

export const MODULE_ICONS: Record<string, LucideIcon> = {
  data_sources: Plug,
  datasets: Database,
  explore_charts: Search,
  dashboards: LayoutDashboard,
  observability: Radar,
  intelligence: Gauge,
  ai_inbox: Inbox,
  semantics: LineChart,
  ai_guidance: Compass,
  govern: Landmark,
  workboards: ClipboardList,
  settings: Shield,
};

/** Area groups mirror the sidebar so the access panel is self-labeled. */
export const MODULE_GROUPS: { key: string; labelKey: string; modules: string[] }[] = [
  { key: 'data', labelKey: 'settings.area.data', modules: ['data_sources', 'datasets'] },
  { key: 'analyze', labelKey: 'settings.area.analyze', modules: ['explore_charts', 'dashboards', 'observability'] },
  { key: 'intelligence', labelKey: 'settings.area.intelligence', modules: ['intelligence', 'ai_inbox', 'semantics', 'ai_guidance', 'govern'] },
  { key: 'operate', labelKey: 'settings.area.operate', modules: ['workboards'] },
  { key: 'admin', labelKey: 'settings.area.admin', modules: ['settings'] },
];

/** Group the live module list (from the matrix) into areas; drop empty groups
 *  and append any ungrouped modules so nothing is ever hidden. */
export function groupModules(modules: string[]): { key: string; labelKey: string; modules: string[] }[] {
  const present = new Set(modules);
  const grouped = new Set<string>();
  const out = MODULE_GROUPS.map((g) => {
    const mods = g.modules.filter((m) => present.has(m));
    mods.forEach((m) => grouped.add(m));
    return { ...g, modules: mods };
  }).filter((g) => g.modules.length > 0);
  const leftover = modules.filter((m) => !grouped.has(m));
  if (leftover.length) out.push({ key: 'other', labelKey: 'settings.area.admin', modules: leftover });
  return out;
}

export const LEVEL_CLASSES: Record<string, string> = {
  none: 'bg-danger/10 text-danger',
  view: 'bg-brand/10 text-brand',
  edit: 'bg-success/10 text-success',
  full: 'bg-info/10 text-info',
};

export const LEVEL_LABEL_KEYS: Record<string, string> = {
  none: 'settings.level.none',
  view: 'settings.level.view',
  edit: 'settings.level.edit',
  full: 'settings.level.full',
};

export const LEVEL_HELP_KEYS: Record<string, string> = {
  none: 'settings.levelHelp.none',
  view: 'settings.levelHelp.view',
  edit: 'settings.levelHelp.edit',
  full: 'settings.levelHelp.full',
};

export const PRESETS = ['admin', 'editor', 'viewer', 'minimal'] as const;

export const PRESET_LABEL_KEYS: Record<string, string> = {
  admin: 'settings.preset.admin',
  editor: 'settings.preset.editor',
  viewer: 'settings.preset.viewer',
  minimal: 'settings.preset.minimal',
};

export const ROLE_LABEL_KEYS: Record<string, string> = {
  admin: 'settings.role.admin',
  editor: 'settings.role.editor',
  viewer: 'settings.role.viewer',
  minimal: 'settings.role.minimal',
  custom: 'settings.role.custom',
};

export const ROLE_BADGE_VARIANT: Record<string, 'brand' | 'success' | 'info' | 'neutral' | 'subtle'> = {
  admin: 'info',
  editor: 'success',
  viewer: 'brand',
  minimal: 'subtle',
  custom: 'neutral',
};

/* ───────────── helpers ───────────── */

type T = (key: string, values?: Record<string, string | number>) => string;

export const moduleLabel = (module: string, t: T) => (MODULE_LABEL_KEYS[module] ? t(MODULE_LABEL_KEYS[module]) : module);
export const levelLabel = (level: string, t: T) => (LEVEL_LABEL_KEYS[level] ? t(LEVEL_LABEL_KEYS[level]) : level);
export const levelHelp = (level: string, t: T) => (LEVEL_HELP_KEYS[level] ? t(LEVEL_HELP_KEYS[level]) : '');
export const presetLabel = (preset: string, t: T) => (PRESET_LABEL_KEYS[preset] ? t(PRESET_LABEL_KEYS[preset]) : preset);
export const roleLabel = (role: string, t: T) => (ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role);

export function levelLabels(t: T): Record<string, string> {
  return { none: levelLabel('none', t), view: levelLabel('view', t), edit: levelLabel('edit', t), full: levelLabel('full', t) };
}

export function authMethodLabel(user: { auth_provider: AuthProvider; google_connected: boolean }, t: T): string {
  if (user.auth_provider === 'password' && user.google_connected) return t('settings.auth.googlePassword');
  return t(user.auth_provider === 'google' ? 'settings.auth.google' : 'settings.auth.password');
}

export function initials(nameOrEmail: string): string {
  return (nameOrEmail || '?').slice(0, 2).toUpperCase();
}

/**
 * Derive a role name by matching the user's effective permissions against the
 * named presets over the live module set. Falls back to "custom".
 */
export function deriveRole(
  perms: Record<string, string>,
  presets: Record<string, Record<string, string>> | undefined,
  modules: string[],
): string {
  if (!presets) return 'custom';
  for (const name of PRESETS) {
    const preset = presets[name];
    if (!preset) continue;
    const matches = modules.every((m) => (perms[m] ?? 'none') === (preset[m] ?? 'none'));
    if (matches) return name;
  }
  return 'custom';
}

/* ═══════════ SHARED MODALS ═══════════ */

export function TeamAssignmentField({
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
                    checked ? 'border-brand bg-brand/10' : 'border-[rgb(var(--border-line))] bg-surface-1 hover:bg-surface-2',
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

export function InviteModal({
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
  const [authProvider, setAuthProvider] = useState<AuthProvider>(authConfig.googleEnabled ? 'google' : 'password');
  const [password, setPassword] = useState('');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(defaultTeamIds);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleTeam = (teamId: string) =>
    setSelectedTeamIds((cur) => (cur.includes(teamId) ? cur.filter((id) => id !== teamId) : [...cur, teamId]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (authProvider === 'password') {
      const passwordError = validatePasswordStrength(password);
      if (passwordError) { setError(t('settings.invite.passwordHelp')); return; }
    }
    setLoading(true);
    try {
      await usersApi.create({
        email, full_name: fullName, auth_provider: authProvider, team_ids: selectedTeamIds,
        ...(authProvider === 'password' ? { password } : {}),
      });
      toast.success(t('settings.invite.createdToast', { email }));
      onSuccess();
    } catch (err: unknown) {
      setError(extractApiError(err, t('settings.invite.failed')));
    } finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen onClose={onClose} title={t('settings.invite.title')} size="lg"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="invite-user-form" disabled={loading} loading={loading}>
            {loading ? t('settings.invite.creating') : t('settings.common.create')}
          </Button>
        </>
      )}
    >
      <form id="invite-user-form" onSubmit={handleSubmit} className="space-y-3">
        {error && <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>}
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
            <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('settings.invite.passwordPlaceholder')} />
          </FieldGroup>
        ) : (
          <div className="rounded-md border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand">
            {t('settings.invite.googleNotice')}
          </div>
        )}
        <TeamAssignmentField availableTeams={availableTeams} selectedTeamIds={selectedTeamIds} onToggle={toggleTeam} />
      </form>
    </Modal>
  );
}

export function ManageTeamsModal({
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
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(user.teams.map((team) => team.id));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggleTeam = (teamId: string) =>
    setSelectedTeamIds((cur) => (cur.includes(teamId) ? cur.filter((id) => id !== teamId) : [...cur, teamId]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await usersApi.update(user.id, { team_ids: selectedTeamIds });
      toast.success(t('settings.editUser.updatedToast'));
      onSuccess();
    } catch (err: unknown) {
      setError(extractApiError(err, t('settings.editUser.failed')));
    } finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen onClose={onClose} title={t('settings.editUser.title')} size="lg"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="manage-teams-form" disabled={loading} loading={loading}>
            {loading ? t('settings.common.saving') : t('settings.common.save')}
          </Button>
        </>
      )}
    >
      <p className="text-caption text-text-tertiary mb-4">{user.email}</p>
      <form id="manage-teams-form" onSubmit={handleSubmit} className="space-y-3">
        {error && <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>}
        <TeamAssignmentField availableTeams={availableTeams} selectedTeamIds={selectedTeamIds} onToggle={toggleTeam} />
      </form>
    </Modal>
  );
}

export function TeamModal({
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
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(team?.members.map((m) => m.user_id) ?? []);
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

  const toggleMember = (userId: string) =>
    setSelectedMemberIds((cur) => (cur.includes(userId) ? cur.filter((id) => id !== userId) : [...cur, userId]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) { setError(t('settings.teamModal.nameRequired')); return; }
    setError(''); setLoading(true);
    try {
      const payload = { name: trimmedName, description: description.trim() || undefined, member_ids: selectedMemberIds };
      if (team) {
        await permissionsApi.updateTeam(team.id, payload);
        toast.success(t('settings.teamModal.updatedToast', { name: trimmedName }));
      } else {
        await permissionsApi.createTeam(payload);
        toast.success(t('settings.teamModal.createdToast', { name: trimmedName }));
      }
      onSuccess();
    } catch (err: unknown) {
      setError(extractApiError(err, t('settings.teamModal.failed')));
    } finally { setLoading(false); }
  };

  return (
    <Modal
      isOpen onClose={onClose}
      title={team ? t('settings.teamModal.editTitle', { name: team.name }) : t('settings.teamModal.createTitle')}
      size="lg"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('settings.common.cancel')}</Button>
          <Button variant="primary" type="submit" form="team-form" disabled={loading} loading={loading}>
            {loading ? t('settings.common.saving') : team ? t('settings.common.saveChanges') : t('settings.teamModal.createTitle')}
          </Button>
        </>
      )}
    >
      <form id="team-form" onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">{error}</p>}
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
            <Input type="text" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder={t('settings.teamModal.filterPlaceholder')} />
            <div className="flex flex-wrap gap-2 min-h-[2rem]">
              {selectedMembers.length > 0 ? (
                selectedMembers.map((member) => (
                  <Badge key={member.id} variant="brand" size="sm">{member.full_name || member.email}</Badge>
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
                    <label key={user.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors">
                      <input type="checkbox" checked={checked} onChange={() => toggleMember(user.id)} className="h-4 w-4 rounded border-[rgb(var(--border-line))] text-brand focus:ring-brand" />
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
