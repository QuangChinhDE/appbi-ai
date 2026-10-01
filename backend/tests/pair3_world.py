"""Pair #3 — the Pair #2 topologies as REAL chart worlds for ChartService.

A world is what a DA builds: a datasource (the test Postgres / MySQL, schema
`p2g` from tests/pair2_topology.py), a dataset, one dataset table per physical
view, the semantic views bound to those tables, ONE model with the topology's
explores, and saved charts. Everything lives in one rolled-back transaction.

A Pair #2 request ({dims, measures, filters, sorts, top_n, limit, time_grains})
becomes the chart config a DA saves: a TABLE chart whose selectedColumns are
the dims + measures and whose metrics are the measures (agg "auto"), the
filters as runtime filters, Top-N as styleConfig.dataLimit, time grains in
roleConfig.timeGrains. The answer is compared with the Pair #2 oracle — never
with ChartService's own output.
"""
from __future__ import annotations

import contextlib
import types
import uuid

from sqlalchemy.orm import Session

from tests import pair2_topology as T

_CC_TYPE = {"int": "integer", "text": "string", "date": "date", "timestamp": "timestamp"}


def _columns_cache(table: str) -> dict:
    cols, _rows = T.TABLES[table]
    return {"columns": [{"name": c, "type": _CC_TYPE[t], "nullable": True} for c, t in cols],
            "source_columns": [c for c, _t in cols]}


def _views_of(model_key: str) -> set:
    """The topology's views plus every ordinary view (as the Pair #2 world has
    them all: a request may name a view the model does not relate); the bulk
    lattice / chain / shared-dim copies only where the topology uses them."""
    used = {v for v in T.VIEWS if not v.startswith(("p2_lat_", "p2_pd_", "p2_ch_"))}
    for base, joins in T.MODELS[model_key].items():
        used.add(base)
        for j in joins:
            used.add(j["view"])
    return used


@contextlib.contextmanager
def chart_world(engine, model_key: str, *, ds_type: str = "postgresql", ds_config: dict | None = None,
                dialect: str = "postgresql"):
    """One topology as a dataset + model + its tables, in a rolled-back
    transaction. `ds_config` is the datasource connection (plain values)."""
    from app.core.crypto import encrypt_config
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        tag = uuid.uuid4().hex[:8]
        ds = DataSource(name=f"p3_{model_key}_{tag}", type=DataSourceType(ds_type),
                        config=encrypt_config(dict(ds_config or {})))
        db.add(ds)
        settings = ({"calendar_dimension": {"timezone": "Asia/Ho_Chi_Minh"}} if model_key.startswith("TZ_") else None)
        dataset = Dataset(name=f"p3_{model_key}_{tag}", settings=settings)
        db.add(dataset)
        db.flush()
        tables, views = {}, {}
        for vname in sorted(_views_of(model_key)):
            spec, dims, measures = T.VIEWS[vname]
            if spec.startswith("T:"):
                table = spec.split(":", 1)[1]
                if dialect == "bigquery":
                    # nothing is read from or written to the warehouse: the rows are inline
                    inline = T.view_relation(spec, dialect)
                    dt = DatasetTable(dataset_id=dataset.id, datasource_id=ds.id, source_kind="sql_query",
                                      source_query=inline[1:-1], display_name=vname,
                                      columns_cache=_columns_cache(table), enabled=True)
                    relation = inline
                else:
                    dt = DatasetTable(dataset_id=dataset.id, datasource_id=ds.id, source_kind="physical_table",
                                      source_table_name=f"{T.S}.{table}", display_name=vname,
                                      columns_cache=_columns_cache(table), enabled=True)
                    relation = f"{T.S}.{table}"
                db.add(dt)
                db.flush()
                tables[vname] = dt
                v = SemanticView(name=vname, dataset_table_id=dt.id, sql_table_name=relation,
                                 dimensions=dims, measures=measures)
            else:  # the generated calendar / a nested-CTE source: a relation of its own
                v = SemanticView(name=vname, dataset_table_id=None, sql_table_name=T.view_relation(spec, dialect),
                                 dimensions=dims, measures=measures)
            db.add(v)
            views[vname] = v
        db.flush()
        model = SemanticModel(name=f"p3_{model_key}_{tag}", dataset_id=dataset.id)
        db.add(model)
        db.flush()
        for base, joins in T.MODELS[model_key].items():
            db.add(SemanticExplore(name=base, model_id=model.id, base_view_id=views[base].id,
                                   base_view_name=base, joins=list(joins)))
        db.flush()
        yield types.SimpleNamespace(db=db, conn=conn, ds=ds, dataset=dataset, tables=tables, views=views,
                                    model=model, model_key=model_key, dialect=dialect)
    finally:
        db.close()
        outer.rollback()
        conn.close()


def runtime_filters(req: dict) -> list:
    """Pair #2 engine filters → the runtime filter list a dashboard sends."""
    out = []
    for ref, preds in (req.get("filters") or {}).items():
        for p in (preds if isinstance(preds, list) else [preds]):
            f = {"field": ref, "semanticField": ref, "operator": p.get("operator"), "value": p.get("value")}
            for k in ("calendarField", "calendarSourceField", "_authoritative"):
                if k in p:
                    f[k] = p[k]
            out.append(f)
    return out


def chart_config(req: dict, *, binding: dict | None = None) -> dict:
    """Pair #2 request → the saved chart config (TABLE, selectedColumns)."""
    dims = list(req.get("dims") or [])
    measures = list(req.get("measures") or [])
    role = {"selectedColumns": dims + measures, "metrics": [{"field": m, "agg": "auto"} for m in measures]}
    if req.get("time_grains"):
        role["timeGrains"] = dict(req["time_grains"])
    cfg: dict = {"roleConfig": role}
    style: dict = {}
    if req.get("top_n"):
        style = {"dataLimit": int(req["top_n"]["n"]), "dataLimitDirection": "top"}
    elif req.get("sorts") and req.get("limit"):
        s = req["sorts"][0]
        style = {"dataLimit": int(req["limit"]),
                 "dataLimitDirection": "bottom" if str(s.get("direction")).lower() == "asc" else "top"}
    if style:
        cfg["styleConfig"] = style
    if binding is not None:
        cfg["semanticBinding"] = binding
    return cfg


def save_chart(world, base: str, req: dict, *, chart_type: str = "TABLE", config: dict | None = None):
    from app.models.models import Chart, ChartType

    c = Chart(name=f"p3 {base} {uuid.uuid4().hex[:8]}", dataset_table_id=world.tables[base].id,
              chart_type=ChartType(chart_type), config=config if config is not None else chart_config(req))
    world.db.add(c)
    world.db.flush()
    return c
