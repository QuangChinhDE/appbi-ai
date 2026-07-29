/**
 * CanvasOverview — Mức 1 của builder (workspace-first).
 *
 * Bố cục "một phòng một lúc": một dải TAB Workspace ở trên; chọn tab nào thì
 * danh sách bên dưới CHỈ hiện screen của workspace đó (đổi tab → bộ screen
 * khác, không lẫn lộn). Tab [Tất cả] xem/sắp xếp toàn cục, tab [Khác] cho
 * screen chưa phân nhóm. Header của workspace đang mở chứa: đổi tên, biểu
 * tượng, xoá, và palette "+ Form / + Table / …" (thêm screen VÀO chính
 * workspace đang mở).
 *
 * Thứ tự nav là thứ tự phẳng của ``screens`` (mini_app_nav.items) nên mọi
 * reorder ở view đã lọc đều quy về CHỈ SỐ TUYỆT ĐỐI trong ``screens`` trước
 * khi gọi ``onReorderScreens`` — không làm lệch thứ tự nav.
 *
 * Style bám design tokens hệ thống; type-scale theo 1 token / 1 vai trò.
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardEdit,
  Database,
  FileText,
  FolderInput,
  FolderPlus,
  GripVertical,
  Layers,
  LayoutDashboard,
  Pencil,
  Plus,
  Table as TableIcon,
  Trash2,
  X,
} from 'lucide-react';

import type { Dataset } from '@/hooks/use-datasets';
import type { ScreenGroupSpec, ScreenKind, ScreenSpec } from './types';
import { resolveScreenIcon } from './ScreenIconRegistry';
import IconPicker from './IconPicker';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

const KIND_ICON: Record<ScreenKind, React.ElementType> = {
  form: ClipboardEdit,
  table: TableIcon,
  doc: FileText,
  dashboard: LayoutDashboard,
};

type Translate = (key: string, values?: Record<string, string | number>) => string;

function screenKindLabel(kind: ScreenKind, t: Translate): string {
  return t(`workboards.builder.kind.${kind}`);
}

type ScreenStatus =
  | { kind: 'ok'; label: string }
  | { kind: 'warn'; label: string }
  | { kind: 'err'; label: string };

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

/** Sentinel tab keys (everything else is a real workspace/group id). */
const TAB_ALL = '__all__';
const TAB_UNGROUPED = '__ungrouped__';

interface Props {
  screens: ScreenSpec[];
  tables: DatasetTableInfo[];
  boundDataset: Dataset | null;
  /** Named workspaces (screen groups). Empty = flat nav. */
  groups: ScreenGroupSpec[];
  onPickScreen: (id: string) => void;
  /** Add a screen; when a real workspace tab is active, groupId targets it. */
  onAddScreen: (kind: ScreenKind, groupId?: string | null) => void;
  /** Reorder by ABSOLUTE indices into the flat ``screens`` array. */
  onReorderScreens: (fromIdx: number, toIdx: number) => void;
  onDeleteScreen: (id: string) => void;
  onCreateGroup: (label: string) => void;
  onRenameGroup: (id: string, label: string) => void;
  onDeleteGroup: (id: string) => void;
  /** Move a screen into a workspace (or unassign when groupId is null). */
  onAssignScreen: (screenId: string, groupId: string | null) => void;
  onSetGroupIcon: (id: string, icon: string | null) => void;
  /** When false (view-only viewer), hide mutation affordances. Edits are
   * already inert (parent handlers no-op), this just removes the dead buttons. */
  canEdit?: boolean;
}

/**
 * Compute a one-liner subtitle for a screen card from its spec — e.g.
 * "5 fields · 1 initial value" or "Pick a dashboard or paste a share token".
 */
function screenSubtitle(s: ScreenSpec, t: Translate): string {
  if (s.kind === 'form') {
    const fields = s.form?.fields?.length ?? 0;
    const initial = Object.keys(s.form?.initial_values || {}).length;
    if (fields === 0) return t('workboards.canvas.noFieldsYet');
    const initialPart =
      initial > 0 ? t('workboards.canvas.initialValuesSuffix', { count: initial }) : '';
    return `${t('workboards.canvas.fieldCount', { count: fields })}${initialPart}`;
  }
  if (s.kind === 'table') {
    const cols = s.table?.columns?.length ?? 0;
    const editable = (s.table?.editable_columns || []).length;
    const computed = s.table?.computed_columns?.length ?? 0;
    const actions = s.table?.row_actions?.length ?? 0;
    if (cols === 0) return t('workboards.canvas.noColumnsYet');
    const editPart =
      editable > 0 ? t('workboards.canvas.editableSuffix', { count: editable }) : t('workboards.canvas.readonlySuffix');
    const formulaPart =
      computed > 0 ? t('workboards.canvas.formulaSuffix', { count: computed }) : '';
    const actionPart =
      actions > 0 ? t('workboards.canvas.rowActionSuffix', { count: actions }) : '';
    return `${t('workboards.canvas.columnCount', { count: cols })}${editPart}${formulaPart}${actionPart}`;
  }
  if (s.kind === 'doc') {
    const blocks = s.doc?.blocks?.length ?? 0;
    const page = s.doc?.page;
    const sizeLabel = page ? `${page.size ?? 'A4'} ${page.orientation ?? 'portrait'}` : 'A4 portrait';
    if (blocks === 0) return t('workboards.canvas.noBlocksYet', { size: sizeLabel });
    return t('workboards.canvas.blockCount', { size: sizeLabel, count: blocks });
  }
  if (s.kind === 'dashboard') {
    const d = s.dashboard;
    if (typeof d?.dashboard_id === 'number' && d.dashboard_id > 0) {
      const slots = (d.role_filter_mapping?.length || 0) + (d.static_filters?.length || 0);
      return slots > 0
        ? t('workboards.canvas.managedDashboardWithSlots', { id: d.dashboard_id, count: slots })
        : t('workboards.canvas.managedDashboard', { id: d.dashboard_id });
    }
    if ((d?.share_token || '').trim()) return t('workboards.canvas.manualShareTokenMode');
    return t('workboards.canvas.pickDashboardOrToken');
  }
  return '';
}

function screenStatus(s: ScreenSpec, t: Translate): ScreenStatus {
  if (s.kind === 'form' || s.kind === 'table' || s.kind === 'doc') {
    if (!s.table_id) return { kind: 'err', label: t('workboards.canvas.status.noDataSource') };
  }
  if (s.kind === 'form' && (s.form?.fields?.length ?? 0) === 0) {
    return { kind: 'warn', label: t('workboards.canvas.status.needsFields') };
  }
  if (s.kind === 'table' && (s.table?.columns?.length ?? 0) === 0) {
    return { kind: 'warn', label: t('workboards.canvas.status.needsColumns') };
  }
  if (s.kind === 'doc' && (s.doc?.blocks?.length ?? 0) === 0) {
    return { kind: 'warn', label: t('workboards.canvas.status.needsBlocks') };
  }
  if (s.kind === 'dashboard') {
    const hasManaged = typeof s.dashboard?.dashboard_id === 'number' && (s.dashboard.dashboard_id ?? 0) > 0;
    const hasManual = !!(s.dashboard?.share_token || '').trim();
    if (!hasManaged && !hasManual) return { kind: 'err', label: t('workboards.canvas.status.noSource') };
  }
  return { kind: 'ok', label: t('workboards.canvas.status.configured') };
}

const STATUS_COLOR: Record<ScreenStatus['kind'], string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  err: 'bg-danger/10 text-danger',
};

const STATUS_DOT: Record<ScreenStatus['kind'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-danger',
};

const PALETTE: Array<{ kind: ScreenKind; icon: React.ElementType; label: string }> = [
  { kind: 'form', icon: ClipboardEdit, label: 'Form' },
  { kind: 'table', icon: TableIcon, label: 'Table' },
  { kind: 'doc', icon: FileText, label: 'Document' },
  { kind: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
];

export default function CanvasOverview({
  screens,
  tables,
  boundDataset,
  groups,
  onPickScreen,
  onAddScreen,
  onReorderScreens,
  onDeleteScreen,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onAssignScreen,
  onSetGroupIcon,
  canEdit = true,
}: Props) {
  const { t } = useI18n();
  // ── Which "drawer" (workspace tab) is open. Real group id, or a sentinel.
  const [activeTab, setActiveTab] = useState<string>(TAB_ALL);
  // Workspace create (inline pill at the end of the tab strip).
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  // Rename / icon-edit of the ACTIVE workspace (in its header).
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState('');
  const [iconOpen, setIconOpen] = useState(false);
  // Per-card "move to workspace" popover + drag-reorder visual state (by id,
  // robust under filtering).
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const groupById = useMemo(() => {
    const m = new Map<string, ScreenGroupSpec>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  const groupOfScreen = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const sid of g.screen_ids || []) m.set(sid, g.id);
    return m;
  }, [groups]);

  // screenId -> its absolute index in the flat ``screens`` array (the only
  // index ``onReorderScreens`` understands; nav order derives from it).
  const absById = useMemo(() => {
    const m = new Map<string, number>();
    screens.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [screens]);

  // Guard a stale active tab (e.g. its group was just deleted) → fall back to All.
  const effectiveTab =
    activeTab === TAB_ALL || activeTab === TAB_UNGROUPED || groupById.has(activeTab)
      ? activeTab
      : TAB_ALL;
  const activeGroup = groupById.get(effectiveTab) || null;

  const ungroupedCount = useMemo(
    () => screens.filter((s) => !groupOfScreen.has(s.id)).length,
    [screens, groupOfScreen],
  );

  // The cards shown for the active tab — always in flat ``screens`` order so
  // the displayed order is the real nav order.
  const visibleScreens = useMemo(() => {
    if (effectiveTab === TAB_ALL) return screens;
    if (effectiveTab === TAB_UNGROUPED) return screens.filter((s) => !groupOfScreen.has(s.id));
    return screens.filter((s) => groupOfScreen.get(s.id) === effectiveTab);
  }, [screens, groupOfScreen, effectiveTab]);

  const isDuplicateLabel = (label: string, exceptId?: string) => {
    const norm = label.trim().toLowerCase();
    return groups.some((g) => g.id !== exceptId && g.label.trim().toLowerCase() === norm);
  };

  // After a create, ``groups`` grows by one; auto-select the new workspace so
  // the user lands in the empty new drawer ready to add screens. The parent
  // generates the id, so we stash the (unique) label and resolve it once the
  // ``groups`` prop updates.
  const pendingSelectRef = useRef<string | null>(null);

  const handleCreate = () => {
    const v = draftName.trim();
    if (!v) {
      setCreating(false);
      setDraftName('');
      return;
    }
    if (isDuplicateLabel(v)) {
      setCreateError(t('workboards.canvas.workspaceDuplicate', { name: v }));
      return;
    }
    pendingSelectRef.current = `ws-pending:${v}`;
    onCreateGroup(v);
    setDraftName('');
    setCreateError(null);
    setCreating(false);
  };

  // Resolve the pending-by-label selection once groups updates.
  useEffect(() => {
    const p = pendingSelectRef.current;
    if (p && p.startsWith('ws-pending:')) {
      const label = p.slice('ws-pending:'.length);
      const created = [...groups].reverse().find((g) => g.label === label);
      if (created) {
        setActiveTab(created.id);
        pendingSelectRef.current = null;
      }
    }
  }, [groups]);

  const commitRename = () => {
    const next = editName.trim();
    if (!activeGroup) {
      setRenaming(false);
      return;
    }
    const id = activeGroup.id;
    setRenaming(false);
    setEditName('');
    if (!next || isDuplicateLabel(next, id)) return;
    onRenameGroup(id, next);
  };

  const handleAddScreen = (kind: ScreenKind) => {
    // Add INTO the active workspace; on All/Khác the screen stays ungrouped.
    onAddScreen(kind, activeGroup ? activeGroup.id : null);
  };

  const handleMove = (screenId: string, targetGroupId: string | null, targetLabel: string) => {
    onAssignScreen(screenId, targetGroupId);
    setMoveMenuFor(null);
    toast.success(
      targetGroupId
        ? t('workboards.canvas.movedToWorkspace', { name: targetLabel })
        : t('workboards.canvas.movedToUngrouped'),
    );
  };

  // Reorder helpers — always translate the visible position to the ABSOLUTE
  // index in ``screens`` so nav order can't be scrambled by the filter.
  const moveByOne = (screenId: string, dir: -1 | 1) => {
    const vIdx = visibleScreens.findIndex((s) => s.id === screenId);
    const sibling = visibleScreens[vIdx + dir];
    if (!sibling) return;
    const from = absById.get(screenId);
    const to = absById.get(sibling.id);
    if (from === undefined || to === undefined) return;
    onReorderScreens(from, to);
  };

  // ── Build the tab list. Always show [Tất cả] + (real workspaces) + [Khác
  // when there are groups] + the create pill.
  const tabs: Array<{ key: string; label: string; icon?: string | null; count: number; synthetic: boolean }> = [
    { key: TAB_ALL, label: t('workboards.canvas.all'), count: screens.length, synthetic: true },
    ...groups.map((g) => ({
      key: g.id,
      label: g.label,
      icon: g.icon ?? null,
      count: (g.screen_ids || []).filter((id) => absById.has(id)).length,
      synthetic: false,
    })),
    ...(groups.length > 0
      ? [{ key: TAB_UNGROUPED, label: t('workboards.canvas.ungrouped'), count: ungroupedCount, synthetic: true }]
      : []),
  ];

  const renderTab = (t: (typeof tabs)[number]) => {
    const active = t.key === effectiveTab;
    const TabIcon = !t.synthetic && t.icon ? resolveScreenIcon(t.icon) : null;
    return (
      <button
        key={t.key}
        type="button"
        onClick={() => setActiveTab(t.key)}
        title={t.label}
        className={`inline-flex h-8 max-w-[180px] items-center gap-1.5 rounded-md border px-2.5 text-caption font-emphasis transition-colors ${
          active
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-brand hover:text-brand'
        }`}
      >
        {TabIcon ? (
          <TabIcon className="h-3.5 w-3.5 shrink-0" />
        ) : t.key === TAB_UNGROUPED ? (
          <Layers className="h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : null}
        <span className="truncate">{t.label}</span>
        <span className={`text-micro ${active ? 'text-brand' : 'text-text-quaternary'}`}>{t.count}</span>
      </button>
    );
  };

  const ActiveIcon = activeGroup ? (resolveScreenIcon(activeGroup.icon) ?? Layers) : null;
  const addHint = activeGroup
    ? t('workboards.canvas.addIntoWorkspace', { name: activeGroup.label })
    : effectiveTab === TAB_UNGROUPED
      ? t('workboards.canvas.addIntoUngrouped')
      : t('workboards.canvas.addUngroupedScreen');

  return (
    <div className="w-full px-6 py-6 lg:px-8">
      {/* Data-strip — bound dataset. */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Database className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            {t('workboards.canvas.boundDataset')}
          </div>
          <div className="mt-0.5 truncate text-caption font-emphasis text-text-primary">
            {boundDataset?.name || t('workboards.canvas.noDataset')}
          </div>
          <div className="text-micro text-text-tertiary">
            {t('workboards.canvas.datasetHintPrefix', { count: tables.length })}{' '}
            <strong>{t('workboards.layout.settings')}</strong>.
          </div>
        </div>
      </div>

      {/* ── Workspace tab strip ─────────────────────────────────────────── */}
      <div className="mb-1 flex items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 text-text-quaternary" />
        <span className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          {t('workboards.canvas.workspaces')}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {tabs.map(renderTab)}
        {/* Create-workspace pill */}
        {creating ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                if (createError) setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setDraftName('');
                  setCreateError(null);
                }
              }}
              placeholder={t('workboards.canvas.workspaceNamePlaceholder')}
              className="h-8 w-40 rounded-md border border-brand bg-surface-0 px-2.5 text-caption text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={handleCreate}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-brand px-2.5 text-tiny font-emphasis text-white hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" />
              {t('workboards.canvas.add')}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setDraftName('');
                setCreateError(null);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-2"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setDraftName('');
              setCreateError(null);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] px-2.5 text-tiny font-emphasis text-text-tertiary hover:border-brand hover:text-brand"
            title={t('workboards.canvas.createWorkspaceTitle')}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t('workboards.canvas.workspace')}
          </button>
        )}
      </div>
      {createError && <p className="mb-2 text-micro text-danger">{createError}</p>}

      {/* ── Active-workspace header + add palette ────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {activeGroup ? (
            <>
              <button
                type="button"
                onClick={() => setIconOpen((v) => !v)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand hover:ring-2 hover:ring-brand/30"
                    title={t('workboards.canvas.changeWorkspaceIcon')}
              >
                {ActiveIcon ? <ActiveIcon className="h-4 w-4" /> : <Layers className="h-4 w-4" />}
              </button>
              {renaming ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') {
                      setRenaming(false);
                      setEditName('');
                    }
                  }}
                  onBlur={commitRename}
                  className="h-7 w-44 rounded border border-brand bg-surface-0 px-2 text-small font-strong text-text-primary outline-none"
                />
              ) : (
                <span className="truncate text-small font-strong text-text-primary">
                  {activeGroup.label}
                </span>
              )}
              <span className="shrink-0 text-micro text-text-quaternary">
                {t('workboards.canvas.screenCount', { count: visibleScreens.length })}
              </span>
              {!renaming && (
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(true);
                    setEditName(activeGroup.label);
                  }}
                  className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
                  title={t('workboards.canvas.renameWorkspace')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      t('workboards.canvas.deleteWorkspaceConfirm', { name: activeGroup.label }),
                    )
                  ) {
                    onDeleteGroup(activeGroup.id);
                    setActiveTab(TAB_ALL);
                  }
                }}
                className="rounded p-1 text-text-quaternary opacity-70 hover:bg-danger/10 hover:text-danger hover:opacity-100"
                title={t('workboards.canvas.deleteWorkspace')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <span className="text-small font-strong text-text-primary">
              {effectiveTab === TAB_UNGROUPED
                ? t('workboards.canvas.ungroupedFull')
                : t('workboards.canvas.allScreens')}
              <span className="ml-2 text-micro font-normal text-text-quaternary">
                {t('workboards.canvas.screenCount', { count: visibleScreens.length })}
              </span>
            </span>
          )}
        </div>
        {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 hidden text-micro text-text-tertiary sm:inline">{addHint}</span>
          {PALETTE.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.kind}
                type="button"
                onClick={() => handleAddScreen(entry.kind)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 text-caption font-emphasis text-text-secondary hover:border-brand hover:text-brand"
                title={`${screenKindLabel(entry.kind, t)} - ${addHint}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {screenKindLabel(entry.kind, t)}
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Inline icon picker for the active workspace (toggled by its icon). */}
      {activeGroup && iconOpen && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
          <span className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            {t('workboards.canvas.icon')}
          </span>
          <div className="w-[260px]">
            <IconPicker
              value={activeGroup.icon ?? undefined}
              onChange={(next) => {
                onSetGroupIcon(activeGroup.id, next || null);
              }}
              placeholder={t('workboards.canvas.iconOptionalPlaceholder')}
            />
          </div>
          <button
            type="button"
            onClick={() => setIconOpen(false)}
            className="ml-auto rounded p-1 text-text-tertiary hover:bg-surface-2"
            title={t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Screen cards for the active workspace (or empty states) ──────── */}
      {screens.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-6 py-10 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
            <Plus className="h-5 w-5" />
          </div>
          <h3 className="text-small font-strong text-text-primary">
            {t('workboards.canvas.emptyTitle')}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-caption text-text-tertiary">
            {t('workboards.canvas.emptyDescription')}
          </p>
        </div>
      ) : visibleScreens.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-6 py-8 text-center">
          <p className="text-caption text-text-tertiary">
            {effectiveTab === TAB_UNGROUPED
              ? t('workboards.canvas.emptyUngrouped')
              : t('workboards.canvas.emptyWorkspace')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleScreens.map((s, vIdx) => {
            const PickedIcon = resolveScreenIcon(s.icon);
            const Icon = PickedIcon ?? KIND_ICON[s.kind];
            const status = screenStatus(s, t);
            const table = tables.find((t) => t.id === s.table_id);
            const canUp = vIdx > 0;
            const canDown = vIdx < visibleScreens.length - 1;
            const isDragging = dragId === s.id;
            const isDropTarget = dropId === s.id && dragId !== null && dragId !== s.id;
            const menuOpen = moveMenuFor === s.id;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  setDragId(s.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', s.id);
                }}
                onDragOver={(event) => {
                  if (dragId === null || dragId === s.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dropId !== s.id) setDropId(s.id);
                }}
                onDragLeave={() => {
                  if (dropId === s.id) setDropId(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragId !== null && dragId !== s.id) {
                    const from = absById.get(dragId);
                    const to = absById.get(s.id);
                    if (from !== undefined && to !== undefined) onReorderScreens(from, to);
                  }
                  setDragId(null);
                  setDropId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropId(null);
                }}
                onClick={() => onPickScreen(s.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onPickScreen(s.id);
                  }
                }}
                className={`group grid cursor-pointer grid-cols-[20px_40px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 rounded-xl border bg-surface-1 px-3 py-2.5 text-left transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear-sm ${
                  isDragging
                    ? 'border-brand/40 opacity-50'
                    : isDropTarget
                      ? 'border-brand'
                      : 'border-[rgb(var(--border-line))]'
                }`}
              >
                {/* Drag handle */}
                <span
                  className="flex h-8 w-5 cursor-grab items-center justify-center text-text-quaternary group-hover:text-text-tertiary active:cursor-grabbing"
                  title={t('workboards.canvas.dragToReorder')}
                  onClick={(event) => event.stopPropagation()}
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-text-secondary group-hover:text-text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-caption font-emphasis text-text-primary">
                      {s.title}
                    </span>
                    <span className="inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 text-tiny font-emphasis uppercase tracking-wider text-text-tertiary">
                      {screenKindLabel(s.kind, t)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-micro text-text-tertiary">
                    {screenSubtitle(s, t)}
                  </div>
                </div>
                <div className="text-right text-micro text-text-quaternary">
                  {table ? (
                    <span className="font-emphasis text-text-secondary">
                      {table.source_table_name}
                    </span>
                  ) : (
                    t('workboards.canvas.noTable')
                  )}
                </div>
                <span
                  className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-tiny font-emphasis ${STATUS_COLOR[status.kind]}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status.kind]}`} />
                  {status.label}
                </span>
                {/* Row actions: move-to-workspace · up · down · delete */}
                <div className="flex items-center gap-0.5">
                  <span className="relative">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMoveMenuFor(menuOpen ? null : s.id);
                      }}
                      className={`rounded p-1 ${
                        menuOpen ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-2 hover:text-text-primary'
                      }`}
                      title={t('workboards.canvas.moveToWorkspace')}
                    >
                      <FolderInput className="h-3.5 w-3.5" />
                    </button>
                    {menuOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMoveMenuFor(null);
                          }}
                        />
                        <div
                          className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 py-1 shadow-popover"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="px-3 py-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                            {t('workboards.canvas.moveScreenTo', { title: s.title })}
                          </div>
                          {groups.map((g) => {
                            const here = groupOfScreen.get(s.id) === g.id;
                            const GIcon = resolveScreenIcon(g.icon) ?? Layers;
                            return (
                              <button
                                key={g.id}
                                type="button"
                                disabled={here}
                                onClick={() => handleMove(s.id, g.id, g.label)}
                                className={`flex w-full items-center gap-2 px-3 py-1.5 text-caption transition-colors ${
                                  here
                                    ? 'cursor-default text-text-quaternary'
                                    : 'text-text-primary hover:bg-surface-2'
                                }`}
                              >
                                <GIcon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                                <span className="min-w-0 flex-1 truncate text-left">{g.label}</span>
                                {here && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                              </button>
                            );
                          })}
                          <div className="my-1 border-t border-[rgb(var(--border-line))]" />
                          <button
                            type="button"
                            disabled={!groupOfScreen.has(s.id)}
                            onClick={() => handleMove(s.id, null, t('workboards.canvas.ungrouped'))}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-caption transition-colors ${
                              !groupOfScreen.has(s.id)
                                ? 'cursor-default text-text-quaternary'
                                : 'text-text-primary hover:bg-surface-2'
                            }`}
                          >
                            <Layers className="h-3.5 w-3.5 shrink-0 opacity-60" />
                            <span className="min-w-0 flex-1 truncate text-left">
                              {t('workboards.canvas.removeFromGroup')}
                            </span>
                            {!groupOfScreen.has(s.id) && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                          </button>
                        </div>
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveByOne(s.id, -1);
                    }}
                    disabled={!canUp}
                    className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
                    title={t('workboards.canvas.moveUp')}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveByOne(s.id, 1);
                    }}
                    disabled={!canDown}
                    className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
                    title={t('workboards.canvas.moveDown')}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  {canEdit && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteScreen(s.id);
                    }}
                    className="rounded p-1 text-text-quaternary opacity-60 hover:bg-danger/10 hover:text-danger hover:opacity-100"
                    title={t('workboards.canvas.deleteScreen')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
