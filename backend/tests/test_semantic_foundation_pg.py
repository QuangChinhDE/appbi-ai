"""Semantic foundation freeze — Pair #1 + #2 + #3 as ONE kernel, executed.

The stored model defines one relationship truth (Pair #1); it gives one
deterministic query meaning (Pair #2); every execution path preserves it
(Pair #3). This module proves the contracts BETWEEN the pairs on a real,
freshly migrated Postgres (DATABASE_URL) and DuckDB (in process):

  F4/F5  numeric meaning — division is true division and a zero denominator
         is NULL on every engine; AVG has one precision (foundation_corpus)
  F2/F9  the same request through every entry point that returns semantic
  F10    business values — ChartService saved / preview, /semantic/query,
  F6     dataset execute, measure preview — gives the same rows or the same
         refusal category, NULLs included
  F11    a declared soft drop is never silent on any entry point
  F13    one live statement reads tables of ONE connection only

Every oracle is computed by hand (tests/pair2_topology.py,
tests/foundation_corpus.py); no entry point is compared with its own output.
"""
from __future__ import annotations

import math
import uuid

import pytest
import sqlalchemy as sa

from tests import foundation_corpus as F
from tests import pair2_topology as T
from tests.pair3_world import chart_config, chart_world, save_chart
from tests.test_pair2_golden_topology_pg import (  # noqa: F401 — fixtures
    _norm,
    canon,
    duck,
    run as engine_run,
    world,
    world_duck,
)
from tests.test_pair2_golden_topology_pg import expect as engine_expect
from tests.test_pair3_chartservice_pg import (  # noqa: F401 — fixtures
    _pg_config,
    ask_preview,
    ask_saved,
    http,
    no_result_cache,
    real_cache,
    pg,
)
from tests.test_pair3_chartservice_pg import expect as chart_expect

ALL = T.CASES + T.TOP_N + F.CASES + F.EXECUTED_REFUSALS + F.SOFT_DROP_CASES
BY_ID = {c[0]: c for c in ALL}


# ── F4 / F5 — numeric meaning ──────────────────────────────────────────────────


@pytest.mark.parametrize("case", F.CASES, ids=[c[0] for c in F.CASES])
def test_division_means_the_same_number_on_postgres(world, case):
    _id, model, base, req, expected = case
    engine_expect(engine_run(world, model, base, req), expected)


@pytest.mark.parametrize("case", F.CASES, ids=[c[0] for c in F.CASES])
def test_division_means_the_same_number_on_duckdb(world_duck, case):
    _id, model, base, req, expected = case
    engine_expect(engine_run(world_duck, model, base, req), expected)


@pytest.mark.parametrize("case", F.CASES, ids=[c[0] for c in F.CASES])
def test_division_means_the_same_number_through_a_saved_chart(pg, case):
    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart_expect(ask_saved(w, base, req), req, expected)


@pytest.mark.parametrize("fixture", ["world", "world_duck"])
def test_a_small_ratio_keeps_its_significant_digits(request, fixture):
    """1 / 30000 is 3.333…e-05, not 0 (Postgres integer division) and not
    0.0000 (MySQL's 4 extra digits): relative error below 1e-9."""
    from tests.test_pair2_golden_topology_pg import generate

    w = request.getfixturevalue(fixture)
    _eng, sql = generate(w, F.M, F.B, {"dims": [], "measures": ["p2_nums.small_ratio"]})
    assert not isinstance(sql, Exception), sql
    _names, raw = w.execute(sql)
    value = float(raw[0][0])
    assert math.isclose(value, 1 / 30000, rel_tol=1e-9), value


def test_the_rewrite_never_touches_strings_comments_or_explicit_integer_division():
    from app.services.semantic_arithmetic import normalize_division as nd

    assert nd("'1/2' || ${TABLE}.a", "postgresql") == "'1/2' || ${TABLE}.a"
    assert nd("a /* c/d */ + 1", "postgresql") == "a /* c/d */ + 1"
    assert nd("a // b", "duckdb") == "a // b"
    assert nd("${a} / ${b}", "postgresql") == "${a} * 1.0 / NULLIF(${b}, 0)"
    # MySQL: x / 0 is already NULL; NULLIF around a window is evaluated twice by MySQL 8
    assert nd("${a} / ${b}", "mysql") == "${a} * 1e0 / ${b}"
    assert nd("a / SUM(b) OVER ()", "mysql") == "a * 1e0 / SUM(b) OVER ()"
    assert nd("${a} / ${b}", "bigquery") == "${a} / NULLIF(${b}, 0)"
    assert nd("a / SUM(b) OVER ()", "duckdb") == "a / NULLIF(SUM(b) OVER (), 0)"
    assert nd("x / NULLIF(y, 0)", "bigquery") == "x / NULLIF(y, 0)"
    assert nd("x / 100", "bigquery") == "x / 100"


# ── F2 / F9 / F10 / F6 — one request, every entry point ───────────────────────

# Representative requests: SUM, AVG, COUNT DISTINCT, filtered measure, ratio,
# role-playing date, related filter, multi-fact, M:N, composite, NULL, and one
# of every refusal family (ambiguous / unequal-length / reverse base / calendar
# roles / equivalent-key orphans / fan-out / route limit / unrelated grain /
# unsupported context / unreachable view).
ENTRY_CORPUS = [
    "F4.sum_int.by_grp", "F4.avg_int.by_grp", "F4.count_distinct.kpi", "F4.int_div_int.by_grp",
    "F4.zero_denominator.kpi", "F4.null_denominator.by_grp", "F4.dimension_division",
    "F7.cross_view_formula.kpi", "F7.formula_on_dimension_view.kpi", "F7.dependencies_asked_separately",
    "F8.one_to_one.by_channel", "F8.one_to_one.filter_web",
    "F10.invalid_relationship", "F10.duplicate_one_side",
    "F4.comment_before_division", "F7.mixed_grain_child_column", "F7.parent_column_measure",
    "F7.cross_table_measure.kpi", "F7.cross_table_measure.unrelated_dim", "F7.plain_measure.unrelated_dim",
    "F11.text_operator_on_a_date_refused",
    "G2.measure_filter_related_kpi", "G7.by_ship_year", "G2.kpi_region_filter", "G6.kpi_three_facts",
    "G6.by_owner_two_facts", "G9.kpi_vip", "G8.by_region", "G8.kpi_region_filter", "G5.kpi_won_deals_both",
    "G12.orphan.direct_and_chain_by_product",
    # NULL contract: a fact row with no member passes no predicate, IS NULL included
    "G1.kpi_customer_name_is_null", "G1.kpi_customer_name_is_not_null", "G2.kpi_region_is_null_two_hops",
    "G1.by_product",
    # refusals
    "G3.by_region", "G12.unequal.fact_by_customer", "G2d.base_customers_by_region",
    "G7.stitch_by_year_tied_roles", "G12.orphan.two_chains_by_product", "G6.by_stage_two_facts",
    "G14.lattice_select", "G9.by_tag", "G2.modifier_all_refused", "G1.measure_filter_related_unreachable",
]
# declared soft drops: the filter is left out AND said so, on every entry point
SOFT_DROPS = ["G5.kpi_won_deals_single", "G9.kpi_vip_single", "G1.dims_only_fact_filter_single",
              "F11.isolated_measure_unreachable_filter", "F11.unrelated_fact_filter_recorded"]


def _refs(req):
    return list(req.get("dims") or []) + list(req.get("measures") or [])


def _by_ref(req, rows, *, remapped, decimal_strings=False):
    """Rows keyed by field ref. Engine aliases (`view_field`) are matched
    case-insensitively (Postgres folds an unquoted alias). `decimal_strings`:
    the response serializes a warehouse DECIMAL as a JSON string
    (/semantic/query) — the same number, a transport type."""
    import decimal
    import re

    from app.services.semantic_query_engine import SemanticQueryEngine

    measures = set(req.get("measures") or [])
    out = []
    for r in rows:
        low = {str(k).lower(): v for k, v in r.items()}
        row = {}
        for ref in _refs(req):
            key = ref if remapped else SemanticQueryEngine._safe_alias(None, ref)
            v = r.get(key) if key in r else low.get(key.lower())
            if isinstance(v, str) and (ref in measures or (decimal_strings and re.fullmatch(r"-?\d+\.\d+", v))):
                v = decimal.Decimal(v)
            row[ref] = _norm(v)
        out.append(row)
    return out


def _single_predicates(req):
    """{field: {operator, value}} when every field has ONE plain predicate
    (/semantic/query's contract), else None."""
    out = {}
    for ref, preds in (req.get("filters") or {}).items():
        preds = preds if isinstance(preds, list) else [preds]
        if len(preds) != 1 or set(preds[0]) - {"operator", "value"}:
            return None
        out[ref] = {"operator": preds[0]["operator"], "value": preds[0].get("value")}
    return out


def _http_outcome(resp, rows_of, *, drops_of=None):
    if resp.status_code == 400:
        return "error", resp.headers.get("X-AppBI-Refusal") or T.REFUSED, resp.text
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return "rows", rows_of(body), {"dropped_filters": (drops_of(body) if drops_of else [])}


def ask_semantic_query(client, w, base, req):
    filters = _single_predicates(req)
    if filters is None or any(f["operator"] in ("is_null", "is_not_null", "between") for f in filters.values()):
        return None     # outside /semantic/query's request contract (one plain predicate per field)
    body = {"explore": base, "model_id": w.model.id, "dimensions": list(req.get("dims") or []),
            "measures": list(req.get("measures") or []), "filters": filters, "limit": 10_000}
    r = client.post("/api/v1/semantic/query", json=body)
    return _http_outcome(r, lambda b: _by_ref(req, b["data"], remapped=False, decimal_strings=True),
                         drops_of=lambda b: b.get("dropped_filters") or [])


def ask_dataset_execute(client, w, base, req):
    filters = []
    for ref, preds in (req.get("filters") or {}).items():
        for p in (preds if isinstance(preds, list) else [preds]):
            if set(p) - {"operator", "value"}:
                return None  # calendar-keyed predicates are a chart-runtime input
            filters.append({"field": ref, "operator": p["operator"], "value": p.get("value")})
    body = {"dimensions": list(req.get("dims") or []),
            "measures": [{"field": m, "function": "auto"} for m in (req.get("measures") or [])],
            "filters": filters, "limit": 10_000}
    r = client.post(f"/api/v1/datasets/{w.dataset.id}/tables/{w.tables[base].id}/execute", json=body)
    return _http_outcome(r, lambda b: _by_ref(req, b["rows"], remapped=True),
                         drops_of=lambda b: b.get("dropped_filters") or [])


def ask_measure_preview(client, w, base, req):
    """The measure editor's "Chạy thử": one declared measure of the base view,
    grouped by at most one base dimension, no filters."""
    measures, dims = list(req.get("measures") or []), list(req.get("dims") or [])
    if len(measures) != 1 or len(dims) > 1 or req.get("filters") or req.get("top_n") or req.get("sorts"):
        return None
    view, name = measures[0].split(".", 1)
    if view != base or (dims and dims[0].split(".", 1)[0] != base):
        return None
    mdef = next((m for m in (w.views[base].measures or []) if m.get("name") == name), None)
    if mdef is None:
        return None
    payload = {"measure": mdef}
    if dims:
        payload["group_by"] = dims[0].split(".", 1)[1]
    r = client.post(f"/api/v1/datasets/{w.dataset.id}/model/views/{w.views[base].id}/measures/preview",
                    json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    if not body.get("ok"):
        return "error", body.get("category") or T.REFUSED, body.get("error")
    return "rows", _by_ref(req, body["rows"], remapped=False), {}


ENTRY_POINTS = {
    "chart_saved": lambda client, w, base, req: ask_saved(w, base, req),
    "chart_preview": lambda client, w, base, req: ask_preview(w, base, req),
    "semantic_query": ask_semantic_query,
    "dataset_execute": ask_dataset_execute,
    "measure_preview": ask_measure_preview,
}


def _matrix(ids):
    return [(cid, ep) for cid in ids for ep in ENTRY_POINTS]


@pytest.mark.parametrize("case_id,entry", _matrix(ENTRY_CORPUS), ids=[f"{c}@{e}" for c, e in _matrix(ENTRY_CORPUS)])
def test_one_request_has_one_meaning_on_every_entry_point(pg, http, case_id, entry):
    client, holder = http
    _id, model, base, req, expected = BY_ID[case_id]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        outcome = ENTRY_POINTS[entry](client, w, base, req)
        if outcome is None:
            pytest.skip(f"{entry}: outside this entry point's request contract")
        chart_expect(outcome, req, expected)


@pytest.mark.parametrize("case_id,entry", _matrix(SOFT_DROPS), ids=[f"{c}@{e}" for c, e in _matrix(SOFT_DROPS)])
def test_a_declared_soft_drop_is_never_silent_on_any_entry_point(pg, http, case_id, entry):
    client, holder = http
    _id, model, base, req, expected = BY_ID[case_id]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        outcome = ENTRY_POINTS[entry](client, w, base, req)
        if outcome is None:
            pytest.skip(f"{entry}: outside this entry point's request contract")
        chart_expect(outcome, req, expected)     # rows AND the dropped field (expected["dropped"])


# ── F13 — one live statement, one connection ──────────────────────────────────

ALT = "p2g_alt"


@pytest.fixture()
def alt_schema(pg):
    """A second Postgres 'datasource' on the same server: schema p2g_alt with a
    `products` table whose names differ from p2g.products."""
    with pg.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {ALT} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {ALT}"))
        c.execute(sa.text(f"CREATE TABLE {ALT}.products(id int, name text)"))
        c.execute(sa.text(f"INSERT INTO {ALT}.products VALUES (1, 'ALT-Pen'), (2, 'ALT-Ink')"))
        # a table only B's schema has: a key probe of it through A's connection cannot even run
        c.execute(sa.text(f"CREATE TABLE {ALT}.only_alt_products(id int, name text)"))
        c.execute(sa.text(f"INSERT INTO {ALT}.only_alt_products VALUES (1, 'ALT-Pen'), (2, 'ALT-Ink')"))
    try:
        yield
    finally:
        with pg.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {ALT} CASCADE"))


def _move_products_to_alt(w, *, same_scope=False, table="products"):
    """p2_products now lives on ANOTHER datasource whose connection resolves an
    unqualified `products` in its own schema (p2g_alt) — or, `same_scope`, a
    second datasource onto the very same database / schema."""
    from app.core.crypto import encrypt_config
    from app.models.models import DataSource, DataSourceType

    cfg = dict(_pg_config(), schema_name=(T.S if same_scope else ALT))
    alt = DataSource(name=f"alt_{uuid.uuid4().hex[:6]}", type=DataSourceType("postgresql"),
                     config=encrypt_config(cfg))
    w.db.add(alt)
    w.db.flush()
    t = w.tables["p2_products"]
    t.datasource_id = alt.id
    t.source_table_name = table
    w.db.flush()
    return alt


def test_a_live_statement_never_reads_another_connections_table_through_its_own(pg, alt_schema):
    """Sales (datasource A, schema p2g) by product, products on datasource B
    (schema p2g_alt). One statement on A's connection would read p2g.products —
    Pen 141 / Ink 57, success, wrong, silent. It is refused instead."""
    _id, model, base, req, _expected = BY_ID["G1.by_product"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        _move_products_to_alt(w)
        kind, payload, extra = ask_saved(w, base, req)
        assert kind == "error" and payload == "UNSUPPORTED_CONTEXT", (kind, payload, extra)
        kind, payload, extra = ask_preview(w, base, req)
        assert kind == "error" and payload == "UNSUPPORTED_CONTEXT", (kind, payload, extra)


def test_the_same_connection_twice_is_one_connection(pg, alt_schema):
    """A second datasource onto the same database and schema reads the same
    table — answered (Pen 141 / Ink 57 from p2g.products)."""
    _id, model, base, req, expected = BY_ID["G1.by_product"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        _move_products_to_alt(w, same_scope=True)
        w.tables["p2_products"].source_table_name = f"{T.S}.products"
        w.db.flush()
        chart_expect(ask_saved(w, base, req), req, expected)


@pytest.mark.parametrize("entry", ["semantic_query", "dataset_execute"])
def test_a_direct_api_never_reads_another_connections_table_through_its_own(pg, http, alt_schema, entry):
    client, holder = http
    _id, model, base, req, _expected = BY_ID["G1.by_product"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _move_products_to_alt(w)
        kind, payload, _extra = ENTRY_POINTS[entry](client, w, base, req)
        assert (kind, payload) == ("error", "UNSUPPORTED_CONTEXT"), (kind, payload, _extra)


def test_a_bigquery_statement_may_read_another_bigquery_connection():
    """BigQuery names a table absolutely (`project.dataset.table`): reading
    another BigQuery datasource's table is the same table — not refused."""
    from types import SimpleNamespace

    from app.services.execution_plan import refuse_foreign_live_sources

    class _Q:
        def __init__(self, rows):
            self.rows = rows

        def filter(self, *_a, **_k):
            return self

        def all(self):
            return self.rows

    from app.services.semantic_join_resolver import SemanticRefusal

    a = SimpleNamespace(id=1, name="A", type="bigquery", config={"project_id": "p1"})
    b = SimpleNamespace(id=2, name="B", type="bigquery", config={"project_id": "p2"})
    db = SimpleNamespace(query=lambda *_a: _Q([b]))
    # B's PHYSICAL tables render as `p2.dataset.table`: the same table from A's job
    refuse_foreign_live_sources(db, {1, 2}, a, {2: {"physical_table"}})
    # B's custom-SQL table text names `dataset.table` — relative to the job's project (p1): refused
    with pytest.raises(SemanticRefusal):
        refuse_foreign_live_sources(db, {1, 2}, a, {2: {"physical_table", "sql_query"}})
    # unknown kinds count as relative
    with pytest.raises(SemanticRefusal):
        refuse_foreign_live_sources(db, {1, 2}, a)
    # the same project: relative and absolute names alike
    b_same = SimpleNamespace(id=2, name="B", type="bigquery", config={"project_id": "P1"})
    refuse_foreign_live_sources(SimpleNamespace(query=lambda *_a: _Q([b_same])), {1, 2}, a, {2: {"sql_query"}})
    pgb = SimpleNamespace(id=3, name="P", type="postgresql", config={"host": "h"})
    db2 = SimpleNamespace(query=lambda *_a: _Q([pgb]))
    with pytest.raises(SemanticRefusal) as exc:
        refuse_foreign_live_sources(db2, {1, 3}, a, {3: {"physical_table"}})
    assert exc.value.category == SemanticRefusal.UNSUPPORTED_CONTEXT
    assert "'P'" not in str(exc.value) and "'A'" not in str(exc.value)   # no connection names (public links)


def test_one_physical_scope_is_one_connection_whatever_its_spelling():
    """Default port, default schema, localhost: the same database — not refused."""
    from types import SimpleNamespace

    from app.services.execution_plan import refuse_foreign_live_sources

    class _Q:
        def __init__(self, rows):
            self.rows = rows

        def filter(self, *_a, **_k):
            return self

        def all(self):
            return self.rows

    a = SimpleNamespace(id=1, name="A", type="postgresql",
                        config={"host": "127.0.0.1", "database": "d", "username": "u"})
    b = SimpleNamespace(id=2, name="B", type="postgresql",
                        config={"host": "localhost", "port": 5432, "database": "d", "username": "u",
                                "schema_name": "public"})
    refuse_foreign_live_sources(SimpleNamespace(query=lambda *_a: _Q([b])), {1, 2}, a, {2: {"sql_query"}})


# ── F15 — a reused engine, a fresh engine, a repeated request: one answer ─────


def test_a_reused_engine_and_a_fresh_one_compile_the_same_meaning(pg):
    """Per-request state (routes, probes, live sources, plan) never leaks from
    one request into the next on a reused instance."""
    from app.models.semantic import SemanticExplore
    from app.services.semantic_query_compiler import SemanticQuerySpec
    from app.services.semantic_query_engine import SemanticQueryEngine

    def spec(w, case_id):
        _id, _model, base, req, _exp = BY_ID[case_id]
        ex = w.db.query(SemanticExplore).filter_by(model_id=w.model.id, base_view_name=base).one()
        return SemanticQuerySpec(explore_name=base, dimensions=list(req.get("dims") or []),
                                 measures=list(req.get("measures") or []),
                                 filters=dict(req.get("filters") or {}), model_id=w.model.id, explore_id=ex.id)

    with chart_world(pg, "G2_snowflake", ds_config=_pg_config()) as w:
        a, b = spec(w, "G2.kpi_region_filter"), spec(w, "G2.by_region")
        reused = SemanticQueryEngine(w.db, database_type="postgresql")
        first = (reused.run(a)[0], set(reused.live_source_ids))
        reused.run(b)
        again = (reused.run(a)[0], set(reused.live_source_ids))
        fresh = SemanticQueryEngine(w.db, database_type="postgresql")
        cold = (fresh.run(a)[0], set(fresh.live_source_ids))
        assert first == again == cold
        assert first[1] == {w.ds.id}


def test_mysql_renders_avg_and_percent_of_total_at_full_precision(world):
    """MySQL keeps 4 extra digits for DECIMAL division and AVG(int) (an average
    of 0/1 flags of 1 in 30000 is 0.0000), and evaluates a window inside NULLIF
    twice in an ungrouped query (% of total = 50, the total doubled): the
    MySQL statement averages a DOUBLE and divides by the bare window (x / 0 is
    NULL there already). Values: the manual MySQL matrix (closure)."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine(world.db, database_type="mysql")
    sql = eng.generate_sql(explore_name="p2_nums", dimensions=[], measures=["p2_nums.avg_a", "p2_nums.pct_a"],
                           filters={}, model_id=world.fwd[F.M])[0]
    flat = " ".join(sql.split())
    assert "AVG((p2_nums.a) * 1e0)" in flat, flat
    assert "SUM(p2_nums.a) * 1e0 / SUM(SUM(p2_nums.a)) OVER ()" in flat, flat
    assert "NULLIF(SUM(SUM(" not in flat, flat


def test_the_rewrite_lexes_strings_and_comments_per_dialect():
    """A `/` inside a string or a comment is never an operator, and the
    division after a `--` / `#` comment line is never appended to it."""
    from app.services.semantic_arithmetic import normalize_division as nd

    # the `/` on the line after a comment: the division stays code
    out = nd("${TABLE}.a -- per b\n / ${TABLE}.b", "postgresql")
    assert out.endswith("\n * 1.0 / NULLIF(${TABLE}.b, 0)"), out
    assert nd("a # note / x\n / b", "bigquery") == "a # note / x\n / NULLIF(b, 0)"
    assert nd("a # b / c", "postgresql") == "a # b * 1.0 / NULLIF(c, 0)"      # `#` is an operator there
    # Postgres strings: a backslash is a character; MySQL / BigQuery: an escape
    assert nd("REPLACE(p, '\\', '/') || a / b", "postgresql").endswith("a * 1.0 / NULLIF(b, 0)")
    assert nd("REPLACE(p, '\\'', '/') || a / b", "mysql").endswith("a * 1e0 / b")
    assert nd("'''a/b''' || x / y", "bigquery") == "'''a/b''' || x / NULLIF(y, 0)"
    # typed literals, subscripts and comments are one right operand
    assert nd("x / NUMERIC '100'", "postgresql") == "x * 1.0 / NULLIF(NUMERIC '100', 0)"
    assert nd("x / arr[1]", "postgresql") == "x * 1.0 / NULLIF(arr[1], 0)"
    # only NULLIF(…, 0) is a zero guard
    assert nd("a / NULLIF(b, 1)", "postgresql") == "a * 1.0 / NULLIF(NULLIF(b, 1), 0)"


def test_a_cache_hit_keeps_the_engines_own_dropped_filters(pg, real_cache, monkeypatch):
    """The engine's soft drop (single-direction gate) is part of the cached
    result: the second viewer (a cache hit, no warehouse call) still sees it."""
    from app.services.chart_service import ChartService
    from app.services.datasource_service import DataSourceConnectionService as DSC

    _id, model, base, req, expected = BY_ID["G5.kpi_won_deals_single"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart = save_chart(w, base, req)
        calls = {"n": 0}
        real = DSC.execute_query

        def counting(*a, **k):
            calls["n"] += 1
            return real(*a, **k)

        monkeypatch.setattr(DSC, "execute_query", staticmethod(counting))
        from tests.pair3_world import runtime_filters

        drops = []
        for _ in range(2):
            out = ChartService.get_chart_data(w.db, chart.id, extra_filters=runtime_filters(req) or None)
            drops.append({d.get("field") or d.get("semantic_field") for d in out["debug"]["dropped_filters"]})
        executed_after_first = calls["n"]
        assert set(expected["dropped"]) <= drops[0] and set(expected["dropped"]) <= drops[1], drops
        out = ChartService.get_chart_data(w.db, chart.id, extra_filters=runtime_filters(req) or None)
        assert calls["n"] == executed_after_first, "the repeated request was not a cache hit"


def test_a_fanned_date_filter_and_look_alike_role_filters_never_share_a_cache_slot(pg, monkeypatch):
    """Copies of ONE fanned Date filter collapse onto the main calendar; the
    same predicates written as separate role filters are AND-ed — different
    queries, so different cache identities (`_calendar_fan` in the key)."""
    from app.services import query_cache
    from app.services.chart_service import ChartService

    seen = []
    # the REAL cache key (canonicalised), not the arguments it is built from
    monkeypatch.setattr(query_cache, "get_cached",
                        lambda _ds, cid, ct, rc, filters: seen.append(query_cache._make_key(cid, ct, rc, filters))
                        or None)
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    role = {"field": "p2_sales__ship_date__date_dim.year", "semanticField": "p2_sales__ship_date__date_dim.year",
            "operator": "eq", "value": 2025}
    with chart_world(pg, "G7_roles_main", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        for extra in ([dict(role)], [dict(role, _calendar_fan="f1")]):
            try:
                ChartService.get_chart_data(w.db, chart.id, extra_filters=extra)
            except Exception:  # noqa: BLE001 — the identity is what is compared
                pass
    assert len(seen) == 2 and seen[0] != seen[1], seen


def test_dataset_execute_ands_every_predicate_on_one_field(pg, http):
    """id >= 2 AND id <= 3 → ids 2, 3 → a = 1 + 3 = 4 (keeping only the last
    predicate, id <= 3, gave 5 + 1 + 3 = 9 — silently)."""
    client, holder = http
    with chart_world(pg, F.M, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        body = {"dimensions": [], "measures": [{"field": "p2_nums.sum_a", "function": "auto"}],
                "filters": [{"field": "p2_nums.id", "operator": "gte", "value": 2},
                            {"field": "p2_nums.id", "operator": "lte", "value": 3}], "limit": 100}
        r = client.post(f"/api/v1/datasets/{w.dataset.id}/tables/{w.tables['p2_nums'].id}/execute", json=body)
        assert r.status_code == 200, r.text
        # ids 2 and 3: a = 1 + 3
        assert [_norm(x["p2_nums.sum_a"]) for x in r.json()["rows"]] == [4], r.json()


def test_a_formula_is_never_re_aggregated_by_an_explicit_agg(pg):
    """`rev_share` is a formula over aggregated measures: agg auto → 1, an
    explicit SUM would aggregate its TEXT as a row expression → refused."""
    req = {"dims": [], "measures": ["p2_sales.rev_share"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        chart_expect(ask_saved(w, "p2_sales", req), req, [{"p2_sales.rev_share": 1}])
        cfg = chart_config(req)
        cfg["roleConfig"]["metrics"] = [{"field": "p2_sales.rev_share", "agg": "sum"}]
        kind, payload, _extra = ask_saved(w, "p2_sales", req, config=cfg)
        assert (kind, payload) == ("error", "UNSUPPORTED_CONTEXT"), (kind, payload)


@pytest.mark.parametrize("entry", ["chart_saved", "chart_preview", "semantic_query", "dataset_execute"])
def test_every_executor_checks_the_connection_before_probing_keys(pg, http, alt_schema, entry):
    """B's `only_alt_products` exists only in B's schema: a key probe through A's
    connection cannot run — the request is refused for what it is (another
    connection's table, UNSUPPORTED_CONTEXT), the same on every entry point."""
    client, holder = http
    _id, model, base, req, _expected = BY_ID["G1.by_product"]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _move_products_to_alt(w, table="only_alt_products")
        kind, payload, _extra = ENTRY_POINTS[entry](client, w, base, req)
        assert (kind, payload) == ("error", "UNSUPPORTED_CONTEXT"), (kind, payload, _extra)


def test_the_live_filter_adapter_divides_like_the_engine_and_reads_one_connection(pg, alt_schema):
    from app.services.chart_service import _build_live_relation_for_semantic_view, _render_live_semantic_field_sql
    from app.services.semantic_join_resolver import SemanticRefusal

    assert _render_live_semantic_field_sql({"sql": "${TABLE}.a / ${TABLE}.b"}, "r", "t", "postgresql") \
        == "t.a * 1.0 / NULLIF(t.b, 0)"
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        _move_products_to_alt(w)
        with pytest.raises(SemanticRefusal) as exc:
            _build_live_relation_for_semantic_view(w.db, w.ds, w.views["p2_products"])
        assert exc.value.category == SemanticRefusal.UNSUPPORTED_CONTEXT
