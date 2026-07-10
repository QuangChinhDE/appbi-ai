/**
 * Public mini-app runtime — adaptive shell.
 *
 * Renders a single workboard as a self-contained mini-app:
 *  - top header with branding + logged-in user
 *  - adaptive nav: bottom-nav/drawer only on real phones (<768px); every
 *    wider viewport — tablets AND desktops, incl. OS-scaled laptops that
 *    report <1024 CSS px — follows the workboard's desktop_kind
 *    (sidebar | top_tabs). Auto-detected from the viewport; no manual device
 *    toggle in the published runtime (the builder's preview pane has its own)
 *  - active screen content rendered from the per-screen API
 *  - shared_context propagated through ``after_submit.go_to_screen`` so
 *    successive screens know which shift / row the user is working with
 */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';
// Leaflet base stylesheet for the `map` form widget. Side-effect import (the
// standard way to load Leaflet CSS under webpack) — dynamic import() of a CSS
// path does not reliably inject styles and breaks TS module resolution.
import 'leaflet/dist/leaflet.css';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Camera,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  ClipboardList,
  Download,
  Factory,
  Loader2,
  LogOut,
  MapPin,
  Menu,
  Mic,
  MoreHorizontal,
  Plus,
  Printer,
  RefreshCw,
  ScanLine,
  Send,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';

import {
  AppShellResponse,
  AppShellScreenStub,
  DashboardScreenResponse,
  DocScreenResponse,
  FormScreenResponse,
  PrintTemplate,
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
import { evaluateTruthy, evaluateExpr } from '@/lib/wb-expr';
import {
  themeVars,
  backgroundStyle,
  darkModeCss,
  resolveMode,
  type WbTheme,
} from '@/lib/wb-theme';
import { enqueueSubmit, newOpId } from '@/lib/offline/queue';
import { isNetworkError } from '@/lib/offline/sync';

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
  capture_only?: unknown;
  max_items?: unknown;
  unit?: unknown;
  formula?: unknown;
  status_config?: { states?: Array<{ value: string; label?: string | null; color?: string | null }>; editable_by_roles?: string[] };
  lookup?: Record<string, unknown>;
}

/** A lookup option resolved by the backend. `geometry`/`lat`/`lng` are only
 * populated for the map widget; `filter` for cascading select — select/lookup
 * widgets ignore keys they don't use. */
interface LookupOption {
  label: string;
  value: unknown;
  geometry?: unknown;
  lat?: unknown;
  lng?: unknown;
  filter?: unknown;
}

interface RuntimeFormSpecExtras {
  pages?: RuntimeFormPage[];
  sections?: string[];
}

/** A resolved nav section (one inner "Workspace") = a label + its screens. */
interface NavSection {
  id: string;
  label: string;
  icon?: string | null;
  screens: AppShellScreenStub[];
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
        // Warm the offline cache: while online, fetch every screen once so the
        // service worker caches each screen's GET. Field workers open the app,
        // lose signal on-site, then fill MANY forms across several screens (and
        // read reports) entirely offline — each entry is queued + synced on
        // reconnect. Fire-and-forget; the SW (network-first → cache) stores them.
        if (typeof navigator === 'undefined' || navigator.onLine) {
          void (async () => {
            for (const sc of s.screens) {
              if (!alive) return;
              try {
                await workspaceApi.getScreen(token, workboardId, sc.id);
              } catch {
                /* offline / transient — the SW caches whatever succeeds */
              }
            }
          })();
        }
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
        // Deep-link: read BOTH the URL query (?screen=…&col=val) and the hash
        // (#screen=…) so a scanned QR that encodes a full URL can open a
        // specific screen AND prefill it. Everything other than `screen`
        // becomes prefill seed — but buildInitial() only keeps keys that are
        // real fields/PK on the destination, and RLS still governs the submit,
        // so an attacker cannot seed protected columns.
        const { deepScreen, seed } = (() => {
          if (typeof window === 'undefined') return { deepScreen: null as string | null, seed: {} as Record<string, string> };
          const out: Record<string, string> = {};
          const collect = (qs: string) => {
            try {
              new URLSearchParams(qs).forEach((v, k) => { if (k && v !== '') out[k] = v; });
            } catch { /* ignore malformed */ }
          };
          collect(window.location.search.replace(/^\?/, ''));
          const hash = window.location.hash.replace(/^#/, '');
          // hash may be "screen=x&y=z" (query-like) — parse the same way
          collect(hash);
          const screen = out.screen || null;
          delete out.screen;
          return { deepScreen: screen, seed: out };
        })();
        if (Object.keys(seed).length > 0) setShared((curr) => ({ ...curr, ...seed }));
        const knownScreen = deepScreen && s.screens.some((sc) => sc.id === deepScreen);
        // Deep-link may target an off-nav screen (e.g. a scan-only status form);
        // the backend still enforces per-screen visibility/hidden/RLS, so accept
        // any existing screen id here and fall back to the nav default otherwise.
        if (knownScreen) {
          setActiveScreenId(deepScreen as string);
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

  // Inner "Workspaces" = named groups of screens. When the shell carries
  // screen_groups, the nav becomes 2-level (group → screens). Any visible nav
  // screen not placed in a group still appears under a "Khác" section so it
  // never silently vanishes. When there are no groups, this is null and the
  // nav stays exactly flat (legacy behaviour).
  //
  // Order within a group follows the FLAT nav order (``navItems``), not the
  // raw ``screen_ids`` array — so the builder's Screens-list order is the
  // single source of nav order and assigning a screen to a workspace never
  // silently reshuffles it. ``screen_ids`` is treated purely as membership.
  // Intersecting with ``navItems`` also drops any member that isn't nav-visible
  // (show_in_nav=false or role-hidden) for free.
  const navSections: NavSection[] | null = useMemo(() => {
    const groups = shell?.screen_groups;
    if (!shell || !groups || groups.length === 0) return null;
    const sections: NavSection[] = [];
    const placed = new Set<string>();
    for (const g of groups) {
      const idSet = new Set(g.screen_ids);
      // First-wins membership: skip any screen already claimed by an earlier
      // group so a (data-only) screen-in-two-groups can't double-render.
      const screens = navItems.filter((s) => idSet.has(s.id) && !placed.has(s.id));
      screens.forEach((s) => placed.add(s.id));
      if (screens.length > 0) {
        sections.push({ id: g.id, label: g.label, icon: g.icon ?? null, screens });
      }
    }
    const ungrouped = navItems.filter((s) => !placed.has(s.id));
    if (ungrouped.length > 0) {
      sections.push({ id: '__other__', label: 'Khác', icon: null, screens: ungrouped });
    }
    return sections.length > 0 ? sections : null;
  }, [shell, navItems]);

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
  // ── Theme (design system) ─────────────────────────────────────────────
  const theme = shell.branding as WbTheme;
  const mode = resolveMode(theme.theme);
  setRuntimeMediaCap(shell.media_max_kb);
  const rootThemeStyle = {
    ...themeVars(theme, mode),
    ...backgroundStyle(theme.background, 'var(--wb-bg)'),
  };

  // ── Layout decision ───────────────────────────────────────────────────
  // Only a genuine PHONE (<768px) gets the mobile nav (bottom_nav | drawer).
  // Everything wider — real tablets AND every desktop window, including
  // laptops whose OS display-scaling makes them report <1024 CSS px — follows
  // the workboard's desktop_kind. This stops a normal/scaled/half-width
  // desktop window from being mistaken for a "tablet" and dumped onto the
  // top-tabs layout (the reported bug).
  const isMobile = effectiveDevice === 'mobile';
  const isSidebar = !isMobile && shell.nav.desktop_kind === 'sidebar';
  const isTopTabs = !isMobile && shell.nav.desktop_kind === 'top_tabs';
  const isDrawer = isMobile && shell.nav.mobile_kind === 'drawer';
  const isBottomNav = isMobile && !isDrawer;

  return (
    <div
      className="wb-app flex min-h-screen flex-col bg-slate-50"
      data-theme={mode}
      style={rootThemeStyle}
    >
      <style>{darkModeCss()}</style>
      {/* Print isolation: when printLabel() runs it flags <body>, and only the
          element marked .wb-print-target (a QR label / doc) stays visible. */}
      <style>{`@media print {
        html, body {
          background: #fff !important;
        }
        .wb-app {
          display: block !important;
          min-height: auto !important;
          background: #fff !important;
        }
        .wb-app > header,
        .wb-app > nav,
        .wb-app > .flex > aside {
          display: none !important;
        }
        .wb-app > .flex {
          display: block !important;
        }
        .wb-app main {
          display: block !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .wb-print-target {
          width: 100% !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          background: #fff !important;
        }
        .wb-print-target * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        body.wb-printing > * { visibility: hidden !important; }
        body.wb-printing .wb-print-target,
        body.wb-printing .wb-print-target * { visibility: visible !important; }
        body.wb-printing .wb-print-target {
          position: absolute !important; left: 0; top: 0; width: 100%;
          box-shadow: none !important; border: none !important;
        }
      }`}</style>
      <Header
        appName={appName}
        accent={accent}
        logoUrl={shell.branding.logo_url}
        logoData={shell.branding.logo_data}
        logoLayout={shell.branding.logo_layout}
        token={token}
        workboardId={workboardId}
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
          sections={navSections}
          activeId={activeScreenId}
          onSelect={(id) => goToScreen(id)}
          accent={accent}
        />
      )}

      <div className="flex min-w-0 flex-1">
        {isSidebar && (
          <Sidebar
            items={navItems}
            sections={navSections}
            activeId={activeScreenId}
            onSelect={(id) => goToScreen(id)}
            accent={accent}
          />
        )}
        <main
          className={`min-w-0 flex-1 ${isBottomNav ? 'pb-20' : 'pb-6'} px-3 pt-3 sm:px-6 sm:pt-4`}
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
          sections={navSections}
          activeId={activeScreenId}
          onSelect={(id) => goToScreen(id)}
          accent={accent}
        />
      )}

      {isDrawer && (
        <MobileDrawer
          items={navItems}
          sections={navSections}
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
  sections,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  sections?: NavSection[] | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  const [open, setOpen] = useState(false);
  const allScreens = sections ? sections.flatMap((s) => s.screens) : items;
  const active = allScreens.find((s) => s.id === activeId);
  const renderBtn = (s: AppShellScreenStub) => (
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
  );
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
            {sections && sections.length > 0 ? (
              <div className="space-y-3">
                {sections.map((sec) => {
                  const SecIcon = sec.icon ? pickIcon(sec.icon) : null;
                  return (
                    <div key={sec.id} className="space-y-1">
                      <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        {SecIcon && <SecIcon className="h-3 w-3 shrink-0" />}
                        <span className="truncate">{sec.label}</span>
                      </div>
                      {sec.screens.map(renderBtn)}
                    </div>
                  );
                })}
              </div>
            ) : (
              items.map(renderBtn)
            )}
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
  logoData,
  logoLayout,
  token,
  workboardId,
  showBackToMenu = false,
  onLogout,
  onBackToMenu,
}: {
  appName: string;
  accent: string;
  logoUrl?: string | null;
  logoData?: string | null;
  logoLayout?: 'mark' | 'wide' | null;
  token: string;
  workboardId: number;
  showBackToMenu?: boolean;
  onLogout: () => void;
  onBackToMenu: () => void;
}) {
  const logoSrc = logoData || logoUrl;
  const wideLogo = logoLayout === 'wide';
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
          className={`flex h-9 shrink-0 items-center justify-center overflow-hidden rounded-lg ${
            wideLogo ? 'w-20 bg-white p-1 ring-1 ring-slate-200' : 'w-9'
          }`}
          style={{ backgroundColor: logoSrc ? undefined : accent }}
        >
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt="" className="h-full w-full object-contain" />
          ) : (
            <Factory className="h-4 w-4 text-white" />
          )}
        </div>
        <h1 className="flex-1 truncate text-base font-semibold text-slate-900">
          {appName}
        </h1>

        <PushToggle token={token} workboardId={workboardId} accent={accent} />

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

// ── Web Push enable toggle (C13) ─────────────────────────────────────────
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function PushToggle({
  token,
  workboardId,
  accent,
}: {
  token: string;
  workboardId: number;
  accent: string;
}) {
  const [state, setState] = useState<'hidden' | 'idle' | 'on' | 'busy'>('hidden');

  useEffect(() => {
    let alive = true;
    (async () => {
      if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
      try {
        const cfg = await workspaceApi.pushConfig(token);
        if (!alive || !cfg.enabled || !cfg.public_key) return;
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        setState(existing ? 'on' : 'idle');
      } catch {
        /* push not available — keep hidden */
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, workboardId]);

  const enable = async () => {
    setState('busy');
    try {
      const cfg = await workspaceApi.pushConfig(token);
      if (!cfg.enabled || !cfg.public_key) {
        setState('hidden');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState('idle');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.public_key) as unknown as BufferSource,
        }));
      await workspaceApi.pushSubscribe(token, workboardId, sub.toJSON());
      await workspaceApi.pushTest(token, workboardId);
      setState('on');
    } catch {
      setState('idle');
    }
  };

  if (state === 'hidden') return null;
  return (
    <button
      onClick={enable}
      disabled={state === 'busy' || state === 'on'}
      title={state === 'on' ? 'Đã bật thông báo' : 'Bật thông báo'}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-70"
      style={{ borderColor: state === 'on' ? accent : '#e2e8f0', color: state === 'on' ? accent : '#475569' }}
    >
      {state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{state === 'on' ? 'Đã bật' : 'Thông báo'}</span>
    </button>
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
      title={label}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        active ? 'font-semibold' : 'text-slate-600 hover:bg-slate-100'
      }`}
      style={active ? { backgroundColor: `${accent}18`, color: accent } : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function Sidebar({
  items,
  sections,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  sections?: NavSection[] | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  const renderBtn = (s: AppShellScreenStub) => (
    <NavBtn
      key={s.id}
      active={s.id === activeId}
      accent={accent}
      onClick={() => onSelect(s.id)}
      icon={pickIcon(s.icon)}
      label={s.title}
      layout="sidebar"
    />
  );
  return (
    <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-3 md:block">
      {sections && sections.length > 0 ? (
        <div className="space-y-4">
          {sections.map((sec) => {
            const SecIcon = sec.icon ? pickIcon(sec.icon) : null;
            return (
              <div key={sec.id} className="space-y-1">
                <div className="flex items-center gap-1.5 px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {SecIcon && <SecIcon className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{sec.label}</span>
                </div>
                {sec.screens.map(renderBtn)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1">{items.map(renderBtn)}</div>
      )}
    </aside>
  );
}

function TopTabs({
  items,
  sections,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  sections?: NavSection[] | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  // Grouped (2-tier) when workspaces exist: row 1 = workspace tabs, row 2 =
  // the active workspace's screens. The active workspace is whichever one
  // contains the active screen; clicking a workspace jumps to its first
  // screen. Falls back to a single flat row when there are no groups.
  if (sections && sections.length > 0) {
    const activeSection =
      sections.find((sec) => sec.screens.some((s) => s.id === activeId)) ?? sections[0];
    return (
      <div className="border-b border-slate-200 bg-white">
        {/* Tier 1 — workspaces */}
        <nav className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-4">
          {sections.map((sec) => {
            const SecIcon = sec.icon ? pickIcon(sec.icon) : null;
            const isActive = sec.id === activeSection.id;
            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => {
                  if (sec.screens[0]) onSelect(sec.screens[0].id);
                }}
                title={sec.label}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                  isActive ? '' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
                style={isActive ? { borderColor: accent, color: accent } : undefined}
              >
                {SecIcon && <SecIcon className="h-3.5 w-3.5 shrink-0" />}
                <span className="max-w-[160px] truncate">{sec.label}</span>
              </button>
            );
          })}
        </nav>
        {/* Tier 2 — screens of the active workspace */}
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto border-t border-slate-100 bg-slate-50/60 px-4">
          {activeSection.screens.map((s) => (
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
  sections,
  activeId,
  onSelect,
  accent,
}: {
  items: AppShellScreenStub[];
  sections?: NavSection[] | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  const [showMore, setShowMore] = useState(false);
  // Four primary items keeps touch targets readable on small phones; the rest
  // live in the More sheet instead of squeezing labels into tiny columns.
  const MAX_VISIBLE = items.length > 4 ? 4 : items.length;
  const visible = items.slice(0, MAX_VISIBLE);
  const overflow = items.slice(MAX_VISIBLE);
  const hasOverflow = overflow.length > 0;
  const overflowActive = overflow.some((s) => s.id === activeId);

  // The bottom bar is space-constrained, so workspace structure lives in the
  // "More" sheet. Two modes:
  //  - 2+ workspaces (grouped): always offer "More" and show the FULL grouped
  //    list there — otherwise a small multi-workspace app (all screens fit the
  //    primary row) would silently lose its grouping on mobile.
  //  - otherwise: legacy behaviour — "More" only when there's slice overflow,
  //    listing just the overflow screens (grouped by section when groups exist).
  const grouped = !!(sections && sections.length > 1);
  const overflowIds = new Set(overflow.map((s) => s.id));
  const sheetSections: NavSection[] | null = grouped
    ? sections!
    : sections && sections.length > 0
      ? sections
          .map((sec) => ({
            ...sec,
            screens: sec.screens.filter((s) => overflowIds.has(s.id)),
          }))
          .filter((sec) => sec.screens.length > 0)
      : null;
  const showMoreButton = grouped || hasOverflow;
  // When grouped the sheet holds every screen, so "More" is the active surface
  // whenever the current screen isn't one of the quick-access primary items.
  const moreActive = grouped ? !visible.some((s) => s.id === activeId) : overflowActive;

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
              {sheetSections
                ? sheetSections.map((sec) => {
                    const SecIcon = sec.icon ? pickIcon(sec.icon) : null;
                    return (
                      <div key={sec.id} className="pb-1">
                        <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          {SecIcon && <SecIcon className="h-3 w-3 shrink-0" />}
                          <span className="truncate">{sec.label}</span>
                        </div>
                        {sec.screens.map((s) => {
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
                    );
                  })
                : overflow.map((s) => {
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
        style={{ gridTemplateColumns: `repeat(${visible.length + (showMoreButton ? 1 : 0)}, 1fr)` }}
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
        {showMoreButton && (
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="flex flex-col items-center justify-center gap-0.5 px-2 py-2"
            style={{ color: moreActive || showMore ? accent : '#64748b' }}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[11px] font-medium leading-tight">{grouped ? 'Mục' : 'Thêm'}</span>
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
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    return (
      <div className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
        {offline
          ? 'Màn hình này chưa được tải để dùng offline. Hãy mở nó một lần khi có mạng, sau đó vẫn dùng được khi mất mạng.'
          : 'Không tải được màn hình này.'}
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
        onNavigate={onNavigate}
        onSaved={(carry, nextScreen) => {
          if (nextScreen) onNavigate(nextScreen, carry);
          else setReloadKey((k) => k + 1);
        }}
      />
    );
  }
  if (data.kind === 'table' && data.table_view?.pos_cart) {
    return (
      <PosCartScreen
        spec={data}
        token={token}
        workboardId={workboardId}
        accent={accent}
        onNavigate={onNavigate}
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
    return (
      <DocScreen
        spec={data}
        token={token}
        workboardId={workboardId}
        shared={shared}
        accent={accent}
      />
    );
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
  onNavigate,
}: {
  spec: FormScreenResponse;
  token: string;
  workboardId: number;
  accent: string;
  shared: Record<string, unknown>;
  onSaved: (carry: Record<string, unknown>, nextScreen?: string) => void;
  onNavigate?: (screenId: string, carry?: Record<string, unknown>) => void;
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
  // ── Chụp ảnh tự điền (OCR) ──
  const ocrEnabled = !!(spec as unknown as { ocr?: { enabled?: boolean } }).ocr?.enabled;
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrNote, setOcrNote] = useState<string | null>(null);
  const [ocrDragging, setOcrDragging] = useState(false);
  const [ocrFilled, setOcrFilled] = useState<Set<string>>(new Set());
  const ocrInputRef = useRef<HTMLInputElement>(null);

  const handleOcrFile = (file: File | null) => {
    setOcrError(null);
    setOcrNote(null);
    if (!file) return;
    if (file.size > 9 * 1024 * 1024) {
      setOcrError('Ảnh quá lớn (tối đa ~9 MB). Hãy chụp lại với độ phân giải thấp hơn.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      setOcrBusy(true);
      try {
        const res = await workspaceApi.ocrExtract(token, workboardId, spec.screen_id, dataUrl);
        const got = res.values || {};
        const keys = Object.keys(got);
        if (keys.length === 0) {
          setOcrNote(null);
          setOcrError('Chưa đọc được trường nào từ ảnh. Hãy chụp rõ hơn hoặc nhập tay.');
          return;
        }
        setValues((curr) => ({ ...curr, ...got }));
        setOcrFilled(new Set(keys));
        setOcrNote(`Đã điền ${keys.length} trường từ ảnh — vui lòng kiểm tra (ô vàng) trước khi lưu.`);
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setOcrError(typeof detail === 'string' ? detail : 'Không nhận diện được ảnh. Vui lòng thử lại.');
      } finally {
        setOcrBusy(false);
      }
    };
    reader.onerror = () => setOcrError('Không đọc được tệp ảnh.');
    reader.readAsDataURL(file);
  };

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

  const handleSubmit = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault();
    // Never persist while the wizard is on a non-final page (e.g. Enter pressed
    // in a page-1 field): advance instead of saving a partial row.
    if (isMultiPage && currentPage < lastVisiblePageId) {
      goNextPage();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(null);
    // Idempotency key — reused if this submit has to be queued offline + replayed,
    // so the backend can never insert it twice.
    const opId = newOpId();
    // Hoisted so the catch block can tell a new-row insert (queueable offline)
    // from an edit (needs the live row, not queueable).
    let isEditing = false;
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
      // Geo-stamp (A3): capture the device location at submit into the
      // configured column (anti-fraud audit of who was where). Non-blocking —
      // a denied/failed fix just leaves the column empty.
      const geoStampCol = (spec as unknown as { geo_stamp_column?: string | null }).geo_stamp_column;
      if (geoStampCol) {
        const coords = await new Promise<string | null>((resolve) => {
          if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (p) => resolve(`${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
          );
        });
        if (coords) payload[geoStampCol] = coords;
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
      isEditing =
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
        await workspaceApi.insertScreenRow(token, workboardId, spec.screen_id, payload, opId);
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
      // Offline (no server reachable) + a NEW row → queue it locally and let the
      // user keep working; it syncs automatically on reconnect. Editing offline
      // is not queued (needs the live row), so it falls through to the error path.
      if (!isEditing && isNetworkError(err)) {
        try {
          const payloadForQueue: Record<string, unknown> = {};
          const fieldCols = new Set(allFields.map((f) => String(f.column || '')));
          for (const k of fieldCols) {
            const v = values[k];
            if (typeof v === 'string' && v.startsWith('{{') && v.endsWith('}}')) continue;
            payloadForQueue[k] = v;
          }
          await enqueueSubmit({
            opId,
            token,
            workboardId,
            screenId: spec.screen_id,
            screenTitle: spec.title,
            values: payloadForQueue,
            createdAt: Date.now(),
            status: 'pending',
          });
          window.dispatchEvent(new Event('appbi-queue-changed'));
          setSuccess('Đã lưu tạm khi ngoại tuyến — sẽ tự gửi khi có mạng.');
          // Stay on the form: calling onSaved would navigate / re-fetch the
          // screen over the (still-offline) network → "Không tải được màn hình".
          // Instead reset locally for the next entry; the queued row syncs on
          // reconnect (OfflineBar shows the pending count).
          setValues(buildInitial());
          setCurrentPage(1);
          setOcrFilled(new Set());
          setTimeout(() => setSuccess(null), 4000);
          return;
        } catch {
          setSubmitError('Không lưu tạm được khi ngoại tuyến. Vui lòng thử lại khi có mạng.');
          return;
        }
      }
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

      {ocrEnabled && (
        <div className="mb-4">
          {!ocrNote ? (
            <div
              role="button"
              tabIndex={0}
              aria-disabled={ocrBusy}
              onClick={() => {
                if (!ocrBusy) ocrInputRef.current?.click();
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !ocrBusy) {
                  e.preventDefault();
                  ocrInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOcrDragging(true);
              }}
              onDragLeave={() => setOcrDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOcrDragging(false);
                if (!ocrBusy) handleOcrFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors select-none sm:flex-row sm:gap-3 sm:text-left ${
                ocrDragging ? 'border-blue-400 bg-blue-100' : 'border-blue-200 bg-blue-50'
              } ${ocrBusy ? 'opacity-60' : 'hover:bg-blue-100'}`}
            >
              <div
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-white"
                style={{ backgroundColor: accent }}
              >
                {ocrBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-blue-900">
                  {ocrBusy ? 'Đang đọc ảnh…' : 'Chụp ảnh phiếu để điền nhanh'}
                </p>
                <p className="text-xs text-slate-600">
                  Bấm để chụp ảnh hoặc chọn tệp ảnh — kéo-thả ảnh vào đây cũng được. Hệ thống tự điền, bạn kiểm tra rồi lưu.
                </p>
              </div>
              <span
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: accent }}
              >
                <Upload className="h-4 w-4" />
                Chọn ảnh
              </span>
              {/* Explicit ref-click (not label-wrap) = bulletproof across browsers.
                  No `capture` attr: mobile shows Camera + Thư viện + Tệp; desktop opens file picker. */}
              <input
                ref={ocrInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                disabled={ocrBusy}
                onChange={(e) => {
                  handleOcrFile(e.target.files?.[0] ?? null);
                  e.target.value = ''; // allow re-selecting the same file
                }}
              />
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
              <p className="text-xs font-medium text-emerald-800">{ocrNote}</p>
            </div>
          )}
          {ocrError && (
            <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {ocrError}
            </p>
          )}
        </div>
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
              {list.map((field) => {
                const col = String(field.column || '');
                const isOcr = ocrFilled.has(col);
                return (
                  <div
                    key={col}
                    className={
                      isOcr
                        ? 'relative rounded-lg bg-amber-50 p-2 ring-1 ring-amber-300'
                        : undefined
                    }
                  >
                    {isOcr && (
                      <span className="absolute right-2 top-2 z-10 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                        AI
                      </span>
                    )}
                    <Field
                      field={field}
                      lookups={spec.lookups}
                      value={values[col]}
                      evalCtx={evalCtx}
                      autoNumberSet={autoNumberSet}
                      onNavigate={onNavigate}
                      onChange={(v) => {
                        setValues((curr) => ({ ...curr, [col]: v }));
                        if (isOcr)
                          setOcrFilled((prev) => {
                            const n = new Set(prev);
                            n.delete(col);
                            return n;
                          });
                      }}
                    />
                  </div>
                );
              })}
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
            // Distinct key + type="button" so advancing to the LAST page does
            // not re-type this same DOM node into a submit button mid-click
            // (which made the browser's native click default submit the form,
            // saving a partial row and skipping the final page).
            <button
              key="wb-form-next"
              type="button"
              onClick={goNextPage}
              className="flex items-center gap-2 rounded-md px-5 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: accent }}
            >
              Bước kế →
            </button>
          ) : (
            <button
              key="wb-form-submit"
              type="button"
              onClick={handleSubmit}
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
  onNavigate,
}: {
  field: RuntimeField;
  lookups: Record<string, LookupOption[]>;
  value: unknown;
  onChange: (v: unknown) => void;
  evalCtx?: RuntimeEvalCtx;
  autoNumberSet?: Set<string>;
  onNavigate?: (screenId: string, carry?: Record<string, unknown>) => void;
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

  // Cascading select (A7): narrow options to those whose `filter` matches the
  // current value of the parent field. Empty parent → force picking it first.
  const filterByField = (field.lookup as Record<string, unknown> | undefined)?.filter_by_field as
    | string
    | undefined;
  const parentVal =
    filterByField && evalCtx ? (evalCtx.row as Record<string, unknown>)[filterByField] : undefined;
  const effectiveOpts: LookupOption[] = filterByField
    ? parentVal == null || parentVal === ''
      ? []
      : (lookupOpts as LookupOption[]).filter((o) => String(o.filter) === String(parentVal))
    : (lookupOpts as LookupOption[]);

  const unit = field.unit ? String(field.unit) : '';
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
          <option value="">
            {filterByField && (parentVal == null || parentVal === '')
              ? '— chọn mục ở trên trước —'
              : '— chọn —'}
          </option>
          {effectiveOpts.map((opt) => (
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
        <div className="flex items-center gap-2">
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
          {unit && <span className="shrink-0 text-sm text-slate-500">{unit}</span>}
        </div>
      ) : widget === 'file' || widget === 'image' ? (
        <FileUploadField
          field={field}
          value={value}
          onChange={onChange}
          readonly={readonly}
          required={required}
          isImage={widget === 'image'}
          captureOnly={!!field.capture_only}
        />
      ) : widget === 'images' ? (
        <MultiImageField
          field={field}
          value={value}
          onChange={onChange}
          readonly={readonly}
          captureOnly={!!field.capture_only}
        />
      ) : widget === 'geopoint' ? (
        <GeoPointField value={value} onChange={onChange} readonly={readonly} />
      ) : widget === 'signature' ? (
        <SignatureField value={value} onChange={onChange} readonly={readonly} />
      ) : widget === 'barcode' ? (
        <BarcodeField value={value} onChange={onChange} readonly={readonly} placeholder={placeholder} baseInput={baseInput} field={field} onNavigate={onNavigate} />
      ) : widget === 'qr' ? (
        <QrField field={field} value={value} evalCtx={evalCtx} />
      ) : widget === 'audio' ? (
        <AudioField field={field} value={value} onChange={onChange} readonly={readonly} />
      ) : widget === 'computed' ? (
        <ComputedField
          formula={typeof field.formula === 'string' ? field.formula : ''}
          unit={unit}
          value={value}
          onChange={onChange}
          evalCtx={evalCtx}
        />
      ) : widget === 'status' ? (
        <StatusField
          field={field}
          value={value}
          onChange={onChange}
          readonly={readonly}
          viewerRole={evalCtx ? String((evalCtx.app_user as Record<string, unknown>)?.role ?? '') : ''}
        />
      ) : widget === 'map' ? (
        <MapSelectField
          options={lookupOpts as LookupOption[]}
          value={value}
          onChange={onChange}
          readonly={readonly}
          basemap={String(
            (field.lookup as Record<string, unknown> | undefined)?.basemap || 'satellite',
          )}
        />
      ) : widget === 'email' || widget === 'phone' || widget === 'url' ? (
        <input
          type={widget === 'email' ? 'email' : widget === 'phone' ? 'tel' : 'url'}
          inputMode={widget === 'phone' ? 'tel' : widget === 'email' ? 'email' : 'url'}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          placeholder={placeholder || (widget === 'email' ? 'name@company.com' : widget === 'phone' ? '09xxxxxxxx' : 'https://…')}
          className={baseInput}
        />
      ) : widget === 'time' ? (
        <input
          type="time"
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          required={required}
          className={baseInput}
        />
      ) : widget === 'color' ? (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={stringValue || '#2563eb'}
            onChange={(e) => onChange(e.target.value)}
            disabled={readonly}
            className="h-9 w-12 cursor-pointer rounded border border-slate-300 p-0.5 disabled:opacity-50"
          />
          <input
            type="text"
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
            disabled={readonly}
            placeholder="#2563eb"
            className={baseInput}
          />
        </div>
      ) : widget === 'currency' || widget === 'percent' ? (
        <div className="flex items-center gap-2">
          {widget === 'currency' && Boolean(field.currency_code) && (
            <span className="shrink-0 text-sm text-slate-500">{String(field.currency_code)}</span>
          )}
          <input
            type="number"
            step="any"
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
          {widget === 'percent' && <span className="shrink-0 text-sm text-slate-500">%</span>}
        </div>
      ) : widget === 'rating' ? (
        <RatingField field={field} value={value} onChange={onChange} readonly={readonly} />
      ) : widget === 'slider' ? (
        <SliderField field={field} value={value} onChange={onChange} readonly={readonly} unit={unit} />
      ) : widget === 'duration' ? (
        <DurationField value={value} onChange={onChange} readonly={readonly} />
      ) : widget === 'enum_list' ? (
        <EnumListField
          field={field}
          options={effectiveOpts as LookupOption[]}
          value={value}
          onChange={onChange}
          readonly={readonly}
        />
      ) : widget === 'rich_text' ? (
        <RichTextField value={value} onChange={onChange} readonly={readonly} placeholder={placeholder} />
      ) : widget === 'video' ? (
        <VideoField field={field} value={value} onChange={onChange} readonly={readonly} />
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

// ── Rating widget (stars) ────────────────────────────────────────────────
function RatingField({
  field,
  value,
  onChange,
  readonly,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
}) {
  const max = Math.min(Math.max(Number(field.max_stars) || 5, 1), 10);
  const current = Number(value) || 0;
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: max }, (_, i) => {
        const n = i + 1;
        const filled = current >= n;
        return (
          <button
            key={n}
            type="button"
            disabled={readonly}
            onClick={() => onChange(current === n ? 0 : n)}
            className="text-2xl leading-none transition disabled:cursor-default"
            style={{ color: filled ? '#f59e0b' : '#cbd5e1' }}
            aria-label={`${n} sao`}
          >
            {filled ? '★' : '☆'}
          </button>
        );
      })}
      {current > 0 && <span className="ml-2 text-sm text-slate-500">{current}/{max}</span>}
    </div>
  );
}

// ── Slider widget (range) ────────────────────────────────────────────────
function SliderField({
  field,
  value,
  onChange,
  readonly,
  unit,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
  unit: string;
}) {
  const min = Number.isFinite(Number(field.min_value)) ? Number(field.min_value) : 0;
  const max = Number.isFinite(Number(field.max_value)) ? Number(field.max_value) : 100;
  const step = Number(field.step) > 0 ? Number(field.step) : 1;
  const current = value == null || value === '' ? min : Number(value);
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={readonly}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 flex-1 cursor-pointer accent-[color:var(--wb-primary,#2563eb)]"
      />
      <span className="w-16 shrink-0 text-right text-sm font-medium text-slate-700">
        {current}
        {unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}

// ── Duration widget (hours + minutes -> total minutes) ───────────────────
function DurationField({
  value,
  onChange,
  readonly,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
}) {
  const total = Number(value) || 0;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const emit = (h: number, m: number) => onChange(Math.max(0, h) * 60 + Math.max(0, Math.min(59, m)));
  const cls =
    'w-16 rounded-md border border-slate-300 px-2 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100';
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600">
      <input
        type="number"
        min={0}
        value={hours || ''}
        disabled={readonly}
        onChange={(e) => emit(Number(e.target.value) || 0, mins)}
        className={cls}
        placeholder="0"
      />
      <span>giờ</span>
      <input
        type="number"
        min={0}
        max={59}
        value={mins || ''}
        disabled={readonly}
        onChange={(e) => emit(hours, Number(e.target.value) || 0)}
        className={cls}
        placeholder="0"
      />
      <span>phút</span>
    </div>
  );
}

// ── Enum-list widget (multi-select chips) ────────────────────────────────
function EnumListField({
  field,
  options,
  value,
  onChange,
  readonly,
}: {
  field: RuntimeField;
  options: LookupOption[];
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
}) {
  const selected: string[] = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string' && value.startsWith('[')
      ? (() => {
          try {
            return (JSON.parse(value) as unknown[]).map((v) => String(v));
          } catch {
            return [];
          }
        })()
      : value
        ? [String(value)]
        : [];
  const maxSel = Number(field.max_select) || 0;
  const toggle = (val: string) => {
    if (readonly) return;
    let next: string[];
    if (selected.includes(val)) {
      next = selected.filter((s) => s !== val);
    } else {
      if (maxSel > 0 && selected.length >= maxSel) return;
      next = [...selected, val];
    }
    // Store as a JSON STRING so it writes to a text/jsonb cell without the
    // connector adapting a Python list to a PG array (type mismatch).
    onChange(JSON.stringify(next));
  };
  return (
    <div className="flex flex-wrap gap-2">
      {options.length === 0 && (
        <span className="text-sm text-slate-400">Chưa có lựa chọn.</span>
      )}
      {options.map((opt) => {
        const val = String(opt.value);
        const on = selected.includes(val);
        return (
          <button
            key={val}
            type="button"
            disabled={readonly}
            onClick={() => toggle(val)}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              on
                ? 'border-transparent text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'
            }`}
            style={on ? { backgroundColor: 'var(--wb-primary, #2563eb)' } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
      {maxSel > 0 && (
        <span className="self-center text-xs text-slate-400">
          {selected.length}/{maxSel}
        </span>
      )}
    </div>
  );
}

// ── Rich-text widget (lightweight markdown) ──────────────────────────────
function mdToSafeHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc(md).split('\n');
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    let line = raw;
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`);
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(line.trim() ? `<p>${line}</p>` : '');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function RichTextField({
  value,
  onChange,
  readonly,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
  placeholder?: string;
}) {
  const text = value == null ? '' : String(value);
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const wrap = (before: string, after: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const sel = text.slice(s, e) || 'text';
    onChange(text.slice(0, s) + before + sel + after + text.slice(e));
  };
  return (
    <div className="rounded-md border border-slate-300">
      <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1 text-sm">
        <button type="button" disabled={readonly} onClick={() => wrap('**', '**')} className="rounded px-2 py-0.5 font-bold hover:bg-slate-100">B</button>
        <button type="button" disabled={readonly} onClick={() => wrap('*', '*')} className="rounded px-2 py-0.5 italic hover:bg-slate-100">I</button>
        <button type="button" disabled={readonly} onClick={() => wrap('\n- ', '')} className="rounded px-2 py-0.5 hover:bg-slate-100">• List</button>
        <button type="button" disabled={readonly} onClick={() => wrap('[', '](https://)')} className="rounded px-2 py-0.5 hover:bg-slate-100">🔗</button>
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className={`ml-auto rounded px-2 py-0.5 hover:bg-slate-100 ${preview ? 'text-blue-600' : 'text-slate-500'}`}
        >
          {preview ? 'Sửa' : 'Xem'}
        </button>
      </div>
      {preview ? (
        <div
          className="prose-sm max-w-none px-3 py-2 text-sm text-slate-700 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: mdToSafeHtml(text) }}
        />
      ) : (
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          disabled={readonly}
          placeholder={placeholder || 'Hỗ trợ **đậm**, *nghiêng*, - danh sách, [link](url)'}
          rows={4}
          className="w-full resize-y px-3 py-2 text-sm focus:outline-none disabled:bg-slate-100"
        />
      )}
    </div>
  );
}

// ── Video widget (capture/upload -> data URI) ────────────────────────────
function VideoField({
  field,
  value,
  onChange,
  readonly,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const maxKb = Math.min(Number(field.max_file_kb) || FILE_HARD_CAP_KB, FILE_HARD_CAP_KB);
  const src = typeof value === 'string' && value.startsWith('data:video') ? value : null;
  return (
    <div className="space-y-2">
      {src ? (
        <div className="space-y-1">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={src} controls className="max-h-48 w-full rounded-md border border-slate-200" />
          {!readonly && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-xs text-rose-600 hover:underline"
            >
              Xoá video
            </button>
          )}
        </div>
      ) : (
        <input
          type="file"
          accept="video/*"
          capture="environment"
          disabled={readonly}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setError(null);
            if (f.size / 1024 > maxKb) {
              setError(`Video lớn hơn giới hạn ${maxKb} KB.`);
              return;
            }
            const reader = new FileReader();
            reader.onload = () => onChange(reader.result as string);
            reader.readAsDataURL(f);
          }}
          className="text-sm"
        />
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <p className="text-xs text-slate-400">
        Tối đa {maxKb} KB — nên dùng clip ngắn (nguồn Postgres, không Google Sheets).
      </p>
    </div>
  );
}

// ── File / image upload widget ───────────────────────────────────────────
//
// Stores the file as a base64 data URL directly in the row's JSONB cell.
// Hard ceiling is 1 MB — anything bigger blows up the row payload + audit
// log. Builder can lower this via FormField.max_file_kb.

// Soft FE pre-check ceiling for base64 media. Defaults to the Postgres/JSONB
// app cap; the shell overrides it (storage-aware — 35KB for Sheets) via
// setRuntimeMediaCap() so the picker rejects oversize before the round-trip.
// The BE remains the authoritative enforcer.
let FILE_HARD_CAP_KB = 1024;
function setRuntimeMediaCap(kb?: number) {
  if (typeof kb === 'number' && kb > 0) FILE_HARD_CAP_KB = kb;
}

function FileUploadField({
  field,
  value,
  onChange,
  readonly,
  required,
  isImage,
  captureOnly,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
  required: boolean;
  isImage: boolean;
  captureOnly?: boolean;
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
            capture={isImage && captureOnly ? 'environment' : undefined}
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

// ── Multi-image widget (widget='images') ─────────────────────────────────
// Stores an array of data:image base64 strings in the JSONB cell. capture_only
// forces the device camera (field-work: photograph tree + cup + slip in one go).
function asImageArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value) {
    if (value.startsWith('[')) {
      try {
        const p = JSON.parse(value);
        return Array.isArray(p) ? p.filter((v): v is string => typeof v === 'string') : [];
      } catch {
        return value.startsWith('data:') ? [value] : [];
      }
    }
    return value.startsWith('data:') ? [value] : [];
  }
  return [];
}

function MultiImageField({
  field,
  value,
  onChange,
  readonly,
  captureOnly,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
  captureOnly?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const items = asImageArray(value);
  const maxKb = Math.min(Number(field.max_file_kb) || FILE_HARD_CAP_KB, FILE_HARD_CAP_KB);
  const maxItems = Math.min(Number(field.max_items) || 10, 20);

  const addFiles = (files: FileList | null) => {
    setError(null);
    if (!files || files.length === 0) return;
    const room = maxItems - items.length;
    if (room <= 0) {
      setError(`Tối đa ${maxItems} ảnh.`);
      return;
    }
    const chosen = Array.from(files).slice(0, room);
    const readers = chosen.map(
      (file) =>
        new Promise<string | null>((resolve) => {
          if (Math.round(file.size / 1024) > maxKb) {
            setError(`Có ảnh vượt ${maxKb} KB — hãy chụp nhỏ hơn.`);
            resolve(null);
            return;
          }
          const r = new FileReader();
          r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
          r.onerror = () => resolve(null);
          r.readAsDataURL(file);
        }),
    );
    void Promise.all(readers).then((results) => {
      const next = [...items, ...results.filter((x): x is string => !!x)];
      onChange(next);
    });
  };

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {items.map((src, i) => (
            <div key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`${field.column}-${i}`} className="h-24 w-full rounded-md border border-slate-200 object-cover" />
              {!readonly && (
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                  className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-xs text-white"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!readonly && items.length < maxItems && (
        <input
          type="file"
          accept="image/*"
          multiple
          capture={captureOnly ? 'environment' : undefined}
          onChange={(e) => addFiles(e.target.files)}
          className="text-xs"
        />
      )}
      {error ? (
        <p className="text-xs text-rose-600">{error}</p>
      ) : (
        <p className="text-xs text-slate-500">
          {items.length}/{maxItems} ảnh · tối đa {maxKb} KB mỗi ảnh{captureOnly ? ' · chỉ chụp trực tiếp' : ''}.
        </p>
      )}
    </div>
  );
}

// ── GPS capture widget (widget='geopoint') ───────────────────────────────
// Captures the device location as "lat,lng" and previews it on a satellite
// mini-map. Used for attendance / "I was at plot X" geo-audit.
function GeoPointField({
  value,
  onChange,
  readonly,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const stringValue = typeof value === 'string' ? value : '';
  const parts = stringValue.split(',').map((s) => Number(s.trim()));
  const hasPoint = parts.length === 2 && parts.every((n) => Number.isFinite(n));

  const capture = () => {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Thiết bị không hỗ trợ định vị.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        setAccuracy(Math.round(pos.coords.accuracy));
        onChange(`${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`);
      },
      (err) => {
        setBusy(false);
        setError(err.code === 1 ? 'Bạn đã từ chối quyền vị trí.' : 'Không lấy được vị trí.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  useEffect(() => {
    if (!hasPoint || !mapEl.current) return;
    let map: { remove: () => void } | null = null;
    let disposed = false;
    (async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const L: any = (await import('leaflet')).default;
      if (disposed || !mapEl.current) return;
      map = L.map(mapEl.current, { attributionControl: false, zoomControl: false, dragging: false, scrollWheelZoom: false });
      L.tileLayer(ESRI_BASEMAPS.satellite, { maxZoom: 19 }).addTo(map);
      (map as any).setView([parts[0], parts[1]], 16);
      L.circleMarker([parts[0], parts[1]], { radius: 8, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.6 }).addTo(map);
      /* eslint-enable @typescript-eslint/no-explicit-any */
    })();
    return () => {
      disposed = true;
      if (map) try { map.remove(); } catch { /* gone */ }
    };
  }, [hasPoint, parts[0], parts[1]]);

  return (
    <div className="space-y-1.5">
      {hasPoint && <div ref={mapEl} className="h-40 w-full overflow-hidden rounded-md border border-slate-300" style={{ zIndex: 0 }} />}
      <div className="flex items-center gap-2">
        {!readonly && (
          <button
            type="button"
            onClick={capture}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60 hover:bg-slate-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            {hasPoint ? 'Cập nhật vị trí' : 'Lấy vị trí của tôi'}
          </button>
        )}
        {hasPoint && (
          <span className="text-xs text-slate-500">
            {parts[0].toFixed(5)}, {parts[1].toFixed(5)}
            {accuracy != null ? ` · ±${accuracy}m` : ''}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

// ── Signature widget (widget='signature') ────────────────────────────────
// Hand-drawn signature on a canvas -> data:image/png. For on-the-spot
// acceptance / hand-over slips.
function SignatureField({
  value,
  onChange,
  readonly,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const stringValue = typeof value === 'string' ? value : '';

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readonly) return;
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current && canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const c = canvasRef.current;
    if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange('');
  };

  if (readonly) {
    return stringValue.startsWith('data:image') ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={stringValue} alt="signature" className="h-28 rounded-md border border-slate-200 bg-white" />
    ) : (
      <p className="text-sm text-slate-400">Chưa ký.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      <canvas
        ref={canvasRef}
        width={480}
        height={160}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="h-40 w-full touch-none rounded-md border border-dashed border-slate-300 bg-white"
      />
      <div className="flex items-center gap-3">
        <button type="button" onClick={clear} className="text-xs text-rose-600 hover:underline">
          Xoá & ký lại
        </button>
        <span className="text-xs text-slate-500">Ký bằng ngón tay / chuột vào ô trên.</span>
      </div>
    </div>
  );
}

// ── QR generation (widget='qr' / doc block 'qr_code') ────────────────────
// The current mini-app base URL (origin + /ws/<token>/workboards/<wbid>). Used
// so a QR can encode a deep-link back into THIS app without threading token/id.
function qrAppBase(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}`;
}

// Resolve a QR value template: {{app_url}} -> this app's base; [column] -> a
// value from the current row (form widget only). Non-URL codes pass through raw.
function resolveQrTemplate(tpl: string, row?: Record<string, unknown>): string {
  let out = tpl.replace(/\{\{\s*app_url\s*\}\}/g, qrAppBase());
  if (row) {
    out = out.replace(/\[([a-zA-Z0-9_]+)\]/g, (_m, col) => {
      const v = row[col];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  return out;
}

// Print the current label: hide the app chrome and print only the nearest
// element flagged `.wb-print-target` (see the global print CSS at page root).
function printLabel() {
  if (typeof document === 'undefined') return;
  const body = document.body;
  body.classList.add('wb-printing');
  const cleanup = () => {
    body.classList.remove('wb-printing');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.setTimeout(cleanup, 3000); // fallback if afterprint never fires
  window.print();
}

// Display-only QR field. Encodes qr_value_template (with {{app_url}}/[col]) or
// the value of qr_source_column (default = the field's own column).
function QrField({
  field,
  value,
  evalCtx,
}: {
  field: RuntimeField;
  value: unknown;
  evalCtx?: RuntimeEvalCtx;
}) {
  const size = typeof field.qr_size === 'number' ? field.qr_size : 160;
  const caption = typeof field.qr_caption === 'string' ? field.qr_caption : '';
  const template = typeof field.qr_value_template === 'string' ? field.qr_value_template : '';
  const sourceCol =
    typeof field.qr_source_column === 'string' && field.qr_source_column
      ? field.qr_source_column
      : String(field.column ?? '');
  const row = (evalCtx?.row as Record<string, unknown>) || {};
  let encoded = '';
  if (template) {
    encoded = resolveQrTemplate(template, row);
  } else {
    const raw = sourceCol in row ? row[sourceCol] : value;
    encoded = raw === undefined || raw === null ? '' : String(raw);
  }
  return (
    <div className="wb-print-target flex flex-col items-center gap-1.5 py-1">
      {encoded ? (
        <div className="rounded-md border border-slate-200 bg-white p-2">
          <QRCodeSVG value={encoded} size={size} level="M" marginSize={2} />
        </div>
      ) : (
        <div className="text-xs text-slate-400">Chưa có giá trị để tạo mã QR</div>
      )}
      {caption && <div className="text-center text-xs text-slate-600">{caption}</div>}
      {encoded && (
        <button
          type="button"
          onClick={printLabel}
          className="print:hidden inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          <Printer className="h-3.5 w-3.5" /> In tem
        </button>
      )}
    </div>
  );
}

// ── Barcode / QR scan widget (widget='barcode') ──────────────────────────
// Uses the native BarcodeDetector when available (Chrome/Android), always with
// a manual-entry fallback. Value is the decoded string (tank/lot/badge code).
function BarcodeField({
  value,
  onChange,
  readonly,
  placeholder,
  baseInput,
  field,
  onNavigate,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
  placeholder: string;
  baseInput: string;
  field?: RuntimeField;
  onNavigate?: (screenId: string, carry?: Record<string, unknown>) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stringValue = typeof value === 'string' ? value : '';
  const supported = cameraScanAvailable();
  // Scan-to-form: when the field declares scan_go_to_screen, a decoded code
  // navigates to that screen carrying the value (default under this column).
  const scanTarget =
    field && typeof field.scan_go_to_screen === 'string' && field.scan_go_to_screen
      ? field.scan_go_to_screen
      : null;
  const carryAs =
    (field && typeof field.scan_carry_as === 'string' && field.scan_carry_as
      ? field.scan_carry_as
      : field
        ? String(field.column)
        : '') || '';

  const stop = () => {
    setScanning(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => () => stop(), []);

  // Route a decoded/entered code. Three cases, in order:
  //  1) the code is a deep-link URL into this runtime (a scanned label sticker)
  //     -> honor its screen + params, so the SAME QR works from an external
  //     phone camera AND from an in-app scan;
  //  2) the field declares scan_go_to_screen -> navigate carrying the value;
  //  3) otherwise just store the code into the field.
  const emit = (decoded: string) => {
    const d = decoded.trim();
    if (onNavigate && /^https?:\/\//i.test(d)) {
      try {
        const u = new URL(d);
        const hashParams = new URLSearchParams(u.hash.replace(/^#/, ''));
        const screen = u.searchParams.get('screen') || hashParams.get('screen');
        if (screen) {
          const carry: Record<string, unknown> = {};
          u.searchParams.forEach((v, k) => { if (k !== 'screen') carry[k] = v; });
          hashParams.forEach((v, k) => { if (k !== 'screen') carry[k] = v; });
          onChange(d);
          onNavigate(screen, carry);
          return;
        }
      } catch { /* not a usable URL — fall through */ }
    }
    if (scanTarget && onNavigate && d) {
      onChange(d);
      onNavigate(scanTarget, carryAs ? { [carryAs]: d } : undefined);
      return;
    }
    onChange(decoded);
  };

  const scan = async () => {
    setError(null);
    try {
      const detector = makeBarcodeDetector();
      const canvas = canvasRef.current || document.createElement('canvas');
      canvasRef.current = canvas;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setScanning(true);
      const v = videoRef.current!;
      v.srcObject = stream;
      v.setAttribute('playsinline', 'true');
      await v.play();
      const tick = async () => {
        if (!streamRef.current) return;
        const decoded = await decodeVideoFrame(v, canvas, detector);
        if (decoded) {
          stop();
          emit(decoded);
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setError('Không mở được camera — cấp quyền camera hoặc nhập tay bên dưới.');
      stop();
    }
  };

  return (
    <div className="space-y-1.5">
      {scanning && (
        <div className="space-y-1">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} className="h-48 w-full rounded-md border border-slate-300 bg-black object-cover" />
          <button type="button" onClick={stop} className="text-xs text-rose-600 hover:underline">
            Dừng quét
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Manual entry (or a keyboard-wedge USB scanner): Enter routes too.
            if (e.key === 'Enter' && scanTarget) {
              e.preventDefault();
              emit(stringValue.trim());
            }
          }}
          disabled={readonly}
          placeholder={placeholder || (scanTarget ? 'Quét/nhập mã rồi Enter' : 'Mã (quét hoặc nhập tay)')}
          className={baseInput}
        />
        {!readonly && supported && !scanning && (
          <button
            type="button"
            onClick={scan}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <ScanLine className="h-4 w-4" /> Quét
          </button>
        )}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

// ── Audio note widget (widget='audio') ───────────────────────────────────
// Records a short voice memo (MediaRecorder) -> data:audio data URL. Hands-free
// notes from the field.
function AudioField({
  field,
  value,
  onChange,
  readonly,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const stringValue = typeof value === 'string' ? value : '';
  const maxKb = Math.min(Number(field.max_file_kb) || FILE_HARD_CAP_KB, FILE_HARD_CAP_KB);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (Math.round(blob.size / 1024) > maxKb) {
          setError(`Ghi âm ${Math.round(blob.size / 1024)} KB vượt ${maxKb} KB — hãy nói ngắn hơn.`);
          return;
        }
        const r = new FileReader();
        r.onload = () => typeof r.result === 'string' && onChange(r.result);
        r.readAsDataURL(blob);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError('Không truy cập được micro.');
    }
  };
  const stop = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  return (
    <div className="space-y-1.5">
      {stringValue.startsWith('data:audio') && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls src={stringValue} className="w-full" />
      )}
      {!readonly && (
        <div className="flex items-center gap-3">
          {!recording ? (
            <button type="button" onClick={start} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              <Mic className="h-4 w-4" /> {stringValue ? 'Ghi lại' : 'Ghi âm'}
            </button>
          ) : (
            <button type="button" onClick={stop} className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> Dừng
            </button>
          )}
          {stringValue && !recording && (
            <button type="button" onClick={() => onChange('')} className="text-xs text-rose-600 hover:underline">
              Xoá
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

// ── Computed (live) widget (widget='computed') ───────────────────────────
// Readonly value computed on the form from `formula` (e.g. kg khô = kg × DRC%),
// stored on submit. Uses the shared wb-expr grammar.
function ComputedField({
  formula,
  unit,
  value,
  onChange,
  evalCtx,
}: {
  formula: string;
  unit: string;
  value: unknown;
  onChange: (next: unknown) => void;
  evalCtx?: RuntimeEvalCtx;
}) {
  const raw = evalCtx ? evaluateExpr(formula, evalCtx) : null;
  const computed = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 1e6) / 1e6 : raw ?? '';
  // Persist the computed value into the form state so it is submitted.
  useEffect(() => {
    if (String(computed ?? '') !== String(value ?? '')) onChange(computed === '' ? '' : computed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(computed ?? '')]);

  return (
    <div className="flex items-center gap-2">
      <div className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        {computed === '' || computed == null ? <span className="text-slate-400">—</span> : String(computed)}
      </div>
      {unit && <span className="shrink-0 text-sm text-slate-500">{unit}</span>}
    </div>
  );
}

// ── Status / approval widget (widget='status') ───────────────────────────
// Colored lifecycle select. `editable_by_roles` restricts who may change it
// (approval gate) on top of screen RLS writable_columns; others see a badge.
const STATUS_TONES: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  green: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  red: 'bg-rose-100 text-rose-700 border-rose-200',
  blue: 'bg-sky-100 text-sky-700 border-sky-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
};

function StatusField({
  field,
  value,
  onChange,
  readonly,
  viewerRole,
}: {
  field: RuntimeField;
  value: unknown;
  onChange: (next: unknown) => void;
  readonly: boolean;
  viewerRole: string;
}) {
  const cfg = field.status_config || {};
  const states = cfg.states || [];
  const editableRoles = cfg.editable_by_roles || [];
  const canEdit =
    !readonly && (editableRoles.length === 0 || editableRoles.map((r) => r.toLowerCase()).includes((viewerRole || '').toLowerCase()));
  const stringValue = value == null ? '' : String(value);
  const current = states.find((s) => String(s.value) === stringValue);
  const tone = STATUS_TONES[current?.color || 'slate'] || STATUS_TONES.slate;

  if (!canEdit) {
    return (
      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
        {current?.label || current?.value || '—'}
      </span>
    );
  }
  return (
    <select
      value={stringValue}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
    >
      <option value="">— chọn trạng thái —</option>
      {states.map((s) => (
        <option key={String(s.value)} value={String(s.value)}>
          {s.label || s.value}
        </option>
      ))}
    </select>
  );
}

// ── Map polygon-select widget (Leaflet, dynamic import) ──────────────────
//
// Each lookup option becomes a polygon (or centroid marker fallback) on a
// satellite basemap; tapping one calls onChange(opt.value). The value is a
// plain string (lô id) — same shape as a <select> — so it passes
// required/valid_if and carries into shared_context unchanged.
//
// Leaflet reads `window` at module load, so it is dynamic-imported inside the
// effect. We deliberately avoid L.marker default icons (external PNG assets
// that break under the bundler + CSP) — polygons + circleMarker only.
// NB: the satellite tile host must be allow-listed in nginx `img-src`
// (see nginx.conf) or tiles are blocked on public links (blank grey map).

const ESRI_BASEMAPS: Record<string, string> = {
  satellite:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  streets:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  light:
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};

const MAP_STYLE_SELECTED = { color: '#f59e0b', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.45 };
const MAP_STYLE_DEFAULT = { color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.15 };

function parseGeometry(geo: unknown): Record<string, unknown> | null {
  if (!geo) return null;
  if (typeof geo === 'object') return geo as Record<string, unknown>;
  if (typeof geo === 'string') {
    try {
      return JSON.parse(geo) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function MapSelectField({
  options,
  value,
  onChange,
  readonly,
  basemap,
}: {
  options: LookupOption[];
  value: unknown;
  onChange: (v: unknown) => void;
  readonly: boolean;
  basemap: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  // Keep each option's rendered layer so the value-effect can restyle without
  // rebuilding the whole map (which would reset pan/zoom).
  const layersRef = useRef<Array<{ value: unknown; layer: { setStyle?: (s: unknown) => void } }>>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const selectedLabel = useMemo(() => {
    const match = options.find((o) => String(o.value) === String(value ?? ''));
    return match?.label ?? null;
  }, [options, value]);

  // Stable key so we only rebuild the map when the option set / basemap /
  // readonly actually change — not on every parent re-render.
  const buildKey = useMemo(
    () =>
      JSON.stringify({
        b: basemap,
        r: readonly,
        o: options.map((o) => [o.value, o.geometry ?? null, o.lat ?? null, o.lng ?? null]),
      }),
    [options, basemap, readonly],
  );

  useEffect(() => {
    let disposed = false;
    // Leaflet is dynamic-imported so we can't lean on its static types here;
    // treat handles as `any` and keep the surface small + readable.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let map: any = null;
    (async () => {
      const el = containerRef.current;
      if (!el || options.length === 0) return;
      const L: any = (await import('leaflet')).default;
      if (disposed || !containerRef.current) return;

      map = L.map(el, { attributionControl: true, scrollWheelZoom: true });
      mapRef.current = map;
      L.tileLayer(ESRI_BASEMAPS[basemap] || ESRI_BASEMAPS.satellite, {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri',
      }).addTo(map);

      const built: Array<{ value: unknown; layer: { setStyle?: (s: unknown) => void } }> = [];
      const bounds = L.latLngBounds([]);
      for (const opt of options) {
        const isSelected = String(opt.value) === String(value ?? '');
        const gj = parseGeometry(opt.geometry);
        let layer: any = null;
        if (gj) {
          layer = L.geoJSON(gj, {
            style: () => (isSelected ? MAP_STYLE_SELECTED : MAP_STYLE_DEFAULT),
          });
          const b = layer.getBounds?.();
          if (b && b.isValid?.()) bounds.extend(b);
        } else if (opt.lat != null && opt.lng != null) {
          const lat = Number(opt.lat);
          const lng = Number(opt.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            layer = L.circleMarker([lat, lng], {
              radius: 9,
              ...(isSelected ? MAP_STYLE_SELECTED : MAP_STYLE_DEFAULT),
            });
            bounds.extend([lat, lng]);
          }
        }
        if (!layer) continue;
        if (opt.label) layer.bindTooltip?.(String(opt.label));
        if (!readonly) {
          layer.on('click', () => onChangeRef.current(opt.value));
        }
        layer.addTo(map);
        built.push({ value: opt.value, layer });
      }
      layersRef.current = built;
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [24, 24] });
      } else {
        map.setView([16.0, 107.5], 6);
      }
    })();

    return () => {
      disposed = true;
      layersRef.current = [];
      if (map) {
        try {
          map.remove();
        } catch {
          /* already gone */
        }
      }
      mapRef.current = null;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildKey]);

  // Restyle on value change without rebuilding the map.
  useEffect(() => {
    for (const { value: v, layer } of layersRef.current) {
      layer.setStyle?.(String(v) === String(value ?? '') ? MAP_STYLE_SELECTED : MAP_STYLE_DEFAULT);
    }
  }, [value]);

  if (options.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
        Chưa có vùng nào để hiển thị. Kiểm tra cấu hình bảng dữ liệu / cột geometry.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div
        ref={containerRef}
        className="h-64 w-full overflow-hidden rounded-md border border-slate-300"
        style={{ zIndex: 0 }}
      />
      <p className="text-xs text-slate-500">
        {selectedLabel ? (
          <>
            Đã chọn: <span className="font-medium text-slate-700">{selectedLabel}</span>
          </>
        ) : (
          'Chạm vào một vùng trên bản đồ để chọn.'
        )}
      </p>
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
  if (format === 'qr') {
    const code = String(value);
    return (
      <span className="inline-flex flex-col items-center gap-0.5">
        <QRCodeSVG value={code} size={64} level="M" marginSize={1} />
        <span className="text-[10px] text-slate-500">{code}</span>
      </span>
    );
  }
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

// ── Gallery display mode for a Table screen ──────────────────────────────
//
// Same rows / RLS / filters / detail-panel as the grid — only the render
// differs: rows become image cards, optionally bucketed into sections by
// `group_by_column` (header shows the value + count "16/05/2025 (3)").
// Reuses the <img data:image> approach from FileUploadField.

type GalleryConfigView = NonNullable<
  NonNullable<TableScreenResponse['table_view']>['gallery_config']
>;

function GalleryView({
  rows,
  config,
  colLabels,
  onOpen,
  panelEnabled,
  emptyMessage,
  rowFormat,
}: {
  rows: Array<Record<string, unknown>>;
  config: GalleryConfigView;
  colLabels: Record<string, string>;
  onOpen: (row: Record<string, unknown>) => void;
  panelEnabled: boolean;
  emptyMessage?: string | null;
  rowFormat?: (row: Record<string, unknown>) => { tone: string; icon?: string | null; label?: string | null } | null;
}) {
  const groupCol = config.group_by_column || null;
  const perRow = Math.min(Math.max(Number(config.columns_per_row) || 3, 1), 6);
  // Responsive: cap columns on small screens so cards don't get tiny on phones.
  const [vw, setVw] = useState(1024);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const effPerRow = vw < 480 ? Math.min(perRow, 2) : vw < 768 ? Math.min(perRow, 3) : perRow;

  // Bucket rows into sections preserving first-seen order.
  const sections = useMemo(() => {
    if (!groupCol) return [{ key: '__all__', label: null as string | null, rows }];
    const order: string[] = [];
    const buckets: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of rows) {
      const raw = row[groupCol];
      const key = raw == null || raw === '' ? '—' : String(raw);
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
      buckets[key].push(row);
    }
    return order.map((key) => ({ key, label: key, rows: buckets[key] }));
  }, [rows, groupCol]);

  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-slate-500">
        {emptyMessage || 'Chưa có dữ liệu.'}
      </div>
    );
  }

  const gridStyle = { gridTemplateColumns: `repeat(${effPerRow}, minmax(0, 1fr))` };

  return (
    <div className="space-y-5 px-1 py-2">
      {sections.map((section) => (
        <div key={section.key} className="space-y-2">
          {section.label !== null && (
            <div className="flex items-center gap-2 border-b border-slate-100 pb-1 text-sm font-semibold text-slate-700">
              <span>{section.label}</span>
              <span className="text-xs font-normal text-slate-400">({section.rows.length})</span>
            </div>
          )}
          <div className="grid gap-3" style={gridStyle}>
            {section.rows.map((row, idx) => {
              const img = row[config.image_column];
              const imgSrc = typeof img === 'string' && img.startsWith('data:image') ? img : null;
              const title = config.title_column ? row[config.title_column] : null;
              const subtitle = config.subtitle_column ? row[config.subtitle_column] : null;
              const fmt = rowFormat?.(row) || null;
              return (
                <button
                  type="button"
                  key={idx}
                  onClick={() => panelEnabled && onOpen(row)}
                  className={`group flex flex-col overflow-hidden rounded-lg border bg-white text-left transition ${
                    fmt ? `${fmt.tone} border-2` : 'border-slate-200'
                  } ${
                    panelEnabled ? 'cursor-pointer hover:border-slate-300 hover:shadow-sm' : 'cursor-default'
                  }`}
                >
                  <div className="flex aspect-square w-full items-center justify-center bg-slate-100">
                    {imgSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imgSrc}
                        alt={title ? String(title) : colLabels[config.image_column] || config.image_column}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-2xl text-slate-300">🖼️</span>
                    )}
                  </div>
                  {(title != null || subtitle != null) && (
                    <div className="space-y-0.5 px-2 py-1.5">
                      {title != null && (
                        <div className="truncate text-xs font-medium text-slate-700">{String(title)}</div>
                      )}
                      {subtitle != null && (
                        <div className="truncate text-[11px] text-slate-400">{String(subtitle)}</div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Calendar display mode for a Table screen ─────────────────────────────
// Places rows on a month grid by a date column. Same rows / RLS / filters /
// detail-panel as the grid — clicking a chip opens the detail panel.
type CalendarConfigView = NonNullable<
  NonNullable<TableScreenResponse['table_view']>['calendar_config']
>;

const CAL_TONES = [
  { dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200' },
  { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200' },
  { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200' },
  { dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200' },
  { dot: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200' },
  { dot: 'bg-slate-400', chip: 'bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-200' },
];
const CAL_WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

function toDayKey(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v);
  // ISO date / datetime → first 10 chars are YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarView({
  rows,
  config,
  accent,
  canAdd,
  canEdit,
  onEditRow,
  onAddOnDate,
}: {
  rows: Array<Record<string, unknown>>;
  config: CalendarConfigView;
  accent: string;
  canAdd: boolean;
  canEdit: boolean;
  onEditRow: (row: Record<string, unknown>) => void;
  onAddOnDate: (dateKey: string) => void;
}) {
  // Bucket rows by day; assign a stable tone per distinct color-column value.
  const { byDay, toneIdxFor, legend } = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of rows) {
      const key = toDayKey(row[config.date_column]);
      if (!key) continue;
      (map[key] ||= []).push(row);
    }
    const colorKeys: string[] = [];
    const idxOf = (row: Record<string, unknown>): number => {
      if (!config.color_column) return 0;
      const v = String(row[config.color_column] ?? '');
      let idx = colorKeys.indexOf(v);
      if (idx < 0) {
        colorKeys.push(v);
        idx = colorKeys.length - 1;
      }
      return idx % CAL_TONES.length;
    };
    // Prime the color order deterministically (sorted by value) for a stable legend.
    if (config.color_column) {
      Array.from(new Set(rows.map((r) => String(r[config.color_column!] ?? ''))))
        .filter((v) => v !== '')
        .sort()
        .forEach((v) => colorKeys.includes(v) || colorKeys.push(v));
    }
    const leg = config.color_column
      ? colorKeys.map((v, i) => ({ value: v, tone: CAL_TONES[i % CAL_TONES.length] }))
      : [];
    return { byDay: map, toneIdxFor: idxOf, legend: leg };
  }, [rows, config.date_column, config.color_column]);

  const initial = useMemo(() => {
    const keys = Object.keys(byDay).sort();
    const base = keys.length ? new Date(keys[keys.length - 1]) : new Date();
    return { y: base.getFullYear(), m: base.getMonth() };
  }, [byDay]);
  const [ym, setYm] = useState(initial);
  useEffect(() => setYm(initial), [initial]);

  const first = new Date(ym.y, ym.m, 1);
  const monthName = first.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const cells: Array<{ day: number; key: string } | null> = [];
  for (let i = 0; i < startOffset; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ day: d, key: `${ym.y}-${String(ym.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const todayKey = toDayKey(new Date().toISOString());
  const monthCount = cells.reduce((n, c) => n + (c ? (byDay[c.key]?.length || 0) : 0), 0);
  const shift = (delta: number) => {
    const nm = ym.m + delta;
    setYm({ y: ym.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 });
  };

  return (
    <div className="px-1 py-2">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-base font-semibold capitalize text-slate-800">{monthName}</div>
          <div className="text-xs text-slate-400">{monthCount} ghi nhận trong tháng</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setYm({ y: new Date().getFullYear(), m: new Date().getMonth() })}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Hôm nay
          </button>
          <div className="flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button type="button" onClick={() => shift(-1)} aria-label="Tháng trước" className="px-2 py-1.5 text-slate-500 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-4 w-px bg-slate-200" />
            <button type="button" onClick={() => shift(1)} aria-label="Tháng sau" className="px-2 py-1.5 text-slate-500 hover:bg-slate-50">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-7 border-b border-slate-100">
          {CAL_WEEKDAYS.map((w, i) => (
            <div
              key={w}
              className={`px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide ${
                i >= 5 ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            const isToday = !!cell && cell.key === todayKey;
            const dayRows = cell ? byDay[cell.key] || [] : [];
            const isWeekend = i % 7 >= 5;
            return (
              <div
                key={i}
                className={`group relative min-h-[112px] border-b border-r border-slate-100 p-1.5 [&:nth-child(7n)]:border-r-0 ${
                  cell ? (isWeekend ? 'bg-slate-50/40' : 'bg-white') : 'bg-slate-50/60'
                } ${cell && canAdd ? 'cursor-pointer hover:bg-emerald-50/40' : ''}`}
                onClick={cell && canAdd ? () => onAddOnDate(cell.key) : undefined}
              >
                {cell && (
                  <>
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] ${
                          isToday ? 'font-bold text-white' : 'text-slate-500'
                        }`}
                        style={isToday ? { backgroundColor: accent } : undefined}
                      >
                        {cell.day}
                      </span>
                      {canAdd && (
                        <span className="rounded-md p-0.5 text-slate-300 opacity-0 transition group-hover:opacity-100" title="Thêm ghi nhận">
                          <Plus className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {dayRows.slice(0, 3).map((row, j) => {
                        const label = config.title_column ? String(row[config.title_column] ?? '') : 'Bản ghi';
                        const tone = CAL_TONES[toneIdxFor(row)];
                        return (
                          <button
                            type="button"
                            key={j}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (canEdit) onEditRow(row);
                            }}
                            className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] ${tone.chip} ${
                              canEdit ? 'hover:brightness-[0.97]' : 'cursor-default'
                            }`}
                            title={canEdit ? `Sửa: ${label}` : label}
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                            <span className="truncate">{label || '•'}</span>
                          </button>
                        );
                      })}
                      {dayRows.length > 3 && (
                        <div className="px-1 text-[10px] font-medium text-slate-400">+{dayRows.length - 3} ghi nhận</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend + hint */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-500">
        {legend.slice(0, 6).map((l) => (
          <span key={l.value} className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${l.tone.dot}`} />
            {l.value}
          </span>
        ))}
        {canAdd && <span className="text-slate-400">· Chạm ô ngày để thêm · chạm thẻ để sửa</span>}
      </div>
    </div>
  );
}

// ── POS scan-cart screen ───────────────────────────────────────────────────
// Supermarket checkout flow: scan a barcode (phone camera) → the product
// resolves from the attached catalog and lands in an on-screen list with an
// editable quantity → press Submit to persist EVERY line at once via the
// screen's bulk-insert endpoint. Nothing is written until submit. On success
// the operator is routed to a printable receipt (doc screen).
function posToNum(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// A camera is usable whenever getUserMedia exists in a secure context
// (https or localhost). We never gate the "Scan" button on the native
// BarcodeDetector — Windows Chrome/Firefox/Safari lack it, so we fall back to
// jsQR (pure-JS QR decoder) which runs everywhere.
function cameraScanAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

// One scan pass over a <video> frame. Prefers the native BarcodeDetector
// (fast, decodes QR + 1D barcodes); otherwise decodes QR from the pixels with
// jsQR. Returns the decoded string, or '' if nothing was found this frame.
async function decodeVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  detector: { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } | null,
): Promise<string> {
  if (detector) {
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) return String(codes[0].rawValue || '').trim();
    } catch {
      /* frame not ready */
    }
    return '';
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return '';
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, w, h);
  try {
    const img = ctx.getImageData(0, 0, w, h);
    const res = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return res && res.data ? String(res.data).trim() : '';
  } catch {
    return '';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeBarcodeDetector(): { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } | null {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    return new (window as any).BarcodeDetector({
      formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'code_93', 'itf', 'upc_a', 'upc_e'],
    });
  } catch {
    try {
      return new (window as any).BarcodeDetector();
    } catch {
      return null;
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function posTwoDigit(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

type PosLine = {
  code: string;
  label: string;
  price: number;
  qty: number;
  row: Record<string, unknown>;
};

function PosCartScreen({
  spec,
  token,
  workboardId,
  accent,
  onNavigate,
}: {
  spec: TableScreenResponse;
  token: string;
  workboardId: number;
  accent: string;
  onNavigate: (screenId: string, carry?: Record<string, unknown>) => void;
}) {
  const cfg = spec.table_view?.pos_cart as NonNullable<
    NonNullable<TableScreenResponse['table_view']>['pos_cart']
  >;
  const catalog = spec.pos_catalog || null;

  const headerInputs = useMemo(() => cfg?.header_inputs || [], [cfg]);
  const [header, setHeader] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const h of cfg?.header_inputs || []) seed[h.column] = h.default ?? '';
    return seed;
  });
  const [lines, setLines] = useState<PosLine[]>([]);
  const [manual, setManual] = useState('');
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanSupported = cameraScanAvailable();

  const matchCol = catalog?.match_column || cfg?.catalog_match_column || '';
  const labelCol = catalog?.label_column || cfg?.catalog_label_column || '';
  const priceCol = catalog?.price_column || cfg?.catalog_price_column || '';

  const catalogByCode = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of catalog?.rows || []) {
      const key = String(row[matchCol] ?? '').trim();
      if (key) map.set(key.toUpperCase(), row);
    }
    return map;
  }, [catalog, matchCol]);

  const resolveRow = useCallback(
    (code: string): Record<string, unknown> | null =>
      catalogByCode.get(code.trim().toUpperCase()) || null,
    [catalogByCode],
  );

  const addByCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      const row = resolveRow(code);
      setLines((prev) => {
        const idx = prev.findIndex((l) => l.code.toUpperCase() === code.toUpperCase());
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
          return next;
        }
        return [
          ...prev,
          {
            code,
            label: row && labelCol ? String(row[labelCol] ?? code) : code,
            price: row && priceCol ? posToNum(row[priceCol]) : 0,
            qty: 1,
            row: row || {},
          },
        ];
      });
    },
    [resolveRow, labelCol, priceCol],
  );

  const stopScan = useCallback(() => {
    setScanning(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  useEffect(() => () => stopScan(), [stopScan]);

  const startScan = useCallback(async () => {
    setScanError(null);
    try {
      const detector = makeBarcodeDetector();
      const canvas = canvasRef.current || document.createElement('canvas');
      canvasRef.current = canvas;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setScanning(true);
      const v = videoRef.current!;
      v.srcObject = stream;
      v.setAttribute('playsinline', 'true');
      await v.play();
      const tick = async () => {
        if (!streamRef.current) return;
        const decoded = await decodeVideoFrame(v, canvas, detector);
        if (decoded) {
          // Debounce: the camera fires the same code many frames/sec — accept a
          // repeat of the SAME code only after 1.2s so one physical scan = +1.
          const now = Date.now();
          if (!(decoded === lastScanRef.current.code && now - lastScanRef.current.at < 1200)) {
            lastScanRef.current = { code: decoded, at: now };
            addByCode(decoded);
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setScanError('Không mở được camera — cấp quyền camera cho trang, hoặc nhập/tìm mã bên dưới.');
      stopScan();
    }
  }, [addByCode, stopScan]);

  const setQty = (code: string, qty: number) =>
    setLines((prev) =>
      prev.map((l) => (l.code === code ? { ...l, qty: Math.max(1, qty) } : l)),
    );
  const removeLine = (code: string) =>
    setLines((prev) => prev.filter((l) => l.code !== code));

  const grandQty = lines.reduce((s, l) => s + l.qty, 0);
  const grandAmount = lines.reduce((s, l) => s + l.qty * l.price, 0);

  const searchHits = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q || !cfg?.allow_manual_search) return [];
    return (catalog?.rows || [])
      .filter((row) => {
        const code = String(row[matchCol] ?? '');
        const name = labelCol ? String(row[labelCol] ?? '') : '';
        return `${code} ${name}`.toUpperCase().includes(q);
      })
      .slice(0, 8);
  }, [search, catalog, matchCol, labelCol, cfg]);

  const genOrderId = useCallback(() => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${posTwoDigit(d.getMonth() + 1)}${posTwoDigit(d.getDate())}`;
    const hms = `${posTwoDigit(d.getHours())}${posTwoDigit(d.getMinutes())}${posTwoDigit(d.getSeconds())}`;
    return `${cfg?.order_id_prefix || 'PN'}-${ymd}-${hms}`;
  }, [cfg]);

  const submit = useCallback(async () => {
    setError(null);
    for (const h of headerInputs) {
      if (h.required && !String(header[h.column] ?? '').trim()) {
        setError(`Thiếu "${h.label}".`);
        return;
      }
    }
    if (lines.length === 0) {
      setError('Chưa quét sản phẩm nào.');
      return;
    }
    setSubmitting(true);
    stopScan();
    const orderId = cfg?.order_id_column ? genOrderId() : null;
    const today = new Date().toISOString().slice(0, 10);
    const ctx: Record<string, unknown> = { ...header };
    if (cfg?.order_id_column && orderId) ctx[cfg.order_id_column] = orderId;
    if (cfg?.date_column) ctx[cfg.date_column] = today;

    const rows = lines.map((l) => {
      const r: Record<string, unknown> = {};
      r[cfg.barcode_column] = l.code;
      r[cfg.quantity_column] = l.qty;
      for (const [lineCol, catCol] of Object.entries(cfg.catalog_copy || {})) {
        r[lineCol] = l.row[catCol] ?? '';
      }
      if (cfg.amount_column) r[cfg.amount_column] = Math.round(l.qty * l.price);
      for (const h of headerInputs) {
        if (h.write_to_line === false) continue;
        r[h.column] = header[h.column] ?? '';
      }
      if (cfg.order_id_column && orderId) r[cfg.order_id_column] = orderId;
      if (cfg.date_column) r[cfg.date_column] = today;
      return r;
    });

    try {
      // Phiếu HEADER row first (khi cấu hình header_screen_id) — giữ bảng
      // DonHang đồng bộ để "Tất cả phiếu" hiển thị phiếu lập từ POS.
      if (cfg.header_screen_id) {
        await workspaceApi.insertScreenRow(
          token,
          workboardId,
          cfg.header_screen_id,
          { ...ctx },
        );
      }
      const res = await workspaceApi.bulkInsertScreenRows(
        token,
        workboardId,
        spec.screen_id,
        rows,
      );
      if (res.failure > 0) {
        const first = res.results.find((x) => !x.ok);
        setError(`Lưu ${res.success}/${res.total} dòng. Lỗi: ${first?.error || 'không rõ'}.`);
        setSubmitting(false);
        return;
      }
      // Success — clear cart then route to the printable receipt.
      setLines([]);
      setSubmitting(false);
      if (cfg.after_submit_screen) {
        const carry: Record<string, unknown> = {};
        for (const col of cfg.after_submit_carry || []) {
          if (col in ctx) carry[col] = ctx[col];
        }
        onNavigate(cfg.after_submit_screen, carry);
      }
    } catch (e) {
      setError(isNetworkError(e) ? 'Mất mạng — thử lại khi có kết nối.' : 'Không lưu được phiếu.');
      setSubmitting(false);
    }
  }, [cfg, header, headerInputs, lines, genOrderId, stopScan, token, workboardId, spec.screen_id, onNavigate]);

  if (!cfg) return null;

  const inputCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200';

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Header inputs (Loại / Kho / Người…) — captured once per phiếu */}
      {headerInputs.length > 0 && (
        <div className="grid grid-cols-1 gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-2">
          {headerInputs.map((h) => (
            <label key={h.column} className="block space-y-1">
              <span className="text-xs font-medium text-slate-500">
                {h.label}
                {h.required && <span className="text-rose-500"> *</span>}
              </span>
              {h.kind === 'select' ? (
                <select
                  value={header[h.column] ?? ''}
                  onChange={(e) => setHeader((p) => ({ ...p, [h.column]: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">— Chọn —</option>
                  {(h.options || []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={h.kind === 'date' ? 'date' : 'text'}
                  value={header[h.column] ?? ''}
                  onChange={(e) => setHeader((p) => ({ ...p, [h.column]: e.target.value }))}
                  className={inputCls}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {/* Scanner + manual add */}
      <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
        {scanning && (
          <div className="space-y-1">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="h-56 w-full rounded-lg border border-slate-300 bg-black object-cover" />
            <button type="button" onClick={stopScan} className="text-xs text-rose-600 hover:underline">
              Dừng quét
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim()) {
                e.preventDefault();
                addByCode(manual);
                setManual('');
              }
            }}
            placeholder="Quét hoặc nhập mã hàng rồi Enter"
            className={inputCls}
          />
          {scanSupported && !scanning && (
            <button
              type="button"
              onClick={startScan}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: accent }}
            >
              <ScanLine className="h-4 w-4" /> Quét
            </button>
          )}
        </div>
        {scanError && <p className="text-xs text-rose-600">{scanError}</p>}

        {cfg.allow_manual_search && (
          <div className="space-y-1.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm sản phẩm theo tên / mã…"
              className={inputCls}
            />
            {searchHits.length > 0 && (
              <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {searchHits.map((row) => {
                  const code = String(row[matchCol] ?? '');
                  const name = labelCol ? String(row[labelCol] ?? '') : '';
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => {
                        addByCode(code);
                        setSearch('');
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="truncate">
                        <span className="font-medium text-slate-700">{code}</span>
                        {name && <span className="text-slate-500"> — {name}</span>}
                      </span>
                      <Plus className="h-4 w-4 shrink-0 text-slate-400" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cart lines */}
      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        <div
          className="flex items-center justify-between border-b border-slate-100 px-4 py-3"
          style={{ backgroundColor: `${accent}0D` }}
        >
          <div>
            <span className="text-sm font-semibold text-slate-800">Danh sách quét</span>
            <p className="mt-0.5 text-xs text-slate-500 sm:hidden">
              Kiểm tra số lượng trước khi lưu phiếu
            </p>
          </div>
          <span
            className="rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ backgroundColor: `${accent}18`, color: accent }}
          >
            {lines.length} mặt hàng · SL {grandQty}
          </span>
        </div>
        {lines.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            {cfg.empty_hint || 'Quét mã để thêm sản phẩm vào danh sách.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {lines.map((l) => (
              <li key={l.code} className="px-4 py-3 sm:flex sm:items-center sm:gap-3">
                <div className="flex min-w-0 items-start justify-between gap-3 sm:flex-1">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold leading-snug text-slate-900 sm:truncate">
                      {l.label}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                        {l.code}
                      </span>
                      {l.price > 0 && (
                        <span>{l.price.toLocaleString('vi-VN')} ₫ / đơn vị</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(l.code)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-rose-500 hover:bg-rose-50 sm:hidden"
                    aria-label="Xóa sản phẩm"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 sm:mt-0 sm:shrink-0 sm:justify-end">
                  <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                    <button
                      type="button"
                      onClick={() => setQty(l.code, l.qty - 1)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-white"
                    >
                      –
                    </button>
                    <input
                      type="number"
                      value={l.qty}
                      min={1}
                      onChange={(e) => setQty(l.code, posToNum(e.target.value))}
                      className="h-8 w-12 rounded-md border border-slate-200 bg-white px-1 text-center text-sm font-semibold"
                    />
                    <button
                      type="button"
                      onClick={() => setQty(l.code, l.qty + 1)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-white"
                    >
                      +
                    </button>
                  </div>
                  {l.price > 0 && (
                    <div className="min-w-[112px] text-right">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 sm:hidden">
                        Thành tiền
                      </p>
                      <p className="text-sm font-bold text-slate-900">
                        {(l.qty * l.price).toLocaleString('vi-VN')} ₫
                      </p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeLine(l.code)}
                    className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-rose-500 hover:bg-rose-50 sm:flex"
                    aria-label="Xóa sản phẩm"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {grandAmount > 0 && (
          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-3">
            <span className="text-sm font-semibold text-slate-700">Tổng tiền</span>
            <span className="text-lg font-bold text-slate-950">
              {grandAmount.toLocaleString('vi-VN')} ₫
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Submit — nothing is saved until here */}
      <div className="sticky bottom-3 z-10">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || lines.length === 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold text-white shadow-lg disabled:opacity-50"
          style={{ backgroundColor: accent }}
        >
          {submitting ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Printer className="h-5 w-5" />
          )}
          {cfg.submit_label || 'Lưu phiếu'}
          {lines.length > 0 && !submitting && <span className="opacity-90">({lines.length})</span>}
        </button>
      </div>
    </div>
  );
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
  // 'edit' opens an existing row; 'create' opens a blank row (same side panel,
  // one consistent concept for add + edit) — used by the calendar day-click.
  const [panelMode, setPanelMode] = useState<'edit' | 'create'>('edit');

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
  const rollupSpecs = useMemo(() => tv.rollup_columns || [], [tv.rollup_columns]);
  const formatRules = useMemo(() => tv.format_rules || [], [tv.format_rules]);
  const totalsSpec = (tv.totals || {}) as Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count'>;
  const derivedCols = useMemo(
    () =>
      new Set([
        ...computedSpecs.map((c) => c.name),
        ...lookupSpecs.map((l) => l.name),
        ...rollupSpecs.map((r) => r.name),
      ]),
    [computedSpecs, lookupSpecs, rollupSpecs],
  );
  const formatByCol = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const c of computedSpecs) out[c.name] = c.format ?? null;
    for (const l of lookupSpecs) out[l.name] = l.format ?? null;
    for (const r of rollupSpecs) out[r.name] = r.format ?? null;
    for (const [name, meta] of Object.entries(tv.column_metadata || {})) {
      if (meta?.format && out[name] === undefined) out[name] = meta.format;
    }
    return out;
  }, [computedSpecs, lookupSpecs, rollupSpecs, tv.column_metadata]);
  // Phase-19: conditional formatting. Evaluate each rule's ``when`` expr per
  // row via the shared row-local expr engine (same one as show_if/valid_if).
  // First matching rule wins. ``columns`` empty ⇒ tint whole row; otherwise
  // only the named cells. Colours reuse the StatusField tone palette.
  const rowFormat = useCallback(
    (row: Record<string, unknown>): {
      tone: string;
      columns: Set<string> | null;
      icon?: string | null;
      label?: string | null;
    } | null => {
      for (const rule of formatRules) {
        if (!rule.when) continue;
        let hit = false;
        try {
          hit = evaluateTruthy(rule.when, { row, app_user: {}, shared: {} }, false);
        } catch {
          hit = false;
        }
        if (hit) {
          return {
            tone: STATUS_TONES[rule.color || 'amber'] || STATUS_TONES.amber,
            columns: rule.columns && rule.columns.length > 0 ? new Set(rule.columns) : null,
            icon: rule.icon,
            label: rule.label,
          };
        }
      }
      return null;
    },
    [formatRules],
  );
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
    setPanelMode('edit');
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

  // Open the SAME side panel for a brand-new row (add), with `prefill` values
  // (e.g. the calendar day the user tapped). No fetch — synthesize a blank
  // detail so add + edit share one consistent UI.
  const openCreatePanel = (prefill: Record<string, unknown>) => {
    if (!allowAdd) return;
    const cols = Array.from(editableCols);
    setPanelMode('create');
    setPanelError(null);
    setPanelDraft({ ...prefill });
    setPanelLoading(false);
    setPanelDetail({
      row: { ...prefill },
      columns: cols,
      editable_columns: cols,
      primary_key_columns: [],
      column_labels: colLabels,
    } as unknown as TableRowDetailResponse);
    setPanelRowKey('__new__');
  };

  const closeDetailPanel = () => {
    setPanelRowKey(null);
    setPanelDetail(null);
    setPanelDraft({});
    setPanelError(null);
    setPanelMode('edit');
  };

  const savePanelDraft = async () => {
    if (!panelDetail) return;
    setPanelSaving(true);
    setPanelError(null);
    try {
      if (panelMode === 'create') {
        // Merge the synthetic row (prefill) with the user's draft edits.
        const values = { ...(panelDetail.row || {}), ...panelDraft };
        await workspaceApi.insertScreenRow(token, workboardId, current.screen_id, values);
        await reloadRows(filterValues);
        closeDetailPanel();
        return;
      }
      if (Object.keys(panelDraft).length === 0) return;
      const pk: Record<string, unknown> = {};
      for (const c of panelDetail.primary_key_columns || []) pk[c] = panelDetail.row[c];
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
    <div className="w-full min-w-0 overflow-hidden rounded-xl bg-white shadow-sm">
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
                  <div key={key} className="grid gap-2 sm:grid-cols-2 md:col-span-2">
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
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={filterLoading}
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:w-auto sm:py-1.5"
              style={{ backgroundColor: accent }}
            >
              {filterLoading ? 'Đang lọc...' : 'Áp dụng bộ lọc'}
            </button>
            <button
              type="button"
              onClick={() => void reloadRows({})}
              disabled={filterLoading || Object.keys(filterValues).length === 0}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 disabled:opacity-50 sm:w-auto sm:py-1.5"
            >
              Xóa lọc
            </button>
          </div>
        </form>
      )}

      {Array.isArray(current.stat_tiles) && current.stat_tiles.length > 0 && (
        <div className="grid min-w-0 gap-2 px-2 py-2 sm:grid-cols-2 lg:grid-cols-4">
          {current.stat_tiles.map((tile, i) => (
            <div key={i} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <div className="truncate text-xs text-slate-500">{tile.label}</div>
              <div className="mt-0.5 text-lg font-semibold text-slate-800">
                {tile.value == null || tile.value === ''
                  ? '—'
                  : `${formatCellValue(tile.value)}${tile.unit ? ' ' + tile.unit : ''}`}
              </div>
            </div>
          ))}
        </div>
      )}

      {tv.display_mode === 'gallery' && tv.gallery_config ? (
        <GalleryView
          rows={rows}
          config={tv.gallery_config}
          colLabels={colLabels}
          onOpen={openDetailPanel}
          panelEnabled={panelEnabled}
          emptyMessage={tv.empty_state_message}
          rowFormat={formatRules.length > 0 ? rowFormat : undefined}
        />
      ) : tv.display_mode === 'calendar' && tv.calendar_config ? (
        <CalendarView
          rows={rows}
          config={tv.calendar_config}
          accent={accent}
          canAdd={allowAdd}
          canEdit={panelEnabled && pkCols.length > 0}
          onEditRow={openDetailPanel}
          onAddOnDate={(d) => openCreatePanel({ [tv.calendar_config!.date_column]: d })}
        />
      ) : (
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="min-w-max w-full text-sm">
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
              const fmt = rowFormat(row);
              // Whole-row tint only when the rule targets no specific columns.
              const rowTint = fmt && !fmt.columns ? fmt.tone : null;
              return (
                <tr
                  key={`${rowKey}:${idx}`}
                  className={`border-b border-slate-100 ${
                    status?.status === 'error'
                      ? 'bg-red-50/40'
                      : rowTint
                        ? rowTint
                        : 'hover:bg-slate-50'
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
                    // Cell-scoped conditional format (rule named this column).
                    const cellTint = fmt && fmt.columns?.has(c) ? fmt.tone : null;
                    return (
                      <td
                        key={c}
                        rowSpan={rowspan}
                        className={`px-3 py-1.5 align-top ${
                          cellTint
                            ? `${cellTint} font-medium`
                            : editable
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
                            meta={(tv.column_metadata || {})[c] as CellMeta}
                          />
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            {cellTint && fmt?.icon ? <span aria-hidden>{fmt.icon}</span> : null}
                            <FormattedCell value={cellValue} format={format} />
                          </span>
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
                          meta={(tv.column_metadata || {})[c] as CellMeta}
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
      )}

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

      {panelRowKey && (panelEnabled || panelMode === 'create') && (
        <div className="fixed inset-0 z-40 flex bg-black/30 sm:bg-transparent">
          <div className="hidden flex-1 bg-black/30 sm:block" onClick={closeDetailPanel} />
          <aside className="flex h-full w-full flex-col bg-white shadow-2xl sm:max-w-md sm:border-l sm:border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                {panelMode === 'create'
                  ? `Thêm mới · ${spec.title || ''}`.trim().replace(/·\s*$/, '')
                  : panelDetail?.title || spec.title || 'Chi tiết'}
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
              <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
                <button
                  type="button"
                  onClick={panelMode === 'create' ? closeDetailPanel : () => setPanelDraft({})}
                  disabled={panelSaving}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:w-auto sm:py-1.5"
                >
                  {panelMode === 'create' ? 'Huỷ' : 'Huỷ thay đổi'}
                </button>
                <button
                  type="button"
                  onClick={() => void savePanelDraft()}
                  disabled={panelSaving || (panelMode === 'edit' && Object.keys(panelDraft).length === 0)}
                  className="w-full rounded-md px-3 py-2 text-xs font-medium text-white disabled:opacity-50 sm:w-auto sm:py-1.5"
                  style={{ backgroundColor: accent }}
                >
                  {panelSaving ? 'Đang lưu...' : panelMode === 'create' ? 'Thêm' : 'Lưu'}
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
            <div key={col} className="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-3">
              <dt className="text-xs font-medium text-slate-600">
                {label}
                {isDerived ? (
                  <span className="ml-1 text-[10px] text-indigo-500" title="Computed/Lookup">
                    ƒ
                  </span>
                ) : null}
              </dt>
              <dd className="text-sm text-slate-800 sm:col-span-2">
                {isEditable && !isDerived ? (
                  <TableCellInput
                    value={draftValue}
                    onCommit={(next) => setDraft((prev) => ({ ...prev, [col]: next }))}
                    meta={detail.column_metadata?.[col] as CellMeta}
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
// Column-meta shape driving a typed inline cell (subset of TableColumnMetaSpec).
type CellMeta = {
  input_type?: string | null;
  options?: Array<{ label: string; value: unknown }> | null;
  currency_code?: string | null;
  max_stars?: number | null;
  min_value?: number | null;
  max_value?: number | null;
  step?: number | null;
} | null | undefined;

function TableCellInput({
  value,
  onCommit,
  placeholder,
  meta,
}: {
  value: unknown;
  onCommit: (next: unknown) => void;
  placeholder?: string;
  meta?: CellMeta;
}) {
  const it = meta?.input_type || 'text';

  // ── Typed controls that commit immediately ──────────────────────────
  if (it === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value === true || value === 'true' || value === 1 || value === '1'}
        onChange={(e) => onCommit(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
    );
  }
  if (it === 'color') {
    return (
      <input
        type="color"
        value={value ? String(value) : '#2563eb'}
        onChange={(e) => onCommit(e.target.value)}
        className="h-7 w-10 cursor-pointer rounded border border-slate-200 p-0.5"
      />
    );
  }
  if (it === 'rating') {
    return (
      <RatingField
        field={{ max_stars: meta?.max_stars } as unknown as RuntimeField}
        value={value}
        onChange={onCommit}
        readonly={false}
      />
    );
  }
  if (it === 'slider') {
    return (
      <SliderField
        field={
          {
            min_value: meta?.min_value,
            max_value: meta?.max_value,
            step: meta?.step,
          } as unknown as RuntimeField
        }
        value={value}
        onChange={onCommit}
        readonly={false}
        unit=""
      />
    );
  }
  if (it === 'enum_list') {
    return (
      <EnumListField
        field={{} as RuntimeField}
        options={(meta?.options || []).map((o) => ({ label: o.label, value: o.value })) as LookupOption[]}
        value={value}
        onChange={onCommit}
        readonly={false}
      />
    );
  }
  if (it === 'select') {
    return (
      <select
        value={value == null ? '' : String(value)}
        onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
        className="h-8 w-full rounded border border-transparent bg-transparent px-2 text-sm outline-none hover:border-slate-200 focus:border-slate-400 focus:bg-white"
      >
        <option value="">—</option>
        {(meta?.options || []).map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  // ── Text-like typed inputs (commit on blur/Enter) ───────────────────
  const numeric = it === 'number' || it === 'currency' || it === 'percent';
  const htmlType =
    it === 'date' ? 'date'
    : it === 'datetime' ? 'datetime-local'
    : it === 'time' ? 'time'
    : numeric ? 'number'
    : 'text';
  return (
    <TextCellInput
      value={value}
      onCommit={onCommit}
      htmlType={htmlType}
      numeric={numeric}
      placeholder={placeholder || (meta?.currency_code ? String(meta.currency_code) : undefined)}
    />
  );
}

// Text/number/date-like inline cell — holds its own draft state (hooks live
// here so TableCellInput's typed dispatch never calls hooks conditionally).
function TextCellInput({
  value,
  onCommit,
  htmlType,
  numeric,
  placeholder,
}: {
  value: unknown;
  onCommit: (next: unknown) => void;
  htmlType: string;
  numeric: boolean;
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
    if (draft === '') return onCommit(null);
    onCommit(numeric ? Number(draft) : draft);
  };

  return (
    <input
      type={htmlType}
      step={numeric ? 'any' : undefined}
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

// Reusable letterhead atop every printable document — company logo + name +
// address, set up once in App Settings (print_template). Part of the
// .wb-print-target so it prints/PDFs with the doc.
function PrintLetterhead({ template }: { template: PrintTemplate }) {
  const accent = template.accent_color || '#0f766e';
  const lines = [
    template.address ? `Địa chỉ: ${template.address}` : null,
    template.tax_code ? `MST: ${template.tax_code}` : null,
    template.hotline ? `Hotline: ${template.hotline}` : null,
    template.email || null,
    template.website || null,
  ].filter(Boolean) as string[];
  if (!template.company_name && lines.length === 0 && !template.logo_data) return null;
  return (
    <div
      className="mb-4 flex items-center gap-4 border-b-2 pb-3"
      style={{ borderColor: accent }}
    >
      {template.logo_data && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={template.logo_data} alt="logo" className="h-14 w-14 shrink-0 rounded object-contain" />
      )}
      <div className="min-w-0">
        {template.company_name && (
          <p className="text-sm font-bold uppercase leading-tight" style={{ color: accent }}>
            {template.company_name}
          </p>
        )}
        {lines.map((l) => (
          <p key={l} className="text-[11px] leading-tight text-slate-500">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function DocExportButton({
  token,
  workboardId,
  screenId,
  blockIndex,
  blockTitle,
  shared,
  compactLabel,
  variant = 'toolbar',
}: {
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
  blockTitle?: string | null;
  shared?: Record<string, unknown>;
  compactLabel?: boolean;
  variant?: 'toolbar' | 'floating';
}) {
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
        shared,
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
      if (err instanceof Error && err.message) {
        setExportError(err.message);
      } else {
        setExportError(
          typeof apiError.response?.data?.detail === 'string'
            ? apiError.response.data.detail
            : 'Không xuất được Excel.',
        );
      }
    } finally {
      setExporting(false);
    }
  };

  const label = compactLabel
    ? 'Excel'
    : blockTitle
      ? `Excel: ${blockTitle}`
      : 'Xuất Excel';
  const floating = variant === 'floating';

  return (
    <span className={floating ? 'inline-flex' : 'inline-flex min-w-0 flex-col items-start gap-1'}>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        className={
          floating
            ? 'inline-flex h-11 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
            : 'inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
        }
        title={blockTitle ? `Xuất Excel: ${blockTitle}` : 'Xuất Excel'}
      >
        {exporting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        <span>{exporting ? 'Đang xuất…' : label}</span>
      </button>
      {exportError && (
        <span className="max-w-xs text-xs text-rose-600">{exportError}</span>
      )}
    </span>
  );
}

function DocScreen({
  spec,
  token,
  workboardId,
  shared,
  accent,
}: {
  spec: DocScreenResponse;
  token: string;
  workboardId: number;
  shared?: Record<string, unknown>;
  accent: string;
}) {
  const exportableBlocks = (spec.blocks || [])
    .map((block, index) => ({
      block,
      index,
      title: typeof block.title === 'string' ? block.title : null,
    }))
    .filter(({ block }) => block.type === 'data_table' && block.allow_export_excel);
  const hasDocActions = true;

  return (
    <div className="w-full min-w-0 pb-16 md:pb-0">
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm print:hidden">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Tài liệu
          </p>
          <h2 className="truncate text-sm font-semibold text-slate-800">
            {spec.title}
          </h2>
        </div>
        <div className="hidden items-center gap-1 rounded-full border border-slate-200 bg-slate-50/80 p-1 md:flex">
          <button
            type="button"
            onClick={printLabel}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" /> In
          </button>
          {exportableBlocks.map(({ index, title }) => (
            <DocExportButton
              key={index}
              token={token}
              workboardId={workboardId}
              screenId={spec.screen_id}
              blockIndex={index}
              blockTitle={exportableBlocks.length > 1 ? title : null}
              shared={shared}
              compactLabel={exportableBlocks.length <= 1}
            />
          ))}
        </div>
      </div>
      {hasDocActions && (
        <div
          className="fixed right-3 z-40 flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 p-1 shadow-xl backdrop-blur md:hidden print:hidden"
          style={{ bottom: 'calc(5.25rem + env(safe-area-inset-bottom))' }}
        >
          <button
            type="button"
            onClick={printLabel}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold text-white shadow-sm"
            style={{ backgroundColor: accent }}
          >
            <Printer className="h-4 w-4" /> In
          </button>
          {exportableBlocks.map(({ index, title }) => (
            <DocExportButton
              key={index}
              token={token}
              workboardId={workboardId}
              screenId={spec.screen_id}
              blockIndex={index}
              blockTitle={exportableBlocks.length > 1 ? title : null}
              shared={shared}
              compactLabel={exportableBlocks.length <= 1}
              variant="floating"
            />
          ))}
        </div>
      )}
      <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2 print:overflow-visible print:pb-0">
        <div className="wb-print-target w-full min-w-0 space-y-3 rounded-xl bg-white p-4 shadow-sm sm:p-6 print:w-full">
          {spec.print_template && spec.print_template.enabled !== false && (
            <PrintLetterhead template={spec.print_template} />
          )}
          {(spec.blocks || []).map((b, i) => (
            <DocBlock
              key={i}
              block={b}
              token={token}
              workboardId={workboardId}
              screenId={spec.screen_id}
              blockIndex={i}
              shared={shared}
            />
          ))}
          {spec.print_template?.footer_note && (
            <p className="mt-4 border-t border-slate-200 pt-2 text-center text-[11px] italic text-slate-400">
              {spec.print_template.footer_note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DocBlock({
  block,
  token,
  workboardId,
  screenId,
  blockIndex,
  shared,
}: {
  block: Record<string, unknown>;
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
  shared?: Record<string, unknown>;
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
        shared={shared}
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
  if (t === 'qr_code') {
    // Server has already resolved {{shared.*}}/{{app_user.*}} into block.value.
    // Resolve {{app_url}} on the client (needs origin+path) so a label can
    // encode a deep-link back into this mini-app.
    const encoded = resolveQrTemplate(String(block.value || ''));
    const size = Number(block.size || 180);
    const caption = block.caption ? String(block.caption) : '';
    const align = (block.align as string) || 'center';
    const justify =
      align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
    return (
      <div className={`my-2 flex ${justify}`}>
        <div className="flex flex-col items-center gap-1.5">
          {encoded ? (
            <QRCodeSVG value={encoded} size={size} level="M" marginSize={2} />
          ) : (
            <div className="text-xs text-slate-400">Chưa có giá trị để tạo mã QR</div>
          )}
          {caption && <div className="text-center text-xs text-slate-600">{caption}</div>}
        </div>
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
  shared,
}: {
  triggers: SyncTriggerSpec[];
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
  shared?: Record<string, unknown>;
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
        shared,
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
  shared,
}: {
  block: Record<string, unknown>;
  token: string;
  workboardId: number;
  screenId: string;
  blockIndex: number;
  shared?: Record<string, unknown>;
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
  const allowExport = false;
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
        shared,
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
      if (err instanceof Error && err.message) {
        setExportError(err.message);
        return;
      }
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

  // Per-column number formatting from the block's column_metadata, so the
  // on-screen (and printed) document matches the templated Excel.
  const metaByCol = (block.column_metadata as Record<string, { format?: string | null }>) || {};
  const NUMERIC_FMT = new Set(['currency', 'number', 'integer', 'percent']);
  const isNumericCol = (c: string) => NUMERIC_FMT.has(String(metaByCol[c]?.format || ''));
  const fmtDocCell = (c: string, v: unknown): string => {
    const f = String(metaByCol[c]?.format || '');
    if (v == null || v === '') return '';
    if (NUMERIC_FMT.has(f)) {
      const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n)) return String(v);
      if (f === 'currency') return `${n.toLocaleString('vi-VN')} ₫`;
      if (f === 'integer') return Math.round(n).toLocaleString('vi-VN');
      if (f === 'percent') return `${(n * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
      return n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
    }
    return String(v);
  };

  return (
    <div>
      {title && (
        <h3 className="mb-1 text-sm font-semibold text-slate-800">{title}</h3>
      )}
      {syncTriggers.length > 0 && (
        // Interactive actions — kept OUT of the printed document (print:hidden)
        // and laid out as one tidy toolbar rather than a cramped stack.
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-2 py-1.5 print:hidden">
          {allowExport && (
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              title="Tải Excel theo biểu mẫu"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>{exporting ? 'Đang xuất…' : 'Xuất Excel'}</span>
            </button>
          )}
          {syncTriggers.length > 0 && (
            <BlockSyncControls
              triggers={syncTriggers}
              token={token}
              workboardId={workboardId}
              screenId={screenId}
              blockIndex={blockIndex}
              shared={shared}
            />
          )}
        </div>
      )}
      {exportError && (
        <p className="mb-2 text-xs text-rose-600">{exportError}</p>
      )}
      <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-slate-200">
        <table className="min-w-max w-full border-collapse text-sm">
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
                        isNumericCol(c) ? 'text-right tabular-nums' : ''
                      } ${span ? 'bg-slate-50 align-middle font-medium' : ''}`}
                    >
                      {fmtDocCell(c, row[c])}
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
                    const numeric = isNumericCol(c);
                    return (
                      <td
                        key={c}
                        className={`border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 ${
                          numeric ? 'text-right tabular-nums' : ''
                        } ${frIdx === 0 ? 'border-t-2 border-t-slate-400' : ''}`}
                      >
                        {isLabelCell
                          ? String(fr.label)
                          : v == null
                            ? ''
                            : numeric
                              ? fmtDocCell(c, v)
                              : formatTotal(v)}
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
