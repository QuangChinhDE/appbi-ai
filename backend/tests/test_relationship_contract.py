"""Model authoring ↔ join resolver: one authored relationship = one persisted
contract = one runtime contract.

Unit tier (SQLite). Locks, behaviourally (after reload, through the resolver
graph / grain graph / health parser / runtime guard — not "the JSON has a key"):

  H1  strict write vs lenient read: a persisted row with unknown or missing
      cardinality, a non-boolean is_active, or an invalid cross_filter never
      becomes a many-to-one / active / single edge; the legacy forms that ARE
      supported read through an explicit canonicalization.
  H3  PK + relationship are one transaction (an injected failure after the PK
      change leaves neither); no helper commits mid-operation.
  H4  a 1:N drawing with a PK is refused, not applied to the other table.
  H5  role-played aliases stay distinct relationships (identity, delete).
  H6  composite keys stay composite — also on reverse edges; a calendar
      expression is not reduced to a plain equality when walked backwards.
  H7  semantic health reads the key from the same contract as the resolver.
  H8  a to-one JOIN's key is verified at runtime; duplicate or unverifiable →
      refused.
  and the write-path defects found on the way: an edit that changes identity
  replaces the old row; a same-identity edit keeps the stored condition and
  provenance; delete is alias-aware and never a wildcard; a removed auto join
  leaves a tombstone.

The legacy fixture is tests/fixtures/relationship_legacy_v1.json.
"""
from __future__ import annotations

import json
import types
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.models import Chart
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_join_resolver import (
    SemanticJoinResolver,
    join_is_usable,
    raise_for_invalid_relationships,
    read_join_contract,
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "relationship_legacy_v1.json").read_text("utf-8"))
CASES = {c["id"]: c for c in FIXTURE["cases"]}


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


def _model(joins, base="orders", extra=()):
    explores = [types.SimpleNamespace(id=1, base_view_name=base, joins=joins)]
    explores += [types.SimpleNamespace(id=i + 2, base_view_name=v, joins=[]) for i, v in enumerate(extra)]
    return types.SimpleNamespace(id=None, explores=explores, updated_at=None)


# ── H1 / F: every legacy form is SUPPORTED (deterministic) or INVALID (loud) ─


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_legacy_fixture_reads_as_declared(case_id):
    case = CASES[case_id]
    c = read_join_contract("orders", json.loads(json.dumps(case["join"])))  # as reloaded from JSON
    if case["class"] == "INVALID":
        assert not c.valid, (case_id, c)
        # … and the runtime graph neither uses it nor hides it.
        r = SemanticJoinResolver(None, _model([case["join"]]), "orders", bidirectional=True)
        assert all(e.to_node != (c.node or "?") for edges in r._adj.values() for e in edges)
        assert r.invalid_joins and r.invalid_joins[0]["reasons"]
        with pytest.raises(ValueError):
            raise_for_invalid_relationships(r)
        assert join_is_usable("orders", case["join"]) is False
        return
    assert c.valid, (case_id, c.invalid)
    for key, want in case.get("expect", {}).items():
        got = getattr(c, key)
        if key == "key_pairs":
            got = [list(p) for p in got]
        assert got == want, (case_id, key, got)


def test_unknown_cardinality_never_reaches_the_graph_as_many_to_one():
    """The pre-contract resolver read "bogus" (and a missing value) as
    many_to_one — the edge the live path then LEFT JOINed as non-fanning."""
    for case_id in ("unknown_cardinality", "missing_cardinality_and_relationship"):
        r = SemanticJoinResolver(None, _model([CASES[case_id]["join"]], extra=["customers"]), "orders")
        assert r.resolve_path("customers") is None, case_id


def test_string_false_is_inactive_in_the_resolver_and_the_grain_graph():
    from app.services.semantic_query_engine import SemanticQueryEngine

    join = CASES["string_false"]["join"]
    r = SemanticJoinResolver(None, _model([join], extra=["customers"]), "orders")
    assert r.resolve_path("customers") is None, '"false" used to be bool("false") == True'
    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng._model = _model([join], extra=["customers"])
    eng._nf_adj_cache = {}
    assert "customers" not in eng._m1_reachable_views("orders")


def test_invalid_cross_filter_does_not_become_single():
    r = SemanticJoinResolver(None, _model([CASES["invalid_cross_filter"]["join"]], extra=["customers"]), "orders")
    assert r.resolve_path("customers") is None and r.invalid_joins


def test_the_real_database_shapes_all_read_as_supported():
    """The shapes the audit found in the persisted model (336 rows): relationship
    without cardinality, missing is_active / cross_filter, LookML conditions,
    calendar CAST / local-date expressions with key columns."""
    for case_id in ("relationship_only", "missing_is_active_and_cross_filter", "lookml_condition_no_columns",
                    "calendar_cast_expression"):
        assert read_join_contract("orders", CASES[case_id]["join"]).valid, case_id


# ── H5: role-played aliases are distinct business roles ─────────────────────


def test_role_played_aliases_are_distinct_nodes_and_identities():
    a, b = CASES["role_played_alias_ship"]["join"], CASES["role_played_alias_close"]["join"]
    ca, cb = read_join_contract("orders", a), read_join_contract("orders", b)
    assert ca.identity != cb.identity
    r = SemanticJoinResolver(None, _model([a, b], extra=["calendar"]), "orders")
    assert r.resolve_path("ship_cal").steps[-1].edge.from_column == "ship_date"
    assert r.resolve_path("close_cal").steps[-1].edge.from_column == "close_date"


# ── H6: composite keys and expressions survive reverse edges ────────────────


def _engine_for(model, dialect="postgresql"):
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.database_type = dialect
    eng._model = model
    eng.views_cache = {}
    return eng


def test_a_composite_relationship_walked_backwards_keeps_every_key_column():
    join = dict(CASES["composite_sql_on_scalar_first_pair"]["join"], cross_filter="both")
    r = SemanticJoinResolver(None, _model([join], extra=["shops"]), "shops", bidirectional=False)
    step = r.resolve_path("orders").steps[0]
    assert step.edge.is_reverse
    rendered = _engine_for(None)._render_edge_join_condition(step.edge)
    assert "region_code" in rendered and "store_code" in rendered, rendered


def test_a_calendar_join_walked_backwards_keeps_its_cast():
    join = CASES["calendar_cast_expression"]["join"]
    r = SemanticJoinResolver(None, _model([join], extra=["orders__created_at__date_dim"]),
                             "orders__created_at__date_dim", bidirectional=True)
    step = r.resolve_path("orders").steps[0]
    rendered = _engine_for(None)._render_edge_join_condition(step.edge)
    assert "CAST(orders.created_at AS DATE)" in rendered, rendered


# ── H7: health reads the key from the same contract ─────────────────────────


@pytest.mark.parametrize("case_id", ["lookml_condition_no_columns", "reversed_equality",
                                     "composite_sql_on_scalar_first_pair", "composite_lists"])
def test_health_sees_exactly_the_key_the_resolver_joins_on(case_id):
    from app.services.semantic_health_service import _join_key_columns

    c = read_join_contract("orders", CASES[case_id]["join"])
    frm, to = _join_key_columns(c)
    assert list(zip(frm, to)) == list(c.key_pairs) and to, case_id


# ── authoring: a world with real rows ───────────────────────────────────────


OWNER = uuid.UUID(int=1)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, Chart.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    dims = lambda *n: [{"name": x, "type": "string", "sql": f"${{TABLE}}.{x}"} for x in n]  # noqa: E731
    with Session(engine) as s:
        s.add(Dataset(id=1, name="d", owner_id=OWNER))
        for tid, name, cols in [(11, "orders", ("id", "customer_id", "ship_date", "close_date")),
                                (12, "customers", ("id", "region")), (13, "calendar", ("date", "year"))]:
            s.add(DatasetTable(id=tid, dataset_id=1, display_name=name, source_table_name=name,
                               columns_cache=[{"name": c} for c in cols]))
            s.add(SemanticView(id=tid, name=name, dataset_table_id=tid, sql_table_name=name,
                               dimensions=dims(*cols), measures=[]))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=11, base_view_name="orders", joins=[]))
        s.add(SemanticExplore(id=2, name="customers", model_id=1, base_view_id=12, base_view_name="customers", joins=[]))
        s.commit()
        yield s


def _add(db, **kw):
    from app.services.dataset_model_service import add_join

    base = dict(dataset_id=1, from_view_id=11, to_view_id=12, from_column="customer_id", to_column="id",
                relationship="many_to_one")
    base.update(kw)
    return add_join(db, **base)


def _joins(db, explore_id=1):
    db.expire_all()
    return list(db.get(SemanticExplore, explore_id).joins or [])


def test_pk_and_relationship_commit_together_or_not_at_all(db, monkeypatch):
    """An injected failure AFTER the PK was validated and changed, BEFORE the
    relationship is committed: neither is persisted (the PK used to commit
    first, on its own)."""
    calls = {"n": 0}
    real_commit = db.commit

    def failing_commit():
        calls["n"] += 1
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(db, "commit", failing_commit)
    with pytest.raises(RuntimeError):
        _add(db, primary_key_on_to_view=["id"])
    assert calls["n"] == 1, "exactly one commit point — no helper commits mid-operation"
    db.rollback()
    monkeypatch.setattr(db, "commit", real_commit)
    assert db.get(SemanticView, 12).primary_key in (None, [])
    assert _joins(db) == []

    _add(db, primary_key_on_to_view=["id"])
    assert db.get(SemanticView, 12).primary_key == ["id"] and len(_joins(db)) == 1


def test_a_pk_with_a_one_to_many_drawing_is_refused_not_moved(db):
    from app.services.dataset_model_service import add_join

    with pytest.raises(ValueError):
        add_join(db, dataset_id=1, from_view_id=12, to_view_id=11, from_column="id", to_column="customer_id",
                 relationship="one_to_many", primary_key_on_to_view=["id"])
    db.rollback()
    assert db.get(SemanticView, 11).primary_key in (None, []) and db.get(SemanticView, 12).primary_key in (None, [])


def test_an_empty_pk_clears_and_none_keeps(db):
    _add(db, primary_key_on_to_view=["id"])
    _add(db, primary_key_on_to_view=None)
    assert db.get(SemanticView, 12).primary_key == ["id"]
    _add(db, primary_key_on_to_view=[])
    assert db.get(SemanticView, 12).primary_key is None


def test_a_one_to_many_drawing_is_stored_on_the_many_side_with_the_same_meaning(db):
    from app.services.dataset_model_service import add_join

    res = add_join(db, dataset_id=1, from_view_id=12, to_view_id=11, from_column="id", to_column="customer_id",
                   relationship="one_to_many", is_active=False, cross_filter="both")
    assert res.get("canonicalized") is True
    (j,) = _joins(db, 1)
    c = read_join_contract("orders", j)
    assert (c.cardinality, c.key_pairs, c.is_active, c.cross_filter) == (
        "many_to_one", (("customer_id", "id"),), False, "both")
    assert _joins(db, 2) == []


def test_an_edit_that_changes_identity_replaces_the_old_relationship(db):
    _add(db)
    _add(db, from_column="customer_id", to_column="region",  # a different key, same tables
         replaces={"from_view": "orders", "view": "customers", "alias": None,
                   "from_columns": ["customer_id"], "to_columns": ["id"]})
    (j,) = _joins(db)
    assert read_join_contract("orders", j).key_pairs == (("customer_id", "region"),)


def test_an_edit_of_a_relationship_someone_else_changed_is_refused(db):
    _add(db)
    with pytest.raises(ValueError):
        _add(db, from_column="customer_id", to_column="region",
             replaces={"from_view": "orders", "view": "customers", "alias": None,
                       "from_columns": ["customer_id"], "to_columns": ["no_longer_there"]})
    db.rollback()
    (j,) = _joins(db)
    assert read_join_contract("orders", j).key_pairs == (("customer_id", "id"),)


def test_a_same_identity_edit_keeps_the_stored_condition_and_provenance(db):
    """A calendar join's CAST and calendar metadata survive an edit of its
    active state (the edit used to rebuild a plain `a = b`, which on Postgres
    matches a timestamp only at midnight)."""
    e = db.get(SemanticExplore, 1)
    e.joins = [{
        "name": "calendar", "view": "calendar", "from_view": "orders",
        "from_column": "ship_date", "to_column": "date", "from_columns": ["ship_date"], "to_columns": ["date"],
        "sql_on": "CAST(${TABLE}.ship_date AS DATE) = ${calendar}.date",
        "relationship": "many_to_one", "origin": "auto_calendar", "managed": True,
        "calendar_role": "ship", "calendar_source_field": "ship_date",
    }]
    db.commit()
    _add(db, to_view_id=13, from_column="ship_date", to_column="date", is_active=False)
    (j,) = _joins(db)
    assert j["sql_on"].startswith("CAST(") and j["origin"] == "auto_calendar"
    assert j["calendar_role"] == "ship" and j["user_edited"] is True
    assert read_join_contract("orders", j).is_active is False


def test_delete_is_alias_aware_and_never_a_wildcard(db):
    from app.services.dataset_model_service import remove_join

    _add(db, to_view_id=13, from_column="ship_date", to_column="date", alias="ship_cal")
    _add(db, to_view_id=13, from_column="ship_date", to_column="date", alias="other_cal")
    with pytest.raises(ValueError):  # no key columns: not "every join to calendar"
        remove_join(db, 1, 11, "calendar")
    db.rollback()
    with pytest.raises(ValueError):  # old client without alias, two candidates
        remove_join(db, 1, 11, "calendar", from_columns=["ship_date"], to_columns=["date"])
    db.rollback()
    remove_join(db, 1, 11, "calendar", from_columns=["ship_date"], to_columns=["date"],
                alias="ship_cal", alias_given=True)
    assert [j["alias"] for j in _joins(db)] == ["other_cal"]


def test_removing_an_auto_join_leaves_a_tombstone(db):
    from app.services.dataset_model_service import _rejected_signatures, _suggestion_signature, remove_join

    e = db.get(SemanticExplore, 1)
    e.joins = [{"name": "customers", "view": "customers", "from_view": "orders", "from_column": "customer_id",
                "to_column": "id", "from_columns": ["customer_id"], "to_columns": ["id"],
                "sql_on": "${TABLE}.customer_id = ${customers}.id", "relationship": "many_to_one",
                "cardinality": "many_to_one", "origin": "auto_fk", "managed": True}]
    db.commit()
    remove_join(db, 1, 11, "customers", from_columns=["customer_id"], to_columns=["id"])
    db.expire_all()
    assert _suggestion_signature("orders", "customers", ["customer_id"], ["id"]) in \
        _rejected_signatures(db.get(SemanticModel, 1))


def test_drift_repair_no_longer_deletes_a_manual_join_whose_column_vanished():
    from app.services.dataset_model_service import _sanitize_join_definitions

    join = {"view": "customers", "from_column": "customer_id", "to_column": "id",
            "cardinality": "many_to_one", "origin": "manual"}
    kept = _sanitize_join_definitions([join], base_view_name="orders", base_fields={"id"},
                                      valid_target_view_names={"customers"})
    assert len(kept) == 1


# ── H8: the key a to-one JOIN trusts is verified before the query runs ──────


def test_key_probe_refuses_a_duplicate_and_an_unverifiable_key(monkeypatch):
    from app.services import query_cache, relationship_key_guard as g
    from app.services.datasource_service import DataSourceConnectionService

    store = {}
    monkeypatch.setattr(query_cache, "get_shared", lambda k: store.get(k))
    monkeypatch.setattr(query_cache, "set_shared", lambda k, v, ttl: store.__setitem__(k, v))
    probe = {"sql": g.key_probe_sql("customers", ["id"]), "view": "customers", "columns": ["id"],
             "label": "orders → customers"}
    calls = []

    def dup(_t, _c, sql, **_k):
        calls.append(sql)
        return ["_appbi_dup"], [{"_appbi_dup": 1}], 0

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(dup))
    with pytest.raises(ValueError, match="bị lặp"):
        g.verify_key_probes([probe], ds_type="postgresql", config={})
    with pytest.raises(ValueError, match="bị lặp"):  # cached verdict, no second warehouse call
        g.verify_key_probes([probe], ds_type="postgresql", config={})
    assert len(calls) == 1

    def boom(*_a, **_k):
        raise RuntimeError("warehouse down")

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(boom))
    with pytest.raises(ValueError, match="Không xác minh được"):
        g.verify_key_probes([probe], ds_type="postgresql", config={}, namespace="other")

    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *_a, **_k: (["_appbi_dup"], [], 0)))
    g.verify_key_probes([probe], ds_type="postgresql", config={}, namespace="clean")  # no raise


def test_the_engine_probes_every_trusted_join_on_the_key_its_condition_compares(db):
    """Calendars included (no name-based exemption: a probe on a calendar is
    cheap, an exemption by name is a way around the guard)."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    _add(db)
    _add(db, to_view_id=13, from_column="ship_date", to_column="date")
    e = SemanticQueryEngine(db, database_type="postgresql")
    e.generate_sql(explore_name="orders", dimensions=["customers.region", "calendar.year"],
                   measures=[], filters={}, model_id=1)
    by_view = {p["view"]: p for p in e.key_probes}
    assert set(by_view) == {"customers", "calendar"}
    assert by_view["customers"]["columns"] == ["customers.id"]
    assert "GROUP BY customers.id HAVING COUNT(*) > 1" in by_view["customers"]["sql"]


def test_a_relationship_walked_from_its_one_side_is_probed_on_that_side(db):
    """Chart based on the DIM summing the FACT: the engine walks the N:1 from
    its one side (FROM customers LEFT JOIN orders). A duplicate customer id
    repeats every order of that id just the same — the pre-fix guard only
    probed edges walked to-one and recorded nothing here."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    o = db.get(SemanticView, 11)
    o.measures = [{"name": "revenue", "type": "sum", "sql": "${TABLE}.id"}]
    db.commit()
    _add(db, cross_filter="both")
    e = SemanticQueryEngine(db, database_type="postgresql")
    sql, _c, _ = e.generate_sql(explore_name="customers", dimensions=["customers.region"],
                                measures=["orders.revenue"], filters={}, model_id=1)
    assert any(p["view"] == "customers" and p["columns"] == ["customers.id"] for p in e.key_probes), (
        sql, e.key_probes)


@pytest.mark.parametrize("condition,expect_exprs,expect_preds", [
    ("orders.customer_id = customers.id", ["customers.id"], []),
    ("customers.id = orders.customer_id", ["customers.id"], []),
    ("orders.a = customers.a AND orders.b = customers.b", ["customers.a", "customers.b"], []),
    # the typed join casts both sides: the probe groups by the CAST, where '007' and '7' collide
    ("SAFE_CAST(orders.customer_id AS FLOAT64) = SAFE_CAST(customers.id AS FLOAT64)",
     ["SAFE_CAST(customers.id AS FLOAT64)"], []),
    ("CAST(orders.ts AS DATE) = customers.d", ["customers.d"], []),
    # a predicate on the one side narrows the rows the JOIN can match
    ("orders.k = customers.k AND customers.active = true", ["customers.k"], ["customers.active = true"]),
    ("orders.k = customers.k AND orders.flag = 1", ["customers.k"], []),
])
def test_the_probe_groups_the_one_side_by_what_the_join_compares(condition, expect_exprs, expect_preds):
    from app.services.relationship_key_guard import one_side_key

    assert one_side_key(condition, "customers", "orders") == (expect_exprs, expect_preds)


@pytest.mark.parametrize("condition", [
    "orders.d BETWEEN customers.start_d AND customers.end_d",
    "orders.a = customers.a OR orders.b = customers.b",
    "orders.a < customers.a",
    "COALESCE(orders.a, customers.b) = 1",
    "",
])
def test_a_condition_that_is_not_a_key_equality_cannot_be_trusted(condition, monkeypatch):
    from app.services.relationship_key_guard import one_side_probe, verify_key_probes

    probe = one_side_probe(condition, one_alias="customers", other_alias="orders", relation="t",
                           label="orders → customers", view="customers")
    assert probe["sql"] is None
    with pytest.raises(ValueError, match="Không xác minh được"):
        verify_key_probes([probe], ds_type="postgresql", config={})


def test_a_one_to_one_is_probed_on_both_sides(db):
    from app.services.semantic_query_engine import SemanticQueryEngine

    _add(db, relationship="one_to_one")
    e = SemanticQueryEngine(db, database_type="postgresql")
    e.generate_sql(explore_name="orders", dimensions=["customers.region"], measures=[], filters={}, model_id=1)
    assert {p["view"] for p in e.key_probes} == {"customers", "orders"}


# ── write paths read keys the way the contract does ─────────────────────────


def test_normalization_keeps_a_composite_key_behind_a_scalar_shorthand():
    """Regeneration used to rewrite from_columns from the scalar shorthand, so
    the supported composite row became 'lists disagree with sql_on' — and
    every query on the model was refused after the next table edit."""
    from app.services.dataset_model_service import _normalize_join

    row = CASES["composite_sql_on_scalar_first_pair"]["join"]
    out = _normalize_join(row, "orders", None)
    c = read_join_contract("orders", out)
    assert c.valid and c.key_pairs == (("region_code", "region_code"), ("store_code", "store_code"))


def test_merge_sees_a_lookml_row_and_an_auto_row_as_the_same_relationship():
    """A user's inactive LookML-spelled row and a re-detected auto FK on the
    same key: the merge used to read the LookML row as keyless, keep both, and
    the active auto row undid the deactivation."""
    from app.services.dataset_model_service import _merge_join_definitions

    manual = {"view": "customers", "sql_on": "${orders.customer_id} = ${customers.id}",
              "cardinality": "many_to_one", "is_active": False, "origin": "manual"}
    auto = {"view": "customers", "from_column": "customer_id", "to_column": "id",
            "from_columns": ["customer_id"], "to_columns": ["id"], "cardinality": "many_to_one",
            "sql_on": "${TABLE}.customer_id = ${customers}.id", "origin": "auto_fk"}
    assert _merge_join_definitions([manual], [auto], "orders") == [manual]


def test_the_distinct_cascade_refuses_a_model_with_an_invalid_relationship(db):
    """Tiles refuse such a model; the slicer cascade used to leave the invalid
    edge out, drop a lock routed through it, and list out-of-scope values."""
    from app.models.models import DataSource
    from app.services.dataset_model_service import get_distinct_field_values

    DataSource.__table__.create(db.get_bind())
    db.add(DataSource(id=1, name="pg", type="postgresql", config={}))
    for tid in (11, 12, 13):
        db.get(DatasetTable, tid).datasource_id = 1
    e = db.get(SemanticExplore, 1)
    e.joins = [CASES["unknown_cardinality"]["join"]]
    db.commit()
    with pytest.raises(ValueError, match="không hợp lệ"):
        get_distinct_field_values(db, 1, "orders.id",
                                  filters=[{"field": "customers.region", "operator": "eq", "value": "N"}])


def test_the_workboard_access_audit_walks_only_relationships_the_runtime_walks():
    from app.modules.workboards.services.access_mode_service import _build_relationship_graph

    views = {"orders": types.SimpleNamespace(id=1), "customers": types.SimpleNamespace(id=2)}
    tables = {1: types.SimpleNamespace(id=101), 2: types.SimpleNamespace(id=102)}
    for join, walks in [
        ({"view": "customers", "sql_on": "${orders.customer_id} = ${customers.id}", "cardinality": "many_to_one"},
         True),
        ({**CASES["string_false"]["join"]}, False),
        ({**CASES["unknown_cardinality"]["join"]}, False),
    ]:
        g = _build_relationship_graph([types.SimpleNamespace(base_view_name="orders", joins=[join])], views, tables)
        assert bool(g.get(101)) is walks, join


def test_a_template_bundle_with_an_invalid_relationship_is_not_stored(db):
    from app.modules.workboards.services.template_service import _rebuild_semantic_from_bundle

    db.add(Dataset(id=2, name="imported", owner_id=OWNER))
    db.add(DatasetTable(id=21, dataset_id=2, display_name="o2", source_table_name="o2", columns_cache=[]))
    db.commit()
    bundle = {
        "views": [{"old_table_id": 11, "name": "o2", "dimensions": [], "measures": []}],
        "explores": [{"base_view_old_table_id": 11, "base_view_name": "o2",
                      "joins": [{"view": "x", "from_column": "a", "to_column": "b", "cardinality": "bogus"}]}],
    }
    with pytest.raises(ValueError, match="không hợp lệ"):
        _rebuild_semantic_from_bundle(db, 2, {11: 21}, bundle)


# ── the direct /semantic API writes exactly what the reader accepts ─────────


def _direct(db, joins, stored=None):
    from app.services.dataset_model_service import validate_direct_explore_joins

    return validate_direct_explore_joins(db, 1, "orders", joins, stored_joins=stored)


def _dj(**kw):
    j = {"name": "customers", "view": "customers", "type": "left", "sql_on": "", "relationship": "many_to_one",
         "from_column": "customer_id", "to_column": "id", "is_active": True, "cross_filter": "single"}
    j.update(kw)
    return j


@pytest.mark.parametrize("bad", [
    {"from_view": "customers", "view": "orders", "from_column": "id", "to_column": "id"},  # another explore's row
    {"from_column": None, "to_column": None, "sql_on": "${TABLE}.customer_id = ${calendar}.date"},  # third table
])
def test_the_direct_api_refuses_a_row_the_reader_would_refuse(db, bad):
    """Pre-fix the direct API stored these; every query on the model was then
    refused (or, before the contract, the row was read as a guess)."""
    with pytest.raises(ValueError):
        _direct(db, [_dj(**bad)])


def test_the_direct_api_refuses_the_same_relationship_twice(db):
    with pytest.raises(ValueError, match="hai lần"):
        _direct(db, [_dj(), _dj(name="dup")])


def test_a_direct_api_round_trip_keeps_provenance_and_marks_an_edited_auto_row(db):
    stored = [_dj(origin="auto_fk", managed=True, cardinality="many_to_one")]
    # The client echoes the row without the server-owned fields, deactivated.
    (out,) = _direct(db, [_dj(is_active=False, origin=None, managed=None, user_edited=None)], stored=stored)
    assert out["origin"] == "auto_fk" and out["managed"] is True and out["user_edited"] is True
    (same,) = _direct(db, [_dj(origin="manual")], stored=stored)  # unchanged semantics
    assert same["origin"] == "auto_fk" and "user_edited" not in same


# ── regeneration, edits and the graph after every transition ────────────────


@pytest.fixture()
def gen_db():
    """A dataset whose model is GENERATED (auto FK join orders → customers)."""
    from app.models.models import DataSource
    from app.services.dataset_model_service import generate_dataset_model

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, Chart.__table__, DataSource.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="d", owner_id=OWNER))
        for tid, name, cols in [
            (11, "orders", [("id", "integer"), ("customer_id", "integer"), ("ship_key", "integer"),
                            ("order_key", "integer"), ("amount", "numeric")]),
            (12, "customers", [("id", "integer"), ("alt_id", "integer"), ("region", "string")]),
            (13, "periods", [("pkey", "integer"), ("year", "integer")]),
        ]:
            s.add(DatasetTable(id=tid, dataset_id=1, display_name=name, source_table_name=name,
                               columns_cache=[{"name": c, "type": t} for c, t in cols]))
        s.commit()
        generate_dataset_model(s, 1)
        s.commit()
        yield s


V_ORD, V_CUS, V_PER = "dataset_table_11", "dataset_table_12", "dataset_table_13"


def _graph_matches_persisted(db):
    """After a reload, every valid active row is exactly one forward edge with
    its full key; a 'both' row also walks backwards; nothing else is in the
    graph; nothing persisted is invalid."""
    db.expire_all()
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == 1).one()
    expected_fwd, expected_rev = set(), set()
    for e in model.explores:
        for j in e.joins or []:
            c = read_join_contract(e.base_view_name, j)
            assert c.valid, (j, c.invalid)
            if c.is_active:
                expected_fwd.add((e.base_view_name, c.node, c.cardinality, tuple(c.key_pairs)))
                if c.cross_filter == "both":
                    expected_rev.add((c.node, e.base_view_name, tuple((t, f) for f, t in c.key_pairs)))
    got_fwd, got_rev = set(), set()
    for base in {e.base_view_name for e in model.explores}:
        r = SemanticJoinResolver(db, model, base, bidirectional=False)
        assert r.invalid_joins == []
        for edges in r._adj.values():
            for edge in edges:
                if edge.is_reverse:
                    got_rev.add((edge.from_node, edge.to_node, tuple(edge.key_pairs)))
                else:
                    got_fwd.add((edge.from_node, edge.to_node, edge.cardinality, tuple(edge.key_pairs)))
    assert got_fwd == expected_fwd
    assert got_rev == expected_rev
    return model


def _ids(db):
    return {v.name: v.id for v in db.query(SemanticView).all()}


def _gadd(db, frm, to, fc, tc, **kw):
    from app.services.dataset_model_service import add_join

    ids = _ids(db)
    return add_join(db, dataset_id=1, from_view_id=ids[frm], to_view_id=ids[to], from_column=fc, to_column=tc,
                    relationship=kw.pop("relationship", "many_to_one"), **kw)


def _rows(db, base=V_ORD):
    db.expire_all()
    e = db.query(SemanticExplore).filter(SemanticExplore.base_view_name == base).one()
    return list(e.joins or [])


def test_state_transitions_keep_persisted_json_and_runtime_graph_identical(gen_db):
    from app.services.dataset_model_service import (
        generate_dataset_model, remove_join, sync_dataset_model_structure,
    )

    db = gen_db
    # create (generated)
    (auto,) = _rows(db)
    assert auto["origin"] == "auto_fk" and read_join_contract(V_ORD, auto).key_pairs == (("customer_id", "id"),)
    _graph_matches_persisted(db)

    # edit cardinality — same identity: provenance kept, marked as a user edit
    _gadd(db, V_ORD, V_CUS, "customer_id", "id", relationship="one_to_one")
    (row,) = _rows(db)
    assert (row["origin"], row["user_edited"], read_join_contract(V_ORD, row).cardinality) == (
        "auto_fk", True, "one_to_one")
    _graph_matches_persisted(db)

    # deactivate / activate / cross filter
    _gadd(db, V_ORD, V_CUS, "customer_id", "id", relationship="one_to_one", is_active=False)
    (row,) = _rows(db)
    assert read_join_contract(V_ORD, row).is_active is False
    _graph_matches_persisted(db)
    _gadd(db, V_ORD, V_CUS, "customer_id", "id", relationship="one_to_one", is_active=True, cross_filter="both")
    _graph_matches_persisted(db)

    # regenerate: the user's edit wins over re-detection
    generate_dataset_model(db, 1)
    db.commit()
    (row,) = _rows(db)
    assert (read_join_contract(V_ORD, row).cardinality, row["cross_filter"]) == ("one_to_one", "both")
    _graph_matches_persisted(db)

    # edit keys (identity change) — the auto row is replaced AND tombstoned
    _gadd(db, V_ORD, V_CUS, "customer_id", "alt_id",
          replaces={"from_view": V_ORD, "view": V_CUS, "alias": None,
                    "from_columns": ["customer_id"], "to_columns": ["id"]})
    (row,) = _rows(db)
    assert read_join_contract(V_ORD, row).key_pairs == (("customer_id", "alt_id"),) and row["origin"] == "manual"
    generate_dataset_model(db, 1)
    db.commit()
    assert [read_join_contract(V_ORD, j).key_pairs for j in _rows(db)] == [(("customer_id", "alt_id"),)], \
        "regeneration must not re-create the auto join the edit replaced"
    _graph_matches_persisted(db)

    # alias add x2 (role-playing) / alias remove
    _gadd(db, V_ORD, V_PER, "ship_key", "pkey", alias="ship_period")
    _gadd(db, V_ORD, V_PER, "order_key", "pkey", alias="order_period")
    assert {j.get("alias") for j in _rows(db)} == {None, "ship_period", "order_period"}
    _graph_matches_persisted(db)
    remove_join(db, 1, _ids(db)[V_ORD], V_PER, from_columns=["ship_key"], to_columns=["pkey"],
                alias="ship_period", alias_given=True)
    assert {j.get("alias") for j in _rows(db)} == {None, "order_period"}
    _graph_matches_persisted(db)

    # PK change rides on the same transaction as its relationship
    _gadd(db, V_ORD, V_PER, "order_key", "pkey", alias="order_period", primary_key_on_to_view=["pkey"])
    assert db.get(SemanticView, _ids(db)[V_PER]).primary_key == ["pkey"]
    _graph_matches_persisted(db)

    # remove the manual relationship
    remove_join(db, 1, _ids(db)[V_ORD], V_CUS, from_columns=["customer_id"], to_columns=["alt_id"])
    assert [j.get("alias") for j in _rows(db)] == ["order_period"]

    # schema drift: a key column disappears -> the relationship is kept (shown,
    # fixable) rather than silently deleted; the structure resync never re-detects.
    t = db.get(DatasetTable, 11)
    t.columns_cache = [c for c in t.columns_cache if c["name"] != "order_key"]
    db.commit()
    sync_dataset_model_structure(db, 1)
    db.commit()
    assert [j.get("alias") for j in _rows(db)] == ["order_period"]

    # restart / reload: a brand-new session reads the same graph
    with Session(db.get_bind()) as fresh:
        _graph_matches_persisted(fresh)


def test_regeneration_does_not_resurrect_a_removed_auto_join(gen_db):
    from app.services.dataset_model_service import generate_dataset_model, remove_join

    db = gen_db
    remove_join(db, 1, _ids(db)[V_ORD], V_CUS, from_columns=["customer_id"], to_columns=["id"])
    generate_dataset_model(db, 1)
    db.commit()
    assert _rows(db) == []


def test_regeneration_keeps_a_manual_join_redrawn_after_removing_the_auto_one(gen_db):
    from app.services.dataset_model_service import generate_dataset_model, remove_join

    db = gen_db
    remove_join(db, 1, _ids(db)[V_ORD], V_CUS, from_columns=["customer_id"], to_columns=["id"])
    _gadd(db, V_ORD, V_CUS, "customer_id", "id", is_active=False)
    generate_dataset_model(db, 1)
    db.commit()
    (row,) = _rows(db)
    assert row["origin"] == "manual" and read_join_contract(V_ORD, row).is_active is False
