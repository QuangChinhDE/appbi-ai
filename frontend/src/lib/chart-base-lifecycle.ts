/**
 * Chart Builder "semantic base" (bảng gốc) lifecycle — the pure rules.
 *
 * The base is the FROM root of a chart's semantic join tree and is saved as the
 * chart's `dataset_table_id`. It can come from four places, and the UI must say
 * which (a DA has to be able to tell a choice they made from one the system
 * made):
 *
 *   saved    — restored from the saved chart (never re-derived on reopen);
 *   user     — picked explicitly in the base picker;
 *   derived  — taken from the FIRST FIELD THE USER PICKED (Power BI-style);
 *   null     — not decided yet.
 *
 * WHY "the first field the USER picked" and not "the first field in the role
 * config": the editor also auto-seeds fields (TABLE default columns, a fallback
 * dimension/metric for BAR/KPI …). Those used to be indistinguishable from user
 * picks, so the base was silently committed to whatever view came FIRST in the
 * model before the user touched anything — and stayed sticky. A chart then
 * looked rooted at that table while its measures came from another fact, and an
 * ambiguity refusal named a route the user had never seen.
 *
 * No imports: checked directly by scripts/check-chart-base-contract.mjs.
 */

export type BaseOrigin = 'saved' | 'user' | 'derived';

interface MetricLike { field?: string | null }
export interface RoleConfigLike {
  dimension?: string | null;
  timeField?: string | null;
  scatterX?: string | null;
  scatterY?: string | null;
  tableRowDimension?: string | null;
  tableColumnDimension?: string | null;
  breakdown?: string | null;
  dimensions?: Array<string | null | undefined> | null;
  metrics?: MetricLike[] | null;
  lineMetric?: MetricLike | null;
  benchmarkMetric?: MetricLike | null;
  tablePivotMetric?: MetricLike | null;
  selectedColumns?: Array<string | null | undefined> | null;
}

export interface FilterLike { field?: string | null }

export interface ModelViewLike {
  name: string;
  dataset_table_id?: number | null;
  view_role?: string | null;
}

/** Every field a role config binds, in a stable role order. */
export function listRoleFieldRefs(rc: RoleConfigLike | null | undefined): string[] {
  if (!rc) return [];
  const raw: Array<string | null | undefined> = [
    rc.dimension, rc.timeField, rc.scatterX, rc.scatterY, rc.tableRowDimension,
    rc.tableColumnDimension, rc.breakdown, ...(rc.dimensions ?? []),
    ...(rc.metrics ?? []).map((m) => m?.field),
    rc.lineMetric?.field, rc.benchmarkMetric?.field, rc.tablePivotMetric?.field,
    ...(rc.selectedColumns ?? []),
  ];
  const out: string[] = [];
  for (const f of raw) {
    if (typeof f === 'string' && f.trim() && !out.includes(f)) out.push(f);
  }
  return out;
}

/** The view of a qualified `view.field` ref (null for a bare ref). */
export function viewOfField(field: string | null | undefined): string | null {
  if (!field || !field.includes('.')) return null;
  return field.split('.', 1)[0] || null;
}

/**
 * The QUALIFIED field a user edit added — exactly one. Null when the edit added
 * nothing qualified, or several at once: a bulk change is not a pick. (A new
 * TABLE shows every column checked while `selectedColumns` is still implicit;
 * unchecking ONE makes the other N explicit, which must not read as the user
 * choosing the first of them.)
 */
export function firstAddedQualifiedField(
  prev: RoleConfigLike | null | undefined,
  next: RoleConfigLike | null | undefined,
): string | null {
  const before = new Set(listRoleFieldRefs(prev));
  const added = listRoleFieldRefs(next).filter((f) => !before.has(f) && viewOfField(f));
  return added.length === 1 ? added[0] : null;
}

/**
 * The dataset table a view stands for. A date-hierarchy view
 * (`{parentView}__{col}__date_dim`, view_role 'calendar_role') has no table of
 * its own: it anchors to its parent table view (longest prefix wins).
 */
export function tableIdForView(views: ModelViewLike[], viewName: string | null): number | null {
  if (!viewName) return null;
  const direct = views.find((v) => v.name === viewName);
  if (direct?.dataset_table_id != null) return direct.dataset_table_id;
  if (direct?.view_role === 'calendar_role' || viewName.endsWith('__date_dim')) {
    const parent = views
      .filter((v) => v.dataset_table_id != null && viewName.startsWith(`${v.name}__`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (parent?.dataset_table_id != null) return parent.dataset_table_id;
  }
  return null;
}

/**
 * The base to derive, or null. Only the user's first explicit field counts —
 * an auto-seeded field never commits a base.
 */
export function deriveBaseTableId(
  views: ModelViewLike[],
  intentField: string | null,
): number | null {
  return tableIdForView(views, viewOfField(intentField));
}

/**
 * What changing the base to one reaching `reachableViewNames` would drop:
 * qualified role fields and filters on views the new base cannot reach. Bare
 * refs are kept (the engine resolves them, or refuses an ambiguous one).
 */
export function bindingsOutsideBase(
  rc: RoleConfigLike | null | undefined,
  filters: FilterLike[] | null | undefined,
  reachableViewNames: Set<string>,
): { fields: string[]; filters: string[] } {
  const outside = (f: string | null | undefined) => {
    const v = viewOfField(f ?? null);
    return v != null && !reachableViewNames.has(v);
  };
  return {
    fields: listRoleFieldRefs(rc).filter(outside),
    filters: (filters ?? []).map((f) => f?.field ?? '').filter((f) => f && outside(f)),
  };
}

/** Filters still valid under a base reaching `reachableViewNames`. */
export function keepFiltersInBase<F extends FilterLike>(filters: F[], reachableViewNames: Set<string>): F[] {
  return filters.filter((f) => {
    const v = viewOfField(f?.field ?? null);
    return v == null || reachableViewNames.has(v);
  });
}

/**
 * Views (other than the base) whose MEASURES the chart aggregates. When this is
 * non-empty the planner computes those numbers at that fact's grain — the chart
 * is "based on" the base for its rows, but its numbers come from these tables,
 * and a route problem is reported from THEM.
 */
export function measureViewsOutsideBase(
  rc: RoleConfigLike | null | undefined,
  baseViewName: string | null,
): string[] {
  if (!rc) return [];
  const fields = [
    ...(rc.metrics ?? []).map((m) => m?.field),
    rc.lineMetric?.field, rc.benchmarkMetric?.field, rc.tablePivotMetric?.field,
  ];
  const out: string[] = [];
  for (const f of fields) {
    const v = viewOfField(f ?? null);
    if (v && v !== baseViewName && !out.includes(v)) out.push(v);
  }
  return out;
}
