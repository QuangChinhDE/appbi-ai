"""
Audit logging service — central entry point for recording security events.
"""
import logging
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit_log import AuditAction, AuditLog, AuditSeverity

logger = logging.getLogger(__name__)

# Actions that are considered high-severity
_CRITICAL_ACTIONS = {
    AuditAction.LOGIN_FAILED,
    AuditAction.PERMISSION_DENIED,
    AuditAction.USER_DEACTIVATED,
}

_WARNING_ACTIONS = {
    AuditAction.PASSWORD_CHANGED,
    AuditAction.USER_PERMISSIONS_CHANGED,
    AuditAction.PUBLIC_LINK_CREATED,
    AuditAction.PUBLIC_LINK_DELETED,
    AuditAction.SHARE_REVOKED,
}


def audit(
    db: Session,
    action: AuditAction,
    *,
    request: Request | None = None,
    user_id: Any = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: dict | None = None,
    severity: AuditSeverity | None = None,
) -> None:
    """Record an audit event. Best-effort — never raises."""
    try:
        ip = None
        ua = None
        if request:
            ip = request.client.host if request.client else None
            ua = (request.headers.get("user-agent") or "")[:512]

        if severity is None:
            if action in _CRITICAL_ACTIONS:
                severity = AuditSeverity.CRITICAL
            elif action in _WARNING_ACTIONS:
                severity = AuditSeverity.WARNING
            else:
                severity = AuditSeverity.INFO

        log = AuditLog(
            user_id=user_id,
            ip_address=ip,
            user_agent=ua,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            details=details,
            severity=severity,
        )
        db.add(log)
        db.commit()
    except Exception:
        logger.exception("Failed to write audit log")
        try:
            db.rollback()
        except Exception:
            pass
