/**
 * FormScreenEditor - object-based form configuration.
 */
'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileInput,
  GripVertical,
  LayoutList,
  Plus,
  Route,
  Trash2,
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
  DataSourcePicker,
} from './BuilderChrome';
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
  focusFieldColumn?: string | null;
  onFocusFieldHandled?: () => void;
}

type FormSpec = NonNullable<ScreenSpec['form']>;
type FormPage = NonNullable<FormSpec['pages']>[number];
type LookupRuntime = NonNullable<FormFieldSpec['lookup']>;
type FormActiveItem = 'layout' | 'submit' | 'initial' | `field:${number}`;

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
  { value: 'select', label: 'Select (static)' },
  { value: 'lookup', label: 'Select (from table)' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
  { value: 'checkbox', label: 'On / off' },
];

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
}: Props) {
  const form = screen.form || EMPTY_FORM;
  const fields = form.fields || [];
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];
  const fieldColumnOptions = Array.from(
    new Set(fields.map((field) => field.column).filter(Boolean)),
  );
  const pages = form.pages || [];
  const sections = form.sections || [];
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

  const addField = () => {
    const usedColumns = new Set(fields.map((field) => field.column));
    const unusedCol = tableCols.find((column) => !usedColumns.has(column.name));
    const column = unusedCol?.name || `field_${fields.length + 1}`;
    updateForm({
      fields: [
        ...fields,
        { column, widget: 'text', label: column, required: false },
      ],
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

    if (activeItem === 'initial') {
      return (
        <BuilderInspectorPanel
          icon={<FileInput className="h-4 w-4" />}
          title="Initial values"
          subtitle="Pre-fill form fields when the screen opens."
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

      {!screen.table_id ? (
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
              icon={<FileInput className="h-3.5 w-3.5" />}
              label="Initial values"
              subtitle={`${initialEntries.length} preset${initialEntries.length === 1 ? '' : 's'}`}
              active={activeItem === 'initial'}
              onClick={() => setActiveItem('initial')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Fields (${fields.length})`}
            action={
              <button
                type="button"
                onClick={addField}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"
                title="Add field"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
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
  onChange,
}: {
  field: FormFieldSpec;
  tableCols: { name: string; type?: string }[];
  tables: DatasetTableInfo[];
  pageOptions: FormPage[];
  sectionOptions: string[];
  onChange: (patch: Partial<FormFieldSpec>) => void;
}) {
  const sectionValue = field.section || '';
  const pageValue = field.page ?? null;
  const computedValue = field.computed_from_dataset || '';

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
          <Lbl label="Input type">
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
        <Lbl label="Default value">
          <FixedExpressionInput
            value={field.default}
            onChange={(next) => onChange({ default: next })}
            fixedPlaceholder="Fixed value"
            expressionPlaceholder="e.g. {{app_user.username}}"
            expressionOptions={COMMON_EXPRESSION_OPTIONS}
          />
        </Lbl>
      </CollapsibleGroup>

      {(field.widget === 'select' || field.widget === 'lookup') && (
        <CollapsibleGroup title="Options">
          <LookupEditor field={field} tables={tables} onChange={onChange} />
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
          <Lbl label="Auto-compute from dataset" className="wb-col-span-2">
            <SingleColumnPicker
              sourceColumns={tableCols.map((column) => column.name)}
              value={computedValue || null}
              onChange={(next) => onChange({ computed_from_dataset: next })}
              placeholder="Not used"
            />
          </Lbl>
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
