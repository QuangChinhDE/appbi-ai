/**
 * FormScreenEditor - object-based form configuration.
 */
'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Eye,
  EyeOff,
  FileInput,
  GripVertical,
  LayoutList,
  Link2,
  Loader2,
  Plus,
  Route,
  Trash2,
  XCircle,
} from 'lucide-react';

import {
  FixedExpressionInput,
  MultiColumnPicker,
  SingleColumnPicker,
  type SelectOption,
} from './BuilderValueControls';
import {
  BUILDER_GRID_2,
  BUILDER_GRID_3,
  BUILDER_GRID_4,
  BuilderActionButton,
  BuilderEmptyHint,
  BuilderIconButton,
  BuilderInspectorPanel,
  BuilderNavigator,
  BuilderNavigatorGroup,
  BuilderNavigatorItem,
  BuilderObjectEditor,
  BuilderTableMissingBanner,
  DataSourcePicker,
} from './BuilderChrome';
import type { FormFieldSpec, RelatedRecordConfigSpec, ScreenSpec } from './types';
import { INPUT, Lbl } from './ScreenEditor';
import { workboardApi } from '@/lib/api/workboards';

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
  focusFieldColumn?: string | null;
  onFocusFieldHandled?: () => void;
  workboardId?: number;
}

type FormSpec = NonNullable<ScreenSpec['form']>;
type FormPage = NonNullable<FormSpec['pages']>[number];
type LookupRuntime = NonNullable<FormFieldSpec['lookup']>;
type FormActiveItem = 'layout' | 'submit' | 'related' | 'initial' | 'ocr' | `field:${number}`;

type OcrSpec = NonNullable<FormSpec['ocr']>;

type RelationshipHop = {
  table_id?: number | null;
  value_column?: string | null;
  label_column?: string | null;
};

const EMPTY_FORM: FormSpec = { fields: [], initial_values: {} };

const WIDGETS: { value: FormFieldSpec['widget']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
  { value: 'checkbox', label: 'On / off' },
  { value: 'file', label: 'File upload (base64, ≤1MB)' },
  { value: 'image', label: 'Image upload (base64, ≤1MB)' },
  { value: 'images', label: 'Nhiều ảnh (chụp thực địa)' },
  { value: 'map', label: 'Bản đồ (chọn vùng trên map)' },
  { value: 'geopoint', label: 'Vị trí GPS (chấm công/định vị)' },
  { value: 'signature', label: 'Chữ ký tay' },
  { value: 'barcode', label: 'Quét mã QR / Barcode' },
  { value: 'audio', label: 'Ghi âm ghi chú' },
  { value: 'computed', label: 'Tính tự động (công thức)' },
  { value: 'status', label: 'Trạng thái / duyệt' },
  // ── Rich input types ──────────────────────────────────────────────
  { value: 'enum_list', label: 'Chọn nhiều' },
  { value: 'rating', label: 'Đánh giá (sao)' },
  { value: 'slider', label: 'Thanh trượt (slider)' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Số điện thoại' },
  { value: 'url', label: 'Đường dẫn (URL)' },
  { value: 'rich_text', label: 'Văn bản định dạng (Markdown)' },
  { value: 'currency', label: 'Tiền tệ' },
  { value: 'percent', label: 'Phần trăm (%)' },
  { value: 'time', label: 'Giờ (time)' },
  { value: 'duration', label: 'Khoảng thời gian' },
  { value: 'color', label: 'Màu sắc' },
  { value: 'video', label: 'Video (clip ngắn)' },
  { value: 'qr', label: 'Mã QR (hiển thị / in tem)' },
];

// ── Field-type picker taxonomy ────────────────────────────────────────────
// A user-facing categorisation LAYERED OVER the runtime widget enum (the enum
// is unchanged; this only groups + renames for the builder picker). `lookup`
// is not its own entry — it is `select` with source = "from table" (the
// "Nguồn lựa chọn" axis flips the widget), so CHOICE reads as one concept.
const FIELD_TYPE_GROUPS: {
  category: string;
  items: Array<{ widget: FormFieldSpec['widget']; label: string; hint?: string }>;
}[] = [
  {
    category: 'Văn bản',
    items: [
      { widget: 'text', label: 'Text' },
      { widget: 'textarea', label: 'Văn bản dài' },
      { widget: 'email', label: 'Email' },
      { widget: 'phone', label: 'Số điện thoại' },
      { widget: 'url', label: 'Đường dẫn (URL)' },
      { widget: 'rich_text', label: 'Văn bản định dạng (Markdown)' },
    ],
  },
  {
    category: 'Số',
    items: [
      { widget: 'number', label: 'Số' },
      { widget: 'currency', label: 'Tiền tệ' },
      { widget: 'percent', label: 'Phần trăm (%)' },
      { widget: 'slider', label: 'Thanh trượt' },
    ],
  },
  {
    category: 'Lựa chọn',
    items: [
      { widget: 'select', label: 'Chọn một', hint: 'tĩnh hoặc từ bảng' },
      { widget: 'enum_list', label: 'Chọn nhiều' },
    ],
  },
  {
    category: 'Ngày & giờ',
    items: [
      { widget: 'date', label: 'Ngày' },
      { widget: 'datetime', label: 'Ngày + giờ' },
      { widget: 'time', label: 'Giờ' },
      { widget: 'duration', label: 'Khoảng thời gian' },
    ],
  },
  {
    category: 'Hình ảnh & Tệp',
    items: [
      { widget: 'image', label: 'Ảnh (1 ảnh)' },
      { widget: 'images', label: 'Nhiều ảnh' },
      { widget: 'file', label: 'Tệp đính kèm' },
      { widget: 'signature', label: 'Chữ ký tay' },
      { widget: 'audio', label: 'Ghi âm' },
      { widget: 'video', label: 'Video (clip ngắn)' },
    ],
  },
  {
    category: 'Vị trí',
    items: [
      { widget: 'geopoint', label: 'Vị trí GPS' },
      { widget: 'map', label: 'Chọn vùng trên bản đồ' },
    ],
  },
  {
    category: 'Giá trị tính toán',
    items: [{ widget: 'computed', label: 'Tính tự động (công thức)' }],
  },
  {
    category: 'Quy trình',
    items: [{ widget: 'status', label: 'Trạng thái / duyệt', hint: 'phân quyền + luồng chuyển' }],
  },
  {
    category: 'Nhập chuyên biệt',
    items: [{ widget: 'barcode', label: 'Quét mã (Barcode/QR)', hint: 'quét để NHẬP giá trị' }],
  },
  {
    category: 'Hiển thị / Output',
    items: [{ widget: 'qr', label: 'Mã QR (in tem)', hint: 'SINH mã để hiển thị/in' }],
  },
  {
    category: 'Khác',
    items: [
      { widget: 'checkbox', label: 'Bật / tắt' },
      { widget: 'rating', label: 'Đánh giá (sao)' },
      { widget: 'color', label: 'Màu sắc' },
    ],
  },
];

const WIDGET_LABEL: Record<string, string> = Object.fromEntries(
  FIELD_TYPE_GROUPS.flatMap((g) => g.items.map((it) => [it.widget as string, it.label])),
);

// Searchable, categorised replacement for the flat 31-item "Field type" select.
// Emits a widget; the caller maps select↔lookup / enum_list defaults exactly as
// the old <select> did, so nothing downstream changes.
function FieldTypePicker({
  widget,
  onSelect,
}: {
  widget: FormFieldSpec['widget'];
  onSelect: (w: FormFieldSpec['widget']) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
        setQ('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  // lookup collapses to the 'select' entry for display (source axis differentiates).
  const shown = widget === 'lookup' ? 'select' : widget;
  const currentLabel = WIDGET_LABEL[shown as string] || String(shown);
  const ql = q.trim().toLowerCase();
  const groups = FIELD_TYPE_GROUPS.map((g) => ({
    category: g.category,
    items: ql
      ? g.items.filter(
          (it) =>
            it.label.toLowerCase().includes(ql) ||
            g.category.toLowerCase().includes(ql) ||
            (it.hint || '').toLowerCase().includes(ql),
        )
      : g.items,
  })).filter((g) => g.items.length > 0);
  const pick = (w: FormFieldSpec['widget']) => {
    onSelect(w);
    setOpen(false);
    setQ('');
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${INPUT} flex items-center justify-between text-left`}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-lg">
          <div className="border-b border-[rgb(var(--border-line))] p-2">
            <input
              autoFocus
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Tìm loại trường..."
              className={INPUT}
            />
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {groups.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                Không có kết quả.
              </span>
            ) : (
              groups.map((g) => (
                <div key={g.category} className="mb-1">
                  <div className="px-2 py-1 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
                    {g.category}
                  </div>
                  {g.items.map((it) => {
                    const active = it.widget === shown;
                    return (
                      <button
                        key={it.widget}
                        type="button"
                        onClick={() => pick(it.widget)}
                        className={`block w-full truncate rounded px-2 py-1.5 text-left text-caption hover:bg-surface-2 ${
                          active ? 'bg-brand/10 text-brand' : 'text-text-primary'
                        }`}
                      >
                        <span className="font-medium">{it.label}</span>
                        {it.hint && (
                          <span className="ml-1 text-tiny text-text-tertiary">· {it.hint}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Infer a sensible default field type from a source column's data type, so
// +Add Field doesn't silently make everything Text.
function inferWidgetFromColumnType(type?: string): FormFieldSpec['widget'] {
  const t = (type || '').toLowerCase();
  if (/bool/.test(t)) return 'checkbox';
  if (/timestamp|datetime/.test(t)) return 'datetime';
  if (/date/.test(t)) return 'date';
  if (/(^|[^a-z])time([^a-z]|$)/.test(t)) return 'time';
  if (/int|numeric|decimal|float|double|real|money|number|serial/.test(t)) return 'number';
  return 'text';
}

// +Add Field: open a source-column picker first (P0 #6). Picking a column
// infers its field type; a manual "custom field" escape hatch remains for
// forms that need a field not bound 1:1 to a source column.
function AddFieldMenu({
  columns,
  usedColumns,
  onAddColumn,
  onAddCustom,
}: {
  columns: { name: string; type?: string }[];
  usedColumns: Set<string>;
  onAddColumn: (col: { name: string; type?: string }) => void;
  onAddCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
        setQ('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const available = columns.filter((c) => !usedColumns.has(c.name));
  const ql = q.trim().toLowerCase();
  const filtered = ql ? available.filter((c) => c.name.toLowerCase().includes(ql)) : available;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"
        title="Add field"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-popover lg:left-0 lg:right-auto">
          {columns.length > 0 && (
            <div className="border-b border-[rgb(var(--border-line))] p-2">
              <input
                autoFocus
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Tìm cột nguồn..."
                className={INPUT}
              />
            </div>
          )}
          <div className="max-h-64 overflow-auto p-1">
            {columns.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                Nguồn chưa có cột — dùng trường tùy chỉnh bên dưới.
              </span>
            ) : available.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                Đã thêm hết cột nguồn.
              </span>
            ) : filtered.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                Không có cột khớp.
              </span>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => {
                    onAddColumn(c);
                    setOpen(false);
                    setQ('');
                  }}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded px-2 py-1.5 text-left text-caption text-text-primary hover:bg-surface-2"
                  title={`${c.name}${c.type ? ` (${c.type})` : ''}`}
                >
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="max-w-[11rem] shrink-0 truncate text-tiny text-text-tertiary">
                    {c.type ? `${c.type} → ` : ''}
                    {inferWidgetFromColumnType(c.type)}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[rgb(var(--border-line))] p-1">
            <button
              type="button"
              onClick={() => {
                onAddCustom();
                setOpen(false);
                setQ('');
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-caption text-text-secondary hover:bg-surface-2"
            >
              + Trường tùy chỉnh (không gắn cột)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const COMMON_EXPRESSION_OPTIONS: SelectOption[] = [
  { value: '{{app_user.username}}', label: 'Signed-in user - username' },
  { value: '{{app_user.full_name}}', label: 'Signed-in user - full name' },
  { value: '{{app_user.role}}', label: 'Signed-in user - role' },
  { value: '{{today}}', label: 'Today' },
  { value: '{{now}}', label: 'Now' },
];

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
    <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 text-caption text-text-secondary">
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
        className="flex w-full items-center gap-1.5 text-caption font-medium text-text-primary hover:text-brand"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open ? <div className="mt-3 space-y-3">{children}</div> : null}
    </section>
  );
}

export default function FormScreenEditor({
  screen,
  allScreens,
  tables,
  tablesLoading,
  onChange,
  focusFieldColumn,
  onFocusFieldHandled,
  workboardId,
}: Props) {
  const form = screen.form || EMPTY_FORM;
  const fields = form.fields || [];
  const boundTable = tables.find((table) => table.id === screen.table_id);
  const tableCols = boundTable?.columns ?? [];
  const tableMissing = !!screen.table_id && !boundTable && !tablesLoading;
  const fieldColumnOptions = Array.from(
    new Set(fields.map((field) => field.column).filter(Boolean)),
  );
  const pages = form.pages || [];
  const sections = form.sections || [];
  const relatedRecords = form.related_records || [];
  const initialValues = form.initial_values || {};
  const initialEntries = Object.entries(initialValues);
  const isMultiStep = pages.length > 0;

  const [activeItem, setActiveItem] = useState<FormActiveItem>('layout');
  const activeFieldIndex = activeItem.startsWith('field:')
    ? Number(activeItem.slice('field:'.length))
    : -1;
  const activeField = activeFieldIndex >= 0 ? fields[activeFieldIndex] : null;

  useEffect(() => {
    if (!activeItem.startsWith('field:')) return;
    if (fields.length === 0) {
      setActiveItem('layout');
    } else if (activeFieldIndex > fields.length - 1) {
      setActiveItem(`field:${fields.length - 1}`);
    }
  }, [activeFieldIndex, activeItem, fields.length]);

  useEffect(() => {
    if (!focusFieldColumn) return;
    const idx = fields.findIndex((field) => field.column === focusFieldColumn);
    if (idx >= 0) setActiveItem(`field:${idx}`);
    onFocusFieldHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFieldColumn]);

  const updateForm = (patch: Partial<FormSpec>) =>
    onChange({ ...screen, form: { ...form, ...patch } });

  const updateField = (index: number, patch: Partial<FormFieldSpec>) => {
    const next = [...fields];
    next[index] = { ...next[index], ...patch };
    updateForm({ fields: next });
  };

  // Add a field bound to a chosen source column, inferring its type.
  const addFieldForColumn = (col: { name: string; type?: string }) => {
    updateForm({
      fields: [
        ...fields,
        {
          column: col.name,
          widget: inferWidgetFromColumnType(col.type),
          label: col.name,
          required: false,
        },
      ],
    });
    setActiveItem(`field:${fields.length}`);
  };

  // Escape hatch: a field not bound to a source column.
  const addCustomField = () => {
    const column = `field_${fields.length + 1}`;
    updateForm({
      fields: [...fields, { column, widget: 'text', label: column, required: false }],
    });
    setActiveItem(`field:${fields.length}`);
  };

  const removeField = (index: number) => {
    const nextFields = fields.filter((_, itemIndex) => itemIndex !== index);
    updateForm({ fields: nextFields });
    if (activeFieldIndex === index) {
      setActiveItem(
        nextFields.length > 0
          ? `field:${Math.max(0, Math.min(index, nextFields.length - 1))}`
          : 'layout',
      );
    } else if (activeFieldIndex > index) {
      setActiveItem(`field:${activeFieldIndex - 1}`);
    }
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    updateForm({ fields: next });
    if (activeFieldIndex === index) setActiveItem(`field:${target}`);
    else if (activeFieldIndex === target) setActiveItem(`field:${index}`);
  };

  const updateInitialValue = (oldKey: string, newKey: string, value: unknown) => {
    const next: Record<string, unknown> = {};
    for (const [key, current] of initialEntries) {
      next[key === oldKey ? newKey : key] = key === oldKey ? value : current;
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

  const addRelatedRecord = () => {
    const parentKey = (screen.primary_key_columns || []).find(Boolean) || '';
    if (!parentKey) return;
    const child = allScreens.find(
      (item) => item.id !== screen.id && (item.kind === 'form' || item.kind === 'table'),
    );
    const childTable = tables.find((table) => table.id === child?.table_id);
    const childFk =
      childTable?.columns.find((column) => column.name === parentKey)?.name ||
      childTable?.columns[0]?.name ||
      parentKey;
    const next: RelatedRecordConfigSpec = {
      id: `related_${relatedRecords.length + 1}`,
      label: child ? child.title : 'Related records',
      child_screen_id: child?.id || '',
      parent_key_column: parentKey,
      child_foreign_key_column: childFk,
      allow_multiple: true,
      show_existing: true,
      allow_add_after_save: true,
      keep_parent_context: true,
      delete_behavior: 'restrict',
      display_columns: [],
      finish_screen_id: null,
    };
    updateForm({ related_records: [...relatedRecords, next] });
    setActiveItem('related');
  };

  const updateRelatedRecord = (index: number, patch: Partial<RelatedRecordConfigSpec>) => {
    const next = [...relatedRecords];
    next[index] = { ...next[index], ...patch };
    updateForm({ related_records: next });
  };

  const removeRelatedRecord = (index: number) => {
    updateForm({ related_records: relatedRecords.filter((_, itemIndex) => itemIndex !== index) });
  };

  const renderInspector = () => {
    if (activeItem === 'layout') {
      return (
        <BuilderInspectorPanel
          icon={<LayoutList className="h-4 w-4" />}
          title="Form layout"
          subtitle="Structure the form before configuring individual fields."
        >
          <FormLayoutInspector
            pages={pages}
            sections={sections}
            isMultiStep={isMultiStep}
            onPagesChange={(next) => updateForm({ pages: next })}
            onSectionsChange={(next) => updateForm({ sections: next })}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'submit') {
      return (
        <BuilderInspectorPanel
          icon={<Route className="h-4 w-4" />}
          title="Submit flow"
          subtitle="Control the save button and what happens after a successful submit."
        >
          <SubmitFlowInspector
            screen={screen}
            form={form}
            allScreens={allScreens}
            fieldColumnOptions={fieldColumnOptions}
            onChange={updateForm}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'related') {
      return (
        <BuilderInspectorPanel
          icon={<Link2 className="h-4 w-4" />}
          title="Related records"
          subtitle="Bind child records to the saved parent row without exposing the FK to the user."
        >
          <RelatedRecordsInspector
            screen={screen}
            allScreens={allScreens}
            tables={tables}
            parentColumns={(screen.primary_key_columns || []).filter(Boolean)}
            relations={relatedRecords}
            onAdd={addRelatedRecord}
            onChange={updateRelatedRecord}
            onRemove={removeRelatedRecord}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'initial') {
      return (
        <BuilderInspectorPanel
          icon={<FileInput className="h-4 w-4" />}
          title="Initial values (mồi cả form)"
          subtitle="Mồi giá trị chung khi mở form mới. Ghi đè 'Default value' của từng trường; nhưng bị ghi đè bởi giá trị mang sang từ màn trước (row-action / after-submit)."
        >
          <InitialValuesInspector
            entries={initialEntries}
            fieldOptions={fieldColumnOptions}
            allValues={initialValues}
            allFieldsUsed={allFieldsUsed}
            onAdd={addInitialValue}
            onChange={updateInitialValue}
            onRemove={removeInitialValue}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'ocr') {
      return (
        <BuilderInspectorPanel
          icon={<Camera className="h-4 w-4" />}
          title="Chụp ảnh tự điền (OCR)"
          subtitle="Cho phép người nhập chụp ảnh phiếu để hệ thống tự điền vào biểu mẫu."
        >
          <OcrInspector
            ocr={(form.ocr || {}) as OcrSpec}
            onChange={(next) => updateForm({ ocr: next })}
            workboardId={workboardId}
            screenId={screen.id}
          />
        </BuilderInspectorPanel>
      );
    }

    if (activeField) {
      return (
        <BuilderInspectorPanel
          icon={<ClipboardList className="h-4 w-4" />}
          title={activeField.label?.trim() || activeField.column}
          subtitle={`${widgetLabel(activeField.widget)} - column ${activeField.column}${
            activeField.readonly ? ' - readonly' : ''
          }`}
          action={
            <BuilderIconButton
              onClick={() => removeField(activeFieldIndex)}
              title="Delete field"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <FieldInspector
            field={activeField}
            tableCols={tableCols}
            tables={tables}
            pageOptions={pages}
            sectionOptions={sections}
            allScreens={allScreens}
            onChange={(patch) => updateField(activeFieldIndex, patch)}
          />
        </BuilderInspectorPanel>
      );
    }

    return (
      <BuilderInspectorPanel
        icon={<ClipboardList className="h-4 w-4" />}
        title="Fields"
        subtitle="Add a field to start configuring the form body."
      >
        <BuilderEmptyHint>No fields yet. Add one from the left panel.</BuilderEmptyHint>
      </BuilderInspectorPanel>
    );
  };

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      {tableMissing ? (
        <BuilderTableMissingBanner tableId={screen.table_id} />
      ) : !screen.table_id ? (
        <BuilderEmptyHint className="text-left">
          Pick a primary data source before adding fields. Form fields are bound to columns
          in that table.
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title="Form objects"
          description="Select a setup area or a field, then edit its details on the right."
        >
          <BuilderNavigatorGroup title="Setup">
            <BuilderNavigatorItem
              icon={<LayoutList className="h-3.5 w-3.5" />}
              label="Form layout"
              subtitle={
                isMultiStep
                  ? `${pages.length} steps - ${sections.length} groups`
                  : `${sections.length} groups`
              }
              active={activeItem === 'layout'}
              onClick={() => setActiveItem('layout')}
            />
            <BuilderNavigatorItem
              icon={<Route className="h-3.5 w-3.5" />}
              label="Submit flow"
              subtitle={form.after_submit?.go_to_screen ? 'Navigate after save' : 'Stay on this screen'}
              active={activeItem === 'submit'}
              onClick={() => setActiveItem('submit')}
            />
            <BuilderNavigatorItem
              icon={<Link2 className="h-3.5 w-3.5" />}
              label="Related records"
              subtitle={
                relatedRecords.length > 0
                  ? `${relatedRecords.length} relation${relatedRecords.length === 1 ? '' : 's'}`
                  : 'No child flow'
              }
              active={activeItem === 'related'}
              onClick={() => setActiveItem('related')}
            />
            <BuilderNavigatorItem
              icon={<FileInput className="h-3.5 w-3.5" />}
              label="Initial values"
              subtitle={`${initialEntries.length} preset${initialEntries.length === 1 ? '' : 's'}`}
              active={activeItem === 'initial'}
              onClick={() => setActiveItem('initial')}
            />
            <BuilderNavigatorItem
              icon={<Camera className="h-3.5 w-3.5" />}
              label="Chụp ảnh tự điền"
              subtitle={form.ocr?.enabled ? `Bật · ${form.ocr?.provider || 'anthropic'}` : 'Tắt'}
              active={activeItem === 'ocr'}
              onClick={() => setActiveItem('ocr')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Fields (${fields.length})`}
            action={
              <AddFieldMenu
                columns={tableCols}
                usedColumns={new Set(fields.map((f) => f.column))}
                onAddColumn={addFieldForColumn}
                onAddCustom={addCustomField}
              />
            }
          >
            {tablesLoading ? (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2 text-caption text-text-tertiary">
                Loading source columns...
              </p>
            ) : fields.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">No fields yet.</BuilderEmptyHint>
            ) : (
              fields.map((field, index) => (
                <FormFieldNavigatorItem
                  key={`${field.column}:${index}`}
                  field={field}
                  active={activeItem === `field:${index}`}
                  canMoveUp={index > 0}
                  canMoveDown={index < fields.length - 1}
                  onSelect={() => setActiveItem(`field:${index}`)}
                  onMoveUp={() => moveField(index, -1)}
                  onMoveDown={() => moveField(index, 1)}
                  onRemove={() => removeField(index)}
                />
              ))
            )}
          </BuilderNavigatorGroup>
        </BuilderNavigator>

        {renderInspector()}
      </BuilderObjectEditor>
    </div>
  );
}

function FormFieldNavigatorItem({
  field,
  active,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
  canMoveUp,
  canMoveDown,
}: {
  field: FormFieldSpec;
  active: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const title = field.label?.trim() || field.column;
  const typeShort = widgetLabel(field.widget);

  return (
    <BuilderNavigatorItem
      icon={<GripVertical className="h-3.5 w-3.5" />}
      label={title}
      subtitle={`${typeShort} - ${field.column}${field.required ? ' - required' : ''}`}
      active={active}
      onClick={onSelect}
      badge={
        field.readonly ? (
          <span className="rounded bg-surface-2 px-1 text-caption text-text-tertiary">readonly</span>
        ) : null
      }
      action={
        <div className="flex items-center">
          {canMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="rounded p-0.5 hover:bg-surface-1"
              title="Move up"
            >
              <ArrowUp className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          {canMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              className="rounded p-0.5 hover:bg-surface-1"
              title="Move down"
            >
              <ArrowDown className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-0.5 hover:bg-danger/10"
            title="Delete"
          >
            <Trash2 className="h-3 w-3 text-danger" />
          </button>
        </div>
      }
    />
  );
}

function FormLayoutInspector({
  pages,
  sections,
  isMultiStep,
  onPagesChange,
  onSectionsChange,
}: {
  pages: FormPage[];
  sections: string[];
  isMultiStep: boolean;
  onPagesChange: (next: FormPage[]) => void;
  onSectionsChange: (next: string[]) => void;
}) {
  const addStep = () => {
    const nextId = Math.max(0, ...pages.map((page) => page.id)) + 1;
    onPagesChange([...pages, { id: nextId, title: `Step ${nextId}` }]);
  };

  return (
    <div className="space-y-5">
      <div className={BUILDER_GRID_2}>
        <Lbl label="Group names">
          <input
            value={sections.join(', ')}
            onChange={(event) =>
              onSectionsChange(
                event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
            className={INPUT}
            placeholder="Header, Quantities, Quality, Other"
          />
        </Lbl>
        <Lbl label="Form flow">
          <select
            value={isMultiStep ? 'multi_step' : 'single_page'}
            onChange={(event) => {
              if (event.target.value === 'multi_step') {
                onPagesChange(isMultiStep ? pages : [{ id: 1, title: 'Step 1' }]);
              } else {
                onPagesChange([]);
              }
            }}
            className={INPUT}
          >
            <option value="single_page">Single page</option>
            <option value="multi_step">Multi-step wizard</option>
          </select>
        </Lbl>
      </div>

      {isMultiStep ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-caption font-medium text-text-secondary">Steps</h3>
            <BuilderActionButton onClick={addStep}>
              <Plus className="h-3.5 w-3.5" />
              Add step
            </BuilderActionButton>
          </div>
          <div className="space-y-2">
            {pages.map((page, index) => (
              <div
                key={page.id}
                className="grid gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <span className="self-center rounded bg-surface-2 px-2 py-1 text-caption text-text-secondary">
                  {page.id}
                </span>
                <input
                  value={page.title}
                  onChange={(event) => {
                    const next = [...pages];
                    next[index] = { ...next[index], title: event.target.value };
                    onPagesChange(next);
                  }}
                  className={INPUT}
                  placeholder="Step title"
                />
                <input
                  value={page.description || ''}
                  onChange={(event) => {
                    const next = [...pages];
                    next[index] = { ...next[index], description: event.target.value || null };
                    onPagesChange(next);
                  }}
                  className={INPUT}
                  placeholder="Optional description"
                />
                <BuilderIconButton
                  onClick={() => onPagesChange(pages.filter((_, itemIndex) => itemIndex !== index))}
                  title="Delete step"
                  variant="danger"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <BuilderEmptyHint className="text-left">
          Single-page forms can still use groups. Turn on multi-step mode when the form
          has a clear step-by-step workflow.
        </BuilderEmptyHint>
      )}
    </div>
  );
}

function SubmitFlowInspector({
  screen,
  form,
  allScreens,
  fieldColumnOptions,
  onChange,
}: {
  screen: ScreenSpec;
  form: FormSpec;
  allScreens: ScreenSpec[];
  fieldColumnOptions: string[];
  onChange: (patch: Partial<FormSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_2}>
      <Lbl label="Submit button label">
        <input
          value={form.submit_label || ''}
          onChange={(event) => onChange({ submit_label: event.target.value })}
          className={INPUT}
          placeholder="Save"
        />
      </Lbl>
      <Lbl label="After successful save">
        <select
          value={form.after_submit?.go_to_screen || ''}
          onChange={(event) =>
            onChange({
              after_submit: event.target.value
                ? {
                    id: form.after_submit?.id || 'after-submit',
                    label: form.after_submit?.label || 'Saved',
                    go_to_screen: event.target.value,
                    carry: form.after_submit?.carry || [],
                  }
                : null,
            })
          }
          className={INPUT}
        >
          <option value="">Stay on this screen</option>
          {allScreens
            .filter((item) => item.id !== screen.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                Go to: {item.title}
              </option>
            ))}
        </select>
      </Lbl>
      {form.after_submit?.go_to_screen && (
        <Lbl label="Carry values to the next screen" className="wb-col-span-2">
          {fieldColumnOptions.length > 0 ? (
            <MultiColumnPicker
              sourceColumns={fieldColumnOptions}
              value={form.after_submit.carry || []}
              onChange={(carry) =>
                onChange({
                  after_submit: { ...form.after_submit!, carry },
                })
              }
              placeholder="Pick columns to carry over..."
              emptyHint="No fields available to carry."
            />
          ) : (
            <input
              value={(form.after_submit.carry || []).join(', ')}
              onChange={(event) =>
                onChange({
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
              placeholder="e.g. shift_id"
            />
          )}
        </Lbl>
      )}
      <Lbl label="Đóng dấu GPS khi lưu (geo-stamp) — cột lưu 'lat,lng'" className="wb-col-span-2">
        <input
          value={form.geo_stamp_column || ''}
          onChange={(event) => onChange({ geo_stamp_column: event.target.value || null })}
          className={INPUT}
          placeholder="vd: vi_tri_gps (để trống = tắt)"
        />
      </Lbl>
    </div>
  );
}

function RelatedRecordsInspector({
  screen,
  allScreens,
  tables,
  parentColumns,
  relations,
  onAdd,
  onChange,
  onRemove,
}: {
  screen: ScreenSpec;
  allScreens: ScreenSpec[];
  tables: DatasetTableInfo[];
  parentColumns: string[];
  relations: RelatedRecordConfigSpec[];
  onAdd: () => void;
  onChange: (index: number, patch: Partial<RelatedRecordConfigSpec>) => void;
  onRemove: (index: number) => void;
}) {
  const childScreens = allScreens.filter(
    (item) => item.id !== screen.id && (item.kind === 'form' || item.kind === 'table'),
  );
  const screenById = new Map(allScreens.map((item) => [item.id, item]));
  const tableById = new Map(tables.map((table) => [table.id, table]));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-caption text-text-tertiary">
          Use this when one parent row owns many child rows.
        </div>
        <BuilderActionButton
          onClick={onAdd}
          disabled={parentColumns.length === 0 || childScreens.length === 0}
        >
          <Plus className="h-3.5 w-3.5" /> Add relation
        </BuilderActionButton>
      </div>

      {parentColumns.length === 0 ? (
        <BuilderEmptyHint className="text-left">
          Configure at least one primary key column on the parent screen before adding a relation.
        </BuilderEmptyHint>
      ) : null}

      {relations.length === 0 ? (
        <BuilderEmptyHint className="text-left">
          No child flow yet. Add a relation to keep a parent key and bind child records automatically.
        </BuilderEmptyHint>
      ) : (
        relations.map((relation, index) => {
          const child = screenById.get(relation.child_screen_id);
          const childTable = child ? tableById.get(child.table_id || 0) : undefined;
          const childColumns = childTable?.columns.map((column) => column.name) || [];
          const finishScreens = allScreens.filter((item) => item.id !== child?.id);
          return (
            <div
              key={`${relation.id}:${index}`}
              className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-caption font-medium text-text-primary">
                    {relation.label || relation.id || 'Related records'}
                  </div>
                  <div className="truncate text-tiny text-text-tertiary">
                    {relation.parent_key_column || 'parent key'} {'->'} {relation.child_foreign_key_column || 'child FK'}
                  </div>
                </div>
                <BuilderIconButton
                  onClick={() => onRemove(index)}
                  title="Delete relation"
                  variant="danger"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
              </div>

              <div className="space-y-3">
                <div className={BUILDER_GRID_2}>
                  <Lbl label="Relation ID">
                    <input
                      value={relation.id || ''}
                      onChange={(event) =>
                        onChange(index, {
                          id: event.target.value.replace(/[^A-Za-z0-9_-]/g, '_'),
                        })
                      }
                      className={`${INPUT} font-mono`}
                      placeholder="production_details"
                    />
                  </Lbl>
                  <Lbl label="Display label">
                    <input
                      value={relation.label || ''}
                      onChange={(event) => onChange(index, { label: event.target.value || null })}
                      className={INPUT}
                      placeholder="Chi tiết sản lượng"
                    />
                  </Lbl>
                  <Lbl label="Child screen">
                    <select
                      value={relation.child_screen_id || ''}
                      onChange={(event) => {
                        const childScreenId = event.target.value;
                        const nextChild = screenById.get(childScreenId);
                        const nextChildTable = nextChild ? tableById.get(nextChild.table_id || 0) : undefined;
                        const parentKey = relation.parent_key_column || parentColumns[0] || '';
                        const fk =
                          nextChildTable?.columns.find((column) => column.name === parentKey)?.name ||
                          nextChildTable?.columns[0]?.name ||
                          relation.child_foreign_key_column ||
                          '';
                        onChange(index, {
                          child_screen_id: childScreenId,
                          child_foreign_key_column: fk,
                        });
                      }}
                      className={INPUT}
                    >
                      <option value="">- pick a child screen -</option>
                      {childScreens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Lbl>
                  <Lbl label="Finish screen">
                    <select
                      value={relation.finish_screen_id || ''}
                      onChange={(event) =>
                        onChange(index, { finish_screen_id: event.target.value || null })
                      }
                      className={INPUT}
                    >
                      <option value="">Stay on child screen</option>
                      {finishScreens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Lbl>
                  <Lbl label="Parent key">
                    <SingleColumnPicker
                      sourceColumns={parentColumns}
                      value={relation.parent_key_column || null}
                      onChange={(next) => onChange(index, { parent_key_column: next || '' })}
                      placeholder="Pick parent key..."
                    />
                  </Lbl>
                  <Lbl label="Child foreign key">
                    <SingleColumnPicker
                      sourceColumns={childColumns}
                      value={relation.child_foreign_key_column || null}
                      onChange={(next) => onChange(index, { child_foreign_key_column: next || '' })}
                      placeholder="Pick child FK..."
                    />
                  </Lbl>
                  <Lbl label="When parent is deleted">
                    <select
                      value={relation.delete_behavior || 'restrict'}
                      onChange={(event) =>
                        onChange(index, {
                          delete_behavior: event.target
                            .value as RelatedRecordConfigSpec['delete_behavior'],
                        })
                      }
                      className={INPUT}
                    >
                      <option value="restrict">Restrict while children exist</option>
                      <option value="cascade">Delete child records</option>
                      <option value="unlink">Keep children and clear FK</option>
                    </select>
                  </Lbl>
                </div>

                <Lbl label="Child list display columns">
                  <MultiColumnPicker
                    sourceColumns={childColumns}
                    value={relation.display_columns || []}
                    onChange={(display_columns) => onChange(index, { display_columns })}
                    placeholder="Pick columns to show in the child list..."
                    emptyHint="Pick a child screen first."
                  />
                </Lbl>

                <div className="flex flex-wrap gap-2">
                  <ToggleChip
                    label="Allow multiple"
                    checked={relation.allow_multiple !== false}
                    onChange={(allow_multiple) => onChange(index, { allow_multiple })}
                  />
                  <ToggleChip
                    label="Show existing"
                    checked={relation.show_existing !== false}
                    onChange={(show_existing) => onChange(index, { show_existing })}
                  />
                  <ToggleChip
                    label="Add after save"
                    checked={relation.allow_add_after_save !== false}
                    onChange={(allow_add_after_save) =>
                      onChange(index, { allow_add_after_save })
                    }
                  />
                  <ToggleChip
                    label="Keep context"
                    checked={relation.keep_parent_context !== false}
                    onChange={(keep_parent_context) =>
                      onChange(index, { keep_parent_context })
                    }
                  />
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// Vision-capable models per provider. First entry = default for that provider.
const OCR_PROVIDERS: {
  value: NonNullable<OcrSpec['provider']>;
  label: string;
  models: string[];
}[] = [
  { value: 'openai', label: 'OpenAI (GPT)', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
  { value: 'anthropic', label: 'Anthropic (Claude)', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'] },
  { value: 'gemini', label: 'Google (Gemini)', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'] },
];

function OcrInspector({
  ocr,
  onChange,
  workboardId,
  screenId,
}: {
  ocr: OcrSpec;
  onChange: (next: OcrSpec) => void;
  workboardId?: number;
  screenId?: string;
}) {
  const provider = ocr.provider || 'anthropic';
  const modelOptions = OCR_PROVIDERS.find((p) => p.value === provider)?.models || [];
  const defModel = modelOptions[0] || '';
  const patch = (p: Partial<OcrSpec>) => onChange({ ...ocr, ...p });

  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Whether the field currently holds a real token the user typed/revealed.
  const hasTyped = !!(ocr.api_key && ocr.api_key.length > 0);
  const canTest = !!(workboardId && screenId && (hasTyped || ocr.api_key_set));

  const runConnTest = async () => {
    if (!workboardId || !screenId || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await workboardApi.testOcrConnection(workboardId, screenId, {
        provider,
        model: ocr.model || defModel,
        // send the typed key if any; empty → server falls back to the saved key
        api_key: ocr.api_key || '',
      });
      setTestResult(
        r.ok
          ? { ok: true, msg: `Kết nối thành công${r.model ? ` · ${r.model}` : ''}` }
          : { ok: false, msg: r.message || 'Kết nối thất bại.' },
      );
    } catch {
      setTestResult({ ok: false, msg: 'Không gọi được máy chủ để kiểm tra.' });
    } finally {
      setTesting(false);
    }
  };

  const toggleEye = async () => {
    // If revealing a stored (but not-yet-loaded) key, fetch it once.
    if (!showKey && !hasTyped && ocr.api_key_set && workboardId && screenId) {
      setRevealing(true);
      try {
        const key = await workboardApi.revealOcrKey(workboardId, screenId);
        if (key) patch({ api_key: key });
      } catch {
        /* ignore — keep masked */
      } finally {
        setRevealing(false);
      }
    }
    setShowKey((s) => !s);
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2.5 text-body text-text-primary">
        <input
          type="checkbox"
          checked={!!ocr.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-[rgb(var(--border-line))]"
        />
        <span>
          Cho phép chụp ảnh để tự điền biểu mẫu
          <span className="block text-caption text-text-tertiary">
            Khi bật, người nhập có thể chụp ảnh phiếu; hệ thống đọc và điền sẵn vào các trường.
          </span>
        </span>
      </label>

      {ocr.enabled && (
        <div className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className={BUILDER_GRID_2}>
            <Lbl label="Nhà cung cấp AI">
              <select
                value={provider}
                onChange={(e) => {
                  const np = e.target.value as OcrSpec['provider'];
                  // switch the model to the new provider's default so we never
                  // keep a model that belongs to a different provider.
                  const nd = OCR_PROVIDERS.find((p) => p.value === np)?.models[0] || '';
                  patch({ provider: np, model: nd });
                }}
                className={INPUT}
              >
                {OCR_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </Lbl>
            <Lbl label="Model">
              <select
                value={ocr.model || defModel}
                onChange={(e) => patch({ model: e.target.value })}
                className={INPUT}
              >
                {/* keep a previously-saved custom model visible/selectable */}
                {ocr.model && !modelOptions.includes(ocr.model) && (
                  <option value={ocr.model}>{ocr.model} (tuỳ chỉnh)</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Lbl>
          </div>
          <Lbl label="Token (API key)">
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                value={ocr.api_key || ''}
                onChange={(e) => patch({ api_key: e.target.value })}
                className={`${INPUT} pr-10`}
                placeholder={
                  ocr.api_key_set
                    ? '•••••••••• đã lưu — bấm 👁 để xem, hoặc nhập khoá mới'
                    : 'Dán token của nhà cung cấp'
                }
              />
              {(ocr.api_key_set || hasTyped) && (
                <button
                  type="button"
                  onClick={toggleEye}
                  title={showKey ? 'Ẩn token' : 'Xem token'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                >
                  {revealing ? (
                    <span className="text-caption">…</span>
                  ) : showKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
            <span className="mt-1 block text-caption text-text-tertiary">
              Token được mã hoá khi lưu (không hiển thị mặc định). Để trống khi lưu = giữ khoá đã lưu.
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runConnTest}
                disabled={testing || !canTest}
                title={
                  canTest
                    ? 'Gọi thử nhà cung cấp để xác nhận token + model hoạt động'
                    : 'Hãy dán (hoặc đã lưu) token trước khi kiểm tra'
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption font-medium text-text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {testing ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
              </button>
              {testResult && (
                <span
                  className={`inline-flex items-center gap-1 text-caption font-medium ${
                    testResult.ok ? 'text-emerald-600' : 'text-rose-600'
                  }`}
                >
                  {testResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  {testResult.msg}
                </span>
              )}
            </div>
          </Lbl>
          <Lbl label="Hướng dẫn cho AI (prompt — tuỳ chọn)">
            <textarea
              value={ocr.hint || ''}
              onChange={(e) => patch({ hint: e.target.value })}
              className={INPUT}
              rows={3}
              placeholder="Dạy thêm cho AI về bố cục phiếu. VD: Mã công tơ ở góc trên phải; chỉ số đầu/cuối kỳ ở bảng giữa; ngày dạng dd/mm/yyyy…"
            />
            <span className="mt-1 block text-caption text-text-tertiary">
              Hệ thống tự gửi kèm danh sách cột của biểu mẫu cho AI; phần này để bổ sung ngữ cảnh phiếu.
            </span>
          </Lbl>
        </div>
      )}
    </div>
  );
}

function InitialValuesInspector({
  entries,
  fieldOptions,
  allValues,
  allFieldsUsed,
  onAdd,
  onChange,
  onRemove,
}: {
  entries: Array<[string, unknown]>;
  fieldOptions: string[];
  allValues: Record<string, unknown>;
  allFieldsUsed: boolean;
  onAdd: () => void;
  onChange: (oldKey: string, newKey: string, value: unknown) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-text-tertiary">
          One row per field to pre-fill with a fixed value or expression.
        </p>
        <BuilderActionButton
          onClick={onAdd}
          disabled={fieldOptions.length === 0 || allFieldsUsed}
        >
          <Plus className="h-3.5 w-3.5" />
          Add value
        </BuilderActionButton>
      </div>
      {entries.length === 0 ? (
        <BuilderEmptyHint>No initial values yet.</BuilderEmptyHint>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <InitialValueRow
              key={key}
              fieldKey={key}
              value={value}
              fieldOptions={fieldOptions}
              allValues={allValues}
              onChange={onChange}
              onRemove={() => onRemove(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
  onChange: (oldKey: string, newKey: string, value: unknown) => void;
  onRemove: () => void;
}) {
  const availableFieldOptions = [
    fieldKey,
    ...fieldOptions.filter((column) => column !== fieldKey && !(column in allValues)),
  ];

  return (
    <div className="wb-row-key-value rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2">
      {fieldOptions.length > 0 ? (
        <select
          value={fieldKey}
          onChange={(event) => onChange(fieldKey, event.target.value, value)}
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
          onChange={(event) => onChange(fieldKey, event.target.value, value)}
          className={INPUT}
          placeholder="Column name"
        />
      )}
      <FixedExpressionInput
        value={value}
        onChange={(next) => onChange(fieldKey, fieldKey, next)}
        fixedPlaceholder="Fixed value"
        expressionPlaceholder="e.g. {{app_user.username}}"
        expressionOptions={COMMON_EXPRESSION_OPTIONS}
      />
      <BuilderIconButton onClick={onRemove} title="Delete" variant="danger">
        <Trash2 className="h-3.5 w-3.5 text-danger" />
      </BuilderIconButton>
    </div>
  );
}

function FieldInspector({
  field,
  tableCols,
  tables,
  pageOptions,
  sectionOptions,
  allScreens,
  onChange,
}: {
  field: FormFieldSpec;
  tableCols: { name: string; type?: string }[];
  tables: DatasetTableInfo[];
  pageOptions: FormPage[];
  sectionOptions: string[];
  allScreens: ScreenSpec[];
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const sectionValue = field.section || '';
  const pageValue = field.page ?? null;
  const computedValue = field.computed_from_dataset || '';
  const selectSource =
    field.widget === 'lookup' || field.lookup?.kind === 'dataset_table' ? 'dataset_table' : 'static';
  const enumListStyle = field.enum_list_style || 'chips';

  return (
    <div className="space-y-3">
      <CollapsibleGroup title="Basic">
        <div className={BUILDER_GRID_3}>
          <Lbl label="Column">
            {tableCols.length > 0 ? (
              <SingleColumnPicker
                sourceColumns={tableCols.map((column) => column.name)}
                value={field.column}
                onChange={(next) => onChange({ column: next || field.column })}
                clearable={false}
                labelByValue={Object.fromEntries(
                  tableCols.map((column) => [
                    column.name,
                    column.type ? `${column.name} (${column.type})` : column.name,
                  ]),
                )}
              />
            ) : (
              <input
                value={field.column}
                onChange={(event) => onChange({ column: event.target.value })}
                className={INPUT}
              />
            )}
          </Lbl>
          <Lbl label="Display label">
            <input
              value={field.label || ''}
              onChange={(event) => onChange({ label: event.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label="Field type">
            <FieldTypePicker
              widget={field.widget}
              onSelect={(widget) => {
                if (widget === 'select') {
                  onChange({
                    widget: selectSource === 'dataset_table' ? 'lookup' : 'select',
                    lookup: field.lookup || { kind: selectSource, values: [] },
                  });
                  return;
                }
                if (widget === 'enum_list') {
                  onChange({
                    widget,
                    enum_list_style: field.enum_list_style || 'chips',
                    lookup: field.lookup || { kind: 'static', values: [] },
                  });
                  return;
                }
                onChange({ widget });
              }}
            />
          </Lbl>
          {(field.widget === 'select' || field.widget === 'lookup') && (
            <Lbl label="Nguồn lựa chọn">
              <select
                value={selectSource}
                onChange={(event) => {
                  const kind = event.target.value as LookupRuntime['kind'];
                  onChange({
                    widget: kind === 'dataset_table' ? 'lookup' : 'select',
                    lookup: {
                      ...(field.lookup || { values: [] }),
                      kind,
                    },
                  });
                }}
                className={INPUT}
              >
                <option value="static">Static</option>
                <option value="dataset_table">From table</option>
              </select>
            </Lbl>
          )}
          {field.widget === 'enum_list' && (
            <Lbl label="Kiểu chọn">
              <select
                value={enumListStyle}
                onChange={(event) =>
                  onChange({
                    enum_list_style: event.target.value as NonNullable<FormFieldSpec['enum_list_style']>,
                  })
                }
                className={INPUT}
              >
                <option value="chips">Chips</option>
                <option value="dropdown">Dropdown</option>
                <option value="checkboxes">Checkbox</option>
              </select>
            </Lbl>
          )}
          {(field.widget === 'select' ||
            field.widget === 'lookup' ||
            field.widget === 'enum_list') && (
            <Lbl label="Ô tìm kiếm khi chọn">
              <select
                value={field.searchable || 'auto'}
                onChange={(event) =>
                  onChange({
                    searchable: event.target.value as NonNullable<FormFieldSpec['searchable']>,
                  })
                }
                className={INPUT}
              >
                <option value="auto">Tự động (khi danh sách dài)</option>
                <option value="always">Luôn hiện</option>
                <option value="never">Tắt</option>
              </select>
            </Lbl>
          )}
        </div>
      </CollapsibleGroup>

      <CollapsibleGroup title="Display">
        <div className={BUILDER_GRID_4}>
          <Lbl label="Content group">
            <select
              value={sectionValue}
              onChange={(event) => onChange({ section: event.target.value || null })}
              className={INPUT}
            >
              <option value="">No group</option>
              {sectionOptions.map((section) => (
                <option key={section} value={section}>
                  {section}
                </option>
              ))}
            </select>
          </Lbl>
          {pageOptions.length > 0 && (
            <Lbl label="Step">
              <select
                value={pageValue ?? ''}
                onChange={(event) =>
                  onChange({
                    page: event.target.value ? Number(event.target.value) : null,
                  })
                }
                className={INPUT}
              >
                <option value="">Default step</option>
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

      <CollapsibleGroup title="Rules">
        <div className="flex flex-wrap gap-2">
          <ToggleChip
            label="Required"
            checked={!!field.required}
            onChange={(checked) => onChange({ required: checked })}
          />
          <ToggleChip
            label="Readonly"
            checked={!!field.readonly}
            onChange={(checked) => onChange({ readonly: checked })}
          />
        </div>
        <Lbl label="Default value (mặc định của trường)">
          <FixedExpressionInput
            value={field.default}
            onChange={(next) => onChange({ default: next })}
            fixedPlaceholder="Fixed value"
            expressionPlaceholder="e.g. {{app_user.username}}"
            expressionOptions={COMMON_EXPRESSION_OPTIONS}
          />
          <p className="mt-1 text-tiny text-text-tertiary">
            Áp dụng khi mở form mới. Thứ tự ưu tiên: giá trị mang sang từ màn
            trước › Initial values (cả form) › Default value này.
          </p>
        </Lbl>
      </CollapsibleGroup>

      {(field.widget === 'select' ||
        field.widget === 'lookup' ||
        field.widget === 'map' ||
        field.widget === 'enum_list') && (
        <CollapsibleGroup title={field.widget === 'map' ? 'Bản đồ / vùng' : 'Options'}>
          <LookupEditor field={field} tables={tables} onChange={onChange} />
        </CollapsibleGroup>
      )}

      {(field.widget === 'computed' ||
        field.widget === 'number' ||
        field.widget === 'images' ||
        field.widget === 'image' ||
        field.widget === 'status' ||
        field.widget === 'rating' ||
        field.widget === 'slider' ||
        field.widget === 'currency' ||
        field.widget === 'qr' ||
        field.widget === 'barcode' ||
        field.widget === 'enum_list') && (
        <CollapsibleGroup title="Cấu hình widget">
          {field.widget === 'rating' && (
            <div className={BUILDER_GRID_2}>
              <Lbl label="Số sao tối đa">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={field.max_stars ?? 5}
                  onChange={(event) =>
                    onChange({ max_stars: Math.min(Math.max(Number(event.target.value) || 5, 1), 10) })
                  }
                  className={INPUT}
                />
              </Lbl>
              <label className="mt-6 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={!!field.allow_half}
                  onChange={(event) => onChange({ allow_half: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Cho nửa sao
              </label>
            </div>
          )}
          {field.widget === 'slider' && (
            <div className={BUILDER_GRID_4}>
              <Lbl label="Min">
                <input
                  type="number"
                  value={field.min_value ?? 0}
                  onChange={(event) => onChange({ min_value: Number(event.target.value) })}
                  className={INPUT}
                />
              </Lbl>
              <Lbl label="Max">
                <input
                  type="number"
                  value={field.max_value ?? 100}
                  onChange={(event) => onChange({ max_value: Number(event.target.value) })}
                  className={INPUT}
                />
              </Lbl>
              <Lbl label="Bước (step)">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={field.step ?? 1}
                  onChange={(event) => onChange({ step: Number(event.target.value) || 1 })}
                  className={INPUT}
                />
              </Lbl>
              <Lbl label="Đơn vị">
                <input
                  value={field.unit || ''}
                  onChange={(event) => onChange({ unit: event.target.value || null })}
                  className={INPUT}
                  placeholder="%"
                />
              </Lbl>
            </div>
          )}
          {field.widget === 'currency' && (
            <Lbl label="Mã / ký hiệu tiền tệ">
              <input
                value={field.currency_code || ''}
                onChange={(event) => onChange({ currency_code: event.target.value || null })}
                className={INPUT}
                placeholder="VND"
              />
            </Lbl>
          )}
          {field.widget === 'enum_list' && (
            <Lbl label="Số lựa chọn tối đa (bỏ trống = không giới hạn)">
              <input
                type="number"
                min={1}
                max={50}
                value={field.max_select ?? ''}
                onChange={(event) =>
                  onChange({ max_select: event.target.value ? Number(event.target.value) : null })
                }
                className={INPUT}
              />
            </Lbl>
          )}
          {field.widget === 'computed' && (
            <Lbl label="Công thức (VD: [san_luong] * [drc] / 100)">
              <input
                value={field.formula || ''}
                onChange={(event) => onChange({ formula: event.target.value || null })}
                className={INPUT}
                placeholder="[san_luong] * [drc] / 100"
              />
            </Lbl>
          )}
          {(field.widget === 'computed' || field.widget === 'number') && (
            <Lbl label="Đơn vị (hậu tố, VD: kg, %)">
              <input
                value={field.unit || ''}
                onChange={(event) => onChange({ unit: event.target.value || null })}
                className={INPUT}
                placeholder="kg"
              />
            </Lbl>
          )}
          {(field.widget === 'image' || field.widget === 'images') && (
            <label className="mt-1 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={!!field.capture_only}
                onChange={(event) => onChange({ capture_only: event.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              Chỉ cho chụp trực tiếp (không chọn từ thư viện)
            </label>
          )}
          {field.widget === 'images' && (
            <Lbl label="Số ảnh tối đa">
              <input
                type="number"
                min={1}
                max={20}
                value={field.max_items ?? 10}
                onChange={(event) =>
                  onChange({ max_items: Math.min(Math.max(Number(event.target.value) || 10, 1), 20) })
                }
                className={INPUT}
              />
            </Lbl>
          )}
          {field.widget === 'status' && (
            <StatusStatesEditor field={field} onChange={onChange} />
          )}
          {field.widget === 'qr' && (
            <div className="space-y-2">
              <Lbl label="Cột nguồn (giá trị mã hoá vào QR)">
                <SingleColumnPicker
                  sourceColumns={tableCols.map((c) => c.name)}
                  value={field.qr_source_column || field.column}
                  onChange={(next) => onChange({ qr_source_column: next || null })}
                  clearable
                />
              </Lbl>
              <Lbl label="Hoặc mẫu giá trị (ưu tiên) — {{app_url}}, [cột]">
                <input
                  value={field.qr_value_template || ''}
                  onChange={(e) => onChange({ qr_value_template: e.target.value || null })}
                  className={INPUT}
                  placeholder="{{app_url}}?screen=capnhat_giao&don_hang_id=[don_hang_id]"
                />
              </Lbl>
              <div className={BUILDER_GRID_2}>
                <Lbl label="Kích thước (px)">
                  <input
                    type="number"
                    min={48}
                    max={1024}
                    value={field.qr_size ?? 160}
                    onChange={(e) => onChange({ qr_size: Number(e.target.value) || 160 })}
                    className={INPUT}
                  />
                </Lbl>
                <Lbl label="Chú thích dưới mã">
                  <input
                    value={field.qr_caption || ''}
                    onChange={(e) => onChange({ qr_caption: e.target.value || null })}
                    className={INPUT}
                  />
                </Lbl>
              </div>
            </div>
          )}
          {field.widget === 'barcode' && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                Sau khi quét được mã, tự chuyển sang màn hình sau (để mở form cập nhật đã điền sẵn).
              </p>
              <Lbl label="Quét xong mở màn hình">
                <select
                  value={field.scan_go_to_screen || ''}
                  onChange={(e) => onChange({ scan_go_to_screen: e.target.value || null })}
                  className={INPUT}
                >
                  <option value="">— Không chuyển (chỉ lưu mã) —</option>
                  {allScreens.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </select>
              </Lbl>
              {field.scan_go_to_screen && (
                <Lbl label="Mang mã sang cột (ở màn hình đích)">
                  <input
                    value={field.scan_carry_as || ''}
                    onChange={(e) => onChange({ scan_carry_as: e.target.value || null })}
                    className={INPUT}
                    placeholder={field.column}
                  />
                </Lbl>
              )}
            </div>
          )}
        </CollapsibleGroup>
      )}

      <CollapsibleGroup title="Advanced" defaultOpen={false}>
        <div className={BUILDER_GRID_4}>
          <Lbl label="Show when (show_if)">
            <input
              value={field.show_if || ''}
              onChange={(event) => onChange({ show_if: event.target.value || null })}
              className={INPUT}
              placeholder="[status] == 'open'"
            />
          </Lbl>
          <Lbl label="Required when (required_if)">
            <input
              value={field.required_if || ''}
              onChange={(event) => onChange({ required_if: event.target.value || null })}
              className={INPUT}
              placeholder="[defect_qty] > 0"
            />
          </Lbl>
          <Lbl label="Readonly when (readonly_if)">
            <input
              value={field.readonly_if || ''}
              onChange={(event) => onChange({ readonly_if: event.target.value || null })}
              className={INPUT}
              placeholder="[submitted] == true"
            />
          </Lbl>
          <Lbl label="Valid when (valid_if)" className="wb-col-span-2">
            <input
              value={field.valid_if || ''}
              onChange={(event) => onChange({ valid_if: event.target.value || null })}
              className={INPUT}
              placeholder="[end_date] >= [start_date]"
            />
          </Lbl>
          <Lbl label="Validation error message" className="wb-col-span-2">
            <input
              value={field.valid_if_error || ''}
              onChange={(event) => onChange({ valid_if_error: event.target.value || null })}
              className={INPUT}
              placeholder="Ngày kết thúc phải ≥ ngày bắt đầu"
            />
          </Lbl>
          <Lbl label="Auto-compute from dataset" className="wb-col-span-2">
            <SingleColumnPicker
              sourceColumns={tableCols.map((column) => column.name)}
              value={computedValue || null}
              onChange={(next) => onChange({ computed_from_dataset: next })}
              placeholder="Not used"
            />
          </Lbl>
          {(field.widget === 'file' || field.widget === 'image') && (
            <Lbl label="Max file size (KB)" className="wb-col-span-2">
              <input
                type="number"
                min={1}
                max={1024}
                value={field.max_file_kb ?? ''}
                onChange={(event) =>
                  onChange({
                    max_file_kb: event.target.value ? Number(event.target.value) : null,
                  })
                }
                className={INPUT}
                placeholder="Mặc định 1024"
              />
            </Lbl>
          )}
        </div>
      </CollapsibleGroup>
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
  const lookup: LookupRuntime = field.lookup || { kind: 'static', values: [] };
  const lookupTable = tables.find((table) => table.id === lookup.table_id);
  const lookupCols = lookupTable?.columns ?? [];

  return (
    <div className="space-y-3">
      <div className={BUILDER_GRID_2}>
        <Lbl label="Source kind">
          <select
            value={lookup.kind}
            onChange={(event) =>
              onChange({
                lookup: {
                  ...lookup,
                  kind: event.target.value as LookupRuntime['kind'],
                },
              })
            }
            className={INPUT}
          >
            <option value="static">Static list</option>
            <option value="dataset_table">From dataset table</option>
          </select>
        </Lbl>

        {lookup.kind === 'dataset_table' && (
          <Lbl label="Source table">
            <SingleColumnPicker
              sourceColumns={tables.map((table) => String(table.id))}
              value={lookup.table_id != null ? String(lookup.table_id) : null}
              onChange={(next) =>
                onChange({
                  lookup: {
                    ...lookup,
                    table_id: next ? Number(next) : null,
                  },
                })
              }
              placeholder="-- pick a table --"
              labelByValue={Object.fromEntries(
                tables.map((table) => [String(table.id), table.display_name]),
              )}
            />
          </Lbl>
        )}

        {lookup.kind === 'dataset_table' && (
          <>
            <Lbl label="Value column">
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.value_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, value_column: next || '' } })}
                placeholder="-- pick a column --"
              />
            </Lbl>
            <Lbl label="Display column">
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.label_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, label_column: next || '' } })}
                placeholder="Default = value column"
              />
            </Lbl>
          </>
        )}

        {lookup.kind === 'dataset_table' && field.widget === 'map' && (
          <>
            <Lbl label="Cột geometry (GeoJSON Polygon)">
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.geometry_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, geometry_column: next || '' } })}
                placeholder="-- cột chứa GeoJSON --"
              />
            </Lbl>
            <Lbl label="Kiểu bản đồ nền">
              <select
                value={lookup.basemap || 'satellite'}
                onChange={(event) =>
                  onChange({
                    lookup: {
                      ...lookup,
                      basemap: event.target.value as NonNullable<LookupRuntime['basemap']>,
                    },
                  })
                }
                className={INPUT}
              >
                <option value="satellite">Vệ tinh</option>
                <option value="streets">Đường phố</option>
                <option value="light">Nền sáng</option>
              </select>
            </Lbl>
            <Lbl label="Cột vĩ độ (lat) — tùy chọn, fallback marker">
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.lat_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, lat_column: next || '' } })}
                placeholder="-- không bắt buộc --"
              />
            </Lbl>
            <Lbl label="Cột kinh độ (lng) — tùy chọn, fallback marker">
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.lng_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, lng_column: next || '' } })}
                placeholder="-- không bắt buộc --"
              />
            </Lbl>
          </>
        )}

        {lookup.kind === 'dataset_table' &&
          (field.widget === 'select' ||
            field.widget === 'lookup' ||
            field.widget === 'enum_list') && (
            <>
              <Lbl label="Lọc theo field (cột form cha) — tùy chọn">
                <input
                  value={lookup.filter_by_field || ''}
                  onChange={(event) =>
                    onChange({ lookup: { ...lookup, filter_by_field: event.target.value || null } })
                  }
                  className={INPUT}
                  placeholder="VD: lo_id (field chọn trước đó)"
                />
              </Lbl>
              <Lbl label="Cột khớp trên bảng nguồn">
                <SingleColumnPicker
                  sourceColumns={lookupCols.map((column) => column.name)}
                  value={lookup.filter_column || null}
                  onChange={(next) => onChange({ lookup: { ...lookup, filter_column: next || '' } })}
                  placeholder="-- cột để lọc --"
                />
              </Lbl>
            </>
          )}
      </div>

      {lookup.kind === 'static' ? (
        <StaticValuesEditor
          values={lookup.values || []}
          onChange={(values) => onChange({ lookup: { ...lookup, values } })}
        />
      ) : (
        <RelationshipPathEditor
          tableId={lookup.table_id ?? null}
          tables={tables}
          path={(lookup.relationship_path || []) as RelationshipHop[]}
          onChange={(next) =>
            onChange({
              lookup: {
                ...lookup,
                relationship_path: next,
              },
            })
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
  path: RelationshipHop[];
  onChange: (next: RelationshipHop[]) => void;
}) {
  const [suggestions, setSuggestions] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const defaultRelationshipTable = tables.find((table) => table.columns.length > 0);
  const defaultRelationshipColumn = defaultRelationshipTable?.columns[0]?.name || null;

  useEffect(() => {
    if (!tableId) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    fetch(`/api/v1/workboard-relationships?from_table_id=${tableId}`, {
      credentials: 'include',
    })
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setSuggestions(Array.isArray(data) ? data : []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [tableId]);

  const updateHop = (index: number, patch: Partial<RelationshipHop>) => {
    const next = path.map((hop, itemIndex) =>
      itemIndex === index ? { ...hop, ...patch } : hop,
    );
    onChange(next);
  };

  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="mb-2">
        <div className="text-caption font-emphasis text-text-secondary">
          Nested relationships
        </div>
        <p className="mt-0.5 text-caption text-text-tertiary">
          Optional chain for resolving display labels through related tables.
        </p>
      </div>

      {loading ? (
        <p className="mb-3 text-caption text-text-tertiary">Loading relationship suggestions...</p>
      ) : suggestions.length > 0 ? (
        <div className="mb-3 space-y-1.5">
          {suggestions.map((suggestion, index) => {
            const targetDisplay = String(suggestion.target_table_display || 'Target table');
            const toCol = String(suggestion.to_column || '');
            const labelCol =
              (suggestion.suggested_label_columns as string[] | undefined)?.[0] || null;
            return (
              <button
                key={index}
                type="button"
                onClick={() =>
                  onChange([
                    {
                      table_id: Number(suggestion.target_table_id),
                      value_column: toCol,
                      label_column: labelCol,
                    },
                  ])
                }
                className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-left text-caption hover:border-brand"
              >
                <span className="font-emphasis text-text-primary">Use {targetDisplay}</span>
                <span className="block text-text-tertiary">
                  Join key: <code className="font-mono">{toCol || 'unknown'}</code>
                  {labelCol ? (
                    <>
                      {' '}
                      - Label: <code className="font-mono">{labelCol}</code>
                    </>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {path.length > 0 ? (
        <div className="space-y-2">
          {path.map((hop, index) => {
            const targetTable = tables.find((table) => table.id === Number(hop.table_id));
            const cols = targetTable?.columns ?? [];
            return (
              <div
                key={index}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2.5"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="rounded bg-brand/10 px-2 py-0.5 text-caption font-emphasis text-brand">
                    Step {index + 1}
                  </span>
                  <BuilderIconButton
                    onClick={() => onChange(path.filter((_, itemIndex) => itemIndex !== index))}
                    title="Delete step"
                    variant="danger"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-danger" />
                  </BuilderIconButton>
                </div>
                <div className={BUILDER_GRID_3}>
                  <Lbl label="Target table">
                    <SingleColumnPicker
                      sourceColumns={tables.map((table) => String(table.id))}
                      value={hop.table_id != null ? String(hop.table_id) : null}
                      onChange={(next) => {
                        const nextTable = tables.find((table) => String(table.id) === next);
                        const firstColumn = nextTable?.columns[0]?.name || null;
                        updateHop(index, {
                          table_id: next ? Number(next) : null,
                          value_column: firstColumn,
                          label_column: null,
                        });
                      }}
                      placeholder="-- pick a table --"
                      clearable={false}
                      labelByValue={Object.fromEntries(
                        tables.map((table) => [String(table.id), table.display_name]),
                      )}
                    />
                  </Lbl>
                  <Lbl label="Join key">
                    <SingleColumnPicker
                      sourceColumns={cols.map((column) => column.name)}
                      value={hop.value_column || null}
                      onChange={(next) => updateHop(index, { value_column: next })}
                      placeholder={targetTable ? '-- pick a column --' : 'Pick a table first'}
                      clearable={false}
                    />
                  </Lbl>
                  <Lbl label="Display column">
                    <SingleColumnPicker
                      sourceColumns={cols.map((column) => column.name)}
                      value={hop.label_column || null}
                      onChange={(next) => updateHop(index, { label_column: next })}
                      placeholder={targetTable ? 'Default = join key' : 'Pick a table first'}
                    />
                  </Lbl>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <BuilderEmptyHint>No relationship steps yet.</BuilderEmptyHint>
      )}

      <BuilderActionButton
        onClick={() =>
          defaultRelationshipTable && defaultRelationshipColumn
            ? onChange([
                ...path,
                {
                  table_id: defaultRelationshipTable.id,
                  value_column: defaultRelationshipColumn,
                  label_column: null,
                },
              ])
            : undefined
        }
        disabled={!defaultRelationshipTable || !defaultRelationshipColumn}
        className="mt-3 w-full justify-center"
      >
        <Plus className="h-3.5 w-3.5" />
        Add step
      </BuilderActionButton>
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
      <div className="text-caption font-emphasis text-text-secondary">Choices</div>
      {values.length > 0 ? (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={index} className="wb-row-static-value">
              <input
                value={value.label}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder="Display label"
                className={INPUT}
              />
              <input
                value={String(value.value ?? '')}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder="Value"
                className={INPUT}
              />
              <BuilderIconButton
                onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
                title="Delete"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      ) : (
        <BuilderEmptyHint>No choices yet.</BuilderEmptyHint>
      )}
      <BuilderActionButton onClick={() => onChange([...values, { label: '', value: '' }])}>
        <Plus className="h-3.5 w-3.5" />
        Add choice
      </BuilderActionButton>
    </div>
  );
}

const STATUS_COLORS = ['slate', 'green', 'amber', 'red', 'blue', 'violet'];

function StatusStatesEditor({
  field,
  onChange,
}: {
  field: FormFieldSpec;
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const cfg = field.status_config || { states: [], editable_by_roles: [] };
  const states = cfg.states || [];
  const setCfg = (patch: Partial<NonNullable<FormFieldSpec['status_config']>>) =>
    onChange({ status_config: { ...cfg, ...patch } });
  const updateState = (
    index: number,
    patch: Partial<{ value: string; label: string; color: string }>,
  ) => {
    const next = states.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setCfg({ states: next });
  };
  return (
    <div className="space-y-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-3">
      <div className="text-caption font-emphasis text-text-secondary">Các trạng thái</div>
      {states.length > 0 ? (
        <div className="space-y-2">
          {states.map((s, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={s.value}
                onChange={(event) => updateState(index, { value: event.target.value })}
                placeholder="giá trị (vd: cho_duyet)"
                className={INPUT}
              />
              <input
                value={s.label || ''}
                onChange={(event) => updateState(index, { label: event.target.value })}
                placeholder="nhãn (vd: Chờ duyệt)"
                className={INPUT}
              />
              <select
                value={s.color || 'slate'}
                onChange={(event) => updateState(index, { color: event.target.value })}
                className={INPUT}
              >
                {STATUS_COLORS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <BuilderIconButton
                onClick={() => setCfg({ states: states.filter((_, i) => i !== index) })}
                title="Delete"
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      ) : (
        <BuilderEmptyHint>Chưa có trạng thái nào.</BuilderEmptyHint>
      )}
      <BuilderActionButton
        onClick={() => setCfg({ states: [...states, { value: '', label: '', color: 'slate' }] })}
      >
        <Plus className="h-3.5 w-3.5" />
        Thêm trạng thái
      </BuilderActionButton>
      <Lbl label="Chỉ role này được đổi trạng thái (cách nhau dấu phẩy) — trống = ai sửa được dòng đều đổi được">
        <input
          value={(cfg.editable_by_roles || []).join(', ')}
          onChange={(event) =>
            setCfg({
              editable_by_roles: event.target.value
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean),
            })
          }
          className={INPUT}
          placeholder="vd: admin, quan_doc"
        />
      </Lbl>
      {states.length > 0 && (
        <div className="space-y-1.5 border-t border-[rgb(var(--border-line))] pt-2">
          <div className="text-caption font-emphasis text-text-secondary">
            Luồng chuyển hợp lệ (bỏ trống = cho chuyển tự do; máy chủ chặn bước sai)
          </div>
          {states.map((s) => {
            const from = s.value;
            const nexts = (cfg.allowed_transitions || {})[from] || [];
            return (
              <div key={from || Math.random()} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-xs text-text-secondary" title={from}>
                  {s.label || from || '—'} →
                </span>
                <input
                  value={nexts.join(', ')}
                  onChange={(event) => {
                    const list = event.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean);
                    const map = { ...(cfg.allowed_transitions || {}) };
                    if (list.length) map[from] = list;
                    else delete map[from];
                    setCfg({ allowed_transitions: map });
                  }}
                  className={INPUT}
                  placeholder="giá trị được phép chuyển tới (vd: dang_giao, huy)"
                  disabled={!from}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
