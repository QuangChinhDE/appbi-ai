"""Error contracts of the semantic surface — asserted on behaviour, not source.

A refusal is only useful if it reaches the DA as a 400 with a message that
names what failed and where to fix it. This locks:

  * the engine's refusals are `ValueError`s (every endpoint maps those to 400),
    in Vietnamese, naming the field/view, with a remediation hint;
  * `GET /charts/{id}/data` turns a runtime ValueError into 400 with that
    message, and anything else into 500;
  * `POST /semantic/query` does the same, and logs the 500 path with the
    explore and dialect.

(Replaces the untracked `test_phase15_error_contracts.py`, which grepped
source text and had drifted: five of its checks no longer matched the code.)
"""
from __future__ import annotations

import re
import types
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_join_resolver import AmbiguousJoinPathError
from app.services.semantic_query_engine import SemanticQueryEngine


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


_VN = re.compile(r"[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]", re.I)


def _is_actionable_vn(msg: str, *names: str) -> None:
    assert _VN.search(msg), f"not Vietnamese: {msg}"
    for n in names:
        assert n in msg, f"does not name {n!r}: {msg}"


def _dim(name, typ="string"):
    return {"name": name, "type": typ, "sql": f"${{TABLE}}.{name}"}


def _j(view, fc, tc, card="many_to_one"):
    return {"name": view, "view": view, "type": "left", "sql_on": "", "from_column": fc,
            "to_column": tc, "relationship": card, "cardinality": card}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, DataSource.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        views = {
            "orders": ([_dim("id", "number"), _dim("customer_id", "number"), _dim("store_id", "number"),
                        _dim("status")], [
                {"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"},
                {"name": "revenue_all", "type": "sum", "sql": "${TABLE}.amount",
                 "context_modifiers": [{"type": "all"}]},
                {"name": "revenue_rx", "type": "sum", "sql": "${TABLE}.amount",
                 "filters": [{"field": "status", "operator": "sounds_like", "value": "x"}]},
            ]),
            "customers": ([_dim("id", "number"), _dim("region_id", "number")], []),
            "stores": ([_dim("id", "number"), _dim("region_id", "number")], []),
            "regions": ([_dim("id", "number"), _dim("name")], []),
            "lonely": ([_dim("id", "number"), _dim("tag")], []),
        }
        objs = {}
        for name, (dims, meas) in views.items():
            objs[name] = SemanticView(name=f"ec_{name}", sql_table_name=name, dimensions=dims, measures=meas)
            s.add(objs[name])
        s.add(SemanticModel(id=1, name="ec", dataset_id=None))
        s.flush()
        explores = {
            "orders": [_j("ec_customers", "customer_id", "id"), _j("ec_stores", "store_id", "id")],
            "customers": [_j("ec_regions", "region_id", "id")],
            "stores": [_j("ec_regions", "region_id", "id")],
            "lonely": [],
        }
        for name, joins in explores.items():
            s.add(SemanticExplore(name=f"ec_{name}", model_id=1, base_view_id=objs[name].id,
                                  base_view_name=f"ec_{name}", joins=joins))
        s.commit()
        yield s


def _gen(db, dims=(), measures=("ec_orders.revenue",), filters=None):
    return SemanticQueryEngine(db, database_type="bigquery").generate_sql(
        explore_name="ec_orders", dimensions=list(dims), measures=list(measures),
        filters=filters or {}, model_id=1,
    )


# ── the engine's refusals ────────────────────────────────────────────────────


def test_ambiguous_route_is_a_valueerror_that_names_both_routes_and_the_fix(db):
    with pytest.raises(AmbiguousJoinPathError) as exc:
        _gen(db, dims=["ec_regions.name"])
    assert isinstance(exc.value, ValueError)
    _is_actionable_vn(str(exc.value), "ec_regions", "ec_customers", "ec_stores", "Inactive")


def test_unsupported_context_modifier_names_the_measure_and_the_alternative(db):
    with pytest.raises(ValueError) as exc:
        _gen(db, measures=["ec_orders.revenue_all"])
    _is_actionable_vn(str(exc.value), "ec_orders.revenue_all", "Data Model")


def test_unknown_measure_filter_operator_names_field_and_operator(db):
    with pytest.raises(ValueError) as exc:
        _gen(db, measures=["ec_orders.revenue_rx"])
    _is_actionable_vn(str(exc.value), "status", "sounds_like", "Data Model")


def test_unknown_report_filter_operator_is_refused_with_its_name(db):
    with pytest.raises(ValueError) as exc:
        _gen(db, filters={"ec_orders.status": {"operator": "sounds_like", "value": "x"}})
    _is_actionable_vn(str(exc.value), "sounds_like")


def test_measure_filter_with_an_operator_aggregates_cannot_take(db):
    with pytest.raises(ValueError) as exc:
        _gen(db, filters={"ec_orders.revenue": {"operator": "contains", "value": "1"}})
    _is_actionable_vn(str(exc.value), "ec_orders.revenue", "contains")


def test_unreachable_view_points_at_the_data_model(db):
    with pytest.raises(ValueError) as exc:
        _gen(db, dims=["ec_lonely.tag"])
    _is_actionable_vn(str(exc.value), "ec_lonely")


# ── endpoints map ValueError → 400, everything else → 500 ───────────────────


def test_chart_data_endpoint_maps_valueerror_to_400_with_the_message(monkeypatch):
    from app.api import charts as api

    chart = types.SimpleNamespace(id=5, dataset_table_id=None)
    monkeypatch.setattr(api.ChartService, "get_by_id", lambda *_a, **_k: chart)
    monkeypatch.setattr(api, "get_effective_permission", lambda *_a, **_k: "view")

    def _raise(exc):
        def _f(*_a, **_k):
            raise exc
        return _f

    monkeypatch.setattr(api.ChartService, "get_chart_data",
                        _raise(AmbiguousJoinPathError("regions", ["a → regions", "b → regions"])))
    with pytest.raises(HTTPException) as e400:
        api.get_chart_data(5, None, None, None, None, db=None, current_user=None)
    assert e400.value.status_code == 400 and "regions" in str(e400.value.detail)

    monkeypatch.setattr(api.ChartService, "get_chart_data", _raise(RuntimeError("boom")))
    with pytest.raises(HTTPException) as e500:
        api.get_chart_data(5, None, None, None, None, db=None, current_user=None)
    assert e500.value.status_code == 500


def _anchored_query_world(db):
    """One readable explore whose base view is anchored to a datasource."""
    db.add(DataSource(id=1, name="ds", type="postgresql", config={}))
    db.add(Dataset(id=1, name="d", owner_id=uuid.UUID(int=1)))
    db.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="t", source_table_name="t"))
    v = db.query(SemanticView).filter_by(name="ec_orders").one()
    v.dataset_table_id = 11
    db.get(SemanticModel, 1).dataset_id = 1
    db.commit()
    return types.SimpleNamespace(id=uuid.UUID(int=1), email="o@x", permissions={"datasets": "edit"})


def test_semantic_query_maps_valueerror_to_400_and_logs_the_500_path(db, monkeypatch):
    from app.routers import semantic as api
    from app.schemas.semantic import SemanticQueryRequest

    owner = _anchored_query_world(db)
    req = SemanticQueryRequest(explore="ec_orders", dimensions=["ec_regions.name"], measures=["ec_orders.revenue"])
    with pytest.raises(HTTPException) as e400:
        api.execute_semantic_query(req, db, owner)  # the real engine refuses the diamond
    assert e400.value.status_code == 400 and "ec_regions" in str(e400.value.detail)

    logged = []
    monkeypatch.setattr(api.logger, "exception", lambda msg, *args: logged.append(msg % args))
    monkeypatch.setattr(api.SemanticQueryEngine, "run", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("x")))
    with pytest.raises(HTTPException) as e500:
        api.execute_semantic_query(req, db, owner)
    assert e500.value.status_code == 500
    assert logged and "ec_orders" in logged[0] and "postgresql" in logged[0]
