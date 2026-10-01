"""Mutation harness for the relationship-authoring <-> join-resolver pair.

Runs the pair's key scenarios against WHICHEVER backend is on PYTHONPATH and
prints FIXED (intended behaviour) or DEFECT (pre-fix behaviour) per scenario.
Only APIs that exist in both trees are used, so the same file proves that the
tracked tests discriminate: on the pre-fix tree every scenario but the control
reports DEFECT; on the candidate all report FIXED.

    git archive 22bac47f backend/app | tar -x -C /tmp/prefix
    cd /tmp/prefix/backend
    DATABASE_URL=sqlite:///./x.db PYTHONPATH=. ENVIRONMENT=test python
        <repo>/backend/tests/mutation/relationship_pair_mutation.py
        <repo>/backend/tests/fixtures/relationship_legacy_v1.json      (one command line)

Not collected by pytest (no test_ prefix) and not run in CI: the behaviour it
checks is locked by tests/test_relationship_contract.py and
tests/test_relationship_contract_pg.py; this file only shows those assertions
fail on the code they were written against.
"""
import json
import sys
import types
import uuid
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


from app.core.database import Base  # noqa: E402
from app.models.dataset import Dataset, DatasetTable  # noqa: E402
from app.models.models import Chart, DataSource  # noqa: E402
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView  # noqa: E402
from app.services import dataset_model_service as dms  # noqa: E402
from app.services.semantic_join_resolver import SemanticJoinResolver  # noqa: E402

FIX = json.loads(Path(sys.argv[1]).read_text("utf-8"))
CASES = {c["id"]: c for c in FIX["cases"]}
results = []


def report(name, fixed, detail=""):
    results.append((name, fixed))
    print(f"{'FIXED ' if fixed else 'DEFECT'}  {name}  {detail}")


def scenario(fn):
    try:
        fn()
    except Exception as exc:  # a crash is reported, never silently skipped
        report(fn.__name__, False, f"CRASH {type(exc).__name__}: {exc}")
    return fn


def _model(joins, base="orders", extra=()):
    explores = [types.SimpleNamespace(id=1, base_view_name=base, joins=joins)]
    explores += [types.SimpleNamespace(id=i + 2, base_view_name=v, joins=[]) for i, v in enumerate(extra)]
    return types.SimpleNamespace(id=None, explores=explores, updated_at=None)


# H1 — malformed / unknown rows must not become a usable N:1 edge
for cid in ("unknown_cardinality", "missing_cardinality_and_relationship", "string_false",
            "invalid_cross_filter", "is_active_garbage", "conflicting_cardinality"):
    def _h1(cid=cid):
        r = SemanticJoinResolver(None, _model([CASES[cid]["join"]], extra=["customers"]), "orders")
        path = r.resolve_path("customers")
        report(f"H1 resolver: {cid}", path is None,
               "" if path is None else f"edge used as {path.steps[0].edge.cardinality}")
    _h1.__name__ = f"H1 {cid}"
    scenario(_h1)


@scenario
def h1_grain_graph_string_false():
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng._model = _model([CASES["string_false"]["join"]], extra=["customers"])
    eng._nf_adj_cache = {}
    report("H1 grain graph: is_active 'false'", "customers" not in eng._m1_reachable_views("orders"))


def _render(edge):
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.database_type = "postgresql"
    eng._model = None
    eng.views_cache = {}
    return eng._render_edge_join_condition(edge)


@scenario
def h6_composite_reverse():
    join = dict(CASES["composite_sql_on_scalar_first_pair"]["join"], cross_filter="both")
    r = SemanticJoinResolver(None, _model([join], extra=["shops"]), "shops")
    path = r.resolve_path("orders")
    sql = _render(path.steps[0].edge) if path else ""
    report("H6 composite reverse edge keeps both keys", "store_code" in sql and "region_code" in sql, sql)


@scenario
def h6_calendar_reverse():
    join = CASES["calendar_cast_expression"]["join"]
    r = SemanticJoinResolver(None, _model([join], extra=["orders__created_at__date_dim"]),
                             "orders__created_at__date_dim", bidirectional=True)
    path = r.resolve_path("orders")
    sql = _render(path.steps[0].edge) if path else ""
    report("H6 calendar reverse edge keeps the CAST", "CAST(orders.created_at AS DATE)" in sql, sql)


@scenario
def h7_health_parity():
    from app.services import semantic_health_service as h

    bad = []
    for cid in ("lookml_condition_no_columns", "reversed_equality"):
        j = CASES[cid]["join"]
        try:
            from app.services.semantic_join_resolver import read_join_contract
            frm, to = h._join_key_columns(read_join_contract("orders", j))
        except ImportError:
            frm, to = h._join_key_columns(j)
        if list(zip(frm, to)) != [("customer_id", "id")]:
            bad.append((cid, frm, to))
    report("H7 health reads the resolver's key", not bad, str(bad))


# ── authoring on a SQLite world ──────────────────────────────────────────────
def world(generated=False):
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, Chart.__table__, DataSource.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    s = Session(engine)
    s.add(Dataset(id=1, name="d", owner_id=uuid.UUID(int=1)))
    for tid, name, cols in [(11, "orders", [("id", "integer"), ("customer_id", "integer"), ("ship_key", "integer")]),
                            (12, "customers", [("id", "integer"), ("alt_id", "integer"), ("region", "string")]),
                            (13, "periods", [("pkey", "integer"), ("year", "integer")])]:
        s.add(DatasetTable(id=tid, dataset_id=1, display_name=name, source_table_name=name,
                           columns_cache=[{"name": c, "type": t} for c, t in cols]))
    s.commit()
    dms.generate_dataset_model(s, 1)
    s.commit()
    if not generated:
        for e in s.query(SemanticExplore).all():
            e.joins = []
        s.commit()
    return s


def ids(s):
    return {v.name: v.id for v in s.query(SemanticView).all()}


def rows(s):
    s.expire_all()
    return list(s.query(SemanticExplore).filter(SemanticExplore.base_view_name == "dataset_table_11").one().joins or [])


@scenario
def h3_pk_atomic():
    s = world()
    i = ids(s)
    calls = {"n": 0}
    real = s.commit

    # fail the LAST commit only: count the commits add_join makes
    def counting():
        calls["n"] += 1
        return real()

    s.commit = counting
    dms.add_join(s, dataset_id=1, from_view_id=i["dataset_table_11"], to_view_id=i["dataset_table_12"],
                 from_column="customer_id", to_column="id", relationship="many_to_one",
                 primary_key_on_to_view=["id"])
    commits = calls["n"]
    # now: a failure at the final commit must leave the PK unchanged
    s2 = world()
    i2 = ids(s2)
    n = {"k": 0}
    real2 = s2.commit

    def fail_last():
        n["k"] += 1
        if n["k"] >= commits:
            raise RuntimeError("injected at the join commit")
        return real2()

    s2.commit = fail_last
    try:
        dms.add_join(s2, dataset_id=1, from_view_id=i2["dataset_table_11"], to_view_id=i2["dataset_table_12"],
                     from_column="customer_id", to_column="id", relationship="many_to_one",
                     primary_key_on_to_view=["id"])
    except RuntimeError:
        pass
    s2.rollback()
    s2.commit = real2
    s2.expire_all()
    pk = s2.get(SemanticView, i2["dataset_table_12"]).primary_key
    report("H3 failed add_join leaves the PK unchanged", commits == 1 and not pk,
           f"commits={commits} pk_after_failure={pk}")


@scenario
def edit_identity_change_replaces():
    s = world()
    i = ids(s)
    kw = dict(dataset_id=1, from_view_id=i["dataset_table_11"], to_view_id=i["dataset_table_12"],
              relationship="many_to_one")
    dms.add_join(s, from_column="customer_id", to_column="id", **kw)
    try:
        dms.add_join(s, from_column="customer_id", to_column="alt_id", replaces={
            "from_view": "dataset_table_11", "view": "dataset_table_12", "alias": None,
            "from_columns": ["customer_id"], "to_columns": ["id"]}, **kw)
    except TypeError:  # pre-fix: no `replaces` — the FE's edit is a plain add
        dms.add_join(s, from_column="customer_id", to_column="alt_id", **kw)
    n = len(rows(s))
    report("edit of keys replaces the relationship (no duplicate)", n == 1, f"rows={n}")


@scenario
def delete_without_keys_is_not_a_wildcard():
    s = world()
    i = ids(s)
    for alias, col in (("ship_p", "ship_key"), ("cust_p", "customer_id")):
        dms.add_join(s, dataset_id=1, from_view_id=i["dataset_table_11"], to_view_id=i["dataset_table_13"],
                     from_column=col, to_column="pkey", relationship="many_to_one", alias=alias)
    try:
        dms.remove_join(s, 1, i["dataset_table_11"], "dataset_table_13")
    except ValueError:
        pass
    s.rollback()
    n = len(rows(s))
    report("remove without keys removes nothing (not every join to the view)", n == 2, f"rows_left={n}")


@scenario
def regeneration_keeps_tombstone():
    s = world(generated=True)
    i = ids(s)
    dms.remove_join(s, 1, i["dataset_table_11"], "dataset_table_12", from_columns=["customer_id"], to_columns=["id"])
    dms.generate_dataset_model(s, 1)
    s.commit()
    n = len(rows(s))
    report("regeneration does not resurrect a removed auto join", n == 0, f"rows={n}")


@scenario
def regeneration_keeps_user_edit():
    s = world(generated=True)
    i = ids(s)
    dms.add_join(s, dataset_id=1, from_view_id=i["dataset_table_11"], to_view_id=i["dataset_table_12"],
                 from_column="customer_id", to_column="id", relationship="many_to_one", is_active=False)
    dms.generate_dataset_model(s, 1)
    s.commit()
    act = [j.get("is_active", True) for j in rows(s)]
    report("regeneration keeps a user's edit of an auto join", act == [False], f"is_active={act}")


@scenario
def calendar_edit_keeps_cast():
    s = world()
    i = ids(s)
    e = s.query(SemanticExplore).filter(SemanticExplore.base_view_name == "dataset_table_11").one()
    e.joins = [{"name": "dataset_table_13", "view": "dataset_table_13", "from_view": "dataset_table_11",
                "from_column": "ship_key", "to_column": "pkey", "from_columns": ["ship_key"], "to_columns": ["pkey"],
                "sql_on": "CAST(${TABLE}.ship_key AS DATE) = ${dataset_table_13}.pkey",
                "relationship": "many_to_one", "origin": "auto_calendar", "managed": True}]
    s.commit()
    dms.add_join(s, dataset_id=1, from_view_id=i["dataset_table_11"], to_view_id=i["dataset_table_13"],
                 from_column="ship_key", to_column="pkey", relationship="many_to_one", is_active=False)
    (j,) = rows(s)
    report("same-identity edit keeps a calendar join's CAST", str(j.get("sql_on", "")).startswith("CAST("),
           j.get("sql_on"))


@scenario
def direct_api_refuses_foreign_from_view():
    s = world()
    j = {"name": "x", "view": "dataset_table_11", "from_view": "dataset_table_12", "type": "left", "sql_on": "",
         "relationship": "many_to_one", "from_column": "id", "to_column": "id"}
    try:
        dms.validate_direct_explore_joins(s, 1, "dataset_table_11", [j])
        ok = False
    except ValueError:
        ok = True
    report("direct API refuses a row whose from_view is not the explore base", ok)


@scenario
def model_response_is_canonical():
    s = world()
    e = s.query(SemanticExplore).filter(SemanticExplore.base_view_name == "dataset_table_11").one()
    e.joins = [{"name": "dataset_table_12", "view": "dataset_table_12", "from_column": "customer_id",
                "to_column": "id", "sql_on": "${TABLE}.customer_id = ${dataset_table_12}.id",
                "relationship": "many_to_one", "is_active": "false"}]
    s.commit()
    m = dms.get_dataset_model(s, 1)
    js = [j for e in m.get("explores", []) for j in (e.get("joins") or []) if j.get("view") == "dataset_table_12"]
    act = [j.get("is_active") for j in js]
    report("model response shows 'false' as inactive", act == [False], f"is_active={act}")


fixed = sum(1 for _n, f in results if f)
print(f"\n{fixed}/{len(results)} FIXED")
