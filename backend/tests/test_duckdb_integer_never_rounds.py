"""An integer conversion never ROUNDS a decimal — on DuckDB, as on every other dialect.

Bug (report #33, OCC 96.44% vs 96.40% in the source file): a manual upload's decimal
column (OCC 71.3, plan 74.97) was auto-typed `integer`. The DuckDB conversion was a bare
`TRY_CAST(x AS BIGINT)`, and DuckDB rounds `'71.3'` to 71 where BigQuery SAFE_CAST,
Postgres and MySQL give NULL. The type probe used the same expression, so `integer`
reported zero invalid values and beat `float`: every decimal was silently rounded.

Executed on a real DuckDB, not by reading the SQL text.
"""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_duckdb_integer_never_rounds.db")

import duckdb  # noqa: E402
import pytest  # noqa: E402

from app.services.column_type_inference_service import (  # noqa: E402
    _parse_row,
    _pick_best_type,
    build_inference_query,
)
from app.services.type_override_service import build_safe_cast_sql  # noqa: E402

BASE = "SELECT * FROM (VALUES ('71.3', '1000', '2,500', ' 42 '), ('74.97', '-7', '3,000', '7'), " \
       "('91.8', '0', '12', '-3'), ('70.5', '12', '1,000', '8')) AS t(occ, qty, amount, padded)"


def _q(sql: str):
    return duckdb.connect().execute(sql).fetchall()


@pytest.mark.parametrize("text,expected", [("71.3", None), ("71.5", None), ("74.97", None), ("abc", None),
                                           ("71", 71), ("-7", -7), ("1,000", 1000), (" 42 ", 42), ("", None)])
def test_duckdb_integer_conversion_never_rounds(text, expected):
    sql = build_safe_cast_sql(f"'{text}'", "integer", "duckdb")
    assert _q(f"SELECT {sql}")[0][0] == expected


def test_duckdb_float_conversion_keeps_the_decimal():
    assert _q("SELECT " + build_safe_cast_sql("'71.3'", "float", "duckdb"))[0][0] == pytest.approx(71.3)


def test_type_probe_types_a_decimal_column_float_and_an_integer_column_integer():
    cols = ["occ", "qty", "amount", "padded"]
    sql, plan = build_inference_query(BASE, cols, "duckdb")
    con = duckdb.connect()
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    stats = _parse_row(dict(zip(names, cur.fetchone())), plan)
    picked = {c: _pick_best_type(stats[c], 0.001, 3)[0] for c in cols}
    assert picked["occ"] == "float", "a column of decimals must never be typed integer"
    assert picked["qty"] == "integer" and picked["amount"] == "integer" and picked["padded"] == "integer"
