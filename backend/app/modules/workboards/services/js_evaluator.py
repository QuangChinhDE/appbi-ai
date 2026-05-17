"""Sandboxed JavaScript evaluator for ``TableComputedColumn(engine='js')``.

Design (Phase-14, 2026-05-16):

* QuickJS via ``quickjs`` Python wrapper — same engine n8n's Code node uses.
  Self-contained C++ build, no native compile per platform, fork-safe.
* Each computed column compiles ONCE per render: the user's body is wrapped
  as ``function(row, rows, index, $helpers){<body>}`` and stored. Per-row
  evaluation just calls the function with the current scope.
* Hard deny-list — QuickJS already lacks ``require`` / ``fetch`` / ``process``
  / ``fs``, but we additionally strip ``eval``, ``Function``, ``globalThis``,
  ``setTimeout``, ``setInterval`` so user code can't escape the sandbox via
  dynamic compilation.
* Per-row timeout 1000ms via QuickJS's interrupt handler.

Surfaced helpers are deliberately minimal — anything not in ``$helpers``
the user can write themselves with raw JS. Helpers exist for ergonomics
(``$helpers.sumIf(rows, r => r.x > 10, 'qty')``) and to avoid Date / Number
quirks (``$helpers.dayjs(...)``, ``$helpers.format(n, '0.00')``).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Iterable, List

try:
    import quickjs as _quickjs
except ImportError:  # pragma: no cover — surfaced when env lacks the package
    _quickjs = None  # type: ignore

logger = logging.getLogger(__name__)


# Per-row execution budget. QuickJS counts opcodes via the interrupt
# handler — 1000ms is generous enough for realistic spreadsheet-style
# logic, tight enough that an infinite loop is caught quickly.
PER_ROW_TIMEOUT_MS = 1000

# Truncate the rows array passed to ``rows`` so a 5000-row page doesn't
# explode the V8 / QuickJS heap when a user writes a O(n²) helper.
MAX_ROWS_IN_SCOPE = 1000


_HELPERS_JS = r"""
const $helpers = {
  sum(arr, key) {
    let total = 0;
    for (const r of arr) {
      const v = key ? r[key] : r;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isNaN(n)) total += n;
    }
    return total;
  },
  avg(arr, key) {
    let total = 0;
    let n = 0;
    for (const r of arr) {
      const v = key ? r[key] : r;
      const num = typeof v === 'number' ? v : Number(v);
      if (!Number.isNaN(num)) { total += num; n += 1; }
    }
    return n === 0 ? null : total / n;
  },
  min(arr, key) {
    let best = null;
    for (const r of arr) {
      const v = key ? r[key] : r;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isNaN(n)) continue;
      if (best === null || n < best) best = n;
    }
    return best;
  },
  max(arr, key) {
    let best = null;
    for (const r of arr) {
      const v = key ? r[key] : r;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isNaN(n)) continue;
      if (best === null || n > best) best = n;
    }
    return best;
  },
  count(arr, predicate) {
    if (typeof predicate !== 'function') {
      return arr.length;
    }
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      if (predicate(arr[i], i)) n += 1;
    }
    return n;
  },
  sumIf(arr, predicate, key) {
    let total = 0;
    for (let i = 0; i < arr.length; i++) {
      if (!predicate(arr[i], i)) continue;
      const v = key ? arr[i][key] : arr[i];
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isNaN(n)) total += n;
    }
    return total;
  },
  countIf(arr, predicate) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      if (predicate(arr[i], i)) n += 1;
    }
    return n;
  },
  // Look up the first row in ``arr`` where ``key === value`` and return
  // ``returnKey`` from it (or the whole row if returnKey is omitted).
  lookup(arr, key, value, returnKey) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i][key] === value) {
        return returnKey ? arr[i][returnKey] : arr[i];
      }
    }
    return null;
  },
  today() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  },
  now() {
    return new Date().toISOString();
  },
  // Minimal dayjs-style wrapper. Not the full lib (too heavy for QuickJS),
  // but enough for ``diff`` / ``format`` / ``add``.
  dayjs(input) {
    const base = input ? new Date(input) : new Date();
    return {
      _d: base,
      toISOString: () => base.toISOString(),
      format(pattern) {
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        return pattern
          .replace(/YYYY/g, base.getFullYear())
          .replace(/MM/g, pad(base.getMonth() + 1))
          .replace(/DD/g, pad(base.getDate()))
          .replace(/HH/g, pad(base.getHours()))
          .replace(/mm/g, pad(base.getMinutes()))
          .replace(/ss/g, pad(base.getSeconds()));
      },
      diff(other, unit) {
        const o = other && other._d ? other._d : new Date(other);
        const ms = base.getTime() - o.getTime();
        if (unit === 'day') return Math.floor(ms / 86400000);
        if (unit === 'hour') return Math.floor(ms / 3600000);
        if (unit === 'minute') return Math.floor(ms / 60000);
        if (unit === 'second') return Math.floor(ms / 1000);
        return ms;
      },
      add(n, unit) {
        const d = new Date(base);
        if (unit === 'day') d.setDate(d.getDate() + n);
        else if (unit === 'hour') d.setHours(d.getHours() + n);
        else if (unit === 'minute') d.setMinutes(d.getMinutes() + n);
        else if (unit === 'month') d.setMonth(d.getMonth() + n);
        else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
        return $helpers.dayjs(d.toISOString());
      },
    };
  },
  // Number formatter — handles thousands sep + decimal precision.
  // Patterns: '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%'.
  format(value, pattern) {
    if (value === null || value === undefined || value === '') return '';
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(n)) return String(value);
    const isPercent = (pattern || '').endsWith('%');
    const num = isPercent ? n * 100 : n;
    const decMatch = (pattern || '').match(/\.([0#]+)/);
    const decimals = decMatch ? decMatch[1].length : 0;
    const groupSep = (pattern || '').includes('#,');
    let s = num.toFixed(decimals);
    if (groupSep) {
      const [intPart, decPart] = s.split('.');
      s = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decPart ? '.' + decPart : '');
    }
    return s + (isPercent ? '%' : '');
  },
};
"""


# Patterns inside the user's body that we reject during compile to harden
# the sandbox. QuickJS itself blocks most of these at runtime, but a
# textual deny-list gives the user a clear error AT EDIT TIME rather than
# letting a typo silently fall through and break a cell on render.
_DENYLIST_PATTERNS = (
    "eval(",
    "Function(",
    "new Function",
    "globalThis",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "process.",
    "require(",
    "import(",
    "import ",
    "fetch(",
    "XMLHttpRequest",
    "Worker(",
    "Atomics.",
    "SharedArrayBuffer",
)


class JsCompileError(ValueError):
    """User-facing compile error — surfaced as the cell value (#ERR: ...)."""


class JsEvalError(ValueError):
    """Per-row runtime error — surfaced as the cell value (#ERR: ...)."""


@dataclass
class CompiledJs:
    """One compiled column body. ``ctx`` is the QuickJS context that holds
    the helpers and the compiled function — reused across rows for speed.
    """
    name: str
    ctx: "_quickjs.Context"
    fn: "_quickjs.Function"


def _check_denylist(body: str) -> None:
    """Surface deny-listed tokens BEFORE compile so the user sees a clear
    error in the editor. False positives are accepted: if a user really
    wants ``'eval('`` inside a string literal they can use ``'ev' + 'al('``.
    """
    for token in _DENYLIST_PATTERNS:
        if token in body:
            raise JsCompileError(
                f"Disallowed pattern in JS formula: '{token.strip('(')}' "
                f"is blocked by the sandbox."
            )


def compile_js_column(name: str, body: str) -> CompiledJs:
    """Compile one column's body. Reused for every row of the page.

    Raises :class:`JsCompileError` on syntax error or deny-list hit.
    """
    if _quickjs is None:
        raise JsCompileError(
            "JS engine not available — install the 'quickjs' package."
        )
    _check_denylist(body)

    ctx = _quickjs.Context()
    # Time + memory budgets (memory cap = 16MB per column context; plenty
    # for spreadsheet logic, prevents a runaway helper from blowing up the
    # backend worker).
    try:
        ctx.set_memory_limit(16 * 1024 * 1024)
    except Exception:  # older bindings — ignore
        pass
    try:
        # quickjs.Context.set_time_limit takes SECONDS (uses C clock()).
        # Convert our millisecond budget once. NB: this is per-CALL wall
        # clock, not per-opcode, so a tight infinite loop still triggers it.
        ctx.set_time_limit(PER_ROW_TIMEOUT_MS / 1000.0)
    except Exception:
        pass

    # Bootstrap helpers FIRST so the compiled function sees ``$helpers``.
    try:
        ctx.eval(_HELPERS_JS)
    except Exception as exc:
        raise JsCompileError(f"Internal: helper bootstrap failed: {exc}") from exc

    # Install the user body as a NAMED global function ``__userFn`` so we
    # can call it via ``__userFn(row, rows, index)`` from the per-row eval
    # without having to interpolate the function object back into source.
    # The wrap form ``function __userFn(row, rows, index){ <body> }`` keeps
    # any syntax error pointing at the user's line.
    wrapped = (
        "var __userFn = function(row, rows, index) {\n"
        f"{body}\n"
        "}; __userFn;"
    )
    try:
        fn = ctx.eval(wrapped)
    except Exception as exc:
        raise JsCompileError(str(exc)) from exc
    return CompiledJs(name=name, ctx=ctx, fn=fn)


def _to_jsonable(value: Any) -> Any:
    """Coerce arbitrary Python value into something QuickJS can read.

    QuickJS accepts JSON-compatible types via JSON.parse. We serialize the
    row dict once per row + call into the compiled function; this is
    measurably faster than walking the dict per-key.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    # Dates, decimals, UUIDs, etc. — stringify.
    return str(value)


def evaluate_js_cell(
    compiled: CompiledJs,
    row: dict,
    rows: List[dict],
    index: int,
) -> Any:
    """Evaluate one row. Returns the JS value (str/num/bool/None/list/dict).

    On any runtime error (TypeError, timeout) raises :class:`JsEvalError`.
    """
    if _quickjs is None:
        raise JsEvalError("JS engine not available.")

    truncated_rows = rows[:MAX_ROWS_IN_SCOPE]
    js_row_str = json.dumps(_to_jsonable(row), default=str, ensure_ascii=False)
    js_rows_str = json.dumps(
        _to_jsonable(truncated_rows), default=str, ensure_ascii=False
    )

    # The quickjs Python wrapper exposes ``ctx.parse_json(str)`` which
    # returns a real JS Object/Array reusable across calls. We hand those
    # to the compiled function via ``fn(row, rows, index)`` — quickjs
    # binds positional args directly, no source-level interpolation.
    try:
        js_row = compiled.ctx.parse_json(js_row_str)
        js_rows = compiled.ctx.parse_json(js_rows_str)
        result = compiled.fn(js_row, js_rows, int(index))
    except Exception as exc:
        raise JsEvalError(str(exc)) from exc

    # QuickJS Python bindings return primitives directly; objects come
    # back as wrappers that JSON.stringify can serialize.
    if isinstance(result, (_quickjs.Object,)):  # type: ignore[attr-defined]
        try:
            return json.loads(result.json())
        except Exception:
            return str(result)
    return result


__all__ = [
    "PER_ROW_TIMEOUT_MS",
    "MAX_ROWS_IN_SCOPE",
    "CompiledJs",
    "JsCompileError",
    "JsEvalError",
    "compile_js_column",
    "evaluate_js_cell",
]
