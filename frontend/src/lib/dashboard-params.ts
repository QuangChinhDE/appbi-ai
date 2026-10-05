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
/** The server's resolution of each switcher's column (`parameter_fields`). */
export type ResolvedParamFields = Record<string, {
  field: string;
  semanticField?: string;
  fieldKey?: string;
  datasetId?: number;
}>;

export function paramsToFilters(
  defs: ParamDef[],
  values: Record<string, string>,
  columns?: ColumnInfo[],
  serverResolved?: ResolvedParamFields | null,
): BaseFilter[] {
  const filters: BaseFilter[] = [];
  for (const def of defs) {
    if (!def.field) continue;
    const value = values[def.paramName];
    if (value === undefined || value === null || value === '') continue;
    // The server resolves a switcher's column ONCE for every surface
    // (dashboard_parameters.resolve_switcher_fields → `parameter_fields`), so
    // the Builder and a published link filter the SAME column. The local
    // lookup is only the fallback for a response that predates it.
    const fromServer = serverResolved?.[def.paramName];
    const resolved = fromServer
      ? { ...fromServer, type: 'dropdown' as FilterType }
      : resolveParamColumn(def.field, columns);
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

/**
 * What-if: the {dimension?, metric?} override a tile's bindings
 * (`parameters.__whatifBindings`) resolve to under the current parameter
 * values. ONE implementation for the Builder tile and every public surface; the
 * server accepts on a public link only values the bound switcher offers.
 */
export function tileRoleOverrides(
  instanceParameters: Record<string, unknown> | null | undefined,
  paramValues: Record<string, string> | null | undefined,
): Record<string, string> | null {
  const bindings = (instanceParameters as any)?.__whatifBindings;
  if (!Array.isArray(bindings) || !paramValues) return null;
  const out: Record<string, string> = {};
  for (const b of bindings) {
    if (!b || (b.role !== 'dimension' && b.role !== 'metric')) continue;
    const val = paramValues[b.param];
    if (typeof val === 'string' && val.trim()) out[b.role] = val.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The key a public view stores each chart tile's data under. A chart sitting on
 * the report more than once with DIFFERENT tile parameters (author-set values
 * or what-if bindings) gets one answer per tile, keyed `-tileId` (tile ids and
 * chart ids never collide that way); every other tile keeps its `chart_id` key,
 * so a report without such duplicates behaves exactly as before.
 */
export function tileDataKeys(
  charts: Array<{ id: number; chart_id?: number | null; widget_type?: string | null; parameters?: unknown }> | null | undefined,
): Map<number, number> {
  const sigsByChart = new Map<number, Set<string>>();
  const rows = (charts ?? []).filter((dc) => (!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id);
  for (const dc of rows) {
    const p = dc.parameters && typeof dc.parameters === 'object' ? dc.parameters : {};
    const sig = stableJson(p);
    if (!sigsByChart.has(dc.chart_id!)) sigsByChart.set(dc.chart_id!, new Set());
    sigsByChart.get(dc.chart_id!)!.add(sig);
  }
  const keys = new Map<number, number>();
  for (const dc of rows) {
    keys.set(dc.id, (sigsByChart.get(dc.chart_id!)?.size ?? 1) > 1 ? -dc.id : dc.chart_id!);
  }
  return keys;
}
