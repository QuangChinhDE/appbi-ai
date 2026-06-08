/**
 * Public mini-app runtime — adaptive shell.
 *
 * Renders a single workboard as a self-contained mini-app:
 *  - top header with branding + logged-in user
 *  - adaptive nav: bottom-nav on mobile, top-tabs on tablet, sidebar on
 *    desktop — auto-detected from the viewport (no manual device toggle in
 *    the published runtime; the builder's live-preview pane has its own)
 *  - active screen content rendered from the per-screen API
 *  - shared_context propagated through ``after_submit.go_to_screen`` so
 *    successive screens know which shift / row the user is working with
 */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Download,
  Factory,
  Loader2,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import {
  AppShellResponse,
  AppShellScreenStub,
  DashboardScreenResponse,
  DocScreenResponse,
  FormScreenResponse,
  ScreenResponse,
  TableRowDetailResponse,
  TableScreenResponse,
  workspaceApi,
} from '@/lib/api/workspace';
import {
  getPublicSession,
  publicDashboardApi,
  savePublicSession,
} from '@/lib/api/public';
import { evaluateTruthy } from '@/lib/wb-expr';

// Icon mapping is centralised in ScreenIconRegistry so the builder
// picker and the runtime can't drift. Anything not in the registry
// falls back to ClipboardList — the same default the legacy code used.
import { SCREEN_ICON_MAP } from '@/components/workboards/builder/ScreenIconRegistry';

function pickIcon(name?: string | null): React.ElementType {
  if (name && SCREEN_ICON_MAP[name]) return SCREEN_ICON_MAP[name];
  return ClipboardList;
}

type DeviceMode = 'mobile' | 'tablet' | 'desktop';

interface ApiErrorLike {
  response?: {
    status?: number;
    data?: {
      detail?: unknown;
    };
  };
}

interface RuntimeFormPage {
  id: number;
  title: string;
  description?: string;
  show_if?: unknown;
}

interface RuntimeEvalCtx {
  row: Record<string, unknown>;
  app_user: Record<string, unknown>;
  shared: Record<string, unknown>;
}

interface RuntimeField extends Record<string, unknown> {
  column?: unknown;
  widget?: unknown;
  label?: unknown;
  help_text?: unknown;
  placeholder?: unknown;
  required?: unknown;
  readonly?: unknown;
  default?: unknown;
  page?: unknown;
  section?: unknown;
  show_if?: unknown;
  required_if?: unknown;
  readonly_if?: unknown;
  valid_if?: unknown;
  valid_if_error?: unknown;
  computed_from_dataset?: unknown;
  max_file_kb?: unknown;
  lookup?: Record<string, unknown>;
}

interface RuntimeFormSpecExtras {
  pages?: RuntimeFormPage[];
  sections?: string[];
}

function detectDevice(): DeviceMode {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < 768) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

export default function WorkspaceWorkboardPage() {
  const router = useRouter();
  const params = useParams<{ token: string; wbid: string }>();
  const token = String(params.token || '');
  const workboardId = Number(params.wbid);

  const [shell, setShell] = useState<AppShellResponse | null>(null);
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null);
  const [shared, setShared] = useState<Record<string, unknown>>({});
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [error, setError] = useState<string | null>(null);
  // How many mini-apps this app-user can reach in the workspace. Drives
  // whether the "back to workspace menu" button is worth showing — for a
  // single-app workspace the launcher is pointless, so we hide it.
  const [siblingApps, setSiblingApps] = useState<number | null>(null);

  // Detect device + listen for resize. Listening to plain ``resize`` is
  // necessary because we want the layout to flip the moment the user
  // crosses the 768px or 1024px breakpoints — not just at one of them.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setDevice(detectDevice());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Layout adapts purely from the real viewport — see detectDevice() + the
  // resize listener above. No manual override in the published runtime.
  const effectiveDevice: DeviceMode = device;

  // Initial shell load. When the URL hash carries a screen id (the
  // builder uses #screen=xxx to jump to whatever the admin is editing),
  // honour it instead of the nav default.
  useEffect(() => {
    if (!token || !workboardId) return;
    let alive = true;
    (async () => {
      try {
        const s = await workspaceApi.getAppShell(token, workboardId);
        if (!alive) return;
        setShell(s);
        // Find out if there are sibling mini-apps in this workspace, to
        // decide whether the "back to menu" button is meaningful.
        workspaceApi
          .getMenu(token)
          .then((m) => {
            if (alive) setSiblingApps(m.menu.length);
          })
          .catch(() => {
            if (alive) setSiblingApps(1);
          });
        const hashScreen = (() => {
          if (typeof window === 'undefined') return null;
          const m = window.location.hash.match(/screen=([\w-]+)/);
          return m ? m[1] : null;
        })();
        if (hashScreen && s.screens.some((sc) => sc.id === hashScreen)) {
          setActiveScreenId(hashScreen);
        } else if (s.nav.items.length > 0) {
          setActiveScreenId(s.nav.items[0]);
        } else if (s.screens.length > 0) {
          setActiveScreenId(s.screens[0].id);
        }
      } catch (err: unknown) {
        if (!alive) return;
        const apiError = err as ApiErrorLike;
        if (apiError.response?.status === 401) {
          router.push(`/ws/${token}`);
          return;
        }
        setError(
          typeof apiError.response?.data?.detail === 'string'
            ? apiError.response.data.detail
            : 'Không tải được mini-app.',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, workboardId, router]);

  const navItems: AppShellScreenStub[] = useMemo(() => {
    if (!shell) return [];
    const byId = new Map(shell.screens.map((s) => [s.id, s]));
    return shell.nav.items
      .map((id) => byId.get(id))
      .filter((s): s is AppShellScreenStub => Boolean(s));
  }, [shell]);

  const goToScreen = useCallback(
    (screenId: string, carry?: Record<string, unknown>) => {
      if (carry && Object.keys(carry).length > 0) {
        setShared((curr) => ({ ...curr, ...carry }));
      }
      setActiveScreenId(screenId);
    },
    [],
  );

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
          <h1 className="text-base font-semibold text-rose-600">Lỗi</h1>
          <p className="mt-2 text-sm text-slate-700">{error}</p>
          <button
            onClick={() => router.push(`/ws/${token}`)}
            className="mt-4 text-sm text-blue-600 hover:underline"
          >
            ← Quay lại menu
          </button>
        </div>
      </div>
    );
  }

  if (!shell) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-7 w-7 animate-spin text-slate-400" />
      </div>
    );
  }

  const accent = shell.branding.primary_color || '#2563eb';
  const appName = shell.branding.app_name || shell.workboard.name;

  // ── Layout decision per device size ──────────────────────────────────
  // Mobile  → bottom_nav OR drawer (per nav.mobile_kind)
  // Tablet  → top_tabs (better for landscape, no big sidebar wasted)
  // Desktop → whatever the workboard config picked (sidebar | top_tabs)
  const isSidebar = effectiveDevice === 'desktop' && shell.nav.desktop_kind === 'sidebar';
  const isTopTabs =
    (effectiveDevice === 'desktop' && shell.nav.desktop_kind === 'top_tabs') ||
    effectiveDevice === 'tablet';
  const isDrawer = effectiveDevice === 'mobile' && shell.nav.mobile_kind === 'drawer';
  const isBottomNav = effectiveDevice === 'mobile' && !isDrawer;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <Header
        appName={appName}
        accent={accent}
        logoUrl={shell.branding.logo_url}
        showBackToMenu={(siblingApps ?? 1) > 1}
        onLogout={async () => {
          try {
            await workspaceApi.logout(token);
          } finally {
            router.push(`/ws/${token}`);
          }
        }}
        onBackToMenu={() => router.push(`/ws/${token}`)}
      />

      {isTopTabs && (
        <TopTabs
          items={navItems}
          activeId={activeScreenId}
          onSelect={(id) => goToScreen(id)}
          accent={accent}
        />
      )}

      <div className="flex flex-1">
        {isSidebar && (
          <Sidebar
            items={navItems}
            activeId={activeScreenId}
            onSelect={(id) => goToScreen(id)}
            accent={accent}
          />
        )}
        <main
          className={`flex-1 ${isBottomNav ? 'pb-20' : 'pb-6'} px-4 pt-4 sm:px-6`}
        >
          {activeScreenId ? (
            <ScreenContainer
              key={`${activeScreenId}-${JSON.stringify(shared)}`}
              token={token}
              workboardId={workboardId}
              screenId={activeScreenId}
              shared={shared}
              accent={accent}
              viewerRole={shell?.viewer?.role ?? null}
              onNavigate={goToScreen}
            />
          ) : (
            <div className="rounded-xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm">
              Chưa có màn hình nào hiển thị cho tài khoản của bạn.
            </div>
          )}
        </main>
      </div>

      {isBottomNav && (
        <BottomNav
          items={navItems}
          activeId={activeScreenId}
          onSelect={(id) => goToScreen(id)}
          accent={accent}
        />
      )}

      {isDrawer && (
        <MobileDrawer
          items={navItems}
          activeId={activeScreenId}
          onSelect={(id) => goToScreen(id)}
          accent={accent}
        />
      )}
    </div>
  );
}

// ── Mobile drawer nav (hamburger → slide-in panel) ──────────────────────────

function MobileDrawer({
  items,
  activeId,
  onSelect,
  accent,
}: {
  items: Array<{ id: string; title: string; icon?: string | null }>;
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  const [open, setOpen] = useState(false);
  const active = items.find((s) => s.id === activeId);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
        style={{ backgroundColor: accent }}
        aria-label="Mở menu"
      >
        <Menu className="h-5 w-5" />
        <span className="max-w-[140px] truncate">{active?.title || 'Menu'}</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <nav className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col gap-1 overflow-y-auto bg-white p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-semibold text-slate-700">Màn hình</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
                aria-label="Đóng menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {items.map((s) => (
              <NavBtn
                key={s.id}
                active={s.id === activeId}
                accent={accent}
                onClick={() => {
                  onSelect(s.id);
                  setOpen(false);
                }}
                icon={pickIcon(s.icon)}
                label={s.title}
                layout="sidebar"
              />
            ))}
          </nav>
        </div>
      )}
    </>
  );
}

// ── Header ────────────────────────────────────────────────────────────────

function Header({
  appName,
  accent,
  logoUrl,
  showBackToMenu = false,
  onLogout,
  onBackToMenu,
}: {
  appName: string;
  accent: string;
  logoUrl?: string | null;
  showBackToMenu?: boolean;
  onLogout: () => void;
  onBackToMenu: () => void;
}) {
  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        {showBackToMenu && (
          <button
            onClick={onBackToMenu}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
            title="Trở lại menu workspace"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
          style={{ backgroundColor: logoUrl ? 'transparent' : accent }}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <Factory className="h-4 w-4 text-white" />
          )}
        </div>
        <h1 className="flex-1 truncate text-base font-semibold text-slate-900">
          {appName}
        </h1>

        <button
          onClick={onLogout}
          className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Đăng xuất</span>
        </button>
      </div>
    </header>
  );
}

// ── Navigation primitives ─────────────────────────────────────────────────

function NavBtn({
  active,
  accent,
  onClick,
  icon: Icon,
  label,
  layout,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  layout: 'sidebar' | 'bottom' | 'top';
}) {
  if (layout === 'bottom') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex flex-col items-center justify-center gap-0.5 px-2 py-2"
        style={{ color: active ? accent : '#64748b' }}
      >
        <Icon className="h-5 w-5" />
        <span className="text-[11px] font-medium leading-tight">{label}</span>
      </button>
    );
  }
  if (layout === 'top') {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
          active ? 'text-slate-900' : 'border-transparent text-slate-600 hover:text-slate-900'
        }`}
        style={active ? { borderColor: accent, color: accent } : undefined}
      >
        <Icon className="h-4 w-4" />
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        active ? 'font-semibold' : 'text-slate-600 hover:bg-slate-100'
      }`}
      style={active ? { backgroundColor: `${accent}18`, color: accent } : undefined}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Sidebar({
  items,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-3 md:block">
      <div className="space-y-1">
        {items.map((s) => (
          <NavBtn
            key={s.id}
            active={s.id === activeId}
            accent={accent}
            onClick={() => onSelect(s.id)}
            icon={pickIcon(s.icon)}
            label={s.title}
            layout="sidebar"
          />
        ))}
      </div>
    </aside>
  );
}

function TopTabs({
  items,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
        {items.map((s) => (
          <NavBtn
            key={s.id}
            active={s.id === activeId}
            accent={accent}
            onClick={() => onSelect(s.id)}
            icon={pickIcon(s.icon)}
            label={s.title}
            layout="top"
          />
        ))}
      </nav>
    </div>
  );
}

function BottomNav({
  items,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  const [showMore, setShowMore] = useState(false);
  // Show at most 4 primary items + "More" button when there are > 5 items
  const MAX_VISIBLE = items.length > 5 ? 4 : 5;
  const visible = items.slice(0, MAX_VISIBLE);
  const overflow = items.slice(MAX_VISIBLE);
  const hasOverflow = overflow.length > 0;
  const overflowActive = overflow.some((s) => s.id === activeId);

  return (
    <>
      {/* More sheet overlay */}
      {showMore && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowMore(false)}
        >
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white pb-safe shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 mt-2 h-1 w-10 rounded-full bg-slate-200" />
            <div className="border-b border-slate-100 px-4 pb-2">
              <h3 className="text-sm font-semibold text-slate-700">Thêm menu</h3>
            </div>
            <div className="py-1">
              {overflow.map((s) => {
                const Icon = pickIcon(s.icon);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      onSelect(s.id);
                      setShowMore(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50"
                    style={{ color: s.id === activeId ? accent : '#374151' }}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className="font-medium">{s.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
        style={{ gridTemplateColumns: `repeat(${visible.length + (hasOverflow ? 1 : 0)}, 1fr)` }}
      >
        {visible.map((s) => (
          <NavBtn
            key={s.id}
            active={s.id === activeId}
            accent={accent}
            onClick={() => onSelect(s.id)}
            icon={pickIcon(s.icon)}
            label={s.title}
            layout="bottom"
          />
        ))}
        {hasOverflow && (
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="flex flex-col items-center justify-center gap-0.5 px-2 py-2"
            style={{ color: overflowActive || showMore ? accent : '#64748b' }}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[11px] font-medium leading-tight">Thêm</span>
          </button>
        )}
      </nav>
    </>
  );
}

// ── Screen container — fetches on screen change ───────────────────────────

function ScreenContainer({
  token,
  workboardId,
  screenId,
  shared,
  accent,
  viewerRole,
  onNavigate,
}: {
  token: string;
  workboardId: number;
  screenId: string;
  shared: Record<string, unknown>;
  accent: string;
  viewerRole?: string | null;
  onNavigate: (next: string, carry?: Record<string, unknown>) => void;
}) {
  const [data, setData] = useState<ScreenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        const r = await workspaceApi.getScreen(token, workboardId, screenId, shared);
        if (alive) setData(r);
      } catch {
        if (alive) setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // shared is included in the parent's `key` so we don't need it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, workboardId, screenId, reloadKey]);

  if (loading) {
    return <Loader2 className="mx-auto my-10 h-6 w-6 animate-spin text-slate-400" />;
  }
  if (!data) {
    return (
      <div className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
        Không tải được màn hình này.
      </div>
    );
  }
  if (data.kind === 'form') {
    return (
      <FormScreen
        spec={data}
        token={token}
        workboardId={workboardId}
        accent={accent}
        shared={shared}
        onSaved={(carry, nextScreen) => {
          if (nextScreen) onNavigate(nextScreen, carry);
          else setReloadKey((k) => k + 1);
        }}
      />
    );
  }
  if (data.kind === 'table') {
    return (
      <TableScreen
        spec={data}
        token={token}
        workboardId={workboardId}
        accent={accent}
        viewerRole={viewerRole}
        onAction={(action, row) => {
          if (action.go_to_screen) {
            const carry: Record<string, unknown> = {};
            for (const col of action.carry || []) {
              if (col in row) carry[col] = row[col];
            }
            onNavigate(action.go_to_screen, carry);
          }
        }}
      />
    );
  }
  if (data.kind === 'doc') {
    return <DocScreen spec={data} token={token} workboardId={workboardId} />;
  }
  if (data.kind === 'dashboard') {
    return <DashboardScreen spec={data} />;
  }
  return null;
}

// ── Dashboard screen ──────────────────────────────────────────────────────
// Embeds an AppBI Dashboard via its public share token. We render the existing
// /embed/{token} page in an iframe so password gates, viewer filters, chart
// loading, cross-filter, and PDF export all use the dashboard module's own
// runtime — no duplication.

function DashboardScreen({ spec }: { spec: DashboardScreenResponse }) {
  const { share_token: shareToken, password, height_px: heightPx } = spec.dashboard;
  const [iframeReady, setIframeReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [reportedHeight, setReportedHeight] = useState<number | null>(null);

  // If the public link is password-protected and the builder pre-filled the
  // password, exchange it for a session before mounting the iframe so the
  // mini-app user is never prompted. Plain links skip straight to mount.
  useEffect(() => {
    let alive = true;
    setIframeReady(false);
    setAuthError(null);
    (async () => {
      if (!shareToken) return;
      if (!password) {
        if (alive) setIframeReady(true);
        return;
      }
      if (getPublicSession(shareToken)) {
        if (alive) setIframeReady(true);
        return;
      }
      try {
        const { session_token, expires_in } = await publicDashboardApi.auth(
          shareToken,
          password,
        );
        savePublicSession(shareToken, session_token, expires_in);
        if (alive) setIframeReady(true);
      } catch {
        if (alive) {
          setAuthError('Không xác thực được dashboard. Có thể public link đã đổi password hoặc bị thu hồi.');
          setIframeReady(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [shareToken, password]);

  // The /embed page posts { type: 'appbi:resize', height } so we can grow the
  // iframe to fit its content. If the builder pinned a fixed height we ignore
  // these messages.
  useEffect(() => {
    if (heightPx) return;
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== 'appbi:resize') return;
      const next = Number((data as { height?: unknown }).height);
      if (Number.isFinite(next) && next > 0) {
        setReportedHeight(Math.max(240, Math.min(4000, Math.round(next))));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [heightPx]);

  if (!shareToken) {
    return (
      <div className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
        Màn hình Dashboard chưa được cấu hình share token.
      </div>
    );
  }
  if (!iframeReady) {
    return <Loader2 className="mx-auto my-10 h-6 w-6 animate-spin text-slate-400" />;
  }

  const iframeHeight = heightPx ?? reportedHeight ?? 600;

  return (
    <div className="space-y-2">
      {authError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-tiny text-amber-800">
          {authError}
        </div>
      )}
      <iframe
        src={`/embed/${shareToken}`}
        title={spec.title}
        className="w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        style={{ height: iframeHeight }}
      />
    </div>
  );
}

// ── Form screen ──────────────────────────────────────────────────────────

function FormScreen({
  spec,
  token,
  workboardId,
  accent,
  shared,
  onSaved,
}: {
  spec: FormScreenResponse;
  token: string;
  workboardId: number;
  accent: string;
  shared: Record<string, unknown>;
  onSaved: (carry: Record<string, unknown>, nextScreen?: string) => void;
}) {
  const buildInitial = useCallback(() => {
    const merged: Record<string, unknown> = {};
    const allowedKeys = new Set<string>();
    for (const f of (spec.fields as Array<Record<string, unknown>>) || []) {
      const col = String(f.column);
      allowedKeys.add(col);
      if (f.default !== undefined && f.default !== null) merged[col] = f.default;
    }
    for (const col of spec.primary_key_columns || []) allowedKeys.add(String(col));
    Object.assign(merged, spec.initial_values || {});
    for (const [key, value] of Object.entries(shared || {})) {
      if (allowedKeys.has(key)) merged[key] = value;
    }
    return merged;
  }, [spec, shared]);

  const [values, setValues] = useState<Record<string, unknown>>(buildInitial());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const formSpec = spec as FormScreenResponse & RuntimeFormSpecExtras;
  const pages = formSpec.pages ?? [];
  const sections = formSpec.sections ?? [];
  const isMultiPage = pages.length >= 2;

  const allFields = (spec.fields as RuntimeField[]) || [];
  const autoNumberSet = new Set(
    (spec.auto_number_columns || []).map((c) => String(c)),
  );
  // Distribute fields per page when multi-page; default page=1 for unassigned fields.
  const fieldsByPage: Record<number, RuntimeField[]> = {};
  for (const f of allFields) {
    const p = isMultiPage ? Number(f.page || 1) : 1;
    (fieldsByPage[p] = fieldsByPage[p] || []).push(f);
  }
  const visibleFields = isMultiPage
    ? fieldsByPage[currentPage] || []
    : allFields;

  // Reset form when spec changes (different screen).
  const lastScreenId = useRef(spec.screen_id);
  useEffect(() => {
    if (lastScreenId.current !== spec.screen_id) {
      lastScreenId.current = spec.screen_id;
      setValues(buildInitial());
      setSubmitError(null);
      setSuccess(null);
      setCurrentPage(1);
    }
  }, [spec.screen_id, buildInitial]);

  const validateCurrentPage = (): boolean => {
    for (const f of visibleFields) {
      const col = String(f.column || '');
      // Hidden fields (show_if false) are never required.
      const showExpr = typeof f.show_if === 'string' ? f.show_if : null;
      if (showExpr && !evaluateTruthy(showExpr, evalCtx, true)) continue;
      // required_if (when present) decides requiredness; else static required.
      const requiredIfExpr = typeof f.required_if === 'string' ? f.required_if : null;
      const required = requiredIfExpr
        ? evaluateTruthy(requiredIfExpr, evalCtx, false)
        : !!f.required;
      const v = values[col];
      if (required && (v === undefined || v === null || v === '')) {
        setSubmitError(`Vui lòng điền "${String(f.label || col)}"`);
        return false;
      }
    }
    setSubmitError(null);
    return true;
  };

  // FormPage.show_if: a page whose expression is falsy is SKIPPED in the
  // wizard (and the BE drops/!requires its fields). Honour it in navigation.
  const pageHidden = (pid: number): boolean => {
    const pg = pages.find((p) => Number(p.id) === pid);
    const expr = pg && typeof pg.show_if === 'string' ? pg.show_if : null;
    return !!expr && !evaluateTruthy(expr, evalCtx, true);
  };
  const lastVisiblePageId =
    pages.reduce((mx, p) => (pageHidden(Number(p.id)) ? mx : Math.max(mx, Number(p.id))), 1);
  const goNextPage = () => {
    if (!validateCurrentPage()) return;
    setCurrentPage((p) => {
      let n = p + 1;
      while (n <= pages.length && pageHidden(n)) n += 1;
      return Math.min(n, pages.length);
    });
  };
  const goPrevPage = () =>
    setCurrentPage((p) => {
      let n = p - 1;
      while (n >= 1 && pageHidden(n)) n -= 1;
      return Math.max(n, 1);
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(null);
    try {
      // Strip placeholder strings (still wrapped in {{…}}); the backend RLS
      // engine forces these columns to the caller's identity anyway.
      const payload: Record<string, unknown> = {};
      const fieldColumns = new Set(
        allFields.map((f) => String(f.column || '')),
      );
      const pkColumns = (spec.primary_key_columns || []).map(String);
      const submitColumns = new Set([...fieldColumns, ...pkColumns]);
      for (const k of submitColumns) {
        const v = values[k];
        if (typeof v === 'string' && v.startsWith('{{') && v.endsWith('}}')) continue;
        payload[k] = v;
      }
      // Client-side valid_if check. Mirrors the BE enforcement so the user
      // sees the rule-specific error message inline instead of waiting for a
      // round-trip rejection. BE remains the source of truth on submit.
      const validationCtx: RuntimeEvalCtx = {
        row: { ...values, ...payload },
        app_user: spec.initial_values || {},
        shared: evalCtx.shared,
      };
      for (const f of allFields) {
        const validIfExpr =
          typeof (f as RuntimeField).valid_if === 'string'
            ? ((f as RuntimeField).valid_if as string)
            : null;
        if (!validIfExpr) continue;
        const col = String(f.column);
        const value = payload[col];
        // Empty optional fields skip valid_if — same contract as BE.
        if (value === null || value === undefined || value === '') continue;
        if (!evaluateTruthy(validIfExpr, validationCtx, true)) {
          const msg =
            typeof (f as RuntimeField).valid_if_error === 'string' &&
            (f as RuntimeField).valid_if_error
              ? String((f as RuntimeField).valid_if_error)
              : `Trường "${f.label || col}" không thoả điều kiện kiểm tra.`;
          setSubmitError(msg);
          setSubmitting(false);
          return;
        }
      }
      const pk: Record<string, unknown> = {};
      const isEditing =
        pkColumns.length > 0 &&
        pkColumns.every((col) => {
          const v = payload[col];
          if (v === undefined || v === null || v === '') return false;
          pk[col] = v;
          return true;
        });
      for (const col of pkColumns) delete payload[col];
      if (isEditing) {
        await workspaceApi.updateScreenRow(token, workboardId, spec.screen_id, pk, payload);
      } else {
        await workspaceApi.insertScreenRow(token, workboardId, spec.screen_id, payload);
      }
      setSuccess(isEditing ? 'Đã cập nhật.' : 'Đã lưu.');
      const next = spec.after_submit?.go_to_screen || undefined;
      const carry: Record<string, unknown> = {};
      for (const col of spec.after_submit?.carry || []) {
        if (col in payload) carry[col] = payload[col];
      }
      // Brief delay so user sees the success badge before navigating.
      setTimeout(() => onSaved(carry, next), 600);
    } catch (err: unknown) {
      const detail = (err as ApiErrorLike)?.response?.data?.detail;
      if (typeof detail === 'string') setSubmitError(detail);
      else if (detail && typeof detail === 'object' && 'message' in detail) {
        setSubmitError(String((detail as { message: string }).message));
      } else setSubmitError('Lưu thất bại. Vui lòng kiểm tra lại các trường.');
    } finally {
      setSubmitting(false);
    }
  };

  // Build expression evaluation context that updates as the user types.
  const evalCtx: RuntimeEvalCtx = {
    row: values,
    app_user: spec.initial_values || {},
    shared,
  };

  // Filter fields by show_if before grouping.
  const computeShouldShow = (f: RuntimeField) => {
    const expr = typeof f.show_if === 'string' ? f.show_if : null;
    if (!expr) return true;
    return evaluateTruthy(expr, evalCtx, true);
  };

  const renderableFields = visibleFields.filter(computeShouldShow);

  // Group visible fields by section heading. Fields without a section land
  // in the "_default" bucket and render without a heading.
  const fieldsBySection: Record<string, RuntimeField[]> = {};
  for (const f of renderableFields) {
    const sec = typeof f.section === 'string' && f.section ? f.section : '_default';
    (fieldsBySection[sec] = fieldsBySection[sec] || []).push(f);
  }
  const derivedSections = renderableFields.map((f) =>
    typeof f.section === 'string' && f.section ? f.section : '_default',
  );
  const sectionOrder = Array.from(
    new Set([
      ...sections.filter((section) => (fieldsBySection[section] || []).length > 0),
      ...derivedSections,
    ]),
  );

  return (
    <div className="mx-auto w-full max-w-3xl rounded-xl bg-white p-5 shadow-sm sm:p-6 xl:max-w-5xl 2xl:max-w-6xl">
      {spec.description && (
        <p className="mb-4 text-sm text-slate-500">{spec.description}</p>
      )}

      {isMultiPage && (
        <PageProgressBar
          pages={pages}
          current={currentPage}
          accent={accent}
        />
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {sectionOrder.map((sec) => {
          const list = fieldsBySection[sec];
          return (
            <div key={sec} className="space-y-3">
              {sec !== '_default' && (
                <h3 className="border-b border-slate-200 pb-1 text-sm font-semibold text-slate-800">
                  {sec}
                </h3>
              )}
              {list.map((field) => (
                <Field
                  key={String(field.column || '')}
                  field={field}
                  lookups={spec.lookups}
                  value={values[String(field.column || '')]}
                  evalCtx={evalCtx}
                  autoNumberSet={autoNumberSet}
                  onChange={(v) =>
                    setValues((curr) => ({
                      ...curr,
                      [String(field.column || '')]: v,
                    }))
                  }
                />
              ))}
            </div>
          );
        })}

        {submitError && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {submitError}
          </p>
        )}
        {success && (
          <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            {success}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isMultiPage && currentPage > 1 ? (
            <button
              type="button"
              onClick={goPrevPage}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              ← Quay lại
            </button>
          ) : (
            <span />
          )}

          {isMultiPage && currentPage < lastVisiblePageId ? (
            <button
              type="button"
              onClick={goNextPage}
              className="flex items-center gap-2 rounded-md px-5 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: accent }}
            >
              Bước kế →
            </button>
          ) : (
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {spec.submit_label || 'Lưu'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function PageProgressBar({
  pages,
  current,
  accent,
}: {
  pages: Array<{ id: number; title: string; description?: string }>;
  current: number;
  accent: string;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          Bước {current}/{pages.length}: <strong className="text-slate-800">{pages[current - 1]?.title}</strong>
        </span>
        <span>{Math.round((current / pages.length) * 100)}%</span>
      </div>
      <div className="flex gap-1">
        {pages.map((p, i) => (
          <div
            key={p.id}
            className="h-1 flex-1 rounded-full"
            style={{ backgroundColor: i + 1 <= current ? accent : '#e2e8f0' }}
          />
        ))}
      </div>
      {pages[current - 1]?.description && (
        <p className="mt-2 text-xs text-slate-500">{pages[current - 1].description}</p>
      )}
    </div>
  );
}

function Field({
  field,
  lookups,
  value,
  onChange,
  evalCtx,
  autoNumberSet,
}: {
  field: RuntimeField;
  lookups: Record<string, Array<{ label: string; value: unknown }>>;
  value: unknown;
  onChange: (v: unknown) => void;
  evalCtx?: RuntimeEvalCtx;
  autoNumberSet?: Set<string>;
}) {
  const col = String(field.column);
  const widget = String(field.widget || 'text');
  const label = String(field.label || col);
  const help = field.help_text ? String(field.help_text) : null;
  const placeholder = field.placeholder ? String(field.placeholder) : '';
  const requiredIfExpr =
    typeof field.required_if === 'string' ? field.required_if : undefined;
  const readonlyIfExpr =
    typeof field.readonly_if === 'string' ? field.readonly_if : undefined;
  const computedFromDataset =
    typeof field.computed_from_dataset === 'string' && field.computed_from_dataset
      ? field.computed_from_dataset
      : null;
  const isAutoNumberCol = !!autoNumberSet && autoNumberSet.has(col);
  const required = requiredIfExpr && evalCtx
    ? evaluateTruthy(requiredIfExpr, evalCtx, false)
    : !!field.required;
  const readonly =
    (readonlyIfExpr && evalCtx
      ? evaluateTruthy(readonlyIfExpr, evalCtx, false)
      : false) ||
    !!field.readonly ||
    !!computedFromDataset ||
    isAutoNumberCol;
  const lookupOpts =
    lookups[col] ||
    (((field.lookup as Record<string, unknown> | undefined)?.values as Array<{
      label: string;
      value: unknown;
    }>) ?? []);

  const stringValue = value == null ? '' : String(value);
  const baseInput =
    'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500';

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>

      {widget === 'textarea' ? (
        <textarea
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          placeholder={placeholder}
          rows={3}
          className={baseInput}
        />
      ) : widget === 'checkbox' ? (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            disabled={readonly}
            className="h-4 w-4 rounded border-slate-300"
          />
          {help || 'Đồng ý'}
        </label>
      ) : widget === 'select' || widget === 'lookup' ? (
        <select
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          className={baseInput}
        >
          <option value="">— chọn —</option>
          {(lookupOpts as Array<{ label: string; value: unknown }>).map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : widget === 'date' ? (
        <input
          type="date"
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          className={baseInput}
        />
      ) : widget === 'datetime' ? (
        <input
          type="datetime-local"
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          className={baseInput}
        />
      ) : widget === 'number' ? (
        <input
          type="number"
          value={stringValue}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? '' : Number(v));
          }}
          disabled={readonly}
          required={required}
          placeholder={placeholder}
          className={baseInput}
        />
      ) : widget === 'file' || widget === 'image' ? (
        <FileUploadField
          field={field}
          value={value}
          onChange={onChange}
          readonly={readonly}
          required={required}
          isImage={widget === 'image'}
        />
      ) : (
        <input
          type="text"
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          placeholder={placeholder}
          className={baseInput}
        />
      )}

      {widget !== 'checkbox' && help && (
        <p className="text-xs text-slate-500">{help}</p>
      )}
      {computedFromDataset && (
        <p className="text-xs text-slate-500 italic">
          Giá trị do dataset tự tính (cột <code>{computedFromDataset}</code>) — không thể chỉnh trực tiếp ở đây.
        </p>
      )}
      {isAutoNumberCol && !computedFromDataset && (
        <p className="text-xs text-slate-500 italic">
          Hệ thống sẽ tự sinh giá trị cho cột này khi lưu — bỏ trống là đủ.
        </p>
      )}
    </div>
  );
}

// ── File / image upload widget ───────────────────────────────────────────
//
// Stores the file as a base64 data URL directly in the row's JSONB cell.
// Hard ceiling is 1 MB — anything bigger blows up the row payload + audit
// log. Builder can lower this via FormField.max_file_kb.

const FILE_HARD_CAP_KB = 1024;

function FileUploadField({
  field,
  value,
  onChange,
  readonly,
  required,
  isImage,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
  required: boolean;
  isImage: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const maxKb = Math.min(
    Number(field.max_file_kb) || FILE_HARD_CAP_KB,
    FILE_HARD_CAP_KB,
  );
  const stringValue = typeof value === 'string' ? value : '';
  const hasValue = !!stringValue;

  const handleFile = (file: File | null) => {
    setError(null);
    if (!file) {
      onChange('');
      return;
    }
    const sizeKb = Math.round(file.size / 1024);
    if (sizeKb > maxKb) {
      setError(`Tệp ${sizeKb} KB vượt giới hạn ${maxKb} KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        onChange(result);
      }
    };
    reader.onerror = () => setError('Không đọc được tệp.');
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2">
      {hasValue && isImage && stringValue.startsWith('data:image') && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={stringValue}
          alt={String(field.label || field.column)}
          className="max-h-40 rounded-md border border-slate-200"
        />
      )}
      {hasValue && !isImage && (
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span>📎</span>
          <span className="truncate">
            {stringValue.startsWith('data:')
              ? stringValue.slice(0, 60) + '…'
              : stringValue}
          </span>
        </div>
      )}
      {!readonly && (
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept={isImage ? 'image/*' : undefined}
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            required={required && !hasValue}
            className="text-xs"
          />
          {hasValue && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                onChange('');
              }}
              className="text-xs text-rose-600 hover:underline"
            >
              Xoá
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {!error && (
        <p className="text-xs text-slate-500">
          Tối đa {maxKb} KB. Tệp được lưu trực tiếp trong cơ sở dữ liệu — phù hợp cho ảnh/scan nhỏ.
        </p>
      )}
    </div>
  );
}

// ── Cell value formatter ─────────────────────────────────────────────────

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString('vi-VN');
  }
  const s = String(value);
  // ISO date/datetime
  if (/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(s)) {
    try {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return /^\d{4}-\d{2}-\d{2}$/.test(s)
          ? d.toLocaleDateString('vi-VN')
          : d.toLocaleString('vi-VN');
      }
    } catch {
      // fall through
    }
  }
  return s;
}

function CellDisplay({ value }: { value: unknown }) {
  if (typeof value === 'boolean') {
    return (
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
          value ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        {value ? '✓' : '✕'}
      </span>
    );
  }
  const s = formatCellValue(value);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="max-w-[180px] truncate text-blue-600 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {value}
      </a>
    );
  }
  return <>{s}</>;
}

// Formatted cell for grid screens. Renders a cell value with a specific
// number/currency/percent/date format hint coming from the builder's
// computed/lookup column spec. Falls back to ``CellDisplay`` when no
// format is set, or when the value is a server-side error sentinel.
function FormattedCell({
  value,
  format,
}: {
  value: unknown;
  format: string | null;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300">—</span>;
  }
  if (typeof value === 'string' && value.startsWith('#ERR')) {
    return (
      <span
        className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600"
        title={value}
      >
        #ERR
      </span>
    );
  }
  if (!format) return <CellDisplay value={value} />;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (format === 'currency' && Number.isFinite(numeric)) {
    return (
      <>
        {numeric.toLocaleString('vi-VN', { style: 'currency', currency: 'VND' })}
      </>
    );
  }
  if (format === 'percent' && Number.isFinite(numeric)) {
    return <>{(numeric * 100).toFixed(2)}%</>;
  }
  if (format === 'integer' && Number.isFinite(numeric)) {
    return <>{Math.round(numeric).toLocaleString('vi-VN')}</>;
  }
  if (format === 'number' && Number.isFinite(numeric)) {
    return <>{numeric.toLocaleString('vi-VN', { maximumFractionDigits: 4 })}</>;
  }
  if (format === 'date' || format === 'datetime') {
    return <CellDisplay value={value} />;
  }
  return <CellDisplay value={value} />;
}

// ── List screen ──────────────────────────────────────────────────────────

// ── Table screen (read + inline edit + detail panel) ───────────────────
//
// One component renders the full spectrum:
// * Pure read-only when ``editable_columns`` is empty
// * Spreadsheet-style inline edit when ``editable_columns`` has entries:
//   autosave 800ms after the last keystroke per row
// * Row actions navigate to other screens with ``carry`` columns
// * Click a row → side detail panel opens with the full record;
//   ``detail_panel.editable_columns`` further controls panel-side edit
//
// RLS still rules the wire — backend re-checks can_update / can_delete /
// can_create on every request so a viewer can't bypass by hand-editing.

type RowActionDescriptor = {
  id: string;
  label: string;
  icon?: string | null;
  style?: 'primary' | 'secondary' | 'ghost' | 'danger';
  go_to_screen?: string | null;
  carry?: string[];
  confirm_message?: string | null;
  visible_for_roles?: string[];
};

type RuntimeTableFilter = {
  column: string;
  kind: 'text' | 'select' | 'date_range' | 'number_range';
  label?: string | null;
};

interface TableCellPatch {
  rowKey: string;
  patch: Record<string, unknown>;
}

function tableRowKey(row: Record<string, unknown>, pkCols: string[]): string {
  if (pkCols.length === 0) return '__no_pk__';
  return pkCols.map((c) => JSON.stringify(row[c] ?? null)).join('|');
}

function TableScreen({
  spec,
  token,
  workboardId,
  accent,
  viewerRole,
  onAction,
}: {
  spec: TableScreenResponse;
  token: string;
  workboardId: number;
  accent: string;
  viewerRole?: string | null;
  onAction: (action: RowActionDescriptor, row: Record<string, unknown>) => void;
}) {
  type Row = Record<string, unknown>;

  const [current, setCurrent] = useState<TableScreenResponse>(spec);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [filterLoading, setFilterLoading] = useState(false);
  const [tablePage, setTablePage] = useState(1);
  const [rowStatus, setRowStatus] = useState<
    Record<string, { status: 'idle' | 'saving' | 'saved' | 'error'; error?: string }>
  >({});
  const [ghost, setGhost] = useState<Row>({});
  const [ghostError, setGhostError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [panelRowKey, setPanelRowKey] = useState<string | null>(null);
  const [panelDetail, setPanelDetail] = useState<TableRowDetailResponse | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelDraft, setPanelDraft] = useState<Record<string, unknown>>({});
  const [panelSaving, setPanelSaving] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  useEffect(() => {
    setCurrent(spec);
    setFilterValues({});
    setRowStatus({});
    setGhost({});
    setGhostError(null);
    setPanelRowKey(null);
    setPanelDetail(null);
    setPanelDraft({});
    setPanelError(null);
  }, [spec]);

  const tv = (current.table_view as TableScreenResponse['table_view']) || {};
  const cols = current.columns ?? [];
  const rows = current.rows ?? [];
  const pkCols = current.primary_key_columns ?? [];
  const editableCols = useMemo(() => new Set(tv.editable_columns || []), [tv.editable_columns]);
  const requiredCols = useMemo(() => new Set(tv.required_columns || []), [tv.required_columns]);
  const computedSpecs = useMemo(() => tv.computed_columns || [], [tv.computed_columns]);
  const lookupSpecs = useMemo(() => tv.lookup_columns || [], [tv.lookup_columns]);
  const totalsSpec = (tv.totals || {}) as Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count'>;
  const derivedCols = useMemo(
    () => new Set([...computedSpecs.map((c) => c.name), ...lookupSpecs.map((l) => l.name)]),
    [computedSpecs, lookupSpecs],
  );
  const formatByCol = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const c of computedSpecs) out[c.name] = c.format ?? null;
    for (const l of lookupSpecs) out[l.name] = l.format ?? null;
    for (const [name, meta] of Object.entries(tv.column_metadata || {})) {
      if (meta?.format && out[name] === undefined) out[name] = meta.format;
    }
    return out;
  }, [computedSpecs, lookupSpecs, tv.column_metadata]);
  const detailPanel = tv.detail_panel;
  const panelEnabled = !(detailPanel && detailPanel.enabled === false);

  // Phase-15: all computed columns evaluate server-side via the QuickJS
  // sandbox. The FE just renders whatever value the backend wrote into
  // ``rows[i][computed_col_name]`` — no local re-eval, no compile pass.

  const isEditable = editableCols.size > 0;
  const allowAdd = isEditable && tv.allow_add_row === true;
  const allowDelete = isEditable && tv.allow_delete_row === true;

  const colLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(current.column_labels || {})) out[k] = v;
    for (const [name, meta] of Object.entries(tv.column_metadata || {})) {
      if (meta?.label) out[name] = meta.label;
    }
    return out;
  }, [current.column_labels, tv.column_metadata]);

  const columnGroups = current.column_groups || [];
  const merges = current.merges || [];
  const mergeByColRow = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of merges) map.set(`${m.column}:${m.row_start}`, m.row_span);
    return map;
  }, [merges]);
  const mergeHiddenCells = useMemo(() => {
    const hidden = new Set<string>();
    for (const m of merges) {
      for (let i = m.row_start + 1; i < m.row_start + m.row_span; i += 1) {
        hidden.add(`${m.column}:${i}`);
      }
    }
    return hidden;
  }, [merges]);
  const groupedColumns = useMemo(() => {
    const assigned = new Set<string>();
    columnGroups.forEach((g) => g.columns.forEach((c) => assigned.add(c)));
    return assigned;
  }, [columnGroups]);

  const configuredFilters = ((tv.filters as RuntimeTableFilter[] | undefined) || []).filter(
    (item) => item?.column,
  );
  const rowActionsRaw = (tv.row_actions || []) as RowActionDescriptor[];
  const rowActions = rowActionsRaw.filter((a) => {
    const allow = a.visible_for_roles;
    if (!allow || allow.length === 0) return true;
    if (!viewerRole) return true;
    const target = viewerRole.toLowerCase();
    return allow.some((r) => r.toLowerCase() === target);
  });
  const empty = tv.empty_state_message || 'No data yet.';

  // FE no longer evaluates computed columns locally — the server-side
  // QuickJS sandbox is the only place that runs ``formula`` bodies. When
  // an inline cell edit changes a non-derived column, we mark the row
  // ``dirty`` so the user sees a hint that derived cells will refresh on
  // the next page reload. Optimistic in-place re-eval is not possible
  // anymore (we'd need a per-keystroke /test-js call) — accept the
  // tradeoff for now.

  const totalsRow = useMemo(() => {
    if (current.totals_row && typeof current.totals_row === 'object') {
      return current.totals_row as Record<string, unknown>;
    }
    if (!Object.keys(totalsSpec).length || rows.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const [col, kind] of Object.entries(totalsSpec)) {
      if (kind === 'count') {
        out[col] = rows.filter(
          (r) => r[col] !== null && r[col] !== undefined && r[col] !== '',
        ).length;
        continue;
      }
      const nums: number[] = [];
      for (const r of rows) {
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        const n = Number(v);
        if (!Number.isNaN(n)) nums.push(n);
      }
      if (!nums.length) {
        out[col] = null;
        continue;
      }
      if (kind === 'sum') out[col] = nums.reduce((s, n) => s + n, 0);
      else if (kind === 'avg') out[col] = nums.reduce((s, n) => s + n, 0) / nums.length;
      else if (kind === 'min') out[col] = Math.min(...nums);
      else if (kind === 'max') out[col] = Math.max(...nums);
    }
    return out;
  }, [current.totals_row, totalsSpec, rows]);

  const buildApiFilters = (values: Record<string, string>) => {
    const out: Array<Record<string, unknown>> = [];
    configuredFilters.forEach((filter, idx) => {
      const key = String(idx);
      if (filter.kind === 'date_range' || filter.kind === 'number_range') {
        const from = values[`${key}:from`];
        const to = values[`${key}:to`];
        if (from || to) {
          out.push({
            field: filter.column,
            operator: 'between',
            value: [from || null, to || null],
          });
        }
        return;
      }
      const value = values[key];
      if (!value) return;
      out.push({
        field: filter.column,
        operator: filter.kind === 'text' ? 'contains' : 'eq',
        value,
      });
    });
    return out;
  };

  const pageSize = Number(tv.page_size || current.page_size || 50);

  // Fetch a specific page. Filter changes reset to page 1; the pager moves
  // within the current filter set. (Before this, the runtime hardcoded
  // page 1 and there was NO way to reach rows beyond page_size.)
  const loadRows = async (values: Record<string, string>, page: number) => {
    setFilterLoading(true);
    try {
      const next = await workspaceApi.tableScreenRows(token, workboardId, current.screen_id, {
        page,
        page_size: pageSize,
        filters: buildApiFilters(values),
      });
      setCurrent((prev) => ({ ...prev, ...next }));
      setFilterValues(values);
      setTablePage(page);
      setRowStatus({});
    } finally {
      setFilterLoading(false);
    }
  };

  // Filter apply/clear always restarts at page 1.
  const reloadRows = async (values: Record<string, string>) => {
    await loadRows(values, 1);
  };

  // A full page implies there may be more rows — cheap "has next" without a
  // server-side count (Sheets data is already cached server-side).
  const hasNextPage = rows.length >= pageSize;
  const goToPage = (p: number) => {
    if (p < 1 || filterLoading) return;
    if (p > tablePage && !hasNextPage) return;
    void loadRows(filterValues, p);
  };

  const pendingRef = useRef<Map<string, TableCellPatch>>(new Map());
  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const flushRow = async (rowKey: string) => {
    const pending = pendingRef.current.get(rowKey);
    if (!pending) return;
    pendingRef.current.delete(rowKey);
    timerRef.current.delete(rowKey);
    const row = rows.find((r) => tableRowKey(r, pkCols) === rowKey);
    if (!row) return;
    const pk: Record<string, unknown> = {};
    for (const c of pkCols) pk[c] = row[c];
    setRowStatus((prev) => ({ ...prev, [rowKey]: { status: 'saving' } }));
    try {
      await workspaceApi.updateScreenRow(token, workboardId, current.screen_id, pk, pending.patch);
      setRowStatus((prev) => ({ ...prev, [rowKey]: { status: 'saved' } }));
      setTimeout(() => {
        setRowStatus((prev) => {
          if (prev[rowKey]?.status !== 'saved') return prev;
          const next = { ...prev };
          delete next[rowKey];
          return next;
        });
      }, 1500);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Save failed';
      setRowStatus((prev) => ({ ...prev, [rowKey]: { status: 'error', error: String(msg) } }));
      void reloadRows(filterValues);
    }
  };

  const queueCellEdit = (rowKey: string, column: string, value: unknown) => {
    const existing = pendingRef.current.get(rowKey) || { rowKey, patch: {} };
    existing.patch[column] = value;
    pendingRef.current.set(rowKey, existing);
    const prevTimer = timerRef.current.get(rowKey);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      void flushRow(rowKey);
    }, 800);
    timerRef.current.set(rowKey, timer);
  };

  const updateRowCell = (rowKey: string, column: string, value: unknown) => {
    // Optimistic local update of the edited cell only. Computed columns
    // get re-evaluated server-side on the next reload (after the PATCH
    // lands) — we don't run JS in the browser, so we can't update
    // derived cells in-place.
    setCurrent((prev) => {
      const currentRows = prev.rows || [];
      const editedIdx = currentRows.findIndex((r) => tableRowKey(r, pkCols) === rowKey);
      if (editedIdx === -1) return prev;
      const newRows = currentRows.map((r, idx) =>
        idx === editedIdx ? { ...r, [column]: value } : r,
      );
      return { ...prev, rows: newRows };
    });
    queueCellEdit(rowKey, column, value);
  };

  const deleteRow = async (row: Row) => {
    if (!allowDelete) return;
    if (!confirm('Delete this row?')) return;
    const rowKey = tableRowKey(row, pkCols);
    const pk: Record<string, unknown> = {};
    for (const c of pkCols) pk[c] = row[c];
    setRowStatus((prev) => ({ ...prev, [rowKey]: { status: 'saving' } }));
    try {
      await workspaceApi.deleteScreenRow(token, workboardId, current.screen_id, pk);
      setCurrent((prev) => ({
        ...prev,
        rows: (prev.rows || []).filter((r) => tableRowKey(r, pkCols) !== rowKey),
      }));
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Delete failed';
      setRowStatus((prev) => ({ ...prev, [rowKey]: { status: 'error', error: String(msg) } }));
    }
  };

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkResult, setBulkResult] = useState<null | {
    total: number;
    success: number;
    failure: number;
    errors: Array<{ index: number; error: string }>;
  }>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const bulkColumns = useMemo(() => {
    const editableArr = cols.filter((c) => editableCols.has(c));
    return editableArr.length > 0 ? editableArr : cols;
  }, [cols, editableCols]);

  const parseBulkText = (text: string): Array<Record<string, unknown>> => {
    const lines = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.length > 0);
    return lines.map((line) => {
      const cells = line.split('\t');
      const row: Record<string, unknown> = {};
      bulkColumns.forEach((col, i) => {
        const cell = cells[i];
        if (cell === undefined) return;
        const trimmed = cell.trim();
        if (trimmed === '') return;
        row[col] = trimmed;
      });
      return row;
    });
  };

  const submitBulk = async () => {
    const parsed = parseBulkText(bulkText);
    if (parsed.length === 0) return;
    setBulkSubmitting(true);
    setBulkResult(null);
    try {
      const result = await workspaceApi.bulkInsertScreenRows(
        token,
        workboardId,
        current.screen_id,
        parsed,
      );
      setBulkResult({
        total: result.total,
        success: result.success,
        failure: result.failure,
        errors: result.results
          .filter((r) => !r.ok)
          .map((r) => ({ index: r.index, error: r.error || 'Insert failed' })),
      });
      if (result.success > 0) await reloadRows(filterValues);
      if (result.failure === 0) {
        setBulkText('');
        setBulkOpen(false);
      }
    } catch (err: unknown) {
      const detail = (err as ApiErrorLike)?.response?.data?.detail;
      setBulkResult({
        total: parsed.length,
        success: 0,
        failure: parsed.length,
        errors: [{ index: 0, error: typeof detail === 'string' ? detail : 'Bulk insert failed' }],
      });
    } finally {
      setBulkSubmitting(false);
    }
  };

  const ghostMissingRequired = useMemo(
    () =>
      Array.from(requiredCols).filter(
        (c) => ghost[c] === undefined || ghost[c] === '' || ghost[c] === null,
      ),
    [ghost, requiredCols],
  );

  const submitGhost = async () => {
    if (!allowAdd) return;
    if (ghostMissingRequired.length > 0) {
      setGhostError(`Required: ${ghostMissingRequired.join(', ')}`);
      return;
    }
    setAdding(true);
    setGhostError(null);
    try {
      await workspaceApi.insertScreenRow(token, workboardId, current.screen_id, ghost);
      setGhost({});
      await reloadRows(filterValues);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string | { message?: string } } } })?.response
          ?.data?.detail;
      const detail = typeof msg === 'string' ? msg : msg?.message || 'Add row failed';
      setGhostError(detail);
    } finally {
      setAdding(false);
    }
  };

  const openDetailPanel = async (row: Record<string, unknown>) => {
    if (!panelEnabled || pkCols.length === 0) return;
    const key = tableRowKey(row, pkCols);
    setPanelRowKey(key);
    setPanelError(null);
    setPanelDraft({});
    setPanelLoading(true);
    const pk: Record<string, unknown> = {};
    for (const c of pkCols) pk[c] = row[c];
    try {
      const detail = await workspaceApi.fetchTableRowDetail(
        token,
        workboardId,
        current.screen_id,
        pk,
      );
      setPanelDetail(detail);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Cannot load row.';
      setPanelError(String(msg));
      setPanelDetail(null);
    } finally {
      setPanelLoading(false);
    }
  };

  const closeDetailPanel = () => {
    setPanelRowKey(null);
    setPanelDetail(null);
    setPanelDraft({});
    setPanelError(null);
  };

  const savePanelDraft = async () => {
    if (!panelDetail || Object.keys(panelDraft).length === 0) return;
    const pk: Record<string, unknown> = {};
    for (const c of panelDetail.primary_key_columns || []) pk[c] = panelDetail.row[c];
    setPanelSaving(true);
    setPanelError(null);
    try {
      await workspaceApi.updateScreenRow(token, workboardId, current.screen_id, pk, panelDraft);
      setPanelDraft({});
      await reloadRows(filterValues);
      const refreshed = await workspaceApi.fetchTableRowDetail(
        token,
        workboardId,
        current.screen_id,
        pk,
      );
      setPanelDetail(refreshed);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string | { message?: string } } } })?.response
          ?.data?.detail;
      const detail = typeof msg === 'string' ? msg : msg?.message || 'Save failed';
      setPanelError(detail);
    } finally {
      setPanelSaving(false);
    }
  };

  const onRowClick = (row: Record<string, unknown>, event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, button, a, textarea, select')) return;
    void openDetailPanel(row);
  };

  return (
    <div className="w-full rounded-xl bg-white shadow-sm">
      {spec.description && (
        <div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-500">
          {spec.description}
        </div>
      )}

      {configuredFilters.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void reloadRows(filterValues);
          }}
          className="border-b border-slate-100 bg-slate-50/70 px-4 py-3"
        >
          <div className="grid gap-2 md:grid-cols-3">
            {configuredFilters.map((filter, idx) => {
              const key = String(idx);
              const label = filter.label || filter.column;
              if (filter.kind === 'date_range' || filter.kind === 'number_range') {
                const type = filter.kind === 'date_range' ? 'date' : 'number';
                return (
                  <div key={key} className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">
                        {label} from
                      </span>
                      <input
                        type={type}
                        value={filterValues[`${key}:from`] || ''}
                        onChange={(event) =>
                          setFilterValues((prev) => ({
                            ...prev,
                            [`${key}:from`]: event.target.value,
                          }))
                        }
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">
                        {label} to
                      </span>
                      <input
                        type={type}
                        value={filterValues[`${key}:to`] || ''}
                        onChange={(event) =>
                          setFilterValues((prev) => ({
                            ...prev,
                            [`${key}:to`]: event.target.value,
                          }))
                        }
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400"
                      />
                    </label>
                  </div>
                );
              }
              return (
                <label key={key} className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
                  <input
                    value={filterValues[key] || ''}
                    onChange={(event) =>
                      setFilterValues((prev) => ({ ...prev, [key]: event.target.value }))
                    }
                    placeholder={filter.kind === 'select' ? 'Exact value' : 'Search'}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400"
                  />
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={filterLoading}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              {filterLoading ? 'Loading...' : 'Apply filters'}
            </button>
            <button
              type="button"
              onClick={() => void reloadRows({})}
              disabled={filterLoading || Object.keys(filterValues).length === 0}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {columnGroups.length > 0 ? (
              <tr className="border-b border-slate-200 bg-slate-100">
                {(() => {
                  const cells: React.ReactNode[] = [];
                  let i = 0;
                  while (i < cols.length) {
                    const col = cols[i];
                    const group = columnGroups.find((g) => g.columns[0] === col);
                    if (group) {
                      cells.push(
                        <th
                          key={`g:${i}`}
                          colSpan={group.columns.length}
                          className="border-r border-slate-200 px-3 py-1.5 text-center text-xs font-semibold text-slate-700"
                        >
                          {group.label}
                        </th>,
                      );
                      i += group.columns.length;
                      continue;
                    }
                    cells.push(
                      <th
                        key={`g:${i}`}
                        rowSpan={2}
                        className="border-r border-slate-200 px-3 py-1.5 text-left text-xs font-semibold text-slate-600"
                      >
                        {colLabels[col] || col}
                      </th>,
                    );
                    i += 1;
                  }
                  if (rowActions.length > 0 || isEditable) {
                    cells.push(<th key="g:actions" rowSpan={2} className="w-24" />);
                  }
                  return cells;
                })()}
              </tr>
            ) : null}
            <tr className="border-b border-slate-200 bg-slate-50">
              {cols.map((c) => {
                if (columnGroups.length > 0 && !groupedColumns.has(c)) return null;
                const computedSpec = computedSpecs.find((cc) => cc.name === c);
                const lookupSpec = lookupSpecs.find((ll) => ll.name === c);
                const isComputed = !!computedSpec;
                const isLookup = !!lookupSpec;
                const headerLabel =
                  computedSpec?.label ||
                  lookupSpec?.label ||
                  colLabels[c] ||
                  c;
                // Origin hint for ↗ lookup icon — shows "↗ tra từ <table>"
                // on hover so the user understands where the value comes
                // from. Computed JS columns get a different hint (server
                // sandbox eval).
                const lookupTooltip = lookupSpec
                  ? `Cột tra cứu: lấy '${lookupSpec.return_column}' từ bảng id=${lookupSpec.from_table_id}. ` +
                    `Khớp khi ${lookupSpec.match_column_local} = ${lookupSpec.match_column_remote}.`
                  : 'Lookup';
                const computedTooltip = computedSpec
                  ? 'Computed (JavaScript, evaluate trên server)'
                  : 'Computed';
                return (
                  <th
                    key={c}
                    className="px-3 py-2 text-left text-xs font-semibold text-slate-600"
                  >
                    {headerLabel}
                    {requiredCols.has(c) ? <span className="ml-0.5 text-red-500">*</span> : null}
                    {isComputed ? (
                      <span className="ml-1 text-[10px] font-normal text-indigo-500" title={computedTooltip}>
                        ƒ
                      </span>
                    ) : isLookup ? (
                      <span className="ml-1 text-[10px] font-normal text-emerald-600" title={lookupTooltip}>
                        ↗
                      </span>
                    ) : editableCols.has(c) ? (
                      <span className="ml-1 text-[10px] font-normal text-slate-400" title="Editable">
                        ✎
                      </span>
                    ) : isEditable ? (
                      <span className="ml-1 text-[10px] font-normal text-slate-300" title="Read-only">
                        🔒
                      </span>
                    ) : null}
                  </th>
                );
              })}
              {(rowActions.length > 0 || isEditable) && columnGroups.length === 0 ? (
                <th className="w-24 px-3 py-2 text-right text-xs font-semibold text-slate-600" />
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !allowAdd ? (
              <tr>
                <td
                  colSpan={cols.length + (rowActions.length > 0 || isEditable ? 1 : 0)}
                  className="p-10 text-center text-sm text-slate-500"
                >
                  {empty}
                </td>
              </tr>
            ) : null}
            {rows.map((row, idx) => {
              const rowKey = tableRowKey(row, pkCols);
              const status = rowStatus[rowKey];
              return (
                <tr
                  key={`${rowKey}:${idx}`}
                  className={`border-b border-slate-100 ${
                    status?.status === 'error' ? 'bg-red-50/40' : 'hover:bg-slate-50'
                  } ${panelEnabled && pkCols.length > 0 ? 'cursor-pointer' : ''}`}
                  onClick={(event) => onRowClick(row, event)}
                >
                  {cols.map((c) => {
                    if (mergeHiddenCells.has(`${c}:${idx}`)) return null;
                    const rowspan = mergeByColRow.get(`${c}:${idx}`);
                    const derived = derivedCols.has(c);
                    const editable = editableCols.has(c) && !derived;
                    const cellValue = row[c];
                    const format = formatByCol[c] ?? null;
                    return (
                      <td
                        key={c}
                        rowSpan={rowspan}
                        className={`px-3 py-1.5 align-top ${
                          editable
                            ? 'text-slate-900'
                            : derived
                              ? 'bg-indigo-50/30 text-slate-700'
                              : 'text-slate-700'
                        }`}
                      >
                        {editable ? (
                          <TableCellInput
                            value={cellValue}
                            onCommit={(next) => updateRowCell(rowKey, c, next)}
                          />
                        ) : (
                          <FormattedCell value={cellValue} format={format} />
                        )}
                      </td>
                    );
                  })}
                  {rowActions.length > 0 || isEditable ? (
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {status?.status === 'saving' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                        ) : status?.status === 'saved' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : status?.status === 'error' ? (
                          <span title={status.error} className="text-xs font-medium text-red-600">
                            !
                          </span>
                        ) : null}
                        {rowActions.map((a) => {
                          const style = a.style || 'primary';
                          const cls =
                            style === 'danger'
                              ? 'bg-rose-600 text-white hover:bg-rose-700'
                              : style === 'secondary'
                                ? 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                                : style === 'ghost'
                                  ? 'text-slate-700 hover:bg-slate-100'
                                  : 'text-white';
                          const inlineStyle =
                            style === 'primary' ? { backgroundColor: accent } : undefined;
                          return (
                            <button
                              key={a.id}
                              onClick={() => {
                                if (a.confirm_message && !window.confirm(a.confirm_message)) return;
                                onAction(a, row);
                              }}
                              className={`rounded-md px-2 py-1 text-xs font-medium ${cls}`}
                              style={inlineStyle}
                              title={a.icon ? `${a.icon} ${a.label}` : a.label}
                            >
                              {a.label}
                            </button>
                          );
                        })}
                        {allowDelete && pkCols.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => void deleteRow(row)}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            title="Delete row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {allowAdd ? (
              <tr className="border-b border-slate-100 bg-slate-50/40">
                {cols.map((c) => {
                  const derived = derivedCols.has(c);
                  const editable = !derived && (editableCols.has(c) || requiredCols.has(c));
                  return (
                    <td key={c} className="px-3 py-1.5 align-top">
                      {editable ? (
                        <TableCellInput
                          value={ghost[c]}
                          placeholder={requiredCols.has(c) ? 'Required' : ''}
                          onCommit={(next) => setGhost((prev) => ({ ...prev, [c]: next }))}
                        />
                      ) : derived ? (
                        // Computed cells preview after the row lands —
                        // they're evaluated server-side on the next page
                        // refresh.
                        <span className="text-xs text-slate-400">ƒ (auto)</span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void submitGhost()}
                      disabled={adding || ghostMissingRequired.length > 0}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                      style={{ backgroundColor: accent }}
                      title={
                        ghostMissingRequired.length > 0
                          ? `Required: ${ghostMissingRequired.join(', ')}`
                          : 'Add row'
                      }
                    >
                      {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBulkResult(null);
                        setBulkOpen(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      title="Dán nhiều dòng từ Excel"
                    >
                      📋 Paste rows
                    </button>
                  </div>
                </td>
              </tr>
            ) : null}
            {totalsRow && Object.keys(totalsRow).length > 0 ? (
              <tr className="border-t-2 border-slate-300 bg-slate-100/80 font-medium">
                {cols.map((c) => {
                  const total = totalsRow[c];
                  const kind = totalsSpec[c];
                  const format = formatByCol[c] ?? null;
                  return (
                    <td key={c} className="px-3 py-2 text-slate-700">
                      {total !== undefined && total !== null ? (
                        <span className="flex items-baseline gap-1.5">
                          {kind ? (
                            <span className="text-[10px] font-normal uppercase tracking-wider text-slate-400">
                              {kind}
                            </span>
                          ) : null}
                          <FormattedCell value={total} format={format ?? 'number'} />
                        </span>
                      ) : kind ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : null}
                    </td>
                  );
                })}
                {rowActions.length > 0 || isEditable ? <td /> : null}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {(tablePage > 1 || hasNextPage) && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
          <span>
            Trang {tablePage}
            {rows.length ? ` · ${rows.length} dòng` : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(tablePage - 1)}
              disabled={tablePage <= 1 || filterLoading}
              className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40 hover:bg-slate-50"
            >
              ← Trước
            </button>
            <button
              type="button"
              onClick={() => goToPage(tablePage + 1)}
              disabled={!hasNextPage || filterLoading}
              className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40 hover:bg-slate-50"
            >
              Sau →
            </button>
          </div>
        </div>
      )}

      {ghostError ? (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {ghostError}
        </div>
      ) : null}

      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Dán nhiều dòng</h3>
              <button
                type="button"
                onClick={() => {
                  setBulkOpen(false);
                  setBulkResult(null);
                  setBulkText('');
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="text-xs text-slate-600">
                Sao chép từ Excel/Google Sheets rồi dán vào ô bên dưới (mỗi dòng = 1 record,
                các cột cách bằng tab).
                <br />
                Thứ tự cột:{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5">{bulkColumns.join('\t')}</code>
              </div>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={10}
                placeholder={bulkColumns.map(() => '...').join('\t')}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
              />
              <div className="text-xs text-slate-500">
                {parseBulkText(bulkText).length > 0
                  ? `Sẽ nhập ${parseBulkText(bulkText).length} dòng`
                  : 'Chưa có dòng hợp lệ'}
                . Tối đa 500 dòng/lần.
              </div>
              {bulkResult && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
                  <div className="font-medium text-slate-700">
                    Đã xử lý {bulkResult.total} dòng: {bulkResult.success} thành công,{' '}
                    {bulkResult.failure} lỗi.
                  </div>
                  {bulkResult.errors.length > 0 && (
                    <ul className="mt-2 space-y-1 text-rose-700">
                      {bulkResult.errors.slice(0, 10).map((err) => (
                        <li key={err.index}>
                          Dòng {err.index + 1}: {err.error}
                        </li>
                      ))}
                      {bulkResult.errors.length > 10 && (
                        <li>... và {bulkResult.errors.length - 10} dòng khác.</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  setBulkOpen(false);
                  setBulkResult(null);
                  setBulkText('');
                }}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Huỷ
              </button>
              <button
                type="button"
                onClick={() => void submitBulk()}
                disabled={bulkSubmitting || parseBulkText(bulkText).length === 0}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: accent }}
              >
                {bulkSubmitting ? 'Đang lưu...' : 'Nhập'}
              </button>
            </div>
          </div>
        </div>
      )}

      {panelRowKey && panelEnabled && (
        <div className="fixed inset-0 z-40 flex">
          <div className="flex-1 bg-black/30" onClick={closeDetailPanel} />
          <aside className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                {panelDetail?.title || spec.title || 'Chi tiết'}
              </h3>
              <button
                type="button"
                onClick={closeDetailPanel}
                className="text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {panelLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                </div>
              ) : panelError ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {panelError}
                </div>
              ) : panelDetail ? (
                <DetailPanelBody
                  detail={panelDetail}
                  draft={panelDraft}
                  setDraft={setPanelDraft}
                />
              ) : null}
            </div>
            {panelDetail && (panelDetail.editable_columns || []).length > 0 && (
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
                <button
                  type="button"
                  onClick={() => setPanelDraft({})}
                  disabled={panelSaving || Object.keys(panelDraft).length === 0}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Huỷ thay đổi
                </button>
                <button
                  type="button"
                  onClick={() => void savePanelDraft()}
                  disabled={panelSaving || Object.keys(panelDraft).length === 0}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: accent }}
                >
                  {panelSaving ? 'Đang lưu...' : 'Lưu'}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function DetailPanelBody({
  detail,
  draft,
  setDraft,
}: {
  detail: TableRowDetailResponse;
  draft: Record<string, unknown>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}) {
  const editableSet = new Set(detail.editable_columns || []);
  const computedNames = new Set(
    (detail.computed_columns || []).map((c) => String((c as Record<string, unknown>).name || '')),
  );
  const lookupNames = new Set(
    (detail.lookup_columns || []).map((l) => String((l as Record<string, unknown>).name || '')),
  );
  const sections = detail.sections || {};
  const assigned = new Set<string>();
  for (const cols of Object.values(sections)) {
    for (const c of cols) assigned.add(c);
  }
  const orphanCols = (detail.columns || []).filter((c) => !assigned.has(c));
  const renderGroup = (title: string | null, columnsInGroup: string[]) => (
    <div key={title || '__default__'} className="mb-4">
      {title ? (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </div>
      ) : null}
      <dl className="space-y-2">
        {columnsInGroup.map((col) => {
          const isEditable = editableSet.has(col);
          const isDerived = computedNames.has(col) || lookupNames.has(col);
          const draftValue = col in draft ? draft[col] : detail.row[col];
          const label = detail.column_labels?.[col] || col;
          return (
            <div key={col} className="grid grid-cols-3 gap-3">
              <dt className="text-xs font-medium text-slate-600">
                {label}
                {isDerived ? (
                  <span className="ml-1 text-[10px] text-indigo-500" title="Computed/Lookup">
                    ƒ
                  </span>
                ) : null}
              </dt>
              <dd className="col-span-2 text-sm text-slate-800">
                {isEditable && !isDerived ? (
                  <input
                    value={draftValue == null ? '' : String(draftValue)}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        [col]: event.target.value === '' ? null : event.target.value,
                      }))
                    }
                    className="h-8 w-full rounded border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                  />
                ) : (
                  <FormattedCell value={detail.row[col]} format={null} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
  return (
    <div>
      {Object.entries(sections).map(([label, columnsInGroup]) =>
        renderGroup(label, columnsInGroup),
      )}
      {orphanCols.length > 0 ? renderGroup(null, orphanCols) : null}
    </div>
  );
}

// Per-cell editable input. Renders a generic text input that commits on
// blur / Enter. We keep a local draft so the user can type freely before
// firing the autosave; if the parent updates the value externally (e.g.
// after a reload) the draft is rehydrated.
function TableCellInput({
  value,
  onCommit,
  placeholder,
}: {
  value: unknown;
  onCommit: (next: unknown) => void;
  placeholder?: string;
}) {
  const initial = value == null ? '' : String(value);
  const [draft, setDraft] = useState(initial);
  const lastValueRef = useRef(initial);

  useEffect(() => {
    const incoming = value == null ? '' : String(value);
    if (incoming !== lastValueRef.current) {
      lastValueRef.current = incoming;
      setDraft(incoming);
    }
  }, [value]);

  const commit = () => {
    if (draft === lastValueRef.current) return;
    lastValueRef.current = draft;
    // Empty string → null so the backend writes NULL rather than ''.
    onCommit(draft === '' ? null : draft);
  };

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === 'Escape') {
          setDraft(lastValueRef.current);
          (event.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className="h-8 w-full rounded border border-transparent bg-transparent px-2 text-sm outline-none hover:border-slate-200 focus:border-slate-400 focus:bg-white"
    />
  );
}

// ── Doc screen (consumes merges + footer_row) ───────────────────────────

function DocScreen({
  spec,
  token,
  workboardId,
}: {
  spec: DocScreenResponse;
  token: string;
  workboardId: number;
}) {
  return (
    <div className="w-full space-y-3 rounded-xl bg-white p-6 shadow-sm">
      {(spec.blocks || []).map((b, i) => (
        <DocBlock
          key={i}
          block={b}
          token={token}
          workboardId={workboardId}
          screenId={spec.screen_id}
          blockIndex={i}
        />
      ))}
    </div>
  );
}

function DocBlock({
  block,
  token,
  workboardId,
  screenId,
  blockIndex,
}: {
  block: Record<string, unknown>;
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
}) {
  const t = String(block.type || '');
  if (t === 'header') {
    const align = (block.align as string) || 'center';
    return (
      <div
        className={`mb-2 ${
          align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center'
        }`}
      >
        {block.title ? (
          <h2 className="text-xl font-bold text-slate-900">{String(block.title)}</h2>
        ) : null}
        {block.subtitle ? (
          <p className="text-sm text-slate-500">{String(block.subtitle)}</p>
        ) : null}
      </div>
    );
  }
  if (t === 'spacer') {
    const h = Number(block.height_mm || 4);
    return <div style={{ height: `${h * 2}px` }} />;
  }
  if (t === 'kv_grid') {
    const cols = Number(block.columns || 2);
    const items = (block.items as Array<{ label: string; value: string }>) || [];
    return (
      <div
        className="rounded-lg border border-slate-200 bg-slate-50 p-3"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '0.5rem 1rem',
        }}
      >
        {items.map((it, i) => (
          <div key={i}>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {it.label}
            </div>
            <div className="text-sm text-slate-800">{it.value}</div>
          </div>
        ))}
      </div>
    );
  }
  if (t === 'text') {
    const align = (block.align as string) || 'left';
    return (
      <p
        className={`text-sm text-slate-700 ${
          align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : ''
        }`}
      >
        {String(block.content || '')}
      </p>
    );
  }
  if (t === 'data_table') {
    return (
      <DocDataTable
        block={block}
        token={token}
        workboardId={workboardId}
        screenId={screenId}
        blockIndex={blockIndex}
      />
    );
  }
  if (t === 'signature') {
    const slots = (block.slots as Array<{ label?: string; role?: string }>) || [];
    if (!slots.length) return null;
    return (
      <div
        className="mt-8 grid gap-8"
        style={{ gridTemplateColumns: `repeat(${Math.min(slots.length, 4)}, minmax(0, 1fr))` }}
      >
        {slots.map((s, i) => (
          <div key={i} className="text-center text-sm text-slate-700">
            <div className="font-medium">{String(s.label || '')}</div>
            {s.role ? <div className="text-xs text-slate-500">{String(s.role)}</div> : null}
            <div className="mt-12 border-t border-slate-400 pt-1 text-[11px] text-slate-400">
              Ký &amp; ghi rõ họ tên
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (t === 'footer') {
    return (
      <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-2 text-xs text-slate-500">
        <span>{String(block.left || '')}</span>
        <span>{String(block.center || '')}</span>
        <span>{String(block.right || '')}</span>
      </div>
    );
  }
  return null;
}

function formatTotal(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

interface FooterRow {
  agg: string;
  label: string;
  values: Record<string, unknown>;
}

function normalizeFooterRows(footer: unknown): FooterRow[] {
  if (!footer || typeof footer !== 'object') return [];
  const obj = footer as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    return (obj.rows as Array<Record<string, unknown>>).map((fr) => ({
      agg: String(fr.agg ?? ''),
      label: String(fr.label ?? fr.agg ?? ''),
      values: (fr.values as Record<string, unknown>) || {},
    }));
  }
  // Legacy flat shape
  return [{ agg: 'sum', label: 'Tổng', values: obj }];
}

function normalizeColumnGroups(
  columns: string[],
  columnGroups: unknown,
): Array<{ label: string; columns: string[] }> {
  if (!Array.isArray(columnGroups) || columns.length === 0) return [];
  const order = new Map(columns.map((column, index) => [column, index]));
  const assigned = new Set<string>();
  const normalized: Array<{ label: string; columns: string[] }> = [];

  for (const raw of columnGroups) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String((raw as { label?: unknown }).label || '').trim();
    const rawColumns = Array.isArray((raw as { columns?: unknown }).columns)
      ? ((raw as { columns: unknown[] }).columns)
      : [];
    if (!label) continue;

    const cols = Array.from(
      new Set(
        rawColumns
          .map((column) => String(column || '').trim())
          .filter((column) => order.has(column) && !assigned.has(column)),
      ),
    ).sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));

    if (cols.length < 2) continue;
    const indices = cols.map((column) => order.get(column) ?? -1);
    const isContiguous = indices.every(
      (value, index) => index === 0 || value === indices[index - 1] + 1,
    );
    if (!isContiguous) continue;

    normalized.push({ label, columns: cols });
    cols.forEach((column) => assigned.add(column));
  }

  return normalized;
}

function buildHeaderRows(
  columns: string[],
  columnGroups: unknown,
  columnLabels: Record<string, string> = {},
): Array<Array<{ label: string; colSpan: number; rowSpan: number }>> {
  const groups = normalizeColumnGroups(columns, columnGroups);
  if (groups.length === 0) {
    return [columns.map((column) => ({ label: columnLabels[column] ?? column, colSpan: 1, rowSpan: 1 }))];
  }

  const rows: Array<Array<{ label: string; colSpan: number; rowSpan: number }>> = [[], []];
  const groupStart = new Map(groups.map((group) => [group.columns[0], group]));

  let index = 0;
  while (index < columns.length) {
    const column = columns[index];
    const group = groupStart.get(column);
    if (!group) {
      rows[0].push({ label: columnLabels[column] ?? column, colSpan: 1, rowSpan: 2 });
      index += 1;
      continue;
    }
    rows[0].push({
      label: group.label,
      colSpan: group.columns.length,
      rowSpan: 1,
    });
    rows[1].push(
      ...group.columns.map((member) => ({ label: columnLabels[member] ?? member, colSpan: 1, rowSpan: 1 })),
    );
    index += group.columns.length;
  }

  return rows;
}

type SyncTriggerSpec = {
  id: string;
  label?: string;
  confirm_message?: string | null;
  webhook_ids?: string[];
  visible_for_roles?: string[];
};

type GroupRun = {
  run_id: string;
  status: string;
  webhook_id: string;
  webhook_name?: string | null;
  total_rows?: number;
  total_batches?: number;
  completed_batches?: number;
  failed_batches?: number;
  last_response_status?: number | null;
  last_error?: string | null;
};

function BlockSyncControls({
  triggers,
  token,
  workboardId,
  screenId,
  blockIndex,
}: {
  triggers: SyncTriggerSpec[];
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
}) {
  const [busyTriggerId, setBusyTriggerId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [runs, setRuns] = useState<GroupRun[]>([]);
  const [aggStatus, setAggStatus] = useState<string>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successFlash, setSuccessFlash] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const poll = useCallback(
    async (gid: string) => {
      try {
        const result = await workspaceApi.getSyncGroup(token, workboardId, gid);
        setRuns(result.runs);
        setAggStatus(result.status);
        if (['success', 'failed', 'partial', 'cancelled'].includes(result.status)) {
          stopPolling();
          setBusyTriggerId(null);
          if (result.status === 'success') {
            setSuccessFlash('Đã đồng bộ xong.');
            setTimeout(() => setSuccessFlash(null), 4000);
          }
        } else {
          pollRef.current = setTimeout(() => poll(gid), 1000);
        }
      } catch (err) {
        const apiError = err as ApiErrorLike;
        setErrorMsg(
          typeof apiError.response?.data?.detail === 'string'
            ? apiError.response.data.detail
            : 'Không lấy được trạng thái đồng bộ.',
        );
        stopPolling();
        setBusyTriggerId(null);
      }
    },
    [token, workboardId],
  );

  const onTrigger = async (trigger: SyncTriggerSpec) => {
    if (busyTriggerId) return;
    if (trigger.confirm_message) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(trigger.confirm_message)) return;
    }
    setErrorMsg(null);
    setSuccessFlash(null);
    setBusyTriggerId(trigger.id);
    setAggStatus('running');
    try {
      const result = await workspaceApi.triggerBlockSync(
        token,
        workboardId,
        screenId,
        blockIndex,
        trigger.id,
      );
      setGroupId(result.group_id);
      setRuns(
        result.runs.map((r) => ({
          ...r,
          total_rows: 0,
          total_batches: 0,
          completed_batches: 0,
          failed_batches: 0,
        })),
      );
      poll(result.group_id);
    } catch (err) {
      const apiError = err as ApiErrorLike;
      setErrorMsg(
        typeof apiError.response?.data?.detail === 'string'
          ? apiError.response.data.detail
          : 'Không khởi chạy được đồng bộ.',
      );
      setAggStatus('idle');
      setBusyTriggerId(null);
    }
  };

  const onCancel = async () => {
    if (!groupId) return;
    try {
      await workspaceApi.cancelSyncGroup(token, workboardId, groupId);
    } catch {
      // best-effort — worker will still poll status
    }
  };

  if (!triggers.length) return null;

  const inFlight =
    aggStatus === 'running' || aggStatus === 'pending';
  const totalBatches = runs.reduce((s, r) => s + (r.total_batches || 0), 0);
  const doneBatches = runs.reduce(
    (s, r) => s + (r.completed_batches || 0) + (r.failed_batches || 0),
    0,
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {triggers.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTrigger(t)}
            disabled={inFlight && busyTriggerId !== t.id ? true : busyTriggerId === t.id}
            className="flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            title={t.label || 'Đồng bộ'}
          >
            {busyTriggerId === t.id ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span>
              {busyTriggerId === t.id ? 'Đang đồng bộ…' : t.label || 'Đồng bộ'}
            </span>
          </button>
        ))}
        {inFlight && groupId && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
            title="Huỷ đồng bộ"
          >
            <XCircle className="h-3.5 w-3.5" />
            <span>Huỷ</span>
          </button>
        )}
      </div>
      {inFlight && runs.length > 0 && (
        <p className="text-[11px] text-slate-500">
          {doneBatches}/{totalBatches || '?'} batch · {runs.length} webhook
        </p>
      )}
      {!inFlight && aggStatus !== 'idle' && runs.length > 0 && (
        <p
          className={`text-[11px] ${
            aggStatus === 'success'
              ? 'text-emerald-600'
              : aggStatus === 'cancelled'
                ? 'text-slate-500'
                : 'text-rose-600'
          }`}
        >
          {aggStatus === 'success' && (
            <>
              <CheckCircle2 className="mr-1 inline h-3 w-3" />
              Đã đồng bộ xong ({doneBatches} batch)
            </>
          )}
          {aggStatus === 'cancelled' && 'Đã huỷ'}
          {aggStatus === 'failed' && (
            <>
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Đồng bộ thất bại
            </>
          )}
          {aggStatus === 'partial' && (
            <>
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Một số webhook thất bại
            </>
          )}
        </p>
      )}
      {successFlash && !inFlight && (
        <p className="text-[11px] text-emerald-600">{successFlash}</p>
      )}
      {errorMsg && <p className="text-[11px] text-rose-600">{errorMsg}</p>}
      {!inFlight && runs.some((r) => r.last_error) && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-rose-600">
          {runs
            .filter((r) => r.last_error)
            .map((r) => (
              <li key={r.run_id}>
                <span className="font-medium">{r.webhook_name || r.webhook_id}:</span>{' '}
                {r.last_error}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function DocDataTable({
  block,
  token,
  workboardId,
  screenId,
  blockIndex,
}: {
  block: Record<string, unknown>;
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
}) {
  const data = (block.data as Record<string, unknown>) || {};
  const cols = (data.columns as string[]) || [];
  const rows = (data.rows as Array<Record<string, unknown>>) || [];
  const footer = (data.footer_row as Record<string, unknown> | null) || null;
  const merges = (data.merges as Array<Record<string, unknown>>) || [];
  const columnLabels = {
    ...(data.column_labels as Record<string, string> | null),
    ...(block.column_labels as Record<string, string> | null),
  } as Record<string, string>;
  const headerRows = buildHeaderRows(
    cols,
    data.column_groups ?? block.column_groups ?? [],
    columnLabels,
  );
  const title = block.title ? String(block.title) : null;
  const allowExport = Boolean(block.allow_export_excel);
  const syncTriggers = (Array.isArray(block.sync_triggers)
    ? (block.sync_triggers as SyncTriggerSpec[])
    : []
  ).filter((t) => t && t.id && (t.webhook_ids?.length ?? 0) > 0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const onExport = async () => {
    if (exporting) return;
    setExportError(null);
    setExporting(true);
    try {
      const { blob, filename } = await workspaceApi.exportDocBlockExcel(
        token,
        workboardId,
        screenId,
        blockIndex,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: unknown) {
      const apiError = err as ApiErrorLike;
      setExportError(
        typeof apiError.response?.data?.detail === 'string'
          ? apiError.response.data.detail
          : 'Không xuất được Excel.',
      );
    } finally {
      setExporting(false);
    }
  };

  const rowspanMap = new Map<string, number>();
  const hidden = new Set<string>();
  for (const m of merges) {
    const col = String(m.column);
    const start = Number(m.row_start || 0);
    const span = Number(m.row_span || 0);
    if (!col || span < 2) continue;
    rowspanMap.set(`${start}:${col}`, span);
    for (let off = 1; off < span; off++) hidden.add(`${start + off}:${col}`);
  }

  return (
    <div>
      {(title || allowExport || syncTriggers.length > 0) && (
        <div className="mb-1 flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{title || ''}</h3>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {allowExport && (
                <button
                  type="button"
                  onClick={onExport}
                  disabled={exporting}
                  className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Tải Excel"
                >
                  {exporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  <span>{exporting ? 'Đang xuất…' : 'Xuất Excel'}</span>
                </button>
              )}
            </div>
            {syncTriggers.length > 0 && (
              <BlockSyncControls
                triggers={syncTriggers}
                token={token}
                workboardId={workboardId}
                screenId={screenId}
                blockIndex={blockIndex}
              />
            )}
          </div>
        </div>
      )}
      {exportError && (
        <p className="mb-2 text-xs text-rose-600">{exportError}</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            {headerRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="bg-slate-100">
                {row.map((cell, cellIndex) => (
                  <th
                    key={`${rowIndex}:${cellIndex}:${cell.label}`}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    className="border border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-700"
                  >
                    {cell.label}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50">
                {cols.map((c) => {
                  if (hidden.has(`${i}:${c}`)) return null;
                  const span = rowspanMap.get(`${i}:${c}`);
                  return (
                    <td
                      key={c}
                      rowSpan={span}
                      className={`border border-slate-200 px-3 py-1.5 text-slate-700 ${
                        span ? 'bg-slate-50 align-middle font-medium' : ''
                      }`}
                    >
                      {row[c] == null ? '' : String(row[c])}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot>
              {normalizeFooterRows(footer).map((fr, frIdx) => (
                <tr key={frIdx} className="bg-slate-50">
                  {cols.map((c, ci) => {
                    const v = (fr.values as Record<string, unknown>)[c];
                    const isLabelCell = v == null && ci === 0 && fr.label;
                    return (
                      <td
                        key={c}
                        className={`border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 ${
                          frIdx === 0 ? 'border-t-2 border-t-slate-400' : ''
                        }`}
                      >
                        {isLabelCell ? String(fr.label) : formatTotal(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
