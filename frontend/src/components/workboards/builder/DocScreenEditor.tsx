/**
 * DocScreenEditor keeps document setup in the shared object-editor pattern:
 * source picker first, object navigator on the left, inspector on the right.
 */
'use client';

import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileText,
  GripVertical,
  Heading1,
  LayoutGrid,
  Minus,
  PenTool,
  Plus,
  Table2,
  Trash2,
  Type,
  X,
} from 'lucide-react';

import {
  FixedExpressionInput,
  MultiColumnPicker,
  type SelectOption,
} from './BuilderValueControls';
import {
  BUILDER_GRID_3,
  BuilderActionButton,
  BuilderCollapsibleAdvanced,
  BuilderEmptyHint,
  BuilderIconButton,
  BuilderInspectorPanel,
  BuilderObjectEditor,
  BuilderSubsection,
  BuilderTopBar,
  BuilderTopBarItem,
  DataSourcePicker,
} from './BuilderChrome';
import type { DocBlockSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

type BlockKind = DocBlockSpec['type'];
type DocActiveItem = 'page' | `block:${number}`;

const BLOCK_META: Record<BlockKind, { label: string; icon: React.ComponentType<{ className?: string }>; group: 'text' | 'data' | 'layout' }> = {
  header: { label: 'Header', icon: Heading1, group: 'text' },
  text: { label: 'Text', icon: Type, group: 'text' },
  footer: { label: 'Footer', icon: FileText, group: 'text' },
  data_table: { label: 'Data table', icon: Table2, group: 'data' },
  kv_grid: { label: 'Key-value grid', icon: LayoutGrid, group: 'data' },
  spacer: { label: 'Spacer', icon: Minus, group: 'layout' },
  signature: { label: 'Signature', icon: PenTool, group: 'layout' },
};

const BLOCK_GROUPS: Array<{ id: 'text' | 'data' | 'layout'; label: string; kinds: BlockKind[] }> = [
  { id: 'text', label: 'Title & text', kinds: ['header', 'text', 'footer'] },
  { id: 'data', label: 'Data', kinds: ['data_table', 'kv_grid'] },
  { id: 'layout', label: 'Layout & sign-off', kinds: ['spacer', 'signature'] },
];

const DOC_EXPRESSION_OPTIONS: SelectOption[] = [
  { value: '{{workboard.name}}', label: 'Workboard > Name' },
  { value: '{{app_user.username}}', label: 'App user > Username' },
  { value: '{{app_user.full_name}}', label: 'App user > Full name' },
  { value: '{{today}}', label: 'System > Today' },
  { value: '{{now}}', label: 'System > Now' },
];

import type { BuilderMode } from './useBuilderMode';

export default function DocScreenEditor({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
  mode?: BuilderMode;
}) {
  const doc = screen.doc || { blocks: [] };
  const blocks = doc.blocks || [];
  const [activeItem, setActiveItem] = useState<DocActiveItem>('page');

  const activeIdx = activeItem.startsWith('block:')
    ? Number(activeItem.slice('block:'.length))
    : -1;
  const safeIdx =
    activeIdx >= 0 && blocks.length > 0 ? Math.min(activeIdx, blocks.length - 1) : -1;
  const activeBlock = safeIdx >= 0 ? blocks[safeIdx] : null;

  const updateDoc = (patch: Partial<NonNullable<ScreenSpec['doc']>>) =>
    onChange({ ...screen, doc: { ...doc, ...patch } });

  const updateBlock = (idx: number, patch: Partial<DocBlockSpec>) => {
    const next = [...blocks];
    next[idx] = { ...next[idx], ...patch };
    updateDoc({ blocks: next });
  };

  const moveBlock = (idx: number, dir: -1 | 1) => {
    const next = [...blocks];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    updateDoc({ blocks: next });
    if (safeIdx === idx) setActiveItem(`block:${target}`);
    else if (safeIdx === target) setActiveItem(`block:${idx}`);
  };

  const removeBlock = (idx: number) => {
    const next = blocks.filter((_, index) => index !== idx);
    updateDoc({ blocks: next });
    if (safeIdx === idx) {
      setActiveItem(next.length > 0 ? `block:${Math.max(0, Math.min(idx, next.length - 1))}` : 'page');
    } else if (safeIdx > idx) {
      setActiveItem(`block:${safeIdx - 1}`);
    }
  };

  const addBlock = (type: BlockKind) => {
    const fresh = makeFreshBlock(type);
    updateDoc({ blocks: [...blocks, fresh] });
    setActiveItem(`block:${blocks.length}`);
  };

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      <BuilderObjectEditor>
        <Outline
          page={doc.page}
          blocks={blocks}
          activeItem={activeItem}
          activeIdx={safeIdx}
          onSelectPage={() => setActiveItem('page')}
          onSelect={(idx) => setActiveItem(`block:${idx}`)}
          onAdd={addBlock}
          onMoveUp={(idx) => moveBlock(idx, -1)}
          onMoveDown={(idx) => moveBlock(idx, 1)}
          onRemove={removeBlock}
        />

        {activeItem === 'page' ? (
          <BuilderInspectorPanel
            icon={<FileText className="h-4 w-4" />}
            title="Page setup"
            subtitle="Paper, orientation, margins, and the primary source used by data blocks."
          >
            <PageSetupInspector page={doc.page} onChange={(page) => updateDoc({ page })} />
          </BuilderInspectorPanel>
        ) : (
          <Inspector
            block={activeBlock}
            tables={tables}
            screenTableId={screen.table_id ?? null}
            onChange={(patch) => safeIdx >= 0 && updateBlock(safeIdx, patch)}
            onRemove={() => safeIdx >= 0 && removeBlock(safeIdx)}
          />
        )}
      </BuilderObjectEditor>
    </div>
  );
}
function makeFreshBlock(type: BlockKind): DocBlockSpec {
  switch (type) {
    case 'header':
      return { type, title: 'Title', subtitle: '', align: 'center' };
    case 'kv_grid':
      return { type, columns: 4, items: [{ label: 'Label', value: 'Value' }] };
    case 'data_table':
      return {
        type,
        source: 'primary',
        columns: [],
        column_groups: [],
        filters_from_view: false,
        totals: [],
        group_by: [],
        max_rows: 200,
        show_index: false,
        title: '',
        transform: null,
        allow_export_excel: false,
      };
    case 'text':
      return { type, content: '', align: 'left' };
    case 'spacer':
      return { type, height_mm: 4 };
    case 'signature':
      return { type, slots: [{ label: 'Signer', role: '' }] };
    default:
      return { type: 'footer', left: '', center: '', right: '' };
  }
}

// ─── Page setup bar ─────────────────────────────────────────────────────

function PageSetupInspector({
  page,
  onChange,
}: {
  page: NonNullable<ScreenSpec['doc']>['page'];
  onChange: (next: NonNullable<NonNullable<ScreenSpec['doc']>['page']>) => void;
}) {
  const size = page?.size || 'A4';
  const orientation = page?.orientation || 'portrait';
  const margin = page?.margin_mm ?? 15;

  return (
    <div className={BUILDER_GRID_3}>
      <Lbl label="Paper">
        <select
          value={size}
          onChange={(event) => onChange({ ...page, size: event.target.value as 'A4' | 'A3' | 'Letter' })}
          className={INPUT}
        >
          <option value="A4">A4</option>
          <option value="A3">A3</option>
          <option value="Letter">Letter</option>
        </select>
      </Lbl>
      <Lbl label="Orientation">
        <select
          value={orientation}
          onChange={(event) =>
            onChange({ ...page, orientation: event.target.value as 'portrait' | 'landscape' })
          }
          className={INPUT}
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </Lbl>
      <Lbl label="Margin (mm)">
        <input
          type="number"
          min={0}
          max={50}
          value={margin}
          onChange={(event) => onChange({ ...page, margin_mm: Number(event.target.value) })}
          className={INPUT}
        />
      </Lbl>
    </div>
  );
}

// ─── Outline (left column) ──────────────────────────────────────────────

function Outline({
  page,
  blocks,
  activeItem,
  activeIdx,
  onSelectPage,
  onSelect,
  onAdd,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  page: NonNullable<ScreenSpec['doc']>['page'];
  blocks: DocBlockSpec[];
  activeItem: DocActiveItem;
  activeIdx: number;
  onSelectPage: () => void;
  onSelect: (idx: number) => void;
  onAdd: (type: BlockKind) => void;
  onMoveUp: (idx: number) => void;
  onMoveDown: (idx: number) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <aside className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <h2 className="mb-2 text-caption font-emphasis text-text-secondary">
        Document objects
      </h2>

      <div className="space-y-1">
        <div
          className={`group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-tiny transition-colors ${
            activeItem === 'page'
              ? 'border-brand/40 bg-brand/10 text-text-primary'
              : 'border-transparent hover:bg-surface-2'
          }`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          <button
            type="button"
            onClick={onSelectPage}
            className="flex min-w-0 flex-1 flex-col text-left"
          >
            <span className="truncate font-medium text-text-primary">Page setup</span>
            <span className="truncate text-tiny text-text-tertiary">
              {page?.size || 'A4'} - {page?.orientation || 'portrait'} - {page?.margin_mm ?? 15} mm
            </span>
          </button>
        </div>

        <div className="px-1 pt-3 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
          Blocks ({blocks.length})
        </div>
        {blocks.map((block, idx) => {
          const meta = BLOCK_META[block.type];
          const Icon = meta.icon;
          const subtitle = describeBlock(block);
          const isActive = idx === activeIdx;
          return (
            <div
              key={idx}
              className={`group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-tiny transition-colors ${
                isActive
                  ? 'border-brand/40 bg-brand/10 text-text-primary'
                  : 'border-transparent hover:bg-surface-2'
              }`}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
              <button
                type="button"
                onClick={() => onSelect(idx)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-text-primary">
                    {meta.label}
                  </span>
                  {subtitle && (
                    <span className="block truncate text-tiny text-text-tertiary">{subtitle}</span>
                  )}
                </span>
              </button>
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                {idx > 0 && (
                  <button
                    type="button"
                    onClick={() => onMoveUp(idx)}
                    title="Move up"
                    className="rounded p-1 text-text-tertiary hover:bg-surface-0 hover:text-text-primary"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                )}
                {idx < blocks.length - 1 && (
                  <button
                    type="button"
                    onClick={() => onMoveDown(idx)}
                    title="Move down"
                    className="rounded p-1 text-text-tertiary hover:bg-surface-0 hover:text-text-primary"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  title="Delete"
                  className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
        {blocks.length === 0 && (
          <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-3 text-center text-tiny text-text-tertiary">
            No blocks yet. Add one below.
          </p>
        )}
      </div>

      <AddBlockMenu onAdd={onAdd} />
    </aside>
  );
}

function describeBlock(block: DocBlockSpec): string {
  switch (block.type) {
    case 'header': {
      const title = String(block.title || '').trim();
      return title ? `"${title.length > 20 ? `${title.slice(0, 20)}...` : title}"` : '-';
    }
    case 'text': {
      const content = String(block.content || '').trim();
      return content ? content.slice(0, 24) : '-';
    }
    case 'data_table': {
      const source = String(block.source || 'primary');
      const cols = Array.isArray(block.columns) ? block.columns.length : 0;
      return `${source === 'primary' ? 'primary source' : 'specific table'} - ${cols} cols`;
    }
    case 'kv_grid': {
      const items = Array.isArray(block.items) ? block.items.length : 0;
      return `${items} cell${items === 1 ? '' : 's'}`;
    }
    case 'signature': {
      const slots = Array.isArray(block.slots) ? block.slots.length : 0;
      return `${slots} slot${slots === 1 ? '' : 's'}`;
    }
    case 'spacer':
      return `${Number(block.height_mm ?? 4)} mm`;
    case 'footer': {
      const left = String(block.left || '');
      const right = String(block.right || '');
      return left || right ? `${left}${left && right ? ' / ' : ''}${right}` : '-';
    }
    default:
      return '';
  }
}

function AddBlockMenu({ onAdd }: { onAdd: (type: BlockKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[rgb(var(--border-line))] py-1.5 text-tiny font-medium text-text-secondary hover:border-brand/40 hover:bg-brand/5 hover:text-text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        Add block
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {BLOCK_GROUPS.map((group) => (
            <div key={group.id} className="mb-2 last:mb-0">
              <p className="px-1.5 pb-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                {group.label}
              </p>
              {group.kinds.map((kind) => {
                const meta = BLOCK_META[kind];
                const Icon = meta.icon;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      onAdd(kind);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-tiny text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                  >
                    <Icon className="h-3.5 w-3.5 text-text-tertiary" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Inspector (center column) ──────────────────────────────────────────

function Inspector({
  block,
  tables,
  screenTableId,
  onChange,
  onRemove,
}: {
  block: DocBlockSpec | null;
  tables: DatasetTableInfo[];
  screenTableId: number | null;
  onChange: (patch: Partial<DocBlockSpec>) => void;
  onRemove: () => void;
}) {
  if (!block) {
    return (
      <BuilderInspectorPanel
        icon={<FileText className="h-4 w-4" />}
        title="Document blocks"
        subtitle="Add a block from the left panel to start editing the document."
      >
        <BuilderEmptyHint>No block selected.</BuilderEmptyHint>
      </BuilderInspectorPanel>
    );
  }

  const meta = BLOCK_META[block.type];
  const Icon = meta.icon;

  return (
    <BuilderInspectorPanel
      icon={<Icon className="h-4 w-4" />}
      title={meta.label}
      subtitle={describeBlock(block)}
      action={
        <BuilderIconButton onClick={onRemove} title="Delete block" variant="danger">
          <Trash2 className="h-3.5 w-3.5 text-danger" />
        </BuilderIconButton>
      }
    >
      {block.type === 'header' && <HeaderInspector block={block} onChange={onChange} />}
      {block.type === 'text' && <TextInspector block={block} onChange={onChange} />}
      {block.type === 'spacer' && <SpacerInspector block={block} onChange={onChange} />}
      {block.type === 'kv_grid' && <KvGridEditor block={block} onChange={onChange} />}
      {block.type === 'data_table' && (
        <DataTableEditor
          block={block}
          tables={tables}
          screenTableId={screenTableId}
          onChange={onChange}
        />
      )}
      {block.type === 'signature' && <SignatureEditor block={block} onChange={onChange} />}
      {block.type === 'footer' && <FooterInspector block={block} onChange={onChange} />}
    </BuilderInspectorPanel>
  );
}

function HeaderInspector({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_3}>
      <Lbl label="Title">
        <input
          value={String(block.title ?? '')}
          onChange={(event) => onChange({ title: event.target.value })}
          className={INPUT}
        />
      </Lbl>
      <Lbl label="Subtitle">
        <input
          value={String(block.subtitle ?? '')}
          onChange={(event) => onChange({ subtitle: event.target.value })}
          className={INPUT}
        />
      </Lbl>
      <Lbl label="Align">
        <select
          value={String(block.align ?? 'center')}
          onChange={(event) => onChange({ align: event.target.value })}
          className={INPUT}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Lbl>
    </div>
  );
}

function TextInspector({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  return (
    <div className="space-y-3">
      <Lbl label="Content">
        <textarea
          value={String(block.content ?? '')}
          onChange={(event) => onChange({ content: event.target.value })}
          rows={3}
          className={INPUT}
        />
      </Lbl>
      <Lbl label="Align">
        <select
          value={String(block.align ?? 'left')}
          onChange={(event) => onChange({ align: event.target.value })}
          className={INPUT}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Lbl>
    </div>
  );
}

function SpacerInspector({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  return (
    <Lbl label="Height (mm)">
      <input
        type="number"
        value={Number(block.height_mm ?? 4)}
        onChange={(event) => onChange({ height_mm: Number(event.target.value) })}
        className={INPUT}
      />
    </Lbl>
  );
}

function FooterInspector({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_3}>
      {(['left', 'center', 'right'] as const).map((side) => (
        <Lbl key={side} label={side[0].toUpperCase() + side.slice(1)}>
          <input
            value={String(block[side] ?? '')}
            onChange={(event) => onChange({ [side]: event.target.value } as Partial<DocBlockSpec>)}
            className={INPUT}
          />
        </Lbl>
      ))}
    </div>
  );
}

// ─── KV grid editor ─────────────────────────────────────────────────────

function KvGridEditor({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  const items =
    (((block as { items?: Array<{ label: string; value: string }> }).items) || []) as Array<{
      label: string;
      value: string;
    }>;
  const columns = Number(block.columns ?? 2);

  const updateItem = (
    idx: number,
    patch: Partial<{ label: string; value: string }>,
  ) => {
    const next = [...items];
    next[idx] = { ...next[idx], ...patch };
    onChange({ items: next });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div
            key={idx}
            className="wb-row-key-value rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2"
          >
            <input
              value={item.label}
              onChange={(event) => updateItem(idx, { label: event.target.value })}
              placeholder="Label"
              className={INPUT}
            />
            <FixedExpressionInput
              value={item.value}
              onChange={(next) => updateItem(idx, { value: next })}
              fixedPlaceholder="Fixed value"
              expressionPlaceholder="{{today}} or placeholder"
              expressionOptions={DOC_EXPRESSION_OPTIONS}
            />
            <BuilderIconButton
              onClick={() => onChange({ items: items.filter((_, index) => index !== idx) })}
              title="Delete cell"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <BuilderActionButton
          onClick={() => onChange({ items: [...items, { label: '', value: '' }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          Add cell
        </BuilderActionButton>
        <label className="flex items-center gap-1.5 text-tiny text-text-secondary">
          Columns per row
          <input
            type="number"
            min={1}
            max={6}
            value={columns}
            onChange={(event) => onChange({ columns: Number(event.target.value) })}
            className="h-9 w-16 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
          />
        </label>
      </div>
    </div>
  );
}

// ─── Data table editor ──────────────────────────────────────────────────
//
// The data-table inspector has been redesigned around a two-pane column
// picker. Per-column meta (label, width, format, align, total, merge)
// lives on `block.column_metadata[colName]`. Legacy `group_by` and
// `totals` arrays are still emitted, derived from the meta, so the
// existing runtime continues to work without backend changes.

import type { DataTableColumnMeta } from './types';

type ColumnMetaMap = Record<string, DataTableColumnMeta>;

const NUMERIC_TYPES = new Set([
  'int', 'integer', 'bigint', 'smallint', 'tinyint',
  'float', 'double', 'decimal', 'numeric', 'number', 'real',
]);

function isNumericType(type?: string): boolean {
  if (!type) return false;
  return NUMERIC_TYPES.has(type.toLowerCase());
}

function readColumnMetadata(block: DocBlockSpec): ColumnMetaMap {
  const raw = (block as { column_metadata?: unknown }).column_metadata;
  if (!raw || typeof raw !== 'object') return {};
  return raw as ColumnMetaMap;
}

/**
 * Derive `group_by` (merge=true columns) and `totals` strings
 * (`<col>:<agg>`) from per-column meta. Preserved for runtime compat
 * with the existing backend which still reads these arrays.
 */
function deriveLegacyArrays(
  selected: string[],
  meta: ColumnMetaMap,
): { group_by: string[]; totals: string[] } {
  const group_by: string[] = [];
  const totals: string[] = [];
  for (const col of selected) {
    const m = meta[col];
    if (!m) continue;
    if (m.merge) group_by.push(col);
    if (m.total) totals.push(`${col}:${m.total}`);
  }
  return { group_by, totals };
}

function DataTableEditor({
  block,
  tables,
  screenTableId,
  onChange,
}: {
  block: DocBlockSpec;
  tables: DatasetTableInfo[];
  screenTableId: number | null;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  const source = String(block.source || 'primary');
  const sourceTableId =
    source === 'primary'
      ? (screenTableId ?? null)
      : source.startsWith('lookup:')
      ? Number(source.split(':')[1])
      : null;
  const sourceTable = tables.find((table) => table.id === sourceTableId);
  const tableCols = sourceTable?.columns || [];
  const columnTypeByName = new Map<string, string | undefined>(
    tableCols.map((column) => [column.name, column.type]),
  );
  const selectedColumns = ((block.columns as string[]) || []).filter(Boolean);
  const columnMetadata = readColumnMetadata(block);
  const columnGroups =
    (((block as { column_groups?: Array<{ label?: string; columns?: string[] }> }).column_groups) ||
      []) as Array<{ label?: string; columns?: string[] }>;

  const transform = (block as { transform?: TransformSpec | null }).transform ?? null;

  // Single onChange shim that re-derives group_by/totals from meta.
  const commit = (
    nextSelected: string[],
    nextMeta: ColumnMetaMap,
    extraPatch?: Partial<DocBlockSpec>,
  ) => {
    const { group_by, totals } = deriveLegacyArrays(nextSelected, nextMeta);
    onChange({
      ...extraPatch,
      columns: nextSelected,
      column_metadata: nextMeta as unknown as DocBlockSpec[string],
      group_by,
      totals,
    });
  };

  return (
    <div className="space-y-4">
      {/* Source, title, and display controls. */}
      <DataTableTopBar
        source={source}
        sourceTableId={sourceTableId}
        tables={tables}
        title={String(block.title ?? '')}
        maxRows={Number(block.max_rows ?? 200)}
        showIndex={!!block.show_index}
        filtersFromView={!!block.filters_from_view}
        onPatch={onChange}
      />

      {/* Column object controls. */}
      {source === 'primary' && !screenTableId ? (
        <BuilderEmptyHint className="text-left">
          This table uses the document primary source. Pick a data source at the top
          of the editor, or switch this block to a specific table.
        </BuilderEmptyHint>
      ) : null}

      <BuilderSubsection
        title="Columns"
        action={
          <span className="rounded bg-surface-2 px-2 py-1 text-tiny font-medium text-text-tertiary">
            {selectedColumns.length} selected
          </span>
        }
      >
        <ColumnObjectsEditor
          available={tableCols}
          selected={selectedColumns}
          metadata={columnMetadata}
          onChange={(nextSelected, nextMeta) => commit(nextSelected, nextMeta)}
        />
      </BuilderSubsection>

      {/* Advanced header groups. */}
      <BuilderCollapsibleAdvanced
        title="Header groups"
        description="Span multiple columns under a shared super-header (e.g. Q1/Q2/Q3 grouped under 'Quarter')."
        defaultOpen={columnGroups.length > 0}
      >
        <ColumnGroupsEditor
          selectedColumns={selectedColumns}
          groups={columnGroups}
          onChange={(next) => onChange({ column_groups: next })}
        />
      </BuilderCollapsibleAdvanced>

      {/* Advanced transform. */}
      <BuilderCollapsibleAdvanced
        title="Transform: pivot / unpivot"
        description="Reshape data in-memory before rendering. Does not touch the database."
        defaultOpen={!!transform}
      >
        <TransformEditor
          sourceColumns={tableCols.map((c) => c.name)}
          transform={transform}
          onChange={(next) => onChange({ transform: next ?? null } as Partial<DocBlockSpec>)}
        />
      </BuilderCollapsibleAdvanced>

      {/* Advanced export. */}
      <BuilderCollapsibleAdvanced
        title="Export"
        description="Let end users download the table as Excel."
        defaultOpen={!!block.allow_export_excel}
      >
        <Lbl label="Allow Excel export">
          <select
            value={block.allow_export_excel ? 'yes' : 'no'}
            onChange={(event) =>
              onChange({ allow_export_excel: event.target.value === 'yes' })
            }
            className={INPUT}
          >
            <option value="no">No</option>
            <option value="yes">Yes - show download button</option>
          </select>
        </Lbl>
      </BuilderCollapsibleAdvanced>

      {/* Hidden column type hints only used to pre-fill defaults above. */}
      <ColumnTypeWarnings selected={selectedColumns} typesByName={columnTypeByName} />
    </div>
  );
}

// ─── Data table sub-components ──────────────────────────────────────────

function DataTableTopBar({
  source,
  sourceTableId,
  tables,
  title,
  maxRows,
  showIndex,
  filtersFromView,
  onPatch,
}: {
  source: string;
  sourceTableId: number | null;
  tables: DatasetTableInfo[];
  title: string;
  maxRows: number;
  showIndex: boolean;
  filtersFromView: boolean;
  onPatch: (patch: Partial<DocBlockSpec>) => void;
}) {
  const isLookup = source.startsWith('lookup:');
  return (
    <BuilderTopBar title="Table options" className="bg-surface-0">
      <BuilderTopBarItem label="From">
        <select
          value={isLookup ? 'lookup' : 'primary'}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'primary') onPatch({ source: 'primary' });
            else if (tables[0]) onPatch({ source: `lookup:${tables[0].id}` });
          }}
          className="h-9 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
        >
          <option value="primary">Primary source</option>
          <option value="lookup">Specific table</option>
        </select>
        {isLookup && (
          <select
            value={sourceTableId ?? ''}
            onChange={(event) => onPatch({ source: `lookup:${event.target.value}` })}
            className="h-9 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.display_name}
              </option>
            ))}
          </select>
        )}
      </BuilderTopBarItem>
      <BuilderTopBarItem label="Title" className="flex-1">
        <input
          value={title}
          onChange={(event) => onPatch({ title: event.target.value })}
          placeholder="Optional heading"
          className="h-9 min-w-0 flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
        />
      </BuilderTopBarItem>
      <BuilderTopBarItem label="Limit">
        <input
          type="number"
          value={maxRows}
          onChange={(event) => onPatch({ max_rows: Number(event.target.value) })}
          className="h-9 w-20 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption"
        />
      </BuilderTopBarItem>
      <label className="flex min-h-9 items-center gap-1.5 text-caption text-text-secondary">
        <input
          type="checkbox"
          checked={showIndex}
          onChange={(event) => onPatch({ show_index: event.target.checked })}
          className="h-3.5 w-3.5"
        />
        Show row #
      </label>
      <label className="flex min-h-9 items-center gap-1.5 text-caption text-text-secondary">
        <input
          type="checkbox"
          checked={filtersFromView}
          onChange={(event) => onPatch({ filters_from_view: event.target.checked })}
          className="h-3.5 w-3.5"
        />
        Inherit filters
      </label>
    </BuilderTopBar>
  );
}

function ColumnTypeWarnings({
  selected,
  typesByName,
}: {
  selected: string[];
  typesByName: Map<string, string | undefined>;
}) {
  // Warn when a selected column no longer exists in the source (typo, rename, table switch).
  const missing = selected.filter((col) => !typesByName.has(col));
  if (missing.length === 0) return null;
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-tiny text-text-secondary">
      <b>Warning:</b> these selected columns don&apos;t exist on the current source:{' '}
      <code className="font-mono">{missing.join(', ')}</code>. Remove them or switch source.
    </div>
  );
}

// Column object editor

const FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Auto' },
  { value: 'integer', label: 'Integer (1,234)' },
  { value: 'number', label: 'Number (1,234.50)' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
  { value: 'text', label: 'Text (no formatting)' },
];

function ColumnObjectsEditor({
  available,
  selected,
  metadata,
  onChange,
}: {
  available: { name: string; type?: string }[];
  selected: string[];
  metadata: ColumnMetaMap;
  onChange: (nextSelected: string[], nextMetadata: ColumnMetaMap) => void;
}) {
  const [activeName, setActiveName] = useState<string | null>(selected[0] ?? null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const selectedSet = new Set(selected);
  const availableNotSelected = available.filter((c) => !selectedSet.has(c.name));
  const activeColumnName =
    activeName && selectedSet.has(activeName) ? activeName : selected[0] ?? null;
  const activeColumnType = activeColumnName
    ? available.find((column) => column.name === activeColumnName)?.type
    : undefined;
  const activeMeta = activeColumnName ? metadata[activeColumnName] || {} : null;

  const [query, setQuery] = useState('');
  const queryNorm = query.trim().toLowerCase();
  const addOptions = queryNorm
    ? availableNotSelected.filter(
        (c) => c.name.toLowerCase().includes(queryNorm),
      )
    : availableNotSelected;

  const addColumn = (name: string, type?: string) => {
    if (selectedSet.has(name)) return;
    const nextMeta = { ...metadata };
    // Seed a friendly default align based on type so new columns look right immediately.
    if (!nextMeta[name]) {
      nextMeta[name] = {
        align: isNumericType(type) ? 'right' : 'left',
      };
    }
    onChange([...selected, name], nextMeta);
    setActiveName(name);
  };

  const removeColumn = (name: string) => {
    const nextMeta = { ...metadata };
    delete nextMeta[name];
    const removeIndex = selected.indexOf(name);
    const nextSelected = selected.filter((c) => c !== name);
    onChange(nextSelected, nextMeta);
    if (activeColumnName === name) {
      setActiveName(nextSelected[Math.min(removeIndex, nextSelected.length - 1)] ?? null);
    }
  };

  const moveColumn = (from: number, to: number) => {
    if (from === to || to < 0 || to >= selected.length) return;
    const next = [...selected];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next, metadata);
  };

  const updateMeta = (name: string, patch: Partial<DataTableColumnMeta>) => {
    const nextMeta = { ...metadata, [name]: { ...(metadata[name] || {}), ...patch } };
    // Strip empty/default fields so saved JSON stays clean.
    const m = nextMeta[name];
    if (m.label === '') delete m.label;
    if (m.width_px == null) delete m.width_px;
    if (!m.format) delete m.format;
    if (!m.align) delete m.align;
    if (!m.total) delete m.total;
    if (!m.merge) delete m.merge;
    if (Object.keys(m).length === 0) delete nextMeta[name];
    onChange(selected, nextMeta);
  };

  const addAll = () => {
    if (availableNotSelected.length === 0) return;
    const nextMeta = { ...metadata };
    for (const c of availableNotSelected) {
      if (!nextMeta[c.name]) {
        nextMeta[c.name] = { align: isNumericType(c.type) ? 'right' : 'left' };
      }
    }
    onChange(
      [...selected, ...availableNotSelected.map((c) => c.name)],
      nextMeta,
    );
    if (!activeColumnName) setActiveName(availableNotSelected[0]?.name ?? null);
  };

  const clearAll = () => {
    if (selected.length === 0) return;
    onChange([], {});
    setActiveName(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find source column"
          disabled={availableNotSelected.length === 0}
          className="h-9 min-w-[180px] flex-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption disabled:cursor-not-allowed disabled:opacity-50"
        />
        <select
          aria-label="Add source column"
          value=""
          onChange={(event) => {
            const column = available.find((item) => item.name === event.target.value);
            if (column) {
              addColumn(column.name, column.type);
              setQuery('');
            }
          }}
          disabled={addOptions.length === 0}
          className="h-9 min-w-[180px] rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 text-caption disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">
            {availableNotSelected.length === 0 ? 'No source columns left' : 'Add column...'}
          </option>
          {addOptions.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
              {column.type ? ` (${column.type})` : ''}
            </option>
          ))}
        </select>
        <BuilderActionButton
          onClick={addAll}
          disabled={availableNotSelected.length === 0}
          className="h-9"
        >
          <Plus className="h-3.5 w-3.5" />
          Add all
        </BuilderActionButton>
        <BuilderActionButton
          onClick={clearAll}
          disabled={selected.length === 0}
          variant="danger"
          className="h-9"
        >
          Clear
        </BuilderActionButton>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(220px,0.9fr)_minmax(0,1.25fr)]">
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <span className="text-tiny font-emphasis text-text-secondary">
            Selected columns
          </span>
          <span className="text-tiny text-text-tertiary">{selected.length}</span>
        </div>
        <div className="max-h-[480px] overflow-y-auto p-1">
          {selected.length === 0 ? (
            <BuilderEmptyHint className="px-3 py-6">No columns selected.</BuilderEmptyHint>
          ) : (
            selected.map((name, idx) => {
              const type = available.find((c) => c.name === name)?.type;
              const meta = metadata[name] || {};
              const isActive = name === activeColumnName;
              return (
                <div
                  key={name}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIdx !== null) moveColumn(dragIdx, idx);
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  className={`group mb-1 flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors ${
                    isActive
                      ? 'border-brand/40 bg-brand/10'
                      : 'border-transparent hover:bg-surface-2'
                  }`}
                >
                    <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-quaternary" />
                    <button
                      type="button"
                      onClick={() => setActiveName(name)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="flex h-5 w-6 shrink-0 items-center justify-center rounded bg-surface-2 text-tiny text-text-tertiary">
                        {idx + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-caption font-medium text-text-primary">
                          {meta.label || name}
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-1 text-tiny text-text-tertiary">
                          {meta.label && meta.label !== name ? (
                            <span className="truncate">{name}</span>
                          ) : null}
                          {type ? <span>{type}</span> : null}
                          {meta.format ? <span>{meta.format}</span> : null}
                          {meta.total ? <span>{meta.total}</span> : null}
                          {meta.merge ? <span>merge</span> : null}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => moveColumn(idx, idx - 1)}
                        disabled={idx === 0}
                        title="Move up"
                        className="rounded p-1 text-text-tertiary hover:bg-surface-0 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveColumn(idx, idx + 1)}
                        disabled={idx === selected.length - 1}
                        title="Move down"
                        className="rounded p-1 text-text-tertiary hover:bg-surface-0 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeColumn(name)}
                        title="Remove"
                        className="rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                </div>
              );
            })
          )}
        </div>
      </div>
        <ColumnSettingsPanel
          name={activeColumnName}
          type={activeColumnType}
          meta={activeMeta}
          onUpdate={(patch) => activeColumnName && updateMeta(activeColumnName, patch)}
          onRemove={() => activeColumnName && removeColumn(activeColumnName)}
        />
      </div>
    </div>
  );
}

// ─── Pivot / Unpivot editor ──────────────────────────────────────────────

function ColumnSettingsPanel({
  name,
  type,
  meta,
  onUpdate,
  onRemove,
}: {
  name: string | null;
  type?: string;
  meta: DataTableColumnMeta | null;
  onUpdate: (patch: Partial<DataTableColumnMeta>) => void;
  onRemove: () => void;
}) {
  if (!name || !meta) {
    return (
      <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
        <BuilderEmptyHint className="px-3 py-8">No column selected.</BuilderEmptyHint>
      </div>
    );
  }

  const isNumeric = isNumericType(type);

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-caption font-emphasis text-text-primary">
            {meta.label || name}
          </h4>
          <p className="mt-0.5 truncate text-tiny text-text-tertiary">
            {name}
            {type ? ` - ${type}` : ''}
          </p>
        </div>
        <BuilderIconButton onClick={onRemove} title="Remove column" variant="danger">
          <X className="h-3.5 w-3.5 text-danger" />
        </BuilderIconButton>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Lbl label="Display label">
          <input
            value={meta.label ?? ''}
            onChange={(event) => onUpdate({ label: event.target.value })}
            placeholder={name}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Width (px)">
          <input
            type="number"
            value={meta.width_px ?? ''}
            onChange={(event) =>
              onUpdate({
                width_px: event.target.value ? Number(event.target.value) : null,
              })
            }
            placeholder="auto"
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Format">
          <select
            value={meta.format ?? ''}
            onChange={(event) => onUpdate({ format: event.target.value || null })}
            className={INPUT}
          >
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Lbl>
        <Lbl label="Align">
          <select
            value={meta.align ?? ''}
            onChange={(event) =>
              onUpdate({
                align: (event.target.value || null) as DataTableColumnMeta['align'],
              })
            }
            className={INPUT}
          >
            <option value="">Auto</option>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </Lbl>
        <Lbl label="Footer total">
          <select
            value={meta.total ?? ''}
            onChange={(event) =>
              onUpdate({
                total: (event.target.value || null) as DataTableColumnMeta['total'],
              })
            }
            className={INPUT}
          >
            <option value="">None</option>
            {isNumeric && <option value="sum">Sum</option>}
            {isNumeric && <option value="avg">Average</option>}
            <option value="count">Count</option>
            {isNumeric && <option value="min">Min</option>}
            {isNumeric && <option value="max">Max</option>}
          </select>
        </Lbl>
        <label className="flex min-h-9 items-center gap-2 self-end rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-caption text-text-secondary">
          <input
            type="checkbox"
            checked={!!meta.merge}
            onChange={(event) => onUpdate({ merge: event.target.checked })}
            className="h-3.5 w-3.5"
          />
          Merge equal cells
        </label>
      </div>
    </div>
  );
}

type UnpivotSpec = {
  kind: 'unpivot';
  id_columns?: string[];
  value_columns?: string[];
  var_name?: string;
  value_name?: string;
  drop_nulls?: boolean;
};

type PivotSpec = {
  kind: 'pivot';
  index?: string[];
  columns?: string | string[];
  values?: string;
  agg?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first';
  max_columns?: number;
  fill_value?: unknown;
};

function normPivotColumns(c: string | string[] | undefined): string[] {
  if (!c) return [];
  return Array.isArray(c) ? c : [c];
}

type TransformSpec = UnpivotSpec | PivotSpec;

function TransformEditor({
  sourceColumns,
  transform,
  onChange,
}: {
  sourceColumns: string[];
  transform: TransformSpec | null;
  onChange: (next: TransformSpec | null) => void;
}) {
  const kind: 'none' | 'unpivot' | 'pivot' = transform?.kind ?? 'none';

  const setKind = (next: 'none' | 'unpivot' | 'pivot') => {
    if (next === 'none') {
      onChange(null);
      return;
    }
    if (next === 'unpivot') {
      onChange({
        kind: 'unpivot',
        id_columns: [],
        value_columns: [],
        var_name: 'variable',
        value_name: 'value',
        drop_nulls: true,
      });
      return;
    }
    onChange({
      kind: 'pivot',
      index: [],
      columns: [],
      values: sourceColumns[0] ?? '',
      agg: 'sum',
      max_columns: 50,
    });
  };

  return (
    <div className="space-y-3">
      <Lbl label="Mode">
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as 'none' | 'unpivot' | 'pivot')
          }
          className={INPUT}
        >
          <option value="none">No transform</option>
          <option value="unpivot">Unpivot (wide → long)</option>
          <option value="pivot">Pivot (long → wide)</option>
        </select>
      </Lbl>

      {transform?.kind === 'unpivot' && (
        <div className="space-y-2">
          <Lbl label="Keep as identifier (id_columns)">
            {sourceColumns.length > 0 ? (
              <MultiColumnPicker
                sourceColumns={sourceColumns}
                value={transform.id_columns ?? []}
                onChange={(next) => onChange({ ...transform, id_columns: next })}
              />
            ) : (
              <input
                value={(transform.id_columns ?? []).join(', ')}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    id_columns: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className={INPUT}
              />
            )}
          </Lbl>
          <Lbl label="Columns to unpivot (value_columns)">
            {sourceColumns.length > 0 ? (
              <MultiColumnPicker
                sourceColumns={sourceColumns}
                value={transform.value_columns ?? []}
                onChange={(next) => onChange({ ...transform, value_columns: next })}
              />
            ) : (
              <input
                value={(transform.value_columns ?? []).join(', ')}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    value_columns: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className={INPUT}
              />
            )}
          </Lbl>
          <div className={BUILDER_GRID_3}>
            <Lbl label="Variable column name">
              <input
                value={transform.var_name ?? 'variable'}
                onChange={(event) =>
                  onChange({ ...transform, var_name: event.target.value })
                }
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Value column name">
              <input
                value={transform.value_name ?? 'value'}
                onChange={(event) =>
                  onChange({ ...transform, value_name: event.target.value })
                }
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Drop null cells?">
              <select
                value={transform.drop_nulls === false ? 'no' : 'yes'}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    drop_nulls: event.target.value === 'yes',
                  })
                }
                className={INPUT}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Lbl>
          </div>
        </div>
      )}

      {transform?.kind === 'pivot' && (
        <div className="space-y-2">
          <Lbl label="Index columns (group by)">
            {sourceColumns.length > 0 ? (
              <MultiColumnPicker
                sourceColumns={sourceColumns}
                value={transform.index ?? []}
                onChange={(next) => onChange({ ...transform, index: next })}
              />
            ) : (
              <input
                value={(transform.index ?? []).join(', ')}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    index: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className={INPUT}
              />
            )}
          </Lbl>
          <Lbl label="Header columns">
            <p className="mb-1 text-tiny text-text-tertiary">
              Pick 1 column for a flat pivot, or 2+ to build a two-level grouped header.
            </p>
            {sourceColumns.length > 0 ? (
              <MultiColumnPicker
                sourceColumns={sourceColumns}
                value={normPivotColumns(transform.columns)}
                onChange={(next) =>
                  onChange({ ...transform, columns: next.length === 1 ? next[0] : next })
                }
              />
            ) : (
              <input
                value={normPivotColumns(transform.columns).join(', ')}
                onChange={(event) => {
                  const arr = event.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  onChange({ ...transform, columns: arr.length === 1 ? arr[0] : arr });
                }}
                className={INPUT}
                placeholder="e.g. group, product_type"
              />
            )}
          </Lbl>
          <div className={BUILDER_GRID_3}>
            <Lbl label="Value column">
              <select
                value={transform.values ?? ''}
                onChange={(event) =>
                  onChange({ ...transform, values: event.target.value })
                }
                className={INPUT}
              >
                <option value="">Pick...</option>
                {sourceColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Aggregation">
              <select
                value={transform.agg ?? 'sum'}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    agg: event.target.value as PivotSpec['agg'],
                  })
                }
                className={INPUT}
              >
                <option value="sum">sum</option>
                <option value="avg">avg</option>
                <option value="min">min</option>
                <option value="max">max</option>
                <option value="count">count</option>
                <option value="first">first</option>
              </select>
            </Lbl>
            <Lbl label="Max pivot columns">
              <input
                type="number"
                min={1}
                max={200}
                value={Number(transform.max_columns ?? 50)}
                onChange={(event) =>
                  onChange({
                    ...transform,
                    max_columns: Math.max(1, Number(event.target.value) || 50),
                  })
                }
                className={INPUT}
              />
            </Lbl>
          </div>
          <p className="text-tiny text-text-tertiary">
            Pivot runs in memory over at most <b>max_rows</b> fetched rows. Distinct values
            in the header column above <b>max pivot columns</b> will return error 422.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Signature editor ───────────────────────────────────────────────────

function SignatureEditor({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  const slots =
    (((block as { slots?: Array<{ label: string; role?: string }> }).slots) || []) as Array<{
      label: string;
      role?: string;
    }>;

  const updateSlot = (idx: number, patch: Partial<{ label: string; role?: string }>) => {
    const next = [...slots];
    next[idx] = { ...next[idx], ...patch };
    onChange({ slots: next });
  };

  return (
    <div className="space-y-2">
      {slots.map((slot, idx) => (
        <div
          key={idx}
          className="wb-row-static-value rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2"
        >
          <input
            value={slot.label}
            onChange={(event) => updateSlot(idx, { label: event.target.value })}
            placeholder="Label (e.g. Accountant)"
            className={INPUT}
          />
          <input
            value={slot.role || ''}
            onChange={(event) => updateSlot(idx, { role: event.target.value })}
            placeholder="Role (optional)"
            className={INPUT}
          />
          <BuilderIconButton
            onClick={() => onChange({ slots: slots.filter((_, index) => index !== idx) })}
            title="Delete slot"
            variant="danger"
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </BuilderIconButton>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <BuilderActionButton
          onClick={() => onChange({ slots: [...slots, { label: '', role: '' }] })}
        >
          <Plus className="h-3.5 w-3.5" />
          Add slot
        </BuilderActionButton>
        {slots.length === 0 && (
          <BuilderActionButton
            onClick={() =>
              onChange({
                slots: [
                  { label: 'Prepared by', role: '' },
                  { label: 'Accountant', role: '' },
                  { label: 'Warehouse keeper', role: '' },
                  { label: 'Director', role: '' },
                ],
              })
            }
          >
            Add 4 common slots
          </BuilderActionButton>
        )}
      </div>
    </div>
  );
}

// ─── Column groups + totals editors (unchanged behaviour) ───────────────

function buildColumnSlice(columns: string[], start: string, end: string): string[] {
  const startIndex = columns.indexOf(start);
  const endIndex = columns.indexOf(end);
  if (startIndex < 0 || endIndex < 0) return [];
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  return columns.slice(from, to + 1);
}

function ColumnGroupsEditor({
  selectedColumns,
  groups,
  onChange,
}: {
  selectedColumns: string[];
  groups: Array<{ label?: string; columns?: string[] }>;
  onChange: (next: Array<{ label: string; columns: string[] }>) => void;
}) {
  const updateGroup = (
    idx: number,
    patch: Partial<{ label: string; columns: string[] }>,
  ) => {
    const next = groups.map((group) => ({
      label: String(group.label || ''),
      columns: Array.isArray(group.columns) ? [...group.columns] : [],
    }));
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const addGroup = () => {
    if (selectedColumns.length < 2) return;
    onChange([
      ...groups.map((group) => ({
        label: String(group.label || ''),
        columns: Array.isArray(group.columns) ? [...group.columns] : [],
      })),
      {
        label: `Group ${groups.length + 1}`,
        columns: selectedColumns.slice(0, 2),
      },
    ]);
  };

  return (
    <BuilderSubsection
      title="Header groups"
      description="Each group spans a contiguous slice of columns to build a 2-level header."
      action={
        <BuilderActionButton
          onClick={addGroup}
          disabled={selectedColumns.length < 2}
        >
          <Plus className="h-3.5 w-3.5" />
          Add group
        </BuilderActionButton>
      }
    >
      {groups.length === 0 ? (
        <p className="text-tiny text-text-tertiary">
          No groups yet. Pick at least 2 display columns to create a grouped header.
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map((group, idx) => {
            const columns = Array.isArray(group.columns) ? group.columns : [];
            const start = columns[0] || selectedColumns[0] || '';
            const end = columns[columns.length - 1] || selectedColumns[1] || start;
            const preview = columns.join(' | ');
            return (
              <div
                key={idx}
                className="wb-row-doc-col rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3"
              >
                <input
                  value={String(group.label || '')}
                  onChange={(event) => updateGroup(idx, { label: event.target.value })}
                  placeholder="Group name"
                  className={INPUT}
                />
                <select
                  value={start}
                  onChange={(event) =>
                    updateGroup(idx, {
                      columns: buildColumnSlice(selectedColumns, event.target.value, end),
                    })
                  }
                  className={INPUT}
                >
                  {selectedColumns.map((column) => (
                    <option key={column} value={column}>
                      From: {column}
                    </option>
                  ))}
                </select>
                <select
                  value={end}
                  onChange={(event) =>
                    updateGroup(idx, {
                      columns: buildColumnSlice(selectedColumns, start, event.target.value),
                    })
                  }
                  className={INPUT}
                >
                  {selectedColumns.map((column) => (
                    <option key={column} value={column}>
                      To: {column}
                    </option>
                  ))}
                </select>
                <BuilderIconButton
                  onClick={() => onChange(groups.filter((_, index) => index !== idx) as Array<{ label: string; columns: string[] }>)}
                  title="Delete group"
                  variant="danger"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
                <div className="col-span-4 text-tiny text-text-tertiary">
                  Covers: {preview || '(invalid range)'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </BuilderSubsection>
  );
}
