"""Binding an operational destination reads the spreadsheet the destination names.

``bind`` with a ``spreadsheet_id`` override (credential datasource configured for
spreadsheet A, user binds B) registered every DatasetTable on the credential
datasource — whose config still says A — while ``settings.destination`` claimed
B. Reads and writes then hit A (or "sheet not found"). A bound override now gets
its own store datasource pointing at B; a retry after a partial failure reuses
it and never duplicates a table; other settings namespaces survive.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


class _Sheets:
    def __init__(self, cfg):
        self.cfg = cfg

    def list_sheets(self, ss):
        return {"sheet-A": ["a_tab"], "sheet-B": ["orders", "items"]}[ss]

    def get_header_row(self, ss, tab):
        return ["id", "name"]


@pytest.fixture()
def db(monkeypatch):
    from app.services import operational_destination_service as od

    monkeypatch.setattr(od, "decrypt_config", lambda c: dict(c or {}))
    monkeypatch.setattr(od, "encrypt_config", lambda c: dict(c or {}))
    monkeypatch.setattr(od, "create_google_sheets_connector", _Sheets)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DataSource.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="cred", type="google_sheets", config={"spreadsheet_id": "sheet-A", "token": "t"}))
        s.add(Dataset(id=1, name="WB", settings={"model_layout": {"orders": {"x": 1}},
                                                 "snapshot_config": {"partition": "d"}}))
        s.commit()
        yield s


def _spreadsheet_read_by(db, table):
    return db.get(DataSource, table.datasource_id).config["spreadsheet_id"]


def _bind(db, **kw):
    from app.services.operational_destination_service import provision_google_sheets_destination
    return provision_google_sheets_destination(db, dataset_id=1, credential_datasource_id=1, mode="bind", **kw)


def test_binding_an_override_spreadsheet_reads_the_override(db):
    out = _bind(db, spreadsheet_id="sheet-B")
    tables = db.query(DatasetTable).filter_by(dataset_id=1).all()
    assert sorted(t.source_table_name for t in tables) == ["items", "orders"]
    assert {_spreadsheet_read_by(db, t) for t in tables} == {"sheet-B"}
    ds = db.get(Dataset, 1)
    assert ds.settings["destination"]["spreadsheet_id"] == "sheet-B"
    assert ds.settings["destination"]["datasource_id"] == out["destination_datasource_id"] != 1
    assert db.get(DataSource, 1).config["spreadsheet_id"] == "sheet-A"  # credential untouched
    assert ds.settings["model_layout"] == {"orders": {"x": 1}} and ds.settings["snapshot_config"] == {"partition": "d"}


def test_binding_the_credentials_own_spreadsheet_uses_the_credential(db):
    out = _bind(db)
    assert out["destination_datasource_id"] == 1
    (t,) = db.query(DatasetTable).filter_by(dataset_id=1).all()
    assert _spreadsheet_read_by(db, t) == "sheet-A"


def test_a_retry_after_a_partial_failure_reuses_the_store_and_duplicates_nothing(db, monkeypatch):
    from app.services import operational_destination_service as od

    real = od.DatasetCRUDService.add_table_to_dataset
    calls = {"n": 0}

    def flaky(_db, dataset_id, table):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("registration failed mid-way")
        return real(_db, dataset_id, table)

    monkeypatch.setattr(od.DatasetCRUDService, "add_table_to_dataset", staticmethod(flaky))
    with pytest.raises(RuntimeError):
        _bind(db, spreadsheet_id="sheet-B")
    db.rollback()
    _bind(db, spreadsheet_id="sheet-B")
    stores = db.query(DataSource).filter(DataSource.id != 1).all()
    assert len(stores) == 1
    tables = db.query(DatasetTable).filter_by(dataset_id=1).all()
    assert sorted(t.source_table_name for t in tables) == ["items", "orders"]
    assert {t.datasource_id for t in tables} == {stores[0].id}
