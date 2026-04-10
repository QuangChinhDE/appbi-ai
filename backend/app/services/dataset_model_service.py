"""
Dataset Model Service
Auto-generates semantic layer (views, model, explores) from dataset tables.
Each dataset = 1 Data Mart with its own semantic model.
"""
import hashlib
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticModel, SemanticExplore
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.core.config import settings
from app.core.logging import get_logger
from app.services import query_cache
from app.services.dataset_calendar_service import (
    CALENDAR_DIMENSIONS,
    CALENDAR_MEASURES,
    build_calendar_join_sql,
    build_calendar_live_sql,
    build_calendar_role_display_name,
    build_calendar_role_view_name,
    get_calendar_role_view_display,
    get_calendar_settings,
    is_generated_calendar_table,
    iter_temporal_columns,
)
from app.services.dataset_table_sql_service import (
    is_derived_table,
)

logger = get_logger(__name__)

# Column type → semantic type mapping
_TYPE_MAP_DIMENSION = {
    "string": "string",
    "text": "string",
    "boolean": "yesno",
    "date": "date",
    "datetime": "datetime",
    "timestamp": "datetime",
}

_NUMERIC_TYPES = {"integer", "int", "float", "number", "numeric", "decimal", "bigint", "double"}

# FK naming heuristics: columns ending with these suffixes are likely foreign keys
_FK_SUFFIXES = ("_id", "_pk", "_fk", "_key")


_JOIN_SQL_ON_RE = re.compile(r"\$\{TABLE\}\.([^\s=]+)\s*=\s*\$\{[^}]+\}\.([^\s=]+)")


def _singularize(name: str) -> str:
    """Basic English singularization for FK detection."""
    base = name.split(".")[-1] if "." in name else name
    if base.endswith("ies"):
        return base[:-3] + "y"
    if base.endswith("s") and not base.endswith("ss"):
        return base[:-1]
    return base


def _classify_columns(columns_cache) -> Tuple[list, list]:
    """
    Classify cached columns into dimensions and measures.
    columns_cache can be a dict {"columns": [...]} or a list of dicts.
    Returns: (dimensions_list, measures_list) as dicts ready for JSON storage.
    """
    dimensions = []
    measures = []

    if not columns_cache:
        return dimensions, measures

    # Normalize: columns_cache may be {"columns": [...]} or [...]
    if isinstance(columns_cache, dict):
        columns = columns_cache.get("columns", [])
    elif isinstance(columns_cache, list):
        columns = columns_cache
    else:
        return dimensions, measures

    for col in columns:
        col_name = col.get("name", "")
        col_type = (col.get("type", "") or "string").lower()

        if not col_name:
            continue

        if col_type in _NUMERIC_TYPES:
            # Numeric → measure (default SUM)
            measures.append({
                "name": col_name,
                "type": "sum",
                "sql": col_name,
                "label": col_name.replace("_", " ").title(),
                "description": None,
                "hidden": False,
            })
            # Also add as dimension for GROUP BY flexibility
            dimensions.append({
                "name": col_name,
                "type": "number",
                "sql": col_name,
                "label": col_name.replace("_", " ").title(),
                "description": None,
                "hidden": True,  # Hidden by default since it's primarily a measure
            })
        elif col_type in _TYPE_MAP_DIMENSION:
            dim_type = _TYPE_MAP_DIMENSION[col_type]
            dimensions.append({
                "name": col_name,
                "type": dim_type,
                "sql": col_name,
                "label": col_name.replace("_", " ").title(),
                "description": None,
                "hidden": False,
            })
        else:
            # Default to string dimension
            dimensions.append({
                "name": col_name,
                "type": "string",
                "sql": col_name,
                "label": col_name.replace("_", " ").title(),
                "description": None,
                "hidden": False,
            })

    # Always add a COUNT measure
    has_count = any(m["type"] == "count" for m in measures)
    if not has_count:
        measures.insert(0, {
            "name": "count",
            "type": "count",
            "sql": "*",
            "label": "Count",
            "description": "Total number of records",
            "hidden": False,
        })

    return dimensions, measures


def _clean_join_identifier(raw: str | None) -> str | None:
    if raw is None:
        return None
    return str(raw).strip().strip('"').strip("`").strip("[]")


def _parse_join_columns(sql_on: str | None) -> tuple[str | None, str | None]:
    if not sql_on:
        return None, None
    match = _JOIN_SQL_ON_RE.search(sql_on)
    if not match:
        return None, None
    return _clean_join_identifier(match.group(1)), _clean_join_identifier(match.group(2))


def _normalize_join(join: dict, base_view_name: str, base_fields: set[str] | None = None) -> dict | None:
    normalized = dict(join)
    from_column = _clean_join_identifier(normalized.get("from_column"))
    to_column = _clean_join_identifier(normalized.get("to_column"))

    if not from_column or not to_column:
        parsed_from, parsed_to = _parse_join_columns(normalized.get("sql_on"))
        from_column = from_column or parsed_from
        to_column = to_column or parsed_to

    if normalized.get("from_view") and normalized.get("from_view") != base_view_name:
        return None

    if base_fields is not None and from_column and from_column not in base_fields:
        return None

    normalized["from_view"] = base_view_name
    if from_column:
        normalized["from_column"] = from_column
    if to_column:
        normalized["to_column"] = to_column
    return normalized


def _apply_duckdb_transformations(view_name: str, transformations) -> str:
    server_transforms = [
        step for step in (transformations or [])
        if step.get("enabled", True) and step.get("type") not in ("js_formula",)
    ]
    if not server_transforms:
        return view_name

    from app.services.transformation_compiler import TransformationCompiler

    compiled_sql, _ = TransformationCompiler.compile_transformations(
        f"SELECT * FROM {view_name}",
        server_transforms,
        dialect="duckdb",
    )
    return f"({compiled_sql}) AS _t"


def _coerce_distinct_values(rows: list[Any]) -> list[str]:
    values: list[str] = []
    for row in rows or []:
        if isinstance(row, dict):
            value = row.get("value")
        elif isinstance(row, (list, tuple)):
            value = row[0] if row else None
        else:
            value = row
        if value is None:
            continue
        text = str(value).strip()
        if text:
            values.append(text)
    return values


def _view_name_for_table(table: DatasetTable) -> str:
    return table.display_name or table.source_table_name or f"table_{table.id}"


def _stable_semantic_view_name(table_id: int) -> str:
    return f"dataset_table_{table_id}"


def _resolve_dataset_dialect(datasources: List[DataSource]) -> str:
    from app.services.live_query_service import _dialect_for_ds_type

    for datasource in datasources:
        if datasource is None:
            continue
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        return _dialect_for_ds_type(ds_type)
    return "postgresql"


def _sql_table_for_table(dataset_obj: Dataset, table: DatasetTable, *, calendar_dialect: str) -> str:
    if is_generated_calendar_table(table):
        settings = get_calendar_settings(dataset_obj, enabled_default=False)
        return f"({build_calendar_live_sql(settings, calendar_dialect)})"
    if is_derived_table(table) and table.source_query:
        return f"({table.source_query})"
    if table.source_kind == "physical_table" and table.source_table_name:
        return table.source_table_name
    if table.source_kind == "sql_query" and table.source_query:
        return f"({table.source_query})"
    return _view_name_for_table(table)


def _semantic_fields_for_table(dataset_obj: Dataset, table: DatasetTable) -> tuple[list[dict], list[dict]]:
    if is_generated_calendar_table(table):
        return [dict(item) for item in CALENDAR_DIMENSIONS], [dict(item) for item in CALENDAR_MEASURES]
    return _classify_columns(table.columns_cache or [])


def _upsert_semantic_view(
    db: Session,
    *,
    name: str,
    sql_table_name: str,
    dataset_table_id: int | None,
    dimensions: list[dict],
    measures: list[dict],
    description: str | None,
    existing_by_dataset_table: Dict[int, SemanticView],
    existing_by_name: Dict[str, SemanticView],
) -> tuple[SemanticView, bool, bool]:
    view: SemanticView | None = None
    if dataset_table_id is not None:
        view = existing_by_dataset_table.get(dataset_table_id)
    if view is None:
        view = existing_by_name.get(name)

    created = False
    updated = False
    if view is None:
        view = SemanticView(
            name=name,
            sql_table_name=sql_table_name,
            dataset_table_id=dataset_table_id,
            dimensions=dimensions,
            measures=measures,
            description=description,
        )
        db.add(view)
        db.flush()
        created = True
    else:
        changed = (
            view.name != name
            or view.sql_table_name != sql_table_name
            or view.dataset_table_id != dataset_table_id
            or (view.dimensions or []) != dimensions
            or (view.measures or []) != measures
            or view.description != description
        )
        view.name = name
        view.sql_table_name = sql_table_name
        view.dataset_table_id = dataset_table_id
        view.dimensions = dimensions
        view.measures = measures
        view.description = description
        updated = changed

    existing_by_name[view.name] = view
    if dataset_table_id is not None:
        existing_by_dataset_table[dataset_table_id] = view
    return view, created, updated


def _detect_fk_joins(
    tables: List[DatasetTable],
    table_views: Dict[int, SemanticView],
) -> Dict[str, List[dict]]:
    joins_by_source: Dict[str, List[dict]] = {}
    table_names: Dict[str, DatasetTable] = {}

    for table in tables:
        if is_generated_calendar_table(table):
            continue
        display = _view_name_for_table(table)
        table_names[display.lower()] = table
        table_names[_singularize(display).lower()] = table

    for table in tables:
        if is_generated_calendar_table(table) or not table.columns_cache:
            continue
        current_view = table_views.get(table.id)
        if current_view is None:
            continue

        cc = table.columns_cache
        if isinstance(cc, dict):
            columns = cc.get("columns", [])
        elif isinstance(cc, list):
            columns = cc
        else:
            continue

        for col in columns:
            raw_col_name = str(col.get("name") or "").strip()
            col_name = raw_col_name.lower()
            if not raw_col_name or not any(col_name.endswith(suffix) for suffix in _FK_SUFFIXES):
                continue

            ref_name = col_name
            for suffix in _FK_SUFFIXES:
                if ref_name.endswith(suffix):
                    ref_name = ref_name[: -len(suffix)]
                    break

            ref_table = table_names.get(ref_name)
            ref_view = table_views.get(ref_table.id) if ref_table else None
            if ref_table is None or ref_view is None or ref_table.id == table.id:
                continue

            joins_by_source.setdefault(current_view.name, [])
            existing = any(
                join.get("view") == ref_view.name
                and join.get("from_column") == raw_col_name
                and join.get("to_column") == "id"
                for join in joins_by_source[current_view.name]
            )
            if existing:
                continue

            joins_by_source[current_view.name].append({
                "name": ref_view.name,
                "view": ref_view.name,
                "type": "left",
                "sql_on": f"${{TABLE}}.{raw_col_name} = ${{{ref_view.name}}}.id",
                "relationship": "many_to_one",
                "from_view": current_view.name,
                "from_column": raw_col_name,
                "to_column": "id",
                "origin": "auto_fk",
                "managed": True,
            })

    return joins_by_source


def _build_calendar_role_views(
    db: Session,
    *,
    dataset_obj: Dataset,
    tables: List[DatasetTable],
    table_views: Dict[int, SemanticView],
    existing_by_name: Dict[str, SemanticView],
    existing_by_dataset_table: Dict[int, SemanticView],
) -> tuple[Dict[str, List[dict]], Dict[str, SemanticView], int, int, Set[str]]:
    joins_by_source: Dict[str, List[dict]] = {}
    role_views: Dict[str, SemanticView] = {}
    created = 0
    updated = 0
    role_view_names: Set[str] = set()

    calendar_settings = get_calendar_settings(dataset_obj, enabled_default=False)
    if not calendar_settings.get("enabled") or not calendar_settings.get("auto_join_temporal_columns"):
        return joins_by_source, role_views, created, updated, role_view_names

    calendar_table = next((table for table in tables if is_generated_calendar_table(table)), None)
    calendar_view = table_views.get(calendar_table.id) if calendar_table else None
    if calendar_table is None or calendar_view is None:
        return joins_by_source, role_views, created, updated, role_view_names

    role_dimensions = [dict(item) for item in CALENDAR_DIMENSIONS]
    role_measures = [dict(item) for item in CALENDAR_MEASURES]

    for table in tables:
        if is_generated_calendar_table(table):
            continue
        source_view = table_views.get(table.id)
        if source_view is None:
            continue
        source_label = table.display_name or table.source_table_name or source_view.name

        for temporal_column in iter_temporal_columns(table):
            column_name = temporal_column["name"]
            column_type = temporal_column["type"]
            role_view_name = build_calendar_role_view_name(source_view.name, column_name)
            role_view_names.add(role_view_name)

            role_view, was_created, was_updated = _upsert_semantic_view(
                db,
                name=role_view_name,
                sql_table_name=calendar_view.sql_table_name,
                dataset_table_id=None,
                dimensions=role_dimensions,
                measures=role_measures,
                description=build_calendar_role_display_name(source_label, column_name),
                existing_by_dataset_table=existing_by_dataset_table,
                existing_by_name=existing_by_name,
            )
            if was_created:
                created += 1
            elif was_updated:
                updated += 1
            role_views[role_view.name] = role_view

            joins_by_source.setdefault(source_view.name, []).append({
                "name": role_view.name,
                "view": role_view.name,
                "type": "left",
                "sql_on": build_calendar_join_sql(column_name, column_type, role_view.name),
                "relationship": "many_to_one",
                "from_view": source_view.name,
                "from_column": column_name,
                "to_column": "date",
                "origin": "auto_calendar",
                "managed": True,
                "calendar_role": role_view.name,
                "calendar_source_field": column_name,
                "presentation_view": calendar_view.name,
            })

    return joins_by_source, role_views, created, updated, role_view_names


def _merge_join_definitions(
    manual_joins: List[dict],
    auto_joins: List[dict],
) -> List[dict]:
    merged: List[dict] = []
    seen: Set[tuple[str, str | None, str | None]] = set()

    for join in [*manual_joins, *auto_joins]:
        parsed_from, parsed_to = _parse_join_columns(join.get("sql_on"))
        join_from = _clean_join_identifier(join.get("from_column")) or parsed_from
        join_to = _clean_join_identifier(join.get("to_column")) or parsed_to
        key = (str(join.get("view") or ""), join_from, join_to)
        if key in seen:
            continue
        seen.add(key)
        merged.append(join)

    return merged


def _view_role_for_response(view: SemanticView, table: DatasetTable | None) -> tuple[str, bool, bool]:
    if table is not None:
        if is_generated_calendar_table(table):
            return "calendar_dimension", True, False
        return "table", False, False
    if str(view.name or "").endswith("__date_dim"):
        return "calendar_role", True, True
    return "table", False, False


def _detect_joins(tables: List[DatasetTable]) -> list:
    """
    Detect potential joins between tables using FK naming conventions.
    Returns a list of JoinDefinition dicts.
    """
    joins = []
    table_names = {}  # singular_name -> table

    for table in tables:
        display = table.display_name or table.source_table_name or ""
        table_names[display.lower()] = table
        table_names[_singularize(display).lower()] = table

    for table in tables:
        if not table.columns_cache:
            continue
        # Normalize columns_cache format
        cc = table.columns_cache
        if isinstance(cc, dict):
            columns = cc.get("columns", [])
        elif isinstance(cc, list):
            columns = cc
        else:
            continue
        for col in columns:
            raw_col_name = col.get("name", "")
            col_name = raw_col_name.lower()
            if not raw_col_name or not any(col_name.endswith(suffix) for suffix in _FK_SUFFIXES):
                continue

            # Extract referenced table name from FK column
            # e.g., "customer_id" → "customer", "product_fk" → "product"
            ref_name = col_name
            for suffix in _FK_SUFFIXES:
                if ref_name.endswith(suffix):
                    ref_name = ref_name[: -len(suffix)]
                    break

            # Find matching table
            ref_table = table_names.get(ref_name)
            if ref_table and ref_table.id != table.id:
                ref_display = ref_table.display_name or ref_table.source_table_name or ""
                current_display = table.display_name or table.source_table_name or ""

                # Check if this join already exists (avoid duplicates)
                existing = any(
                    j["view"] == ref_display and j.get("_source_table") == current_display
                    for j in joins
                )
                if not existing:
                    joins.append({
                        "name": ref_display,
                        "view": ref_display,
                        "type": "left",
                        "sql_on": f"${{TABLE}}.{raw_col_name} = ${{{ref_display}}}.id",
                        "relationship": "many_to_one",
                        "from_view": current_display,
                        "from_column": raw_col_name,
                        "to_column": "id",
                        "_source_table": current_display,  # Internal, stripped before save
                    })

    return joins


def generate_dataset_model(
    db: Session,
    dataset_id: int,
    force: bool = False,
) -> dict:
    """Auto-sync the semantic model for a dataset while preserving manual joins."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise ValueError(f"Dataset {dataset_id} not found")

    tables: List[DatasetTable] = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .filter(DatasetTable.enabled == True)
        .all()
    )
    if not tables:
        raise ValueError("Dataset has no enabled tables")

    datasource_ids = {
        int(table.datasource_id)
        for table in tables
        if getattr(table, "datasource_id", None) is not None
    }
    datasources = (
        db.query(DataSource)
        .filter(DataSource.id.in_(datasource_ids))
        .order_by(DataSource.id)
        .all()
        if datasource_ids
        else []
    )
    calendar_dialect = _resolve_dataset_dialect(datasources)

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if not model:
        model = SemanticModel(
            name=f"model_{dataset_obj.name}",
            dataset_id=dataset_id,
            description=f"Auto-generated model for dataset: {dataset_obj.name}",
        )
        db.add(model)
        db.flush()
    else:
        model.name = f"model_{dataset_obj.name}"
        model.description = f"Auto-generated model for dataset: {dataset_obj.name}"

    existing_views = db.query(SemanticView).all()
    existing_by_dataset_table = {
        view.dataset_table_id: view
        for view in existing_views
        if view.dataset_table_id is not None
    }
    existing_by_name = {view.name: view for view in existing_views}

    views_created = 0
    views_updated = 0
    table_views: Dict[int, SemanticView] = {}
    desired_dataset_view_names: Set[str] = set()
    desired_table_ids = {table.id for table in tables}

    # All table IDs for this dataset (enabled + disabled) — used to scope
    # deletions so we never touch SemanticViews belonging to other datasets.
    all_dataset_table_ids = {
        t_id
        for (t_id,) in db.query(DatasetTable.id).filter(
            DatasetTable.dataset_id == dataset_id
        ).all()
    }

    for stale_view in existing_views:
        if (
            stale_view.dataset_table_id is not None
            and stale_view.dataset_table_id in all_dataset_table_ids
            and stale_view.dataset_table_id not in desired_table_ids
        ):
            db.delete(stale_view)

    for table in tables:
        existing_view = existing_by_dataset_table.get(table.id)
        view_name = existing_view.name if existing_view else _stable_semantic_view_name(table.id)
        desired_dataset_view_names.add(view_name)
        dimensions, measures = _semantic_fields_for_table(dataset_obj, table)
        display_label = table.display_name or table.source_table_name or view_name
        description = table.auto_description or f"View for table: {display_label}"
        view, was_created, was_updated = _upsert_semantic_view(
            db,
            name=view_name,
            sql_table_name=_sql_table_for_table(
                dataset_obj,
                table,
                calendar_dialect=calendar_dialect,
            ),
            dataset_table_id=table.id,
            dimensions=dimensions,
            measures=measures,
            description=description,
            existing_by_dataset_table=existing_by_dataset_table,
            existing_by_name=existing_by_name,
        )
        table_views[table.id] = view
        if was_created:
            views_created += 1
        elif was_updated or force:
            views_updated += 1

    auto_fk_joins = _detect_fk_joins(tables, table_views)
    auto_calendar_joins, role_views, role_views_created, role_views_updated, role_view_names = _build_calendar_role_views(
        db,
        dataset_obj=dataset_obj,
        tables=tables,
        table_views=table_views,
        existing_by_name=existing_by_name,
        existing_by_dataset_table=existing_by_dataset_table,
    )
    views_created += role_views_created
    views_updated += role_views_updated

    # Clean up stale calendar role views — only those belonging to THIS dataset.
    # Role views are named "{dataset_table_{id}}__{column}__date_dim".
    dataset_view_prefixes = {f"dataset_table_{tid}__" for tid in all_dataset_table_ids}
    for view in db.query(SemanticView).filter(SemanticView.dataset_table_id.is_(None)).all():
        if view.name in role_view_names:
            continue
        if view.name.endswith("__date_dim") and any(
            view.name.startswith(pfx) for pfx in dataset_view_prefixes
        ):
            db.delete(view)

    existing_explores = {
        explore.base_view_id: explore
        for explore in db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
    }
    desired_base_view_ids = {view.id for view in table_views.values()}
    for base_view_id, explore in list(existing_explores.items()):
        if base_view_id not in desired_base_view_ids:
            db.delete(explore)
            existing_explores.pop(base_view_id, None)

    explores_created = 0
    for table in tables:
        base_view = table_views.get(table.id)
        if base_view is None:
            continue

        explore = existing_explores.get(base_view.id)
        if explore is None:
            explore = SemanticExplore(
                name=base_view.name,
                model_id=model.id,
                base_view_id=base_view.id,
                base_view_name=base_view.name,
                joins=[],
                description=f"Explore for {table.display_name or table.source_table_name or base_view.name}",
            )
            db.add(explore)
            db.flush()
            explores_created += 1

        manual_joins = [
            join for join in (explore.joins or [])
            if join.get("origin") not in {"auto_fk", "auto_calendar"}
        ]
        auto_joins = [
            *auto_fk_joins.get(base_view.name, []),
            *auto_calendar_joins.get(base_view.name, []),
        ]
        explore.name = base_view.name
        explore.base_view_name = base_view.name
        explore.base_view_id = base_view.id
        explore.description = f"Explore for {table.display_name or table.source_table_name or base_view.name}"
        explore.joins = _merge_join_definitions(manual_joins, auto_joins)

    db.commit()

    return {
        "model_id": model.id,
        "dataset_id": dataset_id,
        "views_created": views_created,
        "views_updated": views_updated,
        "explores_created": explores_created,
        "generated": True,
    }


def get_dataset_model(db: Session, dataset_id: int) -> Optional[dict]:
    """
    Get the full semantic model for a dataset.
    Returns None if no model exists.
    """
    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        return None

    model = db.query(SemanticModel).filter(
        SemanticModel.dataset_id == dataset_id
    ).first()

    if not model:
        return None

    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    table_ids = [t.id for t in tables]
    table_map = {t.id: t for t in tables}

    explores = (
        db.query(SemanticExplore)
        .filter(SemanticExplore.model_id == model.id)
        .all()
    )

    referenced_view_names: Set[str] = set()
    for explore in explores:
        referenced_view_names.add(explore.base_view_name)
        for join in explore.joins or []:
            if join.get("view"):
                referenced_view_names.add(str(join.get("view")))

    views: List[SemanticView] = []
    if table_ids:
        views.extend(
            db.query(SemanticView)
            .filter(SemanticView.dataset_table_id.in_(table_ids))
            .all()
        )
    if referenced_view_names:
        extra_views = (
            db.query(SemanticView)
            .filter(SemanticView.name.in_(list(referenced_view_names)))
            .all()
        )
        existing_ids = {view.id for view in views}
        views.extend(view for view in extra_views if view.id not in existing_ids)

    views_data = []
    view_field_map: dict[str, set[str]] = {}
    for v in views:
        table = table_map.get(v.dataset_table_id) if v.dataset_table_id else None
        view_role, system_managed, hidden_in_canvas = _view_role_for_response(v, table)
        dimension_names = {
            item.get("name")
            for item in (v.dimensions or [])
            if isinstance(item, dict) and item.get("name")
        }
        measure_names = {
            item.get("name")
            for item in (v.measures or [])
            if isinstance(item, dict) and item.get("name")
        }
        view_field_map[v.name] = {name for name in dimension_names | measure_names if name}
        views_data.append({
            "id": v.id,
            "name": v.name,
            "dataset_table_id": v.dataset_table_id,
            "table_display_name": (
                (table.display_name or table.source_table_name or v.name) if table
                else v.description or get_calendar_role_view_display(v.name)
            ),
            "sql_table_name": v.sql_table_name,
            "view_role": view_role,
            "system_managed": system_managed,
            "hidden_in_canvas": hidden_in_canvas,
            "dimensions": v.dimensions or [],
            "measures": v.measures or [],
            "description": v.description,
        })

    calendar_presentation_view_name = next(
        (
            item["name"]
            for item in views_data
            if item.get("view_role") == "calendar_dimension"
        ),
        None,
    )

    explores_data = []
    for e in explores:
        normalized_joins = []
        base_fields = view_field_map.get(e.base_view_name, set())
        for join in e.joins or []:
            normalized_join = _normalize_join(join, e.base_view_name, base_fields)
            if normalized_join:
                if normalized_join.get("origin") == "auto_calendar":
                    if not normalized_join.get("presentation_view") and calendar_presentation_view_name:
                        normalized_join["presentation_view"] = calendar_presentation_view_name
                    if not normalized_join.get("calendar_source_field") and normalized_join.get("from_column"):
                        normalized_join["calendar_source_field"] = normalized_join.get("from_column")
                normalized_joins.append(normalized_join)
        explores_data.append({
            "id": e.id,
            "name": e.name,
            "base_view_name": e.base_view_name,
            "base_view_id": e.base_view_id,
            "joins": normalized_joins,
            "description": e.description,
        })

    return {
        "model_id": model.id,
        "dataset_id": dataset_id,
        "dataset_name": dataset_obj.name,
        "views": views_data,
        "explores": explores_data,
        "generated": False,
    }


def add_join(
    db: Session,
    dataset_id: int,
    from_view_id: int,
    to_view_id: int,
    from_column: str,
    to_column: str,
    join_type: str = "left",
    relationship: str = "many_to_one",
) -> dict:
    """
    Add (or update) a join from one semantic view to another.
    Finds the SemanticExplore for from_view and appends/replaces the join entry.
    """
    from_view = db.query(SemanticView).filter(SemanticView.id == from_view_id).first()
    to_view = db.query(SemanticView).filter(SemanticView.id == to_view_id).first()

    if not from_view or not to_view:
        raise ValueError("One or both views not found")
    if from_view_id == to_view_id:
        raise ValueError("Cannot join a view to itself")

    # Validate both views belong to this dataset/model scope.
    from_table = db.query(DatasetTable).filter(
        DatasetTable.id == from_view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not from_table:
        raise ValueError("Views do not belong to this dataset")

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if not model:
        raise ValueError("No semantic model found - generate the model first")

    if to_view.dataset_table_id is not None:
        to_table = db.query(DatasetTable).filter(
            DatasetTable.id == to_view.dataset_table_id,
            DatasetTable.dataset_id == dataset_id,
        ).first()
        if not to_table:
            raise ValueError("Views do not belong to this dataset")
    else:
        visible_view_names = {explore.base_view_name for explore in model.explores}
        for explore in model.explores:
            for join in explore.joins or []:
                if join.get("view"):
                    visible_view_names.add(str(join.get("view")))
        if to_view.name not in visible_view_names:
            raise ValueError("Views do not belong to this dataset")

    explore = db.query(SemanticExplore).filter(
        SemanticExplore.model_id == model.id,
        SemanticExplore.base_view_id == from_view_id,
    ).first()
    if not explore:
        # Create the explore if missing
        explore = SemanticExplore(
            name=from_view.name,
            model_id=model.id,
            base_view_id=from_view_id,
            base_view_name=from_view.name,
            joins=[],
        )
        db.add(explore)
        db.flush()

    joins = list(explore.joins or [])
    new_join = {
        "name": to_view.name,
        "view": to_view.name,
        "type": join_type,
        "sql_on": f"${{TABLE}}.{from_column} = ${{{to_view.name}}}.{to_column}",
        "relationship": relationship,
        "from_view": from_view.name,
        "from_column": from_column,
        "to_column": to_column,
    }

    # Update an exact existing join, otherwise append so one pair of tables can
    # carry multiple explicit relationships on different columns.
    for i, j in enumerate(joins):
        existing_from, existing_to = _parse_join_columns(j.get("sql_on"))
        join_from = _clean_join_identifier(j.get("from_column")) or existing_from
        join_to = _clean_join_identifier(j.get("to_column")) or existing_to
        if (
            j.get("view") == to_view.name
            and join_from == from_column
            and join_to == to_column
        ):
            joins[i] = new_join
            break
    else:
        joins.append(new_join)

    explore.joins = joins
    db.commit()
    db.refresh(explore)
    return {
        "explore_id": explore.id,
        "base_view_name": explore.base_view_name,
        "joins": explore.joins,
    }


def remove_join(
    db: Session,
    dataset_id: int,
    from_view_id: int,
    to_view_name: str,
    from_column: str | None = None,
    to_column: str | None = None,
) -> dict:
    """Remove a join from one semantic view to another."""
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if not model:
        raise ValueError("No semantic model found for this dataset")

    explore = db.query(SemanticExplore).filter(
        SemanticExplore.model_id == model.id,
        SemanticExplore.base_view_id == from_view_id,
    ).first()
    if not explore:
        raise ValueError("Explore not found for this view")

    normalized_from = _clean_join_identifier(from_column)
    normalized_to = _clean_join_identifier(to_column)

    def should_remove(join: dict) -> bool:
        if join.get("view") != to_view_name:
            return False
        if normalized_from is None and normalized_to is None:
            return True

        parsed_from, parsed_to = _parse_join_columns(join.get("sql_on"))
        join_from = _clean_join_identifier(join.get("from_column")) or parsed_from
        join_to = _clean_join_identifier(join.get("to_column")) or parsed_to
        return join_from == normalized_from and join_to == normalized_to

    matching_joins = [join for join in (explore.joins or []) if should_remove(join)]
    if any(join.get("managed") or join.get("origin") in {"auto_fk", "auto_calendar"} for join in matching_joins):
        raise ValueError("System-managed relationships cannot be removed manually")

    explore.joins = [j for j in (explore.joins or []) if not should_remove(j)]
    db.commit()
    return {
        "explore_id": explore.id,
        "base_view_name": explore.base_view_name,
        "joins": explore.joins,
    }


def get_distinct_field_values(
    db: Session,
    dataset_id: int,
    field: str,
    limit: int = 200,
) -> list[str]:
    if "." not in field:
        raise ValueError("Field must be qualified as view.field")

    view_name, field_name = field.split(".", 1)
    limit = max(1, min(int(limit), 500))

    view = db.query(SemanticView).filter(SemanticView.name == view_name).first()
    if not view:
        raise ValueError(f"View '{view_name}' not found")

    from app.core.crypto import decrypt_config
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _estimate_bigquery_bytes,
        _quote_identifier,
        build_dataset_table_cache_identifier,
        build_live_base_query_plan,
    )

    cache_payload = {
        "field": field_name,
        "limit": limit,
    }

    def execute_distinct_sql(datasource_obj, table_identifier: str, sql: str) -> list[str]:
        ds_type = datasource_obj.type if isinstance(datasource_obj.type, str) else datasource_obj.type.value
        cached = query_cache.get_cached(
            datasource_obj.id,
            table_identifier,
            "model_distinct_values",
            cache_payload,
            [],
        )
        if cached is not None:
            return list(cached.get("values") or [])

        if ds_type == "bigquery":
            estimated_bytes = _estimate_bigquery_bytes(decrypt_config(datasource_obj.config), sql)
            max_bytes = settings.BQ_MAX_BYTES_SCANNED
            if estimated_bytes > max_bytes:
                gb_est = estimated_bytes / (1024**3)
                gb_max = max_bytes / (1024**3)
                raise ValueError(
                    f"Distinct values query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                    "Add a narrower filter or avoid loading high-cardinality suggestions."
                )

        _, rows, _ = DataSourceConnectionService.execute_query(
            ds_type,
            datasource_obj.config,
            sql,
            timeout_seconds=60 if ds_type == "bigquery" else 30,
            skip_bigquery_cost_check=True,
        )
        values = _coerce_distinct_values(rows)
        query_cache.set_cached(
            datasource_obj.id,
            table_identifier,
            "model_distinct_values",
            cache_payload,
            [],
            {"values": values},
        )
        return values

    if view.dataset_table_id is None:
        sql_source = str(view.sql_table_name or "").strip()
        if not sql_source:
            raise ValueError(f"View '{view_name}' not found")

        # Find a datasource from the dataset to execute the query against
        ds_table = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id, DatasetTable.datasource_id.isnot(None))
            .first()
        )
        if ds_table is None:
            raise ValueError(f"No datasource available for view '{view_name}'")
        datasource_for_view = db.query(DataSource).filter(DataSource.id == ds_table.datasource_id).first()
        if datasource_for_view is None:
            raise ValueError(f"No datasource available for view '{view_name}'")

        ds_type = datasource_for_view.type if isinstance(datasource_for_view.type, str) else datasource_for_view.type.value
        dialect = _dialect_for_ds_type(ds_type)
        quoted_field = _quote_identifier(field_name, dialect)
        base_table = f"{sql_source} AS _q" if sql_source.startswith("(") else sql_source
        sql = (
            f"SELECT DISTINCT {quoted_field} AS value "
            f"FROM {base_table} "
            f"WHERE {quoted_field} IS NOT NULL "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )
        source_hash = hashlib.sha1(sql_source.encode("utf-8")).hexdigest()[:16]
        table_identifier = f"semantic_view:{view_name}:{source_hash}"
        return execute_distinct_sql(datasource_for_view, table_identifier, sql)

    db_table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not db_table:
        raise ValueError(f"View '{view_name}' does not belong to dataset {dataset_id}")
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset_obj is None:
        raise ValueError(f"Dataset {dataset_id} not found")

    if is_generated_calendar_table(db_table):
        # Find a datasource from the dataset to execute the calendar query against
        cal_ds_table = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id, DatasetTable.datasource_id.isnot(None))
            .first()
        )
        if cal_ds_table is None:
            raise ValueError("No datasource available for calendar table execution")
        cal_datasource = db.query(DataSource).filter(DataSource.id == cal_ds_table.datasource_id).first()
        if cal_datasource is None:
            raise ValueError("No datasource available for calendar table execution")

        ds_type = cal_datasource.type if isinstance(cal_datasource.type, str) else cal_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        quoted_field = _quote_identifier(field_name, dialect)
        calendar_settings = get_calendar_settings(dataset_obj, enabled_default=False)
        cal_sql = build_calendar_live_sql(calendar_settings, dialect)
        sql = (
            f"SELECT DISTINCT {quoted_field} AS value "
            f"FROM ({cal_sql}) AS _q "
            f"WHERE {quoted_field} IS NOT NULL "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )
        table_identifier = f"calendar_view:{dataset_id}:{view_name}"
        return execute_distinct_sql(cal_datasource, table_identifier, sql)

    live_table = db_table
    datasource = (
        db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if db_table.datasource_id is not None
        else None
    )
    if datasource is None and is_derived_table(db_table):
        from app.services.dataset_table_sql_service import (
            DatasetTableSqlError,
            build_live_proxy_table_for_dataset_table,
        )

        try:
            datasource, live_table = build_live_proxy_table_for_dataset_table(db, dataset_obj, db_table)
        except DatasetTableSqlError as exc:
            raise ValueError(str(exc)) from exc

    def fetch_live_values() -> list[str]:
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        quoted_field = _quote_identifier(field_name, dialect)
        plan = build_live_base_query_plan(datasource, live_table, apply_type_overrides=True)
        sql = (
            f"SELECT DISTINCT {quoted_field} AS value "
            f"FROM ({plan.sql}) AS _appbi_distinct "
            f"WHERE {quoted_field} IS NOT NULL "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )
        table_identifier = build_dataset_table_cache_identifier(live_table)
        return execute_distinct_sql(datasource, table_identifier, sql)

    if datasource is None:
        raise ValueError("Data source not found")
    return fetch_live_values()
