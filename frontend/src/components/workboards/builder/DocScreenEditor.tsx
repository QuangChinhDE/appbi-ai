/**
 * DocScreenEditor — block editor for doc screens.
 *
 * Each block kind has a small inline editor. The most important is
 * `data_table` because that's what carries `group_by` (merge cells) and
 * `totals` (footer aggregates).
 */
'use client';

import React from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import type { DocBlockSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

const BLOCK_KINDS: DocBlockSpec['type'][] = [
  'header',
  'kv_grid',
  'data_table',
  'text',
  'spacer',
  'signature',
  'footer',
];

export default function DocScreenEditor({
  screen,
  tables,
  onChange,
}: {
  screen: ScreenSpec;
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}) {
  const doc = screen.doc || { blocks: [] };
  const blocks = doc.blocks || [];

  const updateDoc = (patch: Partial<NonNullable<ScreenSpec['doc']>>) =>
    onChange({ ...screen, doc: { ...doc, ...patch } });
  const updateBlock = (idx: number, patch: Partial<DocBlockSpec>) => {
    const next = [...blocks];
    next[idx] = { ...next[idx], ...patch };
    updateDoc({ blocks: next });
  };
  const moveBlock = (idx: number, dir: -1 | 1) => {
    const next = [...blocks];
    const t = idx + dir;
    if (t < 0 || t >= next.length) return;
    [next[idx], next[t]] = [next[t], next[idx]];
    updateDoc({ blocks: next });
  };
  const removeBlock = (idx: number) =>
    updateDoc({ blocks: blocks.filter((_, i) => i !== idx) });
  const addBlock = (type: DocBlockSpec['type']) => {
    const fresh: DocBlockSpec =
      type === 'header'
        ? { type, title: 'Tiêu đề', subtitle: '', align: 'center' }
        : type === 'kv_grid'
        ? { type, columns: 4, items: [{ label: 'Label', value: 'Value' }] }
        : type === 'data_table'
        ? {
            type,
            source: 'primary',
            columns: [],
            filters_from_view: false,
            totals: [],
            group_by: [],
            max_rows: 200,
            show_index: false,
            title: '',
          }
        : type === 'text'
        ? { type, content: '', align: 'left' }
        : type === 'spacer'
        ? { type, height_mm: 4 }
        : type === 'signature'
        ? { type, slots: [{ label: 'Tổ trưởng', role: '' }] }
        : { type: 'footer', left: '', center: '', right: '' };
    updateDoc({ blocks: [...blocks, fresh] });
  };

  return (
    <>
      {/* Page settings */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
          Cấu hình trang in
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <Lbl label="Khổ giấy">
            <select
              value={(doc.page?.size as string) || 'A4'}
              onChange={(e) =>
                updateDoc({ page: { ...(doc.page || {}), size: e.target.value as any } })
              }
              className={INPUT}
            >
              <option>A4</option>
              <option>A3</option>
              <option>Letter</option>
            </select>
          </Lbl>
          <Lbl label="Hướng">
            <select
              value={(doc.page?.orientation as string) || 'portrait'}
              onChange={(e) =>
                updateDoc({
                  page: { ...(doc.page || {}), orientation: e.target.value as any },
                })
              }
              className={INPUT}
            >
              <option value="portrait">Dọc</option>
              <option value="landscape">Ngang</option>
            </select>
          </Lbl>
          <Lbl label="Lề (mm)">
            <input
              type="number"
              value={doc.page?.margin_mm ?? 15}
              onChange={(e) =>
                updateDoc({ page: { ...(doc.page || {}), margin_mm: Number(e.target.value) } })
              }
              className={INPUT}
            />
          </Lbl>
        </div>
      </div>

      {/* Blocks */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
            Blocks ({blocks.length})
          </h2>
          <div className="flex gap-1">
            {BLOCK_KINDS.map((k) => (
              <button
                key={k}
                onClick={() => addBlock(k)}
                className="rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-tiny hover:border-brand hover:text-brand"
              >
                + {k}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {blocks.map((b, idx) => (
            <BlockRow
              key={idx}
              block={b}
              tables={tables}
              isFirst={idx === 0}
              isLast={idx === blocks.length - 1}
              onChange={(patch) => updateBlock(idx, patch)}
              onMoveUp={() => moveBlock(idx, -1)}
              onMoveDown={() => moveBlock(idx, 1)}
              onRemove={() => removeBlock(idx)}
            />
          ))}
          {blocks.length === 0 && (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-4 text-center text-caption text-text-tertiary">
              Chưa có block nào — bấm "+ block kind" để thêm.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function BlockRow({
  block,
  tables,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  block: DocBlockSpec;
  tables: DatasetTableInfo[];
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<DocBlockSpec>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-surface-2 px-2 py-0.5 text-tiny font-emphasis text-text-secondary">
          {block.type}
        </span>
        <div className="flex">
          {!isFirst && (
            <button onClick={onMoveUp} className="rounded p-0.5 hover:bg-surface-2">
              <ArrowUp className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          {!isLast && (
            <button onClick={onMoveDown} className="rounded p-0.5 hover:bg-surface-2">
              <ArrowDown className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          <button onClick={onRemove} className="rounded p-0.5 hover:bg-danger/10">
            <Trash2 className="h-3 w-3 text-danger" />
          </button>
        </div>
      </div>

      {block.type === 'header' && (
        <div className="grid grid-cols-3 gap-2">
          <Lbl label="Title">
            <input
              value={String(block.title ?? '')}
              onChange={(e) => onChange({ title: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Subtitle">
            <input
              value={String(block.subtitle ?? '')}
              onChange={(e) => onChange({ subtitle: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Align">
            <select
              value={String(block.align ?? 'center')}
              onChange={(e) => onChange({ align: e.target.value })}
              className={INPUT}
            >
              <option value="left">Trái</option>
              <option value="center">Giữa</option>
              <option value="right">Phải</option>
            </select>
          </Lbl>
        </div>
      )}

      {block.type === 'text' && (
        <Lbl label="Nội dung">
          <textarea
            value={String(block.content ?? '')}
            onChange={(e) => onChange({ content: e.target.value })}
            rows={2}
            className={INPUT}
          />
        </Lbl>
      )}

      {block.type === 'spacer' && (
        <Lbl label="Height (mm)">
          <input
            type="number"
            value={Number(block.height_mm ?? 4)}
            onChange={(e) => onChange({ height_mm: Number(e.target.value) })}
            className={INPUT}
          />
        </Lbl>
      )}

      {block.type === 'kv_grid' && (
        <KvGridEditor block={block} onChange={onChange} />
      )}

      {block.type === 'data_table' && (
        <DataTableEditor block={block} tables={tables} onChange={onChange} />
      )}

      {block.type === 'footer' && (
        <div className="grid grid-cols-3 gap-2">
          {(['left', 'center', 'right'] as const).map((side) => (
            <Lbl key={side} label={side}>
              <input
                value={String(block[side] ?? '')}
                onChange={(e) => onChange({ [side]: e.target.value } as any)}
                className={INPUT}
              />
            </Lbl>
          ))}
        </div>
      )}
    </div>
  );
}

function KvGridEditor({
  block,
  onChange,
}: {
  block: DocBlockSpec;
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  const items =
    (block.items as Array<{ label: string; value: string }>) || [];
  const cols = Number(block.columns ?? 2);
  const update = (idx: number, patch: Partial<{ label: string; value: string }>) => {
    const next = [...items];
    next[idx] = { ...next[idx], ...patch };
    onChange({ items: next });
  };
  return (
    <div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Lbl label="Số cột">
          <input
            type="number"
            value={cols}
            onChange={(e) => onChange({ columns: Number(e.target.value) })}
            className={INPUT}
          />
        </Lbl>
      </div>
      <div className="space-y-1">
        {items.map((it, idx) => (
          <div key={idx} className="flex gap-1">
            <input
              value={it.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              placeholder="Label"
              className={`${INPUT} flex-1`}
            />
            <input
              value={it.value}
              onChange={(e) => update(idx, { value: e.target.value })}
              placeholder="Value (hỗ trợ {{app_user.x}} / {{today}})"
              className={`${INPUT} flex-1`}
            />
            <button
              onClick={() => onChange({ items: items.filter((_, i) => i !== idx) })}
              className="rounded p-1 hover:bg-danger/10"
            >
              <Trash2 className="h-3 w-3 text-danger" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange({ items: [...items, { label: '', value: '' }] })}
        className="mt-1 flex items-center gap-1 text-tiny text-brand hover:underline"
      >
        <Plus className="h-3 w-3" />
        Thêm cell
      </button>
    </div>
  );
}

function DataTableEditor({
  block,
  tables,
  onChange,
}: {
  block: DocBlockSpec;
  tables: DatasetTableInfo[];
  onChange: (patch: Partial<DocBlockSpec>) => void;
}) {
  const source = String(block.source || 'primary');
  const sourceTableId =
    source === 'primary'
      ? null
      : source.startsWith('lookup:')
      ? Number(source.split(':')[1])
      : null;
  const sourceTable = tables.find((t) => t.id === sourceTableId);
  // For "primary" we don't know the table — let user free-type columns; for
  // lookup we show the actual table's columns as checkboxes.
  const tableCols = sourceTable?.columns || [];

  const cols = (block.columns as string[]) || [];
  const groupBy = (block.group_by as string[]) || [];
  const totals = (block.totals as string[]) || [];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Lbl label="Source">
          <select
            value={source.startsWith('lookup:') ? 'lookup' : source}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'primary') onChange({ source: 'primary' });
              else if (tables[0]) onChange({ source: `lookup:${tables[0].id}` });
            }}
            className={INPUT}
          >
            <option value="primary">primary (bảng của screen)</option>
            <option value="lookup">lookup (bảng khác)</option>
          </select>
        </Lbl>
        {source.startsWith('lookup:') && (
          <Lbl label="Bảng lookup">
            <select
              value={sourceTableId ?? ''}
              onChange={(e) => onChange({ source: `lookup:${e.target.value}` })}
              className={INPUT}
            >
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </Lbl>
        )}
        <Lbl label="Title">
          <input
            value={String(block.title ?? '')}
            onChange={(e) => onChange({ title: e.target.value })}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Max rows">
          <input
            type="number"
            value={Number(block.max_rows ?? 200)}
            onChange={(e) => onChange({ max_rows: Number(e.target.value) })}
            className={INPUT}
          />
        </Lbl>
      </div>

      <div>
        <div className="mb-1 text-tiny font-emphasis text-text-secondary">
          Cột hiển thị
        </div>
        {tableCols.length > 0 ? (
          <div className="grid grid-cols-3 gap-1">
            {tableCols.map((c) => (
              <label
                key={c.name}
                className="flex items-center gap-1.5 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-tiny"
              >
                <input
                  type="checkbox"
                  checked={cols.includes(c.name)}
                  onChange={() => {
                    const has = cols.includes(c.name);
                    onChange({
                      columns: has ? cols.filter((x) => x !== c.name) : [...cols, c.name],
                    });
                  }}
                  className="h-3 w-3"
                />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <input
            value={cols.join(', ')}
            onChange={(e) =>
              onChange({
                columns: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="Tên cột ngăn cách bằng dấu phẩy"
            className={INPUT}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Lbl label="Merge cells theo cột (group_by)">
          <input
            value={groupBy.join(', ')}
            onChange={(e) =>
              onChange({
                group_by: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="vd: shift_id, worker_username"
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Tổng (footer): col:sum / col:count / col:avg / col:min / col:max">
          <input
            value={totals.join(', ')}
            onChange={(e) =>
              onChange({
                totals: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="vd: produced_qty:sum, defect_qty:sum"
            className={INPUT}
          />
        </Lbl>
      </div>
    </div>
  );
}
