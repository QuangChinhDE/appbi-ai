# -*- coding: utf-8 -*-
"""Seed the SaaS-metrics fixture the analytics correctness eval runs on.

Reproduces the shapes behind the user-reported Agent Flow defects (F01-F06):

  saas_monthly  year_month (DATE) · mrr_active · arr_active (STOCK — semi-additive)
                · cus_churned (flow) · plan_code (numeric IDENTIFIER, not a measure)
                Aug-2026 ARR = 72 vs Jul-2026 = 864: an unusual drop, NOT an
                incomplete period (the month is closed in this fixture).
  saas_segment  segment · arr_active (SAME NAME as saas_monthly.arr_active) · customers

Creates, in the metadata DB this process points at (DATABASE_URL):
  a POSTGRESQL datasource → the `fixtures` database on FIXTURE_DB_HOST,
  a Dataset with both tables, its generated semantic model. Charts and the
  dashboard are created afterwards over HTTP (`--charts`) so their semantic
  binding is the product's own.

DISPOSABLE DATABASES ONLY: refuses unless EVAL_FIXTURE_SEED=1. Never point this
at a shared or production metadata database.

    EVAL_FIXTURE_SEED=1 FIXTURE_DB_HOST=appbi-afspec-db python eval/seed_saas_fixture.py
"""
from __future__ import annotations

import json
import os
import sys

DATASET_NAME = "EVAL SaaS metrics"
DS_NAME = "EVAL SaaS fixtures PG"

TABLES = {
    "saas_monthly": ("SaaS monthly", [
        ("year_month", "date"), ("mrr_active", "numeric"), ("arr_active", "numeric"),
        ("cus_churned", "integer"), ("plan_code", "integer")]),
    "saas_segment": ("SaaS by segment", [
        ("segment", "text"), ("arr_active", "numeric"), ("customers", "integer")]),
}


def main() -> None:
    if os.environ.get("EVAL_FIXTURE_SEED") != "1":
        raise SystemExit("REFUSED: set EVAL_FIXTURE_SEED=1 and point DATABASE_URL at a DISPOSABLE metadata DB.")
    sys.path.insert(0, "/app")
    from app.core.crypto import encrypt_config
    from app.core.database import SessionLocal
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.services.dataset_model_service import generate_dataset_model

    db = SessionLocal()
    try:
        ds = db.query(DataSource).filter(DataSource.name == DS_NAME).first()
        if ds is None:
            ds = DataSource(name=DS_NAME, type=DataSourceType.POSTGRESQL, config={})
            db.add(ds)
        ds.config = encrypt_config({
            "host": os.environ.get("FIXTURE_DB_HOST", "appbi-afspec-db"), "port": 5432,
            "database": "fixtures", "username": os.environ.get("DB_USER", "appbi"),
            "password": os.environ.get("DB_PASSWORD", "appbi"), "schema_name": "public",
        })
        if hasattr(ds, "owner_email") and not getattr(ds, "owner_email", None):
            ds.owner_email = "admin@appbi.io"
        db.commit()

        dataset = db.query(Dataset).filter(Dataset.name == DATASET_NAME).first()
        if dataset is None:
            dataset = Dataset(name=DATASET_NAME, description="Analytics correctness eval fixture")
            db.add(dataset)
            db.commit()
        tables = {}
        for tbl, (disp, cols) in TABLES.items():
            dt = (db.query(DatasetTable)
                  .filter(DatasetTable.dataset_id == dataset.id, DatasetTable.source_table_name == f"public.{tbl}")
                  .first())
            if dt is None:
                dt = DatasetTable(dataset_id=dataset.id, datasource_id=ds.id, source_kind="physical_table",
                                  source_table_name=f"public.{tbl}", display_name=disp, query_mode="live",
                                  columns_cache={"columns": [{"name": n, "type": t, "nullable": True} for n, t in cols],
                                                 "source_columns": [n for n, _ in cols]},
                                  enabled=True)
                db.add(dt)
                db.commit()
            tables[tbl] = dt.id
        gen = generate_dataset_model(db, dataset.id, force=True)
        db.commit()
        print(json.dumps({"datasource_id": ds.id, "dataset_id": dataset.id, "tables": tables,
                          "views": len(gen.get("views", []))}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
