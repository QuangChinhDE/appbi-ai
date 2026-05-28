"""
Dataset Model Service
Auto-generates semantic layer (views, model, explores) from dataset tables.
Each dataset = 1 Data Mart with its own semantic model.
"""
from collections import deque
import hashlib
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from sqlalchemy import or_
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


_JOIN_SQL_ON_RE = re.compile(r"\$\{TABLE\}\.([^\s=()]+)\s*=\s*\$\{[^}]+\}\.([^\s=()]+)")


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


def _classify_columns(
    columns_cache,
    *,
    auto_generate_measures: bool = False,
) -> Tuple[list, list]:
    """
    Classify cached columns into dimensions and measures.
    columns_cache can be a dict {"columns": [...]} or a list of dicts.
    Returns: (dimensions_list, measures_list) as dicts ready for JSON storage.

    Measures are only emitted when ``auto_generate_measures`` is True. The
    default is False — users now add measures explicitly from the Measures
    panel. Numeric columns always become dimensions (visible) regardless.
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
            if auto_generate_measures:
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
            dimensions.append({
                "name": col_name,
                "type": "number",
                "sql": col_name,
                "label": _default_field_label(col_name),
                "description": None,
                # When the auto-measure pair is generated, keep the dimension
                # hidden so the UI shows the measure first. Otherwise expose
                # it as a regular numeric dimension.
                "hidden": bool(auto_generate_measures),
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

    if auto_generate_measures:
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


def _clean_join_identifier_values(raw_values: Any) -> list[str]:
    if raw_values is None:
        return []
    if isinstance(raw_values, str):
        values = [raw_values]
    elif isinstance(raw_values, (list, tuple, set)):
        values = list(raw_values)
    else:
        values = [raw_values]

    cleaned: list[str] = []
    for value in values:
        normalized = _clean_join_identifier(value)
        if normalized:
            cleaned.append(normalized)
    return cleaned


def _dedupe_join_pairs(pairs: list[tuple[str | None, str | None]]) -> list[tuple[str, str]]:
    deduped: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw_from, raw_to in pairs:
        from_column = _clean_join_identifier(raw_from)
        to_column = _clean_join_identifier(raw_to)
        if not from_column or not to_column:
            continue
        pair = (from_column, to_column)
        if pair in seen:
            continue
        seen.add(pair)
        deduped.append(pair)
    return deduped


def _parse_join_column_pairs(sql_on: str | None) -> list[tuple[str, str]]:
    if not sql_on:
        return []
    return _dedupe_join_pairs(
        [
            (_clean_join_identifier(match.group(1)), _clean_join_identifier(match.group(2)))
            for match in _JOIN_SQL_ON_RE.finditer(sql_on)
        ]
    )


def _parse_join_columns(sql_on: str | None) -> tuple[str | None, str | None]:
    pairs = _parse_join_column_pairs(sql_on)
    if not pairs:
        return None, None
    return pairs[0]


def _normalize_requested_join_columns(
    *,
    from_columns: Any = None,
    to_columns: Any = None,
    from_column: str | None = None,
    to_column: str | None = None,
    require_pairs: bool = True,
) -> tuple[list[str], list[str]]:
    normalized_from = _clean_join_identifier_values(from_columns)
    normalized_to = _clean_join_identifier_values(to_columns)

    if not normalized_from and from_column is not None:
        cleaned_from = _clean_join_identifier(from_column)
        if cleaned_from:
            normalized_from = [cleaned_from]
    if not normalized_to and to_column is not None:
        cleaned_to = _clean_join_identifier(to_column)
        if cleaned_to:
            normalized_to = [cleaned_to]

    if not normalized_from and not normalized_to and not require_pairs:
        return [], []
    if not normalized_from or not normalized_to:
        raise ValueError("Please select join columns for both tables")
    if len(normalized_from) != len(normalized_to):
        raise ValueError("Join key definitions must have the same number of source and target columns")

    pairs = _dedupe_join_pairs(list(zip(normalized_from, normalized_to)))
    if not pairs and require_pairs:
        raise ValueError("Please select join columns for both tables")
    return [pair[0] for pair in pairs], [pair[1] for pair in pairs]


def _join_columns_from_definition(join: dict[str, Any]) -> tuple[list[str], list[str]]:
    pairs = _dedupe_join_pairs(
        list(
            zip(
                _clean_join_identifier_values(join.get("from_columns")),
                _clean_join_identifier_values(join.get("to_columns")),
            )
        )
    )
    if not pairs:
        scalar_from = _clean_join_identifier(join.get("from_column"))
        scalar_to = _clean_join_identifier(join.get("to_column"))
        if scalar_from and scalar_to:
            pairs = [(scalar_from, scalar_to)]
    if not pairs:
        pairs = _parse_join_column_pairs(join.get("sql_on"))
    return [pair[0] for pair in pairs], [pair[1] for pair in pairs]


def _join_pairs_signature(from_columns: list[str], to_columns: list[str]) -> tuple[tuple[str, str], ...]:
    return tuple((from_columns[index], to_columns[index]) for index in range(min(len(from_columns), len(to_columns))))


def _build_join_sql_on(
    *,
    target_placeholder: str,
    from_columns: list[str],
    to_columns: list[str],
) -> str:
    return " AND ".join(
        f"${{TABLE}}.{from_columns[index]} = ${{{target_placeholder}}}.{to_columns[index]}"
        for index in range(min(len(from_columns), len(to_columns)))
    )


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


def _ensure_no_chart_depends_on_join(
    db: Session,
    *,
    dataset_id: int,
    join_view_name: str,
    join_alias: str | None,
) -> None:
    """Reject deactivation of a join when at least one chart still uses it.

    A chart "uses" a join when its config JSON mentions the joined view name
    or alias as a qualifier (e.g. ``users.email`` or ``creator.name``). The
    check is intentionally substring-based: it's conservative (a couple of
    false positives are fine — they only warn) and side-steps having to know
    every chart config dialect.
    """
    import json as _json
    from app.models.dataset import DatasetTable
    from app.models.models import Chart

    qualifiers = {join_view_name.strip()}
    if join_alias:
        qualifiers.add(join_alias.strip())
    qualifiers = {q for q in qualifiers if q}
    if not qualifiers:
        return

    charts = (
        db.query(Chart)
        .join(DatasetTable, Chart.dataset_table_id == DatasetTable.id, isouter=True)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    hits: list[str] = []
    for chart in charts:
        try:
            config_text = _json.dumps(chart.config or {}, ensure_ascii=False)
        except (TypeError, ValueError):
            config_text = str(chart.config or "")
        for q in qualifiers:
            # Match qualified field reference patterns: "qualifier." or
            # "qualifier"<colon|quote-close> in JSON. Plain substring is
            # acceptable for a guard rail — the user can always remove the
            # chart binding then retry.
            if f'"{q}.' in config_text or f"{q}." in config_text:
                hits.append(f"Chart \"{chart.name}\" (id={chart.id})")
                break

    if hits:
        # Raise with a structured payload so the API layer can serialise it
        # as a 409 with `code`, `message`, `affected_charts` — matching the
        # other Phase-3 cascade flows. We attach the data on the exception
        # via a custom attribute that the caller inspects.
        err = ValueError(
            f"{len(hits)} chart đang dùng field từ \"{join_view_name}\". "
            "Xác nhận để tắt quan hệ (chart cần sửa lại sau)."
        )
        err.cascade_payload = {  # type: ignore[attr-defined]
            "code": "JOIN_INACTIVE_CASCADE",
            "message": (
                f"{len(hits)} chart đang dùng field từ \"{join_view_name}\". "
                "Xác nhận để tắt quan hệ (chart cần sửa lại sau)."
            ),
            "join_view": join_view_name,
            "join_alias": join_alias,
            "affected_charts": hits,
        }
        raise err


def _build_join_adjacency(model: SemanticModel) -> dict[str, set[str]]:
    adjacency: dict[str, set[str]] = {}
    for explore in model.explores or []:
        base_view_name = str(getattr(explore, "base_view_name", "") or "").strip()
        if not base_view_name:
            continue
        adjacency.setdefault(base_view_name, set())
        for join in explore.joins or []:
            # Phase-3b: inactive joins are stored but ignored for graph
            # operations (path resolution, cycle detection). Default True
            # for legacy joins missing the flag.
            raw_active = join.get("is_active")
            if raw_active is not None and not bool(raw_active):
                continue
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
    from_columns, to_columns = _join_columns_from_definition(normalized)
    from_column = from_columns[0] if from_columns else None
    to_column = to_columns[0] if to_columns else None

    if normalized.get("from_view") and normalized.get("from_view") != base_view_name:
        return None

    if base_fields is not None:
        for candidate in from_columns:
            if candidate not in base_fields:
                return None

    normalized["from_view"] = base_view_name
    normalized["from_columns"] = from_columns
    normalized["to_columns"] = to_columns
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


def _sql_table_for_table(
    dataset_obj: Dataset,
    table: DatasetTable,
    *,
    calendar_dialect: str,
    datasource: DataSource | None = None,
) -> str:
    """Build the SQL fragment used as a SemanticView's `sql_table_name`.

    For BigQuery physical tables we MUST emit a fully-qualified reference
    (`project.dataset.table`) — bare table names produce the runtime error
    "Table 'X' must be qualified with a dataset" when the semantic engine
    constructs JOINs. We piggy-back on live_query_service._build_base_table_ref
    so the qualification logic stays in one place.
    """
    if is_generated_calendar_table(table):
        settings = get_calendar_settings(dataset_obj, enabled_default=False)
        return f"({build_calendar_live_sql(settings, calendar_dialect)})"
    if is_derived_table(table) and table.source_query:
        base_query = f"SELECT * FROM ({table.source_query}) AS _dataset_model_src"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    if table.source_kind == "physical_table" and table.source_table_name:
        qualified_ref = _qualified_table_reference(table, datasource, calendar_dialect)
        base_query = f"SELECT * FROM {qualified_ref}"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    if table.source_kind == "sql_query" and table.source_query:
        base_query = f"SELECT * FROM ({table.source_query}) AS _dataset_model_src"
        return _apply_semantic_transformations(base_query, table, dialect=calendar_dialect)
    return _view_name_for_table(table)


def _qualified_table_reference(
    table: DatasetTable,
    datasource: DataSource | None,
    dialect: str,
) -> str:
    """Resolve a physical table reference appropriate for `dialect`.

    Falls back to the raw `source_table_name` if the datasource is missing
    (preserves legacy behaviour) so callers without a datasource handle
    don't crash.
    """
    raw = table.source_table_name or ""
    if not raw or datasource is None:
        return raw
    try:
        from app.services.live_query_service import _build_base_table_ref
    except Exception:
        return raw
    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    config = getattr(datasource, "config", None) or {}
    try:
        return _build_base_table_ref(ds_type, config, raw, dialect)
    except Exception:
        # Defensive: BigQuery decrypt_config may fail when called outside the
        # request context (e.g. background workers). Fall back to the raw
        # reference rather than blowing up semantic model generation.
        return raw


def _auto_measures_enabled(dataset_obj: Dataset | Any) -> bool:
    """Read dataset.settings.auto_generate_measures (default False).

    Historically AppBI auto-inserted a COUNT measure and a SUM measure for
    every numeric column on first generate. Users found this noisy; the
    behavior is now opt-in via dataset settings.
    """
    settings = getattr(dataset_obj, "settings", None)
    if not isinstance(settings, dict):
        return False
    return bool(settings.get("auto_generate_measures", False))


def _semantic_fields_for_table(dataset_obj: Dataset, table: DatasetTable) -> tuple[list[dict], list[dict]]:
    if is_generated_calendar_table(table):
        return [dict(item) for item in CALENDAR_DIMENSIONS], [dict(item) for item in CALENDAR_MEASURES]
    dimensions, measures = _classify_columns(
        table.columns_cache or [],
        auto_generate_measures=_auto_measures_enabled(dataset_obj),
    )

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


def measure_dependencies_referencing_view(
    depends_on: Any,
    *,
    owner_view_name: str,
    target_view_name: str,
    target_measure_names: set[str],
) -> set[str]:
    """Return measure names in ``target_view_name`` referenced by depends_on.

    Bare dependency names are same-view only. Qualified ``view.measure`` refs
    can point across views.
    """
    refs: set[str] = set()
    if not isinstance(depends_on, list):
        return refs

    for raw_dep in depends_on:
        dep = str(raw_dep or "").strip()
        if not dep:
            continue
        if "." in dep:
            dep_view, dep_name = dep.split(".", 1)
            dep_view = dep_view.strip()
            dep_name = dep_name.strip()
        else:
            dep_view = owner_view_name
            dep_name = dep
        if dep_view == target_view_name and dep_name in target_measure_names:
            refs.add(dep_name)

    return refs


def _sanitize_join_definitions(
    joins: List[dict],
    *,
    base_view_name: str,
    base_fields: set[str],
    valid_target_view_names: Set[str],
) -> List[dict]:
    sanitized: List[dict] = []
    seen: Set[tuple[str, str | None, tuple[tuple[str, str], ...]]] = set()

    for join in joins or []:
        normalized = _normalize_join(join, base_view_name, base_fields)
        if not normalized:
            continue

        target_view_name = str(normalized.get("view") or "").strip()
        if not target_view_name or target_view_name not in valid_target_view_names:
            continue

        join_from_columns, join_to_columns = _join_columns_from_definition(normalized)
        join_alias = str(normalized.get("alias") or "").strip() or None
        key = (target_view_name, join_alias, _join_pairs_signature(join_from_columns, join_to_columns))
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

        Special case: if ``existing`` is an explicit empty list the user has
        intentionally cleared all measures — do NOT restore the auto-generated
        ones.  ``None`` means the view is brand-new (creation path), but we
        guard it defensively by treating it the same as an empty existing list.
        """
        # User deliberately deleted all measures — honour that.
        if existing is not None and len(existing) == 0:
            return []
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
        # Pass view.measures directly (not `or []`) so merge can distinguish
        # "user explicitly cleared to []" from "never set".
        next_measures = merge_existing_measures(measures, view.measures)
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


def _apply_db_fk_constraints(
    db: Session,
    tables: List[DatasetTable],
    table_views: Dict[int, SemanticView],
    joins_by_source: Dict[str, List[dict]],
) -> None:
    """Phase-15.69 — query each source datasource's INFORMATION_SCHEMA
    for FK constraints and append matching joins into joins_by_source.

    Grouped by datasource_id so we make one connection per DS, not per
    table. Skips tables without a datasource (derived/manual/calendar).
    """
    from app.services.datasource_service import DataSourceConnectionService

    # Group tables by datasource_id; collect their source_table_name.
    by_ds: Dict[int, List[DatasetTable]] = {}
    for t in tables:
        if is_generated_calendar_table(t):
            continue
        if not getattr(t, "datasource_id", None) or not getattr(t, "source_table_name", None):
            continue
        by_ds.setdefault(int(t.datasource_id), []).append(t)
    if not by_ds:
        return

    # Index physical_table by its source_table_name (case-insensitive,
    # with + without schema prefix) so we can map FK rows back to our
    # SemanticView.
    def _index_by_source_name(group: List[DatasetTable]) -> Dict[str, DatasetTable]:
        idx: Dict[str, DatasetTable] = {}
        for tt in group:
            src = str(tt.source_table_name or "").strip()
            if not src:
                continue
            idx[src.lower()] = tt
            # Bare table name (without schema) — for cross-schema FKs.
            if "." in src:
                bare = src.split(".", 1)[1]
                idx.setdefault(bare.lower(), tt)
        return idx

    for ds_id, group in by_ds.items():
        ds = db.query(DataSource).filter(DataSource.id == ds_id).first()
        if not ds:
            continue
        ds_type = ds.type if isinstance(ds.type, str) else getattr(ds.type, "value", "")
        if ds_type not in ("postgresql", "mysql", "bigquery"):
            continue
        source_names = [str(t.source_table_name) for t in group if t.source_table_name]
        try:
            fks = DataSourceConnectionService.list_foreign_keys(
                ds_type=ds_type,
                config=ds.config,
                table_names=source_names,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] ds_id={ds_id} failed: {exc}")
            continue
        if not fks:
            continue

        name_idx = _index_by_source_name(group)
        for fk in fks:
            ft = str(fk.get("from_table") or "").strip()
            tt = str(fk.get("to_table") or "").strip()
            fc = str(fk.get("from_column") or "").strip()
            tc = str(fk.get("to_column") or "").strip()
            if not (ft and tt and fc and tc):
                continue
            from_tbl = name_idx.get(ft.lower())
            to_tbl = name_idx.get(tt.lower())
            if from_tbl is None or to_tbl is None or from_tbl.id == to_tbl.id:
                continue
            from_view = table_views.get(from_tbl.id)
            to_view = table_views.get(to_tbl.id)
            if from_view is None or to_view is None:
                continue
            joins_by_source.setdefault(from_view.name, [])
            # Dedupe by (target_view, from_column).
            already = any(
                join.get("view") == to_view.name
                and join.get("from_column") == fc
                for join in joins_by_source[from_view.name]
            )
            if already:
                continue
            joins_by_source[from_view.name].append({
                "name": to_view.name,
                "view": to_view.name,
                "type": "left",
                "sql_on": f"${{TABLE}}.{fc} = ${{{to_view.name}}}.{tc}",
                "relationship": "many_to_one",
                "from_view": from_view.name,
                "from_column": fc,
                "to_column": tc,
                "from_columns": [fc],
                "to_columns": [tc],
                # Tag distinct from heuristic so UI can show "verified
                # from DB constraint" vs "guessed from naming".
                "origin": "auto_db_constraint",
                "managed": True,
            })


def _detect_fk_joins(
    tables: List[DatasetTable],
    table_views: Dict[int, SemanticView],
    db: Optional[Session] = None,
) -> Dict[str, List[dict]]:
    """Build join suggestions for the model.

    Phase-15.69 — two-pass detection:
      1. Pull FK constraints from the source DB's INFORMATION_SCHEMA
         (Postgres pg_constraint / MySQL KEY_COLUMN_USAGE / BigQuery
         CONSTRAINT_COLUMN_USAGE). These are AUTHORITATIVE — the DB
         already enforces them — so any FK we find here is a 100%
         correct join suggestion. Tagged `origin="auto_db_constraint"`.
      2. Fall back to the legacy name-heuristic (column ending in `_id`
         + matching table name) for tables/sources that don't expose
         FKs. Tagged `origin="auto_fk"` (legacy tag preserved so
         existing UI annotations still work).

    db arg is optional — when None we skip Phase 1 and only run name
    heuristics (e.g. when called from a path that doesn't have a DB
    handle wired in yet).
    """
    joins_by_source: Dict[str, List[dict]] = {}
    table_names: Dict[str, DatasetTable] = {}

    for table in tables:
        if is_generated_calendar_table(table):
            continue
        display = _view_name_for_table(table)
        table_names[display.lower()] = table
        table_names[_singularize(display).lower()] = table

    # ── Phase 1: source-DB FK constraints (highest signal) ────────────────
    if db is not None:
        try:
            _apply_db_fk_constraints(db, tables, table_views, joins_by_source)
        except Exception as exc:  # noqa: BLE001 — best effort; never block model gen
            logger.warning(f"[fk_extract] failed, falling back to name heuristic: {exc}")

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
                and _join_pairs_signature(*_join_columns_from_definition(join)) == ((raw_col_name, "id"),)
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
                "from_columns": [raw_col_name],
                "to_columns": ["id"],
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
                "from_columns": [column_name],
                "to_columns": ["date"],
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
    seen: Set[tuple[str, str | None, tuple[tuple[str, str], ...]]] = set()

    for join in [*manual_joins, *auto_joins]:
        join_from_columns, join_to_columns = _join_columns_from_definition(join)
        join_alias = str(join.get("alias") or "").strip() or None
        key = (
            str(join.get("view") or ""),
            join_alias,
            _join_pairs_signature(join_from_columns, join_to_columns),
        )
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
                        "from_columns": [raw_col_name],
                        "to_columns": ["id"],
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
    datasource_by_id: Dict[int, DataSource] = {int(d.id): d for d in datasources}
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

    stale_dataset_views: list[SemanticView] = []
    for stale_view in existing_views:
        if (
            stale_view.dataset_table_id is not None
            and stale_view.dataset_table_id in all_dataset_table_ids
            and stale_view.dataset_table_id not in desired_table_ids
        ):
            stale_dataset_views.append(stale_view)

    if stale_dataset_views:
        stale_view_ids = {view.id for view in stale_dataset_views}
        for stale_explore in (
            db.query(SemanticExplore)
            .filter(SemanticExplore.base_view_id.in_(stale_view_ids))
            .all()
        ):
            db.delete(stale_explore)
        for stale_view in stale_dataset_views:
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
                datasource=(
                    datasource_by_id.get(int(table.datasource_id))
                    if getattr(table, "datasource_id", None) is not None
                    else None
                ),
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
    role_view_names: Set[str] = set()
    if refresh_auto_joins:
        auto_fk_joins = _detect_fk_joins(tables, table_views, db=db)
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
        for view in table_views.values()
        if str(view.name or "").strip()
    }
    valid_target_view_names.update(
        name for name in role_view_names if str(name or "").strip()
    )
    for explore in db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all():
        for join in explore.joins or []:
            target_view_name = str(join.get("view") or "").strip()
            if target_view_name and join.get("origin") == "auto_calendar":
                valid_target_view_names.add(target_view_name)

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
            .filter(
                or_(
                    SemanticView.dataset_table_id.in_(table_ids),
                    SemanticView.dataset_table_id.is_(None),
                )
            )
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
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    join_type: str = "left",
    relationship: str = "many_to_one",
    alias: str | None = None,
    is_active: bool = True,
    cross_filter: str = "single",
    force: bool = False,
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

    normalized_from_columns, normalized_to_columns = _normalize_requested_join_columns(
        from_columns=from_columns,
        to_columns=to_columns,
        from_column=from_column,
        to_column=to_column,
    )
    primary_from_column = normalized_from_columns[0]
    primary_to_column = normalized_to_columns[0]

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
        from_column=primary_from_column,
        to_column=primary_to_column,
        from_columns=normalized_from_columns,
        to_columns=normalized_to_columns,
    )
    if not join_validation.get("can_create"):
        raise ValueError(str(join_validation.get("message") or "Relationship cannot be created"))

    normalized_join_type = _normalize_join_type(join_type)
    normalized_relationship = _normalize_relationship_type(relationship)
    # Phase-3b: many-to-many is allowed but risky (cartesian fan-out can double
    # aggregates). We accept the relationship and surface a warning to the
    # caller via the response; the UI shows a red banner in RelationshipDialog
    # so the user is reminded to use a bridge table when possible.

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
        "sql_on": _build_join_sql_on(
            target_placeholder=placeholder_target,
            from_columns=normalized_from_columns,
            to_columns=normalized_to_columns,
        ),
        "relationship": normalized_relationship,
        "from_view": from_view.name,
        "from_column": primary_from_column,
        "to_column": primary_to_column,
        "from_columns": normalized_from_columns,
        "to_columns": normalized_to_columns,
        # Phase-3b additions
        "is_active": bool(is_active),
        "cross_filter": cross_filter if cross_filter in ("single", "both") else "single",
    }

    # Update an exact existing join, otherwise append so one pair of tables can
    # carry multiple explicit relationships on different columns or aliases.
    for i, j in enumerate(joins):
        join_from_columns, join_to_columns = _join_columns_from_definition(j)
        existing_alias = (j.get("alias") or "").strip() or None
        if (
            j.get("view") == to_view.name
            and _join_pairs_signature(join_from_columns, join_to_columns)
            == _join_pairs_signature(normalized_from_columns, normalized_to_columns)
            and existing_alias == alias_clean
        ):
            # Phase-3b: if the user is flipping a previously-active join to
            # inactive, refuse when any chart still consumes the joined view's
            # fields. Without this guard the chart silently breaks because
            # the resolver stops emitting that join in the SQL.
            # When `force=True`, the API layer has already prompted the user
            # to confirm — skip the guard.
            previously_active = bool(j.get("is_active", True))
            if previously_active and not new_join["is_active"] and not force:
                _ensure_no_chart_depends_on_join(
                    db,
                    dataset_id=dataset_id,
                    join_view_name=to_view.name,
                    join_alias=alias_clean,
                )
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


def _profile_join_columns(
    db: Session,
    *,
    dataset_obj: Dataset,
    dataset_id: int,
    view: SemanticView,
    column_names: list[str],
) -> dict[str, Any]:
    from app.services.dataset_relation_service import resolve_dataset_table_relation
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.live_query_service import _dialect_for_ds_type, _quote_identifier

    _, datasource, live_table = _resolve_semantic_view_table(
        db,
        dataset_obj=dataset_obj,
        dataset_id=dataset_id,
        view=view,
    )
    relation = resolve_dataset_table_relation(datasource, live_table)
    ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
    dialect = _dialect_for_ds_type(ds_type)
    quoted_columns = [_quote_identifier(column_name, dialect) for column_name in column_names]
    select_columns_sql = ", ".join(quoted_columns)
    non_null_predicate = " AND ".join(f"{column_sql} IS NOT NULL" for column_sql in quoted_columns)

    sql = f"""
WITH source AS (
    {relation.sql}
),
non_null_rows AS (
    SELECT {select_columns_sql}
    FROM source
    WHERE {non_null_predicate}
),
distinct_rows AS (
    SELECT DISTINCT {select_columns_sql}
    FROM non_null_rows
)
SELECT
    (SELECT COUNT(*) FROM source) AS total_rows,
    (SELECT COUNT(*) FROM non_null_rows) AS non_null_rows,
    (SELECT COUNT(*) FROM distinct_rows) AS distinct_count
"""
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds_type,
        datasource.config,
        sql,
        timeout_seconds=30,
    )
    first_row = rows[0] if rows else {}
    total_rows = int(first_row.get("total_rows") or 0)
    non_null_rows = int(first_row.get("non_null_rows") or 0)
    distinct_count = int(first_row.get("distinct_count") or 0)
    null_count = max(total_rows - non_null_rows, 0)
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
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
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

    normalized_from_columns, normalized_to_columns = _normalize_requested_join_columns(
        from_columns=from_columns,
        to_columns=to_columns,
        from_column=from_column,
        to_column=to_column,
    )
    normalized_from_column = normalized_from_columns[0]
    normalized_to_column = normalized_to_columns[0]

    from_fields = _field_names_for_view(from_view)
    to_fields = _field_names_for_view(to_view)
    for candidate in normalized_from_columns:
        if candidate not in from_fields:
            raise ValueError(f"Column '{candidate}' does not exist on view '{from_view.name}'")
    for candidate in normalized_to_columns:
        if candidate not in to_fields:
            raise ValueError(f"Column '{candidate}' does not exist on view '{to_view.name}'")

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
        from_profile = _profile_join_columns(
            db,
            dataset_obj=dataset_obj,
            dataset_id=dataset_id,
            view=from_view,
            column_names=normalized_from_columns,
        )
        to_profile = _profile_join_columns(
            db,
            dataset_obj=dataset_obj,
            dataset_id=dataset_id,
            view=to_view,
            column_names=normalized_to_columns,
        )
    except Exception as exc:
        logger.warning(
            "Falling back to heuristic join suggestion for dataset %s (%s.%s -> %s.%s): %s",
            dataset_id,
            from_view.name,
            ",".join(normalized_from_columns),
            to_view.name,
            ",".join(normalized_to_columns),
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

    # Phase-3b: many-to-many is no longer a blocking condition. We still flag
    # it as a non-blocking warning so the dialog can render a red banner that
    # nudges users toward the safer bridge-table pattern, but they can choose
    # to proceed if the schema genuinely is many-to-many (e.g. tag tables).
    warning_code: str | None = None
    warning_message: str | None = None
    if suggested_relationship == "many_to_many":
        warning_code = "many_to_many"
        warning_message = (
            "Quan hệ many-to-many: aggregate có thể bị nhân đôi do cartesian fan-out. "
            "Nên dùng bridge table + 2 quan hệ N:1 khi có thể."
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
        "warning_code": warning_code,
        "warning_message": warning_message,
    }


def remove_join(
    db: Session,
    dataset_id: int,
    from_view_id: int,
    to_view_name: str,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
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

    match_from_columns, match_to_columns = _normalize_requested_join_columns(
        from_columns=from_columns,
        to_columns=to_columns,
        from_column=from_column,
        to_column=to_column,
        require_pairs=False,
    )
    match_signature = _join_pairs_signature(match_from_columns, match_to_columns)

    def should_remove(join: dict) -> bool:
        if join.get("view") != to_view_name:
            return False
        if not match_signature:
            return True

        join_from_columns, join_to_columns = _join_columns_from_definition(join)
        return _join_pairs_signature(join_from_columns, join_to_columns) == match_signature

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
        join_from_columns, _ = _join_columns_from_definition(join)
        parsed_from = join_from_columns[0] if join_from_columns else None
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


_NESTED_CTE_RE = re.compile(r"\bWITH\s+\w+\s+AS\s*\(", re.IGNORECASE)


def relation_has_nested_cte(relation: str | None) -> bool:
    """True when a view's baked relation embeds a nested ``WITH ... AS (... WITH ... AS (``
    construct that BigQuery rejects when used inside a subquery-as-table.

    The pre-existing guard ``startswith("with ")`` only catches relations that
    are themselves a bare CTE; sql_query sources are baked as
    ``(SELECT * FROM (WITH ... AS (...)) AS _src)`` and the inner ``WITH`` is
    invisible to that check. When the user's source_query itself nests CTEs —
    ``WITH a AS (WITH b AS (...) SELECT...)`` — embedding the wrapped form in
    an EXISTS / JOIN body lands BQ on ``Syntax error: Unexpected keyword SELECT``
    (production log, 2026-05-27). Single-CTE wraps (count == 1) BigQuery DOES
    accept (verified on dataset 55 table 186 = v_top_tasks_per_project's
    ``WITH ranked AS (...) SELECT ...``), so this only fires for nested CTEs.
    """
    if not relation:
        return False
    return len(_NESTED_CTE_RE.findall(str(relation))) >= 2


def _distinct_filter_targets_self(
    view_name: str,
    field_name: str,
    condition: dict,
) -> bool:
    """True when ``condition`` filters the SAME field a distinct-values
    dropdown is being computed for.

    A slicer's option list must always show its FULL set of values,
    cascaded only by filters on OTHER fields — never by a filter on the
    dropdown's own field. The FE drops the target via
    ``getDistinctValueFilterContext``; this mirrors that on the BE so the
    public path (where ``_build_public_chart_filters`` re-injects the
    dashboard's saved slicer/filter default for this very field) doesn't
    pin the dropdown to its own current value.

    Prefers qualified ``view.field`` matching to avoid colliding with a
    same-named field on a different view (e.g. ``orders.country`` vs
    ``users.country``); only falls back to bare-field matching when the
    condition carries no qualified reference at all.
    """
    candidates: list[str] = []
    for key in ("semanticField", "fieldKey", "field"):
        raw = condition.get(key)
        if raw:
            candidates.append(str(raw).strip())
    linked = condition.get("linkedFields")
    if isinstance(linked, list):
        candidates.extend(str(lf).strip() for lf in linked if lf)
    candidates = [c for c in candidates if c]
    has_qualified = any("." in c for c in candidates)
    for cand in candidates:
        if "." in cand:
            node, name = cand.split(".", 1)
            if node.strip() == view_name and name.strip() == field_name:
                return True
        elif not has_qualified and cand == field_name:
            return True
    return False


def get_distinct_field_values(
    db: Session,
    dataset_id: int,
    field: str,
    limit: int = 200,
    filters: list[dict] | None = None,
) -> dict:
    """Return distinct values + dropped-filter diagnostics.

    Shape: ``{"values": [...], "dropped_filters": [{...}]}``. Returning a
    dict (instead of just ``list[str]``) is the Phase-15.94 fix for the
    silently-broken cascading dropdown: when a cascading filter targets
    a view that has no join path to the dropdown's owner view, the
    dropdown previously returned a shorter list and the user assumed
    the data was wrong. Now the dropped filters surface to the FE so the
    user sees a banner naming which filters were ignored.
    """
    if "." not in field:
        raise ValueError("Field must be qualified as view.field")

    view_name, field_name = field.split(".", 1)
    limit = max(1, min(int(limit), 500))

    # A slicer's option list must always show its FULL set of values,
    # cascaded only by filters on OTHER fields — never by a filter on
    # the dropdown's own field. The FE excludes the target via
    # getDistinctValueFilterContext, but on the public path the layered
    # merge (_build_public_chart_filters) re-injects the dashboard's
    # saved slicer/filter default for this very field, which would pin
    # the dropdown to its own current value and make it look "stuck".
    # Strip any incoming filter that references the target field (incl.
    # via linkedFields), mirroring the FE's getDistinctValueFilterContext.
    if filters:
        kept: list[dict] = []
        for item in filters:
            if isinstance(item, dict) and _distinct_filter_targets_self(
                view_name, field_name, item
            ):
                continue
            kept.append(item)
        filters = kept

    dataset_table_ids = [
        row.id
        for row in db.query(DatasetTable.id)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    ]
    view = (
        db.query(SemanticView)
        .filter(
            SemanticView.name == view_name,
            SemanticView.dataset_table_id.in_(dataset_table_ids),
        )
        .first()
        if dataset_table_ids
        else None
    )
    if view is None:
        view = (
            db.query(SemanticView)
            .filter(
                SemanticView.name == view_name,
                SemanticView.dataset_table_id.is_(None),
            )
            .first()
        )
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
        if op in ("neq", "ne"):
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

    def _record_dropped(
        dropped: list[dict],
        filter_condition: dict,
        reason: str,
        detail: str,
    ) -> None:
        """Append a structured diagnostic for one dropped cascading filter."""
        record = {
            "field": str(
                filter_condition.get("field")
                or filter_condition.get("semanticField")
                or ""
            ),
            "semantic_field": filter_condition.get("semanticField") or filter_condition.get("fieldKey"),
            "operator": filter_condition.get("operator"),
            "reason": reason,
            "detail": detail,
        }
        if not any(
            (
                existing.get("field") == record["field"]
                and existing.get("operator") == record["operator"]
                and existing.get("reason") == record["reason"]
            )
            for existing in dropped
        ):
            dropped.append(record)
        logger.warning(
            "[distinct-values] dropped filter field=%s reason=%s detail=%s",
            record["field"],
            reason,
            detail,
        )

    def _build_distinct_sql(
        base_sql: str,
        datasource_obj,
        dialect: str,
        dropped: list[dict],
    ) -> str:
        """Phase-15.94 — Cascading filter strategy switched from
        `LEFT JOIN dim_X ... WHERE dim_X.col = ...` (which acted as an
        INNER JOIN and silently dropped base rows lacking a match) to
        per-filter EXISTS subqueries that preserve base cardinality.

        When the resolver cannot find a join path from this dropdown's
        owner view to the cascading filter's view, the filter is
        recorded in `dropped` (so the FE can show a banner) instead of
        being silently skipped.
        """
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
        # bidirectional=True so views that are normally join *targets*
        # (e.g. "users" in orders→users) can still reach the explore base
        # view when resolving cascading filter conditions.
        resolver = SemanticJoinResolver(db, model, view_name, bidirectional=True)
        view_cache: dict[str, SemanticView | None] = {}
        next_exists_index = [0]

        def _get_view(node_or_view: str) -> SemanticView | None:
            actual_view = resolver.view_for_node(node_or_view) or node_or_view
            if actual_view in view_cache:
                return view_cache[actual_view]
            result = (
                db.query(SemanticView)
                .filter(
                    SemanticView.name == actual_view,
                    SemanticView.dataset_table_id.in_(dataset_table_ids),
                )
                .first()
                if dataset_table_ids
                else None
            )
            if result is None:
                result = (
                    db.query(SemanticView)
                    .filter(
                        SemanticView.name == actual_view,
                        SemanticView.dataset_table_id.is_(None),
                    )
                    .first()
                )
            view_cache[actual_view] = result
            return result

        def _next_alias() -> str:
            alias = f"_appbi_distinct_exists_{next_exists_index[0]}"
            next_exists_index[0] += 1
            return alias

        def _build_exists_for_path(node: str, name: str) -> tuple[str | None, str | None]:
            """Build an `EXISTS (SELECT 1 FROM ...)` subquery whose
            inner JOIN chain mirrors the resolver path and whose first
            hop correlates back to the outer base_alias.

            Returns ``(clause, drop_reason)``. ``clause`` is the SQL or
            None when something prevents rendering; ``drop_reason`` is
            an optional code (``no_join_path``,
            ``cte_in_subquery``, ``view_not_found``) so the caller can
            record an accurate diagnostic in ``dropped_filters``.
            """
            path = resolver.resolve_path(node)
            if path is None or path.is_empty():
                return None, "no_join_path"

            # Materialise the path's joins inside the EXISTS body.
            # SQL shape:
            #   EXISTS (
            #     SELECT 1
            #     FROM <first_hop_rel> AS d0
            #     [INNER JOIN <next_hop_rel> AS d1 ON ...]*
            #     WHERE <correlation back to base_alias>
            #       AND <leaf filter predicate>
            #   )
            # We render the first hop as a bare FROM (no ON) and push
            # its correlation condition into the WHERE clause — SQL
            # forbids `ON` directly after `FROM`. Subsequent hops use
            # INNER JOIN ... ON ... as usual.
            inner_aliases: list[str] = []
            inner_views: list[SemanticView] = []
            sql_pieces: list[str] = []
            correlation_predicates: list[str] = []
            prev_alias: str | None = None

            for step in path.steps:
                joined_view = _get_view(step.edge.to_node)
                if joined_view is None:
                    return None, "view_not_found"
                relation = _build_live_relation_for_semantic_view(db, datasource_obj, joined_view)
                if not relation:
                    return None, "view_not_found"
                # Phase-15.95 — BigQuery rejects `WITH` clauses inside a
                # subquery used as a table relation. The EXISTS-based
                # cascade puts each relation two-levels-deep
                # (EXISTS → SELECT 1 → FROM (rel)), so any CTE-prefixed
                # derived view breaks the whole query with a
                # `Syntax error: Unexpected keyword SELECT` 500. Detect
                # both shapes: (a) the relation itself starts with WITH,
                # and (b) the relation is the standard sql_query wrap
                # `(SELECT * FROM (WITH a AS (WITH b AS (...))) AS _src)`
                # whose nested CTEs only appear via a regex count.
                stripped_rel = str(relation or "").strip().lstrip("(").lstrip()
                if stripped_rel.lower().startswith("with ") or relation_has_nested_cte(relation):
                    return None, "cte_in_subquery"
                new_alias = _next_alias()
                inner_aliases.append(new_alias)
                inner_views.append(joined_view)

                if prev_alias is None:
                    # First hop: correlate back to the outer base view
                    # via the edge from-column / to-column pair so the
                    # EXISTS is bound to the outer row, not a Cartesian
                    # product. The condition lives in the WHERE clause.
                    condition = _render_step_join_condition(
                        step.edge,
                        from_alias=base_alias,
                        to_alias=new_alias,
                    )
                    # Phase-15.97 — Bug D: dropped the "to_col not declared
                    # as dim/measure" fallback. `_semantic_view_has_field`
                    # only scans DECLARED dimensions/measures, but a join
                    # column doesn't need to be a dimension to be valid
                    # SQL. The old safeguard mis-fired on reverse edges
                    # (bidirectional resolver: BC_key on dim is the join
                    # key but NOT declared as a dimension) and silently
                    # rewrote the condition to use `from_col` on both
                    # sides — producing `base.bc_key = inner.bc_key`
                    # instead of `base.bc_key = inner.BC_key`, which
                    # BigQuery rejects when case-sensitive. Trust the
                    # edge's declared from_column/to_column; if a column
                    # truly doesn't exist, BQ surfaces a clean SQL error
                    # which `_safe_execute` records as `sql_error`.
                    if not condition:
                        return None, "no_join_path"
                    sql_pieces.append(f"FROM {_wrap_live_sql_relation(relation)} AS {new_alias}")
                    correlation_predicates.append(condition)
                else:
                    condition = _render_step_join_condition(
                        step.edge,
                        from_alias=prev_alias,
                        to_alias=new_alias,
                    )
                    # Phase-15.97 — same Bug D fix as above.
                    if not condition:
                        return None, "no_join_path"
                    join_kw = (step.edge.type or "inner").upper()
                    # Inside EXISTS we don't need outer joins — base
                    # cardinality is already preserved by the EXISTS
                    # wrapper. Force INNER so the predicate is strict.
                    if join_kw in {"LEFT", "RIGHT", "FULL"}:
                        join_kw = "INNER"
                    sql_pieces.append(
                        f"{join_kw} JOIN {_wrap_live_sql_relation(relation)} AS {new_alias} ON {condition}"
                    )

                prev_alias = new_alias

            leaf_alias = inner_aliases[-1]
            leaf_view = inner_views[-1]
            if not _semantic_view_has_field(leaf_view, name):
                return None, "field_not_on_view"
            leaf_expr = f"{leaf_alias}.{_quote_identifier(name, dialect)}"
            predicate = _render_filter_condition(leaf_expr, filter_condition)
            if not predicate:
                return None, "no_join_path"

            where_parts_inner = [*correlation_predicates, predicate]
            body_parts = [
                "SELECT 1",
                *sql_pieces,
                f"WHERE {' AND '.join(where_parts_inner)}",
            ]
            return "EXISTS (" + " ".join(body_parts) + ")", None

        exists_clauses: list[str] = []
        base_predicates: list[str] = []
        for filter_condition in normalized_filters:
            refs = _qualified_filter_refs(filter_condition)
            if not refs:
                _record_dropped(
                    dropped,
                    filter_condition,
                    "no_field",
                    "filter has no usable field reference",
                )
                continue

            handled = False
            last_reason: str | None = None
            last_view = None
            for node, name in refs:
                # Self-reference on the dropdown's own view — render
                # directly without an EXISTS wrapper.
                if node == view_name:
                    view_obj = _get_view(node)
                    if view_obj is not None and not _semantic_view_has_field(view_obj, name):
                        last_reason = "field_not_on_view"
                        last_view = node
                        continue
                    field_expr = f"{base_alias}.{_quote_identifier(name, dialect)}"
                    predicate = _render_filter_condition(field_expr, filter_condition)
                    if predicate:
                        base_predicates.append(predicate)
                        handled = True
                        break
                    continue

                view_obj = _get_view(node)
                if view_obj is None:
                    last_reason = "view_not_found"
                    last_view = node
                    continue
                if not _semantic_view_has_field(view_obj, name):
                    last_reason = "field_not_on_view"
                    last_view = node
                    continue

                clause, exists_reason = _build_exists_for_path(node, name)
                if clause is None:
                    last_reason = exists_reason or "no_join_path"
                    last_view = node
                    continue
                exists_clauses.append(clause)
                handled = True
                break

            if not handled:
                detail_by_reason = {
                    "field_not_on_view": f"field not declared on view {last_view!r}",
                    "no_join_path": f"no join path from {view_name!r} to {last_view!r}",
                    "view_not_found": f"view {last_view!r} not found in dataset {dataset_id}",
                    "cte_in_subquery": (
                        f"view {last_view!r} is a CTE-backed derived table; "
                        "BigQuery rejects WITH clauses inside subqueries used "
                        "as table relations. Filter cannot be cascaded here."
                    ),
                }
                reason = last_reason or "view_not_found"
                _record_dropped(
                    dropped,
                    filter_condition,
                    reason,
                    detail_by_reason.get(reason, reason),
                )

        where_parts = [f"{target_expr} IS NOT NULL", *base_predicates, *exists_clauses]
        return (
            f"SELECT DISTINCT {target_expr} AS value "
            f"FROM ({base_sql}) AS {base_alias} "
            f"WHERE {' AND '.join(where_parts)} "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )

    dropped: list[dict] = []

    def _safe_execute(label: str, runner) -> list[str]:
        """Phase-15.95 — Never let a distinct-values SQL error escape as
        a 500. The cascading EXISTS path can synthesise SQL that the
        target engine rejects (e.g. BigQuery refuses `WITH ...` inside
        a FROM subquery). Catch the failure, record it as a
        ``dropped_filters`` entry per cascading filter so the FE banner
        identifies the *cascade* (not the dropdown's own column) as the
        broken slot. Phase-15.97 — earlier code stamped the
        ``dropped.field`` with the OUTER ``field`` closure variable
        (the target column being loaded), which caused the FE banner to
        say "X bị bỏ qua" where X was the target, not the offending
        filter. Now we attach one drop entry per active cascading
        filter so the banner names each filter accurately.
        """
        try:
            return runner()
        except ValueError:
            raise  # cost guard / config errors stay as 400
        except Exception as exc:  # noqa: BLE001 — broad on purpose
            logger.exception(
                "[distinct-values] %s failed for dataset=%s target_field=%s",
                label,
                dataset_id,
                field,
            )
            detail = str(exc)[:300]
            cascading_filters = [
                item for item in (filters or [])
                if isinstance(item, dict)
                and (item.get("field") or item.get("semanticField") or item.get("fieldKey"))
            ]
            if cascading_filters:
                for fc in cascading_filters:
                    dropped.append({
                        "field": str(
                            fc.get("field")
                            or fc.get("semanticField")
                            or fc.get("fieldKey")
                            or ""
                        ),
                        "semantic_field": fc.get("semanticField") or fc.get("fieldKey"),
                        "operator": fc.get("operator"),
                        "reason": "sql_error",
                        "detail": detail,
                    })
            else:
                # No cascading filters in payload — record the failure
                # generically so the FE still surfaces "something
                # broke" instead of returning a misleading empty list.
                dropped.append({
                    "field": "__distinct_values__",
                    "semantic_field": None,
                    "operator": None,
                    "reason": "sql_error",
                    "detail": detail,
                })
            return []

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
        sql = _build_distinct_sql(base_sql, datasource_for_view, dialect, dropped)
        source_hash = hashlib.sha1(sql_source.encode("utf-8")).hexdigest()[:16]
        table_identifier = f"semantic_view:{view_name}:{source_hash}"
        values = _safe_execute("semantic_view", lambda: execute_distinct_sql(datasource_for_view, table_identifier, sql))
        return {"values": values, "dropped_filters": dropped}

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
        sql = _build_distinct_sql(cal_sql, cal_datasource, dialect, dropped)
        table_identifier = f"calendar_view:{dataset_id}:{view_name}"
        values = _safe_execute("calendar_view", lambda: execute_distinct_sql(cal_datasource, table_identifier, sql))
        return {"values": values, "dropped_filters": dropped}

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
        sql = _build_distinct_sql(plan.sql, datasource, dialect, dropped)
        table_identifier = build_dataset_table_cache_identifier(live_table)
        return execute_distinct_sql(datasource, table_identifier, sql)

    if datasource is None:
        raise ValueError("Data source not found")
    values = _safe_execute("live_table", fetch_live_values)
    return {"values": values, "dropped_filters": dropped}


# ===========================================================================
# Phase-16 — Relationship review (non-destructive Gen-model)
# ===========================================================================
#
# These helpers power POST /datasets/{id}/model/generate-suggestions.
# The endpoint runs the same detection logic as generate_dataset_model but
# never writes to the DB — it returns a diff the builder can review and
# selectively apply through POST /model/joins/batch. Rejected suggestions
# are persisted in SemanticModel.settings.rejected_auto_joins so they stop
# resurfacing on later runs.


# AppBI normalises every column type into one of a handful of semantic
# labels (see app.schemas.dataset.ColumnMetadata.type) before caching it.
# In particular: every numeric variant — int4, bigint, decimal, float —
# lands as "number" / "numeric" / "integer", and every text variant lands
# as "string" / "text". Earlier versions of this list only matched the
# raw DB types, which meant pass 3 (deep scan) silently skipped every
# column on a real AppBI dataset.
_KEY_LIKE_NUMERIC_TYPES = {
    "integer",
    "int",
    "int4",
    "int8",
    "bigint",
    "smallint",
    "tinyint",
    "number",        # AppBI semantic label for any numeric column
    "numeric",
    "decimal",
    "long",
    "serial",
    "bigserial",
}
_KEY_LIKE_STRING_TYPES = {
    "string",        # AppBI semantic label
    "text",
    "varchar",
    "character varying",
    "char",
    "character",
    "uuid",
    "nvarchar",
    "nchar",
}
_KEY_LIKE_STRING_MAX_LEN = 200  # raised from 64 — VN business keys are often >64 chars

# Columns whose values look like keys but serve a different purpose and
# must NOT be proposed as join candidates. `miniapp_user` is the
# workboard RLS scope — many tables carry it with overlapping values
# (the same user appears across fact tables) which fools the overlap
# probe. Treating it as a join would silently force cross-product joins
# in queries that should stay scoped.
_RESERVED_NON_JOIN_COLUMNS = {"miniapp_user"}

# Generic primary-key column names — when BOTH sides of a candidate
# pair share one of these names (e.g. id↔id), the match is meaningless.
# Two unrelated dim tables each have their own `id`; suggesting a join
# would silently produce cross-joins. The real `<table>_id → <table>.id`
# direction is already covered by pass 2 (name heuristic).
_SAME_NAME_SKIP = {"id", "pk", "key", "_id", "uuid"}


def _is_key_like_column(column: dict) -> bool:
    """A column is "key-like" if its values look like identifiers we could
    plausibly join on: bounded-length strings, uuids, or numeric types.

    Floats are allowed too because AppBI stores all numerics under the
    same "number" label — we can't tell decimals apart from integers
    here. Date/time and booleans are excluded.
    """
    col_name = str(column.get("name") or "").strip().lower()
    if col_name in _RESERVED_NON_JOIN_COLUMNS:
        return False
    raw_type = str(column.get("type") or column.get("data_type") or "").strip().lower()
    if not raw_type:
        # When type is unknown, don't preemptively reject — the overlap
        # probe will tell us via SQL whether the values actually match.
        return True
    # Strip any "(length)" or " precision,scale" trailer that some
    # introspectors leave on, e.g. "varchar(255)" or "numeric(10,2)".
    base_type = raw_type.split("(", 1)[0].strip()
    if base_type in _KEY_LIKE_NUMERIC_TYPES:
        return True
    if base_type in _KEY_LIKE_STRING_TYPES:
        length_value = column.get("length") or column.get("character_maximum_length")
        try:
            if length_value is not None and int(length_value) > _KEY_LIKE_STRING_MAX_LEN:
                return False
        except (TypeError, ValueError):
            pass
        return True
    # Date/datetime/boolean/blob — explicitly not key-like.
    if base_type in {"date", "datetime", "timestamp", "time", "boolean", "bool", "yesno", "blob", "bytea"}:
        return False
    # Anything we don't recognise — let the probe decide.
    return True


def _columns_of_table(table: DatasetTable) -> list[dict]:
    cc = table.columns_cache
    if isinstance(cc, dict):
        cols = cc.get("columns", [])
    elif isinstance(cc, list):
        cols = cc
    else:
        cols = []
    return [c for c in cols if isinstance(c, dict) and c.get("name")]


def _effective_column_meta(
    column: dict,
    table_id: int,
    raw_types_by_table_id: Dict[int, Dict[str, str]],
) -> dict:
    """Return a column dict whose ``type`` is the raw DB type when
    available, falling back to whatever the cache has.

    AppBI's columns_cache stores a normalised semantic type
    (``number`` / ``string`` / ``date`` / ``boolean``) that's too
    coarse for join detection — every numeric collapses into the same
    bucket. Raw DB types (``bigint``, ``uuid``, ``varchar(36)``,
    ``numeric(10,2)``) discriminate much better, so when the table has
    an introspectable datasource we use them.
    """
    raw_map = raw_types_by_table_id.get(table_id) or {}
    col_name = str(column.get("name") or "")
    raw_type = raw_map.get(col_name)
    if not raw_type:
        return column
    enriched = dict(column)
    enriched["type"] = raw_type
    enriched["raw_type"] = raw_type
    return enriched


def _type_family(raw_type: str) -> str:
    """Bucket a raw column type into 'numeric' / 'string' / 'other'."""
    base = str(raw_type or "").strip().lower().split("(", 1)[0].strip()
    if not base:
        return "unknown"
    if base in _KEY_LIKE_NUMERIC_TYPES:
        return "numeric"
    if base in _KEY_LIKE_STRING_TYPES:
        return "string"
    return "other"


def _type_compat(a: dict, b: dict) -> bool:
    """Two columns can be joined when they share a type family.

    'unknown' (cache without a type tag) is treated as a wildcard so we
    still probe — the SQL itself will reject incompatible casts. This
    matters because some legacy tables have columns_cache entries
    without a `type` field.
    """
    fam_a = _type_family(a.get("type") or a.get("data_type") or "")
    fam_b = _type_family(b.get("type") or b.get("data_type") or "")
    if fam_a == "other" or fam_b == "other":
        return False
    if fam_a == "unknown" or fam_b == "unknown":
        return True
    return fam_a == fam_b


def _suggestion_signature(
    from_view_name: str,
    to_view_name: str,
    from_columns: list[str],
    to_columns: list[str],
) -> tuple[str, str, tuple[tuple[str, str], ...]]:
    return (
        str(from_view_name),
        str(to_view_name),
        _join_pairs_signature(from_columns, to_columns),
    )


def _rejected_signatures(model: SemanticModel | None) -> set[tuple]:
    """Tombstones live under SemanticModel.settings.rejected_auto_joins as
    a list of {from_view, to_view, from_columns, to_columns}."""
    if model is None or not isinstance(model.settings, dict):
        return set()
    raw = model.settings.get("rejected_auto_joins") or []
    if not isinstance(raw, list):
        return set()
    out: set[tuple] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        from_cols = item.get("from_columns") or ([item["from_column"]] if item.get("from_column") else [])
        to_cols = item.get("to_columns") or ([item["to_column"]] if item.get("to_column") else [])
        if not from_cols or not to_cols:
            continue
        out.add(
            _suggestion_signature(
                str(item.get("from_view") or ""),
                str(item.get("to_view") or ""),
                [str(c) for c in from_cols],
                [str(c) for c in to_cols],
            )
        )
    return out


def add_rejected_suggestions(
    db: Session,
    dataset_id: int,
    rejections: list[dict],
) -> dict:
    """Persist tombstones the builder dismissed in the review modal."""
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        raise ValueError("Dataset has no semantic model yet")
    settings_obj = dict(model.settings or {})
    existing_raw = settings_obj.get("rejected_auto_joins") or []
    if not isinstance(existing_raw, list):
        existing_raw = []
    existing_sigs = _rejected_signatures(model)
    appended = 0
    for item in rejections:
        if not isinstance(item, dict):
            continue
        from_cols = item.get("from_columns") or []
        to_cols = item.get("to_columns") or []
        if not from_cols or not to_cols:
            continue
        sig = _suggestion_signature(
            str(item.get("from_view") or ""),
            str(item.get("to_view") or ""),
            [str(c) for c in from_cols],
            [str(c) for c in to_cols],
        )
        if sig in existing_sigs:
            continue
        existing_sigs.add(sig)
        existing_raw.append(
            {
                "from_view": str(item.get("from_view") or ""),
                "to_view": str(item.get("to_view") or ""),
                "from_columns": [str(c) for c in from_cols],
                "to_columns": [str(c) for c in to_cols],
            }
        )
        appended += 1
    settings_obj["rejected_auto_joins"] = existing_raw
    model.settings = settings_obj
    db.commit()
    return {"rejected_count": len(existing_raw), "added": appended}


def clear_rejected_suggestions(db: Session, dataset_id: int) -> dict:
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        raise ValueError("Dataset has no semantic model yet")
    settings_obj = dict(model.settings or {})
    cleared = len(settings_obj.get("rejected_auto_joins") or [])
    settings_obj["rejected_auto_joins"] = []
    model.settings = settings_obj
    db.commit()
    return {"cleared": cleared}


class _ColumnDistinctCache:
    """Per-Detect cache for distinct values of (view, column).

    Strategy: fetch the entire table once, then extract distinct values
    for any column in Python. This matters because:

    - Postgres trivially handles per-column SELECT DISTINCT, so the
      naive "one SQL per column" approach already works.
    - Google Sheets is the opposite. Every execute_query against a
      Sheets datasource loads ALL sheets in the spreadsheet through
      one API read (see datasource_service Google Sheets path). With
      the 60-reads-per-minute-per-user quota, fetching even 10 columns
      across 3 tables blows past the limit in seconds.

    So we run ONE `SELECT * FROM table LIMIT 5000` per view. That's
    one datasource read regardless of how many columns the overlap
    probe asks about. Distinct sets are computed once per (view,
    column) request and memoised.

    Side benefit: any view whose first fetch fails (quota or other
    error) is marked failed — subsequent probes for that view skip
    without further network calls.
    """

    SAMPLE_LIMIT = 5000  # cap rows per table; balances cost vs coverage

    def __init__(self, db: Session, dataset_obj: Dataset, dataset_id: int) -> None:
        self.db = db
        self.dataset_obj = dataset_obj
        self.dataset_id = dataset_id
        # view.id -> list of rows (each row is dict col_name -> value)
        self._rows_by_view: Dict[int, Optional[list[dict]]] = {}
        # key (view.id, column) -> cached distinct set so we only compute once
        self._distinct_cache: Dict[tuple[int, str], Optional[set[str]]] = {}
        # cache view -> (datasource, live_table) so we don't re-resolve N times
        self._resolved: Dict[int, Optional[tuple[Any, Any, Any]]] = {}
        # remember which views had a fatal datasource error
        self._failed_views: set[int] = set()
        self.quota_warning_count: int = 0

    @property
    def datasource_reads(self) -> int:
        """Number of full-table fetches that actually hit the datasource."""
        return sum(1 for rows in self._rows_by_view.values() if rows is not None)

    def get_distinct(self, view: SemanticView, column: str) -> Optional[set[str]]:
        cache_key = (view.id, column)
        if cache_key in self._distinct_cache:
            return self._distinct_cache[cache_key]
        if view.id in self._failed_views:
            self._distinct_cache[cache_key] = None
            return None
        rows = self._load_view_rows(view)
        if rows is None:
            self._distinct_cache[cache_key] = None
            return None
        values: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            raw = row.get(column)
            if raw is None or raw == "":
                continue
            values.add(str(raw).strip())
        self._distinct_cache[cache_key] = values
        return values

    def get_non_null_count(self, view: SemanticView, column: str) -> Optional[int]:
        """How many non-null rows does this column have?

        Used together with ``len(get_distinct(...))`` to decide whether
        the column is unique inside its table. If non_null == distinct,
        every row has a unique value → this column behaves like a PK and
        anything joining onto it is many_to_one. This is what lets us
        classify cardinality correctly when the DB does not declare a PK
        (e.g. Google Sheets, ad-hoc Postgres tables).
        """
        rows = self._load_view_rows(view)
        if rows is None:
            return None
        count = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            raw = row.get(column)
            if raw is None or raw == "":
                continue
            count += 1
        return count

    def _resolve(self, view: SemanticView) -> Optional[tuple[Any, Any, Any]]:
        if view.id in self._resolved:
            return self._resolved[view.id]
        try:
            triple = _resolve_semantic_view_table(
                self.db,
                dataset_obj=self.dataset_obj,
                dataset_id=self.dataset_id,
                view=view,
            )
        except Exception as exc:
            logger.warning(
                "Overlap probe — view resolution failed (%s): %s",
                view.name, exc,
            )
            self._failed_views.add(view.id)
            self._resolved[view.id] = None
            return None
        self._resolved[view.id] = triple
        return triple

    def _load_view_rows(self, view: SemanticView) -> Optional[list[dict]]:
        if view.id in self._rows_by_view:
            return self._rows_by_view[view.id]
        triple = self._resolve(view)
        if triple is None:
            self._rows_by_view[view.id] = None
            return None
        _, datasource, live_table = triple
        from app.services.dataset_relation_service import resolve_dataset_table_relation
        from app.services.datasource_service import DataSourceConnectionService

        ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
        try:
            relation = resolve_dataset_table_relation(datasource, live_table)
        except Exception as exc:
            logger.warning(
                "Overlap probe — relation resolution failed (%s): %s",
                view.name, exc,
            )
            self._rows_by_view[view.id] = None
            return None
        sql = f"SELECT * FROM ({relation.sql}) src LIMIT {self.SAMPLE_LIMIT}"
        try:
            _, rows, _ = DataSourceConnectionService.execute_query(
                ds_type,
                datasource.config,
                sql,
                timeout_seconds=15,
            )
        except Exception as exc:
            message = str(exc)
            if "429" in message or "quota" in message.lower() or "rate limit" in message.lower():
                self._failed_views.add(view.id)
                self.quota_warning_count += 1
                logger.warning(
                    "Overlap probe — datasource quota exceeded for view %s; "
                    "abandoning probes against this view: %s",
                    view.name, message,
                )
            else:
                logger.warning(
                    "Overlap probe — full-table fetch failed for %s: %s",
                    view.name, message,
                )
            self._rows_by_view[view.id] = None
            return None
        rows = rows or []
        self._rows_by_view[view.id] = rows
        return rows

    def probe_pair(
        self,
        from_view: SemanticView,
        from_column: str,
        to_view: SemanticView,
        to_column: str,
    ) -> Optional[dict]:
        """Return the same overlap stats the legacy SQL probe returned."""
        triple_a = self._resolve(from_view)
        triple_b = self._resolve(to_view)
        if triple_a is None or triple_b is None:
            return None
        # Cross-datasource joins still skipped — needs separate machinery
        # the runtime doesn't have yet.
        if triple_a[1].id != triple_b[1].id:
            return None
        from_values = self.get_distinct(from_view, from_column)
        to_values = self.get_distinct(to_view, to_column)
        if from_values is None or to_values is None:
            return None
        from_d = len(from_values)
        to_d = len(to_values)
        if from_d == 0 or to_d == 0:
            return None
        from_non_null = self.get_non_null_count(from_view, from_column) or 0
        to_non_null = self.get_non_null_count(to_view, to_column) or 0
        shared = len(from_values & to_values)
        denom = min(from_d, to_d)
        ratio = shared / denom if denom else 0.0
        return {
            "from_distinct": from_d,
            "to_distinct": to_d,
            # Tells the caller whether the column is unique within its
            # table (non_null == distinct ⇒ acts like a PK). Without
            # this we cannot tell many_to_one from one_to_many when the
            # DB has no declared PK.
            "from_non_null": from_non_null,
            "to_non_null": to_non_null,
            "shared_distinct": shared,
            "overlap_ratio": ratio,
        }


def _prefetch_db_metadata(
    db: Session,
    tables: List[DatasetTable],
) -> tuple[Dict[int, List[str]], Dict[int, Dict[str, str]]]:
    """Fetch PK + raw column types from the source DB, keyed by table.id.

    Returns ``(pk_by_table_id, raw_types_by_table_id)`` where:
    - ``pk_by_table_id[table.id]`` is the list of PK columns (ordered)
      for that table, when the source DB declares one.
    - ``raw_types_by_table_id[table.id][col_name]`` is the raw DB type
      string (e.g. "uuid", "bigint", "varchar(36)").

    Tables without a usable datasource (derived/calendar/sql_query
    against non-introspectable source, plus Google Sheets / manual)
    don't appear in the returned dicts — callers fall back to the
    cached `columns_cache` types.

    Network calls are best-effort; any error is logged at WARNING and
    the helper returns whatever it managed to collect.
    """
    from app.services.datasource_service import DataSourceConnectionService

    pk_by_table_id: Dict[int, List[str]] = {}
    raw_types_by_table_id: Dict[int, Dict[str, str]] = {}

    by_ds: Dict[int, List[DatasetTable]] = {}
    for t in tables:
        if is_generated_calendar_table(t):
            continue
        if not getattr(t, "datasource_id", None) or not getattr(t, "source_table_name", None):
            continue
        if getattr(t, "source_kind", "physical_table") != "physical_table":
            continue
        by_ds.setdefault(int(t.datasource_id), []).append(t)
    if not by_ds:
        return pk_by_table_id, raw_types_by_table_id

    for ds_id, group in by_ds.items():
        ds = db.query(DataSource).filter(DataSource.id == ds_id).first()
        if not ds:
            continue
        ds_type = ds.type if isinstance(ds.type, str) else getattr(ds.type, "value", "")
        if ds_type not in ("postgresql", "mysql", "bigquery"):
            continue
        source_names = [str(t.source_table_name) for t in group if t.source_table_name]
        # PK extraction
        try:
            pk_map = DataSourceConnectionService.list_primary_keys(
                ds_type=ds_type, config=ds.config, table_names=source_names,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[prefetch] PK extraction failed ds={ds_id}: {exc}")
            pk_map = {}
        # Raw column types
        try:
            types_map = DataSourceConnectionService.list_source_column_types(
                ds_type=ds_type, config=ds.config, table_names=source_names,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[prefetch] type extraction failed ds={ds_id}: {exc}")
            types_map = {}

        # Re-key by table.id using source_table_name (with + without schema)
        for t in group:
            src = str(t.source_table_name or "").strip()
            if not src:
                continue
            # Try the qualified key first, then bare table.
            candidates = [src]
            if "." in src:
                candidates.append(src.split(".", 1)[1])
            else:
                # PG default schema = public; MySQL uses db_name as schema.
                candidates.insert(0, f"public.{src}")
                if ds_type == "mysql":
                    db_name = (ds.config or {}).get("database")
                    if db_name:
                        candidates.insert(0, f"{db_name}.{src}")
            for key in candidates:
                if key in pk_map and t.id not in pk_by_table_id:
                    pk_by_table_id[t.id] = list(pk_map[key])
                if key in types_map and t.id not in raw_types_by_table_id:
                    raw_types_by_table_id[t.id] = dict(types_map[key])

    return pk_by_table_id, raw_types_by_table_id


_CARDINALITY_CERTAINTY = {
    "target_is_pk": 1.0,
    "source_is_pk": 1.0,
    "both_pk": 1.0,
    "target_unique_in_data": 0.9,
    "source_unique_in_data": 0.9,
    "both_unique_in_data": 0.9,
    "distinct_count_heuristic": 0.6,
    "equal_distinct_count_ambiguous": 0.4,
}


def _cardinality_certainty(reasons: list[str]) -> float:
    """Pick the lowest-certainty tag — that drives the confidence floor."""
    if not reasons:
        return 0.5
    return min((_CARDINALITY_CERTAINTY.get(r, 0.7) for r in reasons), default=0.7)


def _name_similarity_score(a: str, b: str) -> float:
    """Rough 0..1 similarity between two column names.

    Uses Jaccard over 3-char shingles after snake_case normalisation.
    Cheap, works well for "ma_kh" vs "ma_khach_hang" (~0.6) and
    "customer_id" vs "id_customer" (~0.7). Not a real string-similarity
    library — we don't need it perfect, just enough to bubble obvious
    pairs to the front of the probe queue.
    """
    a_norm = str(a or "").strip().lower()
    b_norm = str(b or "").strip().lower()
    if not a_norm or not b_norm:
        return 0.0
    if a_norm == b_norm:
        return 1.0
    # Build 3-char shingle sets (pad short strings).
    def shingles(s: str) -> set[str]:
        if len(s) < 3:
            return {s}
        return {s[i : i + 3] for i in range(len(s) - 2)}
    sa, sb = shingles(a_norm), shingles(b_norm)
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def _score_candidate_pair(
    fc: dict,
    tc: dict,
    *,
    fc_in_pk: bool,
    tc_in_pk: bool,
) -> float:
    """Higher score = probe this pair earlier.

    Signals (additive):
    - PK side present → strong (DB tells us one side is unique)
    - Column-name similarity → tables that have similar key names
      usually intend to join (e.g. khach_hang.ma_kh ↔ don_hang.ma_kh)
    - Either side contains "_id" / "_pk" / "_key" suffix → likely FK

    Range roughly 0..3. The probe loop sorts descending and truncates
    at MAX_PROBES.
    """
    score = 0.0
    if tc_in_pk or fc_in_pk:
        score += 1.5
    score += _name_similarity_score(fc.get("name", ""), tc.get("name", ""))
    fc_name = str(fc.get("name") or "").lower()
    tc_name = str(tc.get("name") or "").lower()
    fk_hint_suffixes = ("_id", "_pk", "_fk", "_key", "_no", "_code", "_ma")
    if any(fc_name.endswith(s) for s in fk_hint_suffixes):
        score += 0.4
    if any(tc_name.endswith(s) for s in fk_hint_suffixes):
        score += 0.4
    return score


def _infer_cardinality_from_probe(
    *,
    probe: dict,
    from_in_pk: bool,
    to_in_pk: bool,
) -> tuple[str, list[str]]:
    """Decide the join cardinality from probe stats + PK info.

    Decision tree, most reliable first:

    1. Declared single-column PK on one side (`from_in_pk` /
       `to_in_pk`) — DB tells us which side is unique, trust it.
    2. Inferred uniqueness from probed data — a column is "PK-like"
       when its non-null row count equals its distinct count, i.e.
       every value appears exactly once. This catches Sheets/CSV-style
       tables where the source doesn't declare a PK but the data is in
       fact unique.
    3. Distinct-count heuristic as a last resort. Returned with a
       "low confidence" tag so the caller can flag it.

    Returns ``(relationship, reasons)``.
    """
    from_d = int(probe.get("from_distinct") or 0)
    to_d = int(probe.get("to_distinct") or 0)
    from_nn = int(probe.get("from_non_null") or 0)
    to_nn = int(probe.get("to_non_null") or 0)

    # Step 1: declared PK wins.
    if to_in_pk and not from_in_pk:
        return "many_to_one", ["target_is_pk"]
    if from_in_pk and not to_in_pk:
        return "one_to_many", ["source_is_pk"]
    if from_in_pk and to_in_pk:
        return "one_to_one", ["both_pk"]

    # Step 2: data-inferred uniqueness. Each side is "unique-like" when
    # non_null == distinct and at least 2 rows exist (1-row probes give
    # no information).
    from_unique = from_nn >= 2 and from_nn == from_d
    to_unique = to_nn >= 2 and to_nn == to_d
    if from_unique and not to_unique:
        return "one_to_many", ["source_unique_in_data"]
    if to_unique and not from_unique:
        return "many_to_one", ["target_unique_in_data"]
    if from_unique and to_unique:
        return "one_to_one", ["both_unique_in_data"]

    # Step 3: distinct-count heuristic — the side with FEWER distinct
    # values is *likely* the dim (its values appear repeatedly on the
    # other side). Marked low-confidence so the FE can flag for review.
    if from_d < to_d:
        return "one_to_many", ["distinct_count_heuristic"]
    if to_d < from_d:
        return "many_to_one", ["distinct_count_heuristic"]
    return "many_to_one", ["distinct_count_heuristic", "equal_distinct_count_ambiguous"]


def _resolve_target_pk_column(
    pk_by_table_id: Dict[int, List[str]],
    to_table: Optional[DatasetTable],
    fallback: str = "id",
) -> str:
    """Pick the target column for a name-heuristic join.

    The legacy heuristic hard-coded ``to_column = "id"``, which fails on
    schemas where the PK is named ``ma_kh`` / ``user_uuid`` /
    ``order_no``. When DB introspection found the real PK, prefer it.
    Composite PKs fall back to the legacy behaviour because the FK
    detection here is single-column anyway.
    """
    if to_table is None:
        return fallback
    pk_cols = pk_by_table_id.get(to_table.id) or []
    if len(pk_cols) == 1:
        return pk_cols[0]
    return fallback


def _generate_join_suggestions(
    db: Session,
    dataset_id: int,
    *,
    deep_scan: bool,
) -> dict:
    """Produce a diff between (a) joins currently saved on the model and
    (b) what auto-detection would propose right now.

    Output shape:
      {
        existing: [...],        # joins already on the model — status=kept
        recommended: [...],     # joins we want to add — needs builder confirm
        obsolete: [...],        # joins on the model that no longer make sense
        warnings: [...],        # many-to-many, ambiguous, etc.
        rejected_count: int,    # how many suggestions were skipped due to tombstones
        deep_scan: bool,
      }
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise ValueError(f"Dataset {dataset_id} not found")

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        raise ValueError(
            "Dataset has no semantic model yet. Run Generate Model first, "
            "then come back here to review suggestions."
        )

    tables: list[DatasetTable] = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id, DatasetTable.enabled == True)
        .all()
    )
    table_by_id = {t.id: t for t in tables}
    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id.in_([t.id for t in tables]))
        .all()
    )
    table_views = {v.dataset_table_id: v for v in views if v.dataset_table_id}
    views_by_name = {v.name: v for v in views}

    rejected = _rejected_signatures(model)

    # --- Prefetch source-DB metadata (PK + raw column types) ------------
    # This is the "fast path" the user asked for: rather than relying on
    # column-name guesses or AppBI's coarse cached type labels, we ask
    # the source DB directly. One query per datasource collects PKs and
    # raw types for every table in the dataset. We skip Google Sheets /
    # manual / derived tables — they have no FK/PK metadata to read.
    pk_by_table_id, raw_types_by_table_id = _prefetch_db_metadata(db, tables)

    # Index from semantic-view name back to its DatasetTable, used to
    # look up the table we need to query PK/types for.
    table_by_view_name: Dict[str, DatasetTable] = {}
    for view in views:
        if view.dataset_table_id is None:
            continue
        tbl = next((t for t in tables if t.id == view.dataset_table_id), None)
        if tbl is not None:
            table_by_view_name[view.name] = tbl

    # --- Existing joins on the model -------------------------------------
    explores = (
        db.query(SemanticExplore)
        .filter(SemanticExplore.model_id == model.id)
        .all()
    )
    existing_payload: list[dict] = []
    existing_sigs: set[tuple] = set()
    for explore in explores:
        for join in explore.joins or []:
            from_cols, to_cols = _join_columns_from_definition(join)
            if not from_cols or not to_cols:
                continue
            sig = _suggestion_signature(
                explore.base_view_name,
                str(join.get("view") or ""),
                from_cols,
                to_cols,
            )
            if sig in existing_sigs:
                continue
            existing_sigs.add(sig)
            existing_payload.append(
                {
                    "from_view": explore.base_view_name,
                    "to_view": str(join.get("view") or ""),
                    "from_columns": from_cols,
                    "to_columns": to_cols,
                    "relationship": join.get("relationship") or "many_to_one",
                    "origin": join.get("origin") or "manual",
                    "status": "kept",
                }
            )

    # --- Pass 1 + 2: existing detection (FK + name heuristic) ------------
    auto_joins_by_source = _detect_fk_joins(tables, table_views, db=db)
    recommended: list[dict] = []
    warnings: list[dict] = []
    stats = {
        "tables_scanned": len(tables),
        "fk_constraints_found": 0,
        "name_matches_found": 0,
        "overlap_probes_run": 0,
        "overlap_probes_hit": 0,
        "overlap_probes_failed": 0,
        "overlap_probes_below_threshold": 0,
        "rejected_skipped": 0,
        "already_existing_skipped": 0,
        "key_like_columns_total": 0,
        "tables_with_db_pk": len(pk_by_table_id),
        "tables_with_raw_types": len(raw_types_by_table_id),
        "datasource_reads": 0,
        "quota_warnings": 0,
    }

    def _push_recommendation(rec: dict) -> None:
        sig = _suggestion_signature(
            rec["from_view"], rec["to_view"], rec["from_columns"], rec["to_columns"],
        )
        if sig in existing_sigs:
            stats["already_existing_skipped"] += 1
            return
        if sig in rejected:
            stats["rejected_skipped"] += 1
            return
        # Dedupe within the recommendations list itself
        for prev in recommended:
            if _suggestion_signature(
                prev["from_view"], prev["to_view"], prev["from_columns"], prev["to_columns"]
            ) == sig:
                return
        recommended.append(rec)

    for from_view_name, joins in auto_joins_by_source.items():
        for join in joins:
            from_cols, to_cols = _join_columns_from_definition(join)
            if not from_cols or not to_cols:
                continue
            origin = str(join.get("origin") or "auto_fk")
            target_view_name = str(join.get("view") or "")
            if origin == "auto_db_constraint":
                stats["fk_constraints_found"] += 1
                reasons = ["db_fk_constraint"]
            else:
                stats["name_matches_found"] += 1
                reasons = ["column_name_match"]
                # Override the hard-coded `.id` target when the DB
                # declares a different single-column PK. Saves the
                # builder from manual-fixing every `kh_id → ma_kh`
                # style mismatch.
                to_table = table_by_view_name.get(target_view_name)
                if to_table is not None and len(to_cols) == 1 and to_cols[0] == "id":
                    real_pk = _resolve_target_pk_column(pk_by_table_id, to_table, fallback="")
                    if real_pk and real_pk != "id":
                        to_cols = [real_pk]
                        reasons.append("pk_resolved_from_db")
            _push_recommendation(
                {
                    "from_view": from_view_name,
                    "to_view": target_view_name,
                    "from_columns": from_cols,
                    "to_columns": to_cols,
                    "relationship": join.get("relationship") or "many_to_one",
                    "origin": origin,
                    "confidence": 1.0 if origin == "auto_db_constraint" else 0.85,
                    "reasons": reasons,
                    "status": "new",
                }
            )

    # --- Pass 2.5: same-name overlap probe -------------------------------
    # Always-on, cheap version of deep scan. For every pair of tables, we
    # probe columns that share the same NAME (case-insensitive after
    # snake_case normalisation). This catches the common VN business
    # pattern where the schema lacks FK declarations but uses a stable
    # column name across tables (e.g. khach_hang.ma_kh shared with
    # don_hang.ma_kh). Same column names with overlapping values is the
    # single strongest signal we can act on without exploding the
    # cartesian search space.
    #
    # Pass 2.5 specifically SKIPS generic primary-key column names like
    # `id` / `pk` / `key`. Every table has its own `id` so a same-name
    # match on `id` between two unrelated dim tables is meaningless —
    # pass 2 already covers the real `<table>_id → <table>.id` flow.
    #
    # The cache used here is identical to the deep-scan cache so we don't
    # double-load the data when both passes run.
    distinct_cache = _ColumnDistinctCache(db, dataset_obj, dataset_id)
    stats["same_name_pairs_probed"] = 0
    stats["same_name_hits"] = 0

    def _normalise_col_name(name: str) -> str:
        return str(name or "").strip().lower()

    sorted_tables = sorted(tables, key=lambda t: t.id)
    for i, from_table in enumerate(sorted_tables):
        from_view = table_views.get(from_table.id)
        if from_view is None or from_table.id in distinct_cache._failed_views:
            continue
        from_col_list = [
            _effective_column_meta(c, from_table.id, raw_types_by_table_id)
            for c in _columns_of_table(from_table)
        ]
        from_col_list = [c for c in from_col_list if _is_key_like_column(c)]
        from_by_norm = {_normalise_col_name(c["name"]): c for c in from_col_list}
        from_pk_cols = pk_by_table_id.get(from_table.id) or []
        from_pk_set = set(from_pk_cols) if len(from_pk_cols) == 1 else set()

        for to_table in sorted_tables[i + 1:]:
            to_view = table_views.get(to_table.id)
            if to_view is None or to_table.id in distinct_cache._failed_views:
                continue
            to_col_list = [
                _effective_column_meta(c, to_table.id, raw_types_by_table_id)
                for c in _columns_of_table(to_table)
            ]
            to_col_list = [c for c in to_col_list if _is_key_like_column(c)]
            to_by_norm = {_normalise_col_name(c["name"]): c for c in to_col_list}
            to_pk_cols = pk_by_table_id.get(to_table.id) or []
            to_pk_set = set(to_pk_cols) if len(to_pk_cols) == 1 else set()

            shared_names = (set(from_by_norm) & set(to_by_norm)) - _SAME_NAME_SKIP
            for norm_name in shared_names:
                fc = from_by_norm[norm_name]
                tc = to_by_norm[norm_name]
                if not _type_compat(fc, tc):
                    continue
                sig_a = _suggestion_signature(
                    from_view.name, to_view.name, [fc["name"]], [tc["name"]],
                )
                sig_b = _suggestion_signature(
                    to_view.name, from_view.name, [tc["name"]], [fc["name"]],
                )
                if sig_a in existing_sigs or sig_b in existing_sigs:
                    stats["already_existing_skipped"] += 1
                    continue
                if sig_a in rejected or sig_b in rejected:
                    stats["rejected_skipped"] += 1
                    continue
                stats["same_name_pairs_probed"] += 1
                probe = distinct_cache.probe_pair(
                    from_view, fc["name"], to_view, tc["name"],
                )
                if probe is None:
                    continue
                if probe["overlap_ratio"] < 0.5:
                    continue
                stats["same_name_hits"] += 1
                relationship, extra_reasons = _infer_cardinality_from_probe(
                    probe=probe,
                    from_in_pk=fc["name"] in from_pk_set,
                    to_in_pk=tc["name"] in to_pk_set,
                )
                # Confidence floor follows the weakest signal we used —
                # if we had to fall back to distinct-count heuristic,
                # the suggestion can't be 100% even with 100% overlap.
                confidence = min(
                    probe["overlap_ratio"],
                    _cardinality_certainty(extra_reasons),
                )
                _push_recommendation(
                    {
                        "from_view": from_view.name,
                        "to_view": to_view.name,
                        "from_columns": [fc["name"]],
                        "to_columns": [tc["name"]],
                        "relationship": relationship,
                        "origin": "auto_same_name",
                        "confidence": round(confidence, 3),
                        "reasons": [
                            "same_column_name",
                            f"overlap_{int(probe['overlap_ratio'] * 100)}pct",
                            *extra_reasons,
                        ],
                        "status": "new",
                    }
                )

    # --- Pass 3: deep scan via column overlap probe ----------------------
    # Pass 2.5 only probed same-name pairs. Pass 3 expands to type-compat
    # cross-name probes (e.g. orders.user_id ↔ customers.id). Opt-in
    # because the search space grows quickly with table/column count.
    if deep_scan:
        # Cap the cartesian product so a 30-table dataset can't issue
        # tens of thousands of in-memory intersections. Note this cap
        # protects the app process (CPU + latency), NOT the datasource —
        # the cache makes every probe free at the datasource level.
        # Bumped to 200 because per-app cost is ~1ms/probe; the bottleneck
        # used to be Sheets quota which is now decoupled from probe count.
        MAX_PROBES = 200
        probes_run = 0
        sorted_tables = sorted(tables, key=lambda t: t.id)
        for i, from_table in enumerate(sorted_tables):
            if probes_run >= MAX_PROBES:
                warnings.append({
                    "kind": "deep_scan_capped",
                    "reason": f"Stopped after {MAX_PROBES} probes — narrow the dataset or rely on existing suggestions.",
                })
                break
            from_view = table_views.get(from_table.id)
            if from_view is None:
                continue
            from_cols = [
                _effective_column_meta(c, from_table.id, raw_types_by_table_id)
                for c in _columns_of_table(from_table)
            ]
            from_cols = [c for c in from_cols if _is_key_like_column(c)]
            stats["key_like_columns_total"] += len(from_cols)
            # Use only SINGLE-column PKs to assert uniqueness. A column
            # that's one of several in a composite PK isn't unique on its
            # own — treating it as a PK in cardinality detection would
            # mark `chi_tiet_don_hang.ma_sp` (composite (ma_dh, ma_sp))
            # as one_to_one with `san_pham.ma_sp`, which is wrong.
            from_pk_cols = pk_by_table_id.get(from_table.id) or []
            from_pk_set = set(from_pk_cols) if len(from_pk_cols) == 1 else set()
            for to_table in sorted_tables[i + 1:]:
                if probes_run >= MAX_PROBES:
                    break
                to_view = table_views.get(to_table.id)
                if to_view is None:
                    continue
                to_cols = [
                    _effective_column_meta(c, to_table.id, raw_types_by_table_id)
                    for c in _columns_of_table(to_table)
                ]
                to_cols = [c for c in to_cols if _is_key_like_column(c)]
                to_pk_cols = pk_by_table_id.get(to_table.id) or []
                to_pk_set = set(to_pk_cols) if len(to_pk_cols) == 1 else set()
                # Rank candidate pairs BEFORE probing so the MAX_PROBES
                # budget covers the most likely matches first. Without
                # this, a dataset with many noise columns can exhaust the
                # budget on bad candidates and miss real relationships.
                candidate_pairs: list[tuple[float, dict, dict]] = []
                for fc in from_cols:
                    for tc in to_cols:
                        if not _type_compat(fc, tc):
                            continue
                        # Skip generic PK→PK same-name pairs (id↔id,
                        # pk↔pk). Two unrelated dim tables both have
                        # an `id` whose values happen to overlap, but
                        # they don't actually join — pass 2 covers the
                        # real `<table>_id → <table>.id` path.
                        fc_lower = str(fc.get("name") or "").lower()
                        tc_lower = str(tc.get("name") or "").lower()
                        if (
                            fc_lower in _SAME_NAME_SKIP
                            and tc_lower in _SAME_NAME_SKIP
                        ):
                            continue
                        score = _score_candidate_pair(
                            fc, tc,
                            fc_in_pk=fc["name"] in from_pk_set,
                            tc_in_pk=tc["name"] in to_pk_set,
                        )
                        candidate_pairs.append((score, fc, tc))
                candidate_pairs.sort(key=lambda x: x[0], reverse=True)
                pair_hits: list[dict] = []
                for _score, fc, tc in candidate_pairs:
                    if probes_run >= MAX_PROBES:
                        break
                    sig_a = _suggestion_signature(
                        from_view.name, to_view.name, [fc["name"]], [tc["name"]],
                    )
                    sig_b = _suggestion_signature(
                        to_view.name, from_view.name, [tc["name"]], [fc["name"]],
                    )
                    if sig_a in existing_sigs or sig_b in existing_sigs:
                        stats["already_existing_skipped"] += 1
                        continue
                    if sig_a in rejected or sig_b in rejected:
                        stats["rejected_skipped"] += 1
                        continue
                    # If we already know either view's datasource
                    # is throttled or unreachable, skip without
                    # touching the network or the probe counter.
                    if (
                        from_view.id in distinct_cache._failed_views
                        or to_view.id in distinct_cache._failed_views
                    ):
                        continue
                    probes_run += 1
                    stats["overlap_probes_run"] += 1
                    probe = distinct_cache.probe_pair(
                        from_view, fc["name"], to_view, tc["name"],
                    )
                    if probe is None:
                        stats["overlap_probes_failed"] += 1
                        continue
                    if probe["overlap_ratio"] < 0.5:
                        stats["overlap_probes_below_threshold"] += 1
                        continue
                    stats["overlap_probes_hit"] += 1
                    pair_hits.append(
                        {
                            "from_column": fc["name"],
                            "to_column": tc["name"],
                            "overlap_ratio": probe["overlap_ratio"],
                            "from_distinct": probe["from_distinct"],
                            "to_distinct": probe["to_distinct"],
                            "from_non_null": probe.get("from_non_null", 0),
                            "to_non_null": probe.get("to_non_null", 0),
                        }
                    )

                # Many-to-many detection: more than one viable column pair
                # between the same two tables almost always means a bridge
                # is needed instead of a direct relationship.
                if len(pair_hits) > 1:
                    warnings.append(
                        {
                            "kind": "ambiguous_relationship",
                            "from_view": from_view.name,
                            "to_view": to_view.name,
                            "candidates": pair_hits,
                            "reason": (
                                f"Detected {len(pair_hits)} distinct column pairs that overlap "
                                f"between {from_view.name} and {to_view.name}. This usually "
                                f"means you need a bridge/junction table — pick one carefully."
                            ),
                        }
                    )
                    # Still propose the top candidate; builder will see warning.
                    pair_hits.sort(key=lambda x: x["overlap_ratio"], reverse=True)

                for hit in pair_hits:
                    # Hit dicts here are summary projections from the
                    # original probe — reconstruct the shape the
                    # cardinality helper needs.
                    probe_for_card = {
                        "from_distinct": hit["from_distinct"],
                        "to_distinct": hit["to_distinct"],
                        "from_non_null": hit.get("from_non_null") or 0,
                        "to_non_null": hit.get("to_non_null") or 0,
                    }
                    relationship, extra_reasons = _infer_cardinality_from_probe(
                        probe=probe_for_card,
                        from_in_pk=hit["from_column"] in from_pk_set,
                        to_in_pk=hit["to_column"] in to_pk_set,
                    )
                    confidence = min(
                        hit["overlap_ratio"],
                        _cardinality_certainty(extra_reasons),
                    )
                    _push_recommendation(
                        {
                            "from_view": from_view.name,
                            "to_view": to_view.name,
                            "from_columns": [hit["from_column"]],
                            "to_columns": [hit["to_column"]],
                            "relationship": relationship,
                            "origin": "auto_type_distinct",
                            "confidence": round(confidence, 3),
                            "reasons": [
                                "type_compatible",
                                f"overlap_{int(hit['overlap_ratio'] * 100)}pct",
                                *extra_reasons,
                            ],
                            "status": "new",
                        }
                    )

    # One full-table fetch per view, regardless of how many columns
    # the probe asked for — see _ColumnDistinctCache strategy note.
    stats["datasource_reads"] = distinct_cache.datasource_reads
    stats["quota_warnings"] = distinct_cache.quota_warning_count

    # --- Surface deep-scan datasource quota warnings ---------------------
    if distinct_cache.quota_warning_count > 0:
        warnings.append({
            "kind": "datasource_quota_exceeded",
            "reason": (
                f"Datasource rate limit (vd. Google Sheets 60 reads/min) "
                f"đã hit khi quét — {distinct_cache.quota_warning_count} bảng "
                f"bị bỏ dở. Chờ 1 phút rồi bấm Re-scan, hoặc giảm số bảng "
                f"trong dataset trước khi dò. Đã có sẵn các gợi ý từ bảng "
                f"hoàn tất."
            ),
        })

    # --- Obsolete check: joins whose columns no longer exist -------------
    obsolete: list[dict] = []
    for join in existing_payload:
        from_view_obj = views_by_name.get(join["from_view"])
        to_view_obj = views_by_name.get(join["to_view"])
        if from_view_obj is None or to_view_obj is None:
            obsolete.append({**join, "reason": "View no longer exists in this model."})
            continue
        from_fields = _field_names_for_view(from_view_obj)
        to_fields = _field_names_for_view(to_view_obj)
        missing_from = [c for c in join["from_columns"] if c not in from_fields]
        missing_to = [c for c in join["to_columns"] if c not in to_fields]
        if missing_from or missing_to:
            parts = []
            if missing_from:
                parts.append(f"{join['from_view']} no longer has {missing_from}")
            if missing_to:
                parts.append(f"{join['to_view']} no longer has {missing_to}")
            obsolete.append({**join, "reason": "; ".join(parts)})

    # Build view-name → friendly label map so the FE shows "Customers"
    # instead of "dataset_table_165". We prefer the dataset table's
    # display_name; if a view has no underlying dataset table (calendar
    # role views, derived) we fall back to the view name itself.
    view_labels: Dict[str, str] = {}
    for view in views:
        tbl = table_by_view_name.get(view.name)
        if tbl is not None:
            view_labels[view.name] = (
                str(tbl.display_name)
                or str(tbl.source_table_name)
                or view.name
            )
        else:
            view_labels[view.name] = view.name

    return {
        "model_id": model.id,
        "dataset_id": dataset_id,
        "existing": existing_payload,
        "recommended": recommended,
        "obsolete": obsolete,
        "warnings": warnings,
        "rejected_count": len(rejected),
        "deep_scan": deep_scan,
        "stats": stats,
        "view_labels": view_labels,
    }


def generate_join_suggestions(
    db: Session,
    dataset_id: int,
    *,
    deep_scan: bool = False,
) -> dict:
    """Public wrapper — kept thin so the endpoint stays simple."""
    return _generate_join_suggestions(db, dataset_id, deep_scan=deep_scan)


def apply_join_suggestions(
    db: Session,
    dataset_id: int,
    selections: list[dict],
) -> dict:
    """Apply a batch of selected suggestions by delegating to add_join."""
    if not selections:
        return {"added": 0, "skipped": 0, "errors": []}

    added = 0
    skipped = 0
    errors: list[dict] = []
    views = {v.name: v for v in db.query(SemanticView).all()}
    for item in selections:
        try:
            from_view_name = str(item.get("from_view") or "")
            to_view_name = str(item.get("to_view") or "")
            from_columns = [str(c) for c in (item.get("from_columns") or [])]
            to_columns = [str(c) for c in (item.get("to_columns") or [])]
            if not from_view_name or not to_view_name or not from_columns or not to_columns:
                skipped += 1
                continue
            from_view = views.get(from_view_name)
            to_view = views.get(to_view_name)
            if from_view is None or to_view is None:
                errors.append(
                    {"item": item, "reason": "View not found at apply time."}
                )
                continue
            add_join(
                db,
                dataset_id=dataset_id,
                from_view_id=from_view.id,
                to_view_id=to_view.id,
                from_column=from_columns[0],
                to_column=to_columns[0],
                from_columns=from_columns,
                to_columns=to_columns,
                join_type=str(item.get("join_type") or "left"),
                relationship=str(item.get("relationship") or "many_to_one"),
            )
            added += 1
        except Exception as exc:
            errors.append({"item": item, "reason": str(exc)})
    return {"added": added, "skipped": skipped, "errors": errors}
