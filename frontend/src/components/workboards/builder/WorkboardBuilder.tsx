/**
 * WorkboardBuilder — visual editor for the mini-app layout.
 *
 * Layout: left rail (screens list) · center (tabbed ScreenEditor) · right
 * (Live Preview iframe). RLS used to live in a separate right panel; it now
 * sits inside the "Quyền" tab of the ScreenEditor so the builder has only
 * two visible panes (editor + preview).
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardEdit,
  Eye,
  FileText,
  HelpCircle,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MoreVertical,
  Plus,
  Save,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';

import type { Workboard } from '@/lib/api/workboards';
import { apiClient } from '@/lib/api-client';
import { useDatasets } from '@/hooks/use-datasets';
import { useUpdateWorkboard } from '@/hooks/use-workboards';
import { toast } from '@/lib/toast';
import {
  ensureLayout,
  MiniAppLayoutSpec,
  ScreenKind,
  ScreenSpec,
} from './types';
import ScreenEditor from './ScreenEditor';
import AppSettingsEditor from './AppSettingsEditor';
import BuilderLivePreview from './BuilderLivePreview';
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

interface ApiErrorShape {
  response?: {
    data?: {
      detail?: string;
    };
  };
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

function getApiErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiErrorShape)?.response?.data?.detail || fallback;
}

interface Props {
  workboard: Workboard;
}

type ScreenStatus = 'ok' | 'warn' | 'missing';

function screenStatus(s: ScreenSpec): ScreenStatus {
  if (s.kind === 'form' || s.kind === 'list') {
    if (!s.table_id) return 'missing';
  }
  if (s.kind === 'form') {
    const fields = (s.form?.fields || []) as Array<unknown>;
    if (fields.length === 0) return 'warn';
  }
  if (s.kind === 'list') {
    const cols = s.list?.columns || [];
    if (cols.length === 0) return 'warn';
  }
  if (s.kind === 'doc') {
    const blocks = s.doc?.blocks || [];
    if (blocks.length === 0) return 'warn';
  }
  return 'ok';
}

const KIND_ICON: Record<ScreenKind, React.ElementType> = {
  form: ClipboardEdit,
  list: ListChecks,
  doc: FileText,
  dashboard: LayoutDashboard,
};
const KIND_LABEL: Record<ScreenKind, string> = {
  form: 'Form',
  list: 'List',
  doc: 'Báo cáo',
  dashboard: 'Dashboard',
};


export default function WorkboardBuilder({ workboard }: Props) {
  const { data: datasets = [] } = useDatasets();
  const updateWorkboard = useUpdateWorkboard();
  const [boundDatasetId, setBoundDatasetId] = useState(workboard.dataset_id);
  const [layout, setLayout] = useState<MiniAppLayoutSpec>(() =>
    ensureLayout(workboard.layout_json),
  );
  const [activeScreenId, setActiveScreenId] = useState<string | null>(
    () => ensureLayout(workboard.layout_json).screens[0]?.id || null,
  );
  const [tables, setTables] = useState<DatasetTableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [focusFieldColumn, setFocusFieldColumn] = useState<string | null>(null);

  useEffect(() => {
    setBoundDatasetId(workboard.dataset_id);
  }, [workboard.id, workboard.dataset_id]);

  const togglePreview = () => setPreviewCollapsed((prev) => !prev);

  // Auto-save with a 1.2s debounce. The mini-preview iframe re-keys on
  // each successful save so the user sees their edits the moment the
  // save lands (no Save button click needed).
  const autosave = useDebouncedAutosave(workboard.id, layout, true);

  const handleDatasetChange = async (nextDatasetId: number) => {
    if (!nextDatasetId || nextDatasetId === boundDatasetId) return;
    try {
      await autosave.flush();
      const updated = await updateWorkboard.mutateAsync({
        id: workboard.id,
        data: { dataset_id: nextDatasetId },
      });
      const nextLayout = ensureLayout(updated.layout_json);
      setBoundDatasetId(updated.dataset_id);
      setLayout(nextLayout);
      setActiveScreenId((current) =>
        current && nextLayout.screens.some((screen) => screen.id === current)
          ? current
          : nextLayout.screens[0]?.id || null,
      );
      toast.success('Đã đổi dataset cho Mini App');
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Không đổi được dataset.'));
    }
  };

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
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== 'wb-builder/field-click') return;
      const screenId = String((data as { screenId?: unknown }).screenId || '');
      const column = String((data as { column?: unknown }).column || '');
      if (!column) return;
      if (screenId && screenId !== activeScreenId) {
        setActiveScreenId(screenId);
      }
      setFocusFieldColumn(column);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeScreenId]);

  const updateScreen = (next: ScreenSpec) => {
    setLayout((curr) => ({
      ...curr,
      screens: curr.screens.map((s) => (s.id === next.id ? next : s)),
    }));
  };

  const moveScreen = (idx: number, dir: -1 | 1) => {
    setLayout((curr) => {
      const arr = [...curr.screens];
      const target = idx + dir;
      if (target < 0 || target >= arr.length) return curr;
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      const navItems = arr.filter((s) => s.show_in_nav !== false).map((s) => s.id);
      return { ...curr, screens: arr, mini_app_nav: { ...curr.mini_app_nav, items: navItems } };
    });
  };

  const addScreen = (kind: ScreenKind) => {
    const id = `screen-${Date.now().toString(36)}`;
    const titleByKind: Record<ScreenKind, string> = {
      form: 'Form mới',
      list: 'Danh sách',
      doc: 'Báo cáo',
      dashboard: 'Dashboard',
    };
    const iconByKind: Record<ScreenKind, string> = {
      form: 'ClipboardEdit',
      list: 'ListChecks',
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
    if (kind === 'form') base.form = { fields: [], submit_label: 'Lưu', initial_values: {} };
    if (kind === 'list') base.list = { columns: [], page_size: 50, row_actions: [] };
    if (kind === 'doc') base.doc = { blocks: [], page: { size: 'A4', orientation: 'portrait', margin_mm: 15 } };
    setLayout((curr) => ({
      ...curr,
      screens: [...curr.screens, base],
      mini_app_nav: { ...curr.mini_app_nav, items: [...(curr.mini_app_nav.items || []), id] },
    }));
    setActiveScreenId(id);
  };

  const deleteScreen = (id: string) => {
    if (!confirm('Xoá screen này?')) return;
    setLayout((curr) => {
      const next = curr.screens.filter((s) => s.id !== id);
      return {
        ...curr,
        screens: next,
        mini_app_nav: { ...curr.mini_app_nav, items: curr.mini_app_nav.items.filter((x) => x !== id) },
      };
    });
    if (activeScreenId === id) setActiveScreenId(null);
  };

  const totalScreens = layout.screens.length;
  const hasScreens = totalScreens > 0;
  const screensWithIssues = layout.screens.filter((s) => screenStatus(s) !== 'ok').length;

  return (
    <div className="flex h-full">
      {/* ── Left rail — screens list ─────────────────────────────── */}
      <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-[rgb(var(--border-line))] bg-surface-1">
        <div className="border-b border-[rgb(var(--border-line))] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                Mini-app
              </h3>
              <p className="mt-0.5 text-caption text-text-secondary">
                {totalScreens} màn hình
                {screensWithIssues > 0 && (
                  <span className="ml-1 text-warning">• {screensWithIssues} cần sửa</span>
                )}
              </p>
            </div>
            <button
              onClick={() => setShowAppSettings(true)}
              className="rounded-md p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
              title="Thiết lập app (branding, navigation)"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
          {hasScreens ? (
            <div className="space-y-0.5">
              {layout.screens.map((s, i) => (
                <ScreenListItem
                  key={s.id}
                  screen={s}
                  active={s.id === activeScreenId}
                  onClick={() => setActiveScreenId(s.id)}
                  onChange={updateScreen}
                  onMoveUp={i > 0 ? () => moveScreen(i, -1) : undefined}
                  onMoveDown={i < layout.screens.length - 1 ? () => moveScreen(i, 1) : undefined}
                  onDelete={() => deleteScreen(s.id)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-6 text-center text-tiny text-text-tertiary">
              Chưa có màn hình nào.
              <br />
              Thêm màn hình đầu tiên ở dưới.
            </p>
          )}

          <div className="mt-3 border-t border-[rgb(var(--border-line))] pt-3">
            <p className="mb-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              + Thêm màn hình
            </p>
            <div className="grid grid-cols-2 gap-1">
              <AddBtn icon={ClipboardEdit} label="Form" onClick={() => addScreen('form')} />
              <AddBtn icon={ListChecks} label="List" onClick={() => addScreen('list')} />
              <AddBtn icon={FileText} label="Báo cáo" onClick={() => addScreen('doc')} />
              <AddBtn
                icon={LayoutDashboard}
                label="Dashboard"
                onClick={() => addScreen('dashboard')}
                disabled
                title="Sắp ra mắt"
              />
            </div>
          </div>
        </div>

        {/* Auto-save status footer */}
        <div className="border-t border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
          <AutosaveFooter
            status={autosave.status}
            savedAt={autosave.savedAt}
            error={autosave.errorMessage}
          />
        </div>
      </aside>

      {/* ── Workspace = editor + preview, splits 50/50 when preview is open.
          Sidebar (w-56) sits outside this so the split ignores its width. */}
      <div className="flex min-w-0 flex-1">
      <main
        className={`wb-editor-pane relative min-w-0 overflow-y-auto bg-surface-0 ${
          previewCollapsed ? 'flex-1' : 'w-1/2 shrink-0'
        }`}
      >
        {previewCollapsed && (
          <button
            type="button"
            onClick={togglePreview}
            title="Mở Live Preview"
            className="absolute right-3 top-3 z-10 flex h-7 items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 text-tiny text-text-secondary shadow-sm hover:bg-surface-2 hover:text-text-primary"
          >
            <Eye className="h-3.5 w-3.5" />
            Live Preview
          </button>
        )}
        {!hasScreens ? (
          <WelcomeEmptyState
            onAdd={addScreen}
            onOpenSettings={() => setShowAppSettings(true)}
          />
        ) : !activeScreen ? (
          <PickAScreenHint screens={layout.screens} onPick={setActiveScreenId} />
        ) : (
          <div className="px-6 py-5 lg:px-10 lg:py-7">
            <ScreenEditor
              screen={activeScreen}
              allScreens={layout.screens}
              tables={tables}
              tablesLoading={tablesLoading}
              onChange={updateScreen}
              focusFieldColumn={focusFieldColumn}
              onFocusFieldHandled={() => setFocusFieldColumn(null)}
            />
          </div>
        )}
      </main>

      {/* ── Live Preview iframe ──────────────────────────────────── */}
      <BuilderLivePreview
        workboard={workboard}
        saveStatus={autosave.status}
        savedAt={autosave.savedAt}
        saveError={autosave.errorMessage}
        activeScreenId={activeScreenId}
        collapsed={previewCollapsed}
        onToggle={togglePreview}
      />
      </div>

      {showAppSettings && (
        <AppSettingsEditor
          layout={layout}
          currentDatasetId={boundDatasetId}
          datasets={datasets}
          datasetChangePending={updateWorkboard.isPending}
          onChange={setLayout}
          onDatasetChange={handleDatasetChange}
          onClose={() => setShowAppSettings(false)}
        />
      )}
    </div>
  );
}


function AutosaveFooter({
  status,
  savedAt,
  error,
}: {
  status: ReturnType<typeof useDebouncedAutosave>['status'];
  savedAt: Date | null;
  error: string | null;
}) {
  if (status === 'saving') {
    return (
      <div className="flex items-center gap-1.5 text-tiny text-info">
        <Loader2 className="h-3 w-3 animate-spin" />
        Đang lưu…
      </div>
    );
  }
  if (status === 'pending') {
    return (
      <div className="flex items-center gap-1.5 text-tiny text-warning">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
        Đang gõ — lưu sau ~1s
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-start gap-1 text-tiny text-danger" title={error || ''}>
        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
        Lỗi lưu — chỉnh tiếp để thử lại
      </div>
    );
  }
  if (status === 'saved' && savedAt) {
    return (
      <div className="flex items-center gap-1.5 text-tiny text-success">
        <CheckCircle2 className="h-3 w-3" />
        Đã đồng bộ {savedAt.toLocaleTimeString()}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-tiny text-text-tertiary">
      <Save className="h-3 w-3" />
      Tự động lưu khi bạn thay đổi
    </div>
  );
}


// ── Welcome / empty state ─────────────────────────────────────────────────

function WelcomeEmptyState({
  onAdd,
  onOpenSettings,
}: {
  onAdd: (kind: ScreenKind) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 lg:py-14">
      <div className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 p-7">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Sparkles className="h-4 w-4" />
          </div>
          <h2 className="text-h4 font-emphasis text-text-primary">
            Bắt đầu xây mini-app
          </h2>
        </div>
        <p className="mb-5 text-caption text-text-secondary">
          Mini-app gồm các <strong>màn hình</strong> (form nhập, danh sách, báo cáo) liên kết với nhau.
          Bắt đầu bằng một trong các màn hình dưới đây — sau đó bấm &quot;Lưu thay đổi&quot;
          rồi vào tab <strong>Preview</strong> để dùng thử.
        </p>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <StarterCard
            icon={ClipboardEdit}
            title="Form nhập liệu"
            description="Một bảng với form thêm/sửa, rất hợp cho quy trình ghi nhận dữ liệu hàng ngày."
            onClick={() => onAdd('form')}
          />
          <StarterCard
            icon={ListChecks}
            title="Danh sách"
            description="Hiện rows đã nhập, có filter + hành động (mở chi tiết, xoá...)."
            onClick={() => onAdd('list')}
          />
          <StarterCard
            icon={FileText}
            title="Báo cáo (Doc)"
            description="Trang tổng quan có header, KPI, bảng có merge cells + footer tổng hợp."
            onClick={() => onAdd('doc')}
          />
        </div>

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-info/20 bg-info/5 p-3">
          <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
          <div className="text-caption text-text-secondary">
            <strong>Mẹo:</strong> Đặt branding (logo, màu, tên app) trước qua{' '}
            <button
              type="button"
              onClick={onOpenSettings}
              className="underline hover:text-info"
            >
              App settings
            </button>
            . Mini-app sẽ hiện brand đó trên màn hình login + header runtime.
          </div>
        </div>
      </div>
    </div>
  );
}

function StarterCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-0 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-brand hover:shadow-sm"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <h4 className="text-caption font-emphasis text-text-primary">{title}</h4>
        <p className="mt-1 text-tiny text-text-tertiary">{description}</p>
      </div>
      <span className="mt-auto flex items-center gap-1 text-tiny font-emphasis text-brand opacity-0 transition-opacity group-hover:opacity-100">
        <Plus className="h-3 w-3" /> Thêm màn hình này
      </span>
    </button>
  );
}

function PickAScreenHint({
  screens,
  onPick,
}: {
  screens: ScreenSpec[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5">
        <h3 className="mb-1 text-body font-emphasis text-text-primary">
          Chọn màn hình để chỉnh sửa
        </h3>
        <p className="mb-3 text-caption text-text-secondary">
          Mini-app này có {screens.length} màn hình. Click thẻ dưới để mở editor.
        </p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {screens.map((s) => {
            const Icon = KIND_ICON[s.kind];
            const status = screenStatus(s);
            return (
              <button
                key={s.id}
                onClick={() => onPick(s.id)}
                className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-3 text-left hover:border-brand"
              >
                <Icon className="h-4 w-4 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-caption font-emphasis text-text-primary">
                    {s.title}
                  </div>
                  <div className="text-tiny text-text-quaternary">
                    {KIND_LABEL[s.kind]}
                  </div>
                </div>
                <StatusDot status={status} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// ── Screen list item with status + gear popover for screen meta ───────────

function ScreenListItem({
  screen,
  active,
  onClick,
  onChange,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  screen: ScreenSpec;
  active: boolean;
  onClick: () => void;
  onChange: (next: ScreenSpec) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete: () => void;
}) {
  const Icon = KIND_ICON[screen.kind];
  const status = screenStatus(screen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  // Close menu/popover on outside click.
  useEffect(() => {
    if (!menuOpen && !settingsOpen) return;
    function onDocClick(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, settingsOpen]);

  const showMenuButton = active || menuOpen || settingsOpen;

  return (
    <div
      ref={wrapperRef}
      className={`group relative flex items-center gap-1 rounded-md px-2 py-1.5 ${
        active ? 'bg-brand/10' : 'hover:bg-surface-2'
      }`}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-caption font-emphasis text-text-primary">
              {screen.title}
            </span>
            <StatusDot status={status} />
          </div>
          <div className="truncate text-tiny text-text-quaternary">
            {KIND_LABEL[screen.kind]}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((prev) => !prev);
        }}
        className={`shrink-0 rounded p-0.5 transition-opacity ${
          showMenuButton ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        } ${
          menuOpen ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary'
        }`}
        title="Thao tác"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {menuOpen && (
        <div
          className="absolute right-1 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 py-1 shadow-lg"
          role="menu"
        >
          <MenuItem
            icon={<Settings className="h-3.5 w-3.5" />}
            label="Thiết lập màn hình"
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen(true);
            }}
          />
          {onMoveUp && (
            <MenuItem
              icon={<ArrowUp className="h-3.5 w-3.5" />}
              label="Di chuyển lên"
              onClick={() => {
                setMenuOpen(false);
                onMoveUp();
              }}
            />
          )}
          {onMoveDown && (
            <MenuItem
              icon={<ArrowDown className="h-3.5 w-3.5" />}
              label="Di chuyển xuống"
              onClick={() => {
                setMenuOpen(false);
                onMoveDown();
              }}
            />
          )}
          <div className="my-1 border-t border-[rgb(var(--border-line))]" />
          <MenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Xoá màn hình"
            danger
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          />
        </div>
      )}

      {settingsOpen && (
        <ScreenSettingsPopover
          screen={screen}
          onChange={onChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption ${
        danger
          ? 'text-danger hover:bg-danger/10'
          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
      }`}
      role="menuitem"
    >
      {icon}
      {label}
    </button>
  );
}

function ScreenSettingsPopover({
  screen,
  onChange,
  onClose,
}: {
  screen: ScreenSpec;
  onChange: (next: ScreenSpec) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute left-1 right-1 top-full z-30 mt-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 shadow-lg"
      role="dialog"
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          Thiết lập màn hình
        </h4>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
          title="Đóng"
        >
          ×
        </button>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-tiny font-emphasis text-text-secondary">
            Tên màn hình
          </span>
          <input
            value={screen.title}
            onChange={(event) => onChange({ ...screen, title: event.target.value })}
            className="min-h-8 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary focus:border-brand focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-tiny font-emphasis text-text-secondary">
            Mô tả ngắn
          </span>
          <textarea
            value={screen.description || ''}
            onChange={(event) => onChange({ ...screen, description: event.target.value })}
            rows={2}
            className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-caption text-text-primary focus:border-brand focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-tiny text-text-secondary">
          <input
            type="checkbox"
            checked={screen.show_in_nav !== false}
            onChange={(event) =>
              onChange({ ...screen, show_in_nav: event.target.checked })
            }
            className="h-3.5 w-3.5"
          />
          Hiển thị trong menu
        </label>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ScreenStatus }) {
  const cls =
    status === 'ok' ? 'bg-success' : status === 'warn' ? 'bg-warning' : 'bg-danger';
  const label =
    status === 'ok'
      ? 'Đã cấu hình đầy đủ'
      : status === 'warn'
      ? 'Còn thiếu fields/columns/blocks'
      : 'Chưa chọn bảng dữ liệu';
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`}
      title={label}
    />
  );
}


function AddBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className="flex flex-col items-center gap-1 rounded-md border border-[rgb(var(--border-line))] py-2 text-caption text-text-secondary hover:border-brand hover:text-brand disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
