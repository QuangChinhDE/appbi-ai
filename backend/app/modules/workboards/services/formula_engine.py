"""Safe formula evaluator for grid computed columns.

A workboard grid lets the builder add columns whose value is computed from
other columns in the same row. The formula language is a small Sheets-like
subset — arithmetic, comparisons, logic, and ~25 whitelisted functions
(IF / SUM / CONCAT / TODAY / ROUND / DATEDIF / …). References are bare
column names; everything happens per-row.

**Security model**: we parse the formula with :mod:`ast` and walk the AST
to verify *every* node before evaluation. Anything that could touch the
host process (``Attribute``, ``Subscript``, ``import``, dunder access,
arbitrary ``Call`` targets) raises ``FormulaError``. Function calls are
resolved against a tiny registry — there is no fallback to the Python
builtins, so an attacker who manages to inject a formula cannot reach
``open`` or ``__import__``.

Public surface:

* :class:`FormulaError`   — raised for parse + runtime issues.
* :class:`Formula`         — a compiled formula ready to evaluate.
* :func:`compile_formula`  — parse + validate, returns ``Formula``.
* :func:`evaluate`         — convenience wrapper (compile + eval once).
* :func:`build_dag`        — topological sort over inter-formula deps.
* :func:`function_names`   — list of supported function identifiers.
"""
from __future__ import annotations

import ast
import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Set


class FormulaError(ValueError):
    """Anything that prevents a formula from being parsed or evaluated."""


# ─── Function registry ────────────────────────────────────────────────────
#
# Each entry is ``(callable, min_args, max_args_or_None)``. We keep the
# implementations short and dependency-free; the goal is correctness on the
# common Sheets shapes, not bit-compatibility. ``None`` for ``max_args``
# means variadic (still bounded by Python's recursion / arg limits).


def _num(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise FormulaError(f"Expected a number, got {value!r}") from exc


def _truthy(value: Any) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return True


def _flatten(args: Iterable[Any]) -> List[Any]:
    out: List[Any] = []
    for a in args:
        if isinstance(a, (list, tuple)):
            out.extend(_flatten(a))
        else:
            out.append(a)
    return out


def _coerce_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            if "T" in value or " " in value:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
            return date.fromisoformat(value)
        except ValueError as exc:
            raise FormulaError(f"Bad date string: {value!r}") from exc
    raise FormulaError(f"Cannot interpret {value!r} as a date")


def _fn_if(cond: Any, then: Any, otherwise: Any = None) -> Any:
    return then if _truthy(cond) else otherwise


def _fn_ifs(*args: Any) -> Any:
    """IFS(cond1, val1, cond2, val2, …) — return val of the first true cond."""
    if len(args) % 2 != 0:
        raise FormulaError("IFS expects an even number of arguments.")
    for i in range(0, len(args), 2):
        if _truthy(args[i]):
            return args[i + 1]
    return None


def _fn_and(*args: Any) -> bool:
    return all(_truthy(a) for a in _flatten(args))


def _fn_or(*args: Any) -> bool:
    return any(_truthy(a) for a in _flatten(args))


def _fn_not(value: Any) -> bool:
    return not _truthy(value)


def _fn_sum(*args: Any) -> float:
    return sum(_num(v) for v in _flatten(args) if v not in (None, ""))


def _fn_avg(*args: Any) -> float:
    nums = [_num(v) for v in _flatten(args) if v not in (None, "")]
    if not nums:
        return 0.0
    return sum(nums) / len(nums)


def _fn_min(*args: Any) -> float:
    nums = [_num(v) for v in _flatten(args) if v not in (None, "")]
    if not nums:
        raise FormulaError("MIN of empty set")
    return min(nums)


def _fn_max(*args: Any) -> float:
    nums = [_num(v) for v in _flatten(args) if v not in (None, "")]
    if not nums:
        raise FormulaError("MAX of empty set")
    return max(nums)


def _fn_count(*args: Any) -> int:
    return sum(1 for v in _flatten(args) if v not in (None, ""))


def _fn_round(value: Any, digits: Any = 0) -> float:
    return round(_num(value), int(_num(digits)))


def _fn_ceil(value: Any) -> float:
    return float(math.ceil(_num(value)))


def _fn_floor(value: Any) -> float:
    return float(math.floor(_num(value)))


def _fn_abs(value: Any) -> float:
    return abs(_num(value))


def _fn_coalesce(*args: Any) -> Any:
    for v in args:
        if v is not None and v != "":
            return v
    return None


def _fn_concat(*args: Any) -> str:
    return "".join("" if v is None else str(v) for v in _flatten(args))


def _fn_len(value: Any) -> int:
    return len("" if value is None else str(value))


def _fn_left(value: Any, n: Any = 1) -> str:
    s = "" if value is None else str(value)
    return s[: max(0, int(_num(n)))]


def _fn_right(value: Any, n: Any = 1) -> str:
    s = "" if value is None else str(value)
    n_i = max(0, int(_num(n)))
    return s[-n_i:] if n_i else ""


def _fn_mid(value: Any, start: Any, n: Any) -> str:
    s = "" if value is None else str(value)
    # Sheets MID is 1-indexed; we honour that.
    start_i = max(1, int(_num(start)))
    n_i = max(0, int(_num(n)))
    return s[start_i - 1 : start_i - 1 + n_i]


def _fn_lower(value: Any) -> str:
    return "" if value is None else str(value).lower()


def _fn_upper(value: Any) -> str:
    return "" if value is None else str(value).upper()


def _fn_trim(value: Any) -> str:
    return "" if value is None else re.sub(r"\s+", " ", str(value).strip())


def _fn_today() -> str:
    return date.today().isoformat()


def _fn_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _fn_year(value: Any) -> int:
    return _coerce_date(value).year


def _fn_month(value: Any) -> int:
    return _coerce_date(value).month


def _fn_day(value: Any) -> int:
    return _coerce_date(value).day


def _fn_datedif(start: Any, end: Any, unit: Any = "D") -> int:
    """DATEDIF(start, end, unit) — difference between dates. Unit:
    ``D`` (days), ``M`` (whole months), ``Y`` (whole years)."""
    a = _coerce_date(start)
    b = _coerce_date(end)
    u = ("" if unit is None else str(unit)).upper().strip()
    if u == "D":
        return (b - a).days
    if u == "M":
        return (b.year - a.year) * 12 + (b.month - a.month) - (1 if b.day < a.day else 0)
    if u == "Y":
        years = b.year - a.year
        if (b.month, b.day) < (a.month, a.day):
            years -= 1
        return years
    raise FormulaError(f"DATEDIF unit must be D/M/Y, got {unit!r}")


def _fn_date_add(value: Any, days: Any) -> str:
    return (_coerce_date(value) + timedelta(days=int(_num(days)))).isoformat()


_FUNCTIONS: Dict[str, Callable[..., Any]] = {
    # logic
    "IF": _fn_if,
    "IFS": _fn_ifs,
    "AND": _fn_and,
    "OR": _fn_or,
    "NOT": _fn_not,
    # math
    "SUM": _fn_sum,
    "AVG": _fn_avg,
    "AVERAGE": _fn_avg,
    "MIN": _fn_min,
    "MAX": _fn_max,
    "COUNT": _fn_count,
    "ROUND": _fn_round,
    "CEIL": _fn_ceil,
    "CEILING": _fn_ceil,
    "FLOOR": _fn_floor,
    "ABS": _fn_abs,
    # null-safety
    "COALESCE": _fn_coalesce,
    "IFNULL": _fn_coalesce,
    # text
    "CONCAT": _fn_concat,
    "CONCATENATE": _fn_concat,
    "LEN": _fn_len,
    "LEFT": _fn_left,
    "RIGHT": _fn_right,
    "MID": _fn_mid,
    "LOWER": _fn_lower,
    "UPPER": _fn_upper,
    "TRIM": _fn_trim,
    # date
    "TODAY": _fn_today,
    "NOW": _fn_now,
    "YEAR": _fn_year,
    "MONTH": _fn_month,
    "DAY": _fn_day,
    "DATEDIF": _fn_datedif,
    "DATE_ADD": _fn_date_add,
}


def function_names() -> List[str]:
    """Sorted list of supported function names. Exposed so the builder UI
    can show an autocomplete dropdown without duplicating the registry."""
    return sorted(_FUNCTIONS.keys())


# ─── Compilation (parse + validate) ───────────────────────────────────────
#
# We allow only this subset of AST nodes. Anything else raises before
# evaluation runs.

_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.FloorDiv)
_ALLOWED_UNARYOPS = (ast.UAdd, ast.USub, ast.Not)
_ALLOWED_BOOLOPS = (ast.And, ast.Or)
_ALLOWED_CMPOPS = (
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot
)
_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
    ast.Call, ast.Name, ast.Constant, ast.Load, ast.List, ast.Tuple,
    # Operator marker nodes — walked by ast.walk under their parent.
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.FloorDiv,
    ast.UAdd, ast.USub, ast.Not,
    ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot,
)


class Formula:
    """A parsed, validated formula ready to evaluate against a row scope."""

    __slots__ = ("source", "_tree", "dependencies")

    def __init__(self, source: str, tree: ast.AST, dependencies: Set[str]):
        self.source = source
        self._tree = tree
        self.dependencies = dependencies

    def evaluate(self, row: Dict[str, Any]) -> Any:
        try:
            return _eval_node(self._tree.body, row)  # type: ignore[attr-defined]
        except FormulaError:
            raise
        except ZeroDivisionError as exc:
            raise FormulaError("Division by zero") from exc
        except Exception as exc:  # pragma: no cover — defensive
            raise FormulaError(f"Evaluation error: {exc}") from exc


_KEYWORD_CASE_INSENSITIVE = re.compile(r"\b(AND|OR|NOT|TRUE|FALSE)\b", re.IGNORECASE)


def _rewrite_sheets_operators(text: str) -> str:
    """Rewrite Sheets-style operators to Python syntax outside string literals.

    * ``=`` → ``==`` (when not part of ``<=``, ``>=``, ``==``, ``!=``)
    * ``<>`` → ``!=``
    * Uppercase / mixed-case ``AND`` / ``OR`` / ``NOT`` → lowercase
    * ``TRUE`` / ``FALSE`` (any case) → ``True`` / ``False``
    """
    out: List[str] = []
    buffer: List[str] = []
    i = 0
    in_string: Optional[str] = None

    def _rewrite_keyword(match: re.Match[str]) -> str:
        """Convert ``AND``/``OR``/``NOT`` / ``TRUE``/``FALSE`` to Python
        forms — but leave them alone when followed by ``(`` (function call)."""
        keyword = match.group(0).upper()
        end = match.end()
        # Look ahead past whitespace for a paren — if present, it's a call,
        # keep the original casing so the function lookup still matches.
        rest_idx = end
        while rest_idx < len(text_chunk) and text_chunk[rest_idx].isspace():
            rest_idx += 1
        if rest_idx < len(text_chunk) and text_chunk[rest_idx] == "(":
            return match.group(0)
        return {
            "AND": "and",
            "OR": "or",
            "NOT": "not",
            "TRUE": "True",
            "FALSE": "False",
        }[keyword]

    def flush_buffer() -> None:
        nonlocal text_chunk
        if not buffer:
            return
        text_chunk = "".join(buffer)
        text_chunk = _KEYWORD_CASE_INSENSITIVE.sub(_rewrite_keyword, text_chunk)
        out.append(text_chunk)
        buffer.clear()

    text_chunk = ""

    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if ch == in_string:
                in_string = None
            i += 1
            continue
        if ch in ('"', "'"):
            flush_buffer()
            in_string = ch
            out.append(ch)
            i += 1
            continue
        if ch == "<" and text[i : i + 2] == "<>":
            flush_buffer()
            out.append("!=")
            i += 2
            continue
        if ch == "=":
            flush_buffer()
            prev = out[-1] if out else ""
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if prev in ("=", "<", ">", "!") or nxt == "=":
                out.append(ch)
            else:
                out.append("==")
            i += 1
            continue
        buffer.append(ch)
        i += 1
    flush_buffer()
    return "".join(out)


def compile_formula(source: str, *, allowed_columns: Optional[Iterable[str]] = None) -> Formula:
    """Parse ``source``, verify every node, and collect referenced columns.

    ``allowed_columns`` (optional) restricts which bare names may appear;
    references to anything else raise ``FormulaError``. Function names are
    matched against the internal registry regardless.
    """
    if not isinstance(source, str) or not source.strip():
        raise FormulaError("Empty formula")
    text = source.strip()
    # Strip a leading "=" so users coming from Sheets can paste verbatim.
    if text.startswith("="):
        text = text[1:].lstrip()
    # Rewrite Sheets-style operators to their Python equivalents:
    #   single ``=`` (not ``==``, ``<=``, ``>=``, ``!=``) → ``==``
    #   ``<>``                                            → ``!=``
    # We do the rewrite character-by-character with a tiny scanner so
    # string literals are left untouched.
    text = _rewrite_sheets_operators(text)
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Syntax error: {exc.msg}") from exc

    deps: Set[str] = set()
    allowed_lookup = set(allowed_columns) if allowed_columns is not None else None

    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise FormulaError(
                f"Disallowed expression node: {type(node).__name__}"
            )
        if isinstance(node, ast.BinOp) and not isinstance(node.op, _ALLOWED_BINOPS):
            raise FormulaError(f"Disallowed operator: {type(node.op).__name__}")
        if isinstance(node, ast.UnaryOp) and not isinstance(node.op, _ALLOWED_UNARYOPS):
            raise FormulaError(f"Disallowed operator: {type(node.op).__name__}")
        if isinstance(node, ast.BoolOp) and not isinstance(node.op, _ALLOWED_BOOLOPS):
            raise FormulaError(f"Disallowed operator: {type(node.op).__name__}")
        if isinstance(node, ast.Compare):
            for op in node.ops:
                if not isinstance(op, _ALLOWED_CMPOPS):
                    raise FormulaError(f"Disallowed comparison: {type(op).__name__}")
        if isinstance(node, ast.Call):
            # Only bare-name calls (no method calls, no expressions in callee).
            if not isinstance(node.func, ast.Name):
                raise FormulaError("Only direct function calls are allowed.")
            fname = node.func.id
            if fname not in _FUNCTIONS:
                raise FormulaError(f"Unknown function: {fname}")
            if node.keywords:
                raise FormulaError(f"{fname} does not accept keyword arguments.")
        if isinstance(node, ast.Name):
            ident = node.id
            # Names that are function callees are validated under ast.Call;
            # everything else is a column reference.
            if ident in _FUNCTIONS:
                continue
            if allowed_lookup is not None and ident not in allowed_lookup:
                raise FormulaError(f"Unknown column reference: {ident}")
            deps.add(ident)
        if isinstance(node, ast.Constant):
            # Allow only JSON-ish scalars. Reject e.g. ellipsis, bytes.
            if not isinstance(node.value, (int, float, str, bool, type(None))):
                raise FormulaError(f"Disallowed constant: {type(node.value).__name__}")

    return Formula(source=source, tree=tree, dependencies=deps)


# ─── Evaluation (walk the validated AST) ──────────────────────────────────


def _eval_node(node: ast.AST, scope: Dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _FUNCTIONS:
            # Stand-alone function reference (rare; allow but not callable here).
            return _FUNCTIONS[node.id]
        return scope.get(node.id)
    if isinstance(node, ast.UnaryOp):
        operand = _eval_node(node.operand, scope)
        if isinstance(node.op, ast.UAdd):
            return +_num(operand)
        if isinstance(node.op, ast.USub):
            return -_num(operand)
        if isinstance(node.op, ast.Not):
            return not _truthy(operand)
    if isinstance(node, ast.BinOp):
        left = _eval_node(node.left, scope)
        right = _eval_node(node.right, scope)
        op = node.op
        # Concatenate strings with `+` if either side is a string.
        if isinstance(op, ast.Add) and (isinstance(left, str) or isinstance(right, str)):
            return ("" if left is None else str(left)) + ("" if right is None else str(right))
        a, b = _num(left), _num(right)
        if isinstance(op, ast.Add): return a + b
        if isinstance(op, ast.Sub): return a - b
        if isinstance(op, ast.Mult): return a * b
        if isinstance(op, ast.Div): return a / b
        if isinstance(op, ast.Mod): return a % b
        if isinstance(op, ast.Pow): return a ** b
        if isinstance(op, ast.FloorDiv): return a // b
    if isinstance(node, ast.BoolOp):
        values = [_eval_node(v, scope) for v in node.values]
        if isinstance(node.op, ast.And):
            return all(_truthy(v) for v in values)
        return any(_truthy(v) for v in values)
    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, scope)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval_node(comparator, scope)
            if not _compare(left, right, op):
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        return (
            _eval_node(node.body, scope)
            if _truthy(_eval_node(node.test, scope))
            else _eval_node(node.orelse, scope)
        )
    if isinstance(node, ast.Call):
        fname = node.func.id  # type: ignore[union-attr]
        fn = _FUNCTIONS[fname]
        args = [_eval_node(a, scope) for a in node.args]
        return fn(*args)
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval_node(e, scope) for e in node.elts]
    raise FormulaError(f"Unsupported node at eval time: {type(node).__name__}")


def _compare(left: Any, right: Any, op: ast.cmpop) -> bool:
    # Equality / identity treat None/"" as "empty"; numeric comparisons coerce.
    if isinstance(op, (ast.Eq, ast.Is)):
        return _coerce_equal(left, right)
    if isinstance(op, (ast.NotEq, ast.IsNot)):
        return not _coerce_equal(left, right)
    a, b = _num(left), _num(right)
    if isinstance(op, ast.Lt): return a < b
    if isinstance(op, ast.LtE): return a <= b
    if isinstance(op, ast.Gt): return a > b
    if isinstance(op, ast.GtE): return a >= b
    raise FormulaError(f"Unsupported comparison: {type(op).__name__}")


def _coerce_equal(left: Any, right: Any) -> bool:
    # Strict equality, with the convenience that "" and None compare equal so
    # ``IF(name = "", …)`` matches both empty cells and explicit NULLs.
    if left is None and right == "":
        return True
    if right is None and left == "":
        return True
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    return left == right


def evaluate(source: str, row: Dict[str, Any]) -> Any:
    return compile_formula(source).evaluate(row)


# ─── Dependency DAG (topological sort) ───────────────────────────────────


def build_dag(
    formulas: Dict[str, Formula],
    *,
    external_columns: Iterable[str] = (),
) -> List[str]:
    """Return formula names in evaluation order (Kahn's algorithm).

    Raises ``FormulaError`` if the graph is cyclic or references an unknown
    column. ``external_columns`` lists names that exist on the row from the
    outside (regular DB columns, lookup columns evaluated earlier) — they
    aren't ordered, just allowed to appear as dependencies.
    """
    externals = set(external_columns)
    names = set(formulas.keys())
    indegree: Dict[str, int] = {name: 0 for name in names}
    edges: Dict[str, List[str]] = {name: [] for name in names}

    for name, formula in formulas.items():
        for dep in formula.dependencies:
            if dep in names:
                edges[dep].append(name)
                indegree[name] += 1
            elif dep not in externals:
                raise FormulaError(
                    f"Formula '{name}' references unknown column '{dep}'."
                )

    queue = [name for name, deg in indegree.items() if deg == 0]
    order: List[str] = []
    while queue:
        # Stable order — sort by name so the output is deterministic across runs.
        queue.sort()
        current = queue.pop(0)
        order.append(current)
        for downstream in edges[current]:
            indegree[downstream] -= 1
            if indegree[downstream] == 0:
                queue.append(downstream)

    if len(order) != len(names):
        remaining = sorted(n for n, deg in indegree.items() if deg > 0)
        raise FormulaError(f"Circular dependency among: {', '.join(remaining)}")
    return order
