#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Dataset lifecycle fixtures for `e2e/tests/dataset-lifecycle*.spec.ts`.

A REAL, MUTABLE SOURCE. Schema `e2e_dslife` of the E2E database, read through an
ordinary PostgreSQL datasource. The journeys change its rows / schema with plain
SQL (the e2e `pg` client) and then drive the product, so every assertion is about
what the product did with a real source change.

A REAL SNAPSHOT HOST — ONLY WHEN ONE EXISTS. Sync & Publish materializes into
BigQuery; nothing else can host a snapshot. When the process environment carries
the sandbox write credential (MATERIALIZATION_SA_CREDENTIALS_JSON) and a
disposable dataset name (MATERIALIZATION_DATASET), an admin-owned BigQuery host
datasource is registered for it. Without them no host is created and the
publish journeys skip themselves BY NAME (CI has no BigQuery). The credential is
read from the environment and stored encrypted; it is never printed.

DETERMINISTIC + IDEMPOTENT (looked up by name; resets the source rows). Prints
the ids as JSON.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import sqlalchemy as sa  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.crypto import encrypt_config  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.dataset import Dataset, DatasetTable  # noqa: E402
from app.models.models import Chart, Dashboard, DashboardChart, DataSource, DataSourceType  # noqa: E402
from app.models.semantic import SemanticView  # noqa: E402
from app.models.user import User  # noqa: E402
from app.schemas.dataset import DatasetCreate, TableCreate  # noqa: E402
from app.schemas.schemas import ChartCreate  # noqa: E402
from app.services.chart_service import ChartService  # noqa: E402
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import add_join, generate_dataset_model  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
SCHEMA = "e2e_dslife"
SOURCE = "E2E dataset-lifecycle Postgres"
HOST = "E2E sandbox snapshot host"
DATASET = "E2E lifecycle sales"
CHART = "E2E lifecycle revenue by region"

ORDERS = [{"name": "id", "type": "integer"}, {"name": "customer_id", "type": "integer"},
          {"name": "region", "type": "string"}, {"name": "amount", "type": "integer"}]
CUSTOMERS = [{"name": "id", "type": "integer"}, {"name": "name", "type": "string"}]


def reset_source(engine) -> None:
    """The canonical source state every journey starts from (North 30, South 30)."""
    with engine.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.orders"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.customers"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.products"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.customers (id int, name text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.customers VALUES (1, 'An'), (2, 'Binh')"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders (id int, customer_id int, region text, amount int)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders VALUES (1, 1, 'North', 10), (2, 1, 'North', 20), "
                          f"(3, 2, 'South', 30)"))
        # Authoring journey source (never mutated by the publish journeys).
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.products (sku text, price int, qty int, category text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.products VALUES ('A', 5, 2, 'toys'), ('B', 7, 3, 'books'), "
                          f"('C', 11, 1, 'toys')"))


def _source(db) -> DataSource:
    ds = db.query(DataSource).filter(DataSource.name == SOURCE).first()
    if ds is not None:
        return ds
    url = sa.engine.make_url(settings.DATABASE_URL)
    ds = DataSource(name=SOURCE, type=DataSourceType("postgresql"), config=encrypt_config({
        "host": url.host, "port": url.port or 5432, "database": url.database,
        "username": url.username, "password": url.password, "schema_name": SCHEMA}))
    db.add(ds)
    db.flush()
    return ds


def _host(db, user) -> DataSource | None:
    cred = os.environ.get("MATERIALIZATION_SA_CREDENTIALS_JSON", "").strip()
    dataset = os.environ.get("MATERIALIZATION_DATASET", "").strip()
    if not cred or not dataset.startswith("appbi_e2e_"):
        return None  # only ever a DISPOSABLE dataset — never a shared one
    ds = db.query(DataSource).filter(DataSource.name == HOST).first()
    if ds is not None:
        return ds
    project = json.loads(cred).get("project_id")
    ds = DataSource(name=HOST, type=DataSourceType("bigquery"), owner_id=user.id, config=encrypt_config({
        "project_id": project, "auth_mode": "service_account", "credentials_json": cred,
        "materialization_enabled": True, "materialization_dataset": dataset}))
    db.add(ds)
    db.flush()
    return ds


def _table(db, dataset_id: int, ds: DataSource, name: str, columns: list) -> DatasetTable:
    t = DatasetCRUDService.add_table_to_dataset(db, dataset_id, TableCreate(
        datasource_id=ds.id, source_kind="physical_table", source_table_name=f"{SCHEMA}.{name}",
        display_name=name))
    DatasetCRUDService.update_table_cache(db, t.id, columns_cache={
        "columns": [dict(c) for c in columns], "source_columns": [c["name"] for c in columns]})
    return t


def _lifecycle_dataset(db, user, ds: DataSource) -> dict:
    found = db.query(Dataset).filter(Dataset.name == DATASET).first()
    if found is None:
        found = DatasetCRUDService.create_dataset(db, DatasetCreate(name=DATASET), owner_id=user.id)
        orders = _table(db, found.id, ds, "orders", ORDERS)
        customers = _table(db, found.id, ds, "customers", CUSTOMERS)
        generate_dataset_model(db, int(found.id), force=False)
        views = {v.dataset_table_id: v for v in db.query(SemanticView).filter(
            SemanticView.dataset_table_id.in_([orders.id, customers.id])).all()}
        add_join(db, int(found.id), views[orders.id].id, views[customers.id].id,
                 from_column="customer_id", to_column="id", relationship="many_to_one")
        found.publish_state = "draft"  # enters the publish lifecycle
        db.commit()
    tables = {t.display_name: t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == found.id)}
    chart = db.query(Chart).filter(Chart.name == CHART).first()
    if chart is None:
        role = {"metrics": [{"field": "amount", "agg": "sum"}], "dimension": "region"}
        chart = ChartService.create(db, ChartCreate(
            name=CHART, chart_type="TABLE", dataset_table_id=tables["orders"],
            config={"chartType": "TABLE", "queryMode": "generated", "roleConfig": role,
                    "generatedRoleConfig": role, "customRoleConfig": {"metrics": []},
                    "filters": [], "baseFilters": [], "styleConfig": {"chartTitle": CHART}},
        ), owner_id=user.id)
        dash = Dashboard(name=f"{CHART} board", owner_id=user.id, pages_config=[{"id": "p1", "name": "Sales"}],
                         slicers_config=[], filters_config=[])
        db.add(dash)
        db.flush()
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                              layout={"x": 0, "y": 0, "w": 24, "h": 10, "gv": 2, "pageId": "p1"}))
        db.commit()
    dash_id = db.query(DashboardChart.dashboard_id).filter(DashboardChart.chart_id == chart.id).scalar()
    return {"dataset_id": int(found.id), "tables": tables, "chart_id": int(chart.id), "dashboard_id": int(dash_id)}


def main() -> None:
    engine = sa.create_engine(settings.DATABASE_URL)
    reset_source(engine)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            raise SystemExit(f"E2E user {EMAIL} missing — run seed_e2e_user.py first")
        ds = _source(db)
        host = _host(db, user)
        db.commit()
        out = {"source_id": int(ds.id), "host_id": int(host.id) if host else None,
               "lifecycle": _lifecycle_dataset(db, user, ds)}
        print(json.dumps(out))
    finally:
        db.close()
        engine.dispose()


if __name__ == "__main__":
    main()
