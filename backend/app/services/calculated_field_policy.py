"""What a calculated field may say: an AST allow-list (SEC-01, ADR-004).

A calculated field is user-written SQL that the semantic engine splices into the
query it runs on the datasource's ONE stored credential. The previous guard was
a substring list of DDL/DML words. It let a scalar subquery through
(`(SELECT MAX(salary) FROM hr.payroll)` reads any table the credential can,
beyond the dataset grant and beyond GovernAIScope). It also rejected valid
fields (`updated_at` contains `UPDATE`).

The template is now parsed with sqlglot, after each `${view.field}` reference is
replaced by a placeholder. EVERY node must belong to an explicit allow-list:
arithmetic, comparison, boolean logic, CASE, casts, literals, and a fixed set of
scalar and aggregate functions. Everything else is refused, including anything
that reads a relation (SELECT, subquery, table, EXISTS, set operations), a bare
column that is not a `${view.field}` reference, a window, an unknown function,
and more than one statement.

WHERE IT APPLIES. The engine's `calculated_fields` are fed only by the Direct
Semantic API (`semantic_query_compiler.compile_from_semantic_request`). Saved
charts and dataset previews build specs without them. So enforcing here, for
every caller, enforces the Direct API and every new execution path, and leaves
no saved chart to break. Dashboard HTML-import "calculated fields" are a
different mechanism (dataset transformation steps, `TransformationCompiler`)
and are not routed through here.
"""
from __future__ import annotations

import re

import sqlglot
import sqlglot.expressions as exp

#: The engine's reference syntax (semantic_query_engine._render_calculated_field).
REF_PATTERN = re.compile(r"\$\{([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\}")
_PLACEHOLDER = "__cfref{}"

_DIALECTS = {
    "postgresql": "postgres", "postgres": "postgres", "bigquery": "bigquery",
    "mysql": "mysql", "duckdb": "duckdb",
}

#: Structure: operators, logic, conditionals, literals, casts.
_STRUCTURE = (
    exp.Literal, exp.Null, exp.Boolean, exp.Paren, exp.Neg, exp.Not,
    exp.And, exp.Or, exp.Xor,
    exp.Add, exp.Sub, exp.Mul, exp.Div, exp.IntDiv, exp.Mod, exp.DPipe,
    exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Is, exp.NullSafeEQ,
    exp.Between, exp.Like, exp.ILike,
    exp.Case, exp.If, exp.Cast, exp.TryCast, exp.DataType, exp.DataTypeParam,
    exp.Interval, exp.Column, exp.Identifier, exp.Var, exp.Distinct, exp.Star,
    exp.In, exp.Tuple,
)

#: Scalar and aggregate functions the engine renders on every supported dialect.
_FUNCTIONS = (
    exp.Coalesce, exp.Nullif, exp.Round, exp.Abs, exp.Greatest, exp.Least,
    exp.Floor, exp.Ceil, exp.Sqrt, exp.Pow, exp.Ln, exp.Log, exp.Exp, exp.Sign,
    exp.Lower, exp.Upper, exp.Concat, exp.Length, exp.Substring, exp.Trim,
    exp.StrPosition,
    exp.DateDiff, exp.DateTrunc, exp.TimestampTrunc, exp.Extract,
    exp.DateAdd, exp.DateSub, exp.CurrentDate, exp.CurrentTimestamp,
    exp.Sum, exp.Avg, exp.Min, exp.Max, exp.Count,
) + tuple(
    # Modelled as their own classes by sqlglot (not Anonymous); looked up by name so a
    # version that lacks one simply does not allow it.
    c for c in (getattr(exp, n, None)
                for n in ("SafeDivide", "TimestampDiff", "DatetimeDiff", "TimeToStr",
                          "TsOrDsToDate"))
    if c is not None
)

_ALLOWED = _STRUCTURE + _FUNCTIONS

#: Functions sqlglot does not model in every dialect (they parse as Anonymous).
_ANONYMOUS_ALLOWED = frozenset({
    "SAFE_DIVIDE", "IFNULL", "NVL", "DATE_PART", "TIMESTAMP_DIFF", "DATETIME_DIFF",
    "FORMAT_DATE", "TO_CHAR",
})

#: Where a bare unit word (DAY, MONTH) may stand: exactly the UNIT slot of a
#: date function, nothing else. `EXTRACT(YEAR FROM date)` keeps YEAR and refuses
#: `date` (a raw physical column read without `${view.field}`).
_UNIT_SLOTS = tuple(
    (cls, slot) for cls, slot in (
        (getattr(exp, "DateDiff", None), "unit"), (getattr(exp, "DateTrunc", None), "unit"),
        (getattr(exp, "TimestampTrunc", None), "unit"), (getattr(exp, "DateAdd", None), "unit"),
        (getattr(exp, "DateSub", None), "unit"), (getattr(exp, "TimestampDiff", None), "unit"),
        (getattr(exp, "DatetimeDiff", None), "unit"), (getattr(exp, "Interval", None), "unit"),
        (getattr(exp, "Extract", None), "this"),
    ) if cls is not None
)

#: CAST targets: scalar types only. `CAST('hr.payroll' AS regclass)` would answer
#: whether a table exists on Postgres; no catalog type is reachable.
_CAST_TYPES = frozenset({
    "TINYINT", "SMALLINT", "INT", "BIGINT", "INT128", "UTINYINT", "USMALLINT", "UINT",
    "UBIGINT", "UINT128", "DECIMAL", "BIGDECIMAL", "FLOAT", "DOUBLE",
    "VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "TEXT", "BOOLEAN",
    "DATE", "DATETIME", "TIMESTAMP", "TIMESTAMPTZ", "TIMESTAMPLTZ", "TIME",
})

#: MySQL reads `"x"` as a STRING unless the server runs with ANSI_QUOTES, where it is
#: a COLUMN. The server mode is not known here, so a double quote is refused there.
_DIALECT_HAZARDS = {"mysql": ('"',)}


def _in_unit_slot(node) -> bool:
    parent = node.parent
    return any(isinstance(parent, cls) and node.arg_key == slot for cls, slot in _UNIT_SLOTS)

#: Text that the warehouse lexer and sqlglot may read differently. Comments are the
#: proven case (SEC-01 review): sqlglot nests block comments for BigQuery/MySQL and
#: those engines do not, so `/* /* */ (SELECT ...) + */ 1` parsed as "1" here and
#: ran the subquery there; MySQL also EXECUTES `/*! ... */`. The engine pastes the
#: raw template, so anything the two lexers may disagree on is refused outright.
_LEXER_HAZARDS = ("--", "/*", "*/", "#", "\\", "'''", '"""', "$$")

#: A bare word in a function argument: date and time units only.
_UNITS = frozenset({
    "MICROSECOND", "MILLISECOND", "SECOND", "MINUTE", "HOUR", "DAY", "DAYOFWEEK",
    "DOW", "WEEK", "ISOWEEK", "MONTH", "QUARTER", "YEAR", "ISOYEAR", "EPOCH", "DATE",
})


class CalculatedFieldRefused(ValueError):
    """User-facing: the field uses a construct calculated fields may not use."""


def _refuse(why: str) -> None:
    raise CalculatedFieldRefused(
        f"Trường tính toán không hợp lệ: {why}. Trường tính toán chỉ được dùng "
        "${view.field}, hằng số, phép tính, CASE/IF và các hàm cho phép — không "
        "được đọc bảng khác (SELECT, subquery, EXISTS) hay gọi hàm lạ."
    )


def _substitute(sql: str) -> tuple[str, frozenset[str]]:
    refs: dict[str, str] = {}

    def repl(m: re.Match) -> str:
        return refs.setdefault(m.group(1), _PLACEHOLDER.format(len(refs)))

    if _PLACEHOLDER.format("") in sql:
        _refuse("không được tự viết tên giữ chỗ nội bộ")
    out = REF_PATTERN.sub(repl, sql)
    if "${" in out:
        _refuse("chỉ chấp nhận tham chiếu dạng ${view.field}")
    return out, frozenset(refs.values())


def validate_calculated_field(sql: str, *, dialect: str | None = None) -> None:
    """Raise `CalculatedFieldRefused` (a ValueError: 400 at the API) unless every
    node of ``sql`` is allow-listed."""
    if not (sql or "").strip():
        _refuse("biểu thức rỗng")
    for hazard in _LEXER_HAZARDS + _DIALECT_HAZARDS.get((dialect or "").lower(), ()):
        if hazard in sql:
            _refuse(f"không được dùng chú thích hay ký tự '{hazard}'")
    text, placeholders = _substitute(sql)
    try:
        parsed = sqlglot.parse(text, read=_DIALECTS.get((dialect or "").lower()))
    except sqlglot.errors.SqlglotError:
        _refuse("không phân tích được biểu thức")
    statements = [p for p in parsed if p is not None]
    if len(statements) != 1:
        _refuse("chỉ được một biểu thức")
    for node in statements[0].walk():
        if isinstance(node, exp.Anonymous):
            if str(node.name or "").upper() not in _ANONYMOUS_ALLOWED:
                _refuse(f"hàm '{node.name}' không được phép")
            continue
        if not isinstance(node, _ALLOWED):
            _refuse(f"cấu trúc '{type(node).__name__}' không được phép")
        if isinstance(node, exp.Column):
            name = str(node.name or "")
            ident = node.this if isinstance(node.this, exp.Identifier) else None
            quoted = bool(ident is not None and ident.args.get("quoted"))
            if not node.table and not quoted and name in placeholders:
                continue
            # A unit word some dialects parse as a column (DAY in DATE_DIFF), only in
            # the function's UNIT slot and never quoted: `SUM(year)` and the `date` in
            # `EXTRACT(YEAR FROM date)` are raw physical columns and are refused.
            if (not node.table and not quoted and name.upper() in _UNITS
                    and _in_unit_slot(node)):
                continue
            _refuse(f"cột '{node.sql()}' phải được viết là ${{view.field}}")
        if isinstance(node, exp.DataType) and isinstance(node.parent, (exp.Cast, exp.TryCast)):
            if str(getattr(node.this, "name", node.this)).upper() not in _CAST_TYPES:
                _refuse(f"không được ép kiểu sang '{node.sql()}'")
        if isinstance(node, exp.Var) and (
            str(node.name or "").upper() not in _UNITS or not _in_unit_slot(node)
        ):
            _refuse(f"từ khoá '{node.name}' không được phép")
        if isinstance(node, exp.Star) and not isinstance(node.parent, exp.Count):
            _refuse("'*' chỉ dùng được trong COUNT(*)")
