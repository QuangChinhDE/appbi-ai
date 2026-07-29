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
import { useI18n } from '@/providers/LanguageProvider';

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
type Translate = ReturnType<typeof useI18n>['t'];

type OcrSpec = NonNullable<FormSpec['ocr']>;

type RelationshipHop = {
  table_id?: number | null;
  value_column?: string | null;
  label_column?: string | null;
};

const EMPTY_FORM: FormSpec = { fields: [], initial_values: {} };

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
    category: 'text',
    items: [
      { widget: 'text', label: 'Text' },
      { widget: 'textarea', label: 'Textarea' },
      { widget: 'email', label: 'Email' },
      { widget: 'phone', label: 'Phone' },
      { widget: 'url', label: 'URL' },
      { widget: 'rich_text', label: 'Rich text' },
    ],
  },
  {
    category: 'number',
    items: [
      { widget: 'number', label: 'Number' },
      { widget: 'currency', label: 'Currency' },
      { widget: 'percent', label: 'Percent' },
      { widget: 'slider', label: 'Slider' },
    ],
  },
  {
    category: 'choice',
    items: [
      { widget: 'select', label: 'Select', hint: 'static or table' },
      { widget: 'enum_list', label: 'Multi-select' },
    ],
  },
  {
    category: 'dateTime',
    items: [
      { widget: 'date', label: 'Date' },
      { widget: 'datetime', label: 'Date time' },
      { widget: 'time', label: 'Time' },
      { widget: 'duration', label: 'Duration' },
    ],
  },
  {
    category: 'media',
    items: [
      { widget: 'image', label: 'Image' },
      { widget: 'images', label: 'Images' },
      { widget: 'file', label: 'File' },
      { widget: 'signature', label: 'Signature' },
      { widget: 'audio', label: 'Audio' },
      { widget: 'video', label: 'Video' },
    ],
  },
  {
    category: 'location',
    items: [
      { widget: 'geopoint', label: 'GPS' },
      { widget: 'map', label: 'Map select' },
    ],
  },
  {
    category: 'computed',
    items: [{ widget: 'computed', label: 'Computed' }],
  },
  {
    category: 'workflow',
    items: [{ widget: 'status', label: 'Status', hint: 'roles + transitions' }],
  },
  {
    category: 'specialInput',
    items: [{ widget: 'barcode', label: 'Barcode/QR scan', hint: 'scan input' }],
  },
  {
    category: 'output',
    items: [{ widget: 'qr', label: 'QR code', hint: 'display/print output' }],
  },
  {
    category: 'other',
    items: [
      { widget: 'checkbox', label: 'Checkbox' },
      { widget: 'rating', label: 'Rating' },
      { widget: 'color', label: 'Color' },
    ],
  },
];

const FORM_WIDGET_LABEL_KEYS: Record<string, string> = {
  text: 'workboards.form.widget.text',
  textarea: 'workboards.form.widget.textarea',
  number: 'workboards.form.widget.number',
  select: 'workboards.form.widget.select',
  lookup: 'workboards.form.widget.select',
  date: 'workboards.form.widget.date',
  datetime: 'workboards.form.widget.datetime',
  checkbox: 'workboards.form.widget.checkbox',
  file: 'workboards.form.widget.file',
  image: 'workboards.form.widget.image',
  images: 'workboards.form.widget.images',
  map: 'workboards.form.widget.map',
  geopoint: 'workboards.form.widget.geopoint',
  signature: 'workboards.form.widget.signature',
  barcode: 'workboards.form.widget.barcode',
  audio: 'workboards.form.widget.audio',
  computed: 'workboards.form.widget.computed',
  status: 'workboards.form.widget.status',
  enum_list: 'workboards.form.widget.enumList',
  rating: 'workboards.form.widget.rating',
  slider: 'workboards.form.widget.slider',
  email: 'workboards.form.widget.email',
  phone: 'workboards.form.widget.phone',
  url: 'workboards.form.widget.url',
  rich_text: 'workboards.form.widget.richText',
  currency: 'workboards.form.widget.currency',
  percent: 'workboards.form.widget.percent',
  time: 'workboards.form.widget.time',
  duration: 'workboards.form.widget.duration',
  color: 'workboards.form.widget.color',
  video: 'workboards.form.widget.video',
  qr: 'workboards.form.widget.qr',
};

const FIELD_TYPE_CATEGORY_KEYS = [
  'workboards.form.fieldGroup.text',
  'workboards.form.fieldGroup.number',
  'workboards.form.fieldGroup.choice',
  'workboards.form.fieldGroup.dateTime',
  'workboards.form.fieldGroup.media',
  'workboards.form.fieldGroup.location',
  'workboards.form.fieldGroup.computed',
  'workboards.form.fieldGroup.workflow',
  'workboards.form.fieldGroup.specialInput',
  'workboards.form.fieldGroup.output',
  'workboards.form.fieldGroup.other',
];

const FIELD_TYPE_HINT_KEYS: Partial<Record<string, string>> = {
  select: 'workboards.form.widgetHint.select',
  status: 'workboards.form.widgetHint.status',
  barcode: 'workboards.form.widgetHint.barcode',
  qr: 'workboards.form.widgetHint.qr',
};

function widgetLabel(widget: FormFieldSpec['widget'], t: Translate): string {
  return t(FORM_WIDGET_LABEL_KEYS[widget as string] || 'workboards.form.widget.unknown', {
    widget: String(widget),
  });
}

function fieldTypeHint(widget: FormFieldSpec['widget'], t: Translate): string | null {
  const key = FIELD_TYPE_HINT_KEYS[widget as string];
  return key ? t(key) : null;
}

// Searchable, categorised replacement for the flat 31-item "Field type" select.
// Emits a widget; the caller maps select↔lookup / enum_list defaults exactly as
// the old <select> did, so nothing downstream changes.
function FieldTypePicker({
  widget,
  t,
  onSelect,
}: {
  widget: FormFieldSpec['widget'];
  t: Translate;
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
  const currentLabel = widgetLabel(shown as FormFieldSpec['widget'], t);
  const ql = q.trim().toLowerCase();
  const groups = FIELD_TYPE_GROUPS.map((g, groupIndex) => {
    const category = t(FIELD_TYPE_CATEGORY_KEYS[groupIndex] || 'workboards.form.fieldGroup.other');
    const localizedItems = g.items.map((it) => ({
      ...it,
      label: widgetLabel(it.widget, t),
      hint: fieldTypeHint(it.widget, t),
    }));
    return {
      category,
      items: ql
        ? localizedItems.filter(
            (it) =>
              it.label.toLowerCase().includes(ql) ||
              category.toLowerCase().includes(ql) ||
              (it.hint || '').toLowerCase().includes(ql),
          )
        : localizedItems,
    };
  }).filter((g) => g.items.length > 0);
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
              placeholder={t('workboards.form.fieldTypeSearchPlaceholder')}
              className={INPUT}
            />
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {groups.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                {t('workboards.form.noFieldTypeResults')}
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
  t,
  onAddColumn,
  onAddCustom,
}: {
  columns: { name: string; type?: string }[];
  usedColumns: Set<string>;
  t: Translate;
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
        title={t('workboards.form.addField')}
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
                placeholder={t('workboards.form.sourceColumnSearchPlaceholder')}
                className={INPUT}
              />
            </div>
          )}
          <div className="max-h-64 overflow-auto p-1">
            {columns.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                {t('workboards.form.noSourceColumnsUseCustom')}
              </span>
            ) : available.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                {t('workboards.form.allSourceColumnsAdded')}
              </span>
            ) : filtered.length === 0 ? (
              <span className="block px-2 py-2 text-caption text-text-tertiary">
                {t('workboards.form.noMatchingColumns')}
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
              {t('workboards.form.addCustomField')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function commonExpressionOptions(t: Translate): SelectOption[] {
  return [
    { value: '{{app_user.username}}', label: t('workboards.form.expression.username') },
    { value: '{{app_user.full_name}}', label: t('workboards.form.expression.fullName') },
    { value: '{{app_user.role}}', label: t('workboards.form.expression.role') },
    { value: '{{today}}', label: t('workboards.form.expression.today') },
    { value: '{{now}}', label: t('workboards.form.expression.now') },
  ];
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
  const { t } = useI18n();
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
      label: child ? child.title : t('workboards.form.relatedRecordsFallback'),
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
          title={t('workboards.form.layoutTitle')}
          subtitle={t('workboards.form.layoutSubtitle')}
        >
          <FormLayoutInspector
            t={t}
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
          title={t('workboards.form.submitFlowTitle')}
          subtitle={t('workboards.form.submitFlowSubtitle')}
        >
          <SubmitFlowInspector
            t={t}
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
          title={t('workboards.form.relatedRecordsTitle')}
          subtitle={t('workboards.form.relatedRecordsSubtitle')}
        >
          <RelatedRecordsInspector
            t={t}
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
          title={t('workboards.form.initialValuesTitle')}
          subtitle={t('workboards.form.initialValuesSubtitle')}
        >
          <InitialValuesInspector
            t={t}
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
          title={t('workboards.form.ocrTitle')}
          subtitle={t('workboards.form.ocrSubtitle')}
        >
          <OcrInspector
            t={t}
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
          subtitle={`${widgetLabel(activeField.widget, t)} - ${t('workboards.form.columnLower')} ${activeField.column}${
            activeField.readonly ? ` - ${t('workboards.form.readonlyBadge')}` : ''
          }`}
          action={
            <BuilderIconButton
              onClick={() => removeField(activeFieldIndex)}
              title={t('workboards.form.deleteField')}
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <FieldInspector
            t={t}
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
        title={t('workboards.form.fieldsTitle')}
        subtitle={t('workboards.form.fieldsSubtitle')}
      >
        <BuilderEmptyHint>{t('workboards.form.noFieldsFromLeft')}</BuilderEmptyHint>
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
          {t('workboards.form.pickDataSourceFirst')}
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title={t('workboards.form.objectsTitle')}
          description={t('workboards.form.objectsDescription')}
        >
          <BuilderNavigatorGroup title={t('workboards.form.setupGroup')}>
            <BuilderNavigatorItem
              icon={<LayoutList className="h-3.5 w-3.5" />}
              label={t('workboards.form.layoutTitle')}
              subtitle={
                isMultiStep
                  ? t('workboards.form.layoutMultiStepSubtitle', {
                      steps: pages.length,
                      groups: sections.length,
                    })
                  : t('workboards.form.layoutGroupsSubtitle', { groups: sections.length })
              }
              active={activeItem === 'layout'}
              onClick={() => setActiveItem('layout')}
            />
            <BuilderNavigatorItem
              icon={<Route className="h-3.5 w-3.5" />}
              label={t('workboards.form.submitFlowTitle')}
              subtitle={form.after_submit?.go_to_screen ? t('workboards.form.navigateAfterSave') : t('workboards.form.stayOnThisScreen')}
              active={activeItem === 'submit'}
              onClick={() => setActiveItem('submit')}
            />
            <BuilderNavigatorItem
              icon={<Link2 className="h-3.5 w-3.5" />}
              label={t('workboards.form.relatedRecordsTitle')}
              subtitle={
                relatedRecords.length > 0
                  ? t('workboards.form.relationsCount', { count: relatedRecords.length })
                  : t('workboards.form.noChildFlow')
              }
              active={activeItem === 'related'}
              onClick={() => setActiveItem('related')}
            />
            <BuilderNavigatorItem
              icon={<FileInput className="h-3.5 w-3.5" />}
              label={t('workboards.form.initialValuesTitle')}
              subtitle={t('workboards.form.presetsCount', { count: initialEntries.length })}
              active={activeItem === 'initial'}
              onClick={() => setActiveItem('initial')}
            />
            <BuilderNavigatorItem
              icon={<Camera className="h-3.5 w-3.5" />}
              label={t('workboards.form.ocrTitle')}
              subtitle={form.ocr?.enabled ? t('workboards.form.ocrOnWithProvider', { provider: form.ocr?.provider || 'anthropic' }) : t('workboards.form.off')}
              active={activeItem === 'ocr'}
              onClick={() => setActiveItem('ocr')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={t('workboards.form.fieldsCount', { count: fields.length })}
            action={
              <AddFieldMenu
                columns={tableCols}
                usedColumns={new Set(fields.map((f) => f.column))}
                t={t}
                onAddColumn={addFieldForColumn}
                onAddCustom={addCustomField}
              />
            }
          >
            {tablesLoading ? (
              <p className="rounded-md border border-dashed border-[rgb(var(--border-line))] px-3 py-2 text-caption text-text-tertiary">
                {t('workboards.form.loadingSourceColumns')}
              </p>
            ) : fields.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">{t('workboards.form.noFieldsYet')}</BuilderEmptyHint>
            ) : (
              fields.map((field, index) => (
                <FormFieldNavigatorItem
                  key={`${field.column}:${index}`}
                  field={field}
                  t={t}
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
  t,
  active,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
  canMoveUp,
  canMoveDown,
}: {
  field: FormFieldSpec;
  t: Translate;
  active: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const title = field.label?.trim() || field.column;
  const typeShort = widgetLabel(field.widget, t);

  return (
    <BuilderNavigatorItem
      icon={<GripVertical className="h-3.5 w-3.5" />}
      label={title}
      subtitle={`${typeShort} - ${field.column}${field.required ? ` - ${t('workboards.form.requiredBadge')}` : ''}`}
      active={active}
      onClick={onSelect}
      badge={
        field.readonly ? (
          <span className="rounded bg-surface-2 px-1 text-caption text-text-tertiary">{t('workboards.form.readonlyBadge')}</span>
        ) : null
      }
      action={
        <div className="flex items-center">
          {canMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              className="rounded p-0.5 hover:bg-surface-1"
              title={t('workboards.form.moveUp')}
            >
              <ArrowUp className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          {canMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              className="rounded p-0.5 hover:bg-surface-1"
              title={t('workboards.form.moveDown')}
            >
              <ArrowDown className="h-3 w-3 text-text-tertiary" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-0.5 hover:bg-danger/10"
            title={t('workboards.form.delete')}
          >
            <Trash2 className="h-3 w-3 text-danger" />
          </button>
        </div>
      }
    />
  );
}

function FormLayoutInspector({
  t,
  pages,
  sections,
  isMultiStep,
  onPagesChange,
  onSectionsChange,
}: {
  t: Translate;
  pages: FormPage[];
  sections: string[];
  isMultiStep: boolean;
  onPagesChange: (next: FormPage[]) => void;
  onSectionsChange: (next: string[]) => void;
}) {
  const addStep = () => {
    const nextId = Math.max(0, ...pages.map((page) => page.id)) + 1;
    onPagesChange([...pages, { id: nextId, title: t('workboards.form.stepFallback', { count: nextId }) }]);
  };

  return (
    <div className="space-y-5">
      <div className={BUILDER_GRID_2}>
        <Lbl label={t('workboards.form.groupNames')}>
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
            placeholder={t('workboards.form.groupNamesPlaceholder')}
          />
        </Lbl>
        <Lbl label={t('workboards.form.formFlow')}>
          <select
            value={isMultiStep ? 'multi_step' : 'single_page'}
            onChange={(event) => {
              if (event.target.value === 'multi_step') {
                onPagesChange(isMultiStep ? pages : [{ id: 1, title: t('workboards.form.stepFallback', { count: 1 }) }]);
              } else {
                onPagesChange([]);
              }
            }}
            className={INPUT}
          >
            <option value="single_page">{t('workboards.form.singlePage')}</option>
            <option value="multi_step">{t('workboards.form.multiStepWizard')}</option>
          </select>
        </Lbl>
      </div>

      {isMultiStep ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-caption font-medium text-text-secondary">{t('workboards.form.steps')}</h3>
            <BuilderActionButton onClick={addStep}>
              <Plus className="h-3.5 w-3.5" />
              {t('workboards.form.addStep')}
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
                  placeholder={t('workboards.form.stepTitlePlaceholder')}
                />
                <input
                  value={page.description || ''}
                  onChange={(event) => {
                    const next = [...pages];
                    next[index] = { ...next[index], description: event.target.value || null };
                    onPagesChange(next);
                  }}
                  className={INPUT}
                  placeholder={t('workboards.form.optionalDescriptionPlaceholder')}
                />
                <BuilderIconButton
                  onClick={() => onPagesChange(pages.filter((_, itemIndex) => itemIndex !== index))}
                  title={t('workboards.form.deleteStep')}
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
          {t('workboards.form.singlePageHint')}
        </BuilderEmptyHint>
      )}
    </div>
  );
}

function SubmitFlowInspector({
  t,
  screen,
  form,
  allScreens,
  fieldColumnOptions,
  onChange,
}: {
  t: Translate;
  screen: ScreenSpec;
  form: FormSpec;
  allScreens: ScreenSpec[];
  fieldColumnOptions: string[];
  onChange: (patch: Partial<FormSpec>) => void;
}) {
  return (
    <div className={BUILDER_GRID_2}>
      <Lbl label={t('workboards.form.submitButtonLabel')}>
        <input
          value={form.submit_label || ''}
          onChange={(event) => onChange({ submit_label: event.target.value })}
          className={INPUT}
          placeholder={t('workboards.form.savePlaceholder')}
        />
      </Lbl>
      <Lbl label={t('workboards.form.afterSuccessfulSave')}>
        <select
          value={form.after_submit?.go_to_screen || ''}
          onChange={(event) =>
            onChange({
              after_submit: event.target.value
                ? {
                    id: form.after_submit?.id || 'after-submit',
                    label: form.after_submit?.label || t('workboards.form.savedLabel'),
                    go_to_screen: event.target.value,
                    carry: form.after_submit?.carry || [],
                  }
                : null,
            })
          }
          className={INPUT}
        >
          <option value="">{t('workboards.form.stayOnThisScreen')}</option>
          {allScreens
            .filter((item) => item.id !== screen.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {t('workboards.form.goToScreen', { title: item.title })}
              </option>
            ))}
        </select>
      </Lbl>
      {form.after_submit?.go_to_screen && (
        <Lbl label={t('workboards.form.carryValuesToNextScreen')} className="wb-col-span-2">
          {fieldColumnOptions.length > 0 ? (
            <MultiColumnPicker
              sourceColumns={fieldColumnOptions}
              value={form.after_submit.carry || []}
              onChange={(carry) =>
                onChange({
                  after_submit: { ...form.after_submit!, carry },
                })
              }
              placeholder={t('workboards.form.pickCarryColumnsPlaceholder')}
              emptyHint={t('workboards.form.noFieldsAvailableToCarry')}
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
      <Lbl label={t('workboards.form.geoStampLabel')} className="wb-col-span-2">
        <input
          value={form.geo_stamp_column || ''}
          onChange={(event) => onChange({ geo_stamp_column: event.target.value || null })}
          className={INPUT}
          placeholder={t('workboards.form.geoStampPlaceholder')}
        />
      </Lbl>
    </div>
  );
}

function RelatedRecordsInspector({
  t,
  screen,
  allScreens,
  tables,
  parentColumns,
  relations,
  onAdd,
  onChange,
  onRemove,
}: {
  t: Translate;
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
          {t('workboards.form.relatedHelp')}
        </div>
        <BuilderActionButton
          onClick={onAdd}
          disabled={parentColumns.length === 0 || childScreens.length === 0}
        >
          <Plus className="h-3.5 w-3.5" /> {t('workboards.form.addRelation')}
        </BuilderActionButton>
      </div>

      {parentColumns.length === 0 ? (
        <BuilderEmptyHint className="text-left">
          {t('workboards.form.parentKeyRequired')}
        </BuilderEmptyHint>
      ) : null}

      {relations.length === 0 ? (
        <BuilderEmptyHint className="text-left">
          {t('workboards.form.noChildFlowHint')}
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
                    {relation.label || relation.id || t('workboards.form.relatedRecordsFallback')}
                  </div>
                  <div className="truncate text-tiny text-text-tertiary">
                    {relation.parent_key_column || t('workboards.form.parentKeyFallback')} {'->'} {relation.child_foreign_key_column || t('workboards.form.childFkFallback')}
                  </div>
                </div>
                <BuilderIconButton
                  onClick={() => onRemove(index)}
                  title={t('workboards.form.deleteRelation')}
                  variant="danger"
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </BuilderIconButton>
              </div>

              <div className="space-y-3">
                <div className={BUILDER_GRID_2}>
                  <Lbl label={t('workboards.form.relationId')}>
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
                  <Lbl label={t('workboards.form.displayLabel')}>
                    <input
                      value={relation.label || ''}
                      onChange={(event) => onChange(index, { label: event.target.value || null })}
                      className={INPUT}
                      placeholder={t('workboards.form.relationLabelPlaceholder')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.form.childScreen')}>
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
                      <option value="">{t('workboards.form.pickChildScreen')}</option>
                      {childScreens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Lbl>
                  <Lbl label={t('workboards.form.finishScreen')}>
                    <select
                      value={relation.finish_screen_id || ''}
                      onChange={(event) =>
                        onChange(index, { finish_screen_id: event.target.value || null })
                      }
                      className={INPUT}
                    >
                      <option value="">{t('workboards.form.stayOnChildScreen')}</option>
                      {finishScreens.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Lbl>
                  <Lbl label={t('workboards.form.parentKey')}>
                    <SingleColumnPicker
                      sourceColumns={parentColumns}
                      value={relation.parent_key_column || null}
                      onChange={(next) => onChange(index, { parent_key_column: next || '' })}
                      placeholder={t('workboards.form.pickParentKey')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.form.childForeignKey')}>
                    <SingleColumnPicker
                      sourceColumns={childColumns}
                      value={relation.child_foreign_key_column || null}
                      onChange={(next) => onChange(index, { child_foreign_key_column: next || '' })}
                      placeholder={t('workboards.form.pickChildFk')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.form.whenParentDeleted')}>
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
                      <option value="restrict">{t('workboards.form.deleteRestrict')}</option>
                      <option value="cascade">{t('workboards.form.deleteCascade')}</option>
                      <option value="unlink">{t('workboards.form.deleteUnlink')}</option>
                    </select>
                  </Lbl>
                </div>

                <Lbl label={t('workboards.form.childListDisplayColumns')}>
                  <MultiColumnPicker
                    sourceColumns={childColumns}
                    value={relation.display_columns || []}
                    onChange={(display_columns) => onChange(index, { display_columns })}
                    placeholder={t('workboards.form.pickChildListColumns')}
                    emptyHint={t('workboards.form.pickChildScreenFirst')}
                  />
                </Lbl>

                <div className="flex flex-wrap gap-2">
                  <ToggleChip
                    label={t('workboards.form.allowMultiple')}
                    checked={relation.allow_multiple !== false}
                    onChange={(allow_multiple) => onChange(index, { allow_multiple })}
                  />
                  <ToggleChip
                    label={t('workboards.form.showExisting')}
                    checked={relation.show_existing !== false}
                    onChange={(show_existing) => onChange(index, { show_existing })}
                  />
                  <ToggleChip
                    label={t('workboards.form.addAfterSave')}
                    checked={relation.allow_add_after_save !== false}
                    onChange={(allow_add_after_save) =>
                      onChange(index, { allow_add_after_save })
                    }
                  />
                  <ToggleChip
                    label={t('workboards.form.keepContext')}
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
  t,
  ocr,
  onChange,
  workboardId,
  screenId,
}: {
  t: Translate;
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
          ? { ok: true, msg: r.model ? t('workboards.form.ocrConnectionSuccessWithModel', { model: r.model }) : t('workboards.form.ocrConnectionSuccess') }
          : { ok: false, msg: r.message || t('workboards.form.ocrConnectionFailed') },
      );
    } catch {
      setTestResult({ ok: false, msg: t('workboards.form.ocrConnectionServerFailed') });
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
          {t('workboards.form.ocrEnableLabel')}
          <span className="block text-caption text-text-tertiary">
            {t('workboards.form.ocrEnableDescription')}
          </span>
        </span>
      </label>

      {ocr.enabled && (
        <div className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
          <div className={BUILDER_GRID_2}>
            <Lbl label={t('workboards.form.ocrProvider')}>
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
                  <option value={ocr.model}>{t('workboards.form.ocrCustomModel', { model: ocr.model })}</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Lbl>
          </div>
          <Lbl label={t('workboards.form.ocrToken')}>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                value={ocr.api_key || ''}
                onChange={(e) => patch({ api_key: e.target.value })}
                className={`${INPUT} pr-10`}
                placeholder={
                  ocr.api_key_set
                    ? t('workboards.form.ocrSavedTokenPlaceholder')
                    : t('workboards.form.ocrTokenPlaceholder')
                }
              />
              {(ocr.api_key_set || hasTyped) && (
                <button
                  type="button"
                  onClick={toggleEye}
                  title={showKey ? t('workboards.form.ocrHideToken') : t('workboards.form.ocrShowToken')}
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
              {t('workboards.form.ocrTokenHelp')}
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runConnTest}
                disabled={testing || !canTest}
                title={
                  canTest
                    ? t('workboards.form.ocrTestTitle')
                    : t('workboards.form.ocrTestDisabledTitle')
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-2.5 py-1.5 text-caption font-medium text-text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {testing ? t('workboards.form.ocrTesting') : t('workboards.form.ocrTestConnection')}
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
          <Lbl label={t('workboards.form.ocrPromptLabel')}>
            <textarea
              value={ocr.hint || ''}
              onChange={(e) => patch({ hint: e.target.value })}
              className={INPUT}
              rows={3}
              placeholder={t('workboards.form.ocrPromptPlaceholder')}
            />
            <span className="mt-1 block text-caption text-text-tertiary">
              {t('workboards.form.ocrPromptHelp')}
            </span>
          </Lbl>
        </div>
      )}
    </div>
  );
}

function InitialValuesInspector({
  t,
  entries,
  fieldOptions,
  allValues,
  allFieldsUsed,
  onAdd,
  onChange,
  onRemove,
}: {
  t: Translate;
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
          {t('workboards.form.initialValuesHelp')}
        </p>
        <BuilderActionButton
          onClick={onAdd}
          disabled={fieldOptions.length === 0 || allFieldsUsed}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('workboards.form.addInitialValue')}
        </BuilderActionButton>
      </div>
      {entries.length === 0 ? (
        <BuilderEmptyHint>{t('workboards.form.noInitialValues')}</BuilderEmptyHint>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <InitialValueRow
              key={key}
              fieldKey={key}
              t={t}
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
  t,
  value,
  fieldOptions,
  allValues,
  onChange,
  onRemove,
}: {
  fieldKey: string;
  t: Translate;
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
          placeholder={t('workboards.form.columnNamePlaceholder')}
        />
      )}
      <FixedExpressionInput
        value={value}
        onChange={(next) => onChange(fieldKey, fieldKey, next)}
        fixedPlaceholder={t('workboards.form.fixedValuePlaceholder')}
        expressionPlaceholder={t('workboards.form.expressionPlaceholder')}
        expressionOptions={commonExpressionOptions(t)}
      />
      <BuilderIconButton onClick={onRemove} title={t('workboards.form.delete')} variant="danger">
        <Trash2 className="h-3.5 w-3.5 text-danger" />
      </BuilderIconButton>
    </div>
  );
}

function FieldInspector({
  t,
  field,
  tableCols,
  tables,
  pageOptions,
  sectionOptions,
  allScreens,
  onChange,
}: {
  t: Translate;
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
      <CollapsibleGroup title={t('workboards.form.basicGroup')}>
        <div className={BUILDER_GRID_3}>
          <Lbl label={t('workboards.form.column')}>
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
          <Lbl label={t('workboards.form.displayLabel')}>
            <input
              value={field.label || ''}
              onChange={(event) => onChange({ label: event.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label={t('workboards.form.fieldType')}>
            <FieldTypePicker
              widget={field.widget}
              t={t}
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
            <Lbl label={t('workboards.form.choiceSource')}>
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
                <option value="static">{t('workboards.form.choiceSourceStatic')}</option>
                <option value="dataset_table">{t('workboards.form.choiceSourceTable')}</option>
              </select>
            </Lbl>
          )}
          {field.widget === 'enum_list' && (
            <Lbl label={t('workboards.form.enumListStyle')}>
              <select
                value={enumListStyle}
                onChange={(event) =>
                  onChange({
                    enum_list_style: event.target.value as NonNullable<FormFieldSpec['enum_list_style']>,
                  })
                }
                className={INPUT}
              >
                <option value="chips">{t('workboards.form.enumListStyle.chips')}</option>
                <option value="dropdown">{t('workboards.form.enumListStyle.dropdown')}</option>
                <option value="checkboxes">{t('workboards.form.enumListStyle.checkbox')}</option>
              </select>
            </Lbl>
          )}
          {(field.widget === 'select' ||
            field.widget === 'lookup' ||
            field.widget === 'enum_list') && (
            <Lbl label={t('workboards.form.choiceSearchMode')}>
              <select
                value={field.searchable || 'auto'}
                onChange={(event) =>
                  onChange({
                    searchable: event.target.value as NonNullable<FormFieldSpec['searchable']>,
                  })
                }
                className={INPUT}
              >
                <option value="auto">{t('workboards.form.choiceSearchAuto')}</option>
                <option value="always">{t('workboards.form.choiceSearchAlways')}</option>
                <option value="never">{t('workboards.form.choiceSearchNever')}</option>
              </select>
            </Lbl>
          )}
        </div>
      </CollapsibleGroup>

      <CollapsibleGroup title={t('workboards.form.displayGroup')}>
        <div className={BUILDER_GRID_4}>
          <Lbl label={t('workboards.form.contentGroup')}>
            <select
              value={sectionValue}
              onChange={(event) => onChange({ section: event.target.value || null })}
              className={INPUT}
            >
              <option value="">{t('workboards.form.noGroup')}</option>
              {sectionOptions.map((section) => (
                <option key={section} value={section}>
                  {section}
                </option>
              ))}
            </select>
          </Lbl>
          {pageOptions.length > 0 && (
            <Lbl label={t('workboards.form.step')}>
              <select
                value={pageValue ?? ''}
                onChange={(event) =>
                  onChange({
                    page: event.target.value ? Number(event.target.value) : null,
                  })
                }
                className={INPUT}
              >
                <option value="">{t('workboards.form.defaultStep')}</option>
                {pageOptions.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.id}. {page.title}
                  </option>
                ))}
              </select>
            </Lbl>
          )}
          <Lbl label={t('workboards.form.placeholderLabel')}>
            <input
              value={field.placeholder || ''}
              onChange={(event) => onChange({ placeholder: event.target.value })}
              className={INPUT}
            />
          </Lbl>
          <Lbl label={t('workboards.form.helpText')}>
            <input
              value={field.help_text || ''}
              onChange={(event) => onChange({ help_text: event.target.value })}
              className={INPUT}
            />
          </Lbl>
        </div>
      </CollapsibleGroup>

      <CollapsibleGroup title={t('workboards.form.rulesGroup')}>
        <div className="flex flex-wrap gap-2">
          <ToggleChip
            label={t('workboards.form.required')}
            checked={!!field.required}
            onChange={(checked) => onChange({ required: checked })}
          />
          <ToggleChip
            label={t('workboards.form.readonly')}
            checked={!!field.readonly}
            onChange={(checked) => onChange({ readonly: checked })}
          />
        </div>
        <Lbl label={t('workboards.form.defaultValueLabel')}>
          <FixedExpressionInput
            value={field.default}
            onChange={(next) => onChange({ default: next })}
            fixedPlaceholder={t('workboards.form.fixedValuePlaceholder')}
            expressionPlaceholder={t('workboards.form.expressionPlaceholder')}
            expressionOptions={commonExpressionOptions(t)}
          />
          <p className="mt-1 text-tiny text-text-tertiary">
            {t('workboards.form.defaultValueHelp')}
          </p>
        </Lbl>
      </CollapsibleGroup>

      {(field.widget === 'select' ||
        field.widget === 'lookup' ||
        field.widget === 'map' ||
        field.widget === 'enum_list') && (
        <CollapsibleGroup title={field.widget === 'map' ? t('workboards.form.mapAreaGroup') : t('workboards.form.optionsGroup')}>
          <LookupEditor t={t} field={field} tables={tables} onChange={onChange} />
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
        <CollapsibleGroup title={t('workboards.form.widgetConfigGroup')}>
          {field.widget === 'rating' && (
            <div className={BUILDER_GRID_2}>
              <Lbl label={t('workboards.form.maxStars')}>
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
                {t('workboards.form.allowHalfStars')}
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
              <Lbl label={t('workboards.form.stepSize')}>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={field.step ?? 1}
                  onChange={(event) => onChange({ step: Number(event.target.value) || 1 })}
                  className={INPUT}
                />
              </Lbl>
              <Lbl label={t('workboards.form.unit')}>
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
            <Lbl label={t('workboards.form.currencyCode')}>
              <input
                value={field.currency_code || ''}
                onChange={(event) => onChange({ currency_code: event.target.value || null })}
                className={INPUT}
                placeholder="VND"
              />
            </Lbl>
          )}
          {field.widget === 'enum_list' && (
            <Lbl label={t('workboards.form.maxSelect')}>
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
            <Lbl label={t('workboards.form.formulaLabel')}>
              <input
                value={field.formula || ''}
                onChange={(event) => onChange({ formula: event.target.value || null })}
                className={INPUT}
                placeholder="[san_luong] * [drc] / 100"
              />
              <p className="mt-1 text-tiny text-text-tertiary">
                {t('workboards.form.formulaHelpPrefix')}{' '}
                <code>SUM_SPLIT([cot])</code>{' '}
                {t('workboards.form.formulaHelpMiddle')}{' '}
                <code>&quot;20;31;25&quot;</code> → 76. {t('workboards.form.formulaHelpSuffix')}{' '}
                <code>SUM_SPLIT([cot], &quot;|&quot;)</code>.
              </p>
            </Lbl>
          )}
          {(field.widget === 'computed' || field.widget === 'number') && (
            <Lbl label={t('workboards.form.unitSuffix')}>
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
              {t('workboards.form.captureOnly')}
            </label>
          )}
          {field.widget === 'images' && (
            <Lbl label={t('workboards.form.maxImages')}>
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
            <StatusStatesEditor t={t} field={field} onChange={onChange} />
          )}
          {field.widget === 'qr' && (
            <div className="space-y-2">
              <Lbl label={t('workboards.form.qrSourceColumn')}>
                <SingleColumnPicker
                  sourceColumns={tableCols.map((c) => c.name)}
                  value={field.qr_source_column || field.column}
                  onChange={(next) => onChange({ qr_source_column: next || null })}
                  clearable
                />
              </Lbl>
              <Lbl label={t('workboards.form.qrValueTemplate')}>
                <input
                  value={field.qr_value_template || ''}
                  onChange={(e) => onChange({ qr_value_template: e.target.value || null })}
                  className={INPUT}
                  placeholder="{{app_url}}?screen=capnhat_giao&don_hang_id=[don_hang_id]"
                />
              </Lbl>
              <div className={BUILDER_GRID_2}>
                <Lbl label={t('workboards.form.qrSize')}>
                  <input
                    type="number"
                    min={48}
                    max={1024}
                    value={field.qr_size ?? 160}
                    onChange={(e) => onChange({ qr_size: Number(e.target.value) || 160 })}
                    className={INPUT}
                  />
                </Lbl>
                <Lbl label={t('workboards.form.qrCaption')}>
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
                {t('workboards.form.barcodeHelp')}
              </p>
              <Lbl label={t('workboards.form.scanGoToScreen')}>
                <select
                  value={field.scan_go_to_screen || ''}
                  onChange={(e) => onChange({ scan_go_to_screen: e.target.value || null })}
                  className={INPUT}
                >
                  <option value="">{t('workboards.form.scanNoNavigation')}</option>
                  {allScreens.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </select>
              </Lbl>
              {field.scan_go_to_screen && (
                <Lbl label={t('workboards.form.scanCarryAs')}>
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

      <CollapsibleGroup title={t('workboards.form.advancedGroup')} defaultOpen={false}>
        <div className={BUILDER_GRID_4}>
          <Lbl label={t('workboards.form.showWhen')}>
            <input
              value={field.show_if || ''}
              onChange={(event) => onChange({ show_if: event.target.value || null })}
              className={INPUT}
              placeholder="[status] == 'open'"
            />
          </Lbl>
          <Lbl label={t('workboards.form.requiredWhen')}>
            <input
              value={field.required_if || ''}
              onChange={(event) => onChange({ required_if: event.target.value || null })}
              className={INPUT}
              placeholder="[defect_qty] > 0"
            />
          </Lbl>
          <Lbl label={t('workboards.form.readonlyWhen')}>
            <input
              value={field.readonly_if || ''}
              onChange={(event) => onChange({ readonly_if: event.target.value || null })}
              className={INPUT}
              placeholder="[submitted] == true"
            />
          </Lbl>
          <Lbl label={t('workboards.form.validWhen')} className="wb-col-span-2">
            <input
              value={field.valid_if || ''}
              onChange={(event) => onChange({ valid_if: event.target.value || null })}
              className={INPUT}
              placeholder="[end_date] >= [start_date]"
            />
          </Lbl>
          <Lbl label={t('workboards.form.validationErrorMessage')} className="wb-col-span-2">
            <input
              value={field.valid_if_error || ''}
              onChange={(event) => onChange({ valid_if_error: event.target.value || null })}
              className={INPUT}
              placeholder={t('workboards.form.validationErrorPlaceholder')}
            />
          </Lbl>
          <Lbl label={t('workboards.form.autoComputeFromDataset')} className="wb-col-span-2">
            <SingleColumnPicker
              sourceColumns={tableCols.map((column) => column.name)}
              value={computedValue || null}
              onChange={(next) => onChange({ computed_from_dataset: next })}
              placeholder={t('workboards.form.notUsed')}
            />
          </Lbl>
          {(field.widget === 'file' || field.widget === 'image') && (
            <Lbl label={t('workboards.form.maxFileSizeKb')} className="wb-col-span-2">
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
                placeholder={t('workboards.form.default1024')}
              />
            </Lbl>
          )}
        </div>
      </CollapsibleGroup>
    </div>
  );
}

function LookupEditor({
  t,
  field,
  tables,
  onChange,
}: {
  t: Translate;
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
        <Lbl label={t('workboards.form.sourceKind')}>
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
            <option value="static">{t('workboards.form.staticList')}</option>
            <option value="dataset_table">{t('workboards.form.fromDatasetTable')}</option>
          </select>
        </Lbl>

        {lookup.kind === 'dataset_table' && (
          <Lbl label={t('workboards.form.sourceTable')}>
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
              placeholder={t('workboards.form.pickTablePlaceholder')}
              labelByValue={Object.fromEntries(
                tables.map((table) => [String(table.id), table.display_name]),
              )}
            />
          </Lbl>
        )}

        {lookup.kind === 'dataset_table' && (
          <>
            <Lbl label={t('workboards.form.valueColumn')}>
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.value_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, value_column: next || '' } })}
                placeholder={t('workboards.form.pickColumnPlaceholder')}
              />
            </Lbl>
            <Lbl label={t('workboards.form.displayColumn')}>
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.label_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, label_column: next || '' } })}
                placeholder={t('workboards.form.defaultValueColumn')}
              />
            </Lbl>
          </>
        )}

        {lookup.kind === 'dataset_table' && field.widget === 'map' && (
          <>
            <Lbl label={t('workboards.form.geometryColumn')}>
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.geometry_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, geometry_column: next || '' } })}
                placeholder={t('workboards.form.geoJsonColumnPlaceholder')}
              />
            </Lbl>
            <Lbl label={t('workboards.form.basemap')}>
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
                <option value="satellite">{t('workboards.form.basemapSatellite')}</option>
                <option value="streets">{t('workboards.form.basemapStreets')}</option>
                <option value="light">{t('workboards.form.basemapLight')}</option>
              </select>
            </Lbl>
            <Lbl label={t('workboards.form.latColumn')}>
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.lat_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, lat_column: next || '' } })}
                placeholder={t('workboards.form.optionalPlaceholder')}
              />
            </Lbl>
            <Lbl label={t('workboards.form.lngColumn')}>
              <SingleColumnPicker
                sourceColumns={lookupCols.map((column) => column.name)}
                value={lookup.lng_column || null}
                onChange={(next) => onChange({ lookup: { ...lookup, lng_column: next || '' } })}
                placeholder={t('workboards.form.optionalPlaceholder')}
              />
            </Lbl>
          </>
        )}

        {lookup.kind === 'dataset_table' &&
          (field.widget === 'select' ||
            field.widget === 'lookup' ||
            field.widget === 'enum_list') && (
            <>
              <Lbl label={t('workboards.form.filterByField')}>
                <input
                  value={lookup.filter_by_field || ''}
                  onChange={(event) =>
                    onChange({ lookup: { ...lookup, filter_by_field: event.target.value || null } })
                  }
                  className={INPUT}
                  placeholder={t('workboards.form.filterByFieldPlaceholder')}
                />
              </Lbl>
              <Lbl label={t('workboards.form.filterColumn')}>
                <SingleColumnPicker
                  sourceColumns={lookupCols.map((column) => column.name)}
                  value={lookup.filter_column || null}
                  onChange={(next) => onChange({ lookup: { ...lookup, filter_column: next || '' } })}
                  placeholder={t('workboards.form.filterColumnPlaceholder')}
                />
              </Lbl>
            </>
          )}
      </div>

      {lookup.kind === 'static' ? (
        <StaticValuesEditor
          t={t}
          values={lookup.values || []}
          onChange={(values) => onChange({ lookup: { ...lookup, values } })}
        />
      ) : (
        <RelationshipPathEditor
          t={t}
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
  t,
  tableId,
  tables,
  path,
  onChange,
}: {
  t: Translate;
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
          {t('workboards.form.nestedRelationships')}
        </div>
        <p className="mt-0.5 text-caption text-text-tertiary">
          {t('workboards.form.nestedRelationshipsHelp')}
        </p>
      </div>

      {loading ? (
        <p className="mb-3 text-caption text-text-tertiary">{t('workboards.form.loadingRelationshipSuggestions')}</p>
      ) : suggestions.length > 0 ? (
        <div className="mb-3 space-y-1.5">
          {suggestions.map((suggestion, index) => {
            const targetDisplay = String(suggestion.target_table_display || t('workboards.form.targetTableFallback'));
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
                <span className="font-emphasis text-text-primary">{t('workboards.form.useTargetTable', { table: targetDisplay })}</span>
                <span className="block text-text-tertiary">
                  {t('workboards.form.joinKey')}: <code className="font-mono">{toCol || t('workboards.form.unknown')}</code>
                  {labelCol ? (
                    <>
                      {' '}
                      - {t('workboards.form.labelColumnShort')}: <code className="font-mono">{labelCol}</code>
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
                    {t('workboards.form.stepFallback', { count: index + 1 })}
                  </span>
                  <BuilderIconButton
                    onClick={() => onChange(path.filter((_, itemIndex) => itemIndex !== index))}
                    title={t('workboards.form.deleteStep')}
                    variant="danger"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-danger" />
                  </BuilderIconButton>
                </div>
                <div className={BUILDER_GRID_3}>
                  <Lbl label={t('workboards.form.targetTable')}>
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
                      placeholder={t('workboards.form.pickTablePlaceholder')}
                      clearable={false}
                      labelByValue={Object.fromEntries(
                        tables.map((table) => [String(table.id), table.display_name]),
                      )}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.form.joinKey')}>
                    <SingleColumnPicker
                      sourceColumns={cols.map((column) => column.name)}
                      value={hop.value_column || null}
                      onChange={(next) => updateHop(index, { value_column: next })}
                      placeholder={targetTable ? t('workboards.form.pickColumnPlaceholder') : t('workboards.form.pickTableFirst')}
                      clearable={false}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.form.displayColumn')}>
                    <SingleColumnPicker
                      sourceColumns={cols.map((column) => column.name)}
                      value={hop.label_column || null}
                      onChange={(next) => updateHop(index, { label_column: next })}
                      placeholder={targetTable ? t('workboards.form.defaultJoinKey') : t('workboards.form.pickTableFirst')}
                    />
                  </Lbl>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <BuilderEmptyHint>{t('workboards.form.noRelationshipSteps')}</BuilderEmptyHint>
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
        {t('workboards.form.addStep')}
      </BuilderActionButton>
    </div>
  );
}

function StaticValuesEditor({
  t,
  values,
  onChange,
}: {
  t: Translate;
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
      <div className="text-caption font-emphasis text-text-secondary">{t('workboards.form.choices')}</div>
      {values.length > 0 ? (
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={index} className="wb-row-static-value">
              <input
                value={value.label}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder={t('workboards.form.displayLabel')}
                className={INPUT}
              />
              <input
                value={String(value.value ?? '')}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={t('workboards.form.value')}
                className={INPUT}
              />
              <BuilderIconButton
                onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
                title={t('workboards.form.delete')}
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      ) : (
        <BuilderEmptyHint>{t('workboards.form.noChoices')}</BuilderEmptyHint>
      )}
      <BuilderActionButton onClick={() => onChange([...values, { label: '', value: '' }])}>
        <Plus className="h-3.5 w-3.5" />
        {t('workboards.form.addChoice')}
      </BuilderActionButton>
    </div>
  );
}

const STATUS_COLORS = ['slate', 'green', 'amber', 'red', 'blue', 'violet'];

function StatusStatesEditor({
  t,
  field,
  onChange,
}: {
  t: Translate;
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
      <div className="text-caption font-emphasis text-text-secondary">{t('workboards.form.statusStates')}</div>
      {states.length > 0 ? (
        <div className="space-y-2">
          {states.map((s, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={s.value}
                onChange={(event) => updateState(index, { value: event.target.value })}
                placeholder={t('workboards.form.statusValuePlaceholder')}
                className={INPUT}
              />
              <input
                value={s.label || ''}
                onChange={(event) => updateState(index, { label: event.target.value })}
                placeholder={t('workboards.form.statusLabelPlaceholder')}
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
                title={t('workboards.form.delete')}
                variant="danger"
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      ) : (
        <BuilderEmptyHint>{t('workboards.form.noStatusStates')}</BuilderEmptyHint>
      )}
      <BuilderActionButton
        onClick={() => setCfg({ states: [...states, { value: '', label: '', color: 'slate' }] })}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('workboards.form.addStatusState')}
      </BuilderActionButton>
      <Lbl label={t('workboards.form.statusEditableRoles')}>
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
          placeholder={t('workboards.form.statusRolesPlaceholder')}
        />
      </Lbl>
      {states.length > 0 && (
        <div className="space-y-1.5 border-t border-[rgb(var(--border-line))] pt-2">
          <div className="text-caption font-emphasis text-text-secondary">
            {t('workboards.form.statusTransitions')}
          </div>
          {states.map((s) => {
            const from = s.value;
            const nexts = (cfg.allowed_transitions || {})[from] || [];
            return (
              <div key={from || Math.random()} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-xs text-text-secondary" title={from}>
                  {s.label || from || t('workboards.form.emptyDash')} →
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
                  placeholder={t('workboards.form.statusTransitionsPlaceholder')}
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
