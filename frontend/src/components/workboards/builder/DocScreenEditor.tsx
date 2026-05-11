/**
 * DocScreenEditor - block editor for report/doc screens.
 */
'use client';

import React from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import {
  CheckboxMultiSelect,
  FixedExpressionInput,
  type SelectOption,
} from './BuilderValueControls';
import {
  BUILDER_GRID_2,
  BUILDER_GRID_3,
  BuilderActionButton,
  BuilderIconButton,
  BuilderSection,
  BuilderSubsection,
} from './BuilderChrome';
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

const DOC_EXPRESSION_OPTIONS: SelectOption[] = [
  { value: '{{workboard.name}}', label: 'Workboard > Name' },
  { value: '{{app_user.username}}', label: 'App user > Username' },
  { value: '{{app_user.full_name}}', label: 'App user > Full name' },
  { value: '{{today}}', label: 'System > Today' },
  { value: '{{now}}', label: 'System > Now' },
];

type TotalAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';

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
  };

  const removeBlock = (idx: number) =>
    updateDoc({ blocks: blocks.filter((_, index) => index !== idx) });

  const addBlock = (type: DocBlockSpec['type']) => {
    const fresh: DocBlockSpec =
      type === 'header'
        ? { type, title: 'Tieu de', subtitle: '', align: 'center' }
        : type === 'kv_grid'
        ? { type, columns: 4, items: [{ label: 'Label', value: 'Value' }] }
        : type === 'data_table'
        ? {
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
          }
        : type === 'text'
        ? { type, content: '', align: 'left' }
        : type === 'spacer'
        ? { type, height_mm: 4 }
        : type === 'signature'
        ? { type, slots: [{ label: 'To truong', role: '' }] }
        : { type: 'footer', left: '', center: '', right: '' };
    updateDoc({ blocks: [...blocks, fresh] });
  };

  return (
    <>
      <BuilderSection
        title="Cấu hình trang in"
        description="Khổ giấy, hướng và lề khi in/ xuất PDF."
      >
        <div className={BUILDER_GRID_3}>
          <Lbl label="Khổ giấy">
            <select
              value={String(doc.page?.size || 'A4')}
              onChange={(event) =>
                updateDoc({
                  page: { ...(doc.page || {}), size: event.target.value as 'A4' | 'A3' | 'Letter' },
                })
              }
              className={INPUT}
            >
              <option value="A4">A4</option>
              <option value="A3">A3</option>
              <option value="Letter">Letter</option>
            </select>
          </Lbl>
          <Lbl label="Hướng">
            <select
              value={String(doc.page?.orientation || 'portrait')}
              onChange={(event) =>
                updateDoc({
                  page: {
                    ...(doc.page || {}),
                    orientation: event.target.value as 'portrait' | 'landscape',
                  },
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
              onChange={(event) =>
                updateDoc({
                  page: { ...(doc.page || {}), margin_mm: Number(event.target.value) },
                })
              }
              className={INPUT}
            />
          </Lbl>
        </div>
      </BuilderSection>

      <BuilderSection
        title={`Khối hiển thị (${blocks.length})`}
        description="Mỗi khối là một phần của document (tiêu đề, KPI, bảng số liệu, chữ ký, …)."
        action={
          <div className="flex flex-wrap gap-2">
            {BLOCK_KINDS.map((kind) => (
              <BuilderActionButton
                key={kind}
                onClick={() => addBlock(kind)}
              >
                + {kind}
              </BuilderActionButton>
            ))}
          </div>
        }
      >
        <div className="space-y-2">
          {blocks.map((block, idx) => (
            <BlockRow
              key={idx}
              block={block}
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
              Chưa có khối nào — bấm nút &quot;+&quot; ở trên để thêm.
            </p>
          )}
        </div>
      </BuilderSection>
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
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="rounded bg-surface-2 px-2 py-0.5 text-tiny font-emphasis text-text-secondary">
          {block.type}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {!isFirst && (
            <BuilderIconButton onClick={onMoveUp} title="Lên">
              <ArrowUp className="h-3.5 w-3.5" />
            </BuilderIconButton>
          )}
          {!isLast && (
            <BuilderIconButton onClick={onMoveDown} title="Xuống">
              <ArrowDown className="h-3.5 w-3.5" />
            </BuilderIconButton>
          )}
          <BuilderIconButton onClick={onRemove} title="Xoá khối" variant="danger">
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </BuilderIconButton>
        </div>
      </div>

      {block.type === 'header' && (
        <div className={BUILDER_GRID_3}>
          <Lbl label="Tiêu đề">
            <input
              value={String(block.title ?? '')}
              onChange={(event) => onChange({ title: event.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Phụ đề">
            <input
              value={String(block.subtitle ?? '')}
              onChange={(event) => onChange({ subtitle: event.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Căn lề">
            <select
              value={String(block.align ?? 'center')}
              onChange={(event) => onChange({ align: event.target.value })}
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
            onChange={(event) => onChange({ content: event.target.value })}
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
            onChange={(event) => onChange({ height_mm: Number(event.target.value) })}
            className={INPUT}
          />
        </Lbl>
      )}

      {block.type === 'kv_grid' && <KvGridEditor block={block} onChange={onChange} />}
      {block.type === 'data_table' && (
        <DataTableEditor block={block} tables={tables} onChange={onChange} />
      )}

      {block.type === 'signature' && (
        <SignatureEditor block={block} onChange={onChange} />
      )}

      {block.type === 'footer' && (
        <div className={BUILDER_GRID_3}>
          {(['left', 'center', 'right'] as const).map((side) => (
            <Lbl key={side} label={side}>
              <input
                value={String(block[side] ?? '')}
                onChange={(event) => onChange({ [side]: event.target.value } as Partial<DocBlockSpec>)}
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
    <div>
      <div className={BUILDER_GRID_2}>
        <Lbl label="So cot">
          <input
            type="number"
            value={columns}
            onChange={(event) => onChange({ columns: Number(event.target.value) })}
            className={INPUT}
          />
        </Lbl>
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div
            key={idx}
            className="wb-row-key-value rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2"
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
              fixedPlaceholder="Gia tri co dinh"
              expressionPlaceholder="{{today}} hoac placeholder"
              expressionOptions={DOC_EXPRESSION_OPTIONS}
            />
            <BuilderIconButton
              onClick={() => onChange({ items: items.filter((_, index) => index !== idx) })}
              title="Xoa cell"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          </div>
        ))}
      </div>
      <BuilderActionButton
        onClick={() => onChange({ items: [...items, { label: '', value: '' }] })}
        className="mt-2"
      >
        <Plus className="h-3.5 w-3.5" />
        Them cell
      </BuilderActionButton>
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
  const sourceTable = tables.find((table) => table.id === sourceTableId);
  const tableCols = sourceTable?.columns || [];
  const selectedColumns = ((block.columns as string[]) || []).filter(Boolean);
  const columnOptions = tableCols.map((column) => ({
    value: column.name,
    label: column.name,
    description: column.type,
  }));
  const groupBy = ((block.group_by as string[]) || []).filter(Boolean);
  const totals = ((block.totals as string[]) || []).filter(Boolean);
  const columnGroups =
    (((block as { column_groups?: Array<{ label?: string; columns?: string[] }> }).column_groups) ||
      []) as Array<{ label?: string; columns?: string[] }>;

  return (
    <div className="space-y-3">
      <div className={BUILDER_GRID_3}>
        <Lbl label="Source">
          <select
            value={source.startsWith('lookup:') ? 'lookup' : source}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'primary') onChange({ source: 'primary' });
              else if (tables[0]) onChange({ source: `lookup:${tables[0].id}` });
            }}
            className={INPUT}
          >
            <option value="primary">primary (bang cua screen)</option>
            <option value="lookup">lookup (bang khac)</option>
          </select>
        </Lbl>
        {source.startsWith('lookup:') && (
          <Lbl label="Bang lookup">
            <select
              value={sourceTableId ?? ''}
              onChange={(event) => onChange({ source: `lookup:${event.target.value}` })}
              className={INPUT}
            >
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.display_name}
                </option>
              ))}
            </select>
          </Lbl>
        )}
        <Lbl label="Title">
          <input
            value={String(block.title ?? '')}
            onChange={(event) => onChange({ title: event.target.value })}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Max rows">
          <input
            type="number"
            value={Number(block.max_rows ?? 200)}
            onChange={(event) => onChange({ max_rows: Number(event.target.value) })}
            className={INPUT}
          />
        </Lbl>
        <Lbl label="Lay filter hien tai?">
          <select
            value={block.filters_from_view ? 'yes' : 'no'}
            onChange={(event) =>
              onChange({ filters_from_view: event.target.value === 'yes' })
            }
            className={INPUT}
          >
            <option value="yes">Co</option>
            <option value="no">Khong</option>
          </select>
        </Lbl>
        <Lbl label="Show row index?">
          <select
            value={block.show_index ? 'yes' : 'no'}
            onChange={(event) => onChange({ show_index: event.target.value === 'yes' })}
            className={INPUT}
          >
            <option value="no">Khong</option>
            <option value="yes">Co</option>
          </select>
        </Lbl>
      </div>

      <BuilderSubsection title="Cot hien thi" description="Danh sach cot duoc gioi han trong panel rieng de giu nhom data-table gon mat.">
        {tableCols.length > 0 ? (
          <CheckboxMultiSelect
            options={columnOptions}
            selectedValues={selectedColumns}
            onChange={(columns) => onChange({ columns })}
            columns={3}
          />
        ) : (
          <input
            value={selectedColumns.join(', ')}
            onChange={(event) =>
              onChange({
                columns: event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="Ten cot ngan cach bang dau phay"
            className={INPUT}
          />
        )}
      </BuilderSubsection>

      <ColumnGroupsEditor
        selectedColumns={selectedColumns}
        groups={columnGroups}
        onChange={(next) => onChange({ column_groups: next })}
      />

      <div className={BUILDER_GRID_2}>
        <Lbl label="Merge cells theo cot (group_by)">
          {selectedColumns.length > 0 ? (
            <CheckboxMultiSelect
              options={selectedColumns.map((column) => ({ value: column, label: column }))}
              selectedValues={groupBy}
              onChange={(next) => onChange({ group_by: next })}
              columns={2}
            />
          ) : (
            <input
              value={groupBy.join(', ')}
              onChange={(event) =>
                onChange({
                  group_by: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
              className={INPUT}
              placeholder="vd: shift_id, worker_username"
            />
          )}
        </Lbl>

        <TotalsEditor
          selectedColumns={selectedColumns}
          totals={totals}
          onChange={(next) => onChange({ totals: next })}
        />
      </div>

      <TransformEditor
        sourceColumns={tableCols.map((c) => c.name)}
        transform={
          (block as { transform?: TransformSpec | null }).transform ?? null
        }
        onChange={(next) => onChange({ transform: next ?? null } as Partial<DocBlockSpec>)}
      />

      <Lbl label="Cho phép xuất Excel bảng này?">
        <select
          value={block.allow_export_excel ? 'yes' : 'no'}
          onChange={(event) =>
            onChange({ allow_export_excel: event.target.value === 'yes' })
          }
          className={INPUT}
        >
          <option value="no">Không</option>
          <option value="yes">Có — hiện nút tải Excel</option>
        </select>
      </Lbl>
    </div>
  );
}

// ─── Pivot / Unpivot editor ──────────────────────────────────────────────

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
  columns?: string;
  values?: string;
  agg?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first';
  max_columns?: number;
  fill_value?: unknown;
};

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
  const colOptions = sourceColumns.map((name) => ({ value: name, label: name }));

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
      columns: sourceColumns[0] ?? '',
      values: sourceColumns[1] ?? '',
      agg: 'sum',
      max_columns: 50,
    });
  };

  return (
    <BuilderSubsection
      title="Pivot / Unpivot (tuỳ chọn)"
      description="Chuyển dạng dữ liệu ngay khi render document — không động vào DB hay Google Sheet. Áp dụng trước khi chọn cột hiển thị / tính tổng."
    >
      <Lbl label="Chế độ">
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as 'none' | 'unpivot' | 'pivot')
          }
          className={INPUT}
        >
          <option value="none">Không biến đổi</option>
          <option value="unpivot">Unpivot (wide → long)</option>
          <option value="pivot">Pivot (long → wide)</option>
        </select>
      </Lbl>

      {transform?.kind === 'unpivot' && (
        <div className="mt-2 space-y-2">
          <Lbl label="Cột giữ nguyên (id_columns)">
            {sourceColumns.length > 0 ? (
              <CheckboxMultiSelect
                options={colOptions}
                selectedValues={transform.id_columns ?? []}
                onChange={(next) =>
                  onChange({ ...transform, id_columns: next })
                }
                columns={3}
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
          <Lbl label="Cột cần unpivot (value_columns)">
            {sourceColumns.length > 0 ? (
              <CheckboxMultiSelect
                options={colOptions}
                selectedValues={transform.value_columns ?? []}
                onChange={(next) =>
                  onChange({ ...transform, value_columns: next })
                }
                columns={3}
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
            <Lbl label="Tên cột biến (var_name)">
              <input
                value={transform.var_name ?? 'variable'}
                onChange={(event) =>
                  onChange({ ...transform, var_name: event.target.value })
                }
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Tên cột giá trị (value_name)">
              <input
                value={transform.value_name ?? 'value'}
                onChange={(event) =>
                  onChange({ ...transform, value_name: event.target.value })
                }
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Bỏ ô null?">
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
                <option value="yes">Có</option>
                <option value="no">Không</option>
              </select>
            </Lbl>
          </div>
        </div>
      )}

      {transform?.kind === 'pivot' && (
        <div className="mt-2 space-y-2">
          <Lbl label="Cột giữ nguyên / index (gộp theo)">
            {sourceColumns.length > 0 ? (
              <CheckboxMultiSelect
                options={colOptions}
                selectedValues={transform.index ?? []}
                onChange={(next) => onChange({ ...transform, index: next })}
                columns={3}
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
          <div className={BUILDER_GRID_3}>
            <Lbl label="Cột làm header (columns)">
              <select
                value={transform.columns ?? ''}
                onChange={(event) =>
                  onChange({ ...transform, columns: event.target.value })
                }
                className={INPUT}
              >
                <option value="">— chọn —</option>
                {sourceColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Cột giá trị (values)">
              <select
                value={transform.values ?? ''}
                onChange={(event) =>
                  onChange({ ...transform, values: event.target.value })
                }
                className={INPUT}
              >
                <option value="">— chọn —</option>
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
            <Lbl label="Max cột pivot">
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
          <p className="text-[11px] text-slate-500">
            Lưu ý: pivot chỉ chạy trong bộ nhớ trên tối đa <b>max_rows</b> dòng
            đã fetch. Distinct values của cột header vượt <b>max cột pivot</b>{' '}
            sẽ báo lỗi 422.
          </p>
        </div>
      )}
    </BuilderSubsection>
  );
}

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
          className="wb-row-static-value rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2"
        >
          <input
            value={slot.label}
            onChange={(event) => updateSlot(idx, { label: event.target.value })}
            placeholder="Label"
            className={INPUT}
          />
          <input
            value={slot.role || ''}
            onChange={(event) => updateSlot(idx, { role: event.target.value })}
            placeholder="Role"
            className={INPUT}
          />
          <BuilderIconButton
            onClick={() => onChange({ slots: slots.filter((_, index) => index !== idx) })}
            title="Xoa slot"
            variant="danger"
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </BuilderIconButton>
        </div>
      ))}
      <BuilderActionButton
        onClick={() => onChange({ slots: [...slots, { label: '', role: '' }] })}
        className="mt-2"
      >
        <Plus className="h-3.5 w-3.5" />
        Them slot
      </BuilderActionButton>
    </div>
  );
}

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
        label: `Nhom ${groups.length + 1}`,
        columns: selectedColumns.slice(0, 2),
      },
    ]);
  };

  return (
    <BuilderSubsection
      title="Header groups"
      description="Moi nhom header span qua mot doan cot lien nhau, giu rang buoc ro rang ve vi tri dau/cuoi."
      action={
        <BuilderActionButton
          onClick={addGroup}
          disabled={selectedColumns.length < 2}
        >
          <Plus className="h-3.5 w-3.5" />
          Them nhom
        </BuilderActionButton>
      }
    >

      {groups.length === 0 ? (
        <p className="text-tiny text-text-tertiary">
          Chua co nhom nao. Chon it nhat 2 cot de tao grouped header.
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
                  placeholder="Ten nhom"
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
                      Tu: {column}
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
                      Den: {column}
                    </option>
                  ))}
                </select>
                <BuilderIconButton
                  onClick={() => onChange(groups.filter((_, index) => index !== idx) as Array<{ label: string; columns: string[] }>)}
                  title="Xoa nhom"
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

function parseTotalSpec(spec: string): { column: string; agg: TotalAgg } {
  const text = String(spec || '').trim();
  if (!text) return { column: '', agg: 'sum' };
  if (!text.includes(':')) return { column: text, agg: 'sum' };
  const [column, rawAgg] = text.split(':', 2);
  const agg = (rawAgg || 'sum').trim().toLowerCase() as TotalAgg;
  return {
    column: column.trim(),
    agg: ['sum', 'avg', 'count', 'min', 'max'].includes(agg) ? agg : 'sum',
  };
}

function TotalsEditor({
  selectedColumns,
  totals,
  onChange,
}: {
  selectedColumns: string[];
  totals: string[];
  onChange: (next: string[]) => void;
}) {
  const items = totals.map(parseTotalSpec);

  const updateItem = (
    idx: number,
    patch: Partial<{ column: string; agg: TotalAgg }>,
  ) => {
    const next = items.map((item, index) => (index === idx ? { ...item, ...patch } : item));
    onChange(next.filter((item) => item.column).map((item) => `${item.column}:${item.agg}`));
  };

  return (
    <BuilderSubsection
      title="Footer totals"
      description="Moi total la mot cap cot + phep tinh, khong tron cung hang voi field merge de giam chenh chieu cao."
      action={
        <BuilderActionButton
          onClick={() =>
            onChange(
              selectedColumns[0]
                ? [...totals, `${selectedColumns[0]}:sum`]
                : totals,
            )
          }
          disabled={selectedColumns.length === 0}
        >
          <Plus className="h-3.5 w-3.5" />
          Them total
        </BuilderActionButton>
      }
    >

      {items.length === 0 ? (
        <p className="text-tiny text-text-tertiary">
          Chua co total nao.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="wb-row-doc-group rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2"
            >
              <select
                value={item.column}
                onChange={(event) => updateItem(idx, { column: event.target.value })}
                className={INPUT}
              >
                {selectedColumns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
              <select
                value={item.agg}
                onChange={(event) => updateItem(idx, { agg: event.target.value as TotalAgg })}
                className={INPUT}
              >
                <option value="sum">sum</option>
                <option value="avg">avg</option>
                <option value="count">count</option>
                <option value="min">min</option>
                <option value="max">max</option>
              </select>
              <BuilderIconButton
                onClick={() => onChange(totals.filter((_, index) => index !== idx))}
                title="Xoa total"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      )}
    </BuilderSubsection>
  );
}
