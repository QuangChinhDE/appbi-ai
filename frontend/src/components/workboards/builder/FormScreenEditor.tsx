/**
 * FormScreenEditor - Form screen editor (compact, Vietnamese, mode-aware).
 */
'use client';

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';

import {
  CheckboxMultiSelect,
  FixedExpressionInput,
  type SelectOption,
} from './BuilderValueControls';
import {
  BUILDER_GRID_2,
  BUILDER_GRID_4,
  BuilderActionButton,
  BuilderIconButton,
  BuilderSection,
  DataSourcePicker,
} from './BuilderChrome';
import type { FormFieldSpec, ScreenSpec } from './types';
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
  tablesLoading: boolean;
  onChange: (next: ScreenSpec) => void;
  mode: BuilderMode;
  focusFieldColumn?: string | null;
  onFocusFieldHandled?: () => void;
}

interface FormPage {
  id: number;
  title: string;
  description?: string;
}

interface FieldRuntimeExtras {
  section?: string | null;
  page?: number | null;
  show_if?: string | null;
  required_if?: string | null;
  readonly_if?: string | null;
  computed_from_dataset?: string | null;
}

type LookupRuntime = NonNullable<FormFieldSpec['lookup']> & {
  relationship_path?: unknown[] | null;
};

const WIDGETS: { value: FormFieldSpec['widget']; label: string }[] = [
  { value: 'text', label: 'Văn bản' },
  { value: 'textarea', label: 'Văn bản dài' },
  { value: 'number', label: 'Số' },
  { value: 'select', label: 'Chọn 1 (tĩnh)' },
  { value: 'lookup', label: 'Chọn 1 (từ bảng)' },
  { value: 'date', label: 'Ngày' },
  { value: 'datetime', label: 'Ngày giờ' },
  { value: 'checkbox', label: 'Bật/Tắt' },
];

const COMMON_EXPRESSION_OPTIONS: SelectOption[] = [
  { value: '{{app_user.username}}', label: 'User đang đăng nhập (username)' },
  { value: '{{app_user.full_name}}', label: 'User đang đăng nhập (họ tên)' },
  { value: '{{app_user.role}}', label: 'Vai trò user đang đăng nhập' },
  { value: '{{today}}', label: 'Hôm nay' },
  { value: '{{now}}', label: 'Bây giờ' },
];

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function getFieldExtra<T>(
  field: FormFieldSpec,
  key: keyof FieldRuntimeExtras,
): T | undefined {
  return (field as FormFieldSpec & FieldRuntimeExtras)[key] as T | undefined;
}

function widgetLabel(widget: FormFieldSpec['widget']): string {
  return WIDGETS.find((item) => item.value === widget)?.label || widget;
}

function ToggleChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-tiny text-text-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3"
      />
      {label}
    </label>
  );
}

function CollapsibleGroup({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-[rgb(var(--border-line))] pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 text-tiny font-medium text-text-primary hover:text-brand"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open ? <div className="mt-3 space-y-3">{children}</div> : null}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-0 px-4 py-6 text-center text-tiny text-text-tertiary">
      {children}
    </div>
  );
}

export default function FormScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  onChange,
  mode,
  focusFieldColumn,
  onFocusFieldHandled,
}: Props) {
  const form = screen.form || { fields: [] };
  const fields = form.fields || [];
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];
  const fieldColumnOptions = Array.from(
    new Set(fields.map((field) => field.column).filter(Boolean)),
  );
  const pages = (((form as { pages?: FormPage[] }).pages) || []) as FormPage[];
  const sections = (((form as { sections?: string[] }).sections) || []) as string[];
  const initialValues = form.initial_values || {};
  const initialEntries = Object.entries(initialValues);

  const [activeFieldIndex, setActiveFieldIndex] = useState(0);

  useEffect(() => {
    if (fields.length === 0) {
      if (activeFieldIndex !== 0) setActiveFieldIndex(0);
      return;
    }
    if (activeFieldIndex > fields.length - 1) {
      setActiveFieldIndex(fields.length - 1);
    }
  }, [activeFieldIndex, fields.length]);

  // React to focus-field requests from live preview.
  useEffect(() => {
    if (!focusFieldColumn) return;
    const idx = fields.findIndex((field) => field.column === focusFieldColumn);
    if (idx >= 0) {
      setActiveFieldIndex(idx);
    }
    onFocusFieldHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFieldColumn]);

  const activeField = fields[activeFieldIndex];

  const updateForm = (patch: Partial<NonNullable<ScreenSpec['form']>>) =>
    onChange({ ...screen, form: { ...form, ...patch } });

  const updateField = (index: number, patch: Partial<FormFieldSpec>) => {
    const next = [...fields];
    next[index] = { ...next[index], ...patch };
    updateForm({ fields: next });
  };

  const addField = () => {
    const column = tableCols[0]?.name || `field_${fields.length + 1}`;
    updateForm({
      fields: [
        ...fields,
        { column, widget: 'text', label: column, required: false },
      ],
    });
    setActiveFieldIndex(fields.length);
  };

  const removeField = (index: number) => {
    updateForm({ fields: fields.filter((_, itemIndex) => itemIndex !== index) });
    setActiveFieldIndex((current) => {
      if (current > index) return current - 1;
      return Math.max(0, Math.min(current, fields.length - 2));
    });
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const next = [...fields];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateForm({ fields: next });
    setActiveFieldIndex((current) => {
      if (current === index) return target;
      if (current === target) return index;
      return current;
    });
  };

  const setPages = (next: FormPage[]) =>
    updateForm({ pages: next } as unknown as Partial<NonNullable<ScreenSpec['form']>>);
  const setSections = (next: string[]) =>
    updateForm({ sections: next } as unknown as Partial<NonNullable<ScreenSpec['form']>>);

  const updateInitialValue = (oldKey: string, newKey: string, value: string) => {
    const next: Record<string, unknown> = {};
    for (const [key, current] of initialEntries) {
      if (key === oldKey) next[newKey] = value;
      else next[key] = current;
    }
    updateForm({ initial_values: next });
  };

  const removeInitialValue = (keyToRemove: string) => {
    const next = { ...initialValues };
    delete next[keyToRemove];
    updateForm({ initial_values: next });
  };

  const addInitialValue = () => {
    const unused = fieldColumnOptions.find((column) => !(column in initialValues));
    if (!unused) return;
    updateForm({ initial_values: { ...initialValues, [unused]: '' } });
  };

  const allFieldsUsed =
    fieldColumnOptions.length > 0 && fieldColumnOptions.every((column) => column in initialValues);

  const isMultiStep = pages.length > 0;

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      {/* ── Sections (always visible — hay dùng) ─────────────────── */}
      <BuilderSection
        title="Nhóm nội dung"
        description="Đặt tên các nhóm để gom field cùng chủ đề trong form. Để trống nếu chỉ là 1 nhóm."
      >
        <Lbl label="Tên nhóm (cách nhau bằng dấu phẩy)">
          <input
            value={sections.join(', ')}
            onChange={(event) =>
              setSections(
                event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
            className={INPUT}
            placeholder="Phiếu nhập, Khối lượng, Chất lượng, Khác"
          />
        </Lbl>

        {/* Multi-step toggle */}
        <div className="mt-3 flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-tiny text-text-secondary">
            <input
              type="checkbox"
              checked={isMultiStep}
              onChange={(event) => {
                if (event.target.checked) {
                  setPages([{ id: 1, title: 'Bước 1' }]);
                } else {
                  setPages([]);
                }
              }}
              className="h-3 w-3"
            />
            Form nhiều bước (wizard)
          </label>
          {isMultiStep && (
            <BuilderActionButton
              onClick={() =>
                setPages([
                  ...pages,
                  { id: pages.length + 1, title: `Bước ${pages.length + 1}` },
                ])
              }
            >
              <Plus className="h-3 w-3" /> Thêm bước
            </BuilderActionButton>
          )}
        </div>

        {isMultiStep && (
          <div className="mt-3 space-y-2">
            {pages.map((page, index) => (
              <div
                key={page.id}
                className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2"
              >
                <span className="rounded bg-surface-2 px-2 py-0.5 text-tiny text-text-secondary">
                  Bước {page.id}
                </span>
                <input
                  value={page.title}
                  onChange={(event) => {
                    const next = [...pages];
                    next[index] = { ...next[index], title: event.target.value };
                    setPages(next);
                  }}
                  className={INPUT}
                  placeholder="Tên bước"
                />
                <BuilderIconButton
                  onClick={() => setPages(pages.filter((_, i) => i !== index))}
                  title="Xoá bước"
                  variant="danger"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
              </div>
            ))}
          </div>
        )}
      </BuilderSection>

      {/* ── Fields (chính) ───────────────────────────────────────── */}
      <BuilderSection
        title={`Trường dữ liệu (${fields.length})`}
        description="Bên trái: danh sách field gọn. Bên phải: chi tiết của field đang chọn."
        action={
          <BuilderActionButton variant="brand" onClick={addField}>
            <Plus className="h-3.5 w-3.5" />
            Thêm field
          </BuilderActionButton>
        }
      >
        {tablesLoading ? (
          <p className="text-tiny text-text-tertiary">Đang tải cột bảng dữ liệu…</p>
        ) : fields.length === 0 ? (
          <EmptyHint>Chưa có field nào. Bấm &quot;Thêm field&quot; ở trên.</EmptyHint>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[260px,minmax(0,1fr)]">
            <CompactFieldList
              fields={fields}
              activeIndex={activeFieldIndex}
              onSelect={setActiveFieldIndex}
              onMoveUp={(index) => moveField(index, -1)}
              onMoveDown={(index) => moveField(index, 1)}
              onRemove={removeField}
            />

            {activeField ? (
              <FieldInspector
                field={activeField}
                tableCols={tableCols}
                tables={tables}
                pageOptions={pages}
                sectionOptions={sections}
                mode={mode}
                onChange={(patch) => updateField(activeFieldIndex, patch)}
              />
            ) : (
              <EmptyHint>Chọn 1 field để chỉnh.</EmptyHint>
            )}
          </div>
        )}
      </BuilderSection>

      {/* ── Submit flow ──────────────────────────────────────────── */}
      <BuilderSection
        title="Sau khi bấm lưu"
        description="Tên nút lưu và hành vi sau khi user submit thành công."
      >
        <div className={BUILDER_GRID_2}>
          <Lbl label="Tên nút lưu">
            <input
              value={form.submit_label || ''}
              onChange={(event) => updateForm({ submit_label: event.target.value })}
              className={INPUT}
              placeholder="Lưu phiếu"
            />
          </Lbl>
          <Lbl label="Sau khi lưu thành công">
            <select
              value={form.after_submit?.go_to_screen || ''}
              onChange={(event) =>
                updateForm({
                  after_submit: event.target.value
                    ? {
                        id: form.after_submit?.id || 'after-submit',
                        label: form.after_submit?.label || 'Đã lưu',
                        go_to_screen: event.target.value,
                        carry: form.after_submit?.carry || [],
                      }
                    : null,
                })
              }
              className={INPUT}
            >
              <option value="">Ở lại màn hình này</option>
              {allScreens
                .filter((item) => item.id !== screen.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    Chuyển đến: {item.title}
                  </option>
                ))}
            </select>
          </Lbl>
          {form.after_submit?.go_to_screen && (
            <Lbl label="Giữ lại giá trị (truyền sang màn sau)" className="md:col-span-2">
              {fieldColumnOptions.length > 0 ? (
                <CheckboxMultiSelect
                  options={fieldColumnOptions.map((column) => ({
                    value: column,
                    label: column,
                  }))}
                  selectedValues={form.after_submit.carry || []}
                  onChange={(carry) =>
                    updateForm({
                      after_submit: { ...form.after_submit!, carry },
                    })
                  }
                  columns={2}
                  emptyMessage="Chưa có field nào để truyền."
                />
              ) : (
                <input
                  value={(form.after_submit.carry || []).join(', ')}
                  onChange={(event) =>
                    updateForm({
                      after_submit: {
                        ...form.after_submit!,
                        carry: event.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                  className={INPUT}
                  placeholder="vd: shift_id"
                />
              )}
            </Lbl>
          )}
        </div>
      </BuilderSection>

      {/* ── Initial values (gọn lại) ─────────────────────────────── */}
      <BuilderSection
        title={`Giá trị mặc định (${initialEntries.length})`}
        description="Mỗi dòng = 1 cột nhận giá trị tự điền khi mở form."
        action={
          <BuilderActionButton
            onClick={addInitialValue}
            disabled={fieldColumnOptions.length === 0 || allFieldsUsed}
          >
            <Plus className="h-3.5 w-3.5" />
            Thêm giá trị mặc định
          </BuilderActionButton>
        }
      >
        {initialEntries.length === 0 ? (
          <EmptyHint>Chưa có giá trị mặc định nào.</EmptyHint>
        ) : (
          <div className="space-y-2">
            {initialEntries.map(([key, value]) => (
              <InitialValueRow
                key={key}
                fieldKey={key}
                value={value}
                fieldOptions={fieldColumnOptions}
                allValues={initialValues}
                onChange={updateInitialValue}
                onRemove={() => removeInitialValue(key)}
              />
            ))}
          </div>
        )}
      </BuilderSection>
    </div>
  );
}

// ── Compact field list ───────────────────────────────────────────────────

function CompactFieldList({
  fields,
  activeIndex,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  fields: FormFieldSpec[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-0">
      {fields.map((field, index) => {
        const isActive = index === activeIndex;
        const title = field.label?.trim() || field.column;
        const typeShort = widgetLabel(field.widget);
        return (
          <div
            key={`${field.column}:${index}`}
            className={cx(
              'group flex h-8 items-center gap-1.5 border-b border-[rgb(var(--border-line))] px-2 last:border-b-0',
              isActive ? 'bg-brand/10' : 'hover:bg-surface-2',
            )}
          >
            <GripVertical className="h-3 w-3 shrink-0 text-text-quaternary" />
            <button
              type="button"
              onClick={() => onSelect(index)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title={`${title} · ${typeShort}${field.required ? ' · Bắt buộc' : ''}`}
            >
              {field.required ? (
                <span className="text-danger" aria-label="Bắt buộc">
                  *
                </span>
              ) : (
                <span className="w-1.5" />
              )}
              <span className="min-w-0 flex-1 truncate text-caption text-text-primary">
                {title}
              </span>
              <span className="shrink-0 text-[11px] text-text-quaternary">{typeShort}</span>
            </button>
            <div className="flex items-center opacity-0 group-hover:opacity-100">
              {index > 0 && (
                <button
                  type="button"
                  onClick={() => onMoveUp(index)}
                  className="rounded p-0.5 hover:bg-surface-1"
                  title="Lên"
                >
                  <ArrowUp className="h-3 w-3 text-text-tertiary" />
                </button>
              )}
              {index < fields.length - 1 && (
                <button
                  type="button"
                  onClick={() => onMoveDown(index)}
                  className="rounded p-0.5 hover:bg-surface-1"
                  title="Xuống"
                >
                  <ArrowDown className="h-3 w-3 text-text-tertiary" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="rounded p-0.5 hover:bg-danger/10"
                title="Xoá"
              >
                <Trash2 className="h-3 w-3 text-danger" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Initial value row ────────────────────────────────────────────────────

function InitialValueRow({
  fieldKey,
  value,
  fieldOptions,
  allValues,
  onChange,
  onRemove,
}: {
  fieldKey: string;
  value: unknown;
  fieldOptions: string[];
  allValues: Record<string, unknown>;
  onChange: (oldKey: string, newKey: string, value: string) => void;
  onRemove: () => void;
}) {
  const availableFieldOptions = [
    fieldKey,
    ...fieldOptions.filter((column) => column !== fieldKey && !(column in allValues)),
  ];

  return (
    <div className="grid items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2 md:grid-cols-[180px,minmax(0,1fr),auto]">
      {fieldOptions.length > 0 ? (
        <select
          value={fieldKey}
          onChange={(event) => onChange(fieldKey, event.target.value, String(value ?? ''))}
          className={INPUT}
        >
          {availableFieldOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={fieldKey}
          onChange={(event) => onChange(fieldKey, event.target.value, String(value ?? ''))}
          className={INPUT}
          placeholder="Tên cột"
        />
      )}
      <FixedExpressionInput
        value={value}
        onChange={(next) => onChange(fieldKey, fieldKey, next)}
        fixedPlaceholder="Giá trị cố định"
        expressionPlaceholder="vd: {{app_user.username}}"
        expressionOptions={COMMON_EXPRESSION_OPTIONS}
      />
      <BuilderIconButton onClick={onRemove} title="Xoá" variant="danger">
        <Trash2 className="h-3.5 w-3.5 text-danger" />
      </BuilderIconButton>
    </div>
  );
}

// ── Field inspector — 3 groups (Hiển thị / Quy tắc / Nâng cao) ────────────

function FieldInspector({
  field,
  tableCols,
  tables,
  pageOptions,
  sectionOptions,
  mode,
  onChange,
}: {
  field: FormFieldSpec;
  tableCols: { name: string; type?: string }[];
  tables: DatasetTableInfo[];
  pageOptions: FormPage[];
  sectionOptions: string[];
  mode: BuilderMode;
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const sectionValue = getFieldExtra<string>(field, 'section') || '';
  const pageValue = getFieldExtra<number>(field, 'page') ?? null;
  const computedValue = getFieldExtra<string>(field, 'computed_from_dataset') || '';

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-4">
      {/* Header — single line, label + meta on the right */}
      <div className="mb-3 flex items-baseline gap-2 border-b border-[rgb(var(--border-line))] pb-2.5">
        <span className="truncate text-caption font-medium text-text-primary">
          {field.label?.trim() || field.column}
        </span>
        {field.required ? (
          <span className="text-danger" title="Bắt buộc">
            *
          </span>
        ) : null}
        <span className="ml-auto truncate text-[11px] text-text-quaternary">
          {widgetLabel(field.widget)}
          {field.readonly ? ' · chỉ đọc' : ''} · cột {field.column}
        </span>
      </div>

      <div className="space-y-3">
        {/* Group 1 — Hiển thị */}
        <CollapsibleGroup title="Hiển thị">
          <div className={BUILDER_GRID_4}>
            <Lbl label="Nhãn">
              <input
                value={field.label || ''}
                onChange={(event) => onChange({ label: event.target.value })}
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Loại nhập">
              <select
                value={field.widget}
                onChange={(event) =>
                  onChange({ widget: event.target.value as FormFieldSpec['widget'] })
                }
                className={INPUT}
              >
                {WIDGETS.map((widget) => (
                  <option key={widget.value} value={widget.value}>
                    {widget.label}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Nhóm nội dung">
              <select
                value={sectionValue}
                onChange={(event) =>
                  onChange({ section: event.target.value || null } as Partial<FormFieldSpec>)
                }
                className={INPUT}
              >
                <option value="">Không thuộc nhóm</option>
                {sectionOptions.map((section) => (
                  <option key={section} value={section}>
                    {section}
                  </option>
                ))}
              </select>
            </Lbl>
            {pageOptions.length > 0 && (
              <Lbl label="Bước">
                <select
                  value={pageValue ?? ''}
                  onChange={(event) =>
                    onChange({
                      page: event.target.value ? Number(event.target.value) : null,
                    } as Partial<FormFieldSpec>)
                  }
                  className={INPUT}
                >
                  <option value="">Bước mặc định</option>
                  {pageOptions.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.id}. {page.title}
                    </option>
                  ))}
                </select>
              </Lbl>
            )}
            <Lbl label="Placeholder">
              <input
                value={field.placeholder || ''}
                onChange={(event) => onChange({ placeholder: event.target.value })}
                className={INPUT}
              />
            </Lbl>
            <Lbl label="Help text">
              <input
                value={field.help_text || ''}
                onChange={(event) => onChange({ help_text: event.target.value })}
                className={INPUT}
              />
            </Lbl>
          </div>
        </CollapsibleGroup>

        {/* Group 2 — Quy tắc */}
        <CollapsibleGroup title="Quy tắc">
          <div className="flex flex-wrap gap-2">
            <ToggleChip
              label="Bắt buộc"
              checked={!!field.required}
              onChange={(checked) => onChange({ required: checked })}
            />
            <ToggleChip
              label="Chỉ đọc"
              checked={!!field.readonly}
              onChange={(checked) => onChange({ readonly: checked })}
            />
          </div>
          <Lbl label="Giá trị mặc định">
            <FixedExpressionInput
              value={field.default}
              onChange={(next) => onChange({ default: next })}
              fixedPlaceholder="Giá trị cố định"
              expressionPlaceholder="vd: {{app_user.username}}"
              expressionOptions={COMMON_EXPRESSION_OPTIONS}
            />
          </Lbl>
        </CollapsibleGroup>

        {/* Group 3 — Nâng cao (chỉ hiện ở mode advanced) */}
        {mode === 'advanced' && (
          <CollapsibleGroup title="Nâng cao" defaultOpen={false}>
            <div className={BUILDER_GRID_4}>
              <Lbl label="Cột (column)">
                <select
                  value={field.column}
                  onChange={(event) => onChange({ column: event.target.value })}
                  className={INPUT}
                >
                  {tableCols.length === 0 && <option value={field.column}>{field.column}</option>}
                  {tableCols.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name} {column.type ? `(${column.type})` : ''}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label="Hiện khi (show_if)">
                <input
                  value={String(getFieldExtra<string>(field, 'show_if') || '')}
                  onChange={(event) =>
                    onChange({ show_if: event.target.value || null } as Partial<FormFieldSpec>)
                  }
                  className={INPUT}
                  placeholder="[status] == 'open'"
                />
              </Lbl>
              <Lbl label="Bắt buộc khi (required_if)">
                <input
                  value={String(getFieldExtra<string>(field, 'required_if') || '')}
                  onChange={(event) =>
                    onChange({
                      required_if: event.target.value || null,
                    } as Partial<FormFieldSpec>)
                  }
                  className={INPUT}
                  placeholder="[defect_qty] > 0"
                />
              </Lbl>
              <Lbl label="Chỉ đọc khi (readonly_if)">
                <input
                  value={String(getFieldExtra<string>(field, 'readonly_if') || '')}
                  onChange={(event) =>
                    onChange({
                      readonly_if: event.target.value || null,
                    } as Partial<FormFieldSpec>)
                  }
                  className={INPUT}
                  placeholder="[submitted] == true"
                />
              </Lbl>
              <Lbl label="Tự tính từ dataset" className="md:col-span-2">
                <select
                  value={computedValue}
                  onChange={(event) =>
                    onChange({
                      computed_from_dataset: event.target.value || null,
                    } as Partial<FormFieldSpec>)
                  }
                  className={INPUT}
                >
                  <option value="">Không dùng</option>
                  {tableCols.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </Lbl>
            </div>
          </CollapsibleGroup>
        )}

        {/* Lookup config */}
        {(field.widget === 'select' || field.widget === 'lookup') && (
          <CollapsibleGroup title="Tuỳ chọn (nguồn lookup)">
            <LookupEditor field={field} tables={tables} mode={mode} onChange={onChange} />
          </CollapsibleGroup>
        )}
      </div>
    </div>
  );
}

function LookupEditor({
  field,
  tables,
  mode,
  onChange,
}: {
  field: FormFieldSpec;
  tables: DatasetTableInfo[];
  mode: BuilderMode;
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const lookup = (field.lookup || { kind: 'static', values: [] }) as LookupRuntime;
  const relationshipPath = lookup.relationship_path || [];
  const lookupTable = tables.find((table) => table.id === lookup.table_id);
  const lookupCols = lookupTable?.columns ?? [];

  return (
    <div className="space-y-3">
      <div className={BUILDER_GRID_2}>
        <Lbl label="Kiểu nguồn">
          <select
            value={lookup.kind}
            onChange={(event) =>
              onChange({
                lookup: {
                  ...lookup,
                  kind: event.target.value as 'static' | 'dataset_table',
                },
              })
            }
            className={INPUT}
          >
            <option value="static">Danh sách cố định</option>
            <option value="dataset_table">Từ bảng dữ liệu</option>
          </select>
        </Lbl>

        {lookup.kind === 'dataset_table' && (
          <Lbl label="Bảng nguồn">
            <select
              value={lookup.table_id ?? ''}
              onChange={(event) =>
                onChange({
                  lookup: {
                    ...lookup,
                    table_id: event.target.value ? Number(event.target.value) : null,
                  },
                })
              }
              className={INPUT}
            >
              <option value="">— chọn bảng —</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.display_name}
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
                onChange={(event) =>
                  onChange({ lookup: { ...lookup, value_column: event.target.value } })
                }
                className={INPUT}
              >
                <option value="">— chọn cột —</option>
                {lookupCols.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Cột hiển thị">
              <select
                value={lookup.label_column || ''}
                onChange={(event) =>
                  onChange({ lookup: { ...lookup, label_column: event.target.value } })
                }
                className={INPUT}
              >
                <option value="">Mặc định = cột giá trị</option>
                {lookupCols.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </Lbl>
          </>
        )}
      </div>

      {lookup.kind === 'static' ? (
        <StaticValuesEditor
          values={lookup.values || []}
          onChange={(values) => onChange({ lookup: { ...lookup, values } })}
        />
      ) : mode === 'advanced' ? (
        <RelationshipPathEditor
          tableId={lookup.table_id ?? null}
          path={relationshipPath}
          onChange={(next) =>
            onChange({
              lookup: {
                ...lookup,
                relationship_path: next,
              } as FormFieldSpec['lookup'],
            })
          }
        />
      ) : null}
    </div>
  );
}

function RelationshipPathEditor({
  tableId,
  path,
  onChange,
}: {
  tableId: number | null;
  path: unknown[];
  onChange: (next: unknown[]) => void;
}) {
  const [suggestions, setSuggestions] = React.useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!tableId) return;
    setLoading(true);
    fetch(`/api/v1/workboard-relationships?from_table_id=${tableId}`, {
      credentials: 'include',
    })
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setSuggestions(Array.isArray(data) ? data : []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [tableId]);

  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-2 text-tiny font-emphasis text-text-secondary">
        Quan hệ lồng (advanced)
      </div>
      {loading ? <p className="text-tiny text-text-tertiary">Đang tải gợi ý…</p> : null}
      {!loading && suggestions.length === 0 && (
        <p className="text-tiny text-text-tertiary">Không có gợi ý quan hệ nào.</p>
      )}
      {suggestions.length > 0 ? (
        <div className="mb-3 grid gap-2">
          {suggestions.map((suggestion, index) => (
            <button
              key={index}
              onClick={() =>
                onChange([
                  {
                    table_id: suggestion.target_table_id,
                    value_column: suggestion.to_column,
                    label_column:
                      (suggestion.suggested_label_columns as string[] | undefined)?.[0] || null,
                  },
                ])
              }
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-left text-tiny hover:border-brand"
            >
              <span className="font-emphasis">
                {String(suggestion.target_table_display || 'Target')}
              </span>{' '}
              <span className="text-text-tertiary">
                ({String(suggestion.from_column || '')} → {String(suggestion.to_column || '')})
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {path.length > 0 ? (
        <div className="space-y-2">
          {path.map((hop, index) => {
            const item = (hop || {}) as Record<string, unknown>;
            return (
              <div
                key={index}
                className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-tiny"
              >
                <span>Bước {index + 1}</span>
                <span className="text-text-tertiary">
                  table#{String(item.table_id || '')} · value={String(item.value_column || '')}{' '}
                  · label={String(item.label_column || '')}
                </span>
                <BuilderIconButton
                  onClick={() => onChange(path.filter((_, i) => i !== index))}
                  title="Xoá"
                  variant="danger"
                  className="ml-auto"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
              </div>
            );
          })}
        </div>
      ) : null}
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
  const update = (
    index: number,
    patch: Partial<{ label: string; value: unknown }>,
  ) => {
    const next = [...values];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  return (
    <div className="space-y-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="text-tiny font-emphasis text-text-secondary">Danh sách lựa chọn</div>
      {values.length > 0 ? (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div
              key={index}
              className="grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto]"
            >
              <input
                value={value.label}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder="Nhãn hiển thị"
                className={INPUT}
              />
              <input
                value={String(value.value ?? '')}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder="Giá trị"
                className={INPUT}
              />
              <BuilderIconButton
                onClick={() => onChange(values.filter((_, i) => i !== index))}
                title="Xoá"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-tiny text-text-tertiary">Chưa có lựa chọn nào.</p>
      )}
      <BuilderActionButton onClick={() => onChange([...values, { label: '', value: '' }])}>
        <Plus className="h-3.5 w-3.5" />
        Thêm lựa chọn
      </BuilderActionButton>
    </div>
  );
}
