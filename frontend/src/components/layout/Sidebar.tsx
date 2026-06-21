'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  LayoutDashboard,
  Search,
  BarChart3,
  ClipboardList,
  Database,
  Plug,
  Home,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  LogOut,
  KeyRound,
  Shield,
  HelpCircle,
  Info,
  Trash2,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { cn } from '@/lib/utils';
import { useCurrentUser } from '@/hooks/use-current-user';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { authApi } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-errors';
import { useNotifications, type AppNotification, type AppNotificationLevel } from '@/lib/notifications';
import { useI18n } from '@/providers/LanguageProvider';
import { useUserLanguage } from '@/hooks/use-user-language';
import { GettingStartedModal } from '@/components/common/GettingStartedGuide';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';

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
  { labelKey: 'sidebar.nav.overview', href: '/overview', icon: <Home className="h-4 w-4" /> },
  { labelKey: 'sidebar.nav.datasources', href: '/datasources', icon: <Plug className="h-4 w-4" />, module: 'data_sources' },
  { labelKey: 'sidebar.nav.datasets', href: '/datasets', icon: <Database className="h-4 w-4" />, module: 'datasets' },
  { labelKey: 'sidebar.nav.explore', href: '/explore', icon: <Search className="h-4 w-4" />, module: 'explore_charts' },
  { labelKey: 'sidebar.nav.dashboards', href: '/dashboards', icon: <LayoutDashboard className="h-4 w-4" />, module: 'dashboards' },
  { labelKey: 'sidebar.nav.workboards', href: '/workboards', icon: <ClipboardList className="h-4 w-4" />, module: 'workboards' },
  { labelKey: 'sidebar.nav.settings', href: '/permissions', icon: <Shield className="h-4 w-4" />, module: 'settings' },
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
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { language, setLanguage, t } = useUserLanguage();
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

  // Close the user menu (language / account popover) on outside click or Escape.
  useEffect(() => {
    if (!showUserMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setShowUserMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowUserMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showUserMenu]);

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
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 flex h-screen flex-col',
        'border-r border-[rgb(var(--border-line))] bg-surface-1',
        'transition-[width] duration-300',
        isCollapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center px-3">
        {!isCollapsed ? (
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-text-inverse">
              <BarChart3 className="h-3.5 w-3.5" />
            </div>
            <span className="text-small font-strong tracking-[-0.011em] text-text-primary">
              AppBI
            </span>
          </Link>
        ) : (
          <Link
            href="/"
            className="mx-auto flex h-8 w-8 items-center justify-center rounded-md bg-brand text-text-inverse"
          >
            <BarChart3 className="h-4 w-4" />
          </Link>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        <ul className="space-y-0.5">
          {visibleItems.map((item) => {
            const active = isActive(item.href);
            const label = t(item.labelKey);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    'group flex items-center rounded-md transition-colors',
                    isCollapsed ? 'h-8 w-8 mx-auto justify-center' : 'h-8 px-2.5 gap-2',
                    active
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary',
                  )}
                  title={isCollapsed ? label : undefined}
                >
                  <span className={cn('flex-shrink-0', active ? 'text-brand' : 'text-text-tertiary group-hover:text-text-secondary')}>
                    {item.icon}
                  </span>
                  {!isCollapsed && (
                    <span className="text-caption font-emphasis truncate">{label}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Bottom: user + collapse */}
      <div className="border-t border-[rgb(var(--border-line))]">
        {user && (
          <div ref={userMenuRef} className="relative px-2 pt-2">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className={cn(
                'relative w-full rounded-md transition-colors hover:bg-surface-2',
                isCollapsed ? 'flex justify-center py-2' : 'flex items-center gap-2 px-2 py-1.5',
              )}
              title={isCollapsed ? user.full_name : undefined}
            >
              <div className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand text-tiny font-strong text-text-inverse">
                {getInitials(user.full_name || user.email)}
                {unreadCount > 0 && isCollapsed && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-danger px-1 text-[9px] font-strong text-text-inverse">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </div>
              {!isCollapsed && (
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-caption font-emphasis text-text-primary">{user.full_name}</p>
                  <p className="truncate text-tiny text-text-quaternary">{user.email}</p>
                </div>
              )}
              {!isCollapsed && unreadCount > 0 && (
                <span className="ml-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-strong text-text-inverse">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {showUserMenu && (
              <div
                className={cn(
                  'absolute bottom-full z-50 mb-1 overflow-hidden rounded-lg',
                  'border border-[rgb(var(--border-strong))] bg-surface-1 shadow-popover',
                  isCollapsed ? 'left-full ml-2 w-60' : 'left-2 right-2',
                )}
              >
                {!isCollapsed && (
                  <div className="border-b border-[rgb(var(--border-line))] px-3 py-2.5">
                    <p className="text-caption font-emphasis text-text-primary truncate">{user.full_name}</p>
                    <p className="text-tiny text-text-tertiary truncate">{user.email}</p>
                  </div>
                )}

                <button
                  onClick={() => {
                    setShowNotifications(true);
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-caption text-text-secondary hover:bg-surface-2"
                >
                  <div className="relative">
                    <Bell className="h-3.5 w-3.5 text-text-tertiary" />
                    {unreadCount > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-3 min-w-[0.75rem] items-center justify-center rounded-full bg-danger px-0.5 text-[9px] font-strong text-text-inverse">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </div>
                  <span>{language === 'vi' ? 'Thông báo' : 'Notifications'}</span>
                </button>

                <div className="border-t border-[rgb(var(--border-line))] px-3 py-2.5">
                  <p className="text-tiny uppercase tracking-[0.14em] text-text-quaternary font-emphasis">
                    {t('sidebar.user.language')}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => setLanguage('en')}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-tiny font-emphasis transition-colors',
                        language === 'en'
                          ? 'border-brand bg-brand/8 text-brand'
                          : 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary hover:bg-surface-2',
                      )}
                    >
                      {t('common.english')}
                    </button>
                    <button
                      onClick={() => setLanguage('vi')}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-tiny font-emphasis transition-colors',
                        language === 'vi'
                          ? 'border-brand bg-brand/8 text-brand'
                          : 'border-[rgb(var(--border-strong))] bg-surface-1 text-text-secondary hover:bg-surface-2',
                      )}
                    >
                      {t('common.vietnamese')}
                    </button>
                  </div>
                </div>

                <button
                  onClick={() => {
                    router.push('/account/tokens');
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2 text-caption text-text-secondary hover:bg-surface-2"
                >
                  <KeyRound className="h-3.5 w-3.5 text-text-tertiary" />
                  <span>{language === 'vi' ? 'Token API' : 'API tokens'}</span>
                </button>
                <button
                  onClick={() => {
                    setShowGuide(true);
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2 text-caption text-text-secondary hover:bg-surface-2"
                >
                  <HelpCircle className="h-3.5 w-3.5 text-text-tertiary" />
                  <span>{language === 'vi' ? 'Hướng dẫn sử dụng' : 'Getting started guide'}</span>
                </button>
                {user.has_password && user.auth_provider === 'password' ? (
                  <button
                    onClick={() => {
                      setShowChangePassword(true);
                      setShowUserMenu(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-caption text-text-secondary hover:bg-surface-2"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-text-tertiary" />
                    <span>{t('sidebar.user.changePassword')}</span>
                  </button>
                ) : (
                  <div className="px-3 py-2 text-caption text-text-tertiary">
                    {language === 'vi' ? 'Tài khoản này dùng đăng nhập Google.' : 'This account signs in with Google.'}
                  </div>
                )}
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 border-t border-[rgb(var(--border-line))] px-3 py-2 text-caption text-danger hover:bg-danger/8"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>{t('sidebar.user.signOut')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="p-2">
          <button
            onClick={onToggleCollapse}
            className={cn(
              'flex w-full items-center justify-center rounded-md h-7',
              'text-text-tertiary hover:bg-surface-2 hover:text-text-primary transition-colors',
            )}
            title={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-tiny font-emphasis">
                <ChevronLeft className="h-3.5 w-3.5" />
                {t('sidebar.collapse')}
              </span>
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
    </aside>
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
  if (!open) return null;

  const title = language === 'vi' ? 'Thông báo' : 'Notifications';
  const description = language === 'vi'
    ? 'Mọi thông báo trong app sẽ được lưu lại ở đây.'
    : 'All app notifications are collected here.';
  const emptyTitle = language === 'vi' ? 'Chưa có thông báo nào' : 'No notifications yet';
  const emptyDescription = language === 'vi'
    ? 'Khi bạn lưu, cập nhật, xóa hoặc chia sẻ, thông báo sẽ xuất hiện ở đây.'
    : 'Save, update, delete, and share events will appear here.';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] px-4 animate-fade-in">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg animate-slide-up">
        <div className="flex items-start justify-between gap-3 border-b border-[rgb(var(--border-line))] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="relative rounded-lg bg-brand/10 p-2 text-brand">
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-strong text-text-inverse">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </div>
            <div>
              <h2 className="text-small font-strong text-text-primary">{title}</h2>
              <p className="text-caption text-text-tertiary">{description}</p>
            </div>
          </div>
          <IconButton
            aria-label={language === 'vi' ? 'Đóng thông báo' : 'Close notifications'}
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] bg-surface-2 px-5 py-2.5">
          <p className="text-caption text-text-secondary">
            {language === 'vi'
              ? `${notifications.length} thông báo${unreadCount > 0 ? `, ${unreadCount} chưa đọc` : ''}`
              : `${notifications.length} notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="secondary"
              onClick={onMarkAllRead}
              disabled={unreadCount === 0}
              leadingIcon={<CheckCheck className="h-3 w-3" />}
            >
              {language === 'vi' ? 'Đọc hết' : 'Mark all read'}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={onClearAll}
              disabled={notifications.length === 0}
              leadingIcon={<Trash2 className="h-3 w-3" />}
              className="text-danger hover:text-danger hover:bg-danger/8"
            >
              {language === 'vi' ? 'Xóa hết' : 'Clear all'}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-surface-0 px-4 py-4">
          {notifications.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 text-center">
              <Bell className="mb-3 h-8 w-8 text-text-quaternary" />
              <p className="text-small font-strong text-text-primary">{emptyTitle}</p>
              <p className="mt-1 max-w-sm text-caption text-text-tertiary">{emptyDescription}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.map((notification) => {
                const { badgeClassName, icon, iconClassName } = getNotificationAppearance(notification.level);

                return (
                  <div
                    key={notification.id}
                    className={cn(
                      'rounded-lg border bg-surface-1 p-3 transition-colors',
                      notification.read
                        ? 'border-[rgb(var(--border-line))]'
                        : 'border-brand/30 shadow-linear-sm',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className={cn('rounded-md p-1.5', badgeClassName)}>
                        {React.cloneElement(icon, { className: iconClassName })}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-caption font-emphasis text-text-primary">{notification.title}</p>
                            {notification.description && (
                              <p className="mt-0.5 text-caption text-text-secondary">{notification.description}</p>
                            )}
                          </div>
                          {!notification.read && (
                            <span className="mt-1 h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
                          )}
                        </div>
                        <p className="mt-2 text-tiny font-emphasis uppercase tracking-[0.14em] text-text-quaternary">
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
        badgeClassName: 'bg-success/10',
        icon: <CheckCircle2 />,
        iconClassName: 'h-3.5 w-3.5 text-success',
      };
    case 'warning':
      return {
        badgeClassName: 'bg-warning/10',
        icon: <AlertTriangle />,
        iconClassName: 'h-3.5 w-3.5 text-warning',
      };
    case 'error':
      return {
        badgeClassName: 'bg-danger/10',
        icon: <AlertCircle />,
        iconClassName: 'h-3.5 w-3.5 text-danger',
      };
    default:
      return {
        badgeClassName: 'bg-info/10',
        icon: <Info />,
        iconClassName: 'h-3.5 w-3.5 text-info',
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
    } catch (err: unknown) {
      setError(extractApiError(err, t('password.error.failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] animate-fade-in">
      <div className="mx-4 w-full max-w-sm rounded-xl bg-surface-1 border border-[rgb(var(--border-strong))] shadow-linear-lg p-5 animate-slide-up">
        <h2 className="mb-4 text-small font-strong text-text-primary">{t('password.title')}</h2>

        {success ? (
          <p className="text-caption text-success">{t('password.success')}</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && (
              <p className="rounded-md border border-danger/30 bg-danger/8 px-2.5 py-1.5 text-caption text-danger">
                {error}
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>{t('password.current')}</Label>
              <Input
                type="password"
                required
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('password.new')}</Label>
              <Input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('password.confirm')}</Label>
              <Input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={loading} loading={loading}>
                {loading ? t('common.loading') : t('password.submit')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
