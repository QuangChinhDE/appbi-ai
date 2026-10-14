"""A user-controlled value can never change the structure of a generated query.

THE BUG
-------
Every builder quoted strings as `"'" + v.replace("'", "''") + "'"`. Correct on
Postgres/DuckDB, where a backslash is an ordinary character. On BigQuery and
MySQL a backslash ESCAPES inside a string literal, so a viewer filter value
ending in a backslash swallowed the closing quote and the next value in the same
IN list ran as SQL:

    col IN ('\\', ') OR 1=1 #')      -- BigQuery: one string, then OR 1=1, then a comment

Viewer filter values reach these builders from public links, embeds, slicers
and the distinct-values search. Fixed by one canonical, dialect-aware literal
function (app/services/sql_literal) that every builder now calls.

HOW THIS PROVES IT (no warehouse needed)
----------------------------------------
1. A reference lexer per dialect, written from the engines' documented string
   rules and independent of the code under test, reads each literal back and
   must end exactly where the literal ends and decode to exactly the input.
2. `sqlglot` (a real SQL parser, already a dependency) parses the WHERE clause
   each real builder emits, on the builder's dialect, and the tree must contain
   exactly the predicate that was asked for, carrying exactly the input values —
   no extra OR, no comment-truncated tail, no second statement.

Live warehouse execution is NOT part of this suite (no credentials in CI); the
lexical contract above is what BigQuery's tokenizer enforces before execution.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlglot
from sqlglot import exp

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_sql_literal_security.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sql_literal import quote_string, sql_literal  # noqa: E402
from app.services.sql_pattern import pattern_predicate, regex_predicate  # noqa: E402

BS = "\\"
Q = "'"

MALICIOUS = [
    "plain",
    "O'Brien",
    BS,                                   # a lone trailing backslash
    "abc" + BS,
    BS + Q,                               # backslash then quote
    BS + BS + Q,
    Q + BS + Q,
    "') OR 1=1 --",
    "') OR 1=1 #",
    BS + "') OR 1=1 #",
    "x'; DROP TABLE users; --",
    "/* c */ ' OR '1'='1",
    "a\nb",                               # raw newline
    "a\rb",
    "tab\tsep",
    "100% _off",                          # LIKE wildcards
    "Đà Nẵng — 東京 — 🙂",                 # Unicode
    "",
]

DIALECTS = ["bigquery", "mysql", "postgresql", "duckdb"]


# ── 1. reference lexers ──────────────────────────────────────────────────────

def _read_literal(sql: str, dialect: str, *, mysql_no_backslash: bool = False) -> tuple[str, int]:
    """Read the single-quoted literal at sql[0]; return (decoded value, end index)."""
    assert sql[0] == Q, sql
    out, i, n = [], 1, len(sql)
    backslash = dialect == "bigquery" or (dialect == "mysql" and not mysql_no_backslash)
    while i < n:
        c = sql[i]
        if backslash and c == BS:
            assert i + 1 < n, "literal ends inside an escape"
            nxt = sql[i + 1]
            out.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0"}.get(nxt, nxt))
            i += 2
            continue
        if c == Q:
            if dialect != "bigquery" and i + 1 < n and sql[i + 1] == Q:
                out.append(Q)
                i += 2
                continue
            return "".join(out), i + 1
        if dialect == "bigquery" and c in "\r\n":
            raise AssertionError("raw newline inside a GoogleSQL quoted string")
        out.append(c)
        i += 1
    raise AssertionError("unterminated literal: " + sql)


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("value", MALICIOUS)
def test_a_literal_reads_back_as_exactly_its_value_and_nothing_after(dialect, value):
    lit = quote_string(value, dialect)
    decoded, end = _read_literal(lit, dialect)
    assert end == len(lit), f"literal ends early on {dialect}: {lit!r}"
    assert decoded == value


@pytest.mark.parametrize("value", MALICIOUS)
def test_mysql_literal_cannot_open_a_string_even_with_no_backslash_escapes(value):
    """Under sql_mode=NO_BACKSLASH_ESCAPES a backslash is literal; the quote is
    doubled (never backslash-escaped), so the literal still ends where it ends."""
    lit = quote_string(value, "mysql")
    _decoded, end = _read_literal(lit, "mysql", mysql_no_backslash=True)
    assert end == len(lit)


def test_non_string_literals():
    assert sql_literal(None, "bigquery") == "NULL"
    assert sql_literal(True, "mysql") == "TRUE"
    assert sql_literal(3, "bigquery") == "3"
    assert sql_literal(2.5, "postgresql") == "2.5"
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError):
            sql_literal(bad, "bigquery")


# ── 2. real builders, parsed by a real SQL parser ───────────────────────────

_SQLGLOT_DIALECT = {"bigquery": "bigquery", "mysql": "mysql", "postgresql": "postgres", "duckdb": "duckdb"}


def _where_tree(where_sql: str, dialect: str) -> exp.Expression:
    body = where_sql.strip()
    if body.upper().startswith("WHERE"):
        body = body[5:]
    stmts = sqlglot.parse(f"SELECT 1 FROM t WHERE {body}", read=_SQLGLOT_DIALECT[dialect])
    assert len(stmts) == 1, f"more than one statement: {where_sql!r}"
    where = stmts[0].args["where"].this
    return where


def _string_values(node: exp.Expression) -> list[str]:
    return [lit.this for lit in node.find_all(exp.Literal) if lit.is_string]


def _assert_one_in(where: exp.Expression, values: list[str], negate: bool = False):
    node = where
    if negate:
        assert isinstance(node, exp.Not), node.sql()
        node = node.this
    assert isinstance(node, exp.In), f"WHERE is not a single IN: {where.sql()}"
    assert [v for v in _string_values(node)] == values
    assert not list(where.find_all(exp.Or)), f"an OR was injected: {where.sql()}"


INJECTION_IN_LISTS = [
    [BS, ") OR 1=1 #"],
    [BS, ") OR 1=1 --"],
    ["abc" + BS, "') OR ('a'='a"],
    [BS + Q, "x"],
    ["O'Brien", "a\nb"],
]


@pytest.mark.parametrize("dialect", ["bigquery", "mysql", "postgresql"])
@pytest.mark.parametrize("values", INJECTION_IN_LISTS)
def test_live_query_in_list_cannot_be_broken_out_of(dialect, values):
    from app.services.live_query_service import _build_where_clause
    sql = _build_where_clause([{"field": "status", "operator": "in", "value": list(values)}], dialect)
    _assert_one_in(_where_tree(sql, dialect), list(values))


def _engine(dialect):
    from app.services.semantic_query_engine import SemanticQueryEngine
    engine = SemanticQueryEngine(db=None, database_type=dialect)  # type: ignore[arg-type]
    engine.views_cache = {
        "revenue": SimpleNamespace(
            measures=[], dimensions=[{"name": "status", "type": "string"}],
            table_name="public.rev", name="revenue",
        )
    }
    return engine


@pytest.mark.parametrize("dialect", ["bigquery", "mysql", "postgresql"])
@pytest.mark.parametrize("values", INJECTION_IN_LISTS)
def test_semantic_engine_in_list_cannot_be_broken_out_of(dialect, values):
    sql = _engine(dialect)._build_where_clause(
        {"revenue.status": {"operator": "in", "value": list(values)}}, {}
    )
    _assert_one_in(_where_tree(sql, dialect), list(values))


@pytest.mark.parametrize("dialect", ["bigquery", "mysql", "postgresql"])
@pytest.mark.parametrize("value", [BS, "abc" + BS, BS + "') OR 1=1 #", "x' OR '1'='1"])
def test_semantic_engine_equality_cannot_be_broken_out_of(dialect, value):
    sql = _engine(dialect)._build_where_clause(
        {"revenue.status": {"operator": "eq", "value": value}}, {}
    )
    where = _where_tree(sql, dialect)
    assert not list(where.find_all(exp.Or)), where.sql()
    assert _string_values(where) == [value]


@pytest.mark.parametrize("dialect", ["bigquery", "mysql", "postgresql"])
@pytest.mark.parametrize("operator", ["contains", "not_contains", "starts_with", "ends_with"])
@pytest.mark.parametrize("value", [BS, "a" + BS, BS + "') OR 1=1 #", "100%_off", "x' OR '1'='1"])
def test_pattern_predicates_cannot_be_broken_out_of(dialect, operator, value):
    pred = pattern_predicate("status", operator, value, dialect, quote=None)  # type: ignore[arg-type]
    where = _where_tree(pred, dialect)
    assert not list(where.find_all(exp.Or)), where.sql()
    strings = _string_values(where)
    if dialect == "bigquery":
        assert strings == [value]
    else:
        # The LIKE pattern carries the value with %, _ and the escape char escaped.
        esc = value.replace(BS, BS + BS).replace("%", BS + "%").replace("_", BS + "_")
        assert len(strings) == 2, strings  # the pattern and the ESCAPE character
        assert BS in strings  # ESCAPE, read back as exactly one backslash
        assert any(esc in s for s in strings if s != BS) or esc == BS, strings


@pytest.mark.parametrize("dialect", ["bigquery", "mysql", "postgresql"])
@pytest.mark.parametrize("value", [BS, "a" + BS, BS + "') OR 1=1 #"])
def test_regex_predicate_cannot_be_broken_out_of(dialect, value):
    pred = regex_predicate("status", value, dialect, quote=None)  # type: ignore[arg-type]
    where = _where_tree(pred, dialect)
    assert not list(where.find_all(exp.Or)), where.sql()
    assert value in _string_values(where)


def test_no_builder_quotes_strings_by_hand_any_more():
    """The class of bug is a builder writing its own `'`-doubling. Every
    user-value path goes through app/services/sql_literal."""
    root = Path(__file__).resolve().parents[1] / "app" / "services"
    needle = 'replace("' + Q + '", "' + Q + Q + '")'
    for name in ("semantic_query_engine.py", "live_query_service.py", "sql_pattern.py",
                 "dataset_model_service.py"):
        src = (root / name).read_text(encoding="utf-8")
        assert needle not in src, f"{name} quotes a literal by hand"
