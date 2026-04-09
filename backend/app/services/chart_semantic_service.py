"""
Helpers for attaching semantic scope metadata to saved charts.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.dataset import DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.chart_contracts import get_chart_active_role_config
from app.services.dataset_calendar_service import iter_calendar_binding_fields
from app.services.dataset_model_service import generate_dataset_model
from app.core.logging import get_logger

logger = get_logger(__name__)


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
    role_config = get_chart_active_role_config(config)

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

    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
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
            logger.warning("Auto-generate semantic model failed for dataset %s", db_table.dataset_id, exc_info=True)
        model = db.query(SemanticModel).filter(SemanticModel.dataset_id == db_table.dataset_id).first()

    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == dataset_table_id).first()
    if view is None and model is not None and auto_generate:
        try:
            generate_dataset_model(db, db_table.dataset_id, force=False)
        except Exception:
            logger.warning("Auto-generate semantic view failed for dataset_table %s", dataset_table_id, exc_info=True)
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
    dimension_fields: list[str] = []
    measure_fields: list[str] = []
    calendar_field_mappings: list[dict[str, Any]] = []

    if view is not None:
        base_dimension_names = _field_names(view.dimensions)
        base_measure_names = _field_names(view.measures)
        dimension_fields.extend(f"{view_name}.{field}" for field in base_dimension_names)
        measure_fields.extend(f"{view_name}.{field}" for field in base_measure_names)

        join_targets: dict[str, SemanticView] = {}
        if explore is not None:
            for join in explore.joins or []:
                join_view_name = str(join.get("view") or "").strip()
                if not join_view_name or join_view_name in join_targets:
                    continue
                join_view = db.query(SemanticView).filter(SemanticView.name == join_view_name).first()
                if join_view is not None:
                    join_targets[join_view_name] = join_view

        for join_view_name, join_view in join_targets.items():
            dimension_fields.extend(
                f"{join_view_name}.{field}"
                for field in _field_names(join_view.dimensions)
            )
            measure_fields.extend(
                f"{join_view_name}.{field}"
                for field in _field_names(join_view.measures)
            )

        if explore is not None:
            calendar_field_mappings = iter_calendar_binding_fields(explore.joins or [])

        available_fields = set(base_dimension_names) | set(base_measure_names)
        calendar_date_by_source = {
            mapping.get("sourceField"): mapping.get("semanticField")
            for mapping in calendar_field_mappings
            if mapping.get("calendarField") == "date"
        }
        for field_name in _collect_chart_field_names(config):
            if field_name in calendar_date_by_source:
                field_map[field_name] = str(calendar_date_by_source[field_name])
            elif field_name in available_fields or view is None:
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
        "dimensionFields": sorted(set(dimension_fields)),
        "measureFields": sorted(set(measure_fields)),
        "calendarFieldMappings": calendar_field_mappings,
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
