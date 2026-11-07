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
  | { type: 'ready'; guard: boolean; authorScript?: 'ran' | 'refused'; need?: Need }
  | ({ type: 'need' } & Need)
  | { type: 'guard'; guard: boolean; authorScript: 'ran' | 'refused' }
  | { type: 'setFilter'; key: string; value: FilterValue | null }
  | { type: 'clearFilters' }
  | { type: 'values'; reqId: string; key: string; search: string }
  | { type: 'region'; region: string }
  | { type: 'error'; kind: string; message: string };

/** What the page shows now: bindings drawn by a rendered element (+ the author JS's), and
 *  a row cap per binding used only by capped lists. Absent = an old document: load all. */
export interface Need { ids: string[]; limits: Record<string, number> }

function parseNeed(d: Record<string, unknown>): Need | undefined {
  if (!Array.isArray(d.need ?? d.ids)) return undefined;
  const ids = ((d.need ?? d.ids) as unknown[]).map((x) => str(x, 20)).filter((x): x is string => !!x).slice(0, 200);
  const limits: Record<string, number> = {};
  if (d.limits && typeof d.limits === 'object') {
    for (const [k, v] of Object.entries(d.limits as Record<string, unknown>)) {
      const n = typeof v === 'number' ? Math.floor(v) : NaN;
      if (str(k, 20) && n > 0 && n <= 100_000) limits[k] = n;
    }
  }
  return { ids, limits };
}

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
      return { type: 'ready', guard: d.guard === true,
        authorScript: d.authorScript === 'ran' || d.authorScript === 'refused' ? d.authorScript : undefined,
        need: Array.isArray(d.need) ? parseNeed(d) : undefined };
    case 'need': {
      const n = parseNeed(d);
      return n ? { type: 'need', ...n } : null;
    }
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


/** What decides that an unsaved-code preview must be re-posted: EVERY byte of html, css and
 *  js (a same-length CSS/JS edit is still a change). FNV-1a over the fields in a fixed order,
 *  plus the total length; computed once per render, no DOM. */
export function previewKey(post: Record<string, string> | undefined): string {
  if (!post) return '';
  let h = 0x811c9dc5;
  let n = 0;
  for (const k of ['html', 'css', 'js', ...Object.keys(post).filter((x) => !['html', 'css', 'js'].includes(x)).sort()]) {
    const v = k + String.fromCharCode(0) + (post[k] ?? '') + String.fromCharCode(1);
    n += v.length;
    for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return `${n}:${h.toString(36)}`;
}
