"""Object-level permission helpers for Workboard dataset bindings."""
from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.dependencies import require_view_access
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.models.user import User

# TEMPORARY (2026-06): Workboards may only bind to Google Sheets sources.
# This is the single chokepoint — relax by widening this set (or gating it on
# a setting) when other write-capable sources are re-enabled for Workboards.
WORKBOARD_ALLOWED_SOURCE_TYPES = {"google_sheets"}


def require_dataset_binding_access(
    db: Session,
    current_user: User,
    dataset_id: int,
) -> Dataset:
    dataset = db.query(Dataset).filter(Dataset.id == int(dataset_id)).first()
    if dataset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )
    require_view_access(db, current_user, dataset, "datasets")
    return dataset


def _datasource_type_for_table(db: Session, table_id: Optional[int]) -> Optional[str]:
    """Return the datasource ``type`` string for a dataset table, or ``None``
    when the table / datasource cannot be resolved (e.g. generated calendar)."""
    if not table_id:
        return None
    table = db.query(DatasetTable).filter(DatasetTable.id == int(table_id)).first()
    if table is None or table.datasource_id is None:
        return None
    ds = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if ds is None:
        return None
    return ds.type.value if hasattr(ds.type, "value") else str(ds.type)


def assert_workboard_dataset_supported(db: Session, dataset_id: int) -> None:
    """Create-time gate: the dataset must expose at least one physical table
    backed by an allowed (Google Sheets) datasource. Blocks binding a pure
    BigQuery/Postgres dataset to a Workboard."""
    tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == int(dataset_id),
            DatasetTable.source_kind == "physical_table",
        )
        .all()
    )
    if not tables:
        # No physical tables yet — nothing to bind/write; let creation proceed.
        return
    types = set()
    for t in tables:
        if t.datasource_id is None:
            continue
        ds = db.query(DataSource).filter(DataSource.id == t.datasource_id).first()
        if ds is not None:
            types.add(ds.type.value if hasattr(ds.type, "value") else str(ds.type))
    if types and not (types & WORKBOARD_ALLOWED_SOURCE_TYPES):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Workboards currently support only Google Sheets data sources. "
                f"This dataset is backed by: {', '.join(sorted(types))}."
            ),
        )


def assert_workboard_tables_supported(
    db: Session, table_ids: Iterable[Optional[int]]
) -> None:
    """Per-screen gate: every bound table must resolve to an allowed source.
    Tables that don't resolve to a datasource (None / generated calendar) are
    skipped — only an explicit non-allowed source is rejected."""
    offenders: dict[str, None] = {}
    for tid in table_ids:
        ds_type = _datasource_type_for_table(db, tid)
        if ds_type is not None and ds_type not in WORKBOARD_ALLOWED_SOURCE_TYPES:
            offenders[ds_type] = None
    if offenders:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Workboard screens can only bind Google Sheets tables. "
                f"Found non-supported source(s): {', '.join(sorted(offenders))}."
            ),
        )
