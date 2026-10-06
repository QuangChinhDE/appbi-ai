"""
CRUD service for data sources — the ONE chokepoint for create / update / delete
(spec docs/features/source-core-hardening/spec.md, domain invariants):

  update = load → merge → restore masked secrets ONCE → auth-mode rules →
           validate the FINAL config (provider schema) → Google claim →
           platform policy → (connection test) → persist atomically
           (config_version + 1 on a connection change) → invalidate_source()

`type` is immutable after create. Names are unique per owner. Delete refuses
with SourceInUseError while anything depends on the source.
"""
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models import DataSource, DataSourceType
from app.models.audit_log import AuditAction
from app.schemas import DataSourceCreate, DataSourceUpdate
from app.services.source_lifecycle import (
    SourceConfigError,
    SourceInUseError,
    audit_source_event,
    connection_fields_changed,
    find_delete_blockers,
    invalidate_source,
    resolve_config,
)
import app.services.manual_assets.service  # noqa: F401 — installs asset file cleanup hooks

logger = get_logger(__name__)

__all__ = ["DataSourceCRUDService", "SourceConfigError", "SourceInUseError"]


def _normalize_google_sheets_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Keep Google Sheets datasources live-backed.

    Older versions stored a full ``config['sheets']`` snapshot, which made a
    deleted/renamed sheet continue to appear in datasets.  Manual uploaded
    files still use snapshots; Google Sheets must reflect the workbook.
    """
    updated = dict(config or {})
    if "sheets" in updated:
        updated.pop("sheets", None)
        logger.info("Removed legacy Google Sheets snapshot from datasource config")
    return updated


def _type_value(ds_type: Any) -> str:
    return str(getattr(ds_type, "value", ds_type) or "")


def _run_connection_test(ds_type: str, config: Dict[str, Any]) -> None:
    """Refuse to persist a config that cannot connect (manual has nothing to test)."""
    if ds_type == "manual":
        return
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.source_errors import classify_source_error, describe_source_error

    success, message = DataSourceConnectionService.test_connection(ds_type, config)
    if success:
        return
    raise SourceConfigError(
        describe_source_error(message, config) if message else "Connection failed",
        code=f"connection_{classify_source_error(message or '')}",
    )


class DataSourceCRUDService:
    """Service for data source CRUD operations."""

    @staticmethod
    def _resolve_unique_name(
        db: Session, base_name: str, exclude_id: Optional[int] = None, owner_id: Any = None,
    ) -> str:
        """Return a name unique among THIS OWNER's sources, suffixing ``(1)``,
        ``(2)``, … — other users' names are neither consulted nor revealed."""
        candidate = (base_name or '').strip() or 'Untitled data source'
        q = db.query(DataSource.id, DataSource.name).filter(DataSource.name.like(f"{candidate}%"))
        q = q.filter(DataSource.owner_id.is_(None) if owner_id is None else DataSource.owner_id == owner_id)
        existing = {name for row_id, name in q.all() if exclude_id is None or row_id != exclude_id}
        if candidate not in existing:
            return candidate
        suffix = 1
        while True:
            next_candidate = f"{candidate} ({suffix})"
            if next_candidate not in existing:
                return next_candidate
            suffix += 1

    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[DataSource]:
        """Get all data sources with pagination."""
        return db.query(DataSource).offset(skip).limit(limit).all()

    @staticmethod
    def get_by_id(db: Session, data_source_id: int) -> Optional[DataSource]:
        """Get a data source by ID."""
        return db.query(DataSource).filter(DataSource.id == data_source_id).first()

    @staticmethod
    def get_for_update(db: Session, data_source_id: int) -> Optional[DataSource]:
        """Load the row under a row lock (S5/S6) and refresh any copy already in
        the session, so a merge/blocker check reads the committed state and a
        concurrent update/delete/insert-referencing-it waits. SQLite ignores
        FOR UPDATE (tests); Postgres honours it."""
        return (
            db.query(DataSource)
            .filter(DataSource.id == data_source_id)
            .populate_existing()
            .with_for_update()
            .first()
        )

    @staticmethod
    def get_by_name(db: Session, name: str, owner_id: Any = None) -> Optional[DataSource]:
        """Get a data source by name (within one owner when given)."""
        q = db.query(DataSource).filter(DataSource.name == name)
        if owner_id is not None:
            q = q.filter(DataSource.owner_id == owner_id)
        return q.first()

    @staticmethod
    def create(
        db: Session,
        data_source: DataSourceCreate,
        owner_id=None,
        *,
        actor: Any = None,
        test_connection: bool = False,
        enforce_policy: Optional[bool] = None,
    ) -> DataSource:
        """Create a data source through the same pipeline as update.

        ``actor`` (the requesting User) enables the Google consent claim and the
        platform-GCP policy; ``test_connection`` refuses a config that cannot
        connect. Internal callers (dashboard import) pass neither."""
        from app.core.crypto import encrypt_config

        ds_type = _type_value(data_source.type)
        config: Dict[str, Any] = {}
        try:
            config = resolve_config(
                db, ds_type, data_source.config, stored=None, actor=actor,
                enforce_policy=(actor is not None) if enforce_policy is None else enforce_policy,
            )
            if ds_type == 'google_sheets':
                config = _normalize_google_sheets_config(config)
            if test_connection:
                _run_connection_test(ds_type, config)
            resolved_name = DataSourceCRUDService._resolve_unique_name(db, data_source.name, owner_id=owner_id)

            db_data_source = DataSource(
                name=resolved_name,
                type=DataSourceType(ds_type),
                description=data_source.description,
                config=encrypt_config(config),
                owner_id=owner_id,
                config_version=1,
            )
            db.add(db_data_source)
            if ds_type == 'manual':
                # Rows never live in config: bind staged uploads (or convert
                # inline rows from internal callers) to asset references.
                from app.services.manual_assets.service import bind_config
                db.flush()
                db_data_source.config = encrypt_config(
                    bind_config(db, db_data_source, config or {}, actor_id=owner_id)
                )
            db.commit()
            db.refresh(db_data_source)
        except IntegrityError:
            db.rollback()
            raise SourceConfigError(
                f"Data source with name '{data_source.name}' already exists", code="name_conflict",
            )
        except Exception:
            db.rollback()  # also removes asset files written / restores a claimed consent
            raise
        logger.info("Created data source id=%s provider=%s", db_data_source.id, ds_type)
        audit_source_event(db, AuditAction.DATASOURCE_CREATED, db_data_source, owner_id,
                           {"auth_mode": (config or {}).get("auth_mode")})
        return db_data_source

    @staticmethod
    def update(
        db: Session,
        data_source_id: int,
        data_source_update: DataSourceUpdate,
        actor_id=None,
        *,
        actor: Any = None,
        test_connection: bool = False,
        enforce_policy: Optional[bool] = None,
    ) -> Optional[DataSource]:
        """Update a data source — the single update chokepoint."""
        from app.core.crypto import decrypt_config, encrypt_config

        # S5: merge + secret restore read the stored config under a row lock,
        # so two concurrent edits cannot both merge over the same old config.
        db_data_source = DataSourceCRUDService.get_for_update(db, data_source_id)
        if not db_data_source:
            return None
        if actor_id is None and actor is not None:
            actor_id = getattr(actor, "id", None)
        ds_type = _type_value(db_data_source.type)

        # F8: type is immutable after create.
        requested_type = getattr(data_source_update, "type", None)
        if requested_type is not None and _type_value(requested_type) != ds_type:
            raise SourceConfigError(
                "Không thể đổi loại của data source sau khi tạo. Hãy tạo data source mới.",
                code="source_type_immutable",
            )

        previous_config = dict(db_data_source.config or {})
        old_plain = decrypt_config(previous_config)
        changed_fields: List[str] = []
        auth_change = None
        try:
            update_data = data_source_update.model_dump(exclude_unset=True)
            update_data.pop('type', None)
            if 'name' in update_data:
                requested_name = (update_data['name'] or '').strip()
                if requested_name and requested_name != db_data_source.name:
                    update_data['name'] = DataSourceCRUDService._resolve_unique_name(
                        db, requested_name, exclude_id=data_source_id, owner_id=db_data_source.owner_id,
                    )
                elif not requested_name:
                    update_data.pop('name')

            if update_data.get('config') is not None:
                new_plain = resolve_config(
                    db, ds_type, update_data['config'], stored=previous_config, actor=actor,
                    enforce_policy=(actor is not None) if enforce_policy is None else enforce_policy,
                )
                if ds_type == 'google_sheets':
                    new_plain = _normalize_google_sheets_config(new_plain)
                elif ds_type == 'manual':
                    # Manual type: bind uploaded assets; config keeps references only.
                    from app.services.manual_assets.service import bind_config
                    new_plain = bind_config(
                        db, db_data_source, new_plain,
                        actor_id=actor_id or db_data_source.owner_id,
                    )
                changed_fields = connection_fields_changed(old_plain, new_plain)
                if changed_fields and test_connection:
                    _run_connection_test(ds_type, new_plain)
                old_auth = str(old_plain.get("auth_mode") or "")
                new_auth = str(new_plain.get("auth_mode") or "")
                if old_auth and new_auth and old_auth != new_auth:
                    auth_change = {"from": old_auth, "to": new_auth}
                if changed_fields:
                    update_data['config'] = encrypt_config(new_plain)
                else:
                    update_data.pop('config')
            else:
                update_data.pop('config', None)

            for field, value in update_data.items():
                setattr(db_data_source, field, value)
            if changed_fields:
                db_data_source.config_version = int(db_data_source.config_version or 1) + 1
                # The last health described the OLD connection.
                db_data_source.last_test_status = None
                db_data_source.last_tested_at = None
                db_data_source.last_error_code = None
            db.commit()
            db.refresh(db_data_source)
        except IntegrityError:
            db.rollback()
            raise SourceConfigError(
                f"Data source with name '{data_source_update.name}' already exists", code="name_conflict",
            )
        except Exception:
            db.rollback()  # also removes asset files written / restores a claimed consent
            raise

        if changed_fields:
            # Only after a successful commit, and only for this source.
            invalidate_source(db, db_data_source, previous_config=previous_config)
            audit_source_event(db, AuditAction.DATASOURCE_CONFIG_CHANGED, db_data_source, actor_id,
                               {"fields": changed_fields})
            if auth_change:
                audit_source_event(db, AuditAction.DATASOURCE_AUTH_MODE_CHANGED, db_data_source,
                                   actor_id, auth_change)
        logger.info("Updated data source id=%s version=%s", db_data_source.id, db_data_source.config_version)
        return db_data_source

    @staticmethod
    def delete(db: Session, data_source_id: int, actor_id=None) -> bool:
        """Delete a data source.

        Raises SourceInUseError (structured blockers) while a non-draft Dataset,
        a hosted snapshot or a Knowledge Doc depends on it. Hidden import drafts
        are purged; ResourceShare rows and manual assets are removed with it."""
        from app.models.resource_share import ResourceShare, ResourceType

        # S6: the blocker check, the draft purge and the delete run in ONE
        # transaction under a row lock on the source. A dataset table inserted
        # concurrently needs a key-share lock on this row (FK), so it either
        # committed before we locked (→ seen as a blocker) or waits and then
        # fails its FK — it can never slip in between check and delete.
        db_data_source = DataSourceCRUDService.get_for_update(db, data_source_id)
        if not db_data_source:
            return False

        blockers = find_delete_blockers(db, data_source_id)
        if blockers:
            db.rollback()  # release the lock before the audit write
            audit_source_event(db, AuditAction.DATASOURCE_DELETE_BLOCKED, db_data_source, actor_id,
                               {"blockers": [{"kind": b["kind"], "id": b["id"]} for b in blockers]})
            raise SourceInUseError(db_data_source.name, blockers)

        # Captured before anything is purged/deleted (the ORM row expires on commit).
        snapshot = SimpleNamespace(
            id=db_data_source.id, name=db_data_source.name, type=db_data_source.type,
            config=dict(db_data_source.config or {}), config_version=db_data_source.config_version,
        )

        # Nothing real references the source → drop any invisible draft that does.
        # Explicit: dataset_tables.datasource_id is ON DELETE CASCADE, so deleting
        # the source alone would leave the draft Dataset row as an empty shell.
        from app.services.dashboard_html_import_service import purge_stale_import_drafts
        # A savepoint, not a commit: a commit here would release the row lock.
        try:
            with db.begin_nested():
                purged = purge_stale_import_drafts(db, datasource_id=data_source_id, older_than_hours=None)
            if purged:
                logger.info("Purged import drafts %s while deleting data source %s", purged, data_source_id)
        except Exception:
            logger.warning("Draft purge before data source %s delete failed", data_source_id, exc_info=True)

        # The purge may already have removed this very source (a wizard-created
        # "[Dashboard Import]" source exists only for its draft) — that IS success.
        try:
            db.query(ResourceShare).filter(
                ResourceShare.resource_type == ResourceType.DATASOURCE,
                ResourceShare.resource_id == str(data_source_id),
            ).delete(synchronize_session=False)
            current = DataSourceCRUDService.get_by_id(db, data_source_id)
            if current is not None:
                db.delete(current)
            db.commit()
        except Exception:
            db.rollback()
            raise
        invalidate_source(db, snapshot)
        audit_source_event(db, AuditAction.DATASOURCE_DELETED, snapshot, actor_id)
        logger.info("Deleted data source id=%s", data_source_id)
        return True
