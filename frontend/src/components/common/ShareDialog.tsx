'use client';

import React, { useState, useEffect } from 'react';
import { Search, Users, Trash2 } from 'lucide-react';
import { teamsApi, usersApi, sharesApi } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/common/Modal';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { useI18n } from '@/providers/LanguageProvider';

type Permission = 'view' | 'edit';

interface ShareUser {
  id: string;
  email: string;
  full_name: string;
}

interface ShareEntry {
  id: number;
  target_type: 'user' | 'team';
  user_id?: string | null;
  team_id?: string | null;
  permission: Permission;
  user?: ShareUser;
  team?: ShareTeam;
}

interface UserOption {
  id: string;
  email: string;
  full_name: string;
  role: string;
}

interface ShareTeam {
  id: string;
  name: string;
  description?: string | null;
  member_count?: number;
}

interface TeamOption {
  id: string;
  name: string;
  description?: string | null;
  member_count: number;
}

interface ShareDialogProps {
  resourceType: string;
  resourceId: number | string;
  resourceName: string;
  onClose: () => void;
}

export function ShareDialog({ resourceType, resourceId, resourceName, onClose }: ShareDialogProps) {
  const { t } = useI18n();
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [permission, setPermission] = useState<Permission>('view');
  const [userShareLoading, setUserShareLoading] = useState(false);
  const [teamShareLoading, setTeamShareLoading] = useState(false);
  const [loadingShares, setLoadingShares] = useState(true);
  const [error, setError] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const typedEmail = !selectedUser && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedSearch)
    ? normalizedSearch
    : '';

  const getShareTargetLabel = (share: ShareEntry) => {
    if (share.target_type === 'team') {
      return share.team?.name || t('shared.share.teamFallback');
    }
    return share.user?.full_name || share.user?.email || share.user_id || t('shared.share.userFallback');
  };

  const getShareTargetDescription = (share: ShareEntry) => {
    if (share.target_type === 'team') {
      return share.team?.description || t('shared.share.teamAccessDescription');
    }
    return share.user?.email || t('shared.share.directUserAccess');
  };

  // Load existing shares, users, and shareable teams
  useEffect(() => {
    const load = async () => {
      setLoadingShares(true);
      try {
        const [sharesData, usersData, teamsData] = await Promise.all([
          sharesApi.getShares(resourceType, resourceId),
          usersApi.getShareable(resourceType, resourceId),
          teamsApi.getShareable(resourceType, resourceId),
        ]);
        setShares(Array.isArray(sharesData) ? sharesData : []);
        setUsers(Array.isArray(usersData) ? usersData : []);
        setTeams(Array.isArray(teamsData) ? teamsData : []);
      } catch {
        const message = t('shared.share.loadFailed');
        setError(message);
        toast.error(message, {
          description: resourceName,
        });
        setShares([]);
        setUsers([]);
        setTeams([]);
      } finally {
        setLoadingShares(false);
      }
    };
    load();
  }, [resourceType, resourceId, resourceName, t]);

  const directUserShareIds = new Set(
    shares
      .filter((share) => share.target_type === 'user' && share.user_id)
      .map((share) => share.user_id as string),
  );

  const filteredUsers = (users || []).filter((u) => {
    const alreadyShared = directUserShareIds.has(u.id);
    if (alreadyShared) return false;
    const q = search.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q);
  });

  const availableTeams = teams.filter(
    (team) => !shares.some((share) => share.target_type === 'team' && share.team_id === team.id),
  );
  const selectedTeam = availableTeams.find((team) => team.id === selectedTeamId) ?? null;

  const matchedUser = selectedUser ?? filteredUsers.find((u) => u.email.toLowerCase() === normalizedSearch) ?? null;
  const sharePayload = selectedUser
    ? { user_id: selectedUser.id, permission }
    : typedEmail
      ? { email: typedEmail, permission }
      : null;

  const handleShare = async () => {
    if (!sharePayload) {
      setError(t('shared.share.chooseUserError'));
      return;
    }
    setUserShareLoading(true);
    setError('');
    try {
      await sharesApi.share(resourceType, resourceId, sharePayload);
      // Refresh shares
      const newShares = await sharesApi.getShares(resourceType, resourceId);
      setShares(newShares);
      toast.success(t('shared.share.accessShared'), {
        description: t('shared.share.toastDescription', {
          target: matchedUser?.full_name || matchedUser?.email || typedEmail,
          resource: resourceName,
        }),
      });
      setSelectedUser(null);
      setSearch('');
    } catch (err: unknown) {
      const message = extractApiError(err, t('shared.share.failedToShare'));
      setError(message);
      toast.error(message, {
        description: resourceName,
      });
    } finally {
      setUserShareLoading(false);
    }
  };

  const handleShareTeam = async () => {
    if (!selectedTeam) {
      setError(t('shared.share.chooseTeamError'));
      return;
    }
    setTeamShareLoading(true);
    setError('');
    try {
      await sharesApi.share(resourceType, resourceId, { team_id: selectedTeam.id, permission });
      const newShares = await sharesApi.getShares(resourceType, resourceId);
      setShares(newShares);
      toast.success(t('shared.share.teamAccessShared'), {
        description: t('shared.share.toastDescription', {
          target: selectedTeam.name,
          resource: resourceName,
        }),
      });
      setSelectedTeamId('');
    } catch (err: unknown) {
      const message = extractApiError(err, t('shared.share.failedToShareTeam'));
      setError(message);
      toast.error(message, {
        description: resourceName,
      });
    } finally {
      setTeamShareLoading(false);
    }
  };

  const handleUpdatePermission = async (shareId: number, newPermission: Permission) => {
    const sharedTarget = shares.find((share) => share.id === shareId);
    setError('');
    try {
      await sharesApi.updateShareEntry(resourceType, resourceId, shareId, { permission: newPermission });
      setShares((prev) =>
        prev.map((s) => (s.id === shareId ? { ...s, permission: newPermission } : s))
      );
      toast.success(t('shared.share.permissionUpdated'), {
        description: t('shared.share.toastDescription', {
          target: sharedTarget ? getShareTargetLabel(sharedTarget) : shareId,
          resource: resourceName,
        }),
      });
    } catch {
      const message = t('shared.share.permissionUpdateFailed');
      setError(message);
      toast.error(message, {
        description: resourceName,
      });
    }
  };

  const handleRevoke = async (shareId: number) => {
    const sharedTarget = shares.find((share) => share.id === shareId);
    setError('');
    try {
      await sharesApi.revokeShareEntry(resourceType, resourceId, shareId);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
      toast.success(t('shared.share.accessRevoked'), {
        description: t('shared.share.toastDescription', {
          target: sharedTarget ? getShareTargetLabel(sharedTarget) : shareId,
          resource: resourceName,
        }),
      });
    } catch {
      const message = t('shared.share.revokeFailed');
      setError(message);
      toast.error(message, {
        description: resourceName,
      });
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('shared.share.title', { name: resourceName })}
      size="lg"
    >
      <div className="space-y-5">
        {error && (
          <p className="text-caption text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {/* Add user section */}
        <div>
          <label className="block text-label font-emphasis text-text-secondary mb-2">{t('shared.share.addPeople')}</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                leadingIcon={<Search className="h-4 w-4" />}
                type="text"
                placeholder={t('shared.share.searchPeoplePlaceholder')}
                value={selectedUser ? `${selectedUser.full_name} <${selectedUser.email}>` : search}
                onChange={(e) => {
                  if (selectedUser) setSelectedUser(null);
                  setSearch(e.target.value);
                }}
              />
              {/* Dropdown */}
              {search.length > 0 && !selectedUser && filteredUsers.length > 0 && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-surface-1 border border-[rgb(var(--border-line))] rounded-md shadow-popover z-10 max-h-40 overflow-y-auto">
                  {filteredUsers.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => { setSelectedUser(u); setSearch(''); }}
                      className="w-full text-left px-3 py-2 hover:bg-surface-2 text-caption"
                    >
                      <span className="font-emphasis text-text-primary">{u.full_name}</span>
                      <span className="text-text-tertiary ml-2">{u.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Select
              className="w-auto"
              value={permission}
              onChange={(e) => setPermission(e.target.value as Permission)}
            >
              <option value="view">{t('shared.share.viewer')}</option>
              <option value="edit">{t('shared.share.editor')}</option>
            </Select>

            <Button
              variant="primary"
              onClick={handleShare}
              disabled={!sharePayload || userShareLoading}
              loading={userShareLoading}
            >
              {userShareLoading ? t('shared.share.sharing') : t('shared.share.shareButton')}
            </Button>
          </div>
          {!selectedUser && normalizedSearch && (
            <p className="mt-2 text-tiny text-text-quaternary">
              {matchedUser
                ? t('shared.share.matchedUserHint', { email: matchedUser.email })
                : typedEmail
                  ? t('shared.share.emailLookupHint', { email: typedEmail })
                  : t('shared.share.keepTypingHint')}
            </p>
          )}
        </div>

        {/* Add team section */}
        <div className="border-t border-[rgb(var(--border-line))] pt-4">
          <label className="block text-label font-emphasis text-text-secondary mb-2">{t('shared.share.addTeam')}</label>
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              <option value="">{t('shared.share.selectTeamPlaceholder')}</option>
              {availableTeams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({team.member_count})
                </option>
              ))}
            </Select>
            <Select
              className="w-auto"
              value={permission}
              onChange={(e) => setPermission(e.target.value as Permission)}
            >
              <option value="view">{t('shared.share.viewer')}</option>
              <option value="edit">{t('shared.share.editor')}</option>
            </Select>
            <Button
              variant="primary"
              onClick={handleShareTeam}
              disabled={!selectedTeam || teamShareLoading}
              loading={teamShareLoading}
            >
              {teamShareLoading ? t('shared.share.sharing') : t('shared.share.shareButton')}
            </Button>
          </div>
          <p className="mt-2 text-tiny text-text-quaternary">
            {t('shared.share.teamInheritsHint')}
          </p>
        </div>

        {/* Existing shares */}
        <div>
          <h3 className="text-label font-emphasis text-text-secondary mb-2">
            {t('shared.share.accessListTitle')} {shares.length > 0 && <span className="text-text-quaternary">({shares.length})</span>}
          </h3>
          {loadingShares ? (
            <p className="text-caption text-text-quaternary">{t('common.loading')}</p>
          ) : shares.length === 0 ? (
            <p className="text-caption text-text-quaternary">{t('shared.share.notSharedYet')}</p>
          ) : (
            <ul className="space-y-2">
              {shares.map((s) => (
                <li
                  key={s.id}
                  className="bg-surface-1 border border-[rgb(var(--border-line))] rounded-lg p-3 flex items-center gap-3"
                >
                  {s.target_type === 'team' ? (
                    <div className="h-9 w-9 rounded-full flex items-center justify-center bg-surface-2 text-text-secondary flex-shrink-0">
                      <Users className="h-4 w-4" />
                    </div>
                  ) : (
                    <div className="h-9 w-9 rounded-full flex items-center justify-center bg-brand text-text-inverse text-tiny font-strong flex-shrink-0">
                      {(s.user?.full_name || s.user?.email || '??').slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-caption font-emphasis text-text-primary truncate">{getShareTargetLabel(s)}</p>
                    <p className="text-tiny text-text-tertiary truncate">{getShareTargetDescription(s)}</p>
                  </div>
                  <Select
                    className="w-auto"
                    size="sm"
                    value={s.permission}
                    onChange={(e) => handleUpdatePermission(s.id, e.target.value as Permission)}
                  >
                    <option value="view">{t('shared.share.viewer')}</option>
                    <option value="edit">{t('shared.share.editor')}</option>
                  </Select>
                  <IconButton
                    aria-label={t('shared.share.removeAccess')}
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevoke(s.id)}
                    className="hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
