/**
 * ListScreenEditor — column picker + filters + row actions.
 */
'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import type { ListFilterSpec, ScreenAction, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface Props {
  screen: ScreenSpec;
  allScreens: ScreenSpec[];
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}

export default function ListScreenEditor({ screen, allScreens, tables, onChange }: Props) {
  const list = screen.list || { columns: [] };
  const tableCols = tables.find((t) => t.id === screen.table_id)?.columns ?? [];

  const updateList = (patch: Partial<NonNullable<ScreenSpec['list']>>) =>
    onChange({ ...screen, list: { ...list, ...patch } });

  const toggleCol = (col: string) => {
    const has = list.columns.includes(col);
    updateList({
      columns: has ? list.columns.filter((c) => c !== col) : [...list.columns, col],
    });
  };

  const addFilter = () =>
    updateList({
      filters: [
        ...(list.filters || []),
        { column: tableCols[0]?.name || '', kind: 'text', label: '' },
      ],
    });
  const updateFilter = (idx: number, patch: Partial<ListFilterSpec>) => {
    const next = [...(list.filters || [])];
    next[idx] = { ...next[idx], ...patch };
    updateList({ filters: next });
  };
  const removeFilter = (idx: number) =>
    updateList({ filters: (list.filters || []).filter((_, i) => i !== idx) });

  const addAction = () =>
    updateList({
      row_actions: [
        ...(list.row_actions || []),
        {
          id: `action-${Date.now().toString(36)}`,
          label: 'Mở',
          go_to_screen: null,
          carry: [],
        },
      ],
    });
  const updateAction = (idx: number, patch: Partial<ScreenAction>) => {
    const next = [...(list.row_actions || [])];
    next[idx] = { ...next[idx], ...patch };
    updateList({ row_actions: next });
  };
  const removeAction = (idx: number) =>
    updateList({ row_actions: (list.row_actions || []).filter((_, i) => i !== idx) });

  return (
    <>
      {/* Columns picker */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
          Cột hiển thị ({list.columns.length})
        </h2>
        {tableCols.length === 0 ? (
          <p className="text-tiny text-text-tertiary">
            Chưa chọn bảng dữ liệu hoặc bảng không có cột nào.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {tableCols.map((c) => (
              <label
                key={c.name}
                className="flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1.5 text-caption hover:border-brand"
              >
                <input
                  type="checkbox"
                  checked={list.columns.includes(c.name)}
                  onChange={() => toggleCol(c.name)}
                  className="h-3 w-3"
                />
                <span className="truncate">{c.name}</span>
                {c.type && <span className="text-tiny text-text-tertiary">{c.type}</span>}
              </label>
            ))}
          </div>
        )}
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Lbl label="Page size">
            <input
              type="number"
              value={list.page_size ?? 50}
              onChange={(e) => updateList({ page_size: Number(e.target.value) })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Sắp xếp theo">
            <select
              value={list.default_sort_column || ''}
              onChange={(e) => updateList({ default_sort_column: e.target.value || null })}
              className={INPUT}
            >
              <option value="">— không —</option>
              {tableCols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Lbl>
          <Lbl label="Hướng">
            <select
              value={list.default_sort_direction || 'desc'}
              onChange={(e) =>
                updateList({ default_sort_direction: e.target.value as 'asc' | 'desc' })
              }
              className={INPUT}
            >
              <option value="desc">Giảm dần</option>
              <option value="asc">Tăng dần</option>
            </select>
          </Lbl>
          <Lbl label="Empty state message">
            <input
              value={list.empty_state_message || ''}
              onChange={(e) => updateList({ empty_state_message: e.target.value })}
              className={INPUT}
              placeholder="vd: Chưa có dữ liệu nào."
            />
          </Lbl>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
            Filter ({(list.filters || []).length})
          </h2>
          <button
            onClick={addFilter}
            className="flex items-center gap-1 rounded-md border border-brand px-2 py-1 text-tiny text-brand hover:bg-brand/10"
          >
            <Plus className="h-3 w-3" />
            Thêm filter
          </button>
        </div>
        <div className="space-y-1.5">
          {(list.filters || []).map((f, idx) => (
            <div key={idx} className="flex gap-1.5">
              <select
                value={f.column}
                onChange={(e) => updateFilter(idx, { column: e.target.value })}
                className={`${INPUT} flex-1`}
              >
                {tableCols.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={f.kind}
                onChange={(e) =>
                  updateFilter(idx, { kind: e.target.value as ListFilterSpec['kind'] })
                }
                className={INPUT}
                style={{ width: 130 }}
              >
                <option value="text">text</option>
                <option value="select">select</option>
                <option value="date_range">date_range</option>
                <option value="number_range">number_range</option>
              </select>
              <input
                value={f.label || ''}
                onChange={(e) => updateFilter(idx, { label: e.target.value })}
                placeholder="Label hiển thị"
                className={`${INPUT} flex-1`}
              />
              <button
                onClick={() => removeFilter(idx)}
                className="rounded p-1 hover:bg-danger/10"
              >
                <Trash2 className="h-3 w-3 text-danger" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Row actions */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
            Hành động trên mỗi dòng ({(list.row_actions || []).length})
          </h2>
          <button
            onClick={addAction}
            className="flex items-center gap-1 rounded-md border border-brand px-2 py-1 text-tiny text-brand hover:bg-brand/10"
          >
            <Plus className="h-3 w-3" />
            Thêm action
          </button>
        </div>
        <div className="space-y-2">
          {(list.row_actions || []).map((a, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
            >
              <input
                value={a.label}
                onChange={(e) => updateAction(idx, { label: e.target.value })}
                placeholder="Nhãn nút"
                className={`${INPUT} col-span-3`}
              />
              <select
                value={a.go_to_screen || ''}
                onChange={(e) =>
                  updateAction(idx, { go_to_screen: e.target.value || null })
                }
                className={`${INPUT} col-span-4`}
              >
                <option value="">— Chọn screen đích —</option>
                {allScreens
                  .filter((s) => s.id !== screen.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} ({s.id})
                    </option>
                  ))}
              </select>
              <input
                value={(a.carry || []).join(', ')}
                onChange={(e) =>
                  updateAction(idx, {
                    carry: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Cột truyền sang (vd: shift_id)"
                className={`${INPUT} col-span-4`}
              />
              <button
                onClick={() => removeAction(idx)}
                className="col-span-1 rounded p-1 hover:bg-danger/10"
              >
                <Trash2 className="mx-auto h-3 w-3 text-danger" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
