/**
 * ListScreenEditor - cột hiển thị + filter + hành động trên dòng.
 */
'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

import {
  BUILDER_GRID_3,
  BuilderActionButton,
  BuilderIconButton,
  BuilderSection,
  DataSourcePicker,
} from './BuilderChrome';
import { CheckboxMultiSelect } from './BuilderValueControls';
import type { ListFilterSpec, ScreenAction, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';
import type { BuilderMode } from './useBuilderMode';

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
  mode: BuilderMode;
}

const FILTER_KIND_LABEL: Record<ListFilterSpec['kind'], string> = {
  text: 'Tìm theo văn bản',
  select: 'Chọn 1 giá trị',
  date_range: 'Khoảng ngày',
  number_range: 'Khoảng số',
};

export default function ListScreenEditor({
  screen,
  allScreens,
  tables,
  onChange,
  mode,
}: Props) {
  const list = screen.list || { columns: [] };
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];
  const columnOptions = tableCols.map((column) => ({
    value: column.name,
    label: column.name,
    description: column.type,
  }));

  const updateList = (patch: Partial<NonNullable<ScreenSpec['list']>>) =>
    onChange({ ...screen, list: { ...list, ...patch } });

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
    updateList({ filters: (list.filters || []).filter((_, index) => index !== idx) });

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
    updateList({ row_actions: (list.row_actions || []).filter((_, index) => index !== idx) });

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      <BuilderSection
        title={`Cột hiển thị (${list.columns.length})`}
        description="Chọn các cột bạn muốn hiển thị trên danh sách."
      >
        {tableCols.length === 0 ? (
          <p className="text-tiny text-text-tertiary">
            Chưa chọn bảng dữ liệu hoặc bảng không có cột nào.
          </p>
        ) : (
          <CheckboxMultiSelect
            options={columnOptions}
            selectedValues={list.columns}
            onChange={(columns) => updateList({ columns })}
            columns={3}
          />
        )}

        <div className={`mt-4 ${BUILDER_GRID_3}`}>
          <Lbl label="Số dòng / trang">
            <input
              type="number"
              value={list.page_size ?? 50}
              onChange={(event) => updateList({ page_size: Number(event.target.value) })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Sắp xếp theo">
            <select
              value={list.default_sort_column || ''}
              onChange={(event) =>
                updateList({ default_sort_column: event.target.value || null })
              }
              className={INPUT}
            >
              <option value="">— không —</option>
              {tableCols.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
          </Lbl>
          <Lbl label="Hướng">
            <select
              value={list.default_sort_direction || 'desc'}
              onChange={(event) =>
                updateList({
                  default_sort_direction: event.target.value as 'asc' | 'desc',
                })
              }
              className={INPUT}
            >
              <option value="desc">Giảm dần</option>
              <option value="asc">Tăng dần</option>
            </select>
          </Lbl>
          {mode === 'advanced' && (
            <Lbl label="Thông báo khi rỗng">
              <input
                value={list.empty_state_message || ''}
                onChange={(event) => updateList({ empty_state_message: event.target.value })}
                className={INPUT}
                placeholder="vd: Chưa có dữ liệu nào."
              />
            </Lbl>
          )}
        </div>
      </BuilderSection>

      <BuilderSection
        title={`Bộ lọc (${(list.filters || []).length})`}
        description="Bộ lọc hiển thị phía trên danh sách để user lọc nhanh."
        action={
          <BuilderActionButton variant="brand" onClick={addFilter}>
            <Plus className="h-3.5 w-3.5" />
            Thêm bộ lọc
          </BuilderActionButton>
        }
      >
        <div className="space-y-2">
          {(list.filters || []).map((filter, idx) => (
            <div
              key={idx}
              className="wb-row-filter rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
            >
              <select
                value={filter.column}
                onChange={(event) => updateFilter(idx, { column: event.target.value })}
                className={INPUT}
              >
                {tableCols.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
              <select
                value={filter.kind}
                onChange={(event) =>
                  updateFilter(idx, {
                    kind: event.target.value as ListFilterSpec['kind'],
                  })
                }
                className={INPUT}
              >
                {(Object.keys(FILTER_KIND_LABEL) as ListFilterSpec['kind'][]).map((kind) => (
                  <option key={kind} value={kind}>
                    {FILTER_KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
              <input
                value={filter.label || ''}
                onChange={(event) => updateFilter(idx, { label: event.target.value })}
                placeholder="Nhãn hiển thị"
                className={INPUT}
              />
              <BuilderIconButton
                onClick={() => removeFilter(idx)}
                title="Xoá"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
          {(list.filters || []).length === 0 && (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-3 text-center text-tiny text-text-tertiary">
              Chưa có bộ lọc nào.
            </p>
          )}
        </div>
      </BuilderSection>

      <BuilderSection
        title={`Hành động trên mỗi dòng (${(list.row_actions || []).length})`}
        description="Mỗi dòng có thể có 1 hoặc nhiều nút (vd: Mở chi tiết, Sửa, Xoá)."
        action={
          <BuilderActionButton variant="brand" onClick={addAction}>
            <Plus className="h-3.5 w-3.5" />
            Thêm hành động
          </BuilderActionButton>
        }
      >
        <div className="space-y-2">
          {(list.row_actions || []).map((action, idx) => (
            <div
              key={idx}
              className="wb-row-action rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-3"
            >
              <input
                value={action.label}
                onChange={(event) => updateAction(idx, { label: event.target.value })}
                placeholder="Nhãn nút"
                className={INPUT}
              />
              <select
                value={action.go_to_screen || ''}
                onChange={(event) =>
                  updateAction(idx, { go_to_screen: event.target.value || null })
                }
                className={INPUT}
              >
                <option value="">— chọn màn đích —</option>
                {allScreens
                  .filter((item) => item.id !== screen.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
              <div>
                {columnOptions.length > 0 ? (
                  <CheckboxMultiSelect
                    options={columnOptions}
                    selectedValues={action.carry || []}
                    onChange={(carry) => updateAction(idx, { carry })}
                    columns={2}
                  />
                ) : (
                  <input
                    value={(action.carry || []).join(', ')}
                    onChange={(event) =>
                      updateAction(idx, {
                        carry: event.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Cột truyền sang"
                    className={INPUT}
                  />
                )}
              </div>
              <BuilderIconButton
                onClick={() => removeAction(idx)}
                title="Xoá"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
          {(list.row_actions || []).length === 0 && (
            <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-3 text-center text-tiny text-text-tertiary">
              Chưa có hành động nào.
            </p>
          )}
        </div>
      </BuilderSection>
    </div>
  );
}
