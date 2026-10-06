"""Manual-source asset lifecycle: stage, bind, read, delete, GC, legacy migration.

``DataSource.config`` of a manual source holds ONLY references::

    {"sheets": {"<sheet>": {"asset_id": "<uuid>", "columns": [{name, type}], "row_count": N}}}

``columns`` / ``row_count`` are copied from the asset row by ``bind_config`` —
never trusted from the client. Rows live in one Parquet file per sheet.

File side-effects follow the DB transaction: files written in a transaction
that rolls back are removed; files of deleted assets are removed only after
the deleting transaction commits (``_install_session_hooks``).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import io
import json
import logging
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import event
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.manual_source_asset import ManualSourceAsset
from app.services.manual_assets.storage import get_storage, new_storage_key

logger = logging.getLogger(__name__)

_NEW_KEYS = "manual_assets_new_keys"
_DELETE_KEYS = "manual_assets_delete_keys"
_PARQUET_META_KEY = b"appbi_manual"


class ManualAssetError(ValueError):
    """Safe, user-facing asset error."""


# ── Parquet codec (lossless for JSON-compatible cell values) ─────────────────

def _column_kind(values: List[Any]) -> Tuple[str, Any]:
    """Return (kind, empty_token). kind: bool | int | float | string | json."""
    non_empty = [v for v in values if v is not None and v != ""]
    empties = {("none" if v is None else "blank") for v in values if v is None or v == ""}
    empty_token: Any = None if empties == {"none"} else ""
    if all(isinstance(v, str) for v in non_empty):
        return "string", None
    if len(empties) > 1:
        return "json", None
    if non_empty and all(isinstance(v, bool) for v in non_empty):
        return "bool", empty_token
    if non_empty and all(isinstance(v, int) and not isinstance(v, bool) for v in non_empty):
        return "int", empty_token
    if non_empty and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in non_empty):
        return "float", empty_token
    return "json", None


def encode_parquet(columns: List[Dict[str, Any]], rows: List[Dict[str, Any]]) -> bytes:
    import pyarrow as pa
    import pyarrow.parquet as pq

    arrays, names, meta_cols = [], [], []
    for idx, col in enumerate(columns):
        name = str(col.get("name"))
        values = [r.get(name, "") if isinstance(r, dict) else "" for r in rows]
        kind, empty = _column_kind(values)
        if kind == "string":
            arr = pa.array(values, type=pa.string())
        elif kind == "json":
            arr = pa.array([json.dumps(v, default=str) for v in values], type=pa.string())
        else:
            pa_type = {"bool": pa.bool_(), "int": pa.int64(), "float": pa.float64()}[kind]
            arr = pa.array([None if (v is None or v == "") else v for v in values], type=pa_type)
        arrays.append(arr)
        names.append(f"c{idx}")  # physical names never collide; logical names in metadata
        meta_cols.append({"name": name, "type": col.get("type", "string"), "kind": kind, "empty": empty})
    table = pa.Table.from_arrays(arrays, names=names) if arrays else pa.table({})
    table = table.replace_schema_metadata({_PARQUET_META_KEY: json.dumps({"columns": meta_cols, "rows": len(rows)})})
    sink = io.BytesIO()
    pq.write_table(table, sink, compression="zstd")
    return sink.getvalue()


def decode_parquet(path) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    meta = json.loads((table.schema.metadata or {}).get(_PARQUET_META_KEY, b"{}"))
    meta_cols = meta.get("columns") or []
    n = int(meta.get("rows") or table.num_rows)
    decoded: List[List[Any]] = []
    for idx, mc in enumerate(meta_cols):
        raw = table.column(f"c{idx}").to_pylist()
        kind, empty = mc.get("kind"), mc.get("empty")
        if kind == "json":
            decoded.append([json.loads(v) if v is not None else None for v in raw])
        elif kind == "string":
            decoded.append(raw)
        else:
            decoded.append([empty if v is None else v for v in raw])
    names = [mc["name"] for mc in meta_cols]
    rows = [{names[c]: decoded[c][i] for c in range(len(names))} for i in range(n)]
    columns = [{"name": mc["name"], "type": mc.get("type", "string")} for mc in meta_cols]
    return columns, rows


# ── session hooks: file side effects follow the transaction ──────────────────

def _install_session_hooks() -> None:
    if getattr(_install_session_hooks, "_done", False):
        return

    @event.listens_for(Session, "after_commit")
    def _after_commit(session):  # noqa: ANN001
        session.info.pop(_NEW_KEYS, None)
        keys = session.info.pop(_DELETE_KEYS, None) or []
        storage = get_storage()
        for key in keys:
            try:
                storage.delete(key)
            except Exception:
                logger.warning("manual_asset.file_delete_failed", exc_info=True)

    @event.listens_for(Session, "after_rollback")
    def _after_rollback(session):  # noqa: ANN001
        session.info.pop(_DELETE_KEYS, None)
        keys = session.info.pop(_NEW_KEYS, None) or []
        storage = get_storage()
        for key in keys:
            try:
                storage.delete(key)
            except Exception:
                logger.warning("manual_asset.file_cleanup_failed", exc_info=True)

    from app.models.models import DataSource

    @event.listens_for(DataSource, "before_delete")
    def _before_source_delete(mapper, connection, target):  # noqa: ANN001
        table = ManualSourceAsset.__table__
        keys = [
            r[0] for r in connection.execute(
                table.select().with_only_columns(table.c.storage_key).where(table.c.datasource_id == target.id)
            )
        ]
        if not keys:
            return
        # Explicit row delete: correct on DBs where the FK cascade is not enforced.
        connection.execute(table.delete().where(table.c.datasource_id == target.id))
        session = Session.object_session(target)
        if session is not None:
            session.info.setdefault(_DELETE_KEYS, []).extend(keys)

    _install_session_hooks._done = True


_install_session_hooks()


def _schedule_delete(db: Session, key: str) -> None:
    db.info.setdefault(_DELETE_KEYS, []).append(key)


# ── create assets ────────────────────────────────────────────────────────────

def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _write_asset(
    db: Session, *, sheet_name: str, columns: List[Dict[str, Any]], rows: List[Dict[str, Any]],
    owner_id, datasource_id: Optional[int], filename: Optional[str], media_type: Optional[str],
) -> ManualSourceAsset:
    data = encode_parquet(columns, rows)
    key = new_storage_key()
    db.info.setdefault(_NEW_KEYS, []).append(key)  # removed again if the txn rolls back
    get_storage().write_bytes(key, data)
    asset = ManualSourceAsset(
        id=uuid.uuid4(),
        datasource_id=datasource_id,
        owner_id=owner_id,
        sheet_name=str(sheet_name)[:255],
        storage_key=key,
        original_filename=(str(filename)[:255] if filename else None),
        media_type=media_type,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        columns=[{"name": c["name"], "type": c.get("type", "string")} for c in columns],
        row_count=len(rows),
        revision=1,
        expires_at=(None if datasource_id else _now() + _dt.timedelta(hours=settings.MANUAL_STAGED_ASSET_TTL_HOURS)),
    )
    db.add(asset)
    return asset


def stage_sheets(
    db: Session, sheets: Dict[str, Dict[str, Any]], *, owner_id, filename: Optional[str],
    media_type: Optional[str],
) -> Dict[str, Dict[str, Any]]:
    """Write each parsed sheet as a STAGED asset; return the bounded API payload.
    Caller commits (rollback removes the files)."""
    out: Dict[str, Dict[str, Any]] = {}
    preview_n = settings.MANUAL_UPLOAD_PREVIEW_ROWS
    for name, sheet in sheets.items():
        rows = sheet.get("rows") or []
        asset = _write_asset(
            db, sheet_name=name, columns=sheet.get("columns") or [], rows=rows,
            owner_id=owner_id, datasource_id=None, filename=filename, media_type=media_type,
        )
        out[name] = {
            "asset_id": str(asset.id),
            "columns": asset.columns,
            "row_count": len(rows),
            "preview_rows": rows[:preview_n],
            "preview_truncated": len(rows) > preview_n,
        }
    db.flush()
    return out


# ── bind (create / update of a manual source) ────────────────────────────────

def _parse_uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _same_owner(a, b) -> bool:
    return a is not None and b is not None and str(a) == str(b)


def has_inline_rows(config: Optional[Dict[str, Any]]) -> bool:
    cfg = config or {}
    if "rows" in cfg and "sheets" not in cfg:
        return True
    sheets = cfg.get("sheets")
    if isinstance(sheets, dict):
        return any(isinstance(v, dict) and "asset_id" not in v for v in sheets.values())
    return False


def _normalise_sheets(config: Dict[str, Any]) -> Dict[str, Any]:
    if isinstance(config.get("sheets"), dict):
        return config["sheets"]
    if "rows" in config or "columns" in config:
        return {"manual_data": {"columns": config.get("columns") or [], "rows": config.get("rows") or []}}
    return {}


def bind_config(db: Session, ds, config: Dict[str, Any], *, actor_id) -> Dict[str, Any]:
    """Return the reference-only config for ``ds`` (which must have an id).

    * ``asset_id`` already bound to ``ds`` -> kept.
    * staged ``asset_id`` owned by ``actor_id`` and not expired -> bound to ``ds``.
    * any other ``asset_id`` -> ManualAssetError (no cross-source / foreign reuse).
    * inline rows (legacy / internal callers) -> written as new bound assets.
    Assets previously bound to ``ds`` and no longer referenced are deleted.
    Does not commit.
    """
    sheets_in = _normalise_sheets(dict(config or {}))
    out_sheets: Dict[str, Any] = {}
    kept: set = set()
    now = _now()
    for name, entry in sheets_in.items():
        entry = entry if isinstance(entry, dict) else {}
        if "asset_id" in entry:
            aid = _parse_uuid(entry.get("asset_id"))
            asset = db.get(ManualSourceAsset, aid) if aid else None
            if asset is None:
                raise ManualAssetError("An uploaded file reference is invalid or has expired — upload the file again.")
            if asset.datasource_id == ds.id:
                pass
            elif asset.datasource_id is None and _same_owner(asset.owner_id, actor_id):
                exp = asset.expires_at
                if exp is not None and exp.tzinfo is None:
                    exp = exp.replace(tzinfo=_dt.timezone.utc)
                if exp is not None and exp < now:
                    raise ManualAssetError("The uploaded file has expired — upload it again.")
                asset.datasource_id = ds.id
                asset.expires_at = None
            else:
                raise ManualAssetError("An uploaded file reference is invalid or has expired — upload the file again.")
        else:
            asset = _write_asset(
                db, sheet_name=name, columns=list(entry.get("columns") or []),
                rows=list(entry.get("rows") or []), owner_id=getattr(ds, "owner_id", None),
                datasource_id=ds.id, filename=None, media_type=None,
            )
        kept.add(asset.id)
        out_sheets[str(name)] = {
            "asset_id": str(asset.id), "columns": list(asset.columns or []), "row_count": int(asset.row_count or 0),
        }
    db.flush()
    for old in db.query(ManualSourceAsset).filter(ManualSourceAsset.datasource_id == ds.id).all():
        if old.id not in kept:
            _schedule_delete(db, old.storage_key)
            db.delete(old)
    new_config = {k: v for k, v in (config or {}).items() if k not in ("sheets", "rows", "columns")}
    new_config["sheets"] = out_sheets
    return new_config


# ── read ─────────────────────────────────────────────────────────────────────

def read_asset(asset_id: Any, db: Optional[Session] = None) -> Optional[Dict[str, Any]]:
    """Columns + rows of a BOUND asset, or None when it cannot be resolved."""
    aid = _parse_uuid(asset_id)
    if aid is None:
        return None
    own = db is None
    if own:
        from app.core import database

        db = database.SessionLocal()
    try:
        asset = db.get(ManualSourceAsset, aid)
        if asset is None or asset.datasource_id is None:
            return None
        key = asset.storage_key
        declared = list(asset.columns or [])
    finally:
        if own:
            db.close()
    storage = get_storage()
    if not storage.exists(key):
        logger.error("manual_asset.file_missing asset=%s", aid)
        return None
    columns, rows = decode_parquet(storage.path_for(key))
    return {"columns": declared or columns, "rows": rows}


# ── GC ───────────────────────────────────────────────────────────────────────

def gc_expired_staged(db: Session, *, limit: int = 200) -> int:
    """Delete staged assets past their expiry (rows now, files after commit)."""
    expired = (
        db.query(ManualSourceAsset)
        .filter(ManualSourceAsset.datasource_id.is_(None), ManualSourceAsset.expires_at < _now())
        .limit(limit).all()
    )
    for asset in expired:
        _schedule_delete(db, asset.storage_key)
        db.delete(asset)
    if expired:
        logger.info("manual_asset.gc_expired count=%s", len(expired))
    return len(expired)


# ── legacy migration ─────────────────────────────────────────────────────────

def migrate_legacy_manual_source(db: Session, ds) -> bool:
    """Move inline rows of one manual source into assets. Idempotent; commits.
    Returns True when the source was converted. On failure the transaction is
    rolled back (written files are removed) and the error re-raised."""
    from app.core.crypto import decrypt_config, encrypt_config

    config = decrypt_config(dict(ds.config or {}))
    if not has_inline_rows(config):
        return False
    try:
        new_config = bind_config(db, ds, config, actor_id=ds.owner_id)
        ds.config = encrypt_config(new_config)
        flag_modified(ds, "config")
        db.commit()
    except Exception:
        db.rollback()
        logger.error("manual_source.legacy_migration_failed datasource_id=%s", ds.id)
        raise
    logger.info(
        "manual_source.legacy_migrated datasource_id=%s sheets=%s", ds.id, len(new_config.get("sheets") or {}),
    )
    return True


def migrate_all_legacy(db: Session) -> Dict[str, int]:
    from app.models.models import DataSource, DataSourceType

    result = {"migrated": 0, "skipped": 0, "failed": 0}
    ids = [r[0] for r in db.query(DataSource.id).filter(DataSource.type == DataSourceType.MANUAL).all()]
    for ds_id in ids:
        ds = db.get(DataSource, ds_id)
        try:
            result["migrated" if migrate_legacy_manual_source(db, ds) else "skipped"] += 1
        except Exception:
            result["failed"] += 1
    return result
