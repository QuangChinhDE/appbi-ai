/**
 * CanvasOverview — Mức 1 của builder.
 *
 * Khi user vào tab Builder, đây là view đầu tiên: chỉ liệt kê screens
 * có trong mini-app như những hàng card lớn, kèm data-strip (dataset
 * đang bind) ở đầu và palette "+ Form / + List / …" ở section heading.
 *
 * Click 1 screen card -> WorkboardBuilder switch sang mức 2 (Screen
 * editor full-page). Pattern này tách 2 nhiệm vụ khác nhau (xem tổng
 * quan vs. config 1 screen) thay vì nhồi chung 1 màn hình.
 *
 * Style bám sát design tokens hệ thống (rgb(var(--surface-1)),
 * text-caption, font-emphasis, brand color) — không sinh ra token mới.
 */
'use client';

import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ClipboardEdit,
  Database,
  FileText,
  Grid3x3,
  GripVertical,
  LayoutDashboard,
  ListChecks,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';

import type { Dataset } from '@/hooks/use-datasets';
import type { ScreenKind, ScreenSpec } from './types';
import { resolveScreenIcon } from './ScreenIconRegistry';

const KIND_ICON: Record<ScreenKind, React.ElementType> = {
  form: ClipboardEdit,
  list: ListChecks,
  doc: FileText,
  dashboard: LayoutDashboard,
  grid: Grid3x3,
};

const KIND_LABEL: Record<ScreenKind, string> = {
  form: 'Form',
  list: 'List',
  doc: 'Document',
  dashboard: 'Dashboard',
  grid: 'Grid',
};

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

interface Props {
  screens: ScreenSpec[];
  tables: DatasetTableInfo[];
  boundDataset: Dataset | null;
  onPickScreen: (id: string) => void;
  onAddScreen: (kind: ScreenKind) => void;
  onOpenAppSettings: () => void;
  onMoveScreen: (idx: number, dir: -1 | 1) => void;
  /** Drag-and-drop reorder: moves the screen at ``fromIdx`` to
   * ``toIdx`` (positions are pre-drop indices in the current array). */
  onReorderScreens: (fromIdx: number, toIdx: number) => void;
  onDeleteScreen: (id: string) => void;
}

/**
 * Compute a one-liner subtitle for a screen card from its spec — e.g.
 * "5 fields · 1 initial value" or "Pick a dashboard or paste a share token".
 * The aim is to surface the *config state* at a glance so the user can
 * tell which screens still need work without clicking in.
 */
function screenSubtitle(s: ScreenSpec): string {
  if (s.kind === 'form') {
    const fields = s.form?.fields?.length ?? 0;
    const initial = Object.keys(s.form?.initial_values || {}).length;
    if (fields === 0) return 'No fields yet — add the first one.';
    const initialPart = initial > 0 ? ` · ${initial} initial value${initial === 1 ? '' : 's'}` : '';
    return `${fields} field${fields === 1 ? '' : 's'}${initialPart}`;
  }
  if (s.kind === 'list') {
    const cols = s.list?.columns?.length ?? 0;
    const actions = s.list?.row_actions?.length ?? 0;
    if (cols === 0) return 'No columns yet — pick which to show.';
    const actionsPart = actions > 0 ? ` · ${actions} row action${actions === 1 ? '' : 's'}` : '';
    return `${cols} column${cols === 1 ? '' : 's'} · ${s.list?.page_size ?? 50} / page${actionsPart}`;
  }
  if (s.kind === 'grid') {
    const cols = s.grid?.columns?.length ?? 0;
    const computed = s.grid?.computed_columns?.length ?? 0;
    if (cols === 0) return 'No columns yet — pick which to show.';
    const formulaPart = computed > 0 ? ` · ${computed} formula${computed === 1 ? '' : 's'}` : '';
    return `${cols} column${cols === 1 ? '' : 's'}${formulaPart}`;
  }
  if (s.kind === 'doc') {
    const blocks = s.doc?.blocks?.length ?? 0;
    const page = s.doc?.page;
    const sizeLabel = page ? `${page.size ?? 'A4'} ${page.orientation ?? 'portrait'}` : 'A4 portrait';
    if (blocks === 0) return `${sizeLabel} · no blocks — add a header + table to start.`;
    return `${sizeLabel} · ${blocks} block${blocks === 1 ? '' : 's'}`;
  }
  if (s.kind === 'dashboard') {
    const d = s.dashboard;
    if (typeof d?.dashboard_id === 'number' && d.dashboard_id > 0) {
      const slots = (d.role_filter_mapping?.length || 0) + (d.static_filters?.length || 0);
      return slots > 0
        ? `Managed dashboard #${d.dashboard_id} · ${slots} filter slot${slots === 1 ? '' : 's'}`
        : `Managed dashboard #${d.dashboard_id}`;
    }
    if ((d?.share_token || '').trim()) return 'Manual share-token mode';
    return 'Pick a dashboard or paste a share token.';
  }
  return '';
}

function screenStatus(s: ScreenSpec): ScreenStatus {
  if (s.kind === 'form' || s.kind === 'list' || s.kind === 'grid' || s.kind === 'doc') {
    if (!s.table_id) return { kind: 'err', label: 'No data source' };
  }
  if (s.kind === 'form' && (s.form?.fields?.length ?? 0) === 0) {
    return { kind: 'warn', label: 'Needs fields' };
  }
  if (s.kind === 'list' && (s.list?.columns?.length ?? 0) === 0) {
    return { kind: 'warn', label: 'Needs columns' };
  }
  if (s.kind === 'grid' && (s.grid?.columns?.length ?? 0) === 0) {
    return { kind: 'warn', label: 'Needs columns' };
  }
  if (s.kind === 'doc' && (s.doc?.blocks?.length ?? 0) === 0) {
    return { kind: 'warn', label: 'Needs blocks' };
  }
  if (s.kind === 'dashboard') {
    const hasManaged = typeof s.dashboard?.dashboard_id === 'number' && (s.dashboard.dashboard_id ?? 0) > 0;
    const hasManual = !!(s.dashboard?.share_token || '').trim();
    if (!hasManaged && !hasManual) return { kind: 'err', label: 'No source' };
  }
  return { kind: 'ok', label: 'Configured' };
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
  { kind: 'list', icon: ListChecks, label: 'List' },
  { kind: 'grid', icon: Grid3x3, label: 'Grid' },
  { kind: 'doc', icon: FileText, label: 'Document' },
  { kind: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
];

export default function CanvasOverview({
  screens,
  tables,
  boundDataset,
  onPickScreen,
  onAddScreen,
  onOpenAppSettings,
  onMoveScreen,
  onReorderScreens,
  onDeleteScreen,
}: Props) {
  // Native HTML5 drag-and-drop state. We only need to know which index
  // is being dragged and which index the cursor is currently hovering
  // over — the actual reorder is delegated to the parent so it can
  // mutate the layout + navigation in one go.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  return (
    <div className="w-full px-6 py-6 lg:px-8">
      {/* Data-strip — bound dataset (replaces the gear-icon flow). */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Database className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
            Bound dataset
          </div>
          <div className="mt-0.5 truncate text-caption font-emphasis text-text-primary">
            {boundDataset?.name || '— no dataset —'}
          </div>
          <div className="text-micro text-text-tertiary">
            Each screen picks one table from this dataset. {tables.length} table
            {tables.length === 1 ? '' : 's'} available.
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenAppSettings}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption font-emphasis text-text-primary hover:bg-surface-2"
        >
          <Settings className="h-3.5 w-3.5" />
          App settings
        </button>
      </div>

      {/* Section heading + palette */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-h3 font-strong text-text-primary">
          Screens
          <span className="ml-2 text-caption font-normal text-text-tertiary">
            · {screens.length}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {PALETTE.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.kind}
                type="button"
                onClick={() => onAddScreen(entry.kind)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption font-emphasis text-text-secondary hover:border-brand hover:text-brand"
              >
                <Icon className="h-3.5 w-3.5" />
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Screen cards (or empty state) */}
      {screens.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-line))] bg-surface-1 px-6 py-10 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
            <Plus className="h-5 w-5" />
          </div>
          <h3 className="text-small font-strong text-text-primary">No screens yet</h3>
          <p className="mx-auto mt-1 max-w-md text-caption text-text-tertiary">
            A mini-app is made of one or more screens. Pick a kind above to add the first
            one — Form for data entry, List/Grid for browsing, Document for printable
            reports, Dashboard to embed charts.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {screens.map((s, idx) => {
            // Prefer the user-picked icon (matched against the icon
            // registry); fall back to the screen-kind default so newly
            // added screens still render before the user opens Settings.
            const PickedIcon = resolveScreenIcon(s.icon);
            const Icon = PickedIcon ?? KIND_ICON[s.kind];
            const status = screenStatus(s);
            const table = tables.find((t) => t.id === s.table_id);
            const canUp = idx > 0;
            const canDown = idx < screens.length - 1;
            const isDragging = dragIdx === idx;
            const isDropTarget = dropIdx === idx && dragIdx !== null && dragIdx !== idx;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  setDragIdx(idx);
                  event.dataTransfer.effectAllowed = 'move';
                  // Some browsers require a payload to allow drop; the
                  // content itself is unused — we track state by index.
                  event.dataTransfer.setData('text/plain', String(idx));
                }}
                onDragOver={(event) => {
                  if (dragIdx === null || dragIdx === idx) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dropIdx !== idx) setDropIdx(idx);
                }}
                onDragLeave={() => {
                  if (dropIdx === idx) setDropIdx(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIdx !== null && dragIdx !== idx) {
                    onReorderScreens(dragIdx, idx);
                  }
                  setDragIdx(null);
                  setDropIdx(null);
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setDropIdx(null);
                }}
                onClick={() => onPickScreen(s.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onPickScreen(s.id);
                  }
                }}
                className={`group grid cursor-pointer grid-cols-[20px_44px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 rounded-xl border bg-surface-1 px-3 py-3 text-left transition-all hover:border-[rgb(var(--border-strong))] hover:shadow-linear-sm ${
                  isDragging
                    ? 'border-brand/40 opacity-50'
                    : isDropTarget
                      ? 'border-brand'
                      : 'border-[rgb(var(--border-line))]'
                }`}
              >
                {/* Drag handle — cursor-grab signals the card is draggable. */}
                <span
                  className="flex h-8 w-5 cursor-grab items-center justify-center text-text-quaternary group-hover:text-text-tertiary active:cursor-grabbing"
                  title="Drag to reorder"
                  onClick={(event) => event.stopPropagation()}
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-secondary group-hover:text-text-primary">
                  <Icon className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-body font-strong text-text-primary">
                      {s.title}
                    </span>
                    <span className="inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 text-tiny font-emphasis uppercase tracking-wider text-text-tertiary">
                      {KIND_LABEL[s.kind]}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-caption text-text-tertiary">
                    {screenSubtitle(s)}
                  </div>
                </div>
                <div className="text-right text-micro text-text-quaternary">
                  {table ? (
                    <span className="font-emphasis text-text-secondary">
                      {table.source_table_name}
                    </span>
                  ) : (
                    'no table'
                  )}
                </div>
                <span
                  className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-tiny font-emphasis ${STATUS_COLOR[status.kind]}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status.kind]}`} />
                  {status.label}
                </span>
                {/* Row actions — kept always-visible (previously hover
                    only, which made reorder feel hidden). Delete stays
                    slightly de-emphasised to discourage accidents. */}
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMoveScreen(idx, -1);
                    }}
                    disabled={!canUp}
                    className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMoveScreen(idx, 1);
                    }}
                    disabled={!canDown}
                    className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteScreen(s.id);
                    }}
                    className="rounded p-1 text-text-quaternary opacity-60 hover:bg-danger/10 hover:text-danger hover:opacity-100"
                    title="Delete screen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
