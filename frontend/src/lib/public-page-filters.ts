import { getFilterDisplayLabel, getFilterKey, isFilterValueActive, type BaseFilter, type DatePreset } from './filters';
import type { DashboardPageConfig } from '@/types/api';

/**
 * Public-link filter resolution FOR A GIVEN PAGE — extracted as a pure function
 * so it has exactly ONE implementation.
 *
 * Why this exists (bug it fixes): the resolution used to live only inside
 * PublicDashboardView's "slicer seed" effect, which recomputes on `activePageId`
 * and publishes the result to state/refs. PDF export switches pages
 * programmatically and fetches data in the SAME tick, before React re-renders —
 * so the fetch read page A's `pageHiddenFilters` while asking for page B's
 * charts. Page B then exported with page A's page-scope filters: wrong numbers,
 * and a scope leak (a page-scope filter is a hard bound, see
 * docs/filter-semantics.md). Any caller that needs a page's filters WITHOUT
 * being on that page must use this function instead of reading the live state.
 *
 * Taxonomy (PBI parity):
 *   • controlSeed   — what the viewer SEES and can change: report-level slicers
 *     (`slicers_config`, scope-visible on this page) + `filters_config` entries
 *     with publicMode='visible' + legacy `public_filters_config` + this page's
 *     own slicers (`pages_config[i].slicers`).
 *   • hiddenFilters — silent WHERE for this page: "Filters on this page"
 *     (`pages_config[i].filters`, publicMode='visible' only — locked/hidden ones
 *     are enforced server-side from the link config) + report slicers whose
 *     custom page-scope says "filter here but don't show a control here".
 */
export interface PublicPageFilterContext {
  controlSeed: BaseFilter[];
  hiddenFilters: BaseFilter[];
}

type PageLike = DashboardPageConfig & { slicers?: unknown; filters?: unknown };

/** A report-level slicer with `scope='custom'` only shows a control on the pages
 *  its pageScope marks visible; 'all'/unset shows everywhere. */
function slicerVisibleOnPage(slicer: unknown, pageId: string): boolean {
  const scope = (slicer as { scope?: string } | null)?.scope || 'all';
  if (scope === 'custom') {
    return Boolean((slicer as { pageScope?: Record<string, { visible?: boolean }> })?.pageScope?.[pageId]?.visible);
  }
  return true;
}

/** Same slicer, but "does it constrain this page's data" (can be true while the
 *  control is hidden → the value applies silently). */
export function slicerFiltersOnPage(slicer: unknown, pageId: string): boolean {
  const scope = (slicer as { scope?: string } | null)?.scope || 'all';
  if (scope === 'custom') {
    return Boolean((slicer as { pageScope?: Record<string, { filter?: boolean }> })?.pageScope?.[pageId]?.filter);
  }
  return true;
}

/**
 * What a slicer control actually filters, said in words — a control placed next
 * to one chart must not read as "filters that chart" when it filters the whole
 * page (or every page). Page slicers filter their page; report slicers filter
 * every page, or the pages their custom scope marks.
 */
export function slicerScopeSummary(
  slicer: unknown,
  pages: { id: string }[],
): { kind: 'thisPage' | 'allPages' | 'somePages'; count: number } {
  const scope = (slicer as { scope?: string } | null)?.scope || 'all';
  if (scope === 'page' || pages.length <= 1) return { kind: 'thisPage', count: 1 };
  const count = pages.filter((p) => slicerFiltersOnPage(slicer, p.id)).length;
  if (count >= pages.length) return { kind: 'allPages', count };
  return count <= 1 ? { kind: 'thisPage', count: 1 } : { kind: 'somePages', count };
}

function asFilterArray(value: unknown): BaseFilter[] {
  return Array.isArray(value) ? (value as BaseFilter[]) : [];
}

function publicVisibleOnly(entries: BaseFilter[]): BaseFilter[] {
  return entries.filter((f) => ((f as { publicMode?: string }).publicMode ?? 'visible') === 'visible');
}

export function resolvePublicPageFilterContext(
  dashboard: Record<string, unknown> | null | undefined,
  pages: DashboardPageConfig[],
  pageId: string | null | undefined,
): PublicPageFilterContext {
  if (!dashboard) return { controlSeed: [], hiddenFilters: [] };
  const pid = pageId ?? '';

  const allConfigSlicers = asFilterArray(dashboard.slicers_config);
  const slicersFromConfig = allConfigSlicers.filter((s) => slicerVisibleOnPage(s, pid));
  const silentScopedSlicers = allConfigSlicers.filter(
    (s) => !slicerVisibleOnPage(s, pid) && slicerFiltersOnPage(s, pid),
  );

  const filtersAsSlicers = publicVisibleOnly(asFilterArray(dashboard.filters_config));

  // Legacy links (pre slicers_config) only ship public_filters_config.
  const legacyPublicConfig =
    slicersFromConfig.length === 0 && filtersAsSlicers.length === 0
      ? asFilterArray(dashboard.public_filters_config)
      : [];

  const page = pages.find((p) => p.id === pid) as PageLike | undefined;
  const rawPageSlicers = asFilterArray(page?.slicers);
  const rawPageFilters = publicVisibleOnly(asFilterArray(page?.filters));

  return {
    controlSeed: [...slicersFromConfig, ...filtersAsSlicers, ...legacyPublicConfig, ...rawPageSlicers],
    hiddenFilters: [...rawPageFilters, ...silentScopedSlicers],
  };
}

/**
 * Merge a page's control seed with the viewer's current selections, keyed by
 * fieldKey — the same rule the live seed effect uses when the viewer switches
 * pages (their edits win for fields the new page still offers). Used by export
 * to reconstruct "what page B would show right now" without touching state.
 */
export function mergeSeedWithViewerSelections(
  controlSeed: BaseFilter[],
  viewerApplied: BaseFilter[],
): BaseFilter[] {
  const seedByKey = new Map<string, BaseFilter>();
  for (const f of controlSeed) seedByKey.set(f.fieldKey ?? f.field, f);
  const existingByKey = new Map<string, BaseFilter>();
  for (const f of viewerApplied) existingByKey.set(f.fieldKey ?? f.field, f);
  const merged: BaseFilter[] = [];
  for (const [key, seedFilter] of seedByKey.entries()) {
    merged.push(existingByKey.get(key) ?? seedFilter);
  }
  return merged;
}


/** One filter that constrains a page's data, as a reader is told it. */
export interface PageFilterFact {
  key: string;
  label: string;
  /** Selected values, already formatted (empty for a relative-date preset). */
  value: string;
  /** A relative-date preset (resolved on the server), shown as its name. */
  preset?: DatePreset;
  /** An exclusion ("not RJ"): shown as such, never as the value alone. */
  negated?: boolean;
  /** How the value reads when it is not plain equality (see statePageFilterFact). */
  kind?: 'excluding' | 'contains' | 'notContains' | 'startsWith' | 'isEmpty' | 'hasValue';
  /** Enforced by the link or the report: the reader cannot change it. */
  locked: boolean;
}

export interface LockedFilterEntry {
  field: string;
  label?: string | null;
  value: unknown;
  semanticField?: string | null;
  operator?: string | null;
  datePreset?: DatePreset | null;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.filter((v) => v !== null && v !== undefined && String(v) !== '').map(String);
    return items.length > 3 ? `${items.slice(0, 3).join(', ')}, +${items.length - 3}` : items.join(', ');
  }
  return value === null || value === undefined ? '' : String(value);
}

function hasPreset(f: BaseFilter): f is BaseFilter & { datePreset: DatePreset } {
  const preset = (f as { datePreset?: DatePreset }).datePreset;
  return !!preset && preset !== 'custom';
}

/**
 * What constrains THIS page's data, as a reader must be told it: a filtered
 * page must never read as unfiltered.
 *
 *   - `locked`: the link's locked (🔒) filters and the report's own locked
 *     filters — enforced, read-only;
 *   - `pageHidden`: filters that apply here without a control ("filters on
 *     this page", and slicers whose scope filters this page but does not show
 *     a control on it);
 *   - `applied`: the viewer's controls' filters. With `withoutControl`, only
 *     those whose id is in that set are kept — the ones no control on this
 *     page draws (a control already says its own value).
 *
 * An entry that constrains nothing (no value, no relative-date preset) is not
 * a filter to announce. One fact per field; a lock wins. A hidden (🚫) filter
 * never reaches this function: the server does not serve it.
 */
// The chart engine's operator aliases (chart_contracts._OPERATOR_MAP) and value
// normalisation (normalize_filter_value), mirrored so a statement reads what the
// engine enforces.
const OPERATOR_ALIASES: Record<string, string> = {
  '=': 'eq', '==': 'eq', '!=': 'neq', '<>': 'neq', ne: 'neq',
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
};
function canonicalCondition(operator: unknown, value: unknown): { operator: string; value: unknown } {
  const raw = String(operator ?? 'eq').trim().toLowerCase() || 'eq';
  const op = OPERATOR_ALIASES[raw] ?? raw;
  if ((op === 'in' || op === 'not_in') && typeof value === 'string') {
    return { operator: op, value: value.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if ((op === 'between' || op === 'not_between') && Array.isArray(value)) return { operator: op, value: value.slice(0, 2) };
  if (op === 'between' && typeof value === 'string') {
    const sep = value.includes('..') ? '..' : ',';
    return { operator: op, value: value.split(sep).map((s) => s.trim()).filter(Boolean).slice(0, 2) };
  }
  return { operator: op, value };
}
// Every operator the engine reads as an exclusion: stated as "not …", never as
// the value alone.
const NEGATING_OPERATORS = new Set(['not_in', 'neq', 'not_contains', 'not_between']);
const COMPARISON_SIGN: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

/** The value half of "Label: value", in the UI language — one wording for the
 * banner and both PDF headers. */
export function statePageFilterFact(fact: PageFilterFact, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (fact.preset) return t(`dashboards.filterContext.preset.${fact.preset}`);
  switch (fact.kind) {
    case 'isEmpty': return t('dashboards.filterContext.isEmpty');
    case 'hasValue': return t('dashboards.filterContext.hasValue');
    case 'contains': return t('dashboards.filterContext.contains', { value: fact.value });
    case 'notContains': return t('dashboards.filterContext.notContains', { value: fact.value });
    case 'startsWith': return t('dashboards.filterContext.startsWith', { value: fact.value });
    case 'excluding': return t('dashboards.filterContext.excluding', { value: fact.value });
    default: return fact.value;
  }
}

export function pageFilterFacts(input: {
  applied: BaseFilter[];
  pageHidden: BaseFilter[];
  locked: LockedFilterEntry[];
  withoutControl?: ReadonlySet<string>;
}): PageFilterFact[] {
  const out = new Map<string, PageFilterFact>();
  const fact = (f: BaseFilter, locked: boolean): PageFilterFact | null => {
    const key = getFilterKey(f);
    const label = getFilterDisplayLabel(f);
    if (hasPreset(f)) return { key, label, value: '', preset: f.datePreset, locked };
    // Stated as the chart engine enforces it: its canonical operator, its
    // value normalisation (a scalar "SP" under `in` is ["SP"]) and its rule for
    // "does this constrain anything" (is_filter_condition_active) — for a lock
    // too, so a lock the engine drops is never announced.
    const { operator: op, value: v } = canonicalCondition(f.operator, f.value);
    if (!isFilterValueActive({ operator: op, value: v } as Pick<BaseFilter, 'operator' | 'value'>)) return null;
    if (op === 'is_null') return { key, label, value: '', kind: 'isEmpty', locked };
    if (op === 'is_not_null') return { key, label, value: '', kind: 'hasValue', locked };
    let value: string;
    if (op === 'between' || op === 'not_between') {
      const [lo, hi] = Array.isArray(v) ? v : [];
      const has = (x: unknown) => x !== null && x !== undefined && String(x) !== '';
      value = has(lo) && has(hi) ? `${lo} – ${hi}` : has(lo) ? `≥ ${lo}` : `≤ ${hi}`;
    } else {
      value = formatValue(v);
      if (!value) return null;
      const sign = COMPARISON_SIGN[op];
      if (sign) value = `${sign} ${value}`;
    }
    const kind = op === 'contains' || op === 'like' ? 'contains'
      : op === 'not_contains' ? 'notContains'
        : op === 'starts_with' ? 'startsWith'
          : NEGATING_OPERATORS.has(op) ? 'excluding' : undefined;
    return { key, label, value, locked, ...(kind ? { kind } : {}), ...(NEGATING_OPERATORS.has(op) ? { negated: true } : {}) };
  };
  for (const entry of input.locked) {
    const f = {
      field: entry.field, semanticField: entry.semanticField ?? undefined, label: entry.label ?? undefined,
      operator: entry.operator || 'in', value: entry.value, ...(entry.datePreset ? { datePreset: entry.datePreset } : {}),
    } as unknown as BaseFilter;
    const made = fact(f, true);
    if (made && !out.has(made.key)) out.set(made.key, made);
  }
  const add = (f: BaseFilter) => {
    if (out.has(getFilterKey(f))) return;
    const made = fact(f, false);
    if (made) out.set(made.key, made);
  };
  for (const f of input.pageHidden) add(f);
  for (const f of input.applied) {
    if (input.withoutControl && !input.withoutControl.has(String(f.id ?? ''))) continue;
    add(f);
  }
  return [...out.values()];
}
