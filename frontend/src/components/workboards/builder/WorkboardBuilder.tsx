/**
 * WorkboardBuilder — visual editor for the mini-app layout.
 *
 * Layout: left rail (screens list) · center (tabbed ScreenEditor) · right
 * (Live Preview iframe). RLS used to live in a separate right panel; it now
 * sits inside the "Permissions" tab of the ScreenEditor so the builder has only
 * two visible panes (editor + preview).
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  LayoutGrid,
  Loader2,
  Lock,
  Save,
} from 'lucide-react';

import { type Workboard } from '@/lib/api/workboards';
import { apiClient } from '@/lib/api-client';
import { useDatasets } from '@/hooks/use-datasets';
import { useWorkboardPresence } from '@/hooks/use-workboard-presence';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { useI18n } from '@/providers/LanguageProvider';
import {
  ensureLayout,
  MiniAppLayoutSpec,
  ScreenKind,
  ScreenSpec,
} from './types';
import ScreenEditor from './ScreenEditor';
import BuilderLivePreview from './BuilderLivePreview';
import { registerAutosaveFlush } from './autosaveFlushRegistry';
import CanvasOverview from './CanvasOverview';
import ScreenSwitcherModal from './ScreenSwitcherModal';
import { useDebouncedAutosave } from './useDebouncedAutosave';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface DatasetTableApi {
  id: number;
  display_name: string;
  source_table_name: string;
  columns_cache?: unknown;
}

function columnsFromCache(cache: unknown): { name: string; type?: string }[] {
  const arr: unknown[] = Array.isArray(cache)
    ? cache
    : cache && typeof cache === 'object' && Array.isArray((cache as { columns?: unknown }).columns)
      ? (cache as { columns: unknown[] }).columns
      : [];
  return arr
    .filter((c): c is { name: unknown; type?: unknown } =>
      Boolean(c && typeof c === 'object' && 'name' in c),
    )
    .map((c) => ({ name: String(c.name), type: c.type ? String(c.type) : undefined }));
}

interface Props {
  workboard: Workboard;
}

type ScreenStatus = 'ok' | 'warn' | 'missing';

function screenStatus(s: ScreenSpec): ScreenStatus {
  if (s.kind === 'form' || s.kind === 'table') {
    if (!s.table_id) return 'missing';
  }
  if (s.kind === 'form') {
    const fields = (s.form?.fields || []) as Array<unknown>;
    if (fields.length === 0) return 'warn';
  }
  if (s.kind === 'table') {
    const cols = s.table?.columns || [];
    if (cols.length === 0) return 'warn';
  }
  if (s.kind === 'doc') {
    const blocks = s.doc?.blocks || [];
    if (blocks.length === 0) return 'warn';
  }
  if (s.kind === 'dashboard') {
    const hasManaged = typeof s.dashboard?.dashboard_id === 'number' && (s.dashboard.dashboard_id ?? 0) > 0;
    const hasManual = !!(s.dashboard?.share_token || '').trim();
    if (!hasManaged && !hasManual) return 'missing';
  }
  return 'ok';
}

// Stable per-user colour + initials for the co-edit presence avatars.
const PRESENCE_COLORS = ['#2563eb', '#16a34a', '#db2777', '#d97706', '#7c3aed', '#0891b2'];
function presenceColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length];
}
function presenceInitials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function WorkboardBuilder({ workboard }: Props) {
  const { t } = useI18n();
  const { data: datasets = [] } = useDatasets();
  const [boundDatasetId, setBoundDatasetId] = useState(workboard.dataset_id);
  const [layout, setLayoutRaw] = useState<MiniAppLayoutSpec>(() =>
    ensureLayout(workboard.layout_json),
  );
  const [activeScreenId, setActiveScreenId] = useState<string | null>(
    () => ensureLayout(workboard.layout_json).screens[0]?.id || null,
  );
  const [tables, setTables] = useState<DatasetTableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  // The redesign separates the builder into two modes:
  //   - canvas  : list of screen cards (Mức 1)
  //   - editor  : full-page editor of a single screen (Mức 2)
  // The transition is driven by ``activeScreenId``: null = canvas, set =
  // editor. We keep both on the same URL so refresh + back/forward stay
  // simple; if a user wants a deep link to a specific screen we can add
  // it later as a search param.
  const [mode, setMode] = useState<'canvas' | 'editor'>('canvas');
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [focusFieldColumn, setFocusFieldColumn] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);

  // View-only users get a fully read-only builder: autosave is disabled and
  // every layout mutation is a no-op, so no edit can reach the backend (which
  // would 403 anyway) and the surface can't masquerade as editable. All
  // structural/field/settings edits funnel through ``setLayout`` — shadowing it
  // is a single choke-point; the only non-setLayout write (dataset change) and
  // the add/delete navigation side-effects are guarded explicitly below.
  const canEdit = getResourcePermissions(workboard.user_permission ?? undefined).canEdit;

  // ── Co-edit soft-lock ──
  // The screen the user currently has open in the editor (their "cursor").
  // null on the canvas.
  const editingScreenId = mode === 'editor' ? activeScreenId : null;
  const presence = useWorkboardPresence(workboard.id, canEdit, editingScreenId);
  // Someone ELSE holds the lock on the screen I'm viewing → I'm view-only for
  // it until I take over (or they leave). The backend version-409 guard is the
  // hard net beneath this; the lock just prevents the accident up front.
  const activeScreenLocked = !!(
    editingScreenId &&
    presence.lock &&
    presence.lock.holder_key &&
    !presence.lock.held_by_me
  );
  const canWrite = canEdit && !activeScreenLocked;

  // ── Autosave save-path classification (Slice 2) ──
  // Screen-CONTENT edits (updateScreen) persist screen-scoped so people on
  // different screens never 409/clobber; structural/app edits persist
  // whole-board. `setLayout` (the structural choke-point) marks structural;
  // `updateScreen` marks the one screen. Refs (not state) so the autosave
  // drain reads the freshest classification without re-render churn.
  const dirtyStructuralRef = useRef(false);
  const dirtyScreenIdsRef = useRef<Set<string>>(new Set());

  // View-only users OR a screen locked by a collaborator → every layout
  // mutation is a no-op (single choke-point, mirroring the !canEdit shadow).
  // Autosave stays enabled on `canEdit` so edits made on OTHER (unlocked)
  // screens still flush — the lock only blocks NEW mutations of the locked
  // screen, which never reach `layout` anyway.
  const setLayout: typeof setLayoutRaw = (value) => {
    if (!canWrite) return;
    dirtyStructuralRef.current = true;
    setLayoutRaw(value);
  };

  useEffect(() => {
    setBoundDatasetId(workboard.dataset_id);
  }, [workboard.id, workboard.dataset_id]);

  // Persistence keys for the resizable preview pane. The Panel itself
  // remembers its size via ``autoSaveId``; ``PREVIEW_COLLAPSED_KEY``
  // stores the collapsed/expanded flag separately because a collapsed
  // Panel has size 0 and would otherwise look like "remembered tiny".
  const SPLIT_STORAGE_KEY = 'wb-builder-split-v1';
  const PREVIEW_COLLAPSED_KEY = 'wb-builder-preview-collapsed-v1';

  // Restore the collapsed preference on mount. We default to STARTING
  // COLLAPSED so the editor gets the full width on first paint; the
  // user re-opens preview from the topbar button when they want it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(PREVIEW_COLLAPSED_KEY);
    // First-time visitor (no stored value) → start collapsed.
    // Returning visitor → honour what they last had.
    const wasCollapsed = stored === null ? true : stored === '1';
    if (wasCollapsed) {
      setPreviewCollapsed(true);
      queueMicrotask(() => previewPanelRef.current?.collapse());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePreview = () => {
    const panel = previewPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  // Reflect the screen being edited in the URL (?screen=<id>) so the builder is
  // deep-linkable and survives F5 — refresh stays on the SCREEN instead of
  // dropping back to the canvas — and browser back/forward walk
  // screen→screen→canvas. Raw History API (not the Next router) so switching
  // screens never remounts the builder mid-edit. `null` → canvas (bare URL).
  const writeBuilderUrl = (screenId: string | null) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if ((url.searchParams.get('screen') || null) === (screenId || null)) return;
    url.search = screenId ? `?screen=${encodeURIComponent(screenId)}` : '';
    window.history.pushState({ wbScreen: screenId }, '', url);
  };

  const openScreen = (id: string) => {
    setActiveScreenId(id);
    setMode('editor');
    writeBuilderUrl(id);
  };

  const backToCanvas = () => {
    setMode('canvas');
    setFocusFieldColumn(null);
    writeBuilderUrl(null);
  };

  // Deep-link: /workboards/[id]?screen=<id> opens that screen straight in the
  // editor. Used by Settings → App health "Sửa" links so a blocking issue jumps
  // the author to the exact screen. Runs once on mount; ignores unknown ids.
  const searchParams = useSearchParams();
  useEffect(() => {
    const target = searchParams?.get('screen');
    if (!target) return;
    const exists = ensureLayout(workboard.layout_json).screens.some((s) => s.id === target);
    if (exists) {
      setActiveScreenId(target);
      setMode('editor');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser back/forward → move between screens (and back to canvas). Reads the
  // screen from the URL; an unknown/blank id just falls to canvas via the
  // isEditor guard (activeScreen === null), so no existence check is needed.
  useEffect(() => {
    const onPop = () => {
      const sid = new URLSearchParams(window.location.search).get('screen');
      if (sid) {
        setActiveScreenId(sid);
        setMode('editor');
      } else {
        setMode('canvas');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Auto-save with a 1.2s debounce. The mini-preview iframe re-keys on
  // each successful save so the user sees their edits the moment the
  // save lands (no Save button click needed).
  const autosave = useDebouncedAutosave(workboard.id, layout, canEdit, {
    structuralRef: dirtyStructuralRef,
    screenIdsRef: dirtyScreenIdsRef,
  });

  // Expose the flush so the topbar Publish control can drain the latest draft
  // before the server promotes Draft → Published (see autosaveFlushRegistry).
  useEffect(() => {
    registerAutosaveFlush(autosave.flush);
    return () => registerAutosaveFlush(null);
  }, [autosave.flush]);

  // Dataset rebind (change dataset + remap/clear screens) now lives in the
  // Settings tab (Settings › Data), not the Build canvas.

  // Load dataset tables once so editors can show column dropdowns.
  useEffect(() => {
    let alive = true;
    setTables([]);
    setTablesLoading(true);
    (async () => {
      try {
        const r = await apiClient.get(`/datasets/${boundDatasetId}/tables`);
        const arr = Array.isArray(r.data) ? (r.data as DatasetTableApi[]) : [];
        const ts = arr.map((t) => ({
          id: t.id,
          display_name: t.display_name,
          source_table_name: t.source_table_name,
          columns: columnsFromCache(t.columns_cache),
        }));
        if (alive) setTables(ts);
      } catch {
        // Non-fatal — editors fall back to free-text input when columns are missing.
      } finally {
        if (alive) setTablesLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [boundDatasetId]);

  const activeScreen = useMemo(
    () => layout.screens.find((s) => s.id === activeScreenId) || null,
    [layout.screens, activeScreenId],
  );

  // Listen for postMessage from the live preview iframe. The runtime form
  // renderer wraps each field in a clickable wrapper that posts
  // `{ type: "wb-builder/field-click", screenId, column }`. We use it to
  // jump to the matching screen + auto-select the field in the inspector.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only trust messages from OUR OWN origin (the preview iframe is
      // same-origin at /ws/...). Without this, any window that embeds/opens the
      // builder could drive its active screen/field selection.
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== 'wb-builder/field-click') return;
      const screenId = String((data as { screenId?: unknown }).screenId || '');
      const column = String((data as { column?: unknown }).column || '');
      if (!column) return;
      if (screenId && screenId !== activeScreenId) {
        setActiveScreenId(screenId);
      }
      // Field-click from the preview iframe always wants the user inside
      // the editor — never the canvas.
      setMode('editor');
      setFocusFieldColumn(column);
      if (screenId) writeBuilderUrl(screenId);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeScreenId]);

  // Screen-CONTENT edit. Marks ONLY this screen dirty (screen-scoped save) and
  // writes via the raw setter so it does NOT trip the structural marker in
  // `setLayout` — that's what keeps different-screen edits off the whole-board
  // (409-guarded) path. Same lock/permission guard as `setLayout`.
  const updateScreen = (next: ScreenSpec) => {
    if (!canWrite) return;
    dirtyScreenIdsRef.current.add(next.id);
    setLayoutRaw((curr) => ({
      ...curr,
      screens: curr.screens.map((s) => (s.id === next.id ? next : s)),
    }));
  };

  /** Drag-and-drop reorder. Splice from `fromIdx`, insert at `toIdx`. */
  const reorderScreens = (fromIdx: number, toIdx: number) => {
    setLayout((curr) => {
      if (fromIdx === toIdx) return curr;
      if (fromIdx < 0 || fromIdx >= curr.screens.length) return curr;
      if (toIdx < 0 || toIdx >= curr.screens.length) return curr;
      const arr = [...curr.screens];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      const navItems = arr.filter((s) => s.show_in_nav !== false).map((s) => s.id);
      return { ...curr, screens: arr, mini_app_nav: { ...curr.mini_app_nav, items: navItems } };
    });
  };

  const addScreen = (kind: ScreenKind, targetGroupId?: string | null) => {
    if (!canEdit) return;
    const id = `screen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const titleByKind: Record<ScreenKind, string> = {
      form: 'New form',
      table: 'Table',
      doc: 'Document',
      dashboard: 'Dashboard',
    };
    const iconByKind: Record<ScreenKind, string> = {
      form: 'ClipboardEdit',
      table: 'Table',
      doc: 'FileText',
      dashboard: 'LayoutDashboard',
    };
    const base: ScreenSpec = {
      id,
      kind,
      title: titleByKind[kind],
      icon: iconByKind[kind],
      table_id: tables[0]?.id ?? null,
      primary_key_columns: [],
      visible_for_roles: [],
      show_in_nav: true,
      rls: [],
    };
    if (kind === 'form') base.form = { fields: [], submit_label: 'Save', initial_values: {} };
    if (kind === 'table') {
      base.table = {
        columns: [],
        editable_columns: [],
        filters: [],
        page_size: 50,
        row_actions: [],
        allow_add_row: false,
        allow_delete_row: false,
        required_columns: [],
        default_values: {},
        detail_panel: { enabled: true },
      };
    }
    if (kind === 'doc') base.doc = { blocks: [], page: { size: 'A4', orientation: 'portrait', margin_mm: 15 } };
    if (kind === 'dashboard') {
      // New dashboard screens start empty — the editor lets the user pick
      // managed (dashboard_id) or manual (share_token) mode. No dataset
      // table binding either way.
      base.dashboard = {};
      base.table_id = null;
    }
    setLayout((curr) => {
      // When a workspace is active in the builder, the new screen is born
      // INTO that workspace (append its id to the group's screen_ids) in the
      // same pass — so "+ Form" on a workspace tab lands where the user looks.
      const screen_groups = targetGroupId
        ? (curr.screen_groups || []).map((g) =>
            g.id === targetGroupId && !(g.screen_ids || []).includes(id)
              ? { ...g, screen_ids: [...(g.screen_ids || []), id] }
              : g,
          )
        : curr.screen_groups;
      return {
        ...curr,
        screens: [...curr.screens, base],
        mini_app_nav: { ...curr.mini_app_nav, items: [...(curr.mini_app_nav.items || []), id] },
        screen_groups,
      };
    });
    // Jump straight into the new screen's editor — the user just signaled
    // "I want a new X", and the next thing they want is to configure it.
    setActiveScreenId(id);
    setMode('editor');
    writeBuilderUrl(id);
  };

  const deleteScreen = (id: string) => {
    if (!canEdit) return;
    if (!confirm('Delete this screen?')) return;
    setLayout((curr) => {
      const next = curr.screens.filter((s) => s.id !== id);
      // G7 — scrub the deleted screen from every workspace so the runtime
      // never references a screen that no longer exists.
      const scrubbedGroups = (curr.screen_groups || []).map((g) => ({
        ...g,
        screen_ids: (g.screen_ids || []).filter((x) => x !== id),
      }));
      return {
        ...curr,
        screens: next,
        mini_app_nav: { ...curr.mini_app_nav, items: curr.mini_app_nav.items.filter((x) => x !== id) },
        screen_groups: scrubbedGroups,
      };
    });
    if (activeScreenId === id) setActiveScreenId(null);
  };

  // ── Workspaces (screen groups) ───────────────────────────────────────
  // A workspace is a named, ordered subset of screens surfaced to the
  // end-user as a nav section. Membership is additive: a screen not in
  // any group falls into the runtime's "Khác" bucket, so leaving groups
  // empty preserves the legacy flat navigation.
  const createGroup = (label: string) => {
    const clean = label.trim();
    if (!clean) return;
    // Random suffix so two creates in the same millisecond (or any future
    // programmatic/bulk path) can't mint colliding ids that would break
    // assignment to the second group.
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setLayout((curr) => ({
      ...curr,
      screen_groups: [
        ...(curr.screen_groups || []),
        { id, label: clean, icon: null, screen_ids: [], visible_for_roles: [] },
      ],
    }));
  };

  const renameGroup = (id: string, label: string) => {
    const clean = label.trim();
    if (!clean) return;
    setLayout((curr) => ({
      ...curr,
      screen_groups: (curr.screen_groups || []).map((g) =>
        g.id === id ? { ...g, label: clean } : g,
      ),
    }));
  };

  const setGroupIcon = (id: string, icon: string | null) => {
    setLayout((curr) => ({
      ...curr,
      screen_groups: (curr.screen_groups || []).map((g) =>
        g.id === id ? { ...g, icon } : g,
      ),
    }));
  };

  const deleteGroup = (id: string) => {
    setLayout((curr) => ({
      ...curr,
      screen_groups: (curr.screen_groups || []).filter((g) => g.id !== id),
    }));
  };

  /** Move ``screenId`` into ``groupId`` (or unassign when null). A screen
   * belongs to at most one workspace, so we first strip it from every
   * group, then append to the target — append keeps the screen at the end
   * of its new group's nav order. */
  const assignScreenToGroup = (screenId: string, groupId: string | null) => {
    setLayout((curr) => {
      const groups = (curr.screen_groups || []).map((g) => ({
        ...g,
        screen_ids: (g.screen_ids || []).filter((s) => s !== screenId),
      }));
      if (groupId) {
        const target = groups.find((g) => g.id === groupId);
        if (target && !target.screen_ids.includes(screenId)) {
          target.screen_ids = [...target.screen_ids, screenId];
        }
      }
      return { ...curr, screen_groups: groups };
    });
  };

  // ``mode`` reflects whether the user is browsing the screens list
  // (canvas) or configuring a specific one (editor). The two-mode shell
  // replaces the old fixed three-pane workspace — see the redesign notes
  // in ``wordboard_redesign/README.md``.
  const isEditor = mode === 'editor' && activeScreen !== null;
  const boundDataset = useMemo(
    () => datasets.find((d) => d.id === boundDatasetId) ?? null,
    [datasets, boundDatasetId],
  );
  const totalScreens = layout.screens.length;
  const screensWithIssues = layout.screens.filter(
    (s) => screenStatus(s) !== 'ok',
  ).length;

  return (
    <div className="relative flex h-full flex-col bg-surface-0">
      {!canEdit && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
          <Eye className="h-3.5 w-3.5" />
          {t('workboards.builder.viewOnlyBanner')}
        </div>
      )}
      {canEdit && activeScreenLocked && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            <strong>{presence.lock?.holder_name || t('workboards.builder.someoneElse')}</strong>{' '}
            {t('workboards.builder.lockedByOther')}
          </span>
          <button
            type="button"
            onClick={() => activeScreenId && presence.takeover(activeScreenId)}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 font-semibold text-white transition-colors hover:bg-amber-700"
          >
            <Lock className="h-3 w-3" />
            {t('workboards.builder.takeOverEditing')}
          </button>
        </div>
      )}
      {/* ── Builder sub-topbar: breadcrumb + save pill + preview ──
          Editor mode breadcrumb: ``[All screens] / [current screen ▾]``.
          The screen-name button opens ScreenSwitcherModal so users can
          hop between screens without round-tripping through Canvas.
          Canvas mode keeps the summary "N screens · K need attention". */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        {isEditor && activeScreen ? (
          <>
            <button
              type="button"
              onClick={backToCanvas}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-caption text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
              title={t('workboards.builder.backToAllScreens')}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              {t('workboards.builder.allScreens')}
            </button>
            <span className="text-text-quaternary">/</span>
            {activeScreen && (
              <button
                type="button"
                onClick={() => setSwitcherOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={switcherOpen}
                className="group inline-flex max-w-[320px] items-center gap-1 rounded-md px-1.5 py-1 text-caption font-emphasis text-text-primary transition-colors hover:bg-surface-2"
                title={t('workboards.builder.switchScreenTitle')}
              >
                <span className="truncate">{activeScreen.title}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform group-hover:text-text-primary" />
              </button>
            )}
          </>
        ) : (
          <span className="text-caption font-emphasis text-text-secondary">
            {t('workboards.canvas.screenCount', { count: totalScreens })}
            {screensWithIssues > 0 && (
              <span className="ml-1 text-warning">
                {t('workboards.builder.needAttentionSuffix', { count: screensWithIssues })}
              </span>
            )}
          </span>
        )}

        <div className="flex-1" />

        {presence.editors.length > 0 && (
          <div className="flex items-center -space-x-1.5 pr-1">
            {presence.editors.slice(0, 4).map((ed) => {
              const onSameScreen =
                !!editingScreenId && ed.editing_screen_id === editingScreenId;
              const where = ed.editing_screen_id
                ? layout.screens.find((s) => s.id === ed.editing_screen_id)?.title
                : null;
              return (
                <span
                  key={ed.user_key}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-surface-1"
                  style={{ backgroundColor: presenceColor(ed.user_key) }}
                  title={`${ed.name}${where ? t('workboards.builder.presenceAt', { screen: where }) : ''}${onSameScreen ? t('workboards.builder.presenceSameScreen') : ''}`}
                >
                  {presenceInitials(ed.name)}
                </span>
              );
            })}
            {presence.editors.length > 4 && (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-text-secondary ring-2 ring-surface-1">
                +{presence.editors.length - 4}
              </span>
            )}
          </div>
        )}

        <SavePill
          status={autosave.status}
          savedAt={autosave.savedAt}
          error={autosave.errorMessage}
        />

        <button
          type="button"
          onClick={togglePreview}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-colors ${
            !previewCollapsed
              ? 'bg-brand/10 text-brand'
              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
          }`}
          title={previewCollapsed ? t('workboards.builder.openLivePreview') : t('workboards.builder.hideLivePreview')}
        >
          {previewCollapsed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {previewCollapsed ? t('workboards.builder.livePreview') : t('workboards.builder.hidePreview')}
        </button>
      </div>

      {/* ── Body: side-by-side editor + live preview, resizable.
          Both Canvas and Editor modes share the same split layout so
          the user can keep Live Preview open while browsing screens;
          the preview just shows the last active screen until they pick
          a new one. ``autoSaveId`` persists the editor/preview ratio
          to localStorage; the preview ``Panel`` is ``collapsible`` so
          ``togglePreview()`` can hide it entirely (size 0) and the
          editor expands to fill the row. ── */}
      <PanelGroup
        direction="horizontal"
        autoSaveId={SPLIT_STORAGE_KEY}
        className="flex flex-1 min-h-0"
      >
        <Panel id="editor" order={1} minSize={30} defaultSize={55}>
          <main className="wb-editor-pane relative h-full min-w-0 overflow-y-auto bg-surface-0">
            {isEditor && activeScreen ? (
              <div
                className={`w-full px-4 py-5 sm:px-6 lg:px-8 ${
                  activeScreenLocked ? 'pointer-events-none select-none opacity-60' : ''
                }`}
                aria-disabled={activeScreenLocked}
              >
                <ScreenEditor
                  screen={activeScreen}
                  allScreens={layout.screens}
                  tables={tables}
                  tablesLoading={tablesLoading}
                  workboardId={workboard.id}
                  onChange={updateScreen}
                  focusFieldColumn={focusFieldColumn}
                  onFocusFieldHandled={() => setFocusFieldColumn(null)}
                  onDeleteScreen={
                    canEdit && !activeScreenLocked
                      ? () => {
                          deleteScreen(activeScreen.id);
                          backToCanvas();
                        }
                      : undefined
                  }
                />
              </div>
            ) : (
              <CanvasOverview
                screens={layout.screens}
                tables={tables}
                boundDataset={boundDataset}
                groups={layout.screen_groups || []}
                onPickScreen={openScreen}
                onAddScreen={addScreen}
                onReorderScreens={reorderScreens}
                onDeleteScreen={deleteScreen}
                onCreateGroup={createGroup}
                onRenameGroup={renameGroup}
                onDeleteGroup={deleteGroup}
                onAssignScreen={assignScreenToGroup}
                onSetGroupIcon={setGroupIcon}
                canEdit={canEdit}
              />
            )}
          </main>
        </Panel>
        <PanelResizeHandle
          className="group relative w-px shrink-0 bg-[rgb(var(--border-line))] data-[panel-group-direction=horizontal]:cursor-col-resize data-[resize-handle-state=hover]:bg-brand/60 data-[resize-handle-state=drag]:bg-brand"
          hidden={previewCollapsed}
        >
          {/* Wider invisible hit-area so the 1px line is still easy to grab. */}
          <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </PanelResizeHandle>
        <Panel
          id="preview"
          order={2}
          ref={previewPanelRef}
          minSize={25}
          defaultSize={45}
          collapsible
          collapsedSize={0}
          onCollapse={() => {
            setPreviewCollapsed(true);
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(PREVIEW_COLLAPSED_KEY, '1');
            }
          }}
          onExpand={() => {
            setPreviewCollapsed(false);
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(PREVIEW_COLLAPSED_KEY, '0');
            }
          }}
        >
          <BuilderLivePreview
            workboard={workboard}
            draftLayout={layout}
            reloadOnSave
            saveStatus={autosave.status}
            savedAt={autosave.savedAt}
            saveError={autosave.errorMessage}
            activeScreenId={activeScreenId}
            collapsed={previewCollapsed}
            onToggle={togglePreview}
          />
        </Panel>
      </PanelGroup>

      {switcherOpen && (
        <ScreenSwitcherModal
          screens={layout.screens}
          currentScreenId={activeScreenId}
          onPick={(id) => {
            setActiveScreenId(id);
            setMode('editor');
            setFocusFieldColumn(null);
            writeBuilderUrl(id);
          }}
          onAllScreens={backToCanvas}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

    </div>
  );
}



function SavePill({
  status,
  savedAt,
  error,
}: {
  status: ReturnType<typeof useDebouncedAutosave>['status'];
  savedAt: Date | null;
  error: string | null;
}) {
  const { t, locale } = useI18n();
  if (status === 'saving') {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-info/10 px-2.5 text-tiny font-emphasis text-info">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('workboards.builder.autosave.saving')}
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-warning/10 px-2.5 text-tiny font-emphasis text-warning">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
        {t('workboards.builder.autosave.editing')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        className="inline-flex h-6 max-w-[260px] items-center gap-1.5 rounded-full bg-danger/10 px-2.5 text-tiny font-emphasis text-danger"
        title={error || t('workboards.builder.autosave.saveFailedRetry')}
      >
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span className="truncate">{t('workboards.builder.autosave.saveFailed')}</span>
      </span>
    );
  }
  if (status === 'saved' && savedAt) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-success/10 px-2.5 text-tiny font-emphasis text-success">
        <CheckCircle2 className="h-3 w-3" />
        {t('workboards.builder.autosave.syncedAt', { time: savedAt.toLocaleTimeString(locale) })}
      </span>
    );
  }
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-tiny font-emphasis text-text-tertiary">
      <Save className="h-3 w-3" />
      {t('workboards.builder.autosave.autoSaves')}
    </span>
  );
}
