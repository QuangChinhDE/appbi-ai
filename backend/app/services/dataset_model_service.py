"""
Dataset Model Service
Auto-generates semantic layer (views, model, explores) from dataset tables.
Each dataset = 1 Data Mart with its own semantic model.
"""
from collections import deque
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
    exclude_calendar_join,
    get_calendar_role_view_display,
    get_calendar_settings,
    is_calendar_join_excluded,
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

_INTEGER_TYPES = {"integer", "int", "bigint", "smallint", "tinyint"}
_NUMERIC_MEASURE_TYPES = {"float", "number", "numeric", "decimal", "double", "real"}

# FK naming heuristics: columns ending with these suffixes are likely foreign keys
_FK_SUFFIXES = ("_id", "_pk", "_fk", "_key")
_AUTO_JOIN_ORIGINS = {"auto_fk", "auto_calendar"}
_VALID_JOIN_TYPES = {"left", "inner", "right", "full"}
_VALID_RELATIONSHIP_TYPES = {
    "one_to_one",
    "one_to_many",
    "many_to_one",
    "many_to_many",
}


_JOIN_SQL_ON_RE = re.compile(r"\$\{TABLE\}\.([^\s=]+)\s*=\s*\$\{[^}]+\}\.([^\s=]+)")


def _singularize(name: str) -> str:
    """Basic English singularization for FK detection."""
    base = name.split(".")[-1] if "." in name else name
    if base.endswith("ies"):
        return base[:-3] + "y"
    if base.endswith("s") and not base.endswith("ss"):
        return base[:-1]
    return base


def _default_field_label(column_name: str) -> str:
    return str(column_name or "")


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

        if col_type in _INTEGER_TYPES:
            dimensions.append({
                "name": col_name,
                "type": "number",
                "sql": col_name,
                "label": _default_field_label(col_name),
                "description": None,
                "hidden": False,
            })
        elif col_type in _NUMERIC_MEASURE_TYPES:
            # Decimal / floating point numeric → measure (default SUM)
            measures.append({
                "name": col_name,
                "type": "sum",
                "sql": col_name,
                "expression": None,
                "filters": [],
                "where_sql": None,
                "depends_on": [],
                "format": None,
                "folder": None,
                "label": _default_field_label(col_name),
                "description": None,
                "hidden": False,
            })
            # Also add as dimension for GROUP BY flexibility
            dimensions.append({
                "name": col_name,
                "type": "number",
                "sql": col_name,
                "label": _default_field_label(col_name),
                "description": None,
                "hidden": True,  # Hidden by default since it's primarily a measure
            })
        elif col_type in _TYPE_MAP_DIMENSION:
            dim_type = _TYPE_MAP_DIMENSION[col_type]
            dimensions.append({
                "name": col_name,
                "type": dim_type,
                "sql": col_name,
                "label": _default_field_label(col_name),
                "description": None,
                "hidden": False,
            })
        else:
            # Default to string dimension
            dimensions.append({
                "name": col_name,
                "type": "string",
                "sql": col_name,
                "label": _default_field_label(col_name),
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
            "expression": None,
            "filters": [],
            "where_sql": None,
            "depends_on": [],
            "format": None,
            "folder": None,
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


def _normalize_join_type(join_type: str | None) -> str:
    normalized = str(join_type or "").strip().lower()
    if normalized not in _VALID_JOIN_TYPES:
        return "left"
    return normalized


def _normalize_relationship_type(relationship: str | None) -> str:
    normalized = str(relationship or "").strip().lower()
    if normalized not in _VALID_RELATIONSHIP_TYPES:
        return "many_to_one"
    return normalized


def _infer_relationship_from_uniqueness(
    from_unique: bool,
    to_unique: bool,
) -> str:
    if from_unique and to_unique:
        return "one_to_one"
    if from_unique:
        return "one_to_many"
    if to_unique:
        return "many_to_one"
    return "many_to_many"


def _heuristic_relationship_for_columns(from_column: str, to_column: str) -> str:
    normalized_from = _clean_join_identifier(from_column) or ""
    normalized_to = _clean_join_identifier(to_column) or ""
    lower_from = normalized_from.lower()
    lower_to = normalized_to.lower()
    if lower_from == "id" and lower_to == "id":
        return "one_to_one"
    if lower_to == "id":
        return "many_to_one"
    if lower_from == "id":
        return "one_to_many"
    if any(lower_from.endswith(suffix) for suffix in _FK_SUFFIXES):
        return "many_to_one"
    return "many_to_one"


def _build_join_adjacency(model: SemanticModel) -> dict[str, set[str]]:
    adjacency: dict[str, set[str]] = {}
    for explore in model.explores or []:
        base_view_name = str(getattr(explore, "base_view_name", "") or "").strip()
        if not base_view_name:
            continue
        adjacency.setdefault(base_view_name, set())
        for join in explore.joins or []:
            source_view_name = str(join.get("from_view") or base_view_name).strip()
            target_view_name = str(join.get("view") or "").strip()
            if not source_view_name or not target_view_name:
                continue
            adjacency.setdefault(source_view_name, set()).add(target_view_name)
            adjacency.setdefault(target_view_name, set())
    return adjacency


def _has_join_path(
    adjacency: dict[str, set[str]],
    start_view_name: str,
    target_view_name: str,
) -> bool:
    if start_view_name == target_view_name:
        return True
    visited: set[str] = {start_view_name}
    queue: deque[str] = deque([start_view_name])
    while queue:
        current = queue.popleft()
        for neighbor in adjacency.get(current, set()):
            if neighbor == target_view_name:
                return True
            if neighbor in visited:
                continue
            visited.add(neighbor)
            queue.append(neighbor)
    return False


def _would_create_join_cycle(
    model: SemanticModel,
    from_view_name: str,
    to_view_name: str,
) -> bool:
    adjacency = _build_join_adjacency(model)
    adjacency.setdefault(from_view_name, set())
    adjacency.setdefault(to_view_name, set())
    return _has_join_path(adjacency, to_view_name, from_view_name)


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


def _source_columns_for_transformations(table: DatasetTable) -> list[str] | None:
    raw_cache = getattr(table, "columns_cache", None)
    if isinstance(raw_cache, dict):
        source_columns = raw_cache.get("source_columns")
        if isinstance(source_columns, list):
            normalized = [str(item) for item in source_columns if str(item).strip()]
            if normalized:
                return normalized
        raw_columns = raw_cache.get("columns")
        if isinstance(raw_columns, list):
            normalized = [
                str(item.get("name") or "").strip()
                for item in raw_columns
                if isinstance(item, dict) and str(item.get("name") or "").strip()
            ]
            if normalized:
                return normalized
    elif isinstance(raw_cache, list):
        normalized = [
            str(item.get("name") or "").strip()
            for item in raw_cache
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ]
        if normalized:
            return normalized
    return None


def _apply_semantic_transformations(base_query: str, table: DatasetTable, *, dialect: str) -> str:
    from app.services.transformation_compiler import TransformationCompiler

    server_transforms = TransformationCompiler.normalize_server_transformations(
        getattr(table, "transformations", None) or []
    )
    if not server_transforms:
        return f"({base_query})"

    compiled_sql, _ = TransformationCompiler.compile_transformations(
        base_query,
        server_transforms,
        dialect=dialect,
        available_columns=_source_columns_for_transformations(table),
    )
    return f"({compiled_sql})"


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
        base_query = f"SELECT * FROM ({table.source_query}) AS _dataset_model_src"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    if table.source_kind == "physical_table" and table.source_table_name:
        base_query = f"SELECT * FROM {table.source_table_name}"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    if table.source_kind == "sql_query" and table.source_query:
        base_query = f"SELECT * FROM ({table.source_query}) AS _dataset_model_src"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    return _view_name_for_table(table)


def _semantic_fields_for_table(dataset_obj: Dataset, table: DatasetTable) -> tuple[list[dict], list[dict]]:
    if is_generated_calendar_table(table):
        return [dict(item) for item in CALENDAR_DIMENSIONS], [dict(item) for item in CALENDAR_MEASURES]
    dimensions, measures = _classify_columns(table.columns_cache or [])

    from app.services.transformation_compiler import TransformationCompiler

    existing_dimension_names = {
        str(item.get("name"))
        for item in dimensions
        if isinstance(item, dict) and item.get("name")
    }
    existing_measure_names = {
        str(item.get("name"))
        for item in measures
        if isinstance(item, dict) and item.get("name")
    }

    for step in TransformationCompiler.normalize_server_transformations(
        getattr(table, "transformations", None) or []
    ):
        if step.get("type") != "add_column":
            continue
        new_field = str((step.get("params") or {}).get("newField") or "").strip()
        if not new_field or new_field in existing_dimension_names or new_field in existing_measure_names:
            continue

        dimensions.append({
            "name": new_field,
            "type": "string",
            "sql": new_field,
            "label": _default_field_label(new_field),
            "description": None,
            "hidden": False,
        })
        existing_dimension_names.add(new_field)

    return dimensions, measures


def _field_names_for_view(view: SemanticView) -> set[str]:
    field_names: set[str] = set()
    for item in (view.dimensions or []):
        if isinstance(item, dict) and item.get("name"):
            field_names.add(str(item.get("name")))
    for item in (view.measures or []):
        if isinstance(item, dict) and item.get("name"):
            field_names.add(str(item.get("name")))
    return field_names


def _sanitize_join_definitions(
    joins: List[dict],
    *,
    base_view_name: str,
    base_fields: set[str],
    valid_target_view_names: Set[str],
) -> List[dict]:
    sanitized: List[dict] = []
    seen: Set[tuple[str, str | None, str | None]] = set()

    for join in joins or []:
        normalized = _normalize_join(join, base_view_name, base_fields)
        if not normalized:
            continue

        target_view_name = str(normalized.get("view") or "").strip()
        if not target_view_name or target_view_name not in valid_target_view_names:
            continue

        parsed_from, parsed_to = _parse_join_columns(normalized.get("sql_on"))
        join_from = _clean_join_identifier(normalized.get("from_column")) or parsed_from
        join_to = _clean_join_identifier(normalized.get("to_column")) or parsed_to
        key = (target_view_name, join_from, join_to)
        if key in seen:
            continue
        seen.add(key)
        sanitized.append(normalized)

    return sanitized


def _allocate_unique_semantic_model_name(
    db: Session,
    *,
    base_name: str,
    own_id: int | None,
) -> str:
    """Return a SemanticModel name guaranteed to be free for ``own_id``.

    Defensive against legacy DB unique indexes on ``semantic_models.name``
    (see migration 20260504_0001) and against orphan rows whose dataset was
    deleted (``dataset_id`` is NULL because of ON DELETE SET NULL). If the
    desired name is taken by a *different* model, we first try to free it by
    deleting orphans (dataset_id IS NULL), then fall back to a numeric
    suffix.
    """
    desired = base_name
    for attempt in range(20):
        candidate = desired if attempt == 0 else f"{desired} ({attempt + 1})"
        clash = (
            db.query(SemanticModel)
            .filter(SemanticModel.name == candidate)
            .filter(SemanticModel.id != (own_id or 0))
            .first()
        )
        if clash is None:
            return candidate
        # If the conflicting row is an orphan, drop it so the rebuild can
        # reclaim the name. Orphans appear when a dataset was deleted via
        # ON DELETE SET NULL on semantic_models.dataset_id.
        if clash.dataset_id is None:
            db.delete(clash)
            db.flush()
            return candidate
    # Last resort: a hash suffix that is guaranteed unique enough.
    suffix = hashlib.sha1(f"{desired}|{own_id}".encode("utf-8")).hexdigest()[:8]
    return f"{desired} [{suffix}]"


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

    def merge_existing_measures(
        generated: list[dict],
        existing: list[dict] | None,
    ) -> list[dict]:
        """Keep user-authored measure definitions when model structure syncs.

        Generated measures are derived from table columns. Once a user edits a
        measure in the semantic model, its JSON definition is the source of
        truth and should not be clobbered by a regenerate action.
        """
        existing_by_name = {
            str(item.get("name")): dict(item)
            for item in (existing or [])
            if isinstance(item, dict) and item.get("name")
        }
        merged: list[dict] = []
        seen: set[str] = set()
        for item in generated:
            name = str(item.get("name") or "")
            seen.add(name)
            merged.append(existing_by_name.get(name, item))
        for name, item in existing_by_name.items():
            if name not in seen:
                merged.append(item)
        return merged

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
        next_measures = merge_existing_measures(measures, view.measures or [])
        changed = (
            view.name != name
            or view.sql_table_name != sql_table_name
            or view.dataset_table_id != dataset_table_id
            or (view.dimensions or []) != dimensions
            or (view.measures or []) != next_measures
            or view.description != description
        )
        view.name = name
        view.sql_table_name = sql_table_name
        view.dataset_table_id = dataset_table_id
        view.dimensions = dimensions
        view.measures = next_measures
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
            if is_calendar_join_excluded(
                calendar_settings,
                view_name=source_view.name,
                column_name=column_name,
            ):
                continue
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
    """Generate or regenerate a semantic model and refresh auto-detected joins."""
    result = _sync_dataset_model_structure(
        db,
        dataset_id,
        force=force,
        create_model=True,
        refresh_auto_joins=True,
    )
    if result is None:
        raise ValueError("Dataset model could not be generated")
    return result


def sync_dataset_model_structure(
    db: Session,
    dataset_id: int,
    *,
    create_model: bool = False,
) -> Optional[dict]:
    """Sync model views/explores without creating or re-creating auto joins."""
    return _sync_dataset_model_structure(
        db,
        dataset_id,
        force=False,
        create_model=create_model,
        refresh_auto_joins=False,
    )


def _sync_dataset_model_structure(
    db: Session,
    dataset_id: int,
    *,
    force: bool,
    create_model: bool,
    refresh_auto_joins: bool,
) -> Optional[dict]:
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
    desired_model_name = _allocate_unique_semantic_model_name(
        db, base_name=f"model_{dataset_obj.name}", own_id=model.id if model else None
    )
    if not model:
        if not create_model:
            return None
        model = SemanticModel(
            name=desired_model_name,
            dataset_id=dataset_id,
            description=f"Auto-generated model for dataset: {dataset_obj.name}",
        )
        db.add(model)
        db.flush()
    else:
        model.name = desired_model_name
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

    auto_fk_joins: Dict[str, List[dict]] = {}
    auto_calendar_joins: Dict[str, List[dict]] = {}
    if refresh_auto_joins:
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

    db.flush()
    valid_target_view_names = {
        str(view.name)
        for view in db.query(SemanticView).all()
        if str(view.name or "").strip()
    }

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

        base_fields = _field_names_for_view(base_view)
        explore.name = base_view.name
        explore.base_view_name = base_view.name
        explore.base_view_id = base_view.id
        explore.description = f"Explore for {table.display_name or table.source_table_name or base_view.name}"
        if refresh_auto_joins:
            manual_joins = _sanitize_join_definitions(
                [
                    join for join in (explore.joins or [])
                    if join.get("origin") not in _AUTO_JOIN_ORIGINS
                ],
                base_view_name=base_view.name,
                base_fields=base_fields,
                valid_target_view_names=valid_target_view_names,
            )
            auto_joins = [
                *auto_fk_joins.get(base_view.name, []),
                *auto_calendar_joins.get(base_view.name, []),
            ]
            explore.joins = _merge_join_definitions(manual_joins, auto_joins)
        else:
            explore.joins = _sanitize_join_definitions(
                list(explore.joins or []),
                base_view_name=base_view.name,
                base_fields=base_fields,
                valid_target_view_names=valid_target_view_names,
            )

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
    alias: str | None = None,
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

    join_validation = suggest_join_relationship(
        db,
        dataset_id=dataset_id,
        from_view_id=from_view_id,
        to_view_id=to_view_id,
        from_column=from_column,
        to_column=to_column,
    )
    if not join_validation.get("can_create"):
        raise ValueError(str(join_validation.get("message") or "Relationship cannot be created"))

    normalized_join_type = _normalize_join_type(join_type)
    normalized_relationship = _normalize_relationship_type(relationship)
    if normalized_relationship == "many_to_many":
        raise ValueError("Many-to-many relationships are not supported")

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
    # When alias is provided, sql_on placeholders reference the alias rather
    # than the view name so role-played joins resolve correctly later.
    alias_clean = (alias or "").strip() or None
    placeholder_target = alias_clean or to_view.name
    new_join = {
        "name": alias_clean or to_view.name,
        "view": to_view.name,
        "alias": alias_clean,
        "type": normalized_join_type,
        "sql_on": f"${{TABLE}}.{from_column} = ${{{placeholder_target}}}.{to_column}",
        "relationship": normalized_relationship,
        "from_view": from_view.name,
        "from_column": from_column,
        "to_column": to_column,
    }

    # Update an exact existing join, otherwise append so one pair of tables can
    # carry multiple explicit relationships on different columns or aliases.
    for i, j in enumerate(joins):
        existing_from, existing_to = _parse_join_columns(j.get("sql_on"))
        join_from = _clean_join_identifier(j.get("from_column")) or existing_from
        join_to = _clean_join_identifier(j.get("to_column")) or existing_to
        existing_alias = (j.get("alias") or "").strip() or None
        if (
            j.get("view") == to_view.name
            and join_from == from_column
            and join_to == to_column
            and existing_alias == alias_clean
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


def _resolve_semantic_view_table(
    db: Session,
    *,
    dataset_obj: Dataset,
    dataset_id: int,
    view: SemanticView,
) -> tuple[DatasetTable, DataSource, Any]:
    db_table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if db_table is None:
        raise ValueError("Views do not belong to this dataset")

    live_table = db_table
    datasource = (
        db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if db_table.datasource_id is not None
        else None
    )

    if datasource is None or is_generated_calendar_table(db_table) or is_derived_table(db_table):
        from app.services.dataset_table_sql_service import (
            DatasetTableSqlError,
            build_live_proxy_table_for_dataset_table,
        )

        try:
            datasource, live_table = build_live_proxy_table_for_dataset_table(db, dataset_obj, db_table)
        except DatasetTableSqlError as exc:
            raise ValueError(str(exc)) from exc

    if datasource is None:
        raise ValueError(f"Data source not found for view '{view.name}'")

    return db_table, datasource, live_table


def _profile_join_column(
    db: Session,
    *,
    dataset_obj: Dataset,
    dataset_id: int,
    view: SemanticView,
    column_name: str,
) -> dict[str, Any]:
    from app.services.column_summary_service import get_column_summary

    _, datasource, live_table = _resolve_semantic_view_table(
        db,
        dataset_obj=dataset_obj,
        dataset_id=dataset_id,
        view=view,
    )
    summary = get_column_summary(datasource, live_table, column_name, top_limit=5)
    total_rows = int(summary.total_rows or 0)
    null_count = int(summary.null_count or 0)
    distinct_count = int(summary.distinct_count or 0)
    non_null_rows = max(total_rows - null_count, 0)

    has_profiled_values = non_null_rows > 0
    is_unique_non_null = has_profiled_values and distinct_count == non_null_rows
    return {
        "total_rows": total_rows,
        "null_count": null_count,
        "distinct_count": distinct_count,
        "non_null_rows": non_null_rows,
        "is_unique_non_null": is_unique_non_null if has_profiled_values else None,
        "has_profiled_values": has_profiled_values,
    }


def suggest_join_relationship(
    db: Session,
    dataset_id: int,
    from_view_id: int,
    to_view_id: int,
    from_column: str,
    to_column: str,
) -> dict[str, Any]:
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset_obj is None:
        raise ValueError("Dataset not found")

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        raise ValueError("No semantic model found - generate the model first")

    from_view = db.query(SemanticView).filter(SemanticView.id == from_view_id).first()
    to_view = db.query(SemanticView).filter(SemanticView.id == to_view_id).first()
    if from_view is None or to_view is None:
        raise ValueError("One or both views not found")
    if from_view_id == to_view_id:
        raise ValueError("Cannot join a view to itself")

    normalized_from_column = _clean_join_identifier(from_column)
    normalized_to_column = _clean_join_identifier(to_column)
    if not normalized_from_column or not normalized_to_column:
        raise ValueError("Please select join columns for both tables")

    from_fields = _field_names_for_view(from_view)
    to_fields = _field_names_for_view(to_view)
    if normalized_from_column not in from_fields:
        raise ValueError(f"Column '{normalized_from_column}' does not exist on view '{from_view.name}'")
    if normalized_to_column not in to_fields:
        raise ValueError(f"Column '{normalized_to_column}' does not exist on view '{to_view.name}'")

    from_table = db.query(DatasetTable).filter(
        DatasetTable.id == from_view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    to_table = db.query(DatasetTable).filter(
        DatasetTable.id == to_view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if from_table is None or to_table is None:
        raise ValueError("Only dataset-backed tables can be joined manually")

    blocking_code: str | None = None
    blocking_message: str | None = None
    if _would_create_join_cycle(model, from_view.name, to_view.name):
        blocking_code = "cycle_detected"
        blocking_message = (
            f"Cannot create relationship because it would create a loop in the data model "
            f"({to_view.name} already reaches {from_view.name})."
        )

    try:
        from_profile = _profile_join_column(
            db,
            dataset_obj=dataset_obj,
            dataset_id=dataset_id,
            view=from_view,
            column_name=normalized_from_column,
        )
        to_profile = _profile_join_column(
            db,
            dataset_obj=dataset_obj,
            dataset_id=dataset_id,
            view=to_view,
            column_name=normalized_to_column,
        )
    except Exception as exc:
        logger.warning(
            "Falling back to heuristic join suggestion for dataset %s (%s.%s -> %s.%s): %s",
            dataset_id,
            from_view.name,
            normalized_from_column,
            to_view.name,
            normalized_to_column,
            exc,
        )
        from_profile = {
            "total_rows": 0,
            "null_count": 0,
            "distinct_count": 0,
            "non_null_rows": 0,
            "is_unique_non_null": None,
            "has_profiled_values": False,
        }
        to_profile = {
            "total_rows": 0,
            "null_count": 0,
            "distinct_count": 0,
            "non_null_rows": 0,
            "is_unique_non_null": None,
            "has_profiled_values": False,
        }

    from_unique = from_profile.get("is_unique_non_null")
    to_unique = to_profile.get("is_unique_non_null")
    inference_mode = "profiled"
    if isinstance(from_unique, bool) and isinstance(to_unique, bool):
        suggested_relationship = _infer_relationship_from_uniqueness(from_unique, to_unique)
    else:
        inference_mode = "heuristic"
        suggested_relationship = _heuristic_relationship_for_columns(
            normalized_from_column,
            normalized_to_column,
        )

    if blocking_code is None and suggested_relationship == "many_to_many":
        blocking_code = "many_to_many"
        blocking_message = (
            "Cannot create relationship because both join columns contain duplicate non-null values, "
            "so this join is many-to-many."
        )

    return {
        "relationship": suggested_relationship,
        "from_unique": from_unique,
        "to_unique": to_unique,
        "from_non_null_rows": from_profile.get("non_null_rows"),
        "to_non_null_rows": to_profile.get("non_null_rows"),
        "from_distinct_count": from_profile.get("distinct_count"),
        "to_distinct_count": to_profile.get("distinct_count"),
        "inference_mode": inference_mode,
        "can_create": blocking_code is None,
        "blocking_code": blocking_code,
        "message": blocking_message,
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
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise ValueError("Dataset not found")

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
    blocked_joins = [
        join
        for join in matching_joins
        if join.get("managed") and join.get("origin") not in _AUTO_JOIN_ORIGINS
    ]
    if blocked_joins:
        raise ValueError("System-managed relationships cannot be removed manually")

    auto_calendar_joins = [
        join for join in matching_joins if join.get("origin") == "auto_calendar"
    ]
    for join in auto_calendar_joins:
        parsed_from, _ = _parse_join_columns(join.get("sql_on"))
        source_field = (
            _clean_join_identifier(join.get("calendar_source_field"))
            or _clean_join_identifier(join.get("from_column"))
            or parsed_from
        )
        if source_field:
            exclude_calendar_join(
                dataset_obj,
                view_name=explore.base_view_name,
                column_name=source_field,
            )

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
    filters: list[dict] | None = None,
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
        _sql_literal,
        build_dataset_table_cache_identifier,
    )
    from app.services.chart_contracts import normalize_filter_conditions, normalize_filter_operator
    from app.services.dataset_relation_service import resolve_dataset_table_relation

    cache_payload = {
        "field": field_name,
        "limit": limit,
        "filters": normalize_filter_conditions(filters or []),
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

    def _qualified_filter_refs(filter_condition: dict) -> list[tuple[str, str]]:
        refs: list[tuple[str, str]] = []

        def add_ref(raw_value) -> None:
            raw = str(raw_value or "").strip()
            if not raw:
                return
            if "." in raw:
                node, name = raw.split(".", 1)
                node = node.strip()
                name = name.strip()
                if node and name and (node, name) not in refs:
                    refs.append((node, name))
                return
            if (view_name, raw) not in refs:
                refs.append((view_name, raw))

        for key in ("semanticField", "fieldKey", "field"):
            add_ref(filter_condition.get(key))
        linked_fields = filter_condition.get("linkedFields")
        if isinstance(linked_fields, list):
            for linked_field in linked_fields:
                add_ref(linked_field)
        return refs

    def _render_filter_condition(field_expression: str, filter_condition: dict) -> str | None:
        op = normalize_filter_operator(filter_condition.get("operator"))
        value = filter_condition.get("value")

        def value_present(candidate) -> bool:
            return candidate is not None and not (isinstance(candidate, str) and not candidate.strip())

        if op == "eq":
            return f"{field_expression} = {_sql_literal(value)}"
        if op == "neq":
            return f"{field_expression} != {_sql_literal(value)}"
        if op == "gt":
            return f"{field_expression} > {_sql_literal(value)}"
        if op == "gte":
            return f"{field_expression} >= {_sql_literal(value)}"
        if op == "lt":
            return f"{field_expression} < {_sql_literal(value)}"
        if op == "lte":
            return f"{field_expression} <= {_sql_literal(value)}"
        if op == "between" and isinstance(value, list):
            lo = value[0] if len(value) > 0 else None
            hi = value[1] if len(value) > 1 else None
            if value_present(lo) and value_present(hi):
                return f"{field_expression} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}"
            if value_present(lo):
                return f"{field_expression} >= {_sql_literal(lo)}"
            if value_present(hi):
                return f"{field_expression} <= {_sql_literal(hi)}"
            return None
        if op in {"in", "not_in"} and isinstance(value, list):
            vals = ", ".join(_sql_literal(item) for item in value if value_present(item))
            if not vals:
                return None
            keyword = "IN" if op == "in" else "NOT IN"
            return f"{field_expression} {keyword} ({vals})"
        if op in {"like", "contains", "not_contains", "starts_with"} and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            if op == "not_contains":
                return f"{field_expression} NOT LIKE '%{esc}%' ESCAPE '\\'"
            if op == "starts_with":
                return f"{field_expression} LIKE '{esc}%' ESCAPE '\\'"
            return f"{field_expression} LIKE '%{esc}%' ESCAPE '\\'"
        if op == "is_null":
            return f"{field_expression} IS NULL"
        if op == "is_not_null":
            return f"{field_expression} IS NOT NULL"
        return None

    def _build_distinct_sql(
        base_sql: str,
        datasource_obj,
        dialect: str,
    ) -> str:
        base_alias = "_appbi_base"
        target_expr = f"{base_alias}.{_quote_identifier(field_name, dialect)}"
        normalized_filters = [
            item
            for item in normalize_filter_conditions(filters or [])
            if item.get("datasetId") in (None, dataset_id)
        ]
        if not normalized_filters:
            return (
                f"SELECT DISTINCT {target_expr} AS value "
                f"FROM ({base_sql}) AS {base_alias} "
                f"WHERE {target_expr} IS NOT NULL "
                f"ORDER BY 1 "
                f"LIMIT {limit}"
            )

        from app.services.chart_service import (
            _build_live_relation_for_semantic_view,
            _render_step_join_condition,
            _semantic_view_has_field,
            _wrap_live_sql_relation,
        )
        from app.services.semantic_join_resolver import SemanticJoinResolver

        model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
        resolver = SemanticJoinResolver(db, model, view_name)
        view_cache: dict[str, SemanticView | None] = {}
        materialized_steps: dict[tuple[str, str], str] = {}
        join_clauses: list[str] = []
        next_join_index = 0

        def _get_view(node_or_view: str) -> SemanticView | None:
            actual_view = resolver.view_for_node(node_or_view) or node_or_view
            if actual_view in view_cache:
                return view_cache[actual_view]
            result = db.query(SemanticView).filter(SemanticView.name == actual_view).first()
            view_cache[actual_view] = result
            return result

        def _alias_for_node(node: str) -> str | None:
            nonlocal next_join_index
            if node == view_name:
                return base_alias
            path = resolver.resolve_path(node)
            if path is None:
                return None

            prev_alias = base_alias
            last_alias = prev_alias
            for step in path.steps:
                cache_key = (prev_alias, step.edge.to_node)
                existing_alias = materialized_steps.get(cache_key)
                if existing_alias is not None:
                    last_alias = existing_alias
                    prev_alias = existing_alias
                    continue

                joined_view = _get_view(step.edge.to_node)
                if joined_view is None:
                    return None
                relation = _build_live_relation_for_semantic_view(db, datasource_obj, joined_view)
                if not relation:
                    return None
                new_alias = f"_appbi_distinct_join_{next_join_index}"
                next_join_index += 1
                condition = _render_step_join_condition(
                    step.edge,
                    from_alias=prev_alias,
                    to_alias=new_alias,
                )
                to_col = step.edge.to_column
                if condition and to_col and not _semantic_view_has_field(joined_view, to_col):
                    from_col = step.edge.from_column
                    if from_col and _semantic_view_has_field(joined_view, from_col):
                        condition = f"{prev_alias}.{from_col} = {new_alias}.{from_col}"
                    else:
                        condition = None
                if not condition:
                    return None
                join_kw = (step.edge.type or "left").upper()
                join_clauses.append(
                    f"{join_kw} JOIN {_wrap_live_sql_relation(relation)} AS {new_alias} "
                    f"ON {condition}"
                )
                materialized_steps[cache_key] = new_alias
                last_alias = new_alias
                prev_alias = new_alias

            return last_alias

        filter_conditions: list[str] = []
        for filter_condition in normalized_filters:
            for node, name in _qualified_filter_refs(filter_condition):
                alias = _alias_for_node(node)
                if not alias:
                    continue
                view_obj = _get_view(node)
                if view_obj is not None and not _semantic_view_has_field(view_obj, name):
                    continue
                expression = f"{alias}.{_quote_identifier(name, dialect)}"
                condition = _render_filter_condition(expression, filter_condition)
                if condition:
                    filter_conditions.append(condition)
                    break

        where_parts = [f"{target_expr} IS NOT NULL", *filter_conditions]
        joins = " ".join(join_clauses)
        return (
            f"SELECT DISTINCT {target_expr} AS value "
            f"FROM ({base_sql}) AS {base_alias} "
            f"{joins} "
            f"WHERE {' AND '.join(where_parts)} "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )

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
        base_relation = f"{sql_source} AS _q" if sql_source.startswith("(") else sql_source
        base_sql = f"SELECT * FROM {base_relation}"
        sql = _build_distinct_sql(base_sql, datasource_for_view, dialect)
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
        calendar_settings = get_calendar_settings(dataset_obj, enabled_default=False)
        cal_sql = build_calendar_live_sql(calendar_settings, dialect)
        sql = _build_distinct_sql(cal_sql, cal_datasource, dialect)
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
        plan = resolve_dataset_table_relation(datasource, live_table)
        sql = _build_distinct_sql(plan.sql, datasource, dialect)
        table_identifier = build_dataset_table_cache_identifier(live_table)
        return execute_distinct_sql(datasource, table_identifier, sql)

    if datasource is None:
        raise ValueError("Data source not found")
    return fetch_live_values()
