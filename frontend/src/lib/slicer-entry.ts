/**
 * The one way a slicer entry is created.
 *
 * The filter bar's "Add slicer" and the grid's "Add element → Slicer" must
 * produce the same entry for the same field and interaction, or a control added
 * on the grid would filter differently from one added in the bar. Both call
 * this; the operator and the initial value come from the interaction exactly as
 * they did when this logic lived inside `DashboardFilterBar.addFilter`.
 */
import {
  type BaseFilter,
  type ColumnInfo,
  type DatePreset,
  type FilterOperator,
  computeDatePresetRange,
  getColumnDisplayLabel,
  getColumnKey,
} from './filters';

export type SlicerInteractionType = NonNullable<BaseFilter['interactionType']>;

export function createSlicerEntry(input: {
  column: ColumnInfo;
  /** Every column the report offers — used for the legacy date auto-link. */
  columns: ColumnInfo[];
  /** Field keys already filtered, so auto-link never links to them. */
  usedFields: ReadonlySet<string>;
  interaction?: SlicerInteractionType;
  preset?: DatePreset;
  /** A slicer added on the report (cluster or grid) starts as "this page". */
  pageScope?: boolean;
  /** Injected for tests; defaults to the clock, as before. */
  id?: string;
}): BaseFilter {
  const { column: col, columns, usedFields, interaction, preset } = input;
  const columnKey = getColumnKey(col);

  let linkedFields = col.defaultLinkedFields ? [...col.defaultLinkedFields] : undefined;
  // Auto-link legacy non-semantic date columns when no explicit linked targets are provided.
  if (!linkedFields?.length && col.type === 'date' && !col.semanticField) {
    linkedFields = columns
      .filter((c) => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c)))
      .map((c) => getColumnKey(c));
    if (!linkedFields.length) linkedFields = undefined;
  }

  let operator: FilterOperator;
  let value: any;
  let datePreset: DatePreset | undefined;
  if (interaction === 'dropdown' || interaction === 'fixed_list') {
    operator = 'in';
    value = [];
  } else if (interaction === 'input') {
    operator = 'contains';
    value = '';
  } else if (interaction === 'slider') {
    operator = 'between';
    value = ['', ''];
  } else if (interaction === 'checkbox') {
    operator = 'eq';
    value = '';
  } else if (interaction === 'date_range') {
    operator = 'between';
    datePreset = preset ?? 'this_month';
    value = datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];
  } else if (interaction === 'advanced') {
    if (col.type === 'date') {
      operator = 'between';
      datePreset = preset ?? 'this_month';
      value = datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];
    } else if (col.type === 'number') {
      operator = 'eq';
      value = '';
    } else {
      operator = 'in';
      value = [];
    }
  } else {
    // Legacy fallback — the pre-interaction inference, unchanged.
    const isMultiSelect = col.type === 'text' || col.type === 'dropdown';
    datePreset = col.type === 'date' ? (preset ?? 'this_month') : undefined;
    const dateValue = datePreset && datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];
    operator = isMultiSelect ? 'in' : col.type === 'date' ? 'between' : 'gte';
    value = isMultiSelect ? [] : col.type === 'date' ? dateValue : '';
  }

  return {
    id: input.id ?? `gf-${Date.now()}`,
    field: col.name,
    fieldKey: columnKey,
    semanticField: col.semanticField,
    datasetId: col.datasetId,
    linkedFields,
    type: col.type,
    operator,
    value,
    label: getColumnDisplayLabel(col),
    datePreset,
    interactionType: interaction,
    ...(input.pageScope ? { scope: 'page' as const } : {}),
  } as BaseFilter;
}

/** The interaction a new control starts with when the author only picked a
 *  field: a date gets a range, a number a slider, anything else a list. */
export function defaultInteractionFor(column: ColumnInfo): SlicerInteractionType {
  if (column.type === 'date') return 'date_range';
  if (column.type === 'number') return 'slider';
  return 'dropdown';
}
