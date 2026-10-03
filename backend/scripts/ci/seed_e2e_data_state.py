#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Pair #5 data-state fixtures for `e2e/tests/data-state.spec.ts`. CI only.

WHAT IT PROTECTS. The user-visible data-state contracts browser testing found
broken (Pair #5 closure): a live result re-served from the cache says when it
was read; a dataset whose semantic model is invalid is never "healthy" in
Observability; a failed Sync & Publish says the last published data keeps
serving; a chart over a relation that cannot be built refuses with the cause.

A REAL SOURCE. The tables live in their own schema of the CI database, read
through an ordinary PostgreSQL datasource — the live path every non-snapshot
dataset takes (CI has no BigQuery snapshot host). Datasets, models and charts
are created through the same services the product uses.

DETERMINISTIC (fixed rows / names / tokens) and IDEMPOTENT (looked up by name
first; nothing it did not create is touched). Prints the ids it made as JSON.
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
from app.models.models import (  # noqa: E402
    Chart, Dashboard, DashboardChart, DashboardPublicLink, DataSource, DataSourceType,
)
from app.models.semantic import SemanticView  # noqa: E402
from app.models.user import User  # noqa: E402
from app.schemas.dataset import DatasetCreate, TableCreate  # noqa: E402
from app.schemas.schemas import ChartCreate  # noqa: E402
from app.services.chart_service import ChartService  # noqa: E402
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import generate_dataset_model  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
SCHEMA = "e2e_data_state"
DATASOURCE = "E2E data-state Postgres"
ROWS = "(1,'North',13,7), (2,'South',5,0), (3,'North',-5,2), (4,'South',NULL,2), (5,'North',1,3), (6,'South',9,4)"
COLUMNS = [{"name": "id", "type": "integer"}, {"name": "region", "type": "string"},
           {"name": "a", "type": "integer"}, {"name": "b", "type": "integer"},
           {"name": "ratio", "type": "float"}]
# A table whose cells exercise the CSV serializer's edge cases: a comma+quote, an
# embedded newline, a leading-'=' formula-injection payload, Unicode diacritics,
# a NULL. The e2e CSV download parses these from the REAL TypeScript exporter.
CSV_ROWS = (
    "(1, 'quote \"x\", comma', 'Áo thun'), "
    "(2, E'line1\\nline2', '=SUM(A1)'), "
    "(3, NULL, 'refund -50')"
)
CSV_COLUMNS = [{"name": "id", "type": "integer"}, {"name": "note", "type": "string"},
               {"name": "label", "type": "string"}]
RATIO = {"id": "e2e-ratio", "type": "add_column", "enabled": True,
         "params": {"newField": "ratio", "expression": "[a] / [b]", "formula": "[a] / [b]"}}


def _source_tables() -> None:
    eng = sa.create_engine(settings.DATABASE_URL)
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.orders"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.orders_nob"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders (id int, region text, a int, b int)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders VALUES {ROWS}"))
        # The same rows WITHOUT `b` — what a source looks like after an upstream
        # column drop the dataset's calculated column still needs.
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders_nob AS SELECT id, region, a FROM {SCHEMA}.orders"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.orders_csv"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders_csv (id int, note text, label text)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders_csv VALUES {CSV_ROWS}"))
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


def _dataset(db, user, ds, name: str, table: str) -> tuple[int, int]:
    found = db.query(Dataset).filter(Dataset.name == name).first()
    if found is not None:
        t = db.query(DatasetTable).filter(DatasetTable.dataset_id == found.id).first()
        return found.id, t.id
    dataset = DatasetCRUDService.create_dataset(db, DatasetCreate(name=name), owner_id=user.id)
    t = DatasetCRUDService.add_table_to_dataset(db, dataset.id, TableCreate(
        datasource_id=ds.id, source_kind="physical_table", source_table_name=f"{SCHEMA}.{table}",
        display_name="orders"))
    t.transformations = [dict(RATIO)]
    db.flush()
    DatasetCRUDService.update_table_cache(db, t.id, columns_cache={
        "columns": [dict(c) for c in COLUMNS],
        # as the preview writes it: the SOURCE columns next to the relation's output
        "source_columns": ["id", "region", "a"] + ([] if table == "orders_nob" else ["b"])})
    generate_dataset_model(db, int(dataset.id), force=False)
    return int(dataset.id), int(t.id)


def _chart_on_dashboard(db, user, table_id: int, name: str, token: str) -> int:
    chart = db.query(Chart).filter(Chart.name == name).first()
    if chart is None:
        role = {"metrics": [{"field": "ratio", "agg": "sum"}], "dimension": "region"}
        chart = ChartService.create(db, ChartCreate(
            name=name, chart_type="BAR", dataset_table_id=table_id,
            config={"chartType": "BAR", "queryMode": "generated", "roleConfig": role,
                    "generatedRoleConfig": role, "customRoleConfig": {"metrics": []},
                    "filters": [], "baseFilters": [], "styleConfig": {"chartTitle": name}},
        ), owner_id=user.id)
    if db.query(DashboardPublicLink).filter(DashboardPublicLink.token == token).first() is None:
        dash = Dashboard(name=f"{name} board", owner_id=user.id, pages_config=[{"id": "p1", "name": "Orders"}],
                         slicers_config=[], filters_config=[])
        db.add(dash)
        db.flush()
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                              layout={"x": 0, "y": 0, "w": 24, "h": 10, "gv": 2, "pageId": "p1"}))
        db.add(DashboardPublicLink(dashboard_id=dash.id, name=name, token=token, is_active=True,
                                   created_by=user.id, filters_config=[], appearance_config={}))
    return int(chart.id)


def _csv_table_link(db, user, ds) -> dict:
    """A TABLE chart over the special-char rows, on a public link whose default
    appearance allows data export — the durable CSV-download e2e opens this."""
    name = "E2E orders detail (csv)"
    token = "e2e-data-state-table"
    found = db.query(Dataset).filter(Dataset.name == name).first()
    if found is None:
        dataset = DatasetCRUDService.create_dataset(db, DatasetCreate(name=name), owner_id=user.id)
        t = DatasetCRUDService.add_table_to_dataset(db, dataset.id, TableCreate(
            datasource_id=ds.id, source_kind="physical_table",
            source_table_name=f"{SCHEMA}.orders_csv", display_name="orders_csv"))
        db.flush()
        DatasetCRUDService.update_table_cache(db, t.id, columns_cache={
            "columns": [dict(c) for c in CSV_COLUMNS],
            "source_columns": ["id", "note", "label"]})
        generate_dataset_model(db, int(dataset.id), force=False)
        table_id = int(t.id)
    else:
        table_id = int(db.query(DatasetTable).filter(DatasetTable.dataset_id == found.id).first().id)
    chart = db.query(Chart).filter(Chart.name == name).first()
    if chart is None:
        role = {"selectedColumns": ["id", "note", "label"], "metrics": []}
        chart = ChartService.create(db, ChartCreate(
            name=name, chart_type="TABLE", dataset_table_id=table_id,
            config={"chartType": "TABLE", "queryMode": "generated", "roleConfig": role,
                    "generatedRoleConfig": role, "customRoleConfig": {"metrics": []},
                    "filters": [], "baseFilters": [], "styleConfig": {"chartTitle": name}},
        ), owner_id=user.id)
    if db.query(DashboardPublicLink).filter(DashboardPublicLink.token == token).first() is None:
        dash = Dashboard(name=f"{name} board", owner_id=user.id,
                         pages_config=[{"id": "p1", "name": "Detail"}], slicers_config=[], filters_config=[])
        db.add(dash); db.flush()
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                              layout={"x": 0, "y": 0, "w": 24, "h": 12, "gv": 2, "pageId": "p1"}))
        db.add(DashboardPublicLink(dashboard_id=dash.id, name=name, token=token, is_active=True,
                                   created_by=user.id, filters_config=[],
                                   appearance_config={"allow_data_export": True}))
    return {"dataset_id": table_id, "chart_id": int(chart.id), "token": token}


def main() -> int:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            print(f"seed_e2e_data_state: no user {EMAIL} — run seed_e2e_user.py first")
            return 1
        _source_tables()
        ds = _datasource(db)
        out = {}
        # A. live, cached reads say when they were read
        live_ds, live_t = _dataset(db, user, ds, "E2E data-state live", "orders")
        out["live"] = {"dataset_id": live_ds, "chart_id": _chart_on_dashboard(
            db, user, live_t, "E2E live ratio by region", "e2e-data-state-live")}
        # E. a relation that cannot be built (b dropped upstream) refuses with the cause
        _bd, broken_t = _dataset(db, user, ds, "E2E data-state broken relation", "orders_nob")
        out["broken"] = {"chart_id": _chart_on_dashboard(
            db, user, broken_t, "E2E broken ratio by region", "e2e-data-state-broken")}
        # B. a model naming a column its table does not have is never healthy
        sem_ds, sem_t = _dataset(db, user, ds, "E2E data-state semantic invalid", "orders")
        view = db.query(SemanticView).filter(SemanticView.dataset_table_id == sem_t).one()
        if not any(d.get("name") == "ghost" for d in (view.dimensions or []) if isinstance(d, dict)):
            from sqlalchemy.orm.attributes import flag_modified

            view.dimensions = list(view.dimensions or []) + [
                {"name": "ghost", "type": "string", "sql": "${TABLE}.ghost"}]
            flag_modified(view, "dimensions")
        out["semantic_invalid"] = {"dataset_id": sem_ds}
        # C. a failed Sync & Publish over a published generation keeps serving it
        pub_ds, _pt = _dataset(db, user, ds, "E2E data-state failed publish", "orders")
        dataset = db.get(Dataset, pub_ds)
        dataset.publish_state = "sync_failed"
        dataset.published_generation = 1790947821684
        dataset.last_sync_error = ("Generation 1790948448889 chưa phủ đủ 1 bảng — build có bảng lỗi. "
                                   "orders: column \"b\" does not exist")
        out["failed_publish"] = {"dataset_id": pub_ds}
        # F. CSV export over special-char rows (A4): the durable CSV-download e2e.
        out["csv_table"] = _csv_table_link(db, user, ds)
        db.commit()
        print(json.dumps(out))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
