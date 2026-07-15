"""Mini expression evaluator that mirrors the dataset transformation grammar.

The dataset's ``transformation_compiler.py`` compiles expressions like
``[Goals] >= 5`` or ``IF([defect] > 0, "alert", "ok")`` into SQL. For
mini-app conditional UI (show_if / required_if / readonly_if) we need the
same grammar evaluated against an in-memory row context, both server-side
(write enforcement) and client-side (realtime UI). This module is the
server-side evaluator; ``frontend/src/lib/wb-expr.ts`` ports it to TS.

Supported subset (sufficient for AppSheet-style "Show_If" expressions):

  Literals     numbers, "strings", true/false, null
  Refs         [column_name]   bare_name   {{app_user.username}}   {{shared.col}}   {{today}}   {{now}}
  Comparisons  == != > >= < <=
  Logical      && || NOT
  Arithmetic   + - * /  (basic)
  Functions    IF(cond, then, else)  COALESCE(a, b, ...)  ROUND(x [, n])  ABS(x)
               CEIL(x)  FLOOR(x)  GREATEST(a, b, ...)  LEAST(a, b, ...)
               NULLIF(a, b)  IN(value, a, b, ...)  NOT(expr)

Anything outside this subset returns ``None`` (treated as "false" by
boolean contexts), so a malformed expression never throws — the form just
behaves as if the rule weren't set.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


_TOKEN_RE = re.compile(
    r"""
    \s*
    (?:
        (?P<num>-?\d+(?:\.\d+)?)
      | (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
      | (?P<colref>\[[^\]]+\])
      | (?P<placeholder>\{\{[^}]+\}\})
      | (?P<op>==|!=|>=|<=|&&|\|\||[+\-*/<>(),])
      | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    )
    """,
    re.VERBOSE,
)


def tokenize(expr: str) -> List[Tuple[str, str]]:
    tokens: List[Tuple[str, str]] = []
    pos = 0
    while pos < len(expr):
        m = _TOKEN_RE.match(expr, pos)
        if not m or m.end() == pos:
            # Unknown char → bail; the parser surfaces None for safety.
            raise ValueError(f"Unexpected character at position {pos}: {expr[pos:pos+20]!r}")
        for name in ("num", "str", "colref", "placeholder", "op", "ident"):
            if m.group(name) is not None:
                tokens.append((name, m.group(name)))
                break
        pos = m.end()
    tokens.append(("end", ""))
    return tokens


# ── Pratt-style recursive descent parser ──────────────────────────────────


class _Parser:
    def __init__(self, tokens: List[Tuple[str, str]]) -> None:
        self.tokens = tokens
        self.idx = 0

    def peek(self) -> Tuple[str, str]:
        return self.tokens[self.idx]

    def consume(self) -> Tuple[str, str]:
        tok = self.tokens[self.idx]
        self.idx += 1
        return tok

    def expect(self, op: str) -> None:
        tok = self.consume()
        if tok[0] != "op" or tok[1] != op:
            raise ValueError(f"Expected {op}, got {tok}")

    def parse(self) -> Any:
        node = self._or()
        if self.peek()[0] != "end":
            raise ValueError(f"Trailing tokens: {self.tokens[self.idx:]}")
        return node

    def _or(self) -> Any:
        left = self._and()
        while self.peek() == ("op", "||"):
            self.consume()
            right = self._and()
            left = ("op", "||", left, right)
        return left

    def _and(self) -> Any:
        left = self._cmp()
        while self.peek() == ("op", "&&"):
            self.consume()
            right = self._cmp()
            left = ("op", "&&", left, right)
        return left

    def _cmp(self) -> Any:
        left = self._add()
        while self.peek()[0] == "op" and self.peek()[1] in {"==", "!=", ">", ">=", "<", "<="}:
            op = self.consume()[1]
            right = self._add()
            left = ("op", op, left, right)
        return left

    def _add(self) -> Any:
        left = self._mul()
        while self.peek()[0] == "op" and self.peek()[1] in {"+", "-"}:
            op = self.consume()[1]
            right = self._mul()
            left = ("op", op, left, right)
        return left

    def _mul(self) -> Any:
        left = self._unary()
        while self.peek()[0] == "op" and self.peek()[1] in {"*", "/"}:
            op = self.consume()[1]
            right = self._unary()
            left = ("op", op, left, right)
        return left

    def _unary(self) -> Any:
        if self.peek() == ("op", "-"):
            self.consume()
            return ("neg", self._unary())
        return self._atom()

    def _atom(self) -> Any:
        tok = self.consume()
        kind, val = tok
        if kind == "num":
            return ("num", float(val) if "." in val else int(val))
        if kind == "str":
            # Strip quotes, unescape minimal.
            return ("str", val[1:-1].replace("\\\"", "\"").replace("\\'", "'"))
        if kind == "colref":
            return ("col", val[1:-1].strip())
        if kind == "placeholder":
            return ("ph", val[2:-2].strip())
        if kind == "ident":
            ident = val
            # Function call?
            if self.peek() == ("op", "("):
                self.consume()
                args: List[Any] = []
                if self.peek() != ("op", ")"):
                    args.append(self._or())
                    while self.peek() == ("op", ","):
                        self.consume()
                        args.append(self._or())
                self.expect(")")
                return ("call", ident.upper(), args)
            # Bare identifier — boolean keyword or column reference.
            up = ident.upper()
            if up == "TRUE":
                return ("bool", True)
            if up == "FALSE":
                return ("bool", False)
            if up == "NULL":
                return ("null",)
            return ("col", ident)
        if kind == "op" and val == "(":
            inner = self._or()
            self.expect(")")
            return inner
        raise ValueError(f"Unexpected token {tok}")


# ── Evaluator ─────────────────────────────────────────────────────────────


def _coerce_number(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    return None


def _truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() not in {"", "false", "0", "null", "none"}
    if isinstance(v, (list, dict)):
        return bool(v)
    return bool(v)


def _resolve_placeholder(path: str, ctx: Dict[str, Any]) -> Any:
    if path == "today":
        return datetime.now(timezone.utc).date().isoformat()
    if path == "now":
        return datetime.now(timezone.utc).isoformat()
    parts = path.split(".")
    cursor: Any = ctx
    for p in parts:
        if isinstance(cursor, dict) and p in cursor:
            cursor = cursor[p]
        else:
            return None
    return cursor


def _eval(node: Any, ctx: Dict[str, Any]) -> Any:
    if not isinstance(node, tuple):
        return node
    head = node[0]
    if head == "num":
        return node[1]
    if head == "str":
        return node[1]
    if head == "bool":
        return node[1]
    if head == "null":
        return None
    if head == "col":
        # Look up in row first, then in shared / app_user pseudo-tables.
        col = node[1]
        row = ctx.get("row") or {}
        if col in row:
            return row[col]
        return None
    if head == "ph":
        return _resolve_placeholder(node[1], ctx)
    if head == "neg":
        v = _coerce_number(_eval(node[1], ctx))
        return -v if v is not None else None
    if head == "op":
        _, op, a, b = node
        if op == "&&":
            return _truthy(_eval(a, ctx)) and _truthy(_eval(b, ctx))
        if op == "||":
            return _truthy(_eval(a, ctx)) or _truthy(_eval(b, ctx))
        av, bv = _eval(a, ctx), _eval(b, ctx)
        if op == "==":
            return av == bv
        if op == "!=":
            return av != bv
        if op in {">", ">=", "<", "<="}:
            an, bn = _coerce_number(av), _coerce_number(bv)
            if an is None or bn is None:
                # Fall back to string compare so dates/strings still work.
                if isinstance(av, str) and isinstance(bv, str):
                    if op == ">":
                        return av > bv
                    if op == ">=":
                        return av >= bv
                    if op == "<":
                        return av < bv
                    if op == "<=":
                        return av <= bv
                return False
            if op == ">":
                return an > bn
            if op == ">=":
                return an >= bn
            if op == "<":
                return an < bn
            if op == "<=":
                return an <= bn
        if op in {"+", "-", "*", "/"}:
            an, bn = _coerce_number(av), _coerce_number(bv)
            if an is None or bn is None:
                return None
            if op == "+":
                return an + bn
            if op == "-":
                return an - bn
            if op == "*":
                return an * bn
            if op == "/":
                return an / bn if bn != 0 else None
    if head == "call":
        _, name, args = node
        evaluated = [_eval(a, ctx) for a in args]
        if name == "IF":
            cond = evaluated[0] if evaluated else None
            return evaluated[1] if _truthy(cond) and len(evaluated) > 1 else (
                evaluated[2] if len(evaluated) > 2 else None
            )
        if name == "COALESCE":
            for v in evaluated:
                if v is not None:
                    return v
            return None
        if name == "ROUND":
            x = _coerce_number(evaluated[0]) if evaluated else None
            digits = int(_coerce_number(evaluated[1]) or 0) if len(evaluated) > 1 else 0
            return None if x is None else round(x, digits)
        if name == "ABS":
            x = _coerce_number(evaluated[0]) if evaluated else None
            return None if x is None else abs(x)
        if name == "CEIL":
            import math
            x = _coerce_number(evaluated[0]) if evaluated else None
            return None if x is None else math.ceil(x)
        if name == "FLOOR":
            import math
            x = _coerce_number(evaluated[0]) if evaluated else None
            return None if x is None else math.floor(x)
        if name == "GREATEST":
            nums = [_coerce_number(v) for v in evaluated]
            nums = [n for n in nums if n is not None]
            return max(nums) if nums else None
        if name == "LEAST":
            nums = [_coerce_number(v) for v in evaluated]
            nums = [n for n in nums if n is not None]
            return min(nums) if nums else None
        if name == "NULLIF":
            if len(evaluated) >= 2 and evaluated[0] == evaluated[1]:
                return None
            return evaluated[0] if evaluated else None
        if name == "IN":
            if not evaluated:
                return False
            return evaluated[0] in evaluated[1:]
        if name == "NOT":
            return not _truthy(evaluated[0]) if evaluated else True
        if name == "AND":
            return all(_truthy(v) for v in evaluated)
        if name == "OR":
            return any(_truthy(v) for v in evaluated)
        if name == "ISBLANK":
            v = evaluated[0] if evaluated else None
            return v is None or (isinstance(v, str) and v.strip() == "")
        # ── Text ──
        if name == "CONCAT":
            return "".join("" if v is None else str(v) for v in evaluated)
        if name == "UPPER":
            return str(evaluated[0]).upper() if evaluated and evaluated[0] is not None else None
        if name == "LOWER":
            return str(evaluated[0]).lower() if evaluated and evaluated[0] is not None else None
        if name == "TRIM":
            return str(evaluated[0]).strip() if evaluated and evaluated[0] is not None else None
        if name == "LEN":
            return len(str(evaluated[0])) if evaluated and evaluated[0] is not None else 0
        if name == "LEFT":
            s = "" if not evaluated or evaluated[0] is None else str(evaluated[0])
            n = int(_coerce_number(evaluated[1]) or 0) if len(evaluated) > 1 else 0
            return s[:max(n, 0)]
        if name == "RIGHT":
            s = "" if not evaluated or evaluated[0] is None else str(evaluated[0])
            n = int(_coerce_number(evaluated[1]) or 0) if len(evaluated) > 1 else 0
            return s[-n:] if n > 0 else ""
        if name == "CONTAINS":
            hay = "" if not evaluated or evaluated[0] is None else str(evaluated[0])
            needle = "" if len(evaluated) < 2 or evaluated[1] is None else str(evaluated[1])
            return needle in hay
        # ── Math ──
        if name == "MOD":
            a = _coerce_number(evaluated[0]) if evaluated else None
            b = _coerce_number(evaluated[1]) if len(evaluated) > 1 else None
            return None if a is None or not b else a % b
        if name == "POWER":
            a = _coerce_number(evaluated[0]) if evaluated else None
            b = _coerce_number(evaluated[1]) if len(evaluated) > 1 else None
            return None if a is None or b is None else a ** b
        # ── Date parts (ISO date/datetime string) ──
        if name in ("YEAR", "MONTH", "DAY"):
            s = str(evaluated[0]) if evaluated and evaluated[0] is not None else ""
            m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
            if not m:
                return None
            return int(m.group({"YEAR": 1, "MONTH": 2, "DAY": 3}[name]))
        # Unknown function — fail soft.
        return None
    return None


def evaluate(expression: Optional[str], ctx: Dict[str, Any]) -> Any:
    """Evaluate ``expression`` against ``ctx``.

    ``ctx`` shape::
        {
          "row": {col: value, ...},     # current form values
          "app_user": {username, role, ...},
          "shared": {...}               # shared_context from upstream screens
        }

    Returns ``None`` on parse error or unknown construct, so callers can
    treat failures as "rule didn't match".
    """
    if not expression:
        return None
    try:
        tokens = tokenize(expression)
        node = _Parser(tokens).parse()
        return _eval(node, ctx)
    except Exception:
        return None


def evaluate_truthy(expression: Optional[str], ctx: Dict[str, Any], default: bool = True) -> bool:
    """Evaluate as boolean. ``default`` is returned when expression is empty."""
    if not expression:
        return default
    return _truthy(evaluate(expression, ctx))
