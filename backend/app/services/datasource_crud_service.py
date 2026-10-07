"""
CRUD service for data sources — the ONE chokepoint for create / update / delete
(spec docs/features/source-core-hardening/spec.md, domain invariants):

  update = snapshot (no lock, version v) → merge → restore masked secrets ONCE
           → auth-mode rules → validate the FINAL config → Google claim →
           platform policy → end txn → (connection test, no txn) → short
           FOR UPDATE txn: still version v? else 409 source_conflict →
           persist (config_version = v + 1 on a connection change) →
           invalidate_source()

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


def _run_connection_test(ds_type: str, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Refuse to persist a config that cannot connect (manual has nothing to test).

    Returns the structured result (source_health.run_connection_test) of a
    passing test so the caller records it as the source's health; None when
    nothing was tested."""
    if ds_type == "manual":
        return None
    from app.services.source_health import run_connection_test

    result = run_connection_test(ds_type, config)
    if result.get("success"):
        return result
    raise SourceConfigError(
        result.get("message") or "Connection failed",
        code=f"connection_{result.get('error_code') or 'unknown'}",
    )


def _conflict() -> SourceConfigError:
    return SourceConfigError(
        "Data source đã được người khác thay đổi. Hãy tải lại rồi thử lại.",
        code="source_conflict", status_code=409,
    )


def _pending_key(incoming: Dict[str, Any]):
    import uuid as _uuid
    raw = str((incoming or {}).get("google_pending_id") or "").strip()
    try:
        return _uuid.UUID(raw) if raw else None
    except ValueError:
        return None


def _consume_google_pending(db: Session, pending_key) -> None:
    """Consume the consent handle claimed in phase 1 exactly once; if another
    save consumed it in between, refuse rather than double-claim."""
    from app.models.models import GoogleOAuthPending
    deleted = db.query(GoogleOAuthPending).filter(GoogleOAuthPending.id == pending_key).delete(
        synchronize_session=False)
    if not deleted:
        raise SourceConfigError(
            "That Google connection expired. Press Connect Google again.",
            code="google_connection_expired",
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
            health = _run_connection_test(ds_type, config) if test_connection else None
            resolved_name = DataSourceCRUDService._resolve_unique_name(db, data_source.name, owner_id=owner_id)

            db_data_source = DataSource(
                name=resolved_name,
                type=DataSourceType(ds_type),
                description=data_source.description,
                config=encrypt_config(config),
                owner_id=owner_id,
                config_version=1,
            )
            if health is not None:
                from app.services.source_health import apply_health
                apply_health(db_data_source, health)
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
        """Update a data source — the single update chokepoint.

        Optimistic concurrency on ``config_version`` (no row lock is ever held
        across network I/O):

          1. snapshot (no lock): read the row, record version v, resolve the
             final config from THAT snapshot (merge / masked-secret restore /
             validate / policy), then end the read transaction;
          2. connection test, outside any transaction;
          3. short write txn: SELECT ... FOR UPDATE; if config_version != v (or
             != the client's expected ``config_version``) → SourceConfigError
             code=source_conflict (409); else persist exactly the tested config
             with config_version = v + 1, commit, then invalidate_source().
        A failed test raises before phase 3: nothing written, version unchanged.
        Every update (also name/description only) passes the same version check.
        """
        from app.core.crypto import decrypt_config, encrypt_config

        # -- Phase 1: snapshot, no lock -------------------------------------
        snap = (
            db.query(DataSource).filter(DataSource.id == data_source_id)
            .populate_existing().first()
        )
        if not snap:
            db.rollback()
            return None
        if actor_id is None and actor is not None:
            actor_id = getattr(actor, "id", None)
        ds_type = _type_value(snap.type)
        snap_version = int(snap.config_version or 1)
        expected_version = getattr(data_source_update, "config_version", None)

        # F8: type is immutable after create.
        requested_type = getattr(data_source_update, "type", None)
        if requested_type is not None and _type_value(requested_type) != ds_type:
            db.rollback()
            raise SourceConfigError(
                "Không thể đổi loại của data source sau khi tạo. Hãy tạo data source mới.",
                code="source_type_immutable",
            )
        if expected_version is not None and int(expected_version) != snap_version:
            db.rollback()
            raise _conflict()

        previous_config = dict(snap.config or {})
        old_plain = decrypt_config(previous_config)
        update_data = data_source_update.model_dump(exclude_unset=True)
        update_data.pop('type', None)
        update_data.pop('config_version', None)
        incoming_config = update_data.pop('config', None)
        new_plain: Optional[Dict[str, Any]] = None
        changed_fields: List[str] = []
        pending_key = None
        try:
            if incoming_config is not None:
                pending_key = _pending_key(incoming_config)
                new_plain = resolve_config(
                    db, ds_type, incoming_config, stored=previous_config, actor=actor,
                    enforce_policy=(actor is not None) if enforce_policy is None else enforce_policy,
                )
                if ds_type == 'google_sheets':
                    new_plain = _normalize_google_sheets_config(new_plain)
                if ds_type != 'manual':
                    changed_fields = connection_fields_changed(old_plain, new_plain)
        finally:
            # End the read txn: undoes the in-session Google claim (re-done in
            # phase 3) and guarantees nothing is held during the test.
            db.rollback()

        # -- Phase 2: connection test, outside any transaction --------------
        health = None
        if changed_fields and test_connection:
            health = _run_connection_test(ds_type, new_plain)

        # -- Phase 3: short write transaction -------------------------------
        auth_change = None
        try:
            db_data_source = DataSourceCRUDService.get_for_update(db, data_source_id)
            if not db_data_source:
                db.rollback()
                return None
            if int(db_data_source.config_version or 1) != snap_version:
                raise _conflict()

            if 'name' in update_data:
                requested_name = (update_data['name'] or '').strip()
                if requested_name and requested_name != db_data_source.name:
                    update_data['name'] = DataSourceCRUDService._resolve_unique_name(
                        db, requested_name, exclude_id=data_source_id, owner_id=db_data_source.owner_id,
                    )
                elif not requested_name:
                    update_data.pop('name')

            if new_plain is not None:
                if ds_type == 'manual':
                    # Manual: binding assets is DB/file work only (nothing to
                    # test), so it runs under the short lock.
                    from app.services.manual_assets.service import bind_config
                    new_plain = bind_config(
                        db, db_data_source, new_plain,
                        actor_id=actor_id or db_data_source.owner_id,
                    )
                    changed_fields = connection_fields_changed(old_plain, new_plain)
                # A consent handle is single-use: spend it even when the
                # reconnect changed nothing (same account / same token).
                if pending_key is not None:
                    _consume_google_pending(db, pending_key)
                old_auth = str(old_plain.get("auth_mode") or "")
                new_auth = str(new_plain.get("auth_mode") or "")
                if old_auth and new_auth and old_auth != new_auth:
                    auth_change = {"from": old_auth, "to": new_auth}
                if changed_fields:
                    update_data['config'] = encrypt_config(new_plain)

            for field, value in update_data.items():
                setattr(db_data_source, field, value)
            if changed_fields:
                db_data_source.config_version = snap_version + 1
                # The last health described the OLD connection.
                db_data_source.last_test_status = None
                db_data_source.last_tested_at = None
                db_data_source.last_error_code = None
                if health is not None:
                    # ...and the test that just passed describes the NEW one.
                    from app.services.source_health import apply_health
                    apply_health(db_data_source, health)
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
