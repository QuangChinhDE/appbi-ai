"""Structured connection test + persisted last health (spec F16).

    {success, status: ok|warning|error, provider,
     checks: {auth, reachable, queryable, discoverable: ok|failed|skipped|warning},
     error_code, message (redacted), warnings[], duration_ms, tested_at}

`success`/`message` stay for older clients. The provider tests keep their
(success, message) tuple API (DataSourceConnectionService.test_connection);
this module reads what the provider raised / recorded in the same context and
classifies it with `source_errors.classify_source_error` (exception types and
structured attributes, not message regexes).
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.logging import get_logger

logger = get_logger(__name__)

_CHECKS = ("auth", "reachable", "queryable", "discoverable")

# Which checks a SUCCESSFUL plain provider test actually proved.
_PROVEN_ON_SUCCESS = {
    "postgresql": {"auth": "ok", "reachable": "ok", "queryable": "skipped", "discoverable": "skipped"},
    "mysql": {"auth": "ok", "reachable": "ok", "queryable": "skipped", "discoverable": "skipped"},
    "google_sheets": {"auth": "ok", "reachable": "ok", "queryable": "skipped", "discoverable": "ok"},
    "google_docs": {"auth": "ok", "reachable": "skipped", "queryable": "skipped", "discoverable": "skipped"},
    "manual": {"auth": "skipped", "reachable": "ok", "queryable": "skipped", "discoverable": "ok"},
}


def _failed_checks(error_code: str) -> Dict[str, str]:
    checks = {k: "skipped" for k in _CHECKS}
    if error_code == "auth":
        checks["auth"] = "failed"
    elif error_code in ("network", "timeout", "policy_blocked"):
        checks["reachable"] = "failed"
    elif error_code in ("permission", "missing_resource"):
        checks["auth"] = "ok"
        checks["reachable"] = "ok"
        checks["discoverable"] = "failed"
    elif error_code == "query":
        checks["auth"] = checks["reachable"] = "ok"
        checks["queryable"] = "failed"
    else:
        checks["reachable"] = "failed"
    return checks


def run_connection_test(ds_type: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """Run the provider test and return the structured result. Never raises."""
    from app.services import datasource_service as dsm
    from app.services.source_errors import classify_source_error, describe_source_error

    started = time.monotonic()
    tok_exc = dsm._LAST_TEST_EXC.set(None)
    tok_det = dsm._LAST_TEST_DETAIL.set(None)
    exc: Optional[BaseException] = None
    detail: Optional[Dict[str, Any]] = None
    try:
        try:
            success, message = dsm.DataSourceConnectionService.test_connection(ds_type, config)
        except Exception as raised:  # noqa: BLE001 — test_connection should not raise; be safe
            success, message, exc = False, str(raised), raised
        exc = exc or dsm._LAST_TEST_EXC.get()
        detail = dsm._LAST_TEST_DETAIL.get()
    finally:
        dsm._LAST_TEST_EXC.reset(tok_exc)
        dsm._LAST_TEST_DETAIL.reset(tok_det)

    safe_message = describe_source_error(message, config) if message else (message or "")
    warnings = [describe_source_error(w, config) for w in ((detail or {}).get("warnings") or [])]
    error_code: Optional[str] = None
    if not success:
        error_code = classify_source_error(exc if exc is not None else (message or ""))
        if error_code in ("network", "timeout", "policy_blocked") and safe_message:
            from app.services.source_errors import redact_ip_literals
            safe_message = redact_ip_literals(safe_message, keep=(config or {}).get("host"))
        checks = dict((detail or {}).get("checks") or _failed_checks(error_code))
        status = "error"
    else:
        checks = dict((detail or {}).get("checks") or _PROVEN_ON_SUCCESS.get(
            ds_type, {k: "skipped" for k in _CHECKS}))
        status = "warning" if (warnings or any(v in ("failed", "warning") for v in checks.values())) else "ok"
        if status == "warning" and (detail or {}).get("warning_code"):
            error_code = detail["warning_code"]
    return {
        "success": bool(success),
        "status": status,
        "provider": ds_type,
        "checks": {k: checks.get(k, "skipped") for k in _CHECKS},
        "error_code": error_code,
        "message": safe_message or ("Connection successful" if success else "Connection failed"),
        "warnings": warnings,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "tested_at": datetime.now(timezone.utc),
    }


def apply_health(data_source, result: Dict[str, Any]) -> None:
    """Set the health columns from a run_connection_test result (no commit).
    The one writer of these fields: record_health and the create/update
    pipeline (whose connection test is the new config's first health)."""
    data_source.last_test_status = result.get("status")
    data_source.last_tested_at = result.get("tested_at")
    data_source.last_error_code = result.get("error_code")


def record_health(db: Session, data_source, result: Dict[str, Any], *, actor_id: Any = None) -> None:
    """Persist the latest health on the source (status, time, category — never
    a message) and audit a failure category. Best-effort: a health write must
    not turn a test into an error."""
    try:
        apply_health(data_source, result)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("source.health_persist_failed source_id=%s", getattr(data_source, "id", None))
        return
    if result.get("status") == "error":
        from app.services.source_lifecycle import audit_source_event
        from app.models.audit_log import AuditAction
        audit_source_event(
            db, AuditAction.DATASOURCE_TEST_FAILED, data_source, actor_id,
            {"error_code": result.get("error_code"), "checks": result.get("checks")},
        )
