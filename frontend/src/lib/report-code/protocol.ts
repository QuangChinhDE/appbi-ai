/**
 * Report-as-Code host ⇄ sandbox protocol (v1). Pure: no imports, no DOM.
 *
 * The report frame is sandboxed WITHOUT allow-same-origin, so its origin is the
 * opaque "null" and `event.origin` identifies nothing. Trust comes from the
 * channel instead: the host creates a MessageChannel and transfers one port into
 * the frame exactly once; only the holder of that port can talk to the host.
 * Everything arriving on it is still untrusted input and is parsed here.
 */

export type FilterKind = 'category' | 'date';
/** grain "month" = a period picker; default "latest" / default_value = what the numbers use until a viewer picks; single = one value. */
export interface ReportFilterDecl {
  key: string; label: string; kind: FilterKind;
  grain?: 'month'; default?: 'latest'; single?: boolean; default_value?: string;
}
export interface ReportBindingDecl { id: string; title: string; kind: string }
export type FilterValue = string[] | [string | null, string | null];
export type FilterState = Record<string, FilterValue>;

export type SandboxMessage =
  | { type: 'ready'; guard: boolean }
  | { type: 'guard'; guard: boolean; authorScript: 'ran' | 'refused' }
  | { type: 'setFilter'; key: string; value: FilterValue | null }
  | { type: 'clearFilters' }
  | { type: 'values'; reqId: string; key: string; search: string }
  | { type: 'region'; region: string }
  | { type: 'error'; kind: string; message: string };

export const PROTOCOL_VERSION = 1;
export const MAX_FILTER_VALUES = 200;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

/** A filter value a viewer may set, or undefined when it is malformed. */
export function parseFilterValue(decl: ReportFilterDecl, value: unknown): FilterValue | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return undefined;
  if (decl.kind === 'date') {
    if (value.length !== 2) return undefined;
    const [a, b] = value;
    const ok = (x: unknown) => x === null || x === '' || (typeof x === 'string' && DATE_RX.test(x));
    if (!ok(a) || !ok(b)) return undefined;
    const lo = (a as string | null) || null;
    const hi = (b as string | null) || null;
    return lo || hi ? [lo, hi] : null;
  }
  if (value.length === 0) return null;
  if (value.length > MAX_FILTER_VALUES) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if ((typeof v !== 'string' && typeof v !== 'number') || String(v).length > 200) return undefined;
    out.push(String(v));
  }
  return out;
}

/** Parse one message from the sandbox port; null for anything not in the protocol. */
export function parseSandboxMessage(data: unknown, filters: ReportFilterDecl[]): SandboxMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'ready':
      return { type: 'ready', guard: d.guard === true };
    case 'guard':
      return { type: 'guard', guard: d.guard === true, authorScript: d.authorScript === 'ran' ? 'ran' : 'refused' };
    case 'clearFilters':
      return { type: 'clearFilters' };
    case 'setFilter': {
      const key = str(d.key, 20);
      const decl = key ? filters.find((f) => f.key === key) : undefined;
      if (!key || !decl) return null;
      const value = parseFilterValue(decl, d.value);
      return value === undefined ? null : { type: 'setFilter', key, value };
    }
    case 'values': {
      const key = str(d.key, 20);
      const reqId = str(d.reqId, 20);
      if (!key || !reqId || !filters.some((f) => f.key === key)) return null;
      return { type: 'values', reqId, key, search: str(d.search, 80) ?? '' };
    }
    case 'region': {
      const region = str(d.region, 80);
      return region ? { type: 'region', region } : null;
    }
    case 'error':
      return { type: 'error', kind: str(d.kind, 40) ?? 'script', message: (str(d.message, 600) ?? '').slice(0, 500) };
    default:
      return null;
  }
}

/**
 * How a report document may be framed. An ISOLATED document (served from the report
 * origin) gets a real origin — required for the navigation guard — and therefore
 * `allow-same-origin`; that is only safe when its origin differs from the app's.
 * Anything else is framed opaque. Null means: refuse to frame it.
 */
export function frameSandbox(src: string, isolated: boolean, appOrigin: string): string | null {
  let origin: string;
  try { origin = new URL(src, appOrigin).origin; } catch { return null; }
  if (!isolated) return 'allow-scripts';
  if (origin === appOrigin || origin === 'null') return null;
  return 'allow-scripts allow-same-origin';
}

export function applyFilter(state: FilterState, key: string, value: FilterValue | null): FilterState {
  const next = { ...state };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}
