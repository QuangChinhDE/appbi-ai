'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Factory,
  Loader2,
  LogIn,
  LogOut,
} from 'lucide-react';

import {
  workspaceApi,
  WorkspaceMeta,
  WorkspaceMenuResponse,
} from '@/lib/api/workspace';
import {
  themeVars,
  backgroundStyle,
  darkModeCss,
  resolveMode,
  type WbTheme,
} from '@/lib/wb-theme';

// Map menu icon strings to lucide components. Falling back to ClipboardList
// keeps the cards looking consistent for icons we don't bundle yet.
const ICONS: Record<string, React.ElementType> = {
  ClipboardList,
  BarChart3,
  AlertTriangle,
  CheckCircle2,
  Factory,
};

function pickIcon(name?: string | null) {
  if (name && ICONS[name]) return ICONS[name];
  return ClipboardList;
}

export default function WorkspacePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = String(params.token || '');

  const [loadingMeta, setLoadingMeta] = useState(true);
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  const [menu, setMenu] = useState<WorkspaceMenuResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Login form state
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let redirecting = false;
    (async () => {
      try {
        // 1. Try menu first — if cookie is valid, we skip login entirely.
        const m = await workspaceApi.getMenu(token);
        if (!alive) return;
        // Single mini-app workspace → the one-card launcher is pointless;
        // drop the user straight into the app. Keep the spinner up (don't
        // setMenu / clear loading) so the launcher never flashes.
        if (m.menu.length === 1) {
          redirecting = true;
          router.replace(`/ws/${token}/workboards/${m.menu[0].workboard_id}`);
          return;
        }
        setMenu(m);
        setMeta(m.workspace);
      } catch (err: any) {
        // 401 = need login; load workspace meta to show branding.
        try {
          const r = await workspaceApi.getMeta(token);
          if (!alive) return;
          setMeta(r.workspace);
        } catch (innerErr: any) {
          if (!alive) return;
          setError(
            innerErr?.response?.data?.detail ||
              'Không tìm thấy workspace hoặc liên kết đã bị thu hồi.',
          );
        }
      } finally {
        if (alive && !redirecting) setLoadingMeta(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, router]);

  const branding = meta?.branding ?? null;
  const accent = branding?.primary_color || '#2563eb';
  const theme = (branding ?? {}) as WbTheme;
  const mode = resolveMode(theme.theme);
  const loginBg = theme.login?.background || theme.background;
  const portalRootStyle = {
    ...themeVars(theme, mode),
    ...backgroundStyle(loginBg, '#f1f5f9'),
  };

  if (loadingMeta) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-7 w-7 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
          <h1 className="text-base font-semibold text-rose-600">Không thể mở workspace</h1>
          <p className="mt-2 text-sm text-slate-700">{error}</p>
        </div>
      </div>
    );
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!username.trim() || !pin) {
      setLoginError('Vui lòng nhập username và PIN.');
      return;
    }
    setSubmitting(true);
    try {
      await workspaceApi.login(token, username.trim(), pin);
      const m = await workspaceApi.getMenu(token);
      setUsername('');
      setPin('');
      // Single mini-app → go straight in instead of showing a 1-card menu.
      if (m.menu.length === 1) {
        router.replace(`/ws/${token}/workboards/${m.menu[0].workboard_id}`);
        return;
      }
      setMenu(m);
      setMeta(m.workspace);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setLoginError(typeof detail === 'string' ? detail : 'Đăng nhập thất bại.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await workspaceApi.logout(token);
    } finally {
      setMenu(null);
    }
  };

  // ── Login screen ────────────────────────────────────────────────────
  if (!menu) {
    return (
      <div
        className="wb-app flex min-h-screen items-center justify-center p-6"
        data-theme={mode}
        style={portalRootStyle}
      >
        <style>{darkModeCss()}</style>
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
          {theme.login?.tagline && (
            <p className="mb-4 text-center text-sm font-medium" style={{ color: accent }}>
              {theme.login.tagline}
            </p>
          )}
          <div className="mb-6 flex items-center gap-3">
            {branding?.logo_url ? (
              <img
                src={branding.logo_url}
                alt="logo"
                className="h-10 w-10 rounded-lg object-contain"
              />
            ) : (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg text-white"
                style={{ backgroundColor: accent }}
              >
                <Factory className="h-5 w-5" />
              </div>
            )}
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                {branding?.app_name || meta?.name || 'Workspace'}
              </h1>
              {meta?.description && (
                <p className="text-xs text-slate-500">{meta.description}</p>
              )}
            </div>
          </div>

          {branding?.welcome_text && (
            <p className="mb-5 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {branding.welcome_text}
            </p>
          )}

          <form onSubmit={handleLogin} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Tên đăng nhập
              </span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
                autoFocus
                autoComplete="username"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                placeholder="VD: w001"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">PIN</span>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                disabled={submitting}
                inputMode="numeric"
                autoComplete="current-password"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                placeholder="PIN của bạn"
              />
            </label>

            {loginError && (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {loginError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              {submitting ? 'Đang xử lý…' : 'Đăng nhập'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Menu screen ────────────────────────────────────────────────────
  return (
    <div
      className="wb-app min-h-screen bg-slate-50"
      data-theme={mode}
      style={{ ...themeVars(theme, mode), ...backgroundStyle(theme.background, 'var(--wb-bg)') }}
    >
      <style>{darkModeCss()}</style>
      <header
        className="border-b border-slate-200 bg-white"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg text-white"
              style={{ backgroundColor: accent }}
            >
              <Factory className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-900">
                {meta?.branding?.app_name || meta?.name}
              </h1>
              <p className="text-xs text-slate-500">
                {menu.app_user.full_name || menu.app_user.username}
                {menu.app_user.role ? ` • ${menu.app_user.role}` : ''}
                {(menu.app_user.context as Record<string, unknown> | undefined)?.team_id
                  ? ` • Tổ ${
                      (menu.app_user.context as Record<string, unknown>)?.team_id
                    }`
                  : ''}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <h2 className="mb-1 text-sm font-medium text-slate-500">Công việc của bạn</h2>
        <p className="mb-6 text-xs text-slate-400">
          Chọn một thẻ bên dưới để bắt đầu.
        </p>

        {menu.menu.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
            Hiện chưa có công việc nào được phân cho bạn.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {menu.menu.map((item) => {
              const Icon = pickIcon(item.icon);
              return (
                <button
                  key={item.workboard_id}
                  onClick={() =>
                    router.push(`/ws/${token}/workboards/${item.workboard_id}`)
                  }
                  className="group flex flex-col items-start gap-3 rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${accent}15`, color: accent }}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-slate-900">{item.label}</h3>
                    {item.description && (
                      <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
