"""Pair #5 — Source / Data Prep / Snapshot ↔ Drift / Health / Quality, executed.

The Semantic Kernel (Kernel Contract v1) reads a DatasetTable's LOGICAL
relation: the source rows after the table's transformations and type
overrides. This module holds the data layer to one meaning of that relation,
with hand-computed oracles, on a real Postgres source (and DuckDB in-process):

  D2  a calculated column's division is the Kernel's: true division, NULL on a
      zero denominator — never Postgres integer division (13 / 7 = 1)
  D3  transformation order is deterministic; a step the server cannot execute,
      a reference to a column no longer there, a duplicate output column refuse
      — never a dataset silently computed without the step
  ...

Every oracle here is written by hand; none is computed by the code under test.
"""
from __future__ import annotations

import decimal
import math
import uuid

import pytest
import sqlalchemy as sa

from tests.test_pair3_chartservice_pg import _url  # noqa: F401 — the audit Postgres
from tests.test_pair3_chartservice_pg import no_result_cache, pg  # noqa: F401 — fixtures

S5 = "p5d"

#: id, a, b, d (numeric)
NUMS = [
    (1, 13, 7, "2.5"),
    (2, -5, 2, "1.0"),
    (3, 1, 30000, "4.0"),
    (4, 0, 2, "2.0"),
    (5, 5, 0, "0.0"),
    (6, None, 2, "1.0"),
    (7, 5, None, None),
]

#: [a] / [b] — by hand
RATIO_A_B = {1: 13 / 7, 2: -2.5, 3: 1 / 30000, 4: 0.0, 5: None, 6: None, 7: None}
#: [d] / [b] (decimal / integer) and [a] / [d] (integer / decimal)
RATIO_D_B = {1: 2.5 / 7, 2: 0.5, 3: 4 / 30000, 4: 1.0, 5: None, 6: 0.5, 7: None}
RATIO_A_D = {1: 5.2, 2: -5.0, 3: 0.25, 4: 0.0, 5: None, 6: None, 7: None}


@pytest.fixture(scope="module")
def pg5():
    engine = sa.create_engine(_url())
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {S5} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {S5}"))
        c.execute(sa.text(f"CREATE TABLE {S5}.nums (id int, a int, b int, d numeric(10,2))"))
        c.execute(sa.text(f"CREATE TABLE {S5}.codes (id int, x_raw text)"))
        c.execute(sa.text(f"INSERT INTO {S5}.codes VALUES (1, '10'), (2, '20'), (3, 'abc')"))
        for r in NUMS:
            c.execute(sa.text(f"INSERT INTO {S5}.nums VALUES (:i, :a, :b, :d)"),
                      {"i": r[0], "a": r[1], "b": r[2], "d": r[3]})
    try:
        yield engine
    finally:
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {S5} CASCADE"))
        engine.dispose()


def _pg_source():
    from app.core.crypto import encrypt_config
    from app.models.models import DataSource, DataSourceType

    u = sa.engine.make_url(_url())
    return DataSource(id=990001, name="p5", type=DataSourceType("postgresql"), config=encrypt_config({
        "host": u.host, "port": u.port or 5432, "database": u.database, "username": u.username,
        "password": u.password, "schema_name": S5}))


def _table(transformations, *, columns=("id", "a", "b", "d")):
    from app.models.dataset import DatasetTable

    return DatasetTable(id=990000 + abs(hash(str(transformations))) % 9999, dataset_id=990001,
                        datasource_id=990001, source_kind="physical_table", source_table_name=f"{S5}.nums",
                        display_name="nums", transformations=transformations, enabled=True,
                        columns_cache={"columns": [{"name": c, "type": "integer"} for c in columns]})


def add_column(name, expression, **kw):
    return {"id": uuid.uuid4().hex[:8], "type": "add_column", "enabled": True,
            "params": {"newField": name, "expression": expression}, **kw}


def _approx(got, want):
    if want is None:
        return got is None
    if got is None:
        return False
    return math.isclose(float(got), want, rel_tol=1e-9, abs_tol=1e-12)


def _by_id(rows, col):
    return {int(r["id"]): (float(r[col]) if isinstance(r[col], decimal.Decimal) else r[col]) for r in rows}


# ── D2 — a calculated column divides like the Kernel ─────────────────────────

CALC = [("ratio", "[a] / [b]", RATIO_A_B), ("ratio_db", "[d] / [b]", RATIO_D_B), ("ratio_ad", "[a] / [d]", RATIO_A_D)]


@pytest.mark.parametrize("name,expression,oracle", CALC, ids=[c[0] for c in CALC])
def test_a_calculated_column_is_true_division_on_postgres(pg5, name, expression, oracle):
    """The dataset's own live relation (build_live_base_query_plan — the one
    the preview, the live chart path and the snapshot build compile) executed
    on Postgres: 13 / 7 = 1.857…, not 1; 5 / 0 = NULL, not an error."""
    from app.services.live_query_service import build_live_base_query_plan

    plan = build_live_base_query_plan(_pg_source(), _table([add_column(name, expression)]))
    with pg5.connect() as c:
        rows = [dict(r._mapping) for r in c.execute(sa.text(f"SELECT * FROM ({plan.sql}) q"))]
    got = _by_id(rows, name)
    bad = {i: (got.get(i), want) for i, want in oracle.items() if not _approx(got.get(i), want)}
    assert not bad, bad


@pytest.mark.parametrize("name,expression,oracle", CALC, ids=[c[0] for c in CALC])
def test_a_calculated_column_is_true_division_on_duckdb(name, expression, oracle):
    duckdb = pytest.importorskip("duckdb")
    from app.services.transformation_compiler import TransformationCompiler

    con = duckdb.connect()
    con.execute("CREATE TABLE nums (id INTEGER, a INTEGER, b INTEGER, d DECIMAL(10,2))")
    for r in NUMS:
        con.execute("INSERT INTO nums VALUES (?, ?, ?, ?)", list(r))
    sql, _cols = TransformationCompiler.compile_transformations(
        "SELECT * FROM nums", [add_column(name, expression)], dialect="duckdb", available_columns=["id", "a", "b", "d"])
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    rows = [dict(zip(names, r)) for r in cur.fetchall()]
    got = _by_id(rows, name)
    bad = {i: (got.get(i), want) for i, want in oracle.items() if not _approx(got.get(i), want)}
    assert not bad, bad


@pytest.mark.parametrize("dialect", ["postgresql", "bigquery", "mysql", "duckdb"])
def test_a_calculated_column_division_renders_the_kernels_arithmetic(dialect):
    """Structural, per dialect: the transform layer's `/` is the Kernel's
    rewrite (semantic_arithmetic.normalize_division) — the same promotion and
    zero guard the semantic engine emits; integer `//` stays explicit."""
    from app.services.semantic_arithmetic import normalize_division
    from app.services.transformation_compiler import TransformationCompiler

    sql, _ = TransformationCompiler.compile_transformations(
        "SELECT * FROM t", [add_column("r", "[a] / [b]")], dialect=dialect, available_columns=["a", "b"])
    q = '`' if dialect in ("bigquery", "mysql") else '"'
    assert normalize_division(f"{q}a{q} / {q}b{q}", dialect) in sql, sql


# ── D3 — one deterministic transformation order, refusals instead of guesses ──

def rename(mapping):
    return {"id": uuid.uuid4().hex[:8], "type": "rename_columns", "enabled": True, "params": {"mapping": mapping}}


def select(cols):
    return {"id": uuid.uuid4().hex[:8], "type": "select_columns", "enabled": True, "params": {"columns": cols}}


def _run(pg5, steps):
    from app.services.live_query_service import build_live_base_query_plan

    plan = build_live_base_query_plan(_pg_source(), _table(steps))
    with pg5.connect() as c:
        rows = [dict(r._mapping) for r in c.execute(sa.text(f"SELECT * FROM ({plan.sql}) q ORDER BY 1"))]
    return plan, rows


def test_a_transformation_chain_runs_in_its_stored_order(pg5):
    """rename a→qty → add_column [qty] * 2 → add_column [dbl] + 1 (depends on
    the previous step) → select [id, dbl, dbl1]: by hand id 1 → 26, 27."""
    plan, rows = _run(pg5, [rename({"a": "qty"}), add_column("dbl", "[qty] * 2"), add_column("dbl1", "[dbl] + 1"),
                            select(["id", "dbl", "dbl1"])])
    assert plan.output_columns == ["id", "dbl", "dbl1"], plan.output_columns
    assert [(r["id"], r["dbl"], r["dbl1"]) for r in rows][:2] == [(1, 26, 27), (2, -10, -9)], rows


def test_a_disabled_step_is_skipped_and_its_column_absent(pg5):
    plan, rows = _run(pg5, [add_column("dbl", "[a] * 2", enabled=False)])
    assert "dbl" not in plan.output_columns and "dbl" not in rows[0], plan.output_columns


@pytest.mark.parametrize("steps,why", [
    ([rename({"a": "qty"}), add_column("dbl", "[a] * 2")], "references a after it was renamed"),
    ([select(["id", "b"]), add_column("x", "[a] + 1")], "references a after it was removed"),
    ([select(["id", "b"]), select(["id", "a"])], "selects a after it was removed"),
    ([add_column("b", "[a] + 1")], "duplicates the output column b"),
    ([rename({"a": "b"})], "renames onto the existing column b"),
], ids=["after_rename", "after_remove", "select_after_remove", "duplicate_add", "duplicate_rename"])
def test_an_invalid_transformation_order_refuses_clearly(pg5, steps, why):
    """Never a dataset computed against a different / stale / ambiguous column:
    an order that provably cannot hold is refused BY NAME before any SQL runs.
    (Two outputs named `b` used to SUCCEED — whoever read `b` got one of them.)"""
    from app.services.live_query_service import build_live_base_query_plan
    from app.services.transformation_compiler import TransformationError

    with pytest.raises(TransformationError) as exc:
        build_live_base_query_plan(_pg_source(), _table(steps))
    assert any(c in str(exc.value) for c in ("'a'", "'b'")), (why, str(exc.value))


@pytest.mark.parametrize("steps", [
    [add_column("dbl", "[qty] * 2"), rename({"a": "qty"})],
    [select(["id", "zzz"])],
], ids=["before_create", "select_unknown"])
def test_a_reference_to_a_column_never_seen_fails_loudly(pg5, steps):
    """A name no step and no source column ever had: the source list may be a
    stale cache, so the compiler does not guess — the engine refuses it, loudly
    (never an empty or defaulted column)."""
    with pytest.raises(Exception) as exc:
        _run(pg5, steps)
    assert "does not exist" in str(exc.value) and ("qty" in str(exc.value) or "zzz" in str(exc.value))


# ── D9 — a snapshot candidate is the dataset's relation or no snapshot at all ──

def test_a_snapshot_extract_never_falls_back_to_the_raw_source(pg5):
    """The federated extract SQL (snapshot_service._source_select_sql) is the
    table's LOGICAL relation. When that relation cannot be built (an invalid
    step order, a planner failure) it used to fall back to `SELECT * FROM
    source` — the snapshot materialized the RAW rows (no calculated column, no
    rename, no type cast) and published as the dataset. Now the build refuses:
    a failed candidate never becomes the visible generation."""
    from app.services import snapshot_service
    from app.services.transformation_compiler import TransformationError

    broken = _table([add_column("b", "[a] + 1")])          # duplicates b — the relation cannot be built
    with pytest.raises(TransformationError):
        snapshot_service._source_select_sql(_pg_source(), broken)
    ok = _table([add_column("ratio", "[a] / [b]")])
    sql = snapshot_service._source_select_sql(_pg_source(), ok)
    assert '"ratio"' in sql and "NULLIF" in sql, sql


def test_a_snapshot_extract_planner_failure_fails_the_build(monkeypatch):
    from app.services import live_query_service, snapshot_service

    def boom(*_a, **_k):
        raise RuntimeError("source columns unavailable")

    monkeypatch.setattr(live_query_service, "build_live_base_query_plan", boom)
    with pytest.raises(RuntimeError):
        snapshot_service._source_select_sql(_pg_source(), _table([add_column("ratio", "[a] / [b]")]))


# ── D1 / P5-01 — one logical relation per DatasetTable, or a refusal ─────────

def test_a_type_override_that_cannot_be_projected_fails_the_chart_relation(monkeypatch):
    """The semantic view's relation (charts, BigQuery snapshot extract) built
    the type-override projection under a catch-all: on failure the chart read
    the column UNCAST while the preview (no guard) cast it. Now it fails."""
    from app.services import dataset_model_service as dms
    from app.services import type_override_service

    def boom(*_a, **_k):
        raise RuntimeError("cannot cast")

    monkeypatch.setattr(type_override_service, "build_runtime_projection_query", boom)
    table = _table([])
    table.type_overrides = {"a": "float"}
    with pytest.raises(RuntimeError):
        dms._apply_semantic_type_overrides('SELECT * FROM "p5d"."nums"', table, dialect="postgresql")


def test_a_calculated_table_whose_sources_cannot_be_resolved_is_refused(monkeypatch):
    """A derived table's SQL names other tables by ALIAS. When resolving them
    fails the relation used to fall back to the RAW wrap — `FROM sales` then
    reads whatever relation the engine finds by that name. Now refused."""
    from types import SimpleNamespace

    from app.services import dataset_model_service as dms
    from app.services import dataset_table_sql_service

    def boom(*_a, **_k):
        raise RuntimeError("dependency table 5 not found")

    monkeypatch.setattr(dataset_table_sql_service, "build_dataset_table_live_query", boom)
    derived = SimpleNamespace(id=1, display_name="calc", source_kind="derived_table",
                              source_query="SELECT * FROM sales", transformations=[], type_overrides=None,
                              dataset_id=1, datasource_id=None, source_table_name=None)
    monkeypatch.setattr(dms, "is_generated_calendar_table", lambda _t: False)
    monkeypatch.setattr(dms, "is_derived_table", lambda t: t.source_kind == "derived_table")
    with pytest.raises(ValueError, match="calc"):
        dms._sql_table_for_table(SimpleNamespace(id=1), derived, calendar_dialect="postgresql", db=object())


def test_a_composed_table_carries_no_shaping_of_its_own():
    """A composed table (another dataset's published table) is read from the
    parent's pinned snapshot: its own transformations / type overrides cannot
    apply on a dashboard — the preview applied them. Refused, by name."""
    from types import SimpleNamespace

    from app.services import dataset_model_service as dms

    composed = SimpleNamespace(id=3, source_kind="dataset", parent_dataset_table_id=9, parent_dataset_id=2,
                               transformations=[add_column("ratio", "[a] / [b]")], type_overrides=None)
    with pytest.raises(ValueError, match="dataset gốc"):
        dms.refuse_composed_table_shaping(composed)
    with pytest.raises(ValueError, match="dataset gốc"):
        dms._sql_table_for_table(SimpleNamespace(id=1), composed, calendar_dialect="postgresql", db=None)
    plain = SimpleNamespace(id=4, source_kind="dataset", transformations=[], type_overrides=None)
    dms.refuse_composed_table_shaping(plain)   # no shaping → fine


def test_a_chart_on_a_table_whose_relation_is_refused_is_refused_not_served_stale(pg):
    """End to end: G1 star, sales given a duplicate-output transformation (its
    current relation is refused). The engine used to answer from the STORED
    relation (the last model sync — the plain table) and return 198 as if the
    transformation did not exist. Now the chart is refused."""
    from tests.pair3_world import chart_world, save_chart
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.chart_service import ChartService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        req = {"dims": [], "measures": ["p2_sales.revenue"]}
        chart = save_chart(w, "p2_sales", req)
        ok = ChartService.get_chart_data(w.db, chart.id)
        assert [r["p2_sales.revenue"] for r in ok["data"]] == [198], ok["data"]
        w.tables["p2_sales"].transformations = [add_column("revenue", "[revenue] + 1")]
        w.db.flush()
        with pytest.raises(ValueError, match="revenue"):
            ChartService.get_chart_data(w.db, chart.id)


# ── D14 — a quality rule checks the DATASET's rows; a rule not evaluated is no PASS ──

def _rule(rule_type, column=None, config=None):
    from types import SimpleNamespace

    return SimpleNamespace(id=1, name=f"{rule_type} {column}", rule_type=rule_type, dimension="completeness",
                           table_id=1, column_name=column, config=config or {}, severity="error", enabled=True)


def _check(rule, table, datasource=None):
    from types import SimpleNamespace

    from app.services.dataset_quality_service import DatasetQualityService

    ds = datasource or _pg_source()
    table.id = 1
    return DatasetQualityService._execute_single_rule(None, SimpleNamespace(id=990001), rule,
                                                      {1: table}, {ds.id: ds})


def _codes(type_overrides=None, transformations=None):
    from app.models.dataset import DatasetTable

    return DatasetTable(id=1, dataset_id=990001, datasource_id=990001, source_kind="physical_table",
                        source_table_name=f"{S5}.codes", display_name="codes", enabled=True,
                        transformations=transformations or [], type_overrides=type_overrides,
                        columns_cache={"columns": [{"name": "id", "type": "integer"}, {"name": "x_raw", "type": "float"}]})


def test_a_quality_rule_checks_the_cast_column_not_the_raw_text(pg5):
    """x_raw is text '10', '20', 'abc'; the dataset converts it to a number
    ('abc' → NULL). not_null on the RAW table: 0 failed (a false PASS). On the
    dataset: 1 of 3 failed — what every chart reads."""
    raw = _check(_rule("not_null", "x_raw"), _codes())
    assert raw["passed"] and raw["rows_failed"] == 0, raw          # the raw text has no NULL
    cast = _check(_rule("not_null", "x_raw"), _codes(type_overrides={"x_raw": "float"}))
    assert (cast["passed"], cast["rows_checked"], cast["rows_failed"]) == (False, 3, 1), cast


def test_a_quality_rule_checks_a_calculated_column(pg5):
    """not_null on ratio = [a] / [b]: NULL for 5/0, NULL/2, 5/NULL — 3 of 7.
    On the raw table the column does not exist (an error, never a pass)."""
    t = _table([add_column("ratio", "[a] / [b]")])
    res = _check(_rule("not_null", "ratio"), t)
    assert (res["passed"], res["rows_checked"], res["rows_failed"]) == (False, 7, 3), res


def test_a_quality_query_error_is_an_error_not_a_pass(pg5):
    from app.models.dataset import DatasetTable

    gone = DatasetTable(id=1, dataset_id=990001, datasource_id=990001, source_kind="physical_table",
                        source_table_name=f"{S5}.no_such_table", display_name="gone", enabled=True,
                        columns_cache={"columns": [{"name": "id", "type": "integer"}]})
    res = _check(_rule("not_null", "id"), gone)
    assert res.get("error") is True and res["passed"] is False, res


def test_a_cross_table_rule_whose_reference_cannot_be_built_is_one_error_not_a_crash(pg5):
    """The secondary table's relation is now built through the dataset's
    planner, which refuses an impossible transformation order. Unguarded, that
    exception escaped the rule — the whole quality run failed (every other
    rule's result lost) and the single-rule preview 500'd."""
    from types import SimpleNamespace

    from app.services.dataset_quality_service import DatasetQualityService

    ds = _pg_source()
    primary = _codes()
    primary.id = 1
    broken = _table([rename({"a": "qty"}), add_column("dbl", "[a] * 2")])
    broken.id = 2
    rule = _rule("cross_table", None, {"secondary_table_id": 2, "join_on": "src.id = ref.id",
                                       "expression": "src.id IS NOT NULL"})
    res = DatasetQualityService._execute_single_rule(None, SimpleNamespace(id=990001), rule,
                                                     {1: primary, 2: broken}, {ds.id: ds})
    assert res.get("error") is True and res["passed"] is False, res
    assert "Secondary relation error" in res["detail"] and "'a'" in res["detail"], res["detail"]


def test_a_quality_query_with_no_result_row_is_not_evaluated_not_a_pass(pg5):
    """A custom rule whose query returns no row was reported PASS ("empty
    table") — the rule was never evaluated. Now: not passed, marked no-data."""
    res = _check(_rule("custom_sql", None, {"sql": "SELECT 1 AS rows_checked, 0 AS rows_failed FROM {{ table }} WHERE 1 = 0"}),
                 _codes())
    assert res["passed"] is False and res.get("no_data") is True and res.get("skipped") is True, res


# ── D15 / D16 / D17 — health is the truth: breach is breach, unchecked is not healthy ──

def _monitor(w, kind, table="p2_sales", **cfg):
    from app.models.observability import ObservabilityMonitor

    m = ObservabilityMonitor(dataset_id=w.dataset.id, dataset_table_id=w.tables[table].id, kind=kind,
                             name=f"p5 {kind}", config=cfg, severity="warning", is_active=True)
    w.db.add(m)
    w.db.flush()
    return m


def _history(w, monitor, values, status="ok", detail=None):
    import datetime as _dt

    from app.models.observability import ObservabilityCheck

    base = _dt.datetime(2026, 1, 1)
    for i, v in enumerate(values):
        w.db.add(ObservabilityCheck(monitor_id=monitor.id, checked_at=base + _dt.timedelta(hours=i), value=v,
                                    status=status, detail=detail or {}))
    w.db.flush()


def _open_incidents(w, key):
    from app.models.observability import ObservabilityIncident

    return w.db.query(ObservabilityIncident).filter(ObservabilityIncident.dedup_key == key,
                                                    ObservabilityIncident.status != "resolved").count()


def _sales_rows(pg):
    from tests import pair2_topology as T

    with pg.connect() as c:
        return int(c.execute(sa.text(f"SELECT COUNT(*) FROM {T.S}.sales")).scalar())


def test_a_volume_drop_from_a_constant_baseline_is_a_breach(pg):
    """Five checks of exactly N rows (a constant baseline, std = 0), today 0:
    was "ok" (the z-score undefined). A breach — the table emptied."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.observability_service import ObservabilityService

    n = _sales_rows(pg)
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        m = _monitor(w, "volume")
        _history(w, m, [n + 5] * 5)                      # a constant baseline that is NOT today's count
        out = ObservabilityService.run_monitor(m, w.db)
        assert out["status"] == "breached" and out["value"] == n, out
        assert _open_incidents(w, f"volume:monitor_{m.id}") == 1
        _history(w, m, [float(n)] * 30)                  # now constant AT today's count
        assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"


def test_a_volume_monitor_still_learning_is_unknown_and_resolves_nothing(pg):
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        m = _monitor(w, "volume")
        ObservabilityService.upsert_incident(w.db, dataset_id=w.dataset.id, dataset_table_id=m.dataset_table_id,
                                             source="volume", dedup_key=f"volume:monitor_{m.id}", title="t",
                                             detail={}, severity="warning")
        _history(w, m, [10.0, 11.0])                     # 2 points: no baseline yet
        out = ObservabilityService.run_monitor(m, w.db)
        assert out["status"] == "unknown", out
        assert _open_incidents(w, f"volume:monitor_{m.id}") == 1, "an unjudged check resolved an incident"


def _drift_table(w, pg):
    from app.models.dataset import DatasetTable

    with pg.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {S5}"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {S5}.drift"))
        c.execute(sa.text(f"CREATE TABLE {S5}.drift (id int, a int, b int)"))
        c.execute(sa.text(f"INSERT INTO {S5}.drift VALUES (1, 10, 20)"))
    t = DatasetTable(dataset_id=w.dataset.id, datasource_id=w.ds.id, source_kind="physical_table",
                     source_table_name=f"{S5}.drift", display_name="drift", enabled=True,
                     columns_cache={"columns": [{"name": n, "type": "integer"} for n in ("id", "a", "b")]})
    w.db.add(t)
    w.db.flush()
    w.tables["drift"] = t
    return t


def _ddl(pg, sql):
    with pg.begin() as c:
        c.execute(sa.text(sql))


def test_a_source_schema_change_is_detected_and_stays_breached_until_accepted(pg):
    """A column dropped / added / retyped UPSTREAM while columns_cache still
    describes the old table: the schema monitor read columns_cache and stayed
    "ok". It now reads the table's live relation. A breach stays breached —
    the next scan compared against the BREACHING check and auto-resolved — until
    a person resolves the incident, which accepts the new schema."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.models.observability import ObservabilityIncident
    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            _drift_table(w, pg)
            m = _monitor(w, "schema", table="drift")
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"            # baseline id, a, b
            _ddl(pg, f"ALTER TABLE {S5}.drift DROP COLUMN b, ADD COLUMN c text")
            first = ObservabilityService.run_monitor(m, w.db)
            assert first["status"] == "breached", first
            assert (first["detail"]["removed"], first["detail"]["added"]) == (["b"], ["c"]), first["detail"]
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "breached"      # still differs
            _history(w, m, [None], status="error", detail={"error": "query failed"})
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "breached"      # an error never re-baselines
            assert _open_incidents(w, f"schema:monitor_{m.id}") == 1
            inc = w.db.query(ObservabilityIncident).filter(
                ObservabilityIncident.dedup_key == f"schema:monitor_{m.id}",
                ObservabilityIncident.status != "resolved").one()
            inc.status = "resolved"
            ObservabilityService.accept_schema_baseline(w.db, inc)
            w.db.flush()
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"           # accepted: id, a, c
            _ddl(pg, f"ALTER TABLE {S5}.drift ALTER COLUMN a TYPE text")
            retyped = ObservabilityService.run_monitor(m, w.db)
            assert retyped["status"] == "breached" and retyped["detail"]["retyped"] == [
                {"column": "a", "from": "number", "to": "text"}], retyped["detail"]
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.drift")


def test_an_appbi_side_reshape_is_a_schema_change_and_an_unreadable_source_an_error(pg):
    """P5-06: a calculated column added in AppBI changes what charts read — the
    monitor sees it. A source that cannot be read is an ERROR, never "ok"."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            t = _drift_table(w, pg)
            m = _monitor(w, "schema", table="drift")
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"
            t.transformations = [add_column("ab", "[a] / [b]")]
            w.db.flush()
            out = ObservabilityService.run_monitor(m, w.db)
            assert out["status"] == "breached" and out["detail"]["added"] == ["ab"], out
            _ddl(pg, f"DROP TABLE {S5}.drift")
            gone = ObservabilityService.run_monitor(m, w.db)
            assert gone["status"] == "error", gone
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.drift")


def test_a_schema_drift_rule_sees_the_source_not_the_cached_schema(pg):
    """The schema_drift QUALITY rule (the user-facing schema check since the
    monitor console was cut) compared columns_cache against its baseline: a
    column dropped upstream, cache untouched, was "Schema unchanged" — a PASS.
    It now reads the live relation (the monitor's reader). An unreadable source
    is an error, never a pass."""
    from types import SimpleNamespace

    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.dataset_quality_service import DatasetQualityService

    check = DatasetQualityService._check_schema_drift
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            t = _drift_table(w, pg)
            rule = SimpleNamespace(id=0, config={})                       # id 0: never commits
            first = check(w.db, rule, t, lambda _m: None)
            assert first["passed"] and [c["name"] for c in rule.config["baseline_columns"]] == ["a", "b", "id"]
            assert check(w.db, rule, t, lambda _m: None)["passed"]                     # int4 vs integer: no change
            _ddl(pg, f"ALTER TABLE {S5}.drift DROP COLUMN b")                         # columns_cache still has b
            drifted = check(w.db, rule, t, lambda _m: None)
            assert (drifted["passed"], drifted["removed"], drifted["rows_failed"]) == (False, ["b"], 1), drifted
            _ddl(pg, f"DROP TABLE {S5}.drift")
            gone = check(w.db, rule, t, lambda _m: None)
            assert gone["passed"] is False and gone.get("error") is True, gone
            assert "does not exist" in gone["detail"], gone                            # the cause, not a shrug
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.drift")


def test_a_baseline_from_before_live_reading_never_raises_a_false_retype(pg):
    """Baselines captured before this change hold columns_cache types (value-
    sampled — a Sheets column of digits cached as "integer", physically text).
    Compared to live physical types, every such column read as RETYPED on the
    first scan after deploy: a monitor incident until someone resolved it, a
    schema_drift rule failing forever. A legacy baseline is compared by name
    only (a drop is still caught) and replaced by a typed one."""
    from types import SimpleNamespace

    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.dataset_quality_service import DatasetQualityService
    from app.services.observability_service import SCHEMA_BASELINE_V, ObservabilityService

    legacy = [{"name": "a", "type": "string"}, {"name": "b", "type": "integer"}, {"name": "id", "type": "integer"}]
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            t = _drift_table(w, pg)                                                 # a is int4 live
            rule = SimpleNamespace(id=0, config={"baseline_columns": legacy})
            out = DatasetQualityService._check_schema_drift(w.db, rule, t, lambda _m: None)
            assert out["passed"] and out["retyped"] == [], out                      # no false "retype"
            assert rule.config["baseline_v"] == SCHEMA_BASELINE_V                   # upgraded, typed
            m = _monitor(w, "schema", table="drift")
            _history(w, m, [3.0], detail={"columns": legacy})                       # a legacy ok check
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"      # names unchanged
            _ddl(pg, f"ALTER TABLE {S5}.drift ALTER COLUMN a TYPE text")
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "breached"  # typed baseline now
            assert not DatasetQualityService._check_schema_drift(w.db, rule, t, lambda _m: None)["passed"]
            legacy_rule = SimpleNamespace(id=0, config={"baseline_columns": legacy})
            _ddl(pg, f"ALTER TABLE {S5}.drift DROP COLUMN b")
            dropped = DatasetQualityService._check_schema_drift(w.db, legacy_rule, t, lambda _m: None)
            assert (dropped["passed"], dropped["removed"]) == (False, ["b"]), dropped  # a drop still caught
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.drift")


def test_observability_instants_are_emitted_as_utc():
    """stats_updated_at / incident times are naive UTC; emitted without a zone
    the browser read them as local time — a table refreshed a minute ago showed
    "7 hours ago" at UTC+7. Every instant now carries Z (aware → converted)."""
    import datetime as _dt

    from app.services.observability_service import ObservabilityService

    iso = ObservabilityService._utc_iso
    assert iso(_dt.datetime(2026, 10, 2, 8, 39, 4)) == "2026-10-02T08:39:04Z"
    aware = _dt.datetime(2026, 10, 2, 15, 39, 4, tzinfo=_dt.timezone(_dt.timedelta(hours=7)))
    assert iso(aware) == "2026-10-02T08:39:04Z"
    assert iso(None) is None


def test_a_quality_rule_not_evaluated_does_not_resolve_its_incident(pg):
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.models.dataset import DatasetQualityRule, DatasetQualityRun
    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        rule = DatasetQualityRule(dataset_id=w.dataset.id, table_id=w.tables["p2_sales"].id, column_name="revenue",
                                  dimension="completeness", rule_type="not_null", name="rev not null",
                                  config={}, severity="error", enabled=True)
        w.db.add(rule)
        w.db.flush()
        w.db.add(DatasetQualityRun(dataset_id=w.dataset.id, status="completed",
                                   results={str(rule.id): {"passed": False, "rows_failed": 2}}))
        w.db.flush()
        ObservabilityService.fold_quality(w.db)
        key = f"quality:rule_{rule.id}"
        assert _open_incidents(w, key) == 1
        w.db.add(DatasetQualityRun(dataset_id=w.dataset.id, status="completed",
                                   results={str(rule.id): {"passed": False, "skipped": True, "no_data": True}}))
        w.db.flush()
        ObservabilityService.fold_quality(w.db)
        assert _open_incidents(w, key) == 1, "a rule nobody evaluated resolved its incident"
        w.db.add(DatasetQualityRun(dataset_id=w.dataset.id, status="completed",
                                   results={str(rule.id): {"passed": True, "rows_failed": 0}}))
        w.db.flush()
        ObservabilityService.fold_quality(w.db)
        assert _open_incidents(w, key) == 0


@pytest.mark.parametrize("statuses,expected", [
    (["error", "error"], "error"),
    (["ok", None], "unknown"),
    (["ok", "unknown"], "unknown"),
    (["ok", "ok"], "healthy"),
    (["ok", "breached"], "breached"),
], ids=["all_error", "never_checked", "learning", "healthy", "breached"])
def test_health_is_healthy_only_when_every_check_ran_and_passed(pg, statuses, expected):
    """A dataset whose monitors all ERRORED showed the green shield with "0"
    (health = no open incident). Now its health says it was not checked."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        for i, st in enumerate(statuses):
            m = _monitor(w, ("freshness", "volume")[i % 2])
            m.last_status = st
        w.db.flush()
        if expected == "breached":
            ObservabilityService.upsert_incident(w.db, dataset_id=w.dataset.id, dataset_table_id=None,
                                                 source="volume", dedup_key="volume:x", title="t", detail={},
                                                 severity="warning")
            w.db.flush()
        row = next(r for r in ObservabilityService.get_usage(w.db, [w.dataset.id]) if r["datasetId"] == w.dataset.id)
        assert row["health"] == expected, row
        overview = ObservabilityService.get_overview(w.db, [w.dataset.id])
        quality = next(p for p in overview["pillars"] if p["pillar"] == "quality")
        assert quality["status"] == "not_monitored" and quality["healthy"] is False, quality


@pytest.mark.parametrize("case,expected,pillar", [
    ("rule_failed", "breached", "breached"),
    ("rule_never_run", "unknown", "unknown"),
    ("rule_disabled_and_monitor_paused", "not_monitored", "not_monitored"),
    ("rule_passed", "healthy", "healthy"),
], ids=["rule_failed", "rule_never_run", "only_paused", "rule_passed"])
def test_dataset_health_reads_the_quality_rules_latest_run(pg, case, expected, pillar):
    """The list showed the green "every check ran and passed" shield while the
    latest quality run had a FAILED rule (it only counted once a scan folded it
    into an incident — up to a day later); a dataset whose monitors were all
    paused (and rules disabled) was "healthy"; the overview's quality pillar was
    healthy for rules that had never run."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.models.dataset import DatasetQualityRule, DatasetQualityRun
    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        rule = DatasetQualityRule(dataset_id=w.dataset.id, table_id=w.tables["p2_sales"].id, column_name="revenue",
                                  dimension="completeness", rule_type="not_null", name="rev not null",
                                  config={}, severity="warning", enabled=case != "rule_disabled_and_monitor_paused")
        w.db.add(rule)
        w.db.flush()
        if case == "rule_disabled_and_monitor_paused":
            m = _monitor(w, "freshness")
            m.is_active, m.last_status = False, "ok"
        elif case in ("rule_failed", "rule_passed"):
            w.db.add(DatasetQualityRun(dataset_id=w.dataset.id, status="completed",
                                       results={str(rule.id): {"passed": case == "rule_passed",
                                                               "rows_failed": 0 if case == "rule_passed" else 2}}))
        w.db.flush()
        row = next(r for r in ObservabilityService.get_usage(w.db, [w.dataset.id]) if r["datasetId"] == w.dataset.id)
        assert row["health"] == expected, row
        quality = next(p for p in ObservabilityService.get_overview(w.db, [w.dataset.id])["pillars"]
                       if p["pillar"] == "quality")
        assert quality["status"] == pillar, quality


# ── D7 / P5-04 / P5-19 — an AppBI-side reshape invalidates what described the old rows ──

def test_a_transformation_edit_drops_the_old_relations_samples_and_stats(pg):
    """A calculated column added: the cached sample rows and per-column stats
    were the PREVIOUS relation's — the new column read as 100% null in stats.
    They are dropped (recomputed from the current relation); the schema hash
    stays as the baseline the next stats run compares against."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.schemas.dataset import TableUpdate as DatasetTableUpdate
    from app.services.dataset_crud import DatasetCRUDService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        t = w.tables["p2_sales"]
        t.sample_cache = [{"id": 1, "revenue": 10}]
        t.column_stats = {"revenue": {"null_pct": 0}}
        t.schema_hash = "h-before"
        w.db.flush()
        DatasetCRUDService.update_table(w.db, t.id, DatasetTableUpdate(
            transformations=[add_column("rev2", "[revenue] * 2")]))
        w.db.refresh(t)
        assert t.sample_cache is None and t.column_stats is None, (t.sample_cache, t.column_stats)
        assert t.schema_hash == "h-before"
        # a pure rename of the table (no reshape) keeps them
        t.sample_cache = [{"id": 1}]
        w.db.flush()
        DatasetCRUDService.update_table(w.db, t.id, DatasetTableUpdate(display_name="sales renamed"))
        w.db.refresh(t)
        assert t.sample_cache == [{"id": 1}]


def test_a_failed_stats_run_never_clears_the_schema_change_flag(pg, monkeypatch):
    """The edit flags schema_change_pending. With a user-written description,
    the pipeline set the flag to "did the stats run see a change" — a FAILED
    stats run ("live_query_failed" → changed: False) erased the flag. It now
    clears only when the description catches up."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _NoClose, _pg_config

    from app.services import description_pipeline_service as dps
    from app.services.table_stats_service import TableStatsService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        t = w.tables["p2_sales"]
        t.schema_change_pending = True
        t.description_source = "user"
        w.db.flush()
        monkeypatch.setattr(TableStatsService, "update_table_stats",
                            staticmethod(lambda *_a, **_k: {"changed": False, "reason": "live_query_failed"}))
        monkeypatch.setattr(dps.EmbeddingService, "embed_table", staticmethod(lambda *_a, **_k: None))
        dps.DescriptionPipelineService.run_table_pipeline(t.id, trigger="schema_change", force=False,
                                                          session_factory=lambda: _NoClose(w.db))
        w.db.refresh(t)
        assert t.schema_change_pending is True


# ── D8 / P5-07 — a semantic dependency broken by drift is visible and refused ──

def _drift_model(w, pg):
    """p5d.facts (id, cust_id, amount) → p5d.custs (id, name): a dataset, two
    tables, two views, one explore joining facts.cust_id → custs.id, a SUM
    measure on amount. columns_cache describes them as built."""
    from app.models.dataset import DatasetTable
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    _ddl(pg, f"CREATE SCHEMA IF NOT EXISTS {S5}")
    _ddl(pg, f"DROP TABLE IF EXISTS {S5}.facts")
    _ddl(pg, f"DROP TABLE IF EXISTS {S5}.custs")
    _ddl(pg, f"CREATE TABLE {S5}.custs (id int, name text)")
    _ddl(pg, f"INSERT INTO {S5}.custs VALUES (1, 'A'), (2, 'B')")
    _ddl(pg, f"CREATE TABLE {S5}.facts (id int, cust_id int, amount int)")
    _ddl(pg, f"INSERT INTO {S5}.facts VALUES (1, 1, 10), (2, 2, 20), (3, 1, 5)")

    def table(name, cols):
        t = DatasetTable(dataset_id=w.dataset.id, datasource_id=w.ds.id, source_kind="physical_table",
                         source_table_name=f"{S5}.{name}", display_name=f"p5_{name}", enabled=True,
                         columns_cache={"columns": [{"name": c, "type": "integer"} for c in cols]})
        w.db.add(t)
        w.db.flush()
        return t

    tf, tc = table("facts", ["id", "cust_id", "amount"]), table("custs", ["id", "name"])
    vf = SemanticView(name="p5_facts", dataset_table_id=tf.id, sql_table_name=f"{S5}.facts",
                      dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                  {"name": "cust_id", "type": "number", "sql": "${TABLE}.cust_id"}],
                      measures=[{"name": "amount", "type": "sum", "sql": "${TABLE}.amount"}], primary_key=["id"])
    vc = SemanticView(name="p5_custs", dataset_table_id=tc.id, sql_table_name=f"{S5}.custs",
                      dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                  {"name": "name", "type": "string", "sql": "${TABLE}.name"}],
                      measures=[], primary_key=["id"])
    w.db.add_all([vf, vc])
    w.db.flush()
    model = w.db.query(SemanticModel).filter(SemanticModel.dataset_id == w.dataset.id).one()
    w.db.add(SemanticExplore(name="p5_facts", model_id=model.id, base_view_id=vf.id, base_view_name="p5_facts",
                             joins=[{"view": "p5_custs", "name": "p5_custs", "from_column": "cust_id",
                                     "to_column": "id", "cardinality": "many_to_one", "type": "left"}]))
    w.db.flush()
    return tf, tc


def test_a_join_key_dropped_upstream_is_a_blocking_semantic_failure(pg):
    """facts.cust_id is dropped in the source; columns_cache still lists it.
    Semantic health read the cache and said nothing; publish went through.
    Now: a dangling JOIN reference, failing and blocking publish."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services import semantic_health_service as sh

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            _drift_model(w, pg)
            assert not [c for c in sh.dangling_checks(w.db, w.dataset.id, live=True)], "clean model flagged"
            _ddl(pg, f"ALTER TABLE {S5}.facts DROP COLUMN cust_id")
            checks = sh.dangling_checks(w.db, w.dataset.id, live=True)
            joins = [c for c in checks if c.evidence["kind"] == "join" and c.evidence["column"] == "cust_id"]
            assert joins and all(c.status == "fail" and c.blocking for c in joins), checks
            assert any("cust_id" in r for r in sh.publish_blockers(w.db, w.dataset.id)), "publish not blocked"
            report = sh.evaluate(w.db, w.dataset.id, execute=True)
            assert report["layers"]["semantic_health"]["status"] == "fail", report["layers"]["semantic_health"]
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.facts")
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.custs")


def test_a_measure_column_dropped_upstream_fails_visibly_and_the_chart_refuses(pg):
    """facts.amount dropped: the measure is dangling (fail, visible — not
    blocking the rest of the model), and a chart on it never answers (the
    warehouse refuses the missing column) — no silently empty or zero number."""
    from tests.pair3_world import chart_world, save_chart
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services import semantic_health_service as sh
    from app.services.chart_service import ChartService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            tf, _tc = _drift_model(w, pg)
            w.tables["p5_facts"] = tf
            req = {"dims": [], "measures": ["p5_facts.amount"]}
            chart = save_chart(w, "p5_facts", req)
            ok = ChartService.get_chart_data(w.db, chart.id)
            assert [r["p5_facts.amount"] for r in ok["data"]] == [35], ok["data"]
            _ddl(pg, f"ALTER TABLE {S5}.facts DROP COLUMN amount")
            measures = [c for c in sh.dangling_checks(w.db, w.dataset.id, live=True)
                        if c.evidence["kind"] == "measure" and c.evidence["column"] == "amount"]
            assert measures and measures[0].status == "fail" and not measures[0].blocking, measures
            with pytest.raises(Exception) as exc:
                ChartService.get_chart_data(w.db, chart.id)
            assert "amount" in str(exc.value), exc.value
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.facts")
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.custs")


# ── D9 / D10 / D11 / D12 — the published generation is the validated one ──────

def _published_world(w, monkeypatch, generations=(1,)):
    """The dataset published at generation 1 (snapshot rows for every table).
    The warehouse build is the only thing faked: `refresh_all_for_dataset`
    writes the snapshot rows a real build would (all tables, or not)."""
    import datetime as _dt
    import types

    from app.models.dataset import DatasetTableSnapshot
    from app.services import dataset_publish_service as pub
    from app.services import snapshot_service

    w.dataset.publish_state = "published"
    w.dataset.published_generation = generations[-1]
    for gen in generations:
        for t in w.tables.values():
            w.db.add(DatasetTableSnapshot(dataset_id=w.dataset.id, dataset_table_id=t.id, version=gen,
                                          generation=gen, physical_ref=f"p5.snap_{t.id}_g{gen}", fingerprint="f" * 64,
                                          status="ready", is_current=True, built_at=_dt.datetime(2026, 1, gen)))
    w.db.flush()
    monkeypatch.setattr(snapshot_service, "host_for_generation", lambda *_a, **_k: types.SimpleNamespace(id=1, config={}))
    monkeypatch.setattr(pub, "_qc", types.SimpleNamespace(invalidate_datasource=lambda *_a: None,
                                                          release_global=lambda *_a: None))
    plan = {"tables": None, "during": None}

    def fake_build(db, dataset_id, force=False):
        gen = max(g for (g,) in db.query(DatasetTableSnapshot.generation).filter(
            DatasetTableSnapshot.dataset_id == dataset_id).all()) + 1
        tables = plan["tables"] if plan["tables"] is not None else list(w.tables.values())
        for t in tables:
            db.add(DatasetTableSnapshot(dataset_id=dataset_id, dataset_table_id=t.id, version=gen, generation=gen,
                                        physical_ref=f"p5.snap_{t.id}_g{gen}", fingerprint="f" * 64, status="ready",
                                        is_current=False, built_at=_dt.datetime(2026, 2, gen)))
        db.flush()
        if plan["during"]:
            plan["during"]()
        return {"generation": gen, "built": [t.id for t in tables], "skipped": []}

    monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", fake_build)
    return plan


def _runs(w):
    from app.models.dataset import DatasetRefreshRun

    return [(r.status, r.generation) for r in w.db.query(DatasetRefreshRun).filter(
        DatasetRefreshRun.dataset_id == w.dataset.id).order_by(DatasetRefreshRun.id).all()]


def test_a_failed_candidate_never_becomes_the_published_generation(pg, monkeypatch):
    """Generation 2 builds only 2 of the 3 tables (a table failed): sync_failed,
    the error recorded, generation 1 still published (serve-stale), the run
    'failed' in history. The repaired sync publishes generation 3 cleanly."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.dataset_publish_service import _sync_and_publish_blocking

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        plan = _published_world(w, monkeypatch)
        plan["tables"] = list(w.tables.values())[:-1]
        out = _sync_and_publish_blocking(w.db, w.dataset.id)
        w.db.refresh(w.dataset)
        assert out["ok"] is False and w.dataset.published_generation == 1, (out, w.dataset.published_generation)
        assert w.dataset.publish_state == "sync_failed" and w.dataset.last_sync_error, w.dataset.last_sync_error
        assert _runs(w)[-1][0] == "failed", _runs(w)
        plan["tables"] = None
        out = _sync_and_publish_blocking(w.db, w.dataset.id)
        w.db.refresh(w.dataset)
        assert out["ok"] and w.dataset.published_generation == 3 and w.dataset.publish_state == "published", out
        assert [s for s, _g in _runs(w)] == ["failed", "success"], _runs(w)


def test_a_dataset_with_no_snapshot_host_fails_publish_naming_the_host(pg, monkeypatch):
    """No BigQuery datasource hosts the snapshots: the builder skips every
    table and the publish failed with "build có bảng lỗi" — a table error that
    does not exist (seen in the browser on a Postgres-only dataset). The
    failure now names the real cause; nothing is published either way."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services import snapshot_service
    from app.services.dataset_publish_service import _sync_and_publish_blocking

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", lambda db, dataset_id, force=False: {
            "generation": 7, "built": [], "skipped": [t.id for t in w.tables.values()], "no_host": True})
        out = _sync_and_publish_blocking(w.db, w.dataset.id)
        w.db.refresh(w.dataset)
        assert out["ok"] is False and w.dataset.published_generation is None, out
        assert "snapshot host" in out["error"] and "bảng lỗi" not in out["error"], out["error"]
        assert w.dataset.publish_state == "sync_failed" and w.dataset.last_sync_error == out["error"]


def test_a_design_edited_during_the_sync_is_not_published_under_the_old_design(pg, monkeypatch):
    """A transformation edited while the build runs: the generation is partly
    built from the new design but would have been published under the design
    locked at the start. Refused — generation 1 keeps serving."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.dataset_publish_service import _sync_and_publish_blocking

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        plan = _published_world(w, monkeypatch)

        def edit_mid_sync():
            w.tables["p2_sales"].transformations = [add_column("rev2", "[revenue] * 2")]
            w.db.flush()

        plan["during"] = edit_mid_sync
        out = _sync_and_publish_blocking(w.db, w.dataset.id)
        w.db.refresh(w.dataset)
        assert out["ok"] is False and "thay đổi trong lúc đồng bộ" in out["error"], out
        assert w.dataset.published_generation == 1


def test_a_sync_still_running_on_another_worker_is_not_reaped(pg, monkeypatch):
    """The startup reaper reset EVERY 'syncing' dataset ("a fresh process runs
    no sync") — on a multi-worker deploy, another worker's live sync. Now only
    a sync whose cross-worker progress has gone stale is reaped."""
    import time as _time

    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _NoClose, _pg_config

    from app.core import database
    from app.services import dataset_publish_service as pub
    from app.services import sync_progress

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        w.dataset.publish_state = "syncing"
        w.dataset.published_generation = 1
        w.db.flush()
        monkeypatch.setattr(database, "SessionLocal", lambda: _NoClose(w.db))
        monkeypatch.setattr(pub, "reconcile_stuck_runs", lambda *_a, **_k: 0)
        fresh = {"phase": "syncing", "updated_at": _time.time()}
        monkeypatch.setattr(sync_progress, "get", lambda _id: dict(fresh))
        assert pub.reap_stuck_syncs() == 0
        w.db.refresh(w.dataset)
        assert w.dataset.publish_state == "syncing"
        fresh["updated_at"] = _time.time() - pub.STUCK_SYNC_STALE_SECONDS - 5
        assert pub.reap_stuck_syncs() == 1
        w.db.refresh(w.dataset)
        assert w.dataset.publish_state == "published"     # keeps serving the pinned generation


class _Leases:
    """An in-memory stand-in for the shared cross-worker lease store."""

    def __init__(self):
        self.held = set()

    def claim(self, key, _ttl):
        if key in self.held:
            return False
        self.held.add(key)
        return True

    def release(self, key):
        self.held.discard(key)

    def probe(self, key):
        return key in self.held


def test_one_writer_per_dataset_publish_and_background_rebuild_exclude_each_other(monkeypatch):
    """Sync & Publish holds `datasetpublish::<id>`, background rebuilds
    (TTL, source change, manual Refresh) `snaprebuild::<id>` — two leases that
    never saw each other, so both could build the same dataset at once. Now
    whichever holds the dataset excludes the other."""
    from app.services import dataset_publish_service as pub
    from app.services import query_cache as qc
    from app.services import snapshot_service

    leases = _Leases()
    monkeypatch.setattr(qc, "try_claim_global", leases.claim)
    monkeypatch.setattr(qc, "release_global", leases.release)
    monkeypatch.setattr(qc, "is_claimed_global", leases.probe)
    monkeypatch.setattr(pub, "_qc", qc)
    monkeypatch.setattr(snapshot_service, "_qc", qc)
    monkeypatch.setattr(snapshot_service, "_in_quota_cooldown", lambda _d: False, raising=False)

    leases.held.add("datasetpublish::77")                      # a Sync & Publish is running
    assert snapshot_service._reserve_rebuild_slot(77) is False
    assert "snaprebuild::77" not in leases.held, "the refused rebuild kept its lease"
    assert snapshot_service.start_manual_refresh([77]) == []
    leases.held.clear()
    leases.held.add("snaprebuild::77")                          # a background rebuild is running
    out = pub.start_sync_and_publish(77)
    assert out == {"started": False, "reason": "rebuilding"}, out
    assert "datasetpublish::77" not in leases.held, "the refused publish kept its lease"


def test_a_scheduled_refresh_never_deploys_an_unpublished_design_edit(pg, monkeypatch):
    """The scheduler read the STORED state ('published'), recomputed only when a
    person views the dataset: a design edited and not viewed was deployed by the
    next scheduled run. It now reads the live state and skips."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _NoClose, _pg_config

    from app.services import dataset_publish_service as pub
    from app.services import snapshot_scheduler

    started = []
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        w.dataset.publish_state = "published"
        w.dataset.published_generation = 1
        w.dataset.published_design_fingerprint = pub.design_fingerprint(w.db, w.dataset.id)
        w.db.flush()
        monkeypatch.setattr(snapshot_scheduler, "SessionLocal", lambda: _NoClose(w.db))
        monkeypatch.setattr(pub, "start_sync_and_publish", lambda *a, **k: started.append(a) or {"started": True})
        snapshot_scheduler._run_scheduled_refresh_locked(w.dataset.id)
        assert len(started) == 1, "a clean published design is refreshed"
        w.tables["p2_sales"].transformations = [add_column("rev2", "[revenue] * 2")]   # edited, never viewed
        w.db.flush()
        snapshot_scheduler._run_scheduled_refresh_locked(w.dataset.id)
        assert len(started) == 1, "the scheduled run deployed an unpublished edit"
        w.db.refresh(w.dataset)
        assert w.dataset.publish_state == "changes_pending"


def test_a_fresh_publish_is_not_changes_pending_when_the_build_reconciled_types(pg, monkeypatch):
    """The build rewrites the column cache (the physical-type reconcile: a
    numeric column the loader stored as text). The published fingerprint was the
    PRE-build one, so the dataset read "changes pending" right after a publish
    nobody changed. It is now the design as built."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services.dataset_publish_service import _sync_and_publish_blocking, refresh_publish_state

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        plan = _published_world(w, monkeypatch)

        def reconcile_types():
            t = w.tables["p2_sales"]
            cache = dict(t.columns_cache or {})
            cache["columns"] = [{**c, "source_type": "string"} for c in cache.get("columns") or []]
            t.columns_cache = cache
            w.db.flush()

        plan["during"] = reconcile_types
        out = _sync_and_publish_blocking(w.db, w.dataset.id)
        assert out["ok"], out
        assert refresh_publish_state(w.db, w.dataset) == "published"


# ── D13 / P5-13 — a composed dataset pins the parent generation it validated ──

def _child_of(w, parent_table):
    """A child dataset: one table of its own (p5d.codes) + one table composed
    from the parent's `parent_table` (mirroring its type overrides, as pinning
    does), and a model."""
    from app.models.dataset import Dataset, DatasetTable
    from app.models.semantic import SemanticModel

    child = Dataset(name=f"p5 child {uuid.uuid4().hex[:6]}")
    w.db.add(child)
    w.db.flush()
    own = DatasetTable(dataset_id=child.id, datasource_id=w.ds.id, source_kind="physical_table",
                       source_table_name=f"{S5}.codes", display_name="codes", enabled=True,
                       columns_cache={"columns": [{"name": "id", "type": "integer"}, {"name": "x_raw", "type": "text"}]})
    composed = DatasetTable(dataset_id=child.id, datasource_id=None, source_kind="dataset",
                            parent_dataset_id=w.dataset.id, parent_dataset_table_id=parent_table.id,
                            display_name="from parent", enabled=True, columns_cache=parent_table.columns_cache,
                            type_overrides=parent_table.type_overrides)
    w.db.add_all([own, composed])
    w.db.add(SemanticModel(name=f"p5 child model {child.id}", dataset_id=child.id))
    w.db.flush()
    return child, own, composed


def test_a_child_pins_the_parent_generation_it_validated(pg5, pg, monkeypatch):
    """The child validates the parent's published generation 1 at pre-flight;
    while the child builds, the parent re-publishes generation 2. The child used
    to pin the parent's generation AT PUBLISH END (2) — never validated for it.
    It now pins 1, the generation it was validated against."""
    import datetime as _dt

    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.models.dataset import DatasetDependency, DatasetTableSnapshot
    from app.services import dataset_composition_service as comp
    from app.services import dataset_publish_service as pub
    from app.services import snapshot_service

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        _published_world(w, monkeypatch)                                  # the PARENT, published at 1
        monkeypatch.setattr(comp, "_host_key", lambda *_a, **_k: ("p5-project", "eu"))
        child, own, _composed = _child_of(w, w.tables["p2_sales"])

        def child_build(db, dataset_id, force=False):
            db.add(DatasetTableSnapshot(dataset_id=dataset_id, dataset_table_id=own.id, version=1, generation=1,
                                        physical_ref="p5.child_g1", fingerprint="f" * 64, status="ready",
                                        is_current=True, built_at=_dt.datetime(2026, 3, 1)))
            for t in w.tables.values():                                    # the parent re-publishes meanwhile
                db.add(DatasetTableSnapshot(dataset_id=w.dataset.id, dataset_table_id=t.id, version=2, generation=2,
                                            physical_ref=f"p5.snap_{t.id}_g2", fingerprint="f" * 64, status="ready",
                                            is_current=False, built_at=_dt.datetime(2026, 3, 2)))
            w.dataset.published_generation = 2
            db.flush()
            return {"generation": 1, "built": [own.id], "skipped": []}

        monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", child_build)
        out = pub._sync_and_publish_blocking(w.db, child.id)
        assert out["ok"], out
        edge = w.db.query(DatasetDependency).filter(DatasetDependency.child_dataset_id == child.id).one()
        assert edge.parent_generation == 1, edge.parent_generation
        # ...and, the parent having moved on to 2, the child is NOT "published"
        # over parent generation 1: it reads changes_pending (its fingerprint
        # used to fold the parent's CURRENT generation in at the flip — so it
        # read published forever, serving the older parent silently).
        w.db.refresh(child)
        assert pub.refresh_publish_state(w.db, child, commit=False) == "changes_pending", child.publish_state


def test_a_composed_table_keeps_the_parents_overrides_but_refuses_its_own(pg):
    """Pinning mirrors the parent table's type overrides onto the composed table
    (metadata: the parent snapshot already has them applied) — allowed. Overrides
    of its own, or a transformation, never reach a chart — refused."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.services import dataset_model_service as dms

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        parent_table = w.tables["p2_sales"]
        parent_table.type_overrides = {"revenue": "float"}
        w.db.flush()
        _child, _own, composed = _child_of(w, parent_table)
        dms.refuse_composed_table_shaping(composed, w.db)                       # mirrored → fine
        parent_table.type_overrides = {"revenue": "string"}                     # the parent moves on (a draft)
        w.db.flush()
        dms.refuse_composed_table_shaping(composed, w.db)                       # the child still reads
        dms.refuse_composed_table_shaping(composed, w.db, type_overrides={"revenue": "float"})  # an echo
        with pytest.raises(ValueError, match="dataset gốc"):
            dms.refuse_composed_table_shaping(composed, w.db, type_overrides={"revenue": "string"})
        with pytest.raises(ValueError, match="dataset gốc"):
            dms.refuse_composed_table_shaping(composed, w.db, transformations=[add_column("x", "[revenue] + 1")])


def test_a_freshness_breach_on_a_timezone_aware_column_is_a_breach_not_an_error(pg):
    """loaded_at is timestamptz (BigQuery TIMESTAMP alike): the check subtracted
    an aware value from naive utcnow() and ERRORED on every scan — freshness
    was never monitored. 3 days old vs a 24 h limit: breached; just loaded: ok."""
    from tests.pair3_world import chart_world
    from tests.test_pair3_chartservice_pg import _pg_config

    from app.models.dataset import DatasetTable
    from app.services.observability_service import ObservabilityService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        try:
            _ddl(pg, f"CREATE SCHEMA IF NOT EXISTS {S5}")
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.loads")
            _ddl(pg, f"CREATE TABLE {S5}.loads (id int, loaded_at timestamptz)")
            _ddl(pg, f"INSERT INTO {S5}.loads VALUES (1, now() - interval '3 days')")
            t = DatasetTable(dataset_id=w.dataset.id, datasource_id=w.ds.id, source_kind="physical_table",
                             source_table_name=f"{S5}.loads", display_name="loads", enabled=True,
                             columns_cache={"columns": [{"name": "id", "type": "integer"},
                                                        {"name": "loaded_at", "type": "datetime"}]})
            w.db.add(t)
            w.db.flush()
            w.tables["loads"] = t
            m = _monitor(w, "freshness", table="loads", time_column="loaded_at", max_lag_hours=24)
            out = ObservabilityService.run_monitor(m, w.db)
            assert out["status"] == "breached" and 70 < out["value"] < 74, out
            assert _open_incidents(w, f"freshness:monitor_{m.id}") == 1
            _ddl(pg, f"INSERT INTO {S5}.loads VALUES (2, now())")
            assert ObservabilityService.run_monitor(m, w.db)["status"] == "ok"
            assert _open_incidents(w, f"freshness:monitor_{m.id}") == 0
        finally:
            _ddl(pg, f"DROP TABLE IF EXISTS {S5}.loads")


def test_a_column_summary_is_keyed_by_the_tables_shaping(monkeypatch):
    """A summary cached for the pre-edit relation was served after a
    transformation edit (the key named only the source)."""
    from app.services import column_summary_service as css
    from app.services import query_cache

    seen = []

    def capture(_ds, _tid, _kind, payload, _filters):
        seen.append(payload)
        raise RuntimeError("stop after the key")

    monkeypatch.setattr(query_cache, "get_cached", capture)
    for steps in ([], [add_column("ratio", "[a] / [b]")]):
        with pytest.raises(RuntimeError):
            css.ColumnSummaryService.get_column_summary(_pg_source(), _table(steps), "a") \
                if hasattr(css, "ColumnSummaryService") else css.get_column_summary(_pg_source(), _table(steps), "a")
    assert seen[0] != seen[1], seen
