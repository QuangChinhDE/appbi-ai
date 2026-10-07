#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Chart final-hardening fixture for `e2e/tests/chart-hardening.spec.ts`. CI only.

WHAT IT PROTECTS. The Chart Builder's semantic base ("bảng gốc") lifecycle and
its refusal UX, on a model where ONE pair of fields has two meanings:

    bc_pfm ──pfm_date──▶ Date            (the sale's own date)
    bc_pfm ──owner_id──▶ bc_owner ──hire_date──▶ Date   (the owner's hire date)

Revenue by Date month therefore has TWO answers (150/7 by sale date, 100/57 by
the owner's hire month); the engine must REFUSE it (AMBIGUOUS_ROUTE) and the UI
must say so in business terms. `bc_activity` reaches Date only through the owner
(one meaning: calls by hire month Ann 2024-01 = 8, Bob 2024-02 = 4) and is added
FIRST, so it is the first view of the model — the view an auto-seed used to
commit as the base without the user ever touching it.

Also: a saved, unambiguous chart (revenue by owner: Ann 100, Bob 57) on a
dashboard with a public link, shared VIEW-only with a password reader — the
debug/SQL disclosure journey reads it as owner, reader and anonymous.

A REAL SOURCE (a schema of the CI database through an ordinary PostgreSQL
datasource), product services for datasets/charts, DETERMINISTIC and IDEMPOTENT.
Writes the ids to e2e/.auth/chart_hardening.json.
"""
from __future__ import annotations

import json
import os
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import sqlalchemy as sa  # noqa: E402

from app.api.auth import hash_password  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.crypto import encrypt_config  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.dataset import Dataset, DatasetGrant, DatasetTable  # noqa: E402
from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink, DataSource, DataSourceType  # noqa: E402
from app.models.resource_share import ResourceShare, ResourceType, SharePermission  # noqa: E402
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView  # noqa: E402
from app.models.user import User, UserStatus  # noqa: E402
from app.schemas.dataset import DatasetCreate, TableCreate  # noqa: E402
from app.schemas.schemas import ChartCreate  # noqa: E402
from app.services.chart_service import ChartService  # noqa: E402
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import generate_dataset_model  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
READER_EMAIL = "chart-reader@example.com"
READER_PASSWORD = os.environ.get("E2E_PASSWORD", "123456")
SCHEMA = "e2e_chart"
DATASOURCE = "E2E chart-hardening Postgres"
DATASET = "E2E chart hardening"
SAVED_CHART = "E2E CH revenue by owner"
LINK_TOKEN = "e2e-chart-hardening"

# (display name, table, columns) — ADD ORDER IS THE CONTRACT: bc_activity first.
TABLES = [
    ("bc_activity", "activity", [("id", "integer"), ("act_date", "date"), ("owner_id", "integer"),
                                 ("channel", "string"), ("calls", "integer")]),
    ("bc_pfm", "pfm", [("id", "integer"), ("pfm_date", "date"), ("owner_id", "integer"),
                       ("product", "string"), ("revenue", "integer")]),
    ("bc_owner", "owner", [("id", "integer"), ("owner_name", "string"), ("hire_date", "date")]),
    ("Date", "cal", [("d", "date"), ("month_label", "string")]),
]
DDL = [
    f"CREATE TABLE {SCHEMA}.activity (id int, act_date date, owner_id int, channel text, calls int)",
    f"INSERT INTO {SCHEMA}.activity VALUES (1,'2024-03-01',1,'Phone',3),(2,'2024-03-01',2,'Email',4),"
    "(3,'2024-02-05',1,'Phone',5)",
    f"CREATE TABLE {SCHEMA}.pfm (id int, pfm_date date, owner_id int, product text, revenue int)",
    f"INSERT INTO {SCHEMA}.pfm VALUES (1,'2024-03-01',1,'Pen',100),(2,'2024-03-01',2,'Ink',50),"
    "(3,'2024-01-10',2,'Ink',7)",
    f"CREATE TABLE {SCHEMA}.owner (id int, owner_name text, hire_date date)",
    f"INSERT INTO {SCHEMA}.owner VALUES (1,'Ann','2024-01-10'),(2,'Bob','2024-02-05')",
    f"CREATE TABLE {SCHEMA}.cal (d date, month_label text)",
    f"INSERT INTO {SCHEMA}.cal VALUES ('2024-01-10','2024-01'),('2024-02-05','2024-02'),('2024-03-01','2024-03')",
]


def _rel(view: str, fc: str, tc: str) -> dict:
    return {"name": view, "view": view, "type": "left", "from_column": fc, "to_column": tc,
            "sql_on": f"${{TABLE}}.{fc} = ${{{view}}}.{tc}", "relationship": "many_to_one",
            "cardinality": "many_to_one", "is_active": True, "cross_filter": "single"}


def _source() -> None:
    eng = sa.create_engine(settings.DATABASE_URL)
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        for t in ("activity", "pfm", "owner", "cal"):
            c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.{t}"))
        for s in DDL:
            c.execute(sa.text(s))
    eng.dispose()


def _datasource(db) -> DataSource:
    ds = db.query(DataSource).filter(DataSource.name == DATASOURCE).first()
    if ds is not None:
        return ds
    url = sa.engine.make_url(settings.DATABASE_URL)
    ds = DataSource(name=DATASOURCE, type=DataSourceType("postgresql"), config=encrypt_config({
        "host": url.host, "port": url.port or 5432, "database": url.database,
        "username": url.username, "password": url.password, "schema_name": SCHEMA}))
    db.add(ds)
    db.flush()
    return ds


def _dataset(db, user, ds) -> tuple[Dataset, dict[str, DatasetTable], dict[str, str]]:
    dataset = db.query(Dataset).filter(Dataset.name == DATASET).first()
    if dataset is None:
        dataset = DatasetCRUDService.create_dataset(db, DatasetCreate(name=DATASET), owner_id=user.id)
        for display, table, cols in TABLES:
            t = DatasetCRUDService.add_table_to_dataset(db, dataset.id, TableCreate(
                datasource_id=ds.id, source_kind="physical_table",
                source_table_name=f"{SCHEMA}.{table}", display_name=display))
            db.flush()
            DatasetCRUDService.update_table_cache(db, t.id, columns_cache={
                "columns": [{"name": n, "type": ty} for n, ty in cols],
                "source_columns": [n for n, _ in cols]})
        generate_dataset_model(db, int(dataset.id), force=False)
        db.flush()
    tables = {t.display_name: t for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset.id)}
    views = {}
    for name, t in tables.items():
        v = db.query(SemanticView).filter(SemanticView.dataset_table_id == t.id).first()
        assert v is not None, f"no semantic view for {name}"
        views[name] = v.name
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset.id).first()
    assert model is not None, "generate_dataset_model made no model"
    # The relationships, written the way the Data Model editor stores them: one
    # explore per base, the graph model-wide.
    joins = {
        "bc_activity": [_rel(views["bc_owner"], "owner_id", "id")],
        "bc_pfm": [_rel(views["Date"], "pfm_date", "d"), _rel(views["bc_owner"], "owner_id", "id")],
        "bc_owner": [_rel(views["Date"], "hire_date", "d")],
        "Date": [],
    }
    for display, js in joins.items():
        vname = views[display]
        ex = db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id,
                                              SemanticExplore.base_view_name == vname).first()
        if ex is None:
            view_id = db.query(SemanticView).filter(SemanticView.name == vname).first().id
            ex = SemanticExplore(name=vname, model_id=model.id, base_view_id=view_id, base_view_name=vname)
            db.add(ex)
        ex.joins = js
    db.flush()
    return dataset, tables, views


def _reader(db) -> User:
    u = db.query(User).filter(User.email == READER_EMAIL).first()
    levels = {k: "none" for k in ("data_sources", "workboards", "govern", "agent_flows", "chat",
                                  "observability", "settings")}
    levels.update(datasets="view", explore_charts="view", dashboards="view")
    if u is None:
        u = User(id=uuid.uuid4(), email=READER_EMAIL, full_name="chart reader", status=UserStatus.ACTIVE)
        db.add(u)
    u.permissions = levels
    u.password_hash = hash_password(READER_PASSWORD)
    u.auth_provider = "password"
    db.flush()
    return u


def _share(db, owner, reader, rtype, rid, perm=SharePermission.VIEW) -> None:
    if db.query(ResourceShare).filter(ResourceShare.resource_type == rtype, ResourceShare.resource_id == str(rid),
                                      ResourceShare.user_id == reader.id).first() is None:
        db.add(ResourceShare(resource_type=rtype, resource_id=str(rid), user_id=reader.id,
                             permission=perm, shared_by=owner.id))


def main() -> int:
    _source()
    db = SessionLocal()
    try:
        owner = db.query(User).filter(User.email == EMAIL).first()
        assert owner is not None, f"{EMAIL} missing — run seed_e2e_user.py first"
        ds = _datasource(db)
        dataset, tables, views = _dataset(db, owner, ds)
        reader = _reader(db)
        chart = db.query(Chart).filter(Chart.name == SAVED_CHART).first()
        if chart is None:
            role = {"dimension": f"{views['bc_owner']}.owner_name",
                    "metrics": [{"field": f"{views['bc_pfm']}.revenue", "agg": "sum"}]}
            chart = ChartService.create(db, ChartCreate(
                name=SAVED_CHART, chart_type="BAR", dataset_table_id=tables["bc_pfm"].id,
                config={"chartType": "BAR", "queryMode": "generated", "dataset_id": dataset.id,
                        "roleConfig": role, "generatedRoleConfig": role, "customRoleConfig": {"metrics": []},
                        "filters": [], "baseFilters": [], "styleConfig": {"chartTitle": SAVED_CHART}},
            ), owner_id=owner.id)
        link = db.query(DashboardPublicLink).filter(DashboardPublicLink.token == LINK_TOKEN).first()
        if link is None:
            dash = Dashboard(name="E2E chart hardening board", owner_id=owner.id,
                             pages_config=[{"id": "p1", "name": "Main"}], slicers_config=[], filters_config=[])
            db.add(dash)
            db.flush()
            db.add(DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                                  layout={"x": 0, "y": 0, "w": 24, "h": 10, "gv": 2, "pageId": "p1"}))
            link = DashboardPublicLink(dashboard_id=dash.id, name="E2E chart hardening", token=LINK_TOKEN,
                                       is_active=True, created_by=owner.id, filters_config=[],
                                       appearance_config={})
            db.add(link)
            db.flush()
        _share(db, owner, reader, ResourceType.CHART, chart.id)
        _share(db, owner, reader, ResourceType.DASHBOARD, link.dashboard_id)
        if db.query(DatasetGrant).filter(DatasetGrant.dataset_id == dataset.id,
                                         DatasetGrant.user_id == reader.id).first() is None:
            db.add(DatasetGrant(dataset_id=dataset.id, user_id=reader.id, verb="view", granted_by=owner.id))
        db.commit()
        out = {"dataset_id": int(dataset.id), "dataset_name": DATASET,
               "tables": {k: int(v.id) for k, v in tables.items()}, "views": views,
               "saved_chart_id": int(chart.id), "dashboard_id": int(link.dashboard_id), "link_token": LINK_TOKEN,
               "reader_email": READER_EMAIL}
        path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "e2e", ".auth", "chart_hardening.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        print(json.dumps(out))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
