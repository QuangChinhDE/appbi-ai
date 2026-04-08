"""
Dataset Model Service
Auto-generates semantic layer (views, model, explores) from dataset tables.
Each dataset = 1 Data Mart with its own semantic model.
"""
import re
from typing import Any, List, Optional, Tuple
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticModel, SemanticExplore
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.core.logging import get_logger
from app.services.runtime_modes import resolve_dataset_query_mode

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
    """
    Auto-generate a semantic model for a dataset.

    For each table in the dataset:
    - Create/update a SemanticView with auto-classified dimensions/measures
    - Create/update a SemanticModel for the dataset
    - Create SemanticExplores with auto-detected joins

    Args:
        db: Database session
        dataset_id: Dataset ID
        force: If True, overwrite existing views/model

    Returns:
        Dict with model_id, views created/updated count, explores count
    """
    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
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

    # 1. Get or create SemanticModel for this dataset
    model = db.query(SemanticModel).filter(
        SemanticModel.dataset_id == dataset_id
    ).first()

    if model and not force:
        # Model exists, just update views for new tables
        pass
    else:
        if not model:
            model = SemanticModel(
                name=f"model_{dataset_obj.name}",
                dataset_id=dataset_id,
                description=f"Auto-generated model for dataset: {dataset_obj.name}",
            )
            db.add(model)
            db.flush()  # Get model.id
        else:
            model.name = f"model_{dataset_obj.name}"
            model.description = f"Auto-generated model for dataset: {dataset_obj.name}"

    # 2. Create/update SemanticView for each table
    views_created = 0
    views_updated = 0
    created_views = []

    for table in tables:
        existing_view = db.query(SemanticView).filter(
            SemanticView.dataset_table_id == table.id
        ).first()

        dimensions, measures = _classify_columns(table.columns_cache or [])
        display_name = table.display_name or table.source_table_name or f"table_{table.id}"

        # Determine the actual SQL table reference for this dataset table
        if table.source_kind == "physical_table" and table.source_table_name:
            sql_table = table.source_table_name
        elif table.source_kind == "sql_query" and table.source_query:
            sql_table = f"({table.source_query})"
        else:
            sql_table = display_name

        if existing_view:
            if force:
                existing_view.name = display_name
                existing_view.sql_table_name = sql_table
                existing_view.dimensions = dimensions
                existing_view.measures = measures
                existing_view.description = table.auto_description or f"View for table: {display_name}"
                views_updated += 1
            created_views.append(existing_view)
        else:
            view = SemanticView(
                name=display_name,
                sql_table_name=sql_table,
                dataset_table_id=table.id,
                dimensions=dimensions,
                measures=measures,
                description=table.auto_description or f"View for table: {display_name}",
            )
            db.add(view)
            db.flush()
            created_views.append(view)
            views_created += 1

    # 3. Create explores with auto-detected joins
    # Delete old explores for this model when force=True
    if force:
        db.query(SemanticExplore).filter(
            SemanticExplore.model_id == model.id
        ).delete()
        db.flush()

    # Check if explores already exist
    existing_explores = db.query(SemanticExplore).filter(
        SemanticExplore.model_id == model.id
    ).count()

    explores_created = 0
    if existing_explores == 0 or force:
        detected_joins = _detect_joins(tables)

        for view in created_views:
            # Find joins where this view is the source
            view_joins = [
                {
                    "name": j["name"],
                    "view": j["view"],
                    "type": j["type"],
                    "sql_on": j["sql_on"],
                    "relationship": j["relationship"],
                    "from_view": view.name,
                    "from_column": j.get("from_column"),
                    "to_column": j.get("to_column"),
                }
                for j in detected_joins
                if j.get("_source_table") == view.name and j.get("view") != view.name
            ]

            # Only create explore if model exists
            explore = SemanticExplore(
                name=view.name,
                model_id=model.id,
                base_view_id=view.id,
                base_view_name=view.name,
                joins=view_joins if view_joins else [],
                description=f"Explore for {view.name}",
            )
            db.add(explore)
            explores_created += 1

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

    # Get all views linked to tables in this dataset
    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    table_ids = [t.id for t in tables]
    table_map = {t.id: t for t in tables}

    views = (
        db.query(SemanticView)
        .filter(SemanticView.dataset_table_id.in_(table_ids))
        .all()
    ) if table_ids else []

    explores = (
        db.query(SemanticExplore)
        .filter(SemanticExplore.model_id == model.id)
        .all()
    )

    views_data = []
    view_field_map: dict[str, set[str]] = {}
    for v in views:
        table = table_map.get(v.dataset_table_id) if v.dataset_table_id else None
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
            "table_display_name": table.display_name if table else None,
            "sql_table_name": v.sql_table_name,
            "dimensions": v.dimensions or [],
            "measures": v.measures or [],
            "description": v.description,
        })

    explores_data = []
    for e in explores:
        normalized_joins = []
        base_fields = view_field_map.get(e.base_view_name, set())
        for join in e.joins or []:
            normalized_join = _normalize_join(join, e.base_view_name, base_fields)
            if normalized_join:
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

    # Validate both views' tables belong to this dataset
    from_table = db.query(DatasetTable).filter(
        DatasetTable.id == from_view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    to_table = db.query(DatasetTable).filter(
        DatasetTable.id == to_view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not from_table or not to_table:
        raise ValueError("Views do not belong to this dataset")

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if not model:
        raise ValueError("No semantic model found - generate the model first")

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
    if not view or view.dataset_table_id is None:
        raise ValueError(f"View '{view_name}' not found")

    db_table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not db_table:
        raise ValueError(f"View '{view_name}' does not belong to dataset {dataset_id}")

    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise ValueError("Data source not found")

    query_mode = resolve_dataset_query_mode(db_table)

    def fetch_live_values() -> list[str]:
        from app.services.datasource_service import DataSourceConnectionService
        from app.services.live_query_service import (
            _dialect_for_ds_type,
            _quote_identifier,
            build_live_base_query_plan,
        )

        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        quoted_field = _quote_identifier(field_name, dialect)
        plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
        sql = (
            f"SELECT DISTINCT {quoted_field} AS value "
            f"FROM ({plan.sql}) AS _appbi_distinct "
            f"WHERE {quoted_field} IS NOT NULL "
            f"ORDER BY 1 "
            f"LIMIT {limit}"
        )
        _, rows, _ = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            timeout_seconds=60 if ds_type == "bigquery" else 30,
            skip_bigquery_cost_check=True,
        )
        return _coerce_distinct_values(rows)

    if query_mode == "live":
        return fetch_live_values()

    from app.services.duckdb_engine import DuckDBEngine
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb

    if db_table.source_kind == "sql_query":
        rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query or "")
        if not rewritten:
            return fetch_live_values()
        base_table = f"({rewritten}) AS _q"
    elif db_table.source_kind == "physical_table":
        synced_view = get_synced_view(datasource.id, db_table.source_table_name or "")
        if not synced_view:
            return fetch_live_values()
        base_table = _apply_duckdb_transformations(synced_view, db_table.transformations)
    else:
        return fetch_live_values()

    rows = DuckDBEngine.query(
        f'SELECT DISTINCT "{field_name}" AS value '
        f'FROM {base_table} '
        f'WHERE "{field_name}" IS NOT NULL '
        f'ORDER BY 1 '
        f'LIMIT {limit}'
    )
    return _coerce_distinct_values(rows)
