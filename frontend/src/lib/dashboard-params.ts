/**
 * Dashboard "what-if / field parameter" helpers.
 *
 * A `parameter_switcher` widget defines a named parameter whose value the
 * viewer switches at runtime. Phase 1 supports the FILTER binding: when the
 * switcher declares a `field`, the active value is injected as a page-scoped
 * filter (`field IN [value]`) that flows through the normal chart-filter path —
 * so every chart on the page reacts, exactly like a slicer but with custom
 * option labels. Text widgets read the raw value via `{{param('name')}}`.
 *
 * The param VALUES live in dashboard page state (not persisted); the param
 * DEFINITIONS live in each switcher widget's `widget_config`.
 */
import type { BaseFilter, ColumnInfo, FilterType } from './filters';
import type { DashboardChart } from '@/types/api';

export interface ParamOption {
  label: string;
  value: string;
}

export interface ParamDef {
  paramName: string;
  label?: string;
  /** Column to filter when the value changes. Empty → text-widget-only. */
  field?: string;
  options: ParamOption[];
  /** Default value; falls back to the first option. */
  default?: string;
}

/** Pull parameter definitions out of the parameter_switcher widgets. */
export function extractParamDefs(charts: DashboardChart[] | undefined | null): ParamDef[] {
  if (!charts?.length) return [];
  const defs: ParamDef[] = [];
  for (const dc of charts) {
    if (dc.widget_type !== 'parameter_switcher') continue;
    const cfg = (dc.widget_config ?? {}) as Record<string, any>;
    const paramName = String(cfg.paramName ?? '').trim();
    if (!paramName) continue;
    const options: ParamOption[] = Array.isArray(cfg.options)
      ? cfg.options
          .filter((o: any) => o && o.value != null)
          .map((o: any) => ({ label: String(o.label ?? o.value), value: String(o.value) }))
      : [];
    defs.push({
      paramName,
      label: cfg.label ? String(cfg.label) : undefined,
      field: cfg.field ? String(cfg.field).trim() : undefined,
      options,
      default: cfg.default != null ? String(cfg.default) : undefined,
    });
  }
  return defs;
}

/**
 * Fill in default values for any param not already set, without disturbing
 * values the viewer already picked. Returns a NEW object only when something
 * changed (so a `setState` with this stays referentially stable when idle).
 */
export function seedParamValues(
  defs: ParamDef[],
  current: Record<string, string>,
): Record<string, string> {
  let changed = false;
  const next = { ...current };
  const liveNames = new Set(defs.map((d) => d.paramName));
  // seed missing
  for (const def of defs) {
    if (next[def.paramName] === undefined) {
      const seed = def.default ?? def.options[0]?.value;
      if (seed !== undefined) {
        next[def.paramName] = seed;
        changed = true;
      }
    }
  }
  // drop values whose param no longer exists (widget removed)
  for (const key of Object.keys(next)) {
    if (!liveNames.has(key)) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : current;
}

/**
 * Match a param's raw `field` string against the dashboard's known filterable
 * columns so the resulting filter carries the semantic identity (`semanticField`
 * / `fieldKey` / `datasetId`) the query engine needs. On a SEMANTIC dataset a
 * bare column name is dropped as "unreachable"; enriching it here is what makes
 * charts actually react. Falls back to the raw field for non-semantic datasets
 * (where the plain column name resolves on its own).
 */
function resolveParamColumn(
  field: string,
  columns?: ColumnInfo[],
): Pick<BaseFilter, 'field' | 'semanticField' | 'fieldKey' | 'datasetId' | 'type'> {
  const raw = field.trim();
  const suffix = raw.includes('.') ? raw : `.${raw}`;
  const match = columns?.find(
    (c) =>
      c.name === raw ||
      c.semanticField === raw ||
      (c.key ?? '') === raw ||
      (c.semanticField ? c.semanticField.endsWith(suffix) : false),
  );
  if (match) {
    return {
      field: match.name,
      semanticField: match.semanticField,
      fieldKey: match.key ?? match.semanticField,
      datasetId: match.datasetId,
      type: (match.type ?? 'dropdown') as FilterType,
    };
  }
  return { field: raw, type: 'dropdown' };
}

/**
 * Convert active filter-bound params into BaseFilter entries that can be
 * appended to the dashboard's effective filter set. Params without a `field`
 * (text-only) or without a value are skipped. Pass the dashboard's available
 * columns so the field resolves on semantic datasets.
 */
export function paramsToFilters(
  defs: ParamDef[],
  values: Record<string, string>,
  columns?: ColumnInfo[],
): BaseFilter[] {
  const filters: BaseFilter[] = [];
  for (const def of defs) {
    if (!def.field) continue;
    const value = values[def.paramName];
    if (value === undefined || value === null || value === '') continue;
    const resolved = resolveParamColumn(def.field, columns);
    filters.push({
      id: `param-${def.paramName}`,
      operator: 'in',
      value: [value],
      label: def.label || def.paramName,
      ...resolved,
    });
  }
  return filters;
}
