/**
 * What kind of "this chart did not run" a chart data/preview error is.
 *
 * The backend says it in a machine-readable way (Chart error contract,
 * backend/app/services/chart_error_contract.py):
 *   - 400 + `X-AppBI-Refusal: <CATEGORY>` + body `refusal: {category, target?, routes?}`
 *     → the semantic engine DECLINED to guess (two meanings, fan-out …). Not a
 *       failure of the system: the chart's meaning is undetermined.
 *   - 400 without a refusal → the configuration is invalid for the data now.
 *   - 401/403 → permission.
 *   - 5xx → data source / system error (already sanitized server-side).
 *
 * The Builder and the dashboard tiles render from THIS classification instead
 * of printing the engine's prose (which names relationships, "Inactive",
 * "alias (role-playing)" … — fine as detail for a modeller, not as the message).
 *
 * No imports: checked directly by scripts/check-chart-base-contract.mjs.
 */

export type ChartFailureKind =
  | 'ambiguous_route'
  | 'semantic_refusal'
  | 'invalid_config'
  | 'permission'
  | 'source_error'
  | 'unknown';

export interface ChartFailure {
  kind: ChartFailureKind;
  /** The refusal category when the engine refused (AMBIGUOUS_ROUTE, FANOUT_RISK …). */
  category?: string;
  /** The table the routes lead to (humanised by the server). */
  target?: string;
  /** The competing relationship paths (humanised by the server). */
  routes?: string[];
  /** The server's own text — shown as secondary detail, never as the headline. */
  technical: string;
  status?: number;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as { get?: (k: string) => unknown } & Record<string, unknown>;
  const v = typeof h.get === 'function' ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
  return typeof v === 'string' && v ? v : undefined;
}

function detailText(data: unknown): string {
  if (typeof data === 'string') return data.trim().startsWith('<') ? '' : data;
  if (!data || typeof data !== 'object') return '';
  const d = (data as { detail?: unknown }).detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') {
    return (d as { message: string }).message;
  }
  const e = (data as { error?: unknown }).error;
  return typeof e === 'string' ? e : '';
}

/** Classify an axios-like error (or a batch item `{status, error, category}`). */
export function describeChartFailure(err: unknown): ChartFailure {
  const e = (err ?? {}) as {
    response?: { status?: number; data?: unknown; headers?: unknown };
    status?: number; error?: unknown; category?: unknown; message?: unknown;
  };
  const status = e.response?.status ?? (typeof e.status === 'number' ? e.status : undefined);
  const data = e.response?.data ?? (e.error !== undefined ? { error: e.error } : undefined);
  const technical = detailText(data) || (typeof e.message === 'string' ? e.message : '');
  const refusal = (data && typeof data === 'object' ? (data as { refusal?: unknown }).refusal : undefined) as
    | { category?: unknown; target?: unknown; routes?: unknown }
    | undefined;
  const category = (typeof refusal?.category === 'string' && refusal.category)
    || headerOf(e.response?.headers, 'x-appbi-refusal')
    || (typeof e.category === 'string' && e.category ? e.category : undefined);

  if (category) {
    const out: ChartFailure = {
      kind: category === 'AMBIGUOUS_ROUTE' ? 'ambiguous_route' : 'semantic_refusal',
      category, technical, status,
    };
    if (typeof refusal?.target === 'string' && refusal.target) out.target = refusal.target;
    if (Array.isArray(refusal?.routes)) out.routes = refusal.routes.filter((r): r is string => typeof r === 'string');
    return out;
  }
  if (status === 401 || status === 403) return { kind: 'permission', technical, status };
  if (status === 400 || status === 422) return { kind: 'invalid_config', technical, status };
  if (status != null && status >= 500) return { kind: 'source_error', technical, status };
  return { kind: 'unknown', technical, status };
}
