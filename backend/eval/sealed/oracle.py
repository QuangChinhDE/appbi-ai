"""The oracle: an independent answer, computed on the fixture with DuckDB.

DuckDB on an in-memory copy of the fixture, never the AppBI engine: an oracle
that ran through the semantic engine would agree with the system it is meant to
judge, including on its bugs.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from decimal import Decimal

from .case import FIXTURES_DIR, EvalCase


@dataclass(frozen=True)
class Expected:
    columns: tuple[str, ...]
    rows: tuple[tuple, ...]
    #: sha256 of the canonical result. The same case on the same fixture always
    #: yields the same fingerprint, which is what makes a run reproducible.
    fingerprint: str

    @property
    def scalar(self):
        if len(self.rows) != 1 or len(self.rows[0]) != 1:
            raise ValueError(f"not a scalar result: {len(self.rows)} rows")
        return self.rows[0][0]


def _norm(v):
    if isinstance(v, Decimal):
        v = float(v)
    if isinstance(v, float):
        if math.isnan(v):
            return None
        return round(v, 9)
    return v


def load_fixture(name: str):
    """A fresh in-memory DuckDB holding the fixture's tables."""
    import duckdb

    spec = json.loads((FIXTURES_DIR / f"{name}.json").read_text(encoding="utf-8"))
    con = duckdb.connect(":memory:")
    for table, body in spec["tables"].items():
        cols = ", ".join(f'"{c}" {t}' for c, t in body["columns"].items())
        con.execute(f'CREATE TABLE "{table}" ({cols})')
        if body["rows"]:
            marks = ", ".join("?" for _ in body["columns"])
            con.executemany(f'INSERT INTO "{table}" VALUES ({marks})', body["rows"])
    return con


def compute_expected(case: EvalCase) -> Expected:
    con = load_fixture(case.fixture)
    try:
        cur = con.execute(case.oracle_sql)
        columns = tuple(d[0] for d in cur.description)
        rows = tuple(tuple(_norm(v) for v in r) for r in cur.fetchall())
    finally:
        con.close()
    if not case.ordered:
        rows = tuple(sorted(rows, key=lambda r: json.dumps(r, default=str)))
    canon = json.dumps({"columns": columns, "rows": rows}, default=str, ensure_ascii=False)
    return Expected(columns, rows, hashlib.sha256(canon.encode("utf-8")).hexdigest())
