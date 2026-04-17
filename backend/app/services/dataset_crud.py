"""CRUD service for Datasets (Table-based Datasets)"""
from datetime import datetime
import re
from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_

from app.models import DataSource
from app.models.dataset import Dataset, DatasetTable
from app.schemas.dataset import (
    DatasetCreate,
    DatasetUpdate,
    TableCreate,
    TableUpdate,
)
from app.services.dataset_calendar_service import (
    ensure_calendar_table,
    get_calendar_settings,
    is_generated_calendar_table,
    normalize_dataset_settings,
    remove_calendar_table,
)
from app.services.dataset_table_sql_service import (
    build_dataset_table_reference_alias_map,
    normalize_dataset_table_sql_alias,
    rewrite_dataset_table_aliases_in_sql,
)
from app.services.dataset_dictionary_service import normalize_dictionary_payload


LOOKUP_TABLE_IDENTIFIER_PREFIX = "dataset-table://"
CALENDAR_REQUIRES_DATASOURCE_MESSAGE = (
    "Add at least one source or SQL table backed by a datasource before creating the Standard Date table."
)


def build_lookup_table_identifier(table_id: int) -> str:
    return f"{LOOKUP_TABLE_IDENTIFIER_PREFIX}{table_id}"


def _rewrite_lookup_formula_identifier(
    formula: str,
    *,
    legacy_names: List[str],
    replacement_identifier: str,
) -> str:
    updated = str(formula or "")
    replacement = f'"{replacement_identifier}"'
    for legacy_name in legacy_names:
        alias = str(legacy_name or "").strip()
        if not alias:
            continue
        updated = updated.replace(f'"{alias}"', replacement)
    return updated


def _migrate_lookup_formulas_for_table_rename(
    db: Session,
    *,
    table: DatasetTable,
    previous_lookup_name: str,
) -> None:
    legacy_name = str(previous_lookup_name or "").strip()
    if not legacy_name:
        return

    replacement_identifier = build_lookup_table_identifier(table.id)
    sibling_tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == table.dataset_id,
            DatasetTable.id != table.id,
        )
        .all()
    )

    for sibling in sibling_tables:
        transforms = sibling.transformations or []
        changed = False
        updated_transforms: List[Dict[str, Any]] = []

        for step in transforms:
            step_copy = dict(step or {})
            params = dict(step_copy.get("params") or {})
            formula = params.get("formula")
            if step_copy.get("type") == "js_formula" and isinstance(formula, str):
                rewritten = _rewrite_lookup_formula_identifier(
                    formula,
                    legacy_names=[legacy_name],
                    replacement_identifier=replacement_identifier,
                )
                if rewritten != formula:
                    params["formula"] = rewritten
                    step_copy["params"] = params
                    changed = True
            updated_transforms.append(step_copy)

        if changed:
            sibling.transformations = updated_transforms


def _normalize_table_display_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _validate_unique_table_display_name(
    db: Session,
    *,
    dataset_id: int,
    display_name: str,
    exclude_table_id: int | None = None,
) -> str:
    normalized_name = _normalize_table_display_name(display_name)
    if not normalized_name:
        raise ValueError("Table name cannot be empty.")

    candidate_alias = normalize_dataset_table_sql_alias(normalized_name, fallback="table")
    sibling_tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )

    for sibling in sibling_tables:
        if exclude_table_id is not None and int(sibling.id) == int(exclude_table_id):
            continue

        sibling_name = _normalize_table_display_name(
            sibling.display_name or sibling.source_table_name or f"Table {sibling.id}"
        )
        if sibling_name.casefold() == normalized_name.casefold():
            raise ValueError(f"Table name '{normalized_name}' already exists in this dataset.")

        sibling_alias = normalize_dataset_table_sql_alias(
            sibling_name,
            fallback=f"table_{sibling.id}",
        )
        if sibling_alias == candidate_alias:
            raise ValueError(
                f"Table name '{normalized_name}' conflicts with existing table '{sibling_name}' after SQL normalization. "
                "Please choose a different name."
            )

    return normalized_name


def _migrate_derived_queries_for_alias_changes(
    db: Session,
    *,
    dataset_id: int,
    alias_changes: Dict[str, str],
) -> None:
    normalized_alias_changes = {
        str(source or "").strip().lower(): str(target or "").strip()
        for source, target in (alias_changes or {}).items()
        if str(source or "").strip() and str(target or "").strip()
    }
    if not normalized_alias_changes:
        return

    derived_tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.source_kind == "derived_table",
        )
        .all()
    )

    for derived_table in derived_tables:
        current_query = str(derived_table.source_query or "").strip()
        if not current_query:
            continue
        try:
            rewritten_query = rewrite_dataset_table_aliases_in_sql(current_query, normalized_alias_changes)
        except Exception:
            continue
        if rewritten_query != current_query:
            derived_table.source_query = rewritten_query


class DatasetCRUDService:
    """Service for Dataset CRUD operations"""

    @staticmethod
    def dataset_has_datasource_backed_table(
        db: Session,
        dataset_id: int,
        *,
        exclude_table_id: int | None = None,
    ) -> bool:
        query = db.query(DatasetTable).filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.datasource_id.isnot(None),
        )
        if exclude_table_id is not None:
            query = query.filter(DatasetTable.id != exclude_table_id)

        for candidate in query.order_by(DatasetTable.id).all():
            if is_generated_calendar_table(candidate):
                continue
            datasource_id = getattr(candidate, "datasource_id", None)
            if datasource_id is None:
                continue
            datasource = db.query(DataSource.id).filter(DataSource.id == datasource_id).first()
            if datasource is not None:
                return True
        return False
    
    # ===== Dataset Methods =====
    
    @staticmethod
    def get_all_datasets(
        db: Session,
        skip: int = 0,
        limit: int = 100
    ) -> List[Dataset]:
        """Get all datasets with pagination"""
        return db.query(Dataset)\
            .order_by(Dataset.updated_at.desc())\
            .offset(skip)\
            .limit(limit)\
            .all()
    
    @staticmethod
    def get_dataset_by_id(
        db: Session,
        dataset_id: int,
        include_tables: bool = False
    ) -> Optional[Dataset]:
        """Get dataset by ID, optionally with tables"""
        query = db.query(Dataset)
        
        if include_tables:
            query = query.options(joinedload(Dataset.tables))
        
        return query.filter(Dataset.id == dataset_id).first()
    
    @staticmethod
    def create_dataset(
        db: Session,
        dataset_in: DatasetCreate,
        owner_id=None,
    ) -> Dataset:
        """Create a new dataset"""
        settings = normalize_dataset_settings(
            dataset_in.settings.model_dump() if getattr(dataset_in, "settings", None) else None,
            enabled_default=False,
        )
        if (settings.get("calendar_dimension") or {}).get("enabled"):
            raise ValueError(CALENDAR_REQUIRES_DATASOURCE_MESSAGE)
        db_dataset = Dataset(
            name=dataset_in.name,
            description=dataset_in.description,
            settings=settings,
            dictionary=normalize_dictionary_payload(
                dataset_in.dictionary.model_dump() if getattr(dataset_in, "dictionary", None) else None
            ) or None,
            dictionary_updated_at=datetime.utcnow() if getattr(dataset_in, "dictionary", None) else None,
            owner_id=owner_id,
        )
        db.add(db_dataset)
        db.flush()

        db.commit()
        db.refresh(db_dataset)
        return db_dataset
    
    @staticmethod
    def update_dataset(
        db: Session,
        dataset_id: int,
        dataset_in: DatasetUpdate
    ) -> Optional[Dataset]:
        """Update a dataset"""
        db_dataset = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not db_dataset:
            return None
        
        # Update only provided fields
        update_data = dataset_in.model_dump(exclude_unset=True)
        incoming_settings = update_data.pop("settings", None)
        calendar_settings_updated = incoming_settings is not None and "calendar_dimension" in incoming_settings
        incoming_dictionary = update_data.pop("dictionary", None)
        for key, value in update_data.items():
            setattr(db_dataset, key, value)

        if incoming_settings is not None:
            current_settings = normalize_dataset_settings(
                getattr(db_dataset, "settings", None),
                enabled_default=False,
            )
            merged_calendar_settings = {
                **(current_settings.get("calendar_dimension") or {}),
                **((incoming_settings or {}).get("calendar_dimension") or {}),
            }
            db_dataset.settings = normalize_dataset_settings(
                {"calendar_dimension": merged_calendar_settings},
                enabled_default=bool(
                    (current_settings.get("calendar_dimension") or {}).get("enabled", False)
                ),
            )

        if incoming_dictionary is not None:
            normalized_dictionary = normalize_dictionary_payload(incoming_dictionary)
            db_dataset.dictionary = normalized_dictionary or None
            db_dataset.dictionary_updated_at = datetime.utcnow()

        if get_calendar_settings(db_dataset, enabled_default=False).get("enabled"):
            if calendar_settings_updated and not DatasetCRUDService.dataset_has_datasource_backed_table(db, dataset_id):
                raise ValueError(CALENDAR_REQUIRES_DATASOURCE_MESSAGE)
            ensure_calendar_table(db, db_dataset)
        else:
            remove_calendar_table(db, dataset_id)
        
        db.commit()
        db.refresh(db_dataset)
        return db_dataset
    
    @staticmethod
    def delete_dataset(db: Session, dataset_id: int) -> bool:
        """Delete a dataset (cascade deletes tables)"""
        db_dataset_obj = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not db_dataset_obj:
            return False
        
        db.delete(db_dataset_obj)
        db.commit()
        return True
    
    # ===== Table Methods =====
    
    @staticmethod
    def get_dataset_tables(
        db: Session,
        dataset_id: int
    ) -> List[DatasetTable]:
        """Get all tables in a dataset"""
        return db.query(DatasetTable)\
            .filter(DatasetTable.dataset_id == dataset_id)\
            .order_by(DatasetTable.created_at)\
            .all()
    
    @staticmethod
    def get_table_by_id(
        db: Session,
        table_id: int
    ) -> Optional[DatasetTable]:
        """Get a table by ID"""
        return db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
    
    @staticmethod
    def add_table_to_dataset(
        db: Session,
        dataset_id: int,
        table: TableCreate
    ) -> Optional[DatasetTable]:
        """Add a table to a dataset"""
        # Check if dataset exists
        dataset_obj = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not dataset_obj:
            return None
        
        # Check if table already exists in this dataset.
        # Only deduplicate physical_table sources (by table name).
        # sql_query sources are always allowed to be created independently.
        if table.source_table_name is not None:
            existing = db.query(DatasetTable)\
                .filter(
                    and_(
                        DatasetTable.dataset_id == dataset_id,
                        DatasetTable.datasource_id == table.datasource_id,
                        DatasetTable.source_table_name == table.source_table_name,
                        DatasetTable.source_kind == table.source_kind,
                    )
                )\
                .first()
            if existing:
                return existing
        
        # Create display name if not provided
        display_name = table.display_name
        if not display_name:
            # Extract table name from source (e.g., "public.orders" -> "Orders")
            if table.source_table_name:
                table_name = table.source_table_name.split('.')[-1]
                display_name = table_name.replace('_', ' ').title()
            else:
                display_name = "Untitled Table"
        display_name = _validate_unique_table_display_name(
            db,
            dataset_id=dataset_id,
            display_name=display_name,
        )

        db_table = DatasetTable(
            dataset_id=dataset_id,
            datasource_id=table.datasource_id,
            source_kind=table.source_kind,
            source_table_name=table.source_table_name,
            source_query=table.source_query,
            display_name=display_name,
            enabled=table.enabled,
            transformations=table.transformations or [],
        )
        
        db.add(db_table)

        if table.datasource_id is not None and get_calendar_settings(dataset_obj, enabled_default=False).get("enabled"):
            ensure_calendar_table(db, dataset_obj)

        db.commit()
        db.refresh(db_table)
        return db_table
    
    @staticmethod
    def update_table(
        db: Session,
        table_id: int,
        table_update: TableUpdate
    ) -> Optional[DatasetTable]:
        """Update a table"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return None
        
        # Update only provided fields
        update_data = table_update.model_dump(exclude_unset=True)
        previous_lookup_name = db_table.display_name or db_table.source_table_name or ""
        sibling_tables = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == db_table.dataset_id)
            .all()
        )
        alias_map_before = build_dataset_table_reference_alias_map(sibling_tables)
        if "display_name" in update_data:
            update_data["display_name"] = _validate_unique_table_display_name(
                db,
                dataset_id=db_table.dataset_id,
                display_name=update_data.get("display_name"),
                exclude_table_id=table_id,
            )
        display_name_changed = (
            "display_name" in update_data
            and str(update_data.get("display_name") or "").strip() != _normalize_table_display_name(db_table.display_name)
        )
        source_query_changed = (
            "source_query" in update_data
            and update_data.get("source_query") != db_table.source_query
        )
        for key, value in update_data.items():
            setattr(db_table, key, value)

        if display_name_changed:
            _migrate_lookup_formulas_for_table_rename(
                db,
                table=db_table,
                previous_lookup_name=previous_lookup_name,
            )
            alias_map_after = build_dataset_table_reference_alias_map(sibling_tables)
            alias_changes = {
                previous_alias: alias_map_after.get(table_key, previous_alias)
                for table_key, previous_alias in alias_map_before.items()
                if alias_map_after.get(table_key) and alias_map_after.get(table_key) != previous_alias
            }
            _migrate_derived_queries_for_alias_changes(
                db,
                dataset_id=db_table.dataset_id,
                alias_changes=alias_changes,
            )

        if source_query_changed:
            # Source-derived metadata must be rebuilt from the new query.
            db_table.columns_cache = None
            db_table.sample_cache = None
            db_table.column_stats = None
            db_table.schema_hash = None
            db_table.stats_updated_at = None
        
        db.commit()
        db.refresh(db_table)
        return db_table
    
    @staticmethod
    def delete_table(db: Session, table_id: int) -> bool:
        """Remove a table from dataset"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return False
        
        db.delete(db_table)
        db.commit()
        return True
    
    @staticmethod
    def update_table_cache(
        db: Session,
        table_id: int,
        columns_cache: Optional[Dict[str, Any]] = None,
        sample_cache: Optional[List[Dict[str, Any]]] = None
    ) -> Optional[DatasetTable]:
        """Update table cache after preview"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return None
        
        if columns_cache is not None:
            db_table.columns_cache = columns_cache
        
        if sample_cache is not None:
            db_table.sample_cache = sample_cache
        
        db.commit()
        db.refresh(db_table)
        return db_table
