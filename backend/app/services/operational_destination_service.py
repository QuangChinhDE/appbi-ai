"""Operational (Workboard) dataset — OLTP *Destination* provisioning.

An **operational** dataset (``dataset.purpose == 'operational'``) is the live
store behind a Workboard. Unlike a reporting dataset — which materialises a
read-only BI snapshot into BigQuery — an operational dataset OWNS a small OLTP
store that the Workboard runtime reads and writes directly:

    LiveQueryService.execute_preview_query   (reads)
    write_service                            (inserts / updates / deletes)
    rls_service.build_rls_filter             (row-level security)

The store is described by ``dataset.settings['destination']``::

    {
      "kind": "google_sheets",     # first supported store (Postgres/MySQL/... later)
      "datasource_id": <int>,      # the DataSource that points at the store
      "spreadsheet_id": "<id>",    # the Google Spreadsheet backing it
      "managed": true|false        # true = app created & owns it; false = bound existing
    }

This module PROVISIONS that store. Two modes:

* **create** — the app creates a brand-new Google Spreadsheet (owned by the
  chosen Google credential), lays out one tab per table with a header row, and
  registers a fresh ``DataSource`` pointing at it. This is the default for a new
  Workboard dataset — "app tự tạo mới".
* **bind** — an existing spreadsheet (already wired as a Google Sheets
  ``DataSource``) is adopted as the store; its tabs become tables. This is the
  "cắm sẵn cái có sẵn" path.

Every OLTP table gets an app-managed ``id`` primary-key column as its first
column (auto-number is applied on insert by the write path). Reporting / OLAP is
NEVER touched here — this branch is fully independent of the semantic model,
snapshots and BigQuery.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.crypto import decrypt_config, encrypt_config
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource, DataSourceType
from app.schemas.dataset import TableCreate
from app.services.dataset_crud import DatasetCRUDService
from app.services.google_sheets_connector import create_google_sheets_connector

logger = logging.getLogger(__name__)

# App-managed primary key for every operational (OLTP) table. Kept as the first
# column of every tab; the write path fills it with an auto-number on insert.
PK_COLUMN = "id"
DEST_KIND_SHEETS = "google_sheets"


# --------------------------------------------------------------------------- #
# Destination config accessors
# --------------------------------------------------------------------------- #
def get_destination(dataset: Dataset) -> Optional[Dict[str, Any]]:
    """Return the operational dataset's Destination config, or None."""
    settings = dataset.settings if isinstance(dataset.settings, dict) else {}
    dest = settings.get("destination")
    return dest if isinstance(dest, dict) else None


def _set_destination(db: Session, dataset: Dataset, dest: Dict[str, Any]) -> None:
    settings = dict(dataset.settings) if isinstance(dataset.settings, dict) else {}
    settings["destination"] = dest
    dataset.settings = settings
    flag_modified(dataset, "settings")
    # A dataset with an OLTP destination is operational by definition.
    dataset.purpose = "operational"


# --------------------------------------------------------------------------- #
# Schema helpers
# --------------------------------------------------------------------------- #
def _normalize_columns(columns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """De-dupe + strip, always with the ``id`` PK first, matching the
    ``columns_cache`` shape used across the app
    (``{"name","type","nullable","source_type"}``)."""
    out: List[Dict[str, Any]] = [
        {"name": PK_COLUMN, "type": "string", "nullable": False, "source_type": None}
    ]
    seen = {PK_COLUMN}
    for col in columns or []:
        name = str(col.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(
            {
                "name": name,
                "type": str(col.get("type") or "string"),
                "nullable": bool(col.get("nullable", True)),
                "source_type": None,
            }
        )
    return out


def _header_names(columns: List[Dict[str, Any]]) -> List[str]:
    return [c["name"] for c in _normalize_columns(columns)]


def _columns_cache(columns: List[Dict[str, Any]]) -> Dict[str, Any]:
    cols = _normalize_columns(columns)
    return {
        "columns": cols,
        "source_columns": [c["name"] for c in cols],
    }


# --------------------------------------------------------------------------- #
# Datasource helpers
# --------------------------------------------------------------------------- #
def _resolve_sheets_datasource(db: Session, datasource_id: int) -> DataSource:
    ds = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not ds:
        raise ValueError(f"Datasource {datasource_id} not found")
    kind = str(getattr(ds.type, "value", ds.type) or "").lower()
    if kind != DEST_KIND_SHEETS:
        raise ValueError(
            f"Datasource {datasource_id} is '{kind}', not a Google Sheets connection"
        )
    return ds


def _unique_ds_name(db: Session, base: str) -> str:
    name = (base or "OLTP store").strip()[:230]
    candidate = name
    n = 2
    while db.query(DataSource).filter(DataSource.name == candidate).first() is not None:
        candidate = f"{name} ({n})"
        n += 1
    return candidate


def _register_tables(
    db: Session,
    dataset_id: int,
    store_ds_id: int,
    specs: List[Tuple[str, List[Dict[str, Any]]]],
) -> List[int]:
    registered: List[int] = []
    for tab_name, columns in specs:
        table = DatasetCRUDService.add_table_to_dataset(
            db,
            dataset_id,
            TableCreate(
                datasource_id=store_ds_id,
                source_kind="physical_table",
                source_table_name=tab_name,
                display_name=tab_name,
            ),
        )
        if table is None:
            continue
        table.columns_cache = _columns_cache(columns)
        db.add(table)
        registered.append(table.id)
    db.commit()
    return registered


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def provision_google_sheets_destination(
    db: Session,
    *,
    dataset_id: int,
    credential_datasource_id: int,
    mode: str = "create",
    tables: Optional[List[Dict[str, Any]]] = None,
    spreadsheet_id: Optional[str] = None,
    title: Optional[str] = None,
    owner_id: Any = None,
) -> Dict[str, Any]:
    """Provision (or bind) a Google Sheets OLTP store for an operational dataset.

    Args:
        dataset_id: the operational dataset to attach the store to.
        credential_datasource_id: an existing Google Sheets ``DataSource`` whose
            credential is used. In ``create`` mode the app borrows the credential
            to create a new spreadsheet; in ``bind`` mode this datasource IS the
            store (its ``spreadsheet_id`` is adopted).
        mode: ``'create'`` (default) or ``'bind'``.
        tables: schema — ``[{"name": str, "columns": [{"name","type"}, ...]}]``.
            Required for ``create``; optional for ``bind`` (tabs auto-discovered
            with their header rows when omitted).
        spreadsheet_id: only for ``bind`` when adopting a spreadsheet different
            from the credential datasource's own (rare); defaults to the
            datasource's ``spreadsheet_id``.
        title: spreadsheet title for ``create`` (defaults to the dataset name).
        owner_id: owner for a newly-created store datasource.

    Returns a summary dict.
    """
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise ValueError(f"Dataset {dataset_id} not found")

    cred_ds = _resolve_sheets_datasource(db, credential_datasource_id)
    cred_cfg = decrypt_config(cred_ds.config)
    connector = create_google_sheets_connector(cred_cfg)

    tables = tables or []

    if mode == "create":
        specs = [
            (str(t.get("name") or "").strip(), list(t.get("columns") or []))
            for t in tables
            if str(t.get("name") or "").strip()
        ]
        if not specs:
            raise ValueError("create mode requires at least one table with a name")

        ss_title = (title or (dataset.name or f"Dataset {dataset_id}")).strip()
        if not ss_title.lower().endswith("store"):
            ss_title = f"{ss_title} · OLTP store"
        created = connector.create_spreadsheet(ss_title, [name for name, _ in specs])
        new_ss_id = created["spreadsheet_id"]
        logger.info(
            "[oltp] created spreadsheet %s for operational dataset %s (%d tabs)",
            new_ss_id, dataset_id, len(specs),
        )
        for name, columns in specs:
            connector.write_header_row(new_ss_id, name, _header_names(columns))

        # Clone the credential into a NEW datasource that points at the new store.
        store_cfg = dict(cred_cfg)
        store_cfg["spreadsheet_id"] = new_ss_id
        store_cfg["sheet_name"] = specs[0][0]
        store_ds = DataSource(
            name=_unique_ds_name(db, f"{dataset.name or f'Dataset {dataset_id}'} · OLTP store"),
            type=DataSourceType(DEST_KIND_SHEETS),
            description=f"App-managed Google Sheets store for operational dataset {dataset_id}",
            config=encrypt_config(store_cfg),
            owner_id=owner_id if owner_id is not None else getattr(dataset, "owner_id", None),
        )
        db.add(store_ds)
        db.commit()
        db.refresh(store_ds)

        registered = _register_tables(db, dataset_id, store_ds.id, specs)
        _set_destination(
            db,
            dataset,
            {
                "kind": DEST_KIND_SHEETS,
                "datasource_id": store_ds.id,
                "spreadsheet_id": new_ss_id,
                "spreadsheet_url": created.get("spreadsheet_url"),
                "managed": True,
            },
        )
        db.add(dataset)
        db.commit()
        return {
            "dataset_id": dataset_id,
            "mode": "create",
            "destination_datasource_id": store_ds.id,
            "spreadsheet_id": new_ss_id,
            "spreadsheet_url": created.get("spreadsheet_url"),
            "managed": True,
            "tables": registered,
        }

    if mode == "bind":
        target_ss = (spreadsheet_id or cred_cfg.get("spreadsheet_id") or "").strip()
        if not target_ss:
            raise ValueError("bind mode requires a spreadsheet_id (on the datasource or explicit)")

        if tables:
            specs = [
                (str(t.get("name") or "").strip(), list(t.get("columns") or []))
                for t in tables
                if str(t.get("name") or "").strip()
            ]
        else:
            # Discover tabs + their header rows.
            specs = []
            for tab_name in connector.list_sheets(target_ss):
                headers = connector.get_header_row(target_ss, tab_name)
                columns = [
                    {"name": h, "type": "string"}
                    for h in headers
                    if str(h or "").strip() and str(h).strip() != PK_COLUMN
                ]
                specs.append((tab_name, columns))
        if not specs:
            raise ValueError("bind mode found no tabs to register")

        registered = _register_tables(db, dataset_id, cred_ds.id, specs)
        _set_destination(
            db,
            dataset,
            {
                "kind": DEST_KIND_SHEETS,
                "datasource_id": cred_ds.id,
                "spreadsheet_id": target_ss,
                "managed": False,
            },
        )
        db.add(dataset)
        db.commit()
        return {
            "dataset_id": dataset_id,
            "mode": "bind",
            "destination_datasource_id": cred_ds.id,
            "spreadsheet_id": target_ss,
            "managed": False,
            "tables": registered,
        }

    raise ValueError(f"Unknown provisioning mode: {mode!r}")
