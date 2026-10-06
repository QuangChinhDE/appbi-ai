"""Custom SQL on a chart is DATASOURCE authority, not dataset authority.

A chart in custom-SQL mode sends its text straight to the table's datasource:
it can read any table that connection reaches, not just the dataset's own
tables. So holding EXPLORE/BUILD on a dataset is not enough to author it - the
author needs the same right as ``POST /datasources/query`` (arbitrary SQL):
edit on the datasource.

Two checks, one rule:
* ``require_custom_sql_authority`` - every path that AUTHORS or PREVIEWS a
  custom-SQL config (chart create/update/AI-save, dashboard fork, HTML import,
  preview, dry-run).
* ``owner_may_run_custom_sql`` - every EXECUTION of a saved custom-SQL chart
  (authed and public): the chart runs only while its owner still holds that
  right, so a chart written before this rule, or by an owner since demoted,
  stops instead of carrying the authority forever.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.services.chart_contracts import get_chart_custom_sql

_REFUSAL = ("Custom SQL runs on the whole datasource, so it needs edit access to that datasource "
            "(not only access to the dataset).")


def _datasource_for_table(db: Session, dataset_table_id: int | None):
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource

    if dataset_table_id is None:
        return None
    table = db.get(DatasetTable, dataset_table_id)
    if table is None or table.datasource_id is None:
        return None
    return db.get(DataSource, table.datasource_id)


def require_custom_sql_authority(db: Session, user, dataset_table_id: int | None, config: Any) -> None:
    """403 unless ``user`` may run arbitrary SQL on the table's datasource.
    A config without custom SQL passes untouched."""
    if not get_chart_custom_sql(config if isinstance(config, dict) else None):
        return
    from app.core.dependencies import require_edit_access, require_view_access

    datasource = _datasource_for_table(db, dataset_table_id)
    if datasource is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_REFUSAL)
    try:
        require_view_access(db, user, datasource, "data_sources")
        require_edit_access(db, user, datasource, "data_sources")
    except HTTPException as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_REFUSAL) from exc


def owner_may_run_custom_sql(db: Session, chart, datasource) -> bool:
    """True while the chart's owner still holds edit on ``datasource``."""
    if datasource is None or getattr(chart, "owner_id", None) is None:
        return False
    from app.core.dependencies import require_edit_access, require_view_access
    from app.models.user import User

    owner = db.get(User, chart.owner_id)
    if owner is None:
        return False
    try:
        require_view_access(db, owner, datasource, "data_sources")
        require_edit_access(db, owner, datasource, "data_sources")
    except HTTPException:
        return False
    return True
