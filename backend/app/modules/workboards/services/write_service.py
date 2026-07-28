"""
Workboard write executor — translates a form submission into parameterised
INSERT / UPDATE / DELETE statements against the source datasource.

Design contract:

* Schema-first. The workboard NEVER runs DDL. The set of writable columns
  is derived from the dataset table's metadata — anything outside of it is
  rejected.
* Parameterised SQL only. Column / table names are validated against a
  strict identifier regex; values are always passed as bound parameters.
  This module bypasses ``sql_validator.validate_select_only`` by design,
  which is why it has its own write-only entry point (``execute_write``).
* Layered validation. Hard validation (quality rules with severity=error)
  blocks the write. Soft validation (severity=warning/info) is recorded
  on the resulting WorkboardSubmission as ``validation_warnings``.
* Optimistic locking. When ``Workboard.optimistic_lock_column`` is set,
  UPDATE / DELETE statements add ``AND <lock_col> = <lock_token>`` to the
  WHERE clause and require exactly 1 affected row, otherwise raise
  :class:`OptimisticLockError`.
* RLS lives in :mod:`screen_runtime`: writes are pre-filtered there using
  the screen-bound ScreenRlsRule list, so this module sees only the values
  the caller is allowed to write.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models import DataSource, DataSourceType
from app.models.dataset import Dataset, DatasetQualityRule, DatasetTable
from app.models.user import User
from app.modules.workboards.models import Workboard
from app.modules.workboards.schemas import LayoutJson
from app.services.dataset_quality_service import evaluate_row
from app.services.datasource_service import DataSourceConnectionService
from app.services.query_cache import invalidate_datasource
from app.modules.workboards.services.crud_service import WorkboardService

logger = get_logger(__name__)


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class WorkboardWriteError(Exception):
    """Generic, caller-displayable write failure."""

    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class WorkboardValidationError(WorkboardWriteError):
    """Hard validation failed (one or more quality rules with severity=error)."""

    def __init__(self, message: str, violations: List[Dict[str, Any]]):
        super().__init__(message, status_code=422)
        self.violations = violations


class OptimisticLockError(WorkboardWriteError):
    """Row not found, already deleted, or concurrently modified."""

    def __init__(self, message: str = "Row was modified or deleted by someone else"):
        super().__init__(message, status_code=409)


# ---------------------------------------------------------------------------
# Identifier helpers
# ---------------------------------------------------------------------------

def _validate_identifier(name: str, kind: str) -> str:
    if not isinstance(name, str) or not _IDENT_RE.match(name):
        raise WorkboardWriteError(f"Invalid {kind} identifier: {name!r}")
    return name


def _quote(name: str, dialect: str) -> str:
    _validate_identifier(name, "column")
    return f'"{name}"' if dialect == "postgresql" else f"`{name}`"


def _quote_qualified_table(
    source_table_name: str, datasource: DataSource, dialect: str
) -> str:
    """
    Render the physical table reference safely. ``source_table_name`` may be
    ``schema.table`` or just ``table``. Both halves are validated as plain
    identifiers (no expressions) and re-quoted per dialect.
    """
    raw = (source_table_name or "").strip()
    if not raw:
        raise WorkboardWriteError("Workboard primary table has no source_table_name")

    if "." in raw:
        schema_part, table_part = raw.split(".", 1)
        schema_part = schema_part.strip().strip('"').strip("`")
        table_part = table_part.strip().strip('"').strip("`")
    else:
        config = datasource.config or {}
        if dialect == "postgresql":
            schema_part = (config.get("schema_name") or config.get("schema") or "public")
        else:
            schema_part = config.get("database") or ""
        table_part = raw.strip('"').strip("`")

    table_q = _quote(table_part, dialect)
    if not schema_part:
        return table_q
    schema_q = _quote(schema_part, dialect)
    return f"{schema_q}.{table_q}"


# ---------------------------------------------------------------------------
# Context resolution
# ---------------------------------------------------------------------------

class _WriteContext:
    __slots__ = (
        "workboard",
        "dataset_table",
        "datasource",
        "dialect",
        "table_ref",
        "layout",
        "allowed_columns",
        "primary_key_columns",
        "rules",
        "optimistic_lock_column",
    )

    def __init__(
        self,
        workboard: Workboard,
        dataset_table: DatasetTable,
        datasource: DataSource,
        dialect: str,
        table_ref: str,
        layout: LayoutJson,
        allowed_columns: List[str],
        primary_key_columns: List[str],
        rules: List[DatasetQualityRule],
        optimistic_lock_column: Optional[str] = None,
    ):
        self.workboard = workboard
        self.dataset_table = dataset_table
        self.datasource = datasource
        self.dialect = dialect
        self.table_ref = table_ref
        self.layout = layout
        self.allowed_columns = allowed_columns
        self.primary_key_columns = primary_key_columns
        self.rules = rules
        # Stage-resolved from published_runtime_config for Live (a draft change to
        # the lock column must not affect Live UPDATE/DELETE until Publish).
        self.optimistic_lock_column = optimistic_lock_column


def _resolve_dialect(ds_type: str) -> str:
    if ds_type == DataSourceType.POSTGRESQL.value:
        return "postgresql"
    if ds_type == DataSourceType.MYSQL.value:
        return "mysql"
    if ds_type == DataSourceType.GOOGLE_SHEETS.value:
        # Sheets writes go through the connector, not SQL — but the
        # context still needs a stable dialect string to short-circuit
        # the SQL builders below.
        return "sheets"
    raise WorkboardWriteError(
        f"Workboards can only write to PostgreSQL, MySQL, or Google Sheets (got '{ds_type}')."
    )


def _table_columns(table: DatasetTable) -> List[str]:
    cache = table.columns_cache or []
    cols: List[str] = []
    if isinstance(cache, list):
        for entry in cache:
            if isinstance(entry, dict) and entry.get("name"):
                cols.append(str(entry["name"]))
            elif isinstance(entry, str):
                cols.append(entry)
    return cols


def _table_primary_key_columns(table: DatasetTable) -> List[str]:
    cache = table.columns_cache
    if isinstance(cache, dict):
        cache = cache.get("columns")
    columns = [item for item in (cache or []) if isinstance(item, dict)]
    flagged = [
        str(item.get("name"))
        for item in columns
        if item.get("name") and bool(item.get("is_primary_key"))
    ]
    if flagged:
        return flagged
    names = [
        str(item.get("name"))
        for item in columns
        if item.get("name")
    ]
    if "id" in names:
        return ["id"]
    id_columns = [name for name in names if name.endswith("_id")]
    return [id_columns[0]] if id_columns else []


def _build_context(
    db: Session,
    workboard: Workboard,
    *,
    target_table_id: Optional[int] = None,
    primary_key_columns: Optional[List[str]] = None,
) -> _WriteContext:
    # Resolve NON-layout write config stage-correctly: a public LIVE write reads
    # write_mode / optimistic-lock column / dataset binding from the PUBLISHED
    # snapshot (published_runtime_config); a Builder Preview reads the live
    # columns. Driven by the _wb_use_published flag. Screen writes pass their
    # target table + PK explicitly, leaving the persisted legacy primary
    # binding untouched.
    from app.modules.workboards.services.runtime_config import (
        effective_layout_raw,
        resolve_runtime_config,
    )

    _rc = resolve_runtime_config(workboard)
    _write_cfg = _rc.write
    bound_dataset_id = _rc.binding.get("dataset_id")
    optimistic_lock_column = _write_cfg.get("optimistic_lock_column")
    active_table_id = (
        target_table_id
        or _rc.binding.get("primary_table_id")
        or workboard.primary_table_id
    )

    if (_write_cfg.get("write_mode") or "direct") != "direct":
        raise WorkboardWriteError(
            f"Unsupported write_mode '{_write_cfg.get('write_mode')}'."
        )

    table = (
        db.query(DatasetTable)
        .filter(DatasetTable.id == active_table_id)
        .first()
    )
    if not table:
        raise WorkboardWriteError("Target table not found", status_code=404)
    if table.dataset_id != bound_dataset_id:
        raise WorkboardWriteError(
            "Target table does not belong to the workboard's dataset",
            status_code=400,
        )
    if table.source_kind != "physical_table":
        raise WorkboardWriteError(
            f"Only physical tables are writable (got source_kind='{table.source_kind}')."
        )

    datasource = (
        db.query(DataSource)
        .filter(DataSource.id == table.datasource_id)
        .first()
    )
    if not datasource:
        raise WorkboardWriteError("Datasource not found", status_code=404)

    ds_type = (
        datasource.type.value
        if hasattr(datasource.type, "value")
        else str(datasource.type)
    )
    dialect = _resolve_dialect(ds_type)
    if dialect == "sheets":
        # Sheet name doesn't need quoting; the connector reads it as-is.
        table_ref = table.source_table_name or ""
    else:
        table_ref = _quote_qualified_table(
            table.source_table_name or "", datasource, dialect
        )

    # Layout (auto-number + audit-column config) also comes from the PUBLISHED
    # snapshot for Live via the same stage resolver.
    try:
        layout = LayoutJson.model_validate(effective_layout_raw(workboard) or {})
    except Exception as exc:
        raise WorkboardWriteError(f"Workboard layout is invalid: {exc}") from exc

    allowed = _table_columns(table)
    if primary_key_columns is not None:
        pk_cols = list(primary_key_columns)
    elif target_table_id is not None:
        pk_cols = _table_primary_key_columns(table)
    else:
        pk_cols = list(
            _rc.binding.get("primary_key_columns")
            or workboard.primary_key_columns
            or []
        )
    if not pk_cols:
        raise WorkboardWriteError(
            "Target primary_key_columns is empty; configure it in the builder before writing."
        )
    missing_pk = [column for column in pk_cols if column not in allowed]
    if missing_pk:
        raise WorkboardWriteError(
            f"Target primary key columns are missing: {', '.join(missing_pk)}."
        )

    rules = (
        db.query(DatasetQualityRule)
        .filter(
            DatasetQualityRule.dataset_id == bound_dataset_id,
            DatasetQualityRule.table_id == active_table_id,
            DatasetQualityRule.enabled.is_(True),
        )
        .all()
    )

    return _WriteContext(
        workboard=workboard,
        dataset_table=table,
        datasource=datasource,
        dialect=dialect,
        table_ref=table_ref,
        layout=layout,
        allowed_columns=allowed,
        primary_key_columns=pk_cols,
        rules=rules,
        optimistic_lock_column=optimistic_lock_column,
    )


# ---------------------------------------------------------------------------
# Value preparation
# ---------------------------------------------------------------------------

def _filter_to_allowed_columns(
    values: Dict[str, Any], allowed: List[str]
) -> Dict[str, Any]:
    if not allowed:
        return dict(values)
    allowed_set = set(allowed)
    rejected = [k for k in values if k not in allowed_set]
    if rejected:
        raise WorkboardWriteError(
            f"Unknown column(s) for this table: {', '.join(sorted(rejected))}"
        )
    return dict(values)


_AUTO_NUMBER_N_RE = re.compile(r"\{N(?::(\d+))?\}")


def _auto_number_bucket(reset: str, now: datetime) -> str:
    if reset == "daily":
        return now.strftime("%Y-%m-%d")
    if reset == "monthly":
        return now.strftime("%Y-%m")
    if reset == "yearly":
        return now.strftime("%Y")
    return "all"


def _parse_row_date(raw: Any) -> Optional[datetime]:
    """Best-effort parse of a row date value for auto-number period scoping.

    Handles native date/datetime, ISO ``YYYY-MM-DD`` (optionally with time),
    and vi-VN ``DD/MM/YYYY`` / ``DD-MM-YYYY``. Returns ``None`` when the value
    is not a recognisable date.
    """
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, date):
        return datetime(raw.year, raw.month, raw.day)
    s = str(raw).strip() if raw is not None else ""
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if m:
        try:
            return datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


def _auto_number_scope_key(config: Any, values: Dict[str, Any]) -> Optional[str]:
    """Canonical scope key from ``scope_columns``.

    Returns ``""`` when the rule is unscoped (legacy single counter), a stable
    64-hex digest when every scope column has a value, or ``None`` when any
    scope column is blank (missing scope — caller decides empty-vs-error).
    """
    cols = list(getattr(config, "scope_columns", None) or [])
    if not cols:
        return ""
    parts: List[str] = []
    for c in cols:
        raw = values.get(c)
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            return None
        # Case-sensitive, whitespace-trimmed — "XE01" and "xe01" are distinct
        # scopes (vehicle codes are canonical identifiers, not free text).
        parts.append(f"{c}=\x1e{str(raw).strip()}")
    canonical = "\x1f".join(parts)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _render_auto_number_pattern(pattern: str, seq: int, now: datetime, padding: int) -> str:
    """Render an AutoNumberConfig pattern.

    Replaces ``{YYYY}/{YY}/{MM}/{DD}`` with the current date and
    ``{N}`` / ``{N:<digits>}`` with the sequence number. Outer ``{N:4}``
    width directive wins; otherwise fall back to ``AutoNumberConfig.padding``.
    """

    def _sub_n(match: "re.Match[str]") -> str:
        width_token = match.group(1)
        width = int(width_token) if width_token else padding
        return str(seq).zfill(width) if width > 0 else str(seq)

    text = _AUTO_NUMBER_N_RE.sub(_sub_n, pattern)
    return (
        text.replace("{YYYY}", now.strftime("%Y"))
        .replace("{YY}", now.strftime("%y"))
        .replace("{MM}", now.strftime("%m"))
        .replace("{DD}", now.strftime("%d"))
    )


def _claim_auto_number_value(
    db: Session,
    workboard: Workboard,
    config: Any,
    now: datetime,
    values: Dict[str, Any],
) -> Optional[str]:
    """Reserve the next sequence value for ``config.column`` and render it.

    Uses an UPSERT on :class:`WorkboardAutoNumberSequence` so two concurrent
    inserts cannot end up with the same id. The pattern is rendered
    against the value we just reserved; the caller writes that into the
    insert payload.

    Scoped rules (``scope_columns`` / ``date_column``) restart the counter per
    distinct scope: the counter lives in a bucket keyed by both the reset
    period AND a digest of the scope-column values, so "27/07 + XE01" and
    "27/07 + XE02" count independently. Returns ``None`` (leave blank, no
    counter consumed) when a required scope/date column is missing and the
    policy is ``missing_scope_behavior='empty'``; raises 422 when it is
    ``'error'``.
    """
    from sqlalchemy import delete, not_, or_
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.modules.workboards.models import WorkboardAutoNumberSequence

    # ── Reference datetime: a row date_column overrides wall-clock for both
    # the reset period AND the pattern's {YYYY}/{MM}/{DD} parts, so the number
    # keys off the business date the user entered, not when they pressed save.
    date_column = getattr(config, "date_column", None)
    ref_dt = now
    date_missing = False
    if date_column:
        parsed = _parse_row_date(values.get(date_column))
        if parsed is None:
            date_missing = True
        else:
            ref_dt = parsed

    scope_key = _auto_number_scope_key(config, values)
    if date_missing or scope_key is None:
        if getattr(config, "missing_scope_behavior", "empty") == "error":
            missing_cols = []
            if date_missing and date_column:
                missing_cols.append(date_column)
            if scope_key is None:
                missing_cols.extend(list(getattr(config, "scope_columns", None) or []))
            raise HTTPException(
                status_code=422,
                detail=(
                    "Số tự động cho cột "
                    f"'{config.column}' cần các trường: "
                    f"{', '.join(dict.fromkeys(missing_cols)) or 'phạm vi'}."
                ),
            )
        return None  # leave blank — no counter consumed

    period_key = _auto_number_bucket(config.reset, ref_dt)
    # Legacy (unscoped) rules keep a bucket that is EXACTLY the period key so
    # their existing counter rows keep matching — byte-for-byte unchanged.
    bucket = period_key if not scope_key else f"{period_key}|s|{scope_key}"
    scoped_table_id = getattr(config, "table_id", None)
    column_name = (
        f"table:{int(scoped_table_id)}:{config.column}"
        if scoped_table_id
        else config.column
    )
    seed = max(int(config.start_at or 1), 1)

    # Honour the reset contract: when reset != "never", a new period must start
    # the sequence over. Drop stale buckets for this column so a workboard that
    # was paused across a period boundary (and any orphaned old-period rows)
    # cannot leak a non-reset counter into the new period. Match on the PERIOD
    # part only so sibling scopes within the CURRENT period are preserved.
    if getattr(config, "reset", "never") != "never":
        db.execute(
            delete(WorkboardAutoNumberSequence).where(
                WorkboardAutoNumberSequence.workboard_id == workboard.id,
                WorkboardAutoNumberSequence.column_name == column_name,
                not_(
                    or_(
                        WorkboardAutoNumberSequence.bucket == period_key,
                        WorkboardAutoNumberSequence.bucket.like(period_key + "|s|%"),
                    )
                ),
            )
        )

    stmt = (
        pg_insert(WorkboardAutoNumberSequence)
        .values(
            workboard_id=workboard.id,
            column_name=column_name,
            bucket=bucket,
            next_value=seed + 1,
        )
        .on_conflict_do_update(
            index_elements=["workboard_id", "column_name", "bucket"],
            set_={"next_value": WorkboardAutoNumberSequence.next_value + 1},
        )
        .returning(WorkboardAutoNumberSequence.next_value)
    )
    next_value = db.execute(stmt).scalar_one()
    # `next_value` is what the row holds AFTER bumping; the value just claimed
    # is one less. The seed branch returns (seed + 1) so the claim is `seed`.
    claimed = max(int(next_value) - 1, seed)
    db.commit()
    return _render_auto_number_pattern(
        config.pattern, claimed, ref_dt, int(config.padding or 0)
    )


def _apply_auto_number_on_insert(
    db: Session,
    workboard: Workboard,
    values: Dict[str, Any],
    layout: LayoutJson,
    now: datetime,
    *,
    target_table_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Fill blank auto-number columns with the next value from their sequence.

    Only runs when the column is missing/blank — if the caller pre-set a
    value, we trust it (useful for imports). Errors here are non-fatal:
    a sequence DB failure should not block the user's submit.
    """
    configs = list(layout.auto_number_columns or [])
    if not configs:
        return values
    out = dict(values)
    active_table_id = target_table_id or getattr(workboard, "primary_table_id", None)
    for cfg in configs:
        scoped_table_id = getattr(cfg, "table_id", None)
        if scoped_table_id and int(scoped_table_id) != int(active_table_id or 0):
            continue
        col = cfg.column
        existing = out.get(col)
        # allow_manual_override (default True): a caller-supplied value wins and
        # consumes no counter (imports, corrections). When False the server is
        # authoritative and always overwrites.
        if getattr(cfg, "allow_manual_override", True) and existing not in (None, "", []):
            continue
        try:
            claimed = _claim_auto_number_value(db, workboard, cfg, now, out)
            if claimed is not None:
                out[col] = claimed
            # None → missing scope with policy 'empty': leave blank on purpose.
        except HTTPException:
            # missing_scope_behavior='error' — a deliberate 422, surface it.
            raise
        except Exception:
            logger.exception(
                "Auto-number claim failed (workboard=%s column=%s)",
                workboard.id,
                col,
            )
            if getattr(cfg, "on_error", "leave_blank") == "block":
                raise HTTPException(
                    status_code=503,
                    detail=f"Không cấp được số tự động cho cột '{col}', vui lòng thử lại.",
                )
            # else leave blank
    return out


def _apply_audit_on_insert(
    values: Dict[str, Any], layout: LayoutJson, user: Optional[User], now: datetime
) -> Dict[str, Any]:
    out = dict(values)
    audit = layout.audit
    if audit.created_by_column and user is not None:
        out[audit.created_by_column] = str(user.id)
    if audit.created_at_column:
        out[audit.created_at_column] = now
    if audit.updated_by_column and user is not None:
        out[audit.updated_by_column] = str(user.id)
    if audit.updated_at_column:
        out[audit.updated_at_column] = now
    return out


def _apply_audit_on_update(
    values: Dict[str, Any], layout: LayoutJson, user: Optional[User], now: datetime
) -> Dict[str, Any]:
    out = dict(values)
    audit = layout.audit
    if audit.updated_by_column and user is not None:
        out[audit.updated_by_column] = str(user.id)
    if audit.updated_at_column:
        out[audit.updated_at_column] = now
    # NEVER mutate created_* on update.
    out.pop(audit.created_by_column, None) if audit.created_by_column else None
    out.pop(audit.created_at_column, None) if audit.created_at_column else None
    return out


def _enforce_validation(
    rules: List[DatasetQualityRule], row: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Run row-level rules. Hard errors raise; warnings are returned."""
    violations = evaluate_row(rules, row)
    blockers = [v for v in violations if v.get("severity") == "error"]
    if blockers:
        message = "; ".join(v.get("message", "validation failed") for v in blockers)
        raise WorkboardValidationError(message, violations=violations)
    return [v for v in violations if v.get("severity") != "error"]


# ---------------------------------------------------------------------------
# SQL builders (parameterised)
# ---------------------------------------------------------------------------

def _build_insert(
    ctx: _WriteContext, values: Dict[str, Any]
) -> Tuple[str, List[Any]]:
    if not values:
        raise WorkboardWriteError("Cannot insert an empty row")
    cols = list(values.keys())
    quoted_cols = ", ".join(_quote(c, ctx.dialect) for c in cols)
    placeholders = ", ".join(["%s"] * len(cols))
    sql = f"INSERT INTO {ctx.table_ref} ({quoted_cols}) VALUES ({placeholders})"
    if ctx.dialect == "postgresql":
        sql += " RETURNING *"
    return sql, [values[c] for c in cols]


def _build_where_pk(
    ctx: _WriteContext,
    pk: Dict[str, Any],
    *,
    lock_token: Any = None,
) -> Tuple[str, List[Any]]:
    if not pk:
        raise WorkboardWriteError("Primary key values are required")
    missing = [c for c in ctx.primary_key_columns if c not in pk]
    if missing:
        raise WorkboardWriteError(
            f"Missing primary key column(s): {', '.join(missing)}"
        )
    where_parts: List[str] = []
    params: List[Any] = []
    for col in ctx.primary_key_columns:
        where_parts.append(f"{_quote(col, ctx.dialect)} = %s")
        params.append(pk[col])
    if ctx.optimistic_lock_column:
        where_parts.append(
            f"{_quote(ctx.optimistic_lock_column, ctx.dialect)} = %s"
        )
        params.append(lock_token)
    return " WHERE " + " AND ".join(where_parts), params


def _build_update(
    ctx: _WriteContext,
    values: Dict[str, Any],
    where_clause: str,
    where_params: List[Any],
) -> Tuple[str, List[Any]]:
    if not values:
        raise WorkboardWriteError("Cannot update with no values")
    set_parts = [f"{_quote(c, ctx.dialect)} = %s" for c in values.keys()]
    sql = (
        f"UPDATE {ctx.table_ref} SET {', '.join(set_parts)}"
        + where_clause
    )
    if ctx.dialect == "postgresql":
        sql += " RETURNING *"
    return sql, list(values.values()) + where_params


def _build_delete(
    ctx: _WriteContext, where_clause: str, where_params: List[Any]
) -> Tuple[str, List[Any]]:
    sql = f"DELETE FROM {ctx.table_ref}{where_clause}"
    return sql, where_params


# ---------------------------------------------------------------------------
# Public service
# ---------------------------------------------------------------------------

class WorkboardWriteService:
    """Static-method facade for INSERT/UPDATE/DELETE flows."""

    @staticmethod
    def insert_row(
        db: Session,
        workboard: Workboard,
        values: Dict[str, Any],
        user: Optional[User],
        *,
        target_table_id: Optional[int] = None,
        primary_key_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        ctx = _build_context(
            db,
            workboard,
            target_table_id=target_table_id,
            primary_key_columns=primary_key_columns,
        )
        clean = _filter_to_allowed_columns(values, ctx.allowed_columns)
        now = datetime.now(timezone.utc)
        # Auto-number runs BEFORE audit fields + validation so the rendered
        # value can be referenced by audit / quality rules and so the value
        # actually lands in the row payload that gets validated.
        clean = _apply_auto_number_on_insert(
            db,
            workboard,
            clean,
            ctx.layout,
            now,
            target_table_id=ctx.dataset_table.id,
        )
        clean = _apply_audit_on_insert(clean, ctx.layout, user, now)
        warnings = _enforce_validation(ctx.rules, clean)

        ds_type = (
            ctx.datasource.type.value
            if hasattr(ctx.datasource.type, "value")
            else str(ctx.datasource.type)
        )

        try:
            if ds_type == "google_sheets":
                # Sheets-backed workboards talk to the connector directly —
                # no SQL string is built. The sheet name is the source_table_name.
                # Auto-generate UUID for PK columns absent from the payload so
                # every appended row has a stable, unique identifier.
                row, rowcount, _ = DataSourceConnectionService.execute_write_op(
                    ds_type,
                    ctx.datasource.config or {},
                    "insert",
                    table_name=ctx.dataset_table.source_table_name or "",
                    values=_jsonable(clean),
                    auto_pk_columns=ctx.primary_key_columns,
                )
                returned_rows = [row] if row else []
            else:
                sql, params = _build_insert(ctx, clean)
                _, returned_rows, rowcount, _ = DataSourceConnectionService.execute_write(
                    ds_type, ctx.datasource.config or {}, sql, params
                )
        except Exception as exc:
            logger.exception("Workboard insert failed (workboard=%s)", workboard.id)
            raise WorkboardWriteError(f"Insert failed: {exc}") from exc

        invalidate_datasource(ctx.datasource.id)

        new_row = returned_rows[0] if returned_rows else dict(clean)
        pk_values = {c: new_row.get(c) for c in ctx.primary_key_columns}
        submission = WorkboardService.record_submission(
            db,
            workboard=workboard,
            action="insert",
            table_name=ctx.dataset_table.source_table_name or "",
            row_pk=_jsonable(pk_values),
            payload=_jsonable(clean),
            validation_warnings=warnings,
            user_id=user.id if user is not None else None,
        )
        return {
            "row": _jsonable(new_row),
            "pk": _jsonable(pk_values),
            "affected_rows": rowcount,
            "warnings": warnings,
            "submission_id": submission.id,
        }

    @staticmethod
    def insert_rows(
        db: Session,
        workboard: Workboard,
        rows: List[Dict[str, Any]],
        user: Optional[User],
        *,
        target_table_id: Optional[int] = None,
        primary_key_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Insert multiple rows through the same validation/audit contract.

        SQL datasources keep the existing row-by-row path. Google Sheets uses a
        real batch append so high-level workboard operations do not burn one
        Sheets read/write pair per detail line.
        """
        if not rows:
            return {"action": "insert_many", "affected_rows": 0, "results": []}

        ctx = _build_context(
            db,
            workboard,
            target_table_id=target_table_id,
            primary_key_columns=primary_key_columns,
        )
        ds_type = (
            ctx.datasource.type.value
            if hasattr(ctx.datasource.type, "value")
            else str(ctx.datasource.type)
        )
        if ds_type != "google_sheets":
            results = [
                WorkboardWriteService.insert_row(
                    db,
                    workboard,
                    row,
                    user,
                    target_table_id=target_table_id,
                    primary_key_columns=primary_key_columns,
                )
                for row in rows
            ]
            return {
                "action": "insert_many",
                "affected_rows": len(results),
                "results": results,
            }

        now = datetime.now(timezone.utc)
        prepared: List[Dict[str, Any]] = []
        warnings_by_row: List[List[Dict[str, Any]]] = []
        for row in rows:
            clean = _filter_to_allowed_columns(row, ctx.allowed_columns)
            clean = _apply_auto_number_on_insert(
                db,
                workboard,
                clean,
                ctx.layout,
                now,
                target_table_id=ctx.dataset_table.id,
            )
            clean = _apply_audit_on_insert(clean, ctx.layout, user, now)
            warnings_by_row.append(_enforce_validation(ctx.rules, clean))
            prepared.append(clean)

        try:
            payload, rowcount, _ = DataSourceConnectionService.execute_write_op(
                ds_type,
                ctx.datasource.config or {},
                "insert_many",
                table_name=ctx.dataset_table.source_table_name or "",
                values=_jsonable(prepared),
                auto_pk_columns=ctx.primary_key_columns,
            )
        except Exception as exc:
            logger.exception("Workboard batch insert failed (workboard=%s)", workboard.id)
            raise WorkboardWriteError(f"Batch insert failed: {exc}") from exc

        invalidate_datasource(ctx.datasource.id)

        returned_rows = (payload or {}).get("rows") if isinstance(payload, dict) else []
        results: List[Dict[str, Any]] = []
        for idx, clean in enumerate(prepared):
            new_row = returned_rows[idx] if idx < len(returned_rows) else dict(clean)
            pk_values = {c: new_row.get(c) for c in ctx.primary_key_columns}
            submission = WorkboardService.record_submission(
                db,
                workboard=workboard,
                action="insert",
                table_name=ctx.dataset_table.source_table_name or "",
                row_pk=_jsonable(pk_values),
                payload=_jsonable(clean),
                validation_warnings=warnings_by_row[idx],
                user_id=user.id if user is not None else None,
            )
            results.append({
                "row": _jsonable(new_row),
                "pk": _jsonable(pk_values),
                "affected_rows": 1,
                "warnings": warnings_by_row[idx],
                "submission_id": submission.id,
            })

        return {
            "action": "insert_many",
            "affected_rows": rowcount,
            "results": results,
        }

    @staticmethod
    def update_row(
        db: Session,
        workboard: Workboard,
        pk: Dict[str, Any],
        values: Dict[str, Any],
        user: Optional[User],
        lock_token: Any = None,
        *,
        target_table_id: Optional[int] = None,
        primary_key_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        ctx = _build_context(
            db,
            workboard,
            target_table_id=target_table_id,
            primary_key_columns=primary_key_columns,
        )
        clean = _filter_to_allowed_columns(values, ctx.allowed_columns)
        # Never allow PK columns to be updated through the workboard.
        for pk_col in ctx.primary_key_columns:
            clean.pop(pk_col, None)
        now = datetime.now(timezone.utc)
        clean = _apply_audit_on_update(clean, ctx.layout, user, now)
        # Validate the merged row (incoming values; cannot validate untouched cols).
        warnings = _enforce_validation(ctx.rules, clean)

        ds_type = (
            ctx.datasource.type.value
            if hasattr(ctx.datasource.type, "value")
            else str(ctx.datasource.type)
        )
        try:
            if ds_type == "google_sheets":
                row, rowcount, _ = DataSourceConnectionService.execute_write_op(
                    ds_type,
                    ctx.datasource.config or {},
                    "update",
                    table_name=ctx.dataset_table.source_table_name or "",
                    values=_jsonable(clean),
                    pk=_jsonable(pk),
                    lock_column=ctx.optimistic_lock_column or None,
                    lock_token=_jsonable(lock_token),
                )
                returned_rows = [row] if row else []
            else:
                where_sql, where_params = _build_where_pk(
                    ctx, pk, lock_token=lock_token
                )
                sql, params = _build_update(ctx, clean, where_sql, where_params)
                _, returned_rows, rowcount, _ = DataSourceConnectionService.execute_write(
                    ds_type, ctx.datasource.config or {}, sql, params
                )
        except Exception as exc:
            if "OPTIMISTIC_LOCK" in str(exc):
                raise OptimisticLockError() from exc
            logger.exception("Workboard update failed (workboard=%s)", workboard.id)
            raise WorkboardWriteError(f"Update failed: {exc}") from exc

        if rowcount != 1:
            raise OptimisticLockError()

        invalidate_datasource(ctx.datasource.id)
        new_row = returned_rows[0] if returned_rows else dict(clean)
        submission = WorkboardService.record_submission(
            db,
            workboard=workboard,
            action="update",
            table_name=ctx.dataset_table.source_table_name or "",
            row_pk=_jsonable(pk),
            payload=_jsonable(clean),
            validation_warnings=warnings,
            user_id=user.id if user is not None else None,
        )
        return {
            "row": _jsonable(new_row),
            "pk": _jsonable(pk),
            "affected_rows": rowcount,
            "warnings": warnings,
            "submission_id": submission.id,
        }

    @staticmethod
    def update_rows(
        db: Session,
        workboard: Workboard,
        updates: List[Dict[str, Any]],
        user: Optional[User],
        *,
        target_table_id: Optional[int] = None,
        primary_key_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Update multiple rows, using a batch path where the datasource supports it."""
        if not updates:
            return {"action": "update_many", "affected_rows": 0, "results": []}

        ctx = _build_context(
            db,
            workboard,
            target_table_id=target_table_id,
            primary_key_columns=primary_key_columns,
        )
        ds_type = (
            ctx.datasource.type.value
            if hasattr(ctx.datasource.type, "value")
            else str(ctx.datasource.type)
        )
        if ds_type != "google_sheets":
            results = [
                WorkboardWriteService.update_row(
                    db,
                    workboard,
                    item.get("pk") if isinstance(item, dict) else {},
                    item.get("values") if isinstance(item, dict) else {},
                    user,
                    lock_token=item.get("lock_token") if isinstance(item, dict) else None,
                    target_table_id=target_table_id,
                    primary_key_columns=primary_key_columns,
                )
                for item in updates
            ]
            return {
                "action": "update_many",
                "affected_rows": len(results),
                "results": results,
            }

        now = datetime.now(timezone.utc)
        prepared: List[Dict[str, Any]] = []
        warnings_by_row: List[List[Dict[str, Any]]] = []
        for item in updates:
            pk = item.get("pk") if isinstance(item, dict) else None
            values = item.get("values") if isinstance(item, dict) else None
            if not isinstance(pk, dict) or not isinstance(values, dict):
                raise WorkboardWriteError("Each batch update needs pk and values.")
            clean = _filter_to_allowed_columns(values, ctx.allowed_columns)
            for pk_col in ctx.primary_key_columns:
                clean.pop(pk_col, None)
            clean = _apply_audit_on_update(clean, ctx.layout, user, now)
            warnings_by_row.append(_enforce_validation(ctx.rules, clean))
            prepared.append({
                "pk": _jsonable(pk),
                "values": _jsonable(clean),
                "lock_token": _jsonable(item.get("lock_token")) if isinstance(item, dict) else None,
            })

        try:
            payload, rowcount, _ = DataSourceConnectionService.execute_write_op(
                ds_type,
                ctx.datasource.config or {},
                "update_many",
                table_name=ctx.dataset_table.source_table_name or "",
                values=prepared,
                lock_column=ctx.optimistic_lock_column or None,
            )
        except Exception as exc:
            if "OPTIMISTIC_LOCK" in str(exc):
                raise OptimisticLockError() from exc
            logger.exception("Workboard batch update failed (workboard=%s)", workboard.id)
            raise WorkboardWriteError(f"Batch update failed: {exc}") from exc

        if rowcount != len(prepared):
            raise OptimisticLockError()

        invalidate_datasource(ctx.datasource.id)
        returned_rows = (payload or {}).get("rows") if isinstance(payload, dict) else []
        results: List[Dict[str, Any]] = []
        for idx, item in enumerate(prepared):
            pk_values = item["pk"]
            new_row = returned_rows[idx] if idx < len(returned_rows) else dict(item["values"])
            submission = WorkboardService.record_submission(
                db,
                workboard=workboard,
                action="update",
                table_name=ctx.dataset_table.source_table_name or "",
                row_pk=_jsonable(pk_values),
                payload=_jsonable(item["values"]),
                validation_warnings=warnings_by_row[idx],
                user_id=user.id if user is not None else None,
            )
            results.append({
                "row": _jsonable(new_row),
                "pk": _jsonable(pk_values),
                "affected_rows": 1,
                "warnings": warnings_by_row[idx],
                "submission_id": submission.id,
            })
        return {
            "action": "update_many",
            "affected_rows": rowcount,
            "results": results,
        }

    @staticmethod
    def delete_row(
        db: Session,
        workboard: Workboard,
        pk: Dict[str, Any],
        user: Optional[User],
        lock_token: Any = None,
        *,
        target_table_id: Optional[int] = None,
        primary_key_columns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        ctx = _build_context(
            db,
            workboard,
            target_table_id=target_table_id,
            primary_key_columns=primary_key_columns,
        )

        ds_type = (
            ctx.datasource.type.value
            if hasattr(ctx.datasource.type, "value")
            else str(ctx.datasource.type)
        )
        try:
            if ds_type == "google_sheets":
                _, rowcount, _ = DataSourceConnectionService.execute_write_op(
                    ds_type,
                    ctx.datasource.config or {},
                    "delete",
                    table_name=ctx.dataset_table.source_table_name or "",
                    pk=_jsonable(pk),
                    lock_column=ctx.optimistic_lock_column or None,
                    lock_token=_jsonable(lock_token),
                )
            else:
                where_sql, where_params = _build_where_pk(
                    ctx, pk, lock_token=lock_token
                )
                sql, params = _build_delete(ctx, where_sql, where_params)
                _, _, rowcount, _ = DataSourceConnectionService.execute_write(
                    ds_type, ctx.datasource.config or {}, sql, params
                )
        except Exception as exc:
            if "OPTIMISTIC_LOCK" in str(exc):
                raise OptimisticLockError() from exc
            logger.exception("Workboard delete failed (workboard=%s)", workboard.id)
            raise WorkboardWriteError(f"Delete failed: {exc}") from exc

        if rowcount != 1:
            raise OptimisticLockError()

        invalidate_datasource(ctx.datasource.id)
        submission = WorkboardService.record_submission(
            db,
            workboard=workboard,
            action="delete",
            table_name=ctx.dataset_table.source_table_name or "",
            row_pk=_jsonable(pk),
            payload=None,
            validation_warnings=[],
            user_id=user.id if user is not None else None,
        )
        return {
            "row": None,
            "pk": _jsonable(pk),
            "affected_rows": rowcount,
            "warnings": [],
            "submission_id": submission.id,
        }


# ---------------------------------------------------------------------------
# JSON-safety
# ---------------------------------------------------------------------------

def _jsonable(value: Any) -> Any:
    """Recursively coerce values into JSON-serialisable shapes."""
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)
