'use client';

import React, { useState, useEffect } from 'react';
import { X, Search, Share2, Users, Trash2, ChevronDown } from 'lucide-react';
import { usersApi, sharesApi } from '@/lib/api-client';

type Permission = 'viewer' | 'editor';

interface ShareUser {
  id: string;
  email: string;
  full_name: string;
}

interface ShareEntry {
  user_id: string;
  permission: Permission;
  user?: ShareUser;
}

interface UserOption {
  id: string;
  email: string;
  full_name: string;
  role: string;
}

interface ShareDialogProps {
  resourceType: string;
  resourceId: number | string;
  resourceName: string;
  onClose: () => void;
}

export function ShareDialog({ resourceType, resourceId, resourceName, onClose }: ShareDialogProps) {
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [permission, setPermission] = useState<Permission>('viewer');
  const [loading, setLoading] = useState(false);
  const [loadingShares, setLoadingShares] = useState(true);
  const [error, setError] = useState('');
  const [allTeamLoading, setAllTeamLoading] = useState(false);

  // Load existing shares and all users
  useEffect(() => {
    const load = async () => {
      setLoadingShares(true);
      try {
        const [sharesData, usersData] = await Promise.all([
          sharesApi.getShares(resourceType, resourceId),
          usersApi.getShareable(),
        ]);
        setShares(Array.isArray(sharesData) ? sharesData : []);
        setUsers(Array.isArray(usersData) ? usersData : []);
      } catch {
        setError('Failed to load sharing information.');
        setShares([]);
        setUsers([]);
      } finally {
        setLoadingShares(false);
      }
    };
    load();
  }, [resourceType, resourceId]);

  const filteredUsers = (users || []).filter((u) => {
    const alreadyShared = shares.some((s) => s.user_id === u.id);
    if (alreadyShared) return false;
    const q = search.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q);
  });

  const handleShare = async () => {
    if (!selectedUser) return;
    setLoading(true);
    setError('');
    try {
      await sharesApi.share(resourceType, resourceId, { user_id: selectedUser.id, permission });
      // Refresh shares
      const newShares = await sharesApi.getShares(resourceType, resourceId);
      setShares(newShares);
      setSelectedUser(null);
      setSearch('');
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to share.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePermission = async (userId: string, newPermission: Permission) => {
    try {
      await sharesApi.updateShare(resourceType, resourceId, userId, { permission: newPermission });
      setShares((prev) =>
        prev.map((s) => (s.user_id === userId ? { ...s, permission: newPermission } : s))
      );
    } catch {
      setError('Failed to update permission.');
    }
  };

  const handleRevoke = async (userId: string) => {
    try {
      await sharesApi.revokeShare(resourceType, resourceId, userId);
      setShares((prev) => prev.filter((s) => s.user_id !== userId));
    } catch {
      setError('Failed to revoke access.');
    }
  };

  const handleShareAllTeam = async () => {
    setAllTeamLoading(true);
    setError('');
    try {
      await sharesApi.shareAllTeam(resourceType, resourceId, { permission });
      const newShares = await sharesApi.getShares(resourceType, resourceId);
      setShares(newShares);
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to share with team.');
    } finally {
      setAllTeamLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center space-x-2">
            <Share2 className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900 truncate max-w-xs" title={resourceName}>
              Share "{resourceName}"
            </h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
          {error && (
            <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Add user section */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Add people</label>
            <div className="flex space-x-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by name or email…"
                  value={selectedUser ? `${selectedUser.full_name} <${selectedUser.email}>` : search}
                  onChange={(e) => {
                    if (selectedUser) setSelectedUser(null);
                    setSearch(e.target.value);
                  }}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {/* Dropdown */}
                {search.length > 0 && !selectedUser && filteredUsers.length > 0 && (
                  <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-40 overflow-y-auto">
                    {filteredUsers.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => { setSelectedUser(u); setSearch(''); }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm"
                      >
                        <span className="font-medium text-gray-900">{u.full_name}</span>
                        <span className="text-gray-500 ml-2">{u.email}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Permission selector */}
              <div className="relative">
                <select
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as Permission)}
                  className="appearance-none pl-3 pr-8 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
              </div>

              <button
                onClick={handleShare}
                disabled={!selectedUser || loading}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sharing…' : 'Share'}
              </button>
            </div>
          </div>

          {/* Share with all team */}
          <div className="flex items-center justify-between py-3 border-t border-gray-100">
            <div className="flex items-center space-x-2">
              <Users className="h-4 w-4 text-gray-400" />
              <span className="text-sm text-gray-700">Share with entire team</span>
            </div>
            <button
              onClick={handleShareAllTeam}
              disabled={allTeamLoading}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
            >
              {allTeamLoading ? 'Sharing…' : `Share as ${permission}`}
            </button>
          </div>

          {/* Existing shares */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">
              People with access {shares.length > 0 && <span className="text-gray-400">({shares.length})</span>}
            </h3>
            {loadingShares ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-gray-400">Not shared with anyone yet.</p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => (
                  <li key={s.user_id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600 flex-shrink-0">
                        {(s.user?.full_name || s.user?.email || '??').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{s.user?.full_name}</p>
                        <p className="text-xs text-gray-500 truncate">{s.user?.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      <select
                        value={s.permission}
                        onChange={(e) => handleUpdatePermission(s.user_id, e.target.value as Permission)}
                        className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button
                        onClick={() => handleRevoke(s.user_id)}
                        className="p-1 text-gray-400 hover:text-red-500 rounded"
                        title="Remove access"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
