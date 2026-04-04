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
  LogOut,
  KeyRound,
  Shield,
  Bot,
  HelpCircle,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/use-current-user';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { authApi } from '@/lib/api-client';
import { useI18n } from '@/providers/LanguageProvider';
import { GettingStartedModal } from '@/components/common/GettingStartedGuide';

interface NavItem {
  labelKey: string;
  href: string;
  icon: React.ReactNode;
  module?: string;
}

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const ALL_NAV_ITEMS: NavItem[] = [
  { labelKey: 'sidebar.nav.datasources', href: '/datasources', icon: <Plug className="h-5 w-5" />, module: 'data_sources' },
  { labelKey: 'sidebar.nav.datasets', href: '/datasets', icon: <Database className="h-5 w-5" />, module: 'datasets' },
  { labelKey: 'sidebar.nav.explore', href: '/explore', icon: <Search className="h-5 w-5" />, module: 'explore_charts' },
  { labelKey: 'sidebar.nav.dashboards', href: '/dashboards', icon: <LayoutDashboard className="h-5 w-5" />, module: 'dashboards' },
  { labelKey: 'sidebar.nav.aiReports', href: '/ai-reports', icon: <Bot className="h-5 w-5" />, module: 'ai_agent' },
  { labelKey: 'sidebar.nav.aiChat', href: '/chat', icon: <MessageSquareText className="h-5 w-5" />, module: 'ai_chat' },
  { labelKey: 'sidebar.nav.settings', href: '/permissions', icon: <Shield className="h-5 w-5" />, module: 'settings' },
];

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function Sidebar({ isCollapsed, onToggleCollapse }: SidebarProps) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { language, setLanguage, t } = useI18n();
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
      className={`fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-gray-200 bg-white transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-64'
      }`}
    >
      <div className="flex h-16 items-center justify-between border-b border-gray-200 px-4">
        {!isCollapsed ? (
          <Link href="/" className="flex items-center space-x-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-purple-600">
              <BarChart3 className="h-5 w-5 text-white" />
            </div>
            <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-xl font-bold text-transparent">
              AppBI
            </span>
          </Link>
        ) : (
          <Link href="/" className="flex w-full items-center justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-purple-600">
              <BarChart3 className="h-5 w-5 text-white" />
            </div>
          </Link>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="space-y-1 px-2">
          {visibleItems.map((item) => {
            const active = isActive(item.href);
            const label = t(item.labelKey);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center space-x-3 rounded-lg px-3 py-2.5 transition-all ${
                    active ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                  title={isCollapsed ? label : undefined}
                >
                  <span className={active ? 'text-blue-600' : 'text-gray-500'}>{item.icon}</span>
                  {!isCollapsed && <span>{label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-gray-200">
        {user && (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className={`w-full px-4 py-3 transition-colors hover:bg-gray-50 ${
                isCollapsed ? 'flex justify-center' : 'flex items-center space-x-3'
              }`}
              title={isCollapsed ? user.full_name : undefined}
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-purple-600 text-xs font-bold text-white">
                {getInitials(user.full_name || user.email)}
              </div>
              {!isCollapsed && (
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-gray-900">{user.full_name}</p>
                  <p className="truncate text-xs text-gray-500">{user.email}</p>
                </div>
              )}
            </button>

            {showUserMenu && (
              <div
                className={`absolute bottom-full z-50 mb-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg ${
                  isCollapsed ? 'left-full ml-2' : 'left-2 right-2'
                }`}
              >
                {!isCollapsed && (
                  <div className="border-b border-gray-100 px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{user.full_name}</p>
                    <p className="truncate text-xs text-gray-500">{user.email}</p>
                  </div>
                )}

                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
                    {t('sidebar.user.language')}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setLanguage('en')}
                      className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                        language === 'en'
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {t('common.english')}
                    </button>
                    <button
                      onClick={() => setLanguage('vi')}
                      className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                        language === 'vi'
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {t('common.vietnamese')}
                    </button>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setShowGuide(true);
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center space-x-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <HelpCircle className="h-4 w-4 text-gray-400" />
                  <span>{language === 'vi' ? 'Hướng dẫn sử dụng' : 'Getting started guide'}</span>
                </button>
                <button
                  onClick={() => {
                    setShowChangePassword(true);
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center space-x-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <KeyRound className="h-4 w-4 text-gray-400" />
                  <span>{t('sidebar.user.changePassword')}</span>
                </button>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center space-x-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>{t('sidebar.user.signOut')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="p-4">
          <button
            onClick={onToggleCollapse}
            className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
            title={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            {isCollapsed ? (
              <ChevronRight className="h-5 w-5" />
            ) : (
              <>
                <ChevronLeft className="mr-2 h-5 w-5" />
                <span className="text-sm">{t('sidebar.collapse')}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      <GettingStartedModal open={showGuide} onClose={() => setShowGuide(false)} locale={language} />
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
  const { t } = useI18n();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError(t('password.error.mismatch'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('password.error.length'));
      return;
    }
    setLoading(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setError(err?.response?.data?.detail || t('password.error.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">{t('password.title')}</h2>

        {success ? (
          <p className="text-sm text-green-600">{t('password.success')}</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            )}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('password.current')}</label>
              <input
                type="password"
                required
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('password.new')}</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('password.confirm')}</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {loading ? t('common.loading') : t('password.submit')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
