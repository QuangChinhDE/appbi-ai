'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Search,
  BarChart3,
  Database,
  Plug,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
  Users,
  LogOut,
  KeyRound,
  Shield,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from '@/hooks/use-current-user';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { authApi } from '@/lib/api-client';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  module?: string;      // module key for permission check
  adminOnly?: boolean;  // only visible to admin
}

const ALL_NAV_ITEMS: NavItem[] = [
  {
    label: 'Data Sources',
    href: '/datasources',
    icon: <Plug className="h-5 w-5" />,
    module: 'data_sources',
  },
  {
    label: 'Workspaces',
    href: '/dataset-workspaces',
    icon: <Database className="h-5 w-5" />,
    module: 'workspaces',
  },
  {
    label: 'Explore',
    href: '/explore',
    icon: <Search className="h-5 w-5" />,
    module: 'explore_charts',
  },
  {
    label: 'Dashboards',
    href: '/dashboards',
    icon: <LayoutDashboard className="h-5 w-5" />,
    module: 'dashboards',
  },
  {
    label: 'AI Chat',
    href: '/chat',
    icon: <MessageSquareText className="h-5 w-5" />,
    module: 'ai_chat',
  },
  {
    label: 'Settings',
    href: '/permissions',
    icon: <Shield className="h-5 w-5" />,
    module: 'settings',
  },
];

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { data: user } = useCurrentUser();
  const { data: permData } = usePermissions();

  const perms = permData?.permissions;
  const visibleItems = ALL_NAV_ITEMS.filter((item) => {
    if (item.module) return hasPermission(perms, item.module, 'view');
    return true;
  });

  const isActive = (href: string) => {
    if (href === '/explore') return pathname.startsWith('/explore');
    return pathname.startsWith(href);
  };

  const queryClient = useQueryClient();

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } finally {
      queryClient.clear();
      router.push('/login');
    }
  };

  return (
    <div
      className={`fixed left-0 top-0 h-screen bg-white border-r border-gray-200 transition-all duration-300 flex flex-col z-40 ${
        isCollapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200">
        {!isCollapsed && (
          <Link href="/" className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
              <BarChart3 className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              AppBI
            </span>
          </Link>
        )}
        {isCollapsed && (
          <Link href="/" className="flex items-center justify-center w-full">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
              <BarChart3 className="h-5 w-5 text-white" />
            </div>
          </Link>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="space-y-1 px-2">
          {visibleItems.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-all ${
                    active
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                  title={isCollapsed ? item.label : undefined}
                >
                  <span className={active ? 'text-blue-600' : 'text-gray-500'}>
                    {item.icon}
                  </span>
                  {!isCollapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User avatar + menu */}
      <div className="border-t border-gray-200">
        {user && (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className={`w-full flex items-center px-4 py-3 hover:bg-gray-50 transition-colors ${
                isCollapsed ? 'justify-center' : 'space-x-3'
              }`}
              title={isCollapsed ? user.full_name : undefined}
            >
              {/* Avatar circle */}
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {getInitials(user.full_name || user.email)}
              </div>
              {!isCollapsed && (
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-gray-900 truncate">{user.full_name}</p>
                  <p className="text-xs text-gray-500 truncate">{user.email}</p>
                </div>
              )}
            </button>

            {/* Dropdown */}
            {showUserMenu && (
              <div
                className={`absolute bottom-full ${
                  isCollapsed ? 'left-full ml-2' : 'left-2 right-2'
                } mb-1 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50`}
              >
                {!isCollapsed && (
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-sm font-medium text-gray-900">{user.full_name}</p>
                    <p className="text-xs text-gray-500 truncate">{user.email}</p>
                  </div>
                )}
                <button
                  onClick={() => { setShowChangePassword(true); setShowUserMenu(false); }}
                  className="w-full flex items-center space-x-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <KeyRound className="h-4 w-4 text-gray-400" />
                  <span>Change password</span>
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center space-x-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Collapse Toggle */}
        <div className="p-4">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="w-full flex items-center justify-center px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-5 w-5" />
            ) : (
              <>
                <ChevronLeft className="h-5 w-5 mr-2" />
                <span className="text-sm">Collapse</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Change Password modal */}
      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      const { authApi } = await import('@/lib/api-client');
      await authApi.changePassword(oldPassword, newPassword);
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to change password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Change password</h2>

        {success ? (
          <p className="text-green-600 text-sm">Password changed successfully!</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && (
              <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Current password</label>
              <input
                type="password"
                required
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg border border-gray-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60"
              >
                {loading ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

