/**
 * FormScreenEditor — fields editor + after_submit wiring + initial values.
 */
'use client';

import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import type { FormFieldSpec, ScreenSpec } from './types';
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
  tablesLoading: boolean;
  onChange: (next: ScreenSpec) => void;
}

const WIDGETS: FormFieldSpec['widget'][] = [
  'text',
  'textarea',
  'number',
  'select',
  'date',
  'datetime',
  'checkbox',
  'lookup',
];

export default function FormScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  onChange,
}: Props) {
  const form = screen.form || { fields: [] };
  const fields = form.fields || [];
  const tableCols = tables.find((t) => t.id === screen.table_id)?.columns ?? [];

  const updateForm = (patch: Partial<NonNullable<ScreenSpec['form']>>) =>
    onChange({ ...screen, form: { ...form, ...patch } });

  const updateField = (idx: number, patch: Partial<FormFieldSpec>) => {
    const next = [...fields];
    next[idx] = { ...next[idx], ...patch };
    updateForm({ fields: next });
  };
  const addField = () => {
    const id = tableCols[0]?.name || `col_${fields.length + 1}`;
    updateForm({
      fields: [
        ...fields,
        { column: id, widget: 'text', label: id, required: false },
      ],
    });
  };
  const removeField = (idx: number) => updateForm({ fields: fields.filter((_, i) => i !== idx) });
  const moveField = (idx: number, dir: -1 | 1) => {
    const next = [...fields];
    const t = idx + dir;
    if (t < 0 || t >= next.length) return;
    [next[idx], next[t]] = [next[t], next[idx]];
    updateForm({ fields: next });
  };

  const pages = (form as any).pages as Array<{ id: number; title: string; description?: string }> | undefined;
  const sections = ((form as any).sections as string[] | undefined) || [];

  const setPages = (next: Array<{ id: number; title: string; description?: string }>) =>
    updateForm({ pages: next } as any);
  const setSections = (next: string[]) => updateForm({ sections: next } as any);

  return (
    <>
      {/* Pages (multi-step) + sections */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
          Multi-step pages & sections
        </h2>
        <p className="mb-2 text-tiny text-text-tertiary">
          Tạo 2+ page để form hiện wizard có Back/Next + progress bar. Section là heading nhóm field trong cùng 1 page.
        </p>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-tiny font-emphasis text-text-secondary">Pages ({(pages || []).length})</span>
          <button
            onClick={() =>
              setPages([
                ...(pages || []),
                { id: ((pages || []).length || 0) + 1, title: `Bước ${(pages || []).length + 1}` },
              ])
            }
            className="flex items-center gap-1 text-tiny text-brand hover:underline"
          >
            <Plus className="h-3 w-3" />
            Thêm page
          </button>
        </div>
        {(pages || []).map((p, idx) => (
          <div key={idx} className="mb-1 flex gap-1">
            <span className="rounded bg-surface-2 px-2 py-1 text-tiny text-text-secondary">#{p.id}</span>
            <input
              value={p.title}
              onChange={(e) => {
                const next = [...(pages || [])];
                next[idx] = { ...next[idx], title: e.target.value };
                setPages(next);
              }}
              className={`${INPUT} flex-1`}
              placeholder="Tiêu đề bước"
            />
            <button
              onClick={() => setPages((pages || []).filter((_, i) => i !== idx))}
              className="rounded p-1 hover:bg-danger/10"
            >
              <Trash2 className="h-3 w-3 text-danger" />
            </button>
          </div>
        ))}

        <div className="mt-3">
          <Lbl label="Sections (ngăn cách dấu phẩy — tên section dùng cho field.section)">
            <input
              value={sections.join(', ')}
              onChange={(e) =>
                setSections(
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              className={INPUT}
              placeholder="vd: Thông tin chung, Phân công, Mục tiêu"
            />
          </Lbl>
        </div>
      </div>

      {/* Submit button + after_submit */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
          Submit & navigation
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Lbl label="Nhãn nút Submit">
            <input
              value={form.submit_label || ''}
              onChange={(e) => updateForm({ submit_label: e.target.value })}
              className={INPUT}
              placeholder="vd: Lưu, Tạo ca, Gửi báo cáo"
            />
          </Lbl>
          <Lbl label="Sau khi submit → đi screen nào?">
            <select
              value={form.after_submit?.go_to_screen || ''}
              onChange={(e) =>
                updateForm({
                  after_submit: e.target.value
                    ? {
                        id: form.after_submit?.id || 'after-submit',
                        label: form.after_submit?.label || 'Đã lưu',
                        go_to_screen: e.target.value,
                        carry: form.after_submit?.carry || [],
                      }
                    : null,
                })
              }
              className={INPUT}
            >
              <option value="">Ở lại screen này</option>
              {allScreens
                .filter((s) => s.id !== screen.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.id})
                  </option>
                ))}
            </select>
          </Lbl>
          {form.after_submit?.go_to_screen && (
            <Lbl label="Truyền cột nào sang screen sau? (carry)">
              <input
                value={(form.after_submit.carry || []).join(', ')}
                onChange={(e) =>
                  updateForm({
                    after_submit: {
                      ...form.after_submit!,
                      carry: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  })
                }
                className={INPUT}
                placeholder="vd: shift_id"
              />
            </Lbl>
          )}
        </div>
      </div>

      {/* Initial values */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <h2 className="mb-3 text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
          Giá trị mặc định khi mở form
        </h2>
        <p className="mb-2 text-tiny text-text-tertiary">
          Hỗ trợ <code className="bg-surface-2 px-1">{`{{app_user.username}}`}</code>,{' '}
          <code className="bg-surface-2 px-1">{`{{app_user.team_id}}`}</code>,{' '}
          <code className="bg-surface-2 px-1">{`{{today}}`}</code>
        </p>
        <InitialValuesEditor
          values={form.initial_values || {}}
          fieldOptions={fields.map((f) => f.column)}
          onChange={(v) => updateForm({ initial_values: v })}
        />
      </div>

      {/* Fields list */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-caption font-emphasis uppercase tracking-wider text-text-quaternary">
            Trường nhập liệu ({fields.length})
          </h2>
          <button
            onClick={addField}
            className="flex items-center gap-1 rounded-md border border-brand px-2 py-1 text-tiny text-brand hover:bg-brand/10"
          >
            <Plus className="h-3 w-3" />
            Thêm trường
          </button>
        </div>

        {tablesLoading ? (
          <p className="text-tiny text-text-tertiary">Đang tải columns…</p>
        ) : (
          <div className="space-y-2">
            {fields.map((f, idx) => (
              <FieldRow
                key={idx}
                field={f}
                tableCols={tableCols}
                tables={tables}
                isFirst={idx === 0}
                isLast={idx === fields.length - 1}
                onChange={(patch) => updateField(idx, patch)}
                onMoveUp={() => moveField(idx, -1)}
                onMoveDown={() => moveField(idx, 1)}
                onRemove={() => removeField(idx)}
              />
            ))}
            {fields.length === 0 && (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] p-4 text-center text-caption text-text-tertiary">
                Chưa có trường nào — bấm "Thêm trường" để bắt đầu.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function FieldRow({
  field,
  tableCols,
  tables,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  field: FormFieldSpec;
  tableCols: { name: string; type?: string }[];
  tables: DatasetTableInfo[];
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<FormFieldSpec>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-3">
      <div className="flex items-center gap-2">
        <select
          value={field.column}
          onChange={(e) => onChange({ column: e.target.value })}
          className={`${INPUT} flex-1`}
        >
          {tableCols.length === 0 && <option value={field.column}>{field.column}</option>}
          {tableCols.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} {c.type ? `(${c.type})` : ''}
            </option>
          ))}
        </select>
        <select
          value={field.widget}
          onChange={(e) => onChange({ widget: e.target.value as FormFieldSpec['widget'] })}
          className={INPUT}
          style={{ width: 110 }}
        >
          {WIDGETS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 whitespace-nowrap text-tiny text-text-secondary">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
            className="h-3 w-3"
          />
          required
        </label>
        <label className="flex items-center gap-1 whitespace-nowrap text-tiny text-text-secondary">
          <input
            type="checkbox"
            checked={!!field.readonly}
            onChange={(e) => onChange({ readonly: e.target.checked })}
            className="h-3 w-3"
          />
          readonly
        </label>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded px-1.5 py-0.5 text-tiny text-text-tertiary hover:bg-surface-2"
        >
          {expanded ? '▴' : '▾'}
        </button>
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

      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[rgb(var(--border-line))] pt-2">
          <Lbl label="Label hiển thị">
            <input
              value={field.label || ''}
              onChange={(e) => onChange({ label: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Placeholder">
            <input
              value={field.placeholder || ''}
              onChange={(e) => onChange({ placeholder: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Help text">
            <input
              value={field.help_text || ''}
              onChange={(e) => onChange({ help_text: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Default (vd {{app_user.username}})">
            <input
              value={String(field.default ?? '')}
              onChange={(e) => onChange({ default: e.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Section (heading nhóm)">
            <input
              value={(field as any).section || ''}
              onChange={(e) => onChange({ section: e.target.value || null } as any)}
              className={INPUT}
              placeholder="vd: Thông tin chung"
            />
          </Lbl>
          <Lbl label="Page (multi-step) — số trang field xuất hiện">
            <input
              type="number"
              min={1}
              value={Number((field as any).page || 1)}
              onChange={(e) => onChange({ page: Number(e.target.value) } as any)}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Show_If (ẩn khi expr false)">
            <input
              value={(field as any).show_if || ''}
              onChange={(e) => onChange({ show_if: e.target.value || null } as any)}
              className={INPUT}
              placeholder='vd: [defect_qty] > 0'
            />
          </Lbl>
          <Lbl label="Required_If (bắt buộc khi expr true)">
            <input
              value={(field as any).required_if || ''}
              onChange={(e) => onChange({ required_if: e.target.value || null } as any)}
              className={INPUT}
              placeholder='vd: [defect_qty] > 0'
            />
          </Lbl>
          <Lbl label="Readonly_If (khoá khi expr true)">
            <input
              value={(field as any).readonly_if || ''}
              onChange={(e) => onChange({ readonly_if: e.target.value || null } as any)}
              className={INPUT}
              placeholder='vd: [submitted] == true'
            />
          </Lbl>
          <Lbl label="Computed from dataset transformation (tên cột)">
            <input
              value={(field as any).computed_from_dataset || ''}
              onChange={(e) =>
                onChange({ computed_from_dataset: e.target.value || null } as any)
              }
              className={INPUT}
              placeholder="vd: total_qty (cột compute trong dataset)"
            />
          </Lbl>
          {(field.widget === 'select' || field.widget === 'lookup') && (
            <LookupEditor field={field} tables={tables} onChange={onChange} />
          )}
        </div>
      )}
    </div>
  );
}

function LookupEditor({
  field,
  tables,
  onChange,
}: {
  field: FormFieldSpec;
  tables: DatasetTableInfo[];
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const lookup = field.lookup || { kind: 'static', values: [] };
  const relPath: any[] = ((lookup as any).relationship_path as any[]) || [];
  const lookupTable = tables.find((t) => t.id === lookup.table_id);
  const lookupCols = lookupTable?.columns ?? [];
  return (
    <div className="col-span-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Lbl label="Lookup kind">
          <select
            value={lookup.kind}
            onChange={(e) =>
              onChange({
                lookup: {
                  ...lookup,
                  kind: e.target.value as 'static' | 'dataset_table',
                },
              })
            }
            className={INPUT}
          >
            <option value="static">Static (giá trị cố định)</option>
            <option value="dataset_table">Dataset table</option>
          </select>
        </Lbl>
        {lookup.kind === 'dataset_table' && (
          <Lbl label="Bảng nguồn">
            <select
              value={lookup.table_id ?? ''}
              onChange={(e) =>
                onChange({
                  lookup: {
                    ...lookup,
                    table_id: e.target.value ? Number(e.target.value) : null,
                  },
                })
              }
              className={INPUT}
            >
              <option value="">— chọn —</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </Lbl>
        )}
        {lookup.kind === 'dataset_table' && (
          <>
            <Lbl label="Cột giá trị">
              <select
                value={lookup.value_column || ''}
                onChange={(e) =>
                  onChange({ lookup: { ...lookup, value_column: e.target.value } })
                }
                className={INPUT}
              >
                <option value="">— chọn —</option>
                {lookupCols.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Cột hiển thị">
              <select
                value={lookup.label_column || ''}
                onChange={(e) =>
                  onChange({ lookup: { ...lookup, label_column: e.target.value } })
                }
                className={INPUT}
              >
                <option value="">— chọn (mặc định = value) —</option>
                {lookupCols.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Lbl>
          </>
        )}
      </div>
      {lookup.kind === 'static' && (
        <StaticValuesEditor
          values={lookup.values || []}
          onChange={(values) => onChange({ lookup: { ...lookup, values } })}
        />
      )}

      {lookup.kind === 'dataset_table' && (
        <RelationshipPathEditor
          tableId={lookup.table_id ?? null}
          tables={tables}
          path={relPath}
          onChange={(next) =>
            onChange({ lookup: { ...lookup, relationship_path: next } as any })
          }
        />
      )}
    </div>
  );
}

function RelationshipPathEditor({
  tableId,
  tables,
  path,
  onChange,
}: {
  tableId: number | null;
  tables: DatasetTableInfo[];
  path: any[];
  onChange: (next: any[]) => void;
}) {
  const [suggestions, setSuggestions] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!tableId) return;
    setLoading(true);
    fetch(`/api/v1/workboard-relationships?from_table_id=${tableId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setSuggestions(Array.isArray(d) ? d : []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [tableId]);

  return (
    <div className="col-span-2 mt-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2">
      <div className="mb-1 text-tiny font-emphasis text-text-secondary">
        Nested lookup (chain join để hiển thị label từ bảng liên quan)
      </div>
      {loading && <p className="text-tiny text-text-tertiary">Đang tải gợi ý...</p>}
      {!loading && suggestions.length === 0 && (
        <p className="text-tiny text-text-tertiary">
          (Dataset này chưa có semantic explore — config relationship trong
          dataset model rồi quay lại đây để dùng dropdown này.)
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="mb-2 grid grid-cols-1 gap-1">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() =>
                onChange([
                  {
                    table_id: s.target_table_id,
                    value_column: s.to_column,
                    label_column: s.suggested_label_columns?.[0] || null,
                  },
                ])
              }
              className="rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-left text-tiny hover:border-brand"
            >
              <span className="font-emphasis">{s.target_table_display}</span>{' '}
              <span className="text-text-tertiary">
                ({s.from_column} → {s.to_column})
              </span>
            </button>
          ))}
        </div>
      )}
      {path.length > 0 && (
        <div className="mt-2 space-y-1">
          {path.map((hop, i) => (
            <div
              key={i}
              className="flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-0 px-2 py-1 text-tiny"
            >
              <span>Hop {i + 1}: table#{hop.table_id}</span>
              <span className="text-text-tertiary">
                value={hop.value_column} label={hop.label_column}
              </span>
              <button
                onClick={() => onChange(path.filter((_: any, j: number) => j !== i))}
                className="ml-auto rounded p-0.5 hover:bg-danger/10"
              >
                <Trash2 className="h-3 w-3 text-danger" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StaticValuesEditor({
  values,
  onChange,
}: {
  values: Array<{ label: string; value: unknown }>;
  onChange: (next: Array<{ label: string; value: unknown }>) => void;
}) {
  const update = (idx: number, patch: Partial<{ label: string; value: unknown }>) => {
    const next = [...values];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };
  return (
    <div>
      <div className="mb-1 text-tiny text-text-secondary">Static options</div>
      <div className="space-y-1">
        {values.map((v, idx) => (
          <div key={idx} className="flex gap-1">
            <input
              value={v.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              placeholder="Label"
              className={`${INPUT} flex-1`}
            />
            <input
              value={String(v.value ?? '')}
              onChange={(e) => update(idx, { value: e.target.value })}
              placeholder="Value"
              className={`${INPUT} flex-1`}
            />
            <button
              onClick={() => onChange(values.filter((_, i) => i !== idx))}
              className="rounded p-1 hover:bg-danger/10"
            >
              <Trash2 className="h-3 w-3 text-danger" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...values, { label: '', value: '' }])}
        className="mt-1 flex items-center gap-1 text-tiny text-brand hover:underline"
      >
        <Plus className="h-3 w-3" />
        Thêm option
      </button>
    </div>
  );
}

function InitialValuesEditor({
  values,
  fieldOptions,
  onChange,
}: {
  values: Record<string, unknown>;
  fieldOptions: string[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(values);
  const update = (oldKey: string, newKey: string, val: string) => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (k === oldKey) next[newKey] = val;
      else next[k] = v;
    }
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {entries.map(([k, v], idx) => (
        <div key={idx} className="flex gap-1">
          <select
            value={k}
            onChange={(e) => update(k, e.target.value, String(v ?? ''))}
            className={`${INPUT} flex-1`}
          >
            <option value={k}>{k}</option>
            {fieldOptions
              .filter((c) => c !== k && !(c in values))
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
          <input
            value={String(v ?? '')}
            onChange={(e) => update(k, k, e.target.value)}
            placeholder="Giá trị mặc định"
            className={`${INPUT} flex-1`}
          />
          <button
            onClick={() => {
              const next = { ...values };
              delete next[k];
              onChange(next);
            }}
            className="rounded p-1 hover:bg-danger/10"
          >
            <Trash2 className="h-3 w-3 text-danger" />
          </button>
        </div>
      ))}
      <button
        onClick={() => {
          const unused = fieldOptions.find((c) => !(c in values));
          if (unused) onChange({ ...values, [unused]: '' });
        }}
        disabled={fieldOptions.every((c) => c in values)}
        className="flex items-center gap-1 text-tiny text-brand hover:underline disabled:opacity-50"
      >
        <Plus className="h-3 w-3" />
        Thêm cột
      </button>
    </div>
  );
}
