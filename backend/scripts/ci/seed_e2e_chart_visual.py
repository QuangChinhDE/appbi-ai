#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Chart VISUAL certification fixture for `e2e/tests/chart-visual.spec.ts`. CI only.

WHAT IT PROTECTS. "HTTP 200 + N rows + legend" is not a chart: a BAR_LINE that
returned 10 rows rendered axes and a legend over an EMPTY plot (every mark at
NaN). Every chart type the Builder offers is built on these rows and must show
its data marks, not just its frame.

ONE TABLE `e2e_chart_vis.vis` (24 deterministic rows) carries what every type
needs: categories (region / channel / product / stage), a monthly date, US state
codes for maps, lat/lon, positive and negative values, a rate, an all-zero and
an all-NULL measure, and DECLARED measures (label "Tổng lead nhận", "Won") for
the AS-IS path of the user report.

The oracle (`expected` in e2e/.auth/chart_visual.json) is computed here from
the rows in Python — never from the renderer under test.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import sqlalchemy as sa  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.crypto import encrypt_config  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.dataset import Dataset, DatasetTable  # noqa: E402
from app.models.models import DataSource, DataSourceType  # noqa: E402
from app.models.semantic import SemanticView  # noqa: E402
from app.models.user import User  # noqa: E402
from app.schemas.dataset import DatasetCreate, TableCreate  # noqa: E402
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import generate_dataset_model  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
SCHEMA = "e2e_chart_vis"
DATASOURCE = "E2E chart-visual Postgres"
DATASET = "E2E chart visual"

REGIONS = ["North", "South", "East", "West"]
CHANNELS = ["Online", "Store", "Partner"]
PRODUCTS = ["P1", "P2", "P3"]
STAGES = ["Lead", "Qualified", "Proposal", "Won"]
STATES = {"CA": (37.0, -119.7), "TX": (31.5, -99.3), "NY": (42.9, -75.5), "FL": (28.6, -81.7)}
COLUMNS = [("id", "integer"), ("order_date", "date"), ("region", "string"), ("channel", "string"),
           ("product", "string"), ("stage", "string"), ("state_code", "string"), ("lat", "float"),
           ("lon", "float"), ("leads", "integer"), ("won", "integer"), ("revenue", "integer"),
           ("cost", "integer"), ("profit", "integer"), ("rate", "float"), ("zero_metric", "integer"),
           ("null_metric", "integer")]


def rows() -> list[dict]:
    out = []
    for i in range(1, 25):
        state = list(STATES)[i % 4]
        lat, lon = STATES[state]
        revenue = 100 * i
        cost = 60 * i + (i % 3) * 40
        leads = 10 + i
        won = i % 5
        out.append({
            "id": i, "order_date": date(2024, (i - 1) % 12 + 1, 15), "region": REGIONS[i % 4],
            "channel": CHANNELS[i % 3], "product": PRODUCTS[i % 3], "stage": STAGES[i % 4],
            "state_code": state, "lat": lat + (i % 3) * 0.5, "lon": lon - (i % 2) * 0.5,
            "leads": leads, "won": won, "revenue": revenue, "cost": cost,
            "profit": revenue - cost - (700 if i % 4 == 0 else 0), "rate": round(won / leads, 4),
            "zero_metric": 0, "null_metric": None,
        })
    return out


def oracle(rs: list[dict]) -> dict:
    def by(key, val):
        acc = defaultdict(float)
        for r in rs:
            acc[str(r[key])] += r[val]
        return {k: (int(v) if float(v).is_integer() else v) for k, v in acc.items()}

    month = defaultdict(lambda: {"leads": 0, "won": 0})
    for r in rs:
        m = r["order_date"].strftime("%Y-%m")
        month[m]["leads"] += r["leads"]
        month[m]["won"] += r["won"]
    return {
        "rows": len(rs),
        "revenue_by_region": by("region", "revenue"),
        "profit_by_product": by("product", "profit"),
        "leads_by_stage": by("stage", "leads"),
        "revenue_by_state": by("state_code", "revenue"),
        "revenue_by_channel": by("channel", "revenue"),
        "leads_won_by_month": dict(sorted(month.items())),
        "total_revenue": sum(r["revenue"] for r in rs),
        "total_leads": sum(r["leads"] for r in rs),
    }


def _sql_value(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _source(rs: list[dict]) -> None:
    eng = sa.create_engine(settings.DATABASE_URL)
    ddl_types = {"integer": "int", "date": "date", "string": "text", "float": "double precision"}
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.vis"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.vis (" + ", ".join(f"{n} {ddl_types[t]}" for n, t in COLUMNS) + ")"))
        values = ",".join("(" + ",".join(_sql_value(r[n]) for n, _ in COLUMNS) + ")" for r in rs)
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.vis VALUES {values}"))
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


def main() -> int:
    rs = rows()
    _source(rs)
    db = SessionLocal()
    try:
        owner = db.query(User).filter(User.email == EMAIL).first()
        assert owner is not None, f"{EMAIL} missing — run seed_e2e_user.py first"
        ds = _datasource(db)
        dataset = db.query(Dataset).filter(Dataset.name == DATASET).first()
        if dataset is None:
            dataset = DatasetCRUDService.create_dataset(db, DatasetCreate(name=DATASET), owner_id=owner.id)
            t = DatasetCRUDService.add_table_to_dataset(db, dataset.id, TableCreate(
                datasource_id=ds.id, source_kind="physical_table", source_table_name=f"{SCHEMA}.vis",
                display_name="vis"))
            db.flush()
            DatasetCRUDService.update_table_cache(db, t.id, columns_cache={
                "columns": [{"name": n, "type": ty} for n, ty in COLUMNS],
                "source_columns": [n for n, _ in COLUMNS]})
            generate_dataset_model(db, int(dataset.id), force=False)
            db.flush()
        table = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset.id).first()
        view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table.id).first()
        assert view is not None, "no semantic view for vis"
        # Declared measures — the AS-IS (agg "auto") path of the user report.
        declared = [
            {"name": "total_leads", "type": "sum", "sql": "${TABLE}.leads", "label": "Tổng lead nhận"},
            {"name": "won_deals", "type": "sum", "sql": "${TABLE}.won", "label": "Won"},
        ]
        names = {m.get("name") for m in (view.measures or [])}
        view.measures = list(view.measures or []) + [m for m in declared if m["name"] not in names]
        db.commit()
        out = {"dataset_id": int(dataset.id), "dataset_name": DATASET, "table_id": int(table.id),
               "view": view.name, "expected": oracle(rs)}
        path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "e2e", ".auth", "chart_visual.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        print(json.dumps({k: out[k] for k in ("dataset_id", "table_id", "view")}))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
