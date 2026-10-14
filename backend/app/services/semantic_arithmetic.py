"""Division means the same number on every engine.

Semantic Kernel Contract — Numeric/Formula Meaning: ``a / b`` in a semantic
expression (a measure's ``sql`` / ``expression``, a formula over measures, a
dimension's SQL, a measure ``where_sql``, a chart calculated field) is TRUE
division, and a zero denominator is NULL (undefined, never a number):

    engine      a / b as written            here
    postgresql  integer division (5/2 = 2)  a * 1.0 / NULLIF(b, 0)   → 2.5 (numeric)
    mysql       DECIMAL, 4 extra digits     a * 1e0 / b              → 2.5 (double)
                (1/30000 = 0.0000)          (x / 0 is already NULL in a SELECT, strict
                                            modes included; NULLIF around a window
                                            function is evaluated twice by MySQL 8 in an
                                            ungrouped query — SUM(SUM(a)) OVER () doubled)
    bigquery    FLOAT64 / NUMERIC; /0 error a / NULLIF(b, 0)
    duckdb      DOUBLE; x/0 = inf           a / NULLIF(b, 0)

Only the author's text is touched: the rewrite runs on the TEMPLATE, before
``${…}`` placeholders are substituted, so SQL the engine generates for a
referenced measure is never re-parsed. Each ``/`` operator (outside strings,
quoted identifiers, comments and placeholders — lexed per dialect: backslash
escapes and ``#`` comments on MySQL / BigQuery, BigQuery's ``"…"`` and
triple-quoted strings) gets the dialect's promotion inserted right before it —
``*`` and ``/`` share one precedence level and associate left, so ``L / R`` →
``L * 1.0 / R`` multiplies exactly the left operand — and its right operand
(one primary: a literal, a typed literal, a column, a placeholder, a
parenthesised expression, a function call with its OVER / FILTER, a CASE, with
``::type`` and ``[…]`` postfixes) is wrapped in ``NULLIF(…, 0)`` unless it
already is ``NULLIF(…, 0)`` or a non-zero number literal. A right operand this
scanner cannot read is left as written (that division keeps the engine's own
semantics). DuckDB's explicit integer division ``//`` is kept.
"""
from __future__ import annotations

import re

_PROMOTE = {"postgresql": " * 1.0", "postgres": " * 1.0", "mysql": " * 1e0"}

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")
_NUMBER = re.compile(r"(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_CAST_WORDS = {"precision", "varying", "with", "without", "time", "zone"}
# `NUMERIC '1.5'`, `DATE '2024-01-01'`, `INTERVAL '1' DAY` / `INTERVAL 1 DAY`
_TYPED_LITERALS = {"date", "time", "timestamp", "timestamptz", "datetime", "interval", "numeric",
                   "bignumeric", "decimal", "json", "real", "float", "double", "bigint", "integer", "int"}
_INTERVAL_UNITS = {"microsecond", "millisecond", "second", "minute", "hour", "day", "week", "month",
                   "quarter", "year", "decade", "century"}


class _Lexer:
    """Dialect-aware skipping of the atoms a `/` inside them is NOT an operator."""

    def __init__(self, dialect: str):
        d = (dialect or "").lower()
        self.backslash = d in ("mysql", "bigquery")          # '\'' escapes; Postgres / DuckDB: literal
        self.hash_comments = d in ("mysql", "bigquery")      # `#` starts a comment (Postgres: an operator)
        self.dq_strings = d == "bigquery"                    # "…" is a string (with escapes)

    def skip_quoted(self, s: str, i: int) -> int:
        n = len(s)
        q = s[i]
        if self.dq_strings and s.startswith(q * 3, i) and q in "'\"":
            end = s.find(q * 3, i + 3)
            return n if end < 0 else end + 3
        escapes = self.backslash and (q == "'" or (q == '"' and self.dq_strings))
        j = i + 1
        while j < n:
            c = s[j]
            if c == "\\" and escapes:
                j += 2
                continue
            if c == q:
                if j + 1 < n and s[j + 1] == q:   # doubled quote = escaped
                    j += 2
                    continue
                return j + 1
            j += 1
        return n

    def skip_atom(self, s: str, i: int) -> int | None:
        """If ``s[i:]`` starts a string, quoted identifier, comment or
        placeholder, return the index after it; else None."""
        c = s[i]
        if c in "'\"`":
            return self.skip_quoted(s, i)
        if s.startswith("--", i) or (c == "#" and self.hash_comments):
            j = s.find("\n", i)
            return len(s) if j < 0 else j
        if s.startswith("/*", i):
            j = s.find("*/", i + 2)
            return len(s) if j < 0 else j + 2
        if s.startswith("${", i):
            j = s.find("}", i)
            return len(s) if j < 0 else j + 1
        return None

    def is_comment(self, s: str, i: int) -> bool:
        return s.startswith("--", i) or s.startswith("/*", i) or (s[i:i + 1] == "#" and self.hash_comments)

    def ws(self, s: str, i: int) -> int:
        """Skip whitespace AND comments."""
        n = len(s)
        while i < n:
            if s[i].isspace():
                i += 1
            elif self.is_comment(s, i):
                i = self.skip_atom(s, i)
            else:
                break
        return i

    def match_paren(self, s: str, i: int) -> int | None:
        """``s[i] == '('`` → index after its matching ``)``."""
        depth = 0
        j = i
        n = len(s)
        while j < n:
            k = self.skip_atom(s, j)
            if k is not None:
                j = k
                continue
            if s[j] == "(":
                depth += 1
            elif s[j] == ")":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return None

    def match_bracket(self, s: str, i: int) -> int | None:
        """``s[i] == '['`` → index after its matching ``]``."""
        depth = 0
        j = i
        n = len(s)
        while j < n:
            k = self.skip_atom(s, j)
            if k is not None:
                j = k
                continue
            if s[j] == "[":
                depth += 1
            elif s[j] == "]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return None

    def match_case(self, s: str, i: int) -> int | None:
        """``s[i:]`` starts ``CASE`` → index after its matching ``END``."""
        depth = 0
        j = i
        n = len(s)
        while j < n:
            k = self.skip_atom(s, j)
            if k is not None:
                j = k
                continue
            if s[j] == "(":
                k = self.match_paren(s, j)
                if k is None:
                    return None
                j = k
                continue
            m = _IDENT.match(s, j)
            if m and (j == 0 or not (s[j - 1].isalnum() or s[j - 1] in "_$.")):
                word = m.group(0).upper()
                if word == "CASE":
                    depth += 1
                elif word == "END":
                    depth -= 1
                    if depth == 0:
                        return m.end()
                j = m.end()
                continue
            j += 1
        return None

    def call_suffix_end(self, s: str, j: int) -> int | None:
        """After a function call's ``)``: its ``WITHIN GROUP (…)``, ``FILTER (…)``
        and ``OVER (…)`` / ``OVER name`` belong to the same operand."""
        n = len(s)
        while True:
            k = self.ws(s, j)
            m = _IDENT.match(s, k)
            if not m:
                return j
            word = m.group(0).upper()
            if word == "WITHIN":
                k2 = self.ws(s, m.end())
                m2 = _IDENT.match(s, k2)
                if not (m2 and m2.group(0).upper() == "GROUP"):
                    return j
                k3 = self.ws(s, m2.end())
                if k3 >= n or s[k3] != "(":
                    return j
                j = self.match_paren(s, k3)
            elif word in ("FILTER", "OVER"):
                k2 = self.ws(s, m.end())
                if k2 < n and s[k2] == "(":
                    j = self.match_paren(s, k2)
                elif word == "OVER" and _IDENT.match(s, k2):
                    j = _IDENT.match(s, k2).end()
                else:
                    return j
            else:
                return j
            if j is None:
                return None

    def primary_end(self, s: str, i: int) -> int | None:
        """End index of the primary expression starting at ``s[i]`` (one right
        operand of ``/``), or None when it is not something this scanner reads."""
        n = len(s)
        j = self.ws(s, i)
        while j < n and s[j] in "+-" and not self.is_comment(s, j):
            j = self.ws(s, j + 1)
        if j >= n:
            return None
        c = s[j]
        if c == "(":
            j = self.match_paren(s, j)
        elif s.startswith("${", j) or c == "`" or (c == '"' and not self.dq_strings):
            j = self.skip_atom(s, j)
        elif c == "'" or (c == '"' and self.dq_strings):
            j = self.skip_quoted(s, j)
        elif c.isdigit() or (c == "." and j + 1 < n and s[j + 1].isdigit()):
            j = _NUMBER.match(s, j).end()
        elif _IDENT.match(s, j):
            m = _IDENT.match(s, j)
            word = m.group(0).lower()
            if word == "case":
                j = self.match_case(s, j)
            else:
                j = m.end()
                k = self.ws(s, j)
                if k < n and s[k] == "(":
                    j = self.match_paren(s, k)
                    if j is not None:
                        j = self.call_suffix_end(s, j)
                elif word in _TYPED_LITERALS and k < n and (s[k] == "'" or (s[k] == '"' and self.dq_strings)):
                    j = self.skip_quoted(s, k)
                    if word == "interval":
                        k2 = self.ws(s, j)
                        m2 = _IDENT.match(s, k2)
                        if m2 and m2.group(0).lower() in _INTERVAL_UNITS:
                            j = m2.end()
                elif word == "interval" and k < n and (s[k].isdigit()):
                    j = _NUMBER.match(s, k).end()
                    k2 = self.ws(s, j)
                    m2 = _IDENT.match(s, k2)
                    if m2 and m2.group(0).lower() in _INTERVAL_UNITS:
                        j = m2.end()
        else:
            return None
        if j is None:
            return None
        # member chain: `${TABLE}.col`, `view."Col"`, `t.*`
        while j < n and s[j] == ".":
            k = j + 1
            if k < n and (s[k] in "\"`" or s.startswith("${", k)):
                j = self.skip_atom(s, k)
            elif k < n and s[k] == "*":
                j = k + 1
            else:
                m = _IDENT.match(s, k)
                if not m:
                    break
                j = m.end()
                k2 = self.ws(s, j)
                if k2 < n and s[k2] == "(":
                    j = self.match_paren(s, k2)
                    if j is None:
                        return None
                    j = self.call_suffix_end(s, j)
                    if j is None:
                        return None
        # postfixes: casts `::numeric`, `:: double precision`, `::numeric(10,2)`, `::int[]`; subscripts `[1]`
        while True:
            k = self.ws(s, j)
            if k < n and s[k] == "[":
                e = self.match_bracket(s, k)
                if e is None:
                    return None
                j = e
                continue
            if not s.startswith("::", k):
                break
            k = self.ws(s, k + 2)
            m = _IDENT.match(s, k)
            if not m:
                return None
            j = m.end()
            while True:
                k2 = self.ws(s, j)
                m2 = _IDENT.match(s, k2)
                if m2 and m2.group(0).lower() in _CAST_WORDS:
                    j = m2.end()
                    continue
                break
            k2 = self.ws(s, j)
            if k2 < n and s[k2] == "(":
                j = self.match_paren(s, k2)
                if j is None:
                    return None
        return j

    def split_top_level(self, s: str) -> list[str]:
        """Comma-separated top-level parts of ``s`` (outside parens/atoms)."""
        parts, depth, start, j, n = [], 0, 0, 0, len(s)
        while j < n:
            k = self.skip_atom(s, j)
            if k is not None:
                j = k
                continue
            if s[j] in "([":
                depth += 1
            elif s[j] in ")]":
                depth -= 1
            elif s[j] == "," and depth == 0:
                parts.append(s[start:j])
                start = j + 1
            j += 1
        parts.append(s[start:])
        return parts

    def already_safe(self, rhs: str) -> bool:
        """A non-zero number literal, or ``NULLIF(<x>, 0)`` (a zero guard)."""
        r = rhs.strip()
        if _NUMBER.fullmatch(r):
            try:
                return float(r) != 0.0
            except ValueError:
                return False
        m = re.match(r"(?i)NULLIF\s*\(", r)
        if not m or self.match_paren(r, m.end() - 1) != len(r):
            return False
        args = self.split_top_level(r[m.end():-1])
        if len(args) != 2 or not _NUMBER.fullmatch(args[1].strip()):
            return False
        return float(args[1].strip()) == 0.0


def promotion(dialect: str) -> str:
    return _PROMOTE.get((dialect or "").lower(), "")


def _guards_zero(dialect: str) -> bool:
    """Does ``x / 0`` need NULLIF on this engine? (MySQL: NULL already.)"""
    return (dialect or "").lower() != "mysql"


def true_division_sql(numerator: str, denominator: str, dialect: str) -> str:
    """``numerator / denominator`` as true division, NULL on a zero denominator."""
    den = f"NULLIF({denominator}, 0)" if _guards_zero(dialect) else denominator
    return f"{numerator}{promotion(dialect)} / {den}"


def normalize_division(template: str, dialect: str) -> str:
    """Rewrite every ``/`` operator of an author-written SQL expression into
    true division with a NULL zero-denominator, for ``dialect`` (see module)."""
    s = str(template or "")
    if "/" not in s:
        return s
    lx = _Lexer(dialect)
    promo = promotion(dialect)
    guard = _guards_zero(dialect)
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        k = lx.skip_atom(s, i)
        if k is not None:
            out.append(s[i:k])
            i = k
            continue
        if s[i] != "/":
            out.append(s[i])
            i += 1
            continue
        if s.startswith("//", i):          # DuckDB integer division — explicit, kept
            out.append("//")
            i += 2
            continue
        end = lx.primary_end(s, i + 1)
        if end is None:
            out.append("/")
            i += 1
            continue
        rhs = normalize_division(s[i + 1:end], dialect)
        # only spaces / tabs: a newline may end a `--` / `#` comment the promotion
        # and the division must never be appended to
        left = re.sub(r"[ \t]+$", "", "".join(out))
        rhs_core = rhs.strip()
        wrapped = rhs_core if (lx.already_safe(rhs_core) or not guard) else f"NULLIF({rhs_core}, 0)"
        out = [left, promo, " / ", wrapped]
        i = end
    return "".join(out)
