"""
Helpers for attaching semantic scope metadata to saved charts.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.dataset import DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.dataset_model_service import generate_dataset_model


def _field_names(items: list[dict] | None) -> list[str]:
    return [
        str(item.get("name")).strip()
        for item in (items or [])
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    ]


def _collect_chart_field_names(config: dict[str, Any] | None) -> list[str]:
    if not isinstance(config, dict):
        return []

    fields: set[str] = set()
    role_config = config.get("roleConfig") if isinstance(config.get("roleConfig"), dict) else {}

    for key in (
        "dimension",
        "breakdown",
        "timeField",
        "scatterX",
        "scatterY",
        "tableRowDimension",
        "tableColumnDimension",
    ):
        value = role_config.get(key)
        if isinstance(value, str) and value.strip():
            fields.add(value.strip())

    for key in ("lineMetric", "tablePivotMetric"):
        value = role_config.get(key)
        if isinstance(value, dict):
            field_name = str(value.get("field") or "").strip()
            if field_name:
                fields.add(field_name)

    for metric in role_config.get("metrics") or []:
        if not isinstance(metric, dict):
            continue
        field_name = str(metric.get("field") or "").strip()
        if field_name:
            fields.add(field_name)

    for selected in role_config.get("selectedColumns") or []:
        if isinstance(selected, str) and selected.strip():
            fields.add(selected.strip())

    for filter_key in ("filters", "baseFilters"):
        for filt in config.get(filter_key) or []:
            if not isinstance(filt, dict):
                continue
            field_name = str(filt.get("field") or "").strip()
            if field_name:
                fields.add(field_name)

    return sorted(fields)


def resolve_chart_semantic_binding(
    db: Session,
    dataset_table_id: int | None,
    config: dict[str, Any] | None = None,
    *,
    auto_generate: bool = False,
) -> dict[str, Any] | None:
    if dataset_table_id is None:
        return None

    db_table = db.query(DatasetTable).filter(DatasetTable.id == dataset_table_id).first()
    if not db_table:
        return None

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == db_table.dataset_id).first()
    if model is None and auto_generate:
        try:
            generate_dataset_model(db, db_table.dataset_id, force=False)
        except Exception:
            pass
        model = db.query(SemanticModel).filter(SemanticModel.dataset_id == db_table.dataset_id).first()

    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == dataset_table_id).first()
    if view is None and model is not None and auto_generate:
        try:
            generate_dataset_model(db, db_table.dataset_id, force=False)
        except Exception:
            pass
        view = db.query(SemanticView).filter(SemanticView.dataset_table_id == dataset_table_id).first()

    explore = None
    if model is not None and view is not None:
        explore = db.query(SemanticExplore).filter(
            SemanticExplore.model_id == model.id,
            SemanticExplore.base_view_id == view.id,
        ).first()

    view_name = (
        view.name
        if view is not None
        else db_table.display_name or db_table.source_table_name or f"table_{dataset_table_id}"
    )

    field_map: dict[str, str] = {}
    dimension_fields = _field_names(view.dimensions if view is not None else [])
    measure_fields = _field_names(view.measures if view is not None else [])
    available_fields = set(dimension_fields) | set(measure_fields)
    for field_name in _collect_chart_field_names(config):
        if field_name in available_fields or view is None:
            field_map[field_name] = f"{view_name}.{field_name}"

    binding: dict[str, Any] = {
        "status": "resolved" if model is not None and explore is not None and view is not None else "partial",
        "datasetId": db_table.dataset_id,
        "datasetTableId": dataset_table_id,
        "modelId": model.id if model is not None else None,
        "exploreId": explore.id if explore is not None else None,
        "exploreName": explore.name if explore is not None else view_name,
        "baseViewId": view.id if view is not None else None,
        "baseViewName": view_name,
        "fieldMap": field_map,
        "dimensionFields": [f"{view_name}.{field}" for field in dimension_fields],
        "measureFields": [f"{view_name}.{field}" for field in measure_fields],
    }
    return binding


def with_chart_semantic_binding(
    db: Session,
    dataset_table_id: int | None,
    config: dict[str, Any] | None,
    *,
    auto_generate: bool = False,
) -> dict[str, Any]:
    next_config = deepcopy(config or {})
    binding = resolve_chart_semantic_binding(
        db,
        dataset_table_id,
        next_config,
        auto_generate=auto_generate,
    )
    if binding:
        next_config["semanticBinding"] = binding
    return next_config
