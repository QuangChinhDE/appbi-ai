/**
 * Tiny, sandboxed expression evaluator for dashboard text/countdown widgets.
 *
 * Supports a fixed allowlist of helpers — never `eval` / `Function` / `with`.
 * Templates use `{{ ... }}`; everything outside the braces is passed through
 * as plain text. If parsing fails, the original token is left in place so the
 * user sees what they typed (no silent drop).
 *
 * Helpers:
 *   now()                       → ISO date string of "now"
 *   today()                     → 'YYYY-MM-DD'
 *   daysUntil("YYYY-MM-DD")     → integer days from today to target
 *   hoursUntil("YYYY-MM-DD..")  → integer hours
 *   formatDate("YYYY-MM-DD", "DD/MM")   → naïve date format
 *   param("name")               → string from the params bag (provided at eval)
 */

type Params = Record<string, any>;

function getDaysBetween(targetIso: string): number {
  const t = new Date(targetIso).getTime();
  const now = Date.now();
  if (!Number.isFinite(t)) return NaN;
  return Math.max(0, Math.ceil((t - now) / (1000 * 60 * 60 * 24)));
}

function getHoursBetween(targetIso: string): number {
  const t = new Date(targetIso).getTime();
  const now = Date.now();
  if (!Number.isFinite(t)) return NaN;
  return Math.max(0, Math.floor((t - now) / (1000 * 60 * 60)));
}

function formatDate(iso: string, pattern: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/MM/g, m)
    .replace(/DD/g, day);
}

function todayIso(): string {
  const d = new Date();
  return formatDate(d.toISOString(), 'YYYY-MM-DD');
}

const STRING_RE = /^"([^"]*)"$|^'([^']*)'$/;

function parseArg(raw: string, params: Params): string | number {
  const trimmed = raw.trim();
  const sm = STRING_RE.exec(trimmed);
  if (sm) return sm[1] ?? sm[2] ?? '';
  // numeric
  const n = Number(trimmed);
  if (!Number.isNaN(n) && trimmed !== '') return n;
  // bare param reference
  if (Object.prototype.hasOwnProperty.call(params, trimmed)) {
    const v = params[trimmed];
    return typeof v === 'string' || typeof v === 'number' ? v : String(v ?? '');
  }
  return trimmed;
}

function evalCall(name: string, args: Array<string | number>, params: Params): string {
  switch (name) {
    case 'now':
      return new Date().toISOString();
    case 'today':
      return todayIso();
    case 'daysUntil': {
      const v = getDaysBetween(String(args[0] ?? ''));
      return Number.isFinite(v) ? String(v) : '';
    }
    case 'hoursUntil': {
      const v = getHoursBetween(String(args[0] ?? ''));
      return Number.isFinite(v) ? String(v) : '';
    }
    case 'formatDate':
      return formatDate(String(args[0] ?? ''), String(args[1] ?? 'YYYY-MM-DD'));
    case 'param': {
      const k = String(args[0] ?? '');
      const v = params[k];
      return v == null ? '' : String(v);
    }
    default:
      return '';
  }
}

const CALL_RE = /^(\w+)\s*\((.*)\)$/s;

export function evaluateExpression(expr: string, params: Params = {}): string {
  const trimmed = expr.trim();
  // bare param
  if (Object.prototype.hasOwnProperty.call(params, trimmed)) {
    return String(params[trimmed] ?? '');
  }
  const m = CALL_RE.exec(trimmed);
  if (!m) {
    // fall back to literal
    const sm = STRING_RE.exec(trimmed);
    if (sm) return sm[1] ?? sm[2] ?? '';
    return trimmed;
  }
  const fnName = m[1];
  const argList = m[2].trim();
  const args = argList === ''
    ? []
    : argList.split(',').map((s) => parseArg(s, params));
  return evalCall(fnName, args, params);
}

export function renderTemplate(template: string, params: Params = {}): string {
  if (!template) return '';
  return template.replace(/\{\{([^}]+)\}\}/g, (full, expr) => {
    try {
      return evaluateExpression(expr, params);
    } catch {
      return full;
    }
  });
}
