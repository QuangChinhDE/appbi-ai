#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Dataset permission journey (e2e/tests/dataset-lifecycle-permissions.spec.ts).

Five password users, one DatasetGrant each on ONE dataset they do not own:
view / explore / edit / reshare / manage. Their `datasets` module level is
`edit`, so the module ceiling never hides a verb — the GRANT alone decides, which
is exactly the contract under test (no ResourceShare, no ownership).

Requires seed_e2e_user.py (owner) and seed_e2e_dataset_lifecycle.py (source).
Deterministic + idempotent. Prints ids as JSON.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from app.api.auth import hash_password  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.dataset import Dataset, DatasetGrant, DatasetTable  # noqa: E402
from app.models.models import DataSource  # noqa: E402
from app.models.user import User  # noqa: E402
from app.schemas.dataset import DatasetCreate, TableCreate  # noqa: E402
from app.services.dataset_crud import DatasetCRUDService  # noqa: E402
from app.services.dataset_model_service import generate_dataset_model  # noqa: E402

OWNER = os.environ.get("E2E_EMAIL", "admin@appbi.io")
PASSWORD = "e2e-authz-123456"
DATASET = "E2E authz sales"
VERBS = ("view", "explore", "edit", "reshare", "manage")


def _user(db, verb: str) -> User:
    email = f"ds-{verb}@appbi.io"
    u = db.query(User).filter(User.email == email).first()
    if u is None:
        u = User(email=email, full_name=f"E2E dataset {verb}")
        db.add(u)
        for field, value in (("auth_provider", "password"), ("status", "active"), ("preferred_language", "en")):
            if hasattr(u, field):
                try:
                    setattr(u, field, value)
                except Exception:  # noqa: BLE001
                    pass
    u.password_hash = hash_password(PASSWORD)
    if hasattr(u, "permissions"):
        u.permissions = {"datasets": "edit", "dashboards": "view", "charts": "view"}
    db.flush()
    return u


def main() -> None:
    db = SessionLocal()
    try:
        owner = db.query(User).filter(User.email == OWNER).first()
        source = db.query(DataSource).filter(DataSource.name == "E2E dataset-lifecycle Postgres").first()
        if owner is None or source is None:
            raise SystemExit("run seed_e2e_user.py and seed_e2e_dataset_lifecycle.py first")
        ds = db.query(Dataset).filter(Dataset.name == DATASET).first()
        if ds is None:
            ds = DatasetCRUDService.create_dataset(db, DatasetCreate(name=DATASET), owner_id=owner.id)
            t = DatasetCRUDService.add_table_to_dataset(db, ds.id, TableCreate(
                datasource_id=source.id, source_kind="physical_table",
                source_table_name="e2e_dslife.products", display_name="products"))
            DatasetCRUDService.update_table_cache(db, t.id, columns_cache={"columns": [
                {"name": "sku", "type": "string"}, {"name": "price", "type": "integer"},
                {"name": "qty", "type": "integer"}, {"name": "category", "type": "string"}]})
            generate_dataset_model(db, int(ds.id), force=False)
        users = {}
        for verb in VERBS:
            u = _user(db, verb)
            g = db.query(DatasetGrant).filter(DatasetGrant.dataset_id == ds.id, DatasetGrant.user_id == u.id).first()
            if g is None:
                db.add(DatasetGrant(dataset_id=ds.id, user_id=u.id, verb=verb, granted_by=owner.id))
            else:
                g.verb = verb
            users[verb] = {"email": u.email, "id": str(u.id)}
        db.commit()
        table_id = db.query(DatasetTable.id).filter(DatasetTable.dataset_id == ds.id).scalar()
        print(json.dumps({"dataset_id": int(ds.id), "table_id": int(table_id), "password": "<seeded>",
                          "users": users}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
