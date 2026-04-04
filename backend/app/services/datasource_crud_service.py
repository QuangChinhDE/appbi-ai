"""
CRUD service for data sources.
"""
from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import DataSource, DataSourceType
from app.schemas import DataSourceCreate, DataSourceUpdate
from app.core.logging import get_logger

logger = get_logger(__name__)


def _snapshot_google_sheets(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fetch every sheet from the spreadsheet and store data in config['sheets'].
    Mirrors the Manual Table format so the rest of the stack can treat them
    identically.  On failure the original config is returned unchanged so that
    datasource creation / update never blocks.
    """
    try:
        from app.services.google_sheets_connector import create_google_sheets_connector
        connector = create_google_sheets_connector(config)
        spreadsheet_id = config.get('spreadsheet_id', '')
        if not spreadsheet_id:
            return config

        sheet_names = connector.list_sheets(spreadsheet_id)
        sheets: Dict[str, Any] = {}
        for name in sheet_names:
            try:
                data = connector.get_sheet_data(spreadsheet_id, sheet_name=name)
                sheets[name] = {
                    'columns': data.get('columns', []),
                    'rows': data.get('rows', []),
                }
            except Exception as e:
                logger.warning(f"Could not snapshot sheet '{name}': {e}")

        updated = dict(config)
        updated['sheets'] = sheets
        logger.info(f"Snapshotted {len(sheets)} sheets from spreadsheet '{spreadsheet_id}'")
        return updated
    except Exception as e:
        logger.warning(f"GG Sheets snapshot failed (using live mode): {e}")
        return config


class DataSourceCRUDService:
    """Service for data source CRUD operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[DataSource]:
        """Get all data sources with pagination."""
        return db.query(DataSource).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, data_source_id: int) -> Optional[DataSource]:
        """Get a data source by ID."""
        return db.query(DataSource).filter(DataSource.id == data_source_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[DataSource]:
        """Get a data source by name."""
        return db.query(DataSource).filter(DataSource.name == name).first()
    
    @staticmethod
    def create(db: Session, data_source: DataSourceCreate, owner_id=None) -> DataSource:
        """Create a new data source."""
        try:
            from app.core.crypto import encrypt_config
            config = data_source.config
            if data_source.type.value == 'google_sheets':
                config = _snapshot_google_sheets(config)
            config = encrypt_config(config)

            db_data_source = DataSource(
                name=data_source.name,
                type=DataSourceType(data_source.type.value),
                description=data_source.description,
                config=config,
                owner_id=owner_id,
            )
            db.add(db_data_source)
            db.commit()
            db.refresh(db_data_source)
            logger.info(f"Created data source: {data_source.name}")
            return db_data_source
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Data source with name '{data_source.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        data_source_id: int,
        data_source_update: DataSourceUpdate
    ) -> Optional[DataSource]:
        """Update a data source."""
        db_data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
        if not db_data_source:
            return None
        
        try:
            update_data = data_source_update.model_dump(exclude_unset=True)

            # Re-snapshot sheets if config is being updated for a GG Sheets or Manual datasource.
            # Track whether config actually changed so we know to invalidate dataset-table caches.
            config_refreshed = False
            if 'config' in update_data:
                from app.core.crypto import encrypt_config, MASKED_PLACEHOLDER, _SENSITIVE_FIELDS
                ds_type = db_data_source.type.value

                # Restore existing encrypted values for any sensitive field that the
                # frontend sent back as "__stored__" (masked placeholder) or as empty
                # string (user didn't type a new value).
                existing_config = dict(db_data_source.config or {})
                new_cfg = dict(update_data['config'])
                for field in _SENSITIVE_FIELDS:
                    val = new_cfg.get(field, None)
                    if val == MASKED_PLACEHOLDER or val == "":
                        if field in existing_config and existing_config[field]:
                            new_cfg[field] = existing_config[field]  # keep encrypted value
                        else:
                            new_cfg.pop(field, None)  # field didn't exist before
                update_data['config'] = new_cfg

                if ds_type == 'google_sheets':
                    update_data['config'] = _snapshot_google_sheets(update_data['config'])
                    config_refreshed = True
                elif ds_type == 'manual':
                    # Manual type: config is already the new snapshot (uploaded by user)
                    config_refreshed = True
                update_data['config'] = encrypt_config(update_data['config'])

            for field, value in update_data.items():
                setattr(db_data_source, field, value)

            # When the underlying data changes, invalidate all dataset-table caches that
            # reference this datasource so the next preview re-reads from the fresh snapshot.
            # This prevents stale column names showing in the UI after columns are added/removed.
            if config_refreshed:
                from app.models.dataset import DatasetTable
                db.query(DatasetTable).filter(
                    DatasetTable.datasource_id == db_data_source.id
                ).update({'columns_cache': None, 'sample_cache': None})
                logger.info(
                    f"Invalidated dataset table caches for datasource id={db_data_source.id}"
                )

            db.commit()
            db.refresh(db_data_source)
            logger.info(f"Updated data source: {db_data_source.name}")
            return db_data_source
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Data source with name '{data_source_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, data_source_id: int) -> bool:
        """Delete a data source."""
        db_data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
        if not db_data_source:
            return False
        
        db.delete(db_data_source)
        db.commit()
        logger.info(f"Deleted data source: {db_data_source.name}")
        return True
