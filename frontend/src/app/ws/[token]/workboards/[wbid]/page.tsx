/**
 * Public mini-app runtime — adaptive shell.
 *
 * Renders a single workboard as a self-contained mini-app:
 *  - top header with branding + logged-in user
 *  - adaptive nav: bottom-nav on mobile (auto), sidebar on desktop (auto),
 *    user can override via the device toggle in the header
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
  BarChart3,
  Bell,
  Calendar,
  CheckCircle2,
  ClipboardEdit,
  ClipboardList,
  Download,
  Eye,
  Factory,
  FileText,
  Folder,
  Grid3x3,
  Home,
  Image as ImageIcon,
  LayoutDashboard,
  Laptop,
  ListChecks,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MoreHorizontal,
  Phone,
  PieChart,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
  Settings,
  Smartphone,
  Sparkles,
  Star,
  Table2,
  Tablet,
  Truck,
  Users,
  XCircle,
} from 'lucide-react';

import {
  AppShellResponse,
  AppShellScreenStub,
  DashboardScreenResponse,
  DocScreenResponse,
  FormScreenResponse,
  ListScreenResponse,
  ScreenResponse,
  workspaceApi,
} from '@/lib/api/workspace';
import {
  getPublicSession,
  publicDashboardApi,
  savePublicSession,
} from '@/lib/api/public';
import { evaluateTruthy } from '@/lib/wb-expr';

const ICON_MAP: Record<string, React.ElementType> = {
  // Original set
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Factory,
  FileText,
  ListChecks,
  PlusCircle,
  // Extended set for builder icon picker
  Bell,
  Calendar,
  ClipboardEdit,
  Eye,
  Folder,
  Grid3x3,
  Home,
  Image: ImageIcon,
  ImageIcon,
  LayoutDashboard,
  Mail,
  Map: MapPin,
  MapPin,
  MoreHorizontal,
  Phone,
  PieChart,
  Search,
  Settings,
  Star,
  Table: Table2,
  Table2,
  Truck,
  Users,
};

function pickIcon(name?: string | null): React.ElementType {
  if (name && ICON_MAP[name]) return ICON_MAP[name];
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
  const [deviceOverride, setDeviceOverride] = useState<DeviceMode | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const effectiveDevice: DeviceMode = deviceOverride ?? device;

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
  // Mobile  → bottom_nav (always — drawer kind not implemented yet)
  // Tablet  → top_tabs (better for landscape, no big sidebar wasted)
  // Desktop → whatever the workboard config picked (sidebar | top_tabs)
  const isSidebar = effectiveDevice === 'desktop' && shell.nav.desktop_kind === 'sidebar';
  const isTopTabs =
    (effectiveDevice === 'desktop' && shell.nav.desktop_kind === 'top_tabs') ||
    effectiveDevice === 'tablet';
  const isBottomNav = effectiveDevice === 'mobile';

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <Header
        appName={appName}
        accent={accent}
        logoUrl={shell.branding.logo_url}
        device={effectiveDevice}
        override={deviceOverride}
        onDeviceChange={setDeviceOverride}
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
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────────

function Header({
  appName,
  accent,
  logoUrl,
  device,
  override,
  onDeviceChange,
  onLogout,
  onBackToMenu,
}: {
  appName: string;
  accent: string;
  logoUrl?: string | null;
  device: DeviceMode;        // currently effective layout
  override: DeviceMode | null;  // user override; null = auto
  onDeviceChange: (d: DeviceMode | null) => void;
  onLogout: () => void;
  onBackToMenu: () => void;
}) {
  // The "active" state on each chip indicates which mode is currently
  // applied (so the user can see what auto resolved to). The Auto chip
  // gets a visible highlight when no override is set.
  const isAuto = override === null;

  const chip = (
    key: DeviceMode | 'auto',
    label: string,
    icon: React.ReactNode,
    title: string,
  ) => {
    const active =
      key === 'auto' ? isAuto : !isAuto && override === key;
    return (
      <button
        type="button"
        onClick={() => onDeviceChange(key === 'auto' ? null : (key as DeviceMode))}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
          active
            ? 'bg-slate-900 text-white'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
        }`}
        title={title}
      >
        {icon}
        {label}
      </button>
    );
  };

  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <button
          onClick={onBackToMenu}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
          title="Trở lại menu workspace"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
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

        <div className="hidden items-center gap-1 rounded-md border border-slate-200 p-0.5 sm:flex">
          {chip(
            'auto',
            isAuto ? `Auto (${device})` : 'Auto',
            <Sparkles className="h-3.5 w-3.5" />,
            'Tự động theo kích thước cửa sổ',
          )}
          <span className="mx-0.5 h-4 w-px bg-slate-200" />
          {chip('mobile', 'Mobile', <Smartphone className="h-3.5 w-3.5" />, 'Bottom-nav cho điện thoại')}
          {chip('tablet', 'Tablet', <Tablet className="h-3.5 w-3.5" />, 'Top-tabs cho tablet')}
          {chip('desktop', 'Desktop', <Laptop className="h-3.5 w-3.5" />, 'Sidebar cho máy tính')}
        </div>

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
  onNavigate,
}: {
  token: string;
  workboardId: number;
  screenId: string;
  shared: Record<string, unknown>;
  accent: string;
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
  if (data.kind === 'list') {
    return (
      <ListScreen
        spec={data}
        token={token}
        workboardId={workboardId}
        accent={accent}
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
      const required = !!f.required;
      const v = values[col];
      if (required && (v === undefined || v === null || v === '')) {
        setSubmitError(`Vui lòng điền "${String(f.label || col)}"`);
        return false;
      }
    }
    setSubmitError(null);
    return true;
  };

  const goNextPage = () => {
    if (!validateCurrentPage()) return;
    setCurrentPage((p) => Math.min(p + 1, pages.length));
  };
  const goPrevPage = () => setCurrentPage((p) => Math.max(p - 1, 1));

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

          {isMultiPage && currentPage < pages.length ? (
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
}: {
  field: RuntimeField;
  lookups: Record<string, Array<{ label: string; value: unknown }>>;
  value: unknown;
  onChange: (v: unknown) => void;
  evalCtx?: RuntimeEvalCtx;
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
  const required = requiredIfExpr && evalCtx
    ? evaluateTruthy(requiredIfExpr, evalCtx, false)
    : !!field.required;
  const readonly = (readonlyIfExpr && evalCtx
    ? evaluateTruthy(readonlyIfExpr, evalCtx, false)
    : false) || !!field.readonly;
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

// ── List screen ──────────────────────────────────────────────────────────

function ListScreen({
  spec,
  token,
  workboardId,
  accent,
  onAction,
}: {
  spec: ListScreenResponse;
  token: string;
  workboardId: number;
  accent: string;
  onAction: (
    action: { go_to_screen?: string | null; carry?: string[] },
    row: Record<string, unknown>,
  ) => void;
}) {
  type RuntimeFilter = {
    column: string;
    kind: 'text' | 'select' | 'date_range' | 'number_range';
    label?: string | null;
  };

  const [current, setCurrent] = useState<ListScreenResponse>(spec);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [filterLoading, setFilterLoading] = useState(false);

  useEffect(() => {
    setCurrent(spec);
    setFilterValues({});
  }, [spec]);

  const cols = current.columns ?? [];
  const rows = current.rows ?? [];
  const lv = (current.list_view as Record<string, unknown>) || {};
  const colLabels = (current.column_labels as Record<string, string>) || {};
  const configuredFilters = ((lv.filters as RuntimeFilter[] | undefined) || []).filter(
    (item) => item?.column,
  );
  const rowActions =
    (lv.row_actions as Array<{
      id: string;
      label: string;
      go_to_screen?: string | null;
      carry?: string[];
    }>) ?? [];
  const empty = (lv.empty_state_message as string | undefined) || 'No data yet.';

  const buildApiFilters = (values: Record<string, string>) => {
    const apiFilters: Array<Record<string, unknown>> = [];
    configuredFilters.forEach((filter, index) => {
      const key = String(index);
      if (filter.kind === 'date_range' || filter.kind === 'number_range') {
        const from = values[`${key}:from`];
        const to = values[`${key}:to`];
        if (from || to) {
          apiFilters.push({
            field: filter.column,
            operator: 'between',
            value: [from || null, to || null],
          });
        }
        return;
      }
      const value = values[key];
      if (!value) return;
      apiFilters.push({
        field: filter.column,
        operator: filter.kind === 'text' ? 'contains' : 'eq',
        value,
      });
    });
    return apiFilters;
  };

  const reloadRows = async (values: Record<string, string>) => {
    setFilterLoading(true);
    try {
      const next = await workspaceApi.listScreenRows(token, workboardId, current.screen_id, {
        page: 1,
        page_size: Number(lv.page_size || current.page_size || 50),
        filters: buildApiFilters(values),
      });
      setCurrent((prev) => ({ ...prev, ...next }));
      setFilterValues(values);
    } finally {
      setFilterLoading(false);
    }
  };

  const applyFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void reloadRows(filterValues);
  };

  const clearFilters = () => {
    void reloadRows({});
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
          onSubmit={applyFilters}
          className="border-b border-slate-100 bg-slate-50/70 px-4 py-3"
        >
          <div className="grid gap-2 md:grid-cols-3">
            {configuredFilters.map((filter, index) => {
              const key = String(index);
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
                  <span className="mb-1 block text-xs font-medium text-slate-600">
                    {label}
                  </span>
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
              onClick={clearFilters}
              disabled={filterLoading || Object.keys(filterValues).length === 0}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </form>
      )}
      {rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500">{empty}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {cols.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 text-left text-xs font-semibold text-slate-600"
                  >
                    {colLabels[c] ?? c}
                  </th>
                ))}
                {rowActions.length > 0 && (
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-600">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 text-slate-700">
                      <CellDisplay value={r[c]} />
                    </td>
                  ))}
                  {rowActions.length > 0 && (
                    <td className="px-3 py-2 text-right">
                      {rowActions.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => onAction(a, r)}
                          className="ml-2 rounded-md px-2 py-1 text-xs font-medium text-white"
                          style={{ backgroundColor: accent }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
