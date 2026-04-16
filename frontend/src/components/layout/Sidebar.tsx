'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  LayoutDashboard,
  Search,
  BarChart3,
  Database,
  Plug,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
  LogOut,
  KeyRound,
  Shield,
  Bot,
  HelpCircle,
  FileText,
  Info,
  Trash2,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/use-current-user';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { authApi } from '@/lib/api-client';
import { useNotifications, type AppNotification, type AppNotificationLevel } from '@/lib/notifications';
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
  { labelKey: 'sidebar.nav.templates', href: '/templates', icon: <FileText className="h-5 w-5" />, module: 'report_templates' },
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
  const [showNotifications, setShowNotifications] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { language, setLanguage, t } = useI18n();
  const { data: user } = useCurrentUser();
  const { data: permData } = usePermissions();
  const {
    notifications,
    unreadCount,
    markAllNotificationsRead,
    clearNotifications,
  } = useNotifications();

  useEffect(() => {
    if (showNotifications && unreadCount > 0) {
      markAllNotificationsRead();
    }
  }, [markAllNotificationsRead, showNotifications, unreadCount]);

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
              className={`relative w-full px-4 py-3 transition-colors hover:bg-gray-50 ${
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
              {unreadCount > 0 && (
                <span className={`absolute flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold text-white ${
                  isCollapsed ? 'right-1 top-2' : 'right-3 top-3'
                }`}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {showUserMenu && (
              <div
                className={`absolute bottom-full z-50 mb-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg ${
                  isCollapsed ? 'left-full ml-2' : 'left-2 right-2'
                }`}
              >
                <button
                  onClick={() => {
                    setShowNotifications(true);
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center space-x-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <div className="relative">
                    <Bell className="h-4 w-4 text-gray-400" />
                    {unreadCount > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </div>
                  <span>{language === 'vi' ? 'Thông báo' : 'Notifications'}</span>
                </button>
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
                {user.has_password && user.auth_provider === 'password' ? (
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
                ) : (
                  <div className="px-4 py-2.5 text-sm text-gray-500">
                    {language === 'vi' ? 'Tài khoản này dùng đăng nhập Google.' : 'This account signs in with Google.'}
                  </div>
                )}
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

      {showChangePassword && user?.has_password && user.auth_provider === 'password' && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
      <GettingStartedModal open={showGuide} onClose={() => setShowGuide(false)} locale={language} />
      <NotificationsModal
        open={showNotifications}
        onClose={() => setShowNotifications(false)}
        notifications={notifications}
        unreadCount={unreadCount}
        onMarkAllRead={markAllNotificationsRead}
        onClearAll={clearNotifications}
        language={language}
      />
    </div>
  );
}

function NotificationsModal({
  open,
  onClose,
  notifications,
  unreadCount,
  onMarkAllRead,
  onClearAll,
  language,
}: {
  open: boolean;
  onClose: () => void;
  notifications: AppNotification[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  language: 'en' | 'vi';
}) {
  if (!open) {
    return null;
  }

  const title = language === 'vi' ? 'Thông báo' : 'Notifications';
  const description = language === 'vi'
    ? 'Mọi thông báo trong app sẽ được lưu lại ở đây.'
    : 'All app notifications are collected here.';
  const emptyTitle = language === 'vi' ? 'Chưa có thông báo nào' : 'No notifications yet';
  const emptyDescription = language === 'vi'
    ? 'Khi bạn lưu, cập nhật, xóa hoặc chia sẻ, thông báo sẽ xuất hiện ở đây.'
    : 'Save, update, delete, and share events will appear here.';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="relative rounded-full bg-blue-50 p-2 text-blue-600">
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold text-white">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
                <p className="text-sm text-gray-500">{description}</p>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label={language === 'vi' ? 'Đóng thông báo' : 'Close notifications'}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-5 py-3">
          <p className="text-sm text-gray-600">
            {language === 'vi'
              ? `${notifications.length} thông báo${unreadCount > 0 ? `, ${unreadCount} chưa đọc` : ''}`
              : `${notifications.length} notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onMarkAllRead}
              disabled={unreadCount === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCheck className="h-4 w-4" />
              <span>{language === 'vi' ? 'Đọc hết' : 'Mark all read'}</span>
            </button>
            <button
              onClick={onClearAll}
              disabled={notifications.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              <span>{language === 'vi' ? 'Xóa hết' : 'Clear all'}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50 px-5 py-4">
          {notifications.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white px-6 text-center">
              <Bell className="mb-4 h-10 w-10 text-gray-300" />
              <p className="text-base font-semibold text-gray-700">{emptyTitle}</p>
              <p className="mt-2 max-w-sm text-sm text-gray-500">{emptyDescription}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {notifications.map((notification) => {
                const { badgeClassName, icon, iconClassName } = getNotificationAppearance(notification.level);

                return (
                  <div
                    key={notification.id}
                    className={`rounded-2xl border bg-white p-4 shadow-sm transition-colors ${
                      notification.read ? 'border-gray-200' : 'border-blue-200 ring-1 ring-blue-100'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`rounded-xl p-2 ${badgeClassName}`}>
                        {React.cloneElement(icon, { className: iconClassName })}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{notification.title}</p>
                            {notification.description && (
                              <p className="mt-1 text-sm text-gray-600">{notification.description}</p>
                            )}
                          </div>
                          {!notification.read && (
                            <span className="mt-1 h-2.5 w-2.5 rounded-full bg-blue-500" aria-hidden="true" />
                          )}
                        </div>
                        <p className="mt-3 text-xs font-medium uppercase tracking-[0.14em] text-gray-400">
                          {formatNotificationTimestamp(notification.createdAt, language)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getNotificationAppearance(level: AppNotificationLevel): {
  badgeClassName: string;
  icon: React.ReactElement;
  iconClassName: string;
} {
  switch (level) {
    case 'success':
      return {
        badgeClassName: 'bg-emerald-50',
        icon: <CheckCircle2 />,
        iconClassName: 'h-5 w-5 text-emerald-600',
      };
    case 'warning':
      return {
        badgeClassName: 'bg-amber-50',
        icon: <AlertTriangle />,
        iconClassName: 'h-5 w-5 text-amber-600',
      };
    case 'error':
      return {
        badgeClassName: 'bg-red-50',
        icon: <AlertCircle />,
        iconClassName: 'h-5 w-5 text-red-600',
      };
    default:
      return {
        badgeClassName: 'bg-sky-50',
        icon: <Info />,
        iconClassName: 'h-5 w-5 text-sky-600',
      };
  }
}

function formatNotificationTimestamp(createdAt: string, language: 'en' | 'vi') {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return language === 'vi' ? 'Không rõ thời gian' : 'Unknown time';
  }

  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
